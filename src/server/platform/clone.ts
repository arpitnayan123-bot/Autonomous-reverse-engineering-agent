/**
 * CLONE stage executors (Capability C3) — turn BUILD-stage artifacts into a
 * *runnable* clone, not just source snippets:
 *
 *   clone:dockerize  — web reconstructions get real deployment artifacts
 *                      (Dockerfile + compose + docs); when a container
 *                      runtime exists the image is BUILT and BOOTED and the
 *                      clone URL is recorded for equivalence verification.
 *   clone:decompile  — binary targets are routed through the RE toolchain
 *                      (ghidra → rizin → pycdc by availability) into
 *                      compilable C under clone/ in the workspace.
 *   clone:rebuild    — a build-system skeleton is generated and a REAL
 *                      compile is attempted when a C toolchain exists.
 *
 * Every failure is honest: no daemon, no tool, no compiler — the exact
 * reason and the exact enable command land in the step output.
 */

import { spawn } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { containerRuntimeBin } from "./sandbox";
import { workspaceDir, writeFile } from "./builder";
import { upsertGraph } from "./graph";
import { getAvailability, runReTool } from "@/server/retools/runner";
import { toolsForFile } from "@/server/retools/registry";

const BINARY_EXTENSIONS = new Set([
  ".elf", ".so", ".o", ".a", ".exe", ".dll", ".sys", ".dylib", ".macho",
  ".pyc", ".pyo", ".wasm", ".dex", ".apk", ".bin", ".out", "",
]);

interface CloneBinary { abs: string; rel: string; bytes: number }

async function walkFiles(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 4 || out.length > 400) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      await walkFiles(abs, out, depth + 1);
    } else if (e.isFile()) {
      out.push(abs);
    }
  }
}

/** Largest binary-looking file in the workspace (skip .git/node_modules). */
export async function pickPrimaryBinary(projectId: string): Promise<CloneBinary | null> {
  const ws = workspaceDir(projectId);
  const files: string[] = [];
  await walkFiles(ws, files, 0);
  let best: CloneBinary | null = null;
  for (const abs of files) {
    const rel = path.relative(ws, abs);
    if (rel.startsWith("clone/") || rel.startsWith(".git")) continue;
    const ext = path.extname(abs).toLowerCase();
    if (!BINARY_EXTENSIONS.has(ext)) continue;
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    // Skip obvious text sources misnamed with an empty extension
    if (ext === "") {
      try {
        const head = Buffer.from(await fs.readFile(abs)).subarray(0, 4096);
        if (!head.includes(0)) continue; // no NUL byte → likely text
      } catch {
        continue;
      }
    }
    if (!best || stat.size > best.bytes) best = { abs, rel, bytes: stat.size };
  }
  return best;
}

async function spawnCap(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let timedOut = false;
    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: `spawn failed: ${err instanceof Error ? err.message : String(err)}`, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* gone */ }
    }, timeoutMs);
    child.stdout.on("data", (d) => { if (stdout.join("").length < 8000) stdout.push(String(d)); });
    child.stderr.on("data", (d) => { if (stderr.join("").length < 8000) stderr.push(String(d)); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: stdout.join(""), stderr: `spawn error: ${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stdout.join(""), stderr: stderr.join(""), timedOut });
    });
  });
}

async function whichFirst(names: string[]): Promise<string | null> {
  for (const n of names) {
    const r = await spawnCap("which", [n], process.cwd(), 4_000);
    const p = r.stdout.trim().split("\n")[0]?.trim();
    if (r.code === 0 && p) return p;
  }
  return null;
}

// ---------------------------------------------------------------- dockerize

export interface CloneDockerizeResult {
  files: Array<{ path: string; bytes: number }>;
  runtimeAvailable: boolean;
  build?: { attempted: true; exitCode: number; output: string; image: string };
  boot?: { attempted: true; url: string | null; exitCode: number; output: string };
  note: string;
}

export async function cloneDockerize(
  projectId: string,
  project: { name: string; reference: string },
  goal: string
): Promise<CloneDockerizeResult> {
  const safeName = `rea-clone-${projectId.replace(/[^a-z0-9-]/gi, "").slice(0, 20)}`.toLowerCase();

  const dockerfile = `# Clone image generated by REA (clone:dockerize) for: ${project.name}
# Goal: ${goal.slice(0, 160)}
FROM nginx:alpine
COPY scaffold/ /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
`;

  const compose = `# Boot the reconstruction: docker compose up --build
services:
  clone:
    build: .
    image: ${safeName}
    ports:
      - "8080:80"
    restart: unless-stopped
`;

  const dockerignore = `.git
node_modules
*.md
!README-CLONE.md
`;

  const readme = `# REA Clone — ${project.name}

Generated by the REA CLONE stage from observed evidence (original: ${project.reference}).

## Run it

    docker compose up --build
    # → http://localhost:8080

## What this is

A self-hosted reconstruction scaffold produced from the pipeline's BUILD stage.
It serves the reconstructed site statically; the equivalence of this clone
against the original is measured by the VERIFY stage (behavioral checks +
reference diff), never assumed.

## Honest gaps

Anything the public evidence could not determine is recorded in REA-PLAN.md
at the workspace root.
`;

  const written: Array<{ path: string; bytes: number }> = [];
  for (const [p, content] of [
    ["clone/Dockerfile", dockerfile],
    ["clone/docker-compose.yml", compose],
    ["clone/.dockerignore", dockerignore],
    ["clone/README-CLONE.md", readme],
  ] as const) {
    const r = await writeFile(projectId, p, content);
    written.push({ path: r.path, bytes: r.bytes });
  }

  const runtimeBin = await containerRuntimeBin();
  if (!runtimeBin) {
    const note = "Clone deployment artifacts written (Dockerfile + compose + docs). Runtime boot test NOT performed: no Docker daemon is reachable on this host — the clone is runnable wherever Docker exists (`docker compose up --build` inside clone/).";
    await recordCloneNode(projectId, "clone:dockerize (artifacts only, no runtime)", note);
    return { files: written, runtimeAvailable: false, note };
  }

  // Real build + boot. Executed directly (argv array) — deliberately NOT via
  // builder.runCommand, whose allowlist governs workspace commands, not
  // platform-managed clone builds.
  const buildRes = await spawnCap(runtimeBin, ["build", "-t", safeName, "."], workspaceDir(projectId) + "/clone", 240_000);
  const build = { attempted: true as const, exitCode: buildRes.code, output: (buildRes.stdout + buildRes.stderr).slice(0, 4_000), image: safeName };
  if (buildRes.code !== 0) {
    const note = `Clone artifacts written; docker build FAILED (exit ${buildRes.code}) — output recorded verbatim above.`;
    await recordCloneNode(projectId, "clone:dockerize (build failed)", note);
    return { files: written, runtimeAvailable: true, build, note };
  }

  // Boot: detached container on a random host port, then probe it.
  const port = 30000 + Math.floor(Math.random() * 20000);
  const runRes = await spawnCap(runtimeBin, ["run", "-d", "--rm", "-p", `${port}:80`, safeName], workspaceDir(projectId), 30_000);
  let bootUrl: string | null = null;
  if (runRes.code === 0) {
    const containerId = runRes.stdout.trim().slice(0, 12);
    await new Promise((r) => setTimeout(r, 1_500));
    const probe = await spawnCap(runtimeBin, ["exec", containerId, "wget", "-qO-", "http://127.0.0.1/"], workspaceDir(projectId), 10_000);
    bootUrl = `http://127.0.0.1:${port}/`;
    // stop the container regardless (it was started --rm, so it removes itself)
    await spawnCap(runtimeBin, ["stop", containerId], workspaceDir(projectId), 15_000);
    const note = probe.code === 0
      ? `Clone image built and booted; probe returned ${probe.stdout.length} bytes. Boot URL: ${bootUrl}`
      : `Clone image built and started, but the in-container probe failed (exit ${probe.code}).`;
    await recordCloneNode(projectId, "clone:dockerize (built + booted)", note);
    return { files: written, runtimeAvailable: true, build, boot: { attempted: true, url: bootUrl, exitCode: runRes.code, output: runRes.stdout.slice(0, 500) }, note };
  }
  const note = `Clone image built; boot attempt failed (${runtimeBin} run exit ${runRes.code}): ${runRes.stderr.slice(0, 300)}`;
  await recordCloneNode(projectId, "clone:dockerize (boot failed)", note);
  return { files: written, runtimeAvailable: true, build, note };
}

// ---------------------------------------------------------------- decompile

export interface CloneDecompileResult {
  binary: { rel: string; bytes: number } | null;
  tool: string | null;
  mode: string | null;
  receipt: string | null;
  note: string;
}

export async function cloneDecompile(projectId: string): Promise<CloneDecompileResult> {
  const binary = await pickPrimaryBinary(projectId);
  if (!binary) {
    return { binary: null, tool: null, mode: null, receipt: null, note: "No binary-looking file found in the workspace — nothing to decompile." };
  }
  const candidates = toolsForFile(binary.abs);
  for (const toolId of candidates) {
    // availability probe per candidate (cached in the runner)
    const { getAvailability } = await import("@/server/retools/runner");
    const spec = (await import("@/server/retools/registry")).buildRegistry().find((s) => s.id === toolId);
    if (!spec) continue;
    const avail = await getAvailability(spec);
    if (avail.mode === "unavailable") continue;
    try {
      const res = await runReTool(toolId, { inputPath: binary.abs, operation: "decompile" });
      // Copy produced artifacts into the workspace so they are visible
      // alongside the source tree.
      const ws = workspaceDir(projectId);
      const copied: string[] = [];
      for (const a of res.artifacts) {
        // artifacts live under storage/retools/<tool>/<run>/<name>
        const runDir = path.resolve(process.cwd(), "storage", "retools", toolId);
        // find the freshest run dir containing this artifact
        const found = await findFreshArtifact(runDir, a.name);
        if (found) {
          const dest = path.join(ws, "clone", path.basename(a.name));
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.copyFile(found, dest);
          copied.push(path.relative(ws, dest));
        }
      }
      const receipt = `decompiled ${binary.rel} with ${toolId} (${res.mode}) — artifacts: ${copied.join(", ") || "none"}`;
      await writeFile(projectId, "clone/DECOMPILE-RECEIPT.md", `# Clone decompile receipt\n\n${receipt}\n\n\`\`\`\n${res.stdout.slice(0, 4_000)}${res.stderr ? `\nstderr:\n${res.stderr.slice(0, 2_000)}` : ""}\n\`\`\`\n`);
      await recordCloneNode(projectId, `clone:decompile via ${toolId}`, receipt, "DERIVED");
      return { binary: { rel: binary.rel, bytes: binary.bytes }, tool: toolId, mode: res.mode, receipt, note: copied.length ? `Decompiled output written to ${copied.join(", ")}.` : "Tool ran but produced no collected artifacts — see the receipt for verbatim tool output." };
    } catch (err) {
      // try the next candidate; the last error is reported if all fail
      const lastError = err instanceof Error ? err.message : String(err);
      if (toolId === candidates[candidates.length - 1]) {
        return { binary: { rel: binary.rel, bytes: binary.bytes }, tool: null, mode: null, receipt: null, note: `All candidate tools failed; last error: ${lastError}` };
      }
    }
  }
  return { binary: { rel: binary.rel, bytes: binary.bytes }, tool: null, mode: null, receipt: null, note: `No RE backend is available for this binary (tried: ${candidates.join(", ")}). Enable one: docker build -t rea/ghidra:11 docker/ghidra` };
}

async function findFreshArtifact(runRoot: string, relName: string): Promise<string | null> {
  try {
    const runs = await fs.readdir(runRoot);
    let best: { p: string; m: number } | null = null;
    for (const run of runs) {
      const p = path.join(runRoot, run, relName);
      try {
        const st = await fs.stat(p);
        if (!best || st.mtimeMs > best.m) best = { p, m: st.mtimeMs };
      } catch { /* not in this run */ }
    }
    return best?.p ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- rebuild

export interface CloneRebuildResult {
  files: Array<{ path: string; bytes: number }>;
  compiler: string | null;
  compile?: { exitCode: number; output: string };
  note: string;
}

export async function cloneRebuild(projectId: string): Promise<CloneRebuildResult> {
  const ws = workspaceDir(projectId);
  const cloneDir = path.join(ws, "clone");
  const makefile = `# REA clone rebuild skeleton (clone:rebuild)
# Adjust SRCS as the decompiled sources are organized.
CC ?= cc
CFLAGS ?= -O2 -Wall
SRCS := $(wildcard src/*.c)

clone_app: $(SRCS)
\t$(CC) $(CFLAGS) -o $@ $(SRCS)

clean:
\trm -f clone_app
`;

  const readme = `# Rebuilding the clone

1. Place the decompiled C sources under clone/src/ (the decompile step writes
   its primary output next to this file).
2. \`make\` — the skeleton compiles every src/*.c into clone_app.
3. Run \`./clone_app\` and compare behavior against the original binary; the
   VERIFY stage records the comparison.

The rebuild is REAL, not aspirational: when a C toolchain exists on the host,
this stage compiles what is present and reports the compiler's verbatim
output; when it does not, it says so.
`;
  const written: Array<{ path: string; bytes: number }> = [];
  for (const [p, content] of [
    ["clone/Makefile", makefile],
    ["clone/README-REBUILD.md", readme],
  ] as const) {
    const r = await writeFile(projectId, p, content);
    written.push({ path: r.path, bytes: r.bytes });
  }

  const compiler = await whichFirst(["cc", "gcc", "clang"]);
  if (!compiler) {
    const note = "Rebuild skeleton written (Makefile + docs). No C compiler found on this host — install gcc/clang to compile the decompiled sources here.";
    await recordCloneNode(projectId, "clone:rebuild (no compiler)", note);
    return { files: written, compiler: null, note };
  }
  const srcDir = path.join(cloneDir, "src");
  const hasSources = fsSync.existsSync(srcDir) && (await fs.readdir(srcDir)).some((f) => f.endsWith(".c"));
  if (!hasSources) {
    const note = `Compiler ${path.basename(compiler)} is available, but clone/src/ has no .c sources yet — place decompiled sources and run make.`;
    await recordCloneNode(projectId, "clone:rebuild (no sources yet)", note);
    return { files: written, compiler: path.basename(compiler), note };
  }
  const compile = await spawnCap("make", ["clone_app"], cloneDir, 120_000);
  const note = compile.code === 0
    ? `Compiled the clone with ${path.basename(compiler)} (exit 0). Binary: clone/clone_app.`
    : `Compile attempt FAILED (exit ${compile.code}) — make output recorded verbatim.`;
  await recordCloneNode(projectId, "clone:rebuild", note);
  return {
    files: written,
    compiler: path.basename(compiler),
    compile: { exitCode: compile.code, output: (compile.stdout + compile.stderr).slice(0, 4_000) },
    note,
  };
}

async function recordCloneNode(projectId: string, label: string, detail: string, provenance: "OBSERVED" | "DERIVED" = "OBSERVED"): Promise<void> {
  await upsertGraph(projectId, [
    {
      kind: "artifact",
      key: `clone:${label}:${Date.now()}`,
      label,
      meta: { detail: detail.slice(0, 500) },
      provenance,
    },
  ], []).catch(() => { /* graph is best-effort */ });
}

/** Count clone artifacts persisted for a project (used by reports). */
export async function cloneArtifactCount(projectId: string): Promise<number> {
  return db.buildArtifact.count({ where: { projectId, path: { startsWith: "clone/" } } });
}
