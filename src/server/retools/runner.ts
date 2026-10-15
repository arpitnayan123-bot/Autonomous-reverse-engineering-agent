/**
 * RE tool runner — executes registry tools in the best available mode
 * (docker image → local binary → honest unavailability), with per-tool
 * resource profiles, argv-array-only spawning (no shell), capped output,
 * artifact collection, and verbatim "how to enable" errors.
 *
 * Security posture (per-tool profiles deliberately differ from the 512 MB
 * workspace sandbox — analysis tools are heavier, but still locked down):
 *   - containers: --network none, read-only rootfs, tmpfs /tmp, memory/cpus
 *     from the tool profile, ONLY the run work dir is bind-mounted rw
 *   - local mode: direct spawn (no shell), scrubbed env, cwd = work dir
 *   - inputs must resolve inside the platform storage tree
 *     (storage/uploads/** for targets, storage/workspaces/** for project
 *     workspaces) — anything else is refused before any process starts
 */

import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { buildRegistry, type ReToolSpec, type ReToolOperation } from "./registry";

export interface ReToolAvailability {
  mode: "docker" | "local" | "unavailable";
  detail: string;
}

export interface ReToolRunResult {
  tool: string;
  operation: ReToolOperation;
  mode: "docker" | "local";
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  artifacts: Array<{ name: string; bytes: number; preview: string | null }>;
}

export interface ReToolRunOptions {
  /** Absolute path of the input file (must live under platform storage). */
  inputPath: string;
  operation: ReToolOperation;
  /** Force a mode ("docker" | "local") — default auto-resolution. */
  mode?: "docker" | "local";
  /** Testing hook: override the container-runtime probe answer. */
  runtimeAvailableForTesting?: boolean | null;
}

const STDOUT_CAP = 8_000;
const STDERR_CAP = 4_000;
const ARTIFACT_PREVIEW_CHARS = 2_000;
const AVAILABILITY_TTL_MS = 60_000;
const RETOOLS_ROOT = path.resolve(process.cwd(), "storage", "retools");

// ---------------------------------------------------------------- availability

const availabilityCache = new Map<string, { at: number; value: ReToolAvailability }>();

/** Testing hook — deterministic probe override (null = back to real probing). */
let probeOverride: boolean | null = null;
export function setRuntimeProbeForTesting(v: boolean | null): void {
  probeOverride = v;
  availabilityCache.clear();
}

function spawnCapture(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    try {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        if (!done) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
      }, timeoutMs);
      child.stdout.on("data", (d) => { if (out.length < 4096) out += String(d); });
      child.stderr.on("data", (d) => { if (out.length < 4096) out += String(d); });
      child.on("error", () => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, out }); } });
      child.on("close", (code) => {
        if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? -1, out }); }
      });
    } catch {
      resolve({ code: -1, out: "" });
    }
  });
}

async function runtimeBinary(): Promise<string | null> {
  if (probeOverride !== null) return probeOverride ? "docker" : null;
  for (const bin of ["docker", "podman"]) {
    const probe = await spawnCapture(bin, ["version", "--format", "{{.Server.Version}}"], 4_000);
    if (probe.code === 0) return bin;
  }
  return null;
}

async function whichBinary(name: string): Promise<string | null> {
  if (probeOverride !== null) {
    // Tests control availability deterministically: an override implies no
    // local binaries unless they stage one themselves via PATH.
  }
  const probe = await spawnCapture("which", [name], 3_000);
  const p = probe.out.trim().split("\n")[0]?.trim();
  return probe.code === 0 && p ? p : null;
}

async function imageExists(runtime: string, image: string): Promise<boolean> {
  const probe = await spawnCapture(runtime, ["image", "inspect", image, "--format", "ok"], 6_000);
  return probe.code === 0 && probe.out.includes("ok");
}

/** Resolve how a tool can run right now (cached 60 s). */
export async function getAvailability(spec: ReToolSpec): Promise<ReToolAvailability> {
  const cached = availabilityCache.get(spec.id);
  if (cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) return cached.value;

  let value: ReToolAvailability;
  const runtime = await runtimeBinary();
  if (runtime && await imageExists(runtime, spec.image)) {
    value = { mode: "docker", detail: `image ${spec.image} present in ${runtime}` };
  } else {
    for (const bin of spec.localBinaries) {
      const found = await whichBinary(bin);
      if (found) {
        value = { mode: "local", detail: `local binary ${bin} at ${found}` };
        break;
      }
    }
    value ??= {
      mode: "unavailable",
      detail: spec.license
        ? `${spec.name} requires a licensed image or binary. ${spec.docs}`
        : `${spec.name} is not available. ${spec.docs}`,
    };
  }
  availabilityCache.set(spec.id, { at: Date.now(), value });
  return value;
}

/** List with live availability (parallel probes, cached). */
export async function listRegistryWithAvailability(): Promise<Array<ReToolSpec & { availability: ReToolAvailability }>> {
  const specs = buildRegistry();
  return Promise.all(specs.map(async (s) => ({ ...s, availability: await getAvailability(s) })));
}

export async function getTool(id: string): Promise<ReToolSpec | null> {
  return buildRegistry().find((s) => s.id === id) ?? null;
}

// ---------------------------------------------------------------- input guard

/** Inputs must live under storage/uploads/** (targets) or storage/workspaces/** (projects). */
export function assertInputInStorage(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const allowedRoots = [
    path.resolve(process.cwd(), "storage", "uploads"),
    path.resolve(process.cwd(), "storage", "workspaces"),
  ];
  const ok = allowedRoots.some((root) => {
    const rel = path.relative(root, resolved);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
  if (!ok) {
    throw new Error(`input path is outside platform storage (uploads/ or workspaces/): ${inputPath}`);
  }
  if (!fsSync.existsSync(resolved)) {
    throw new Error(`input file does not exist: ${resolved}`);
  }
  return resolved;
}

// ---------------------------------------------------------------- execution

function cap(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [+${s.length - max} chars truncated]`;
}

function newWorkDir(toolId: string): string {
  const runId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  return path.join(RETOOLS_ROOT, toolId, runId);
}

async function collectArtifacts(workDir: string, spec: ReToolSpec): Promise<ReToolRunResult["artifacts"]> {
  const artifacts: ReToolRunResult["artifacts"] = [];
  for (const rel of spec.outputPaths) {
    const abs = path.join(workDir, rel);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
      let preview: string | null = null;
      if (stat.size <= 512 * 1024) {
        preview = cap(await fs.readFile(abs, "utf8"), ARTIFACT_PREVIEW_CHARS);
      }
      artifacts.push({ name: rel, bytes: stat.size, preview });
    } catch { /* output not produced this run */ }
  }
  return artifacts;
}

function runChild(bin: string, argv: string[], cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawn(bin, argv, { cwd, env: env ?? ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, LANG: "C.UTF-8", NO_COLOR: "1", NODE_ENV: process.env.NODE_ENV } as NodeJS.ProcessEnv), stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: `spawn failed: ${err instanceof Error ? err.message : String(err)}`, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    child.stdout.on("data", (d) => { if (stdout.join("").length < STDOUT_CAP * 2) stdout.push(String(d)); });
    child.stderr.on("data", (d) => { if (stderr.join("").length < STDERR_CAP * 2) stderr.push(String(d)); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ code: -1, stdout: stdout.join(""), stderr: `spawn error: ${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stdout.join(""), stderr: stderr.join(""), timedOut });
    });
  });
}

/**
 * Run a registry tool against an input file. Throws honest Error objects
 * (message starts with "Error:") for unavailability, unsupported operations,
 * or policy refusals — the agent loop surfaces these verbatim.
 */
export async function runReTool(toolId: string, opts: ReToolRunOptions): Promise<ReToolRunResult> {
  const spec = await getTool(toolId);
  if (!spec) {
    const known = buildRegistry().map((s) => s.id).join(", ");
    throw new Error(`Error: unknown RE tool '${toolId}'. Known tools: ${known}.`);
  }
  if (!(opts.operation in spec.operations)) {
    throw new Error(`Error: tool '${toolId}' has no operation '${opts.operation}'. Supported: ${Object.keys(spec.operations).join(", ")}.`);
  }

  const input = assertInputInStorage(opts.inputPath);

  const availability = await getAvailability(spec);
  let mode: "docker" | "local" | null = null;
  let runtime: string | null = null;

  if (opts.mode === "docker" || (!opts.mode && availability.mode === "docker")) {
    runtime = await runtimeBinary();
    if (runtime) mode = "docker";
    else if (opts.mode === "docker") {
      throw new Error(`Error: docker mode requested for ${toolId} but no container runtime is reachable. ${spec.docs}`);
    }
  }
  if (!mode) {
    const localBin = await whichBinary(spec.localBinaries[0]);
    if (localBin) mode = "local";
    else if (opts.mode === "local") {
      throw new Error(`Error: local mode requested but '${spec.localBinaries[0]}' is not on PATH. ${spec.docs}`);
    } else {
      throw new Error(`Error: ${availability.detail}`);
    }
  }

  // Work dir: input copied in (container sees a stable /area/input), outputs collected out.
  const workDir = newWorkDir(toolId);
  await fs.mkdir(path.join(workDir, "out"), { recursive: true });
  const inContainerInput = "/area/input";
  const inContainerOut = "/area";
  const localOut = workDir;

  const buildOpts = {
    inputPath: mode === "docker" ? inContainerInput : input,
    outPath: mode === "docker" ? inContainerOut : localOut,
    projectName: "AreaProject",
  };
  const toolArgv = spec.operations[opts.operation](buildOpts);

  let argv: string[];
  let bin: string;
  let cwd = workDir;
  let env: NodeJS.ProcessEnv | undefined;

  if (mode === "docker") {
    bin = runtime!;
    argv = [
      "run", "--rm", "--network", "none", "--read-only", "--tmpfs", "/tmp",
      "--memory", spec.profile.memory, "--cpus", spec.profile.cpus,
      "-v", `${workDir}:/area:rw`, "-w", "/area",
      spec.image, ...spec.entrypoint, ...toolArgv,
    ];
    // docker/podman itself needs full PATH; container env is the image's own.
    env = undefined;
    cwd = process.cwd();
  } else {
    const localBin = await whichBinary(spec.localBinaries[0]);
    bin = localBin!;
    const prefix = [...spec.localPrefix];
    const extra: string[] = [];
    if (spec.localScript) {
      const scriptAbs = path.resolve(process.cwd(), spec.localScript);
      if (!fsSync.existsSync(scriptAbs)) {
        throw new Error(`Error: ${spec.name} local mode needs ${spec.localScript} (missing). ${spec.docs}`);
      }
      extra.push(scriptAbs);
    }
    argv = [...prefix, ...extra, ...toolArgv];
  }

  const t0 = Date.now();
  const res = await runChild(bin, argv, cwd, spec.profile.timeoutMs, env);
  const durationMs = Date.now() - t0;

  const artifacts = await collectArtifacts(workDir, spec);
  const result: ReToolRunResult = {
    tool: toolId,
    operation: opts.operation,
    mode,
    argv: [bin, ...argv],
    exitCode: res.code,
    stdout: cap(res.stdout, STDOUT_CAP),
    stderr: cap(res.stderr, STDERR_CAP),
    timedOut: res.timedOut,
    durationMs,
    artifacts,
  };
  return result;
}

/** Render a run result as an agent-receipt string (used by re_tool tool). */
export function renderRunResult(r: ReToolRunResult): string {
  const lines: string[] = [];
  lines.push(`RE tool run: ${r.tool} (${r.operation}) via ${r.mode} — exit ${r.exitCode}${r.timedOut ? " (TIMED OUT)" : ""} in ${(r.durationMs / 1000).toFixed(1)}s`);
  for (const a of r.artifacts) {
    lines.push(`artifact ${a.name}: ${a.bytes} bytes${a.preview !== null ? "" : " (too large for preview — fetch via workspace/artifact API)"}`);
  }
  if (r.stdout.trim()) lines.push(`stdout:\n${r.stdout}`);
  if (r.stderr.trim()) lines.push(`stderr:\n${r.stderr}`);
  if (r.artifacts.length === 0 && r.exitCode !== 0) {
    lines.push("No artifacts produced. The tool failed — see stdout/stderr above; the error is reported verbatim.");
  }
  return lines.join("\n").slice(0, 10_000);
}
