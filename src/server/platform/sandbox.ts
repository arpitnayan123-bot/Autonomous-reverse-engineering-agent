import { spawn } from "child_process";
import path from "node:path";
import { isPathInside } from "@/lib/security";
import { db } from "@/lib/db";

/**
 * Docker-based sandboxing for workspace command execution.
 *
 * The process-level jail in builder.ts (no shell, allowlist, cwd pin,
 * scrubbed env, hard timeout) is the platform baseline. When a Docker or
 * Podman daemon is reachable, commands can additionally run INSIDE a
 * disposable container:
 *
 *   docker run --rm --network none --read-only --tmpfs /tmp \
 *     --memory 512m --cpus 1 \
 *     -v <workspacePath>:/workspace:rw -w /workspace \
 *     <image> <command-as-argv>
 *
 * Guarantees layered on top of the process jail:
 *   - the container has NO network (--network none),
 *   - a read-only rootfs (--read-only) with a single writable tmpfs /tmp,
 *   - a hard 512 MB memory cap and 1 CPU,
 *   - the ONLY writable host path is the workspace bind-mount (rw),
 *   - the command argv is passed exec-form (a JSON array of arguments) —
 *     there is no shell on the host AND none inside the container, so pipes,
 *     globs and $VAR interpolation are never interpreted,
 *   - the container is --rm (removed after every run).
 *
 * The command still goes through builder's allowlist and chat-mode guards
 * BEFORE a container is ever created — sandboxing is defense in depth, not a
 * replacement for the command policy.
 *
 * IMAGE ALLOWLIST CONTRACT: the container image must contain the binaries
 * builder's allowlist admits (node, python3, git, gcc, … — see
 * COMMAND_ALLOWLIST in builder.ts). The default image is node:20-alpine,
 * which ships node/npm plus busybox userland (ls, cat, grep, find, tar, …)
 * but NOT python3/gcc/git — allowlisted commands that are missing from the
 * image fail inside the container with an honest exit-127 stderr. Operators
 * who need the full allowlist must set AREA_SANDBOX_IMAGE to an image that
 * contains those binaries (documented in README.md).
 */

/** Container image used when AREA_SANDBOX_IMAGE is not set. */
export const DEFAULT_SANDBOX_IMAGE = "node:20-alpine";

/** The image that would be used right now (AREA_SANDBOX_IMAGE override aware). */
export function sandboxImage(): string {
  const override = process.env.AREA_SANDBOX_IMAGE?.trim() ?? process.env.REA_SANDBOX_IMAGE?.trim(); // legacy REA_* env kept working
  return override && override.length > 0 ? override : DEFAULT_SANDBOX_IMAGE;
}

/** Hard cap for container runs — identical to the process-jail ceiling. */
const CONTAINER_TIMEOUT_CAP_MS = 120_000;

/** Output caps — identical to the process jail. */
const MAX_OUT = 200 * 1024;

/**
 * The only host tree that may ever be bind-mounted into a container.
 * MUST mirror builder.workspaceRoot() — asserted by a test so the two
 * constants cannot silently drift apart.
 */
export function containerWorkspaceRoot(): string {
  return path.join(process.cwd(), "storage", "workspaces");
}

/**
 * Bind-mount path validation: the mounted host directory must be an
 * ABSOLUTE path INSIDE the platform workspace root. A container must never
 * be handed an arbitrary host directory (that would turn the sandbox inside
 * out — the mount is the one rw door into the host filesystem).
 */
export function validateBindMountPath(workspacePath: string): { ok: true } | { ok: false; error: string } {
  if (typeof workspacePath !== "string" || workspacePath.trim() === "") {
    return { ok: false, error: "bind-mount path validation failed: empty workspace path" };
  }
  const resolved = path.resolve(workspacePath);
  if (resolved !== workspacePath) {
    return {
      ok: false,
      error: `bind-mount path validation failed: path must be absolute and normalized (got "${workspacePath.slice(0, 200)}")`,
    };
  }
  if (!isPathInside(resolved, containerWorkspaceRoot())) {
    return {
      ok: false,
      error: `bind-mount path validation failed: "${resolved.slice(0, 200)}" is outside the platform workspace root — only directories under ${containerWorkspaceRoot()} may be mounted into a container`,
    };
  }
  return { ok: true };
}

// --- no-shell tokenizer (shared with builder.ts) -----------------------------
//
// Lives here so both the process jail and the container path parse commands
// with the SAME tokenizer — one implementation, no drift. The shell is never
// involved: single/double quotes are honored, everything else is literal.

export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (started || cur) {
        out.push(cur);
        cur = "";
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started || cur) out.push(cur);
  return out;
}

// --- availability probe (cached for the process lifetime) --------------------

interface ContainerCli {
  bin: "docker" | "podman";
  available: boolean;
}

let containerCliCache: ContainerCli | null = null;

/** Test hook: force the availability probe (null = re-probe naturally). */
export function setDockerAvailabilityForTesting(v: boolean | null): void {
  containerCliCache = v === null ? null : { bin: "docker", available: v };
}

function probeContainerCli(bin: "docker" | "podman"): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      // `version` (not `--version`) — it also verifies the DAEMON responds,
      // which is the real availability question; a CLI without a daemon is
      // not a usable sandbox.
      const child = spawn(bin, ["version"], { stdio: "ignore", shell: false });
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
        done(false);
      }, 5_000);
      child.on("error", () => { clearTimeout(timer); done(false); });
      child.on("close", (code) => { clearTimeout(timer); done(code === 0); });
    } catch {
      done(false);
    }
  });
}

/**
 * Whether a container runtime (Docker, else Podman) is usable right now:
 * the CLI exists AND its daemon answers. Probed once, then cached for the
 * process lifetime.
 */
export async function detectDocker(): Promise<boolean> {
  if (containerCliCache !== null) return containerCliCache.available;
  const docker = await probeContainerCli("docker");
  containerCliCache = docker
    ? { bin: "docker", available: true }
    : { bin: "podman", available: await probeContainerCli("podman") };
  return containerCliCache.available;
}

/** The resolved runtime binary ("docker" | "podman"); for honest reporting. */
export async function containerRuntimeBin(): Promise<string | null> {
  if (containerCliCache === null) await detectDocker();
  return containerCliCache?.available ? containerCliCache.bin : null;
}

// --- container execution ------------------------------------------------------

export interface ContainerRunResult {
  /** The docker/podman argv that was constructed (for honest receipts). */
  argv: string[];
  image: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** Set when the mount path was rejected or the runtime could not spawn. */
  refused?: string;
}

/**
 * Run one command inside a disposable container with the workspace
 * bind-mounted at /workspace. The command string is parsed with the shared
 * no-shell tokenizer and appended AFTER the image as an exec-form argv
 * array — the container interprets it directly, no shell either side.
 *
 * Every env entry is passed into the container with `-e KEY=VALUE`; values
 * that reference the HOST workspace path are translated to /workspace so
 * HOME (set to the host workspace dir by builder) keeps pointing at the
 * mounted workspace inside the container.
 */
export async function runInContainer(
  workspacePath: string,
  command: string,
  timeoutMs: number,
  env: Record<string, string>
): Promise<ContainerRunResult> {
  const started = Date.now();
  const image = sandboxImage();
  const refused = (exitCode: number, message: string): ContainerRunResult => ({
    argv: [], image, exitCode, stdout: "", stderr: message, timedOut: false,
    durationMs: Date.now() - started, refused: message,
  });

  // Gate 1 — the bind mount is the one rw door into the host; validate it
  // BEFORE any container exists.
  const mount = validateBindMountPath(workspacePath);
  if (!mount.ok) return refused(126, mount.error);

  // Gate 2 — a runtime must actually be there (the caller normally checked
  // detectDocker(); re-verifying keeps runInContainer safe standalone).
  const bin = await containerRuntimeBin();
  if (!bin) return refused(127, "docker is not available on this platform.");

  const argv = tokenize(command);
  if (argv.length === 0) return refused(126, "empty command");

  // The exact sandbox posture: no network, read-only rootfs, tmpfs /tmp,
  // 512 MB memory, 1 CPU, workspace bind-mounted rw at /workspace.
  const runArgs = [
    "run", "--rm",
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp",
    "--memory", "512m",
    "--cpus", "1",
    "-v", `${workspacePath}:/workspace:rw`,
    "-w", "/workspace",
  ];

  // Command environment → `-e KEY=VALUE` pairs (host workspace paths inside
  // values are translated to their container-side location).
  for (const [key, value] of Object.entries(env)) {
    const translated = value === workspacePath ? "/workspace" : value;
    runArgs.push("-e", `${key}=${translated}`);
  }

  // Image, then the command as a JSON/argv array — exec form, no shell.
  runArgs.push(image, ...argv);

  return new Promise<ContainerRunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const startedSpawn = Date.now();
    // The container CLI runs with the PLATFORM environment (it needs
    // DOCKER_HOST/registry credentials); the COMMAND's scrubbed env enters
    // the container only through the -e pairs above.
    let child;
    try {
      child = spawn(bin, runArgs, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    } catch (err) {
      resolve(refused(127, `${bin}: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      // A grandchild that outlived the CLI (a daemon, a spawned test runner)
      // inherits the stdio pipes and would keep "close" pending until IT
      // exits — destroy the streams so the timeout is honored immediately.
      // (stdin is "ignore" — there is no stream to destroy on that side.)
      try { child.stdout?.destroy(); } catch { /* noop */ }
      try { child.stderr?.destroy(); } catch { /* noop */ }
    }, Math.min(timeoutMs, CONTAINER_TIMEOUT_CAP_MS));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { if (stdout.length < MAX_OUT) stdout += d; });
    child.stderr.on("data", (d: string) => { if (stderr.length < MAX_OUT) stderr += d; });
    const finish = (code: number) => {
      clearTimeout(timer);
      resolve({
        argv: runArgs, image, exitCode: code,
        stdout: stdout.slice(0, MAX_OUT), stderr: stderr.slice(0, MAX_OUT),
        timedOut, durationMs: Date.now() - startedSpawn,
      });
    };
    child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));
    child.on("error", (err) => {
      stderr += String(err);
      finish(127);
    });
  });
}

// --- per-user sandbox preference ----------------------------------------------

export type SandboxMode = "auto" | "process" | "docker";

export const SANDBOX_MODES: readonly SandboxMode[] = ["auto", "process", "docker"];

export function isSandboxMode(v: unknown): v is SandboxMode {
  return typeof v === "string" && (SANDBOX_MODES as readonly string[]).includes(v);
}

/**
 * The sandbox mode configured by this user (Security tab). Any trouble —
 * unknown user, missing row, database hiccup — degrades to "auto": the
 * platform default. The mode is a PREFERENCE, never a security bypass:
 * even "docker" runs go through builder's allowlist and guards first.
 */
export async function getUserSandboxMode(userId: string | undefined | null): Promise<SandboxMode> {
  if (!userId) return "auto";
  try {
    const row = await db.userPreference.findUnique({ where: { userId } });
    return isSandboxMode(row?.sandboxMode) ? row.sandboxMode : "auto";
  } catch {
    return "auto";
  }
}

/** Upsert the preference (called from the security-scoped /api/preferences). */
export async function setUserSandboxMode(userId: string, mode: SandboxMode): Promise<void> {
  await db.userPreference.upsert({
    where: { userId },
    update: { sandboxMode: mode },
    create: { userId, sandboxMode: mode },
  });
}
