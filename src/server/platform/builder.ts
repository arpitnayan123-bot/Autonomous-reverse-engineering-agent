import { spawn } from "child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { isPathInside } from "@/lib/security";
import { db } from "@/lib/db";
import {
  detectDocker,
  runInContainer,
  sandboxImage,
  tokenize,
  type SandboxMode,
} from "@/server/platform/sandbox";

/**
 * REA Builder — isolated workspace execution.
 *
 * Every project gets its own workspace directory under storage/workspaces/.
 * All file operations are sandbox-checked with isPathInside BEFORE touching
 * the filesystem — path traversal ("../../etc/passwd") is impossible by
 * construction. Terminal commands run WITHOUT a shell (argument tokenizer,
 * no pipes/interpolation), from an allowlist, with a hard timeout and output
 * cap, in a scrubbed environment, always with cwd = the project workspace.
 *
 * Execution context — sandbox modes (see sandbox.ts):
 *   "process" — the process-level jail (no shell, allowlist, cwd pin, hard
 *               timeout, scrubbed env). The historical baseline.
 *   "docker"  — the same command policy, but the command runs INSIDE a
 *               disposable container (--network none, --read-only rootfs,
 *               tmpfs /tmp, 512 MB memory, 1 CPU, workspace bind-mounted
 *               rw at /workspace). Refused honestly when no container
 *               daemon is reachable — the command is NOT executed.
 *   "auto"    — container when one is available, process jail otherwise
 *               (the platform default).
 * The chosen mode is carried on the result (`sandbox`) so tool outputs can
 * report which context actually executed — never implied, always stated.
 *
 * Workspaces carry a built-in git history (see the "Git version control"
 * section): creation runs `git init` + an initial empty commit, and every
 * successful file write / file-changing command is auto-committed with a
 * deterministic message. Git operations use the SAME sandbox guarantees as
 * terminal commands — no shell, an allowlist of git subcommands, no
 * user-configurable flags that could escape the workspace — and degrade
 * gracefully when the git binary is missing (workspaces keep working;
 * the git tools report the unavailability honestly).
 *
 * Downloaded repository code is DATA: nothing is ever auto-executed.
 */

export function workspaceRoot(): string {
  return path.join(process.cwd(), "storage", "workspaces");
}

export function workspaceDir(projectId: string): string {
  return path.join(workspaceRoot(), projectId);
}

export async function ensureWorkspace(projectId: string): Promise<string> {
  const dir = workspaceDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  await ensureGitRepository(projectId, dir);
  return dir;
}

export function resolveSafe(projectId: string, relPath: string): string {
  const root = workspaceDir(projectId);
  const cleaned = relPath.replace(/^[/\\]+/, "");
  const abs = path.resolve(root, cleaned);
  if (!isPathInside(abs, root)) {
    throw new Error(`Path escapes the workspace sandbox: ${relPath}`);
  }
  return abs;
}

// --- File operations -------------------------------------------------------

export interface WorkspaceEntry {
  path: string; // workspace-relative
  type: "file" | "dir";
  sizeBytes?: number;
}

export async function listFiles(projectId: string, sub: string = ""): Promise<WorkspaceEntry[]> {
  const root = resolveSafe(projectId, sub || ".");
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: WorkspaceEntry[] = [];
  for (const e of entries) {
    if (out.length >= 300) break;
    const rel = path.join(sub, e.name);
    if (e.isDirectory()) out.push({ path: rel, type: "dir" });
    else if (e.isFile()) {
      let size = 0;
      try {
        size = (await fs.stat(path.join(root, e.name))).size;
      } catch {
        /* unreadable */
      }
      out.push({ path: rel, type: "file", sizeBytes: size });
    }
  }
  return out;
}

export async function readFile(projectId: string, relPath: string): Promise<string> {
  const abs = resolveSafe(projectId, relPath);
  const stat = await fs.stat(abs);
  if (stat.size > 1024 * 1024) throw new Error("File exceeds the 1 MB read cap");
  return fs.readFile(abs, "utf8");
}

export interface WorkspaceUsage {
  bytes: number;
  files: number;
  /** true when the walk hit its entry cap — bytes is then a LOWER bound. */
  truncated: boolean;
}

/** Walk entry cap so a pathological tree cannot pin the event loop. */
const DISK_USAGE_MAX_ENTRIES = 5000;

/**
 * Total bytes + file count of a workspace (recursive, entry-capped walk).
 * Powers the chat-workspace disk quota and honest usage reporting.
 */
export async function workspaceDiskUsage(projectId: string): Promise<WorkspaceUsage> {
  const root = workspaceDir(projectId);
  const usage: WorkspaceUsage = { bytes: 0, files: 0, truncated: false };
  const stack: string[] = [root];
  let visited = 0;
  while (stack.length > 0) {
    if (visited >= DISK_USAGE_MAX_ENTRIES) {
      usage.truncated = true;
      break;
    }
    const dir = stack.pop() as string;
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // vanished / unreadable dir — contributes nothing
    }
    for (const e of entries) {
      visited++;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          usage.bytes += (await fs.stat(p)).size;
          usage.files++;
        } catch {
          /* unreadable file */
        }
      }
    }
  }
  return usage;
}

/**
 * Per-workspace disk quota for CHAT workspaces (model-driven writes and
 * command-created files). Project workspaces are operator-driven and are NOT
 * quota-enforced — repo materialization can legitimately be large.
 */
export const CHAT_WORKSPACE_QUOTA_BYTES = 8 * 1024 * 1024;

export interface WriteResult {
  path: string;
  bytes: number;
  created: boolean;
  /**
   * Auto-commit receipt (git-integrated workspaces). Present when a git
   * commit was ATTEMPTED for this write: committed=true carries the short
   * SHA; committed=false carries the honest failure reason. Absent when git
   * is unavailable, the path is internal bookkeeping (.rea/), or the
   * workspace has no repository — the write itself is unaffected either way.
   */
  git?: GitCommitInfo;
}

export interface WriteOptions {
  maxBytes?: number;
  /**
   * Enforce a total per-workspace byte quota: the write is refused when
   * current usage − this file's existing size + the incoming bytes would
   * exceed quotaBytes (overwriting a file credits the bytes it replaces).
   * CHAT workspace tools pass CHAT_WORKSPACE_QUOTA_BYTES.
   */
  quotaBytes?: number;
  /**
   * Persist a BuildArtifact audit row (default true). CHAT workspace tools
   * pass false: the chat tool trace (persisted on the ChatMessage row) is
   * the receipt of record there, and chat workspaces have no Project row to
   * satisfy the BuildArtifact.projectId foreign key.
   */
  audit?: boolean;
}

export async function writeFile(
  projectId: string,
  relPath: string,
  content: string,
  opts?: WriteOptions
): Promise<WriteResult> {
  const maxBytes = opts?.maxBytes ?? 512 * 1024;
  const incoming = Buffer.byteLength(content, "utf8");
  if (incoming > maxBytes) {
    throw new Error(`Content exceeds the ${Math.round(maxBytes / 1024)} KB write cap`);
  }
  await ensureWorkspace(projectId);
  const abs = resolveSafe(projectId, relPath);
  if (opts?.quotaBytes !== undefined) {
    let existing = 0;
    try {
      existing = (await fs.stat(abs)).size;
    } catch {
      /* new file — nothing to credit */
    }
    const usage = await workspaceDiskUsage(projectId);
    const projected = usage.bytes - existing + incoming;
    if (projected > opts.quotaBytes) {
      throw new Error(
        `Workspace disk quota exceeded: this write would put the workspace at ${projected} bytes, over the ${opts.quotaBytes}-byte quota (${usage.files} file(s), ${usage.bytes} bytes currently used). Remove unused files (e.g. rm) or write smaller content — NOTHING was written.`
      );
    }
  }
  const existed = fsSync.existsSync(abs);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  if (opts?.audit !== false) {
    // Persist as a build artifact for auditability.
    await db.buildArtifact.create({
      data: {
        projectId,
        path: relPath,
        content: content.slice(0, 20_000),
        kind: "file",
        sizeBytes: incoming,
      },
    });
  }
  // Auto-commit the write into the workspace's built-in git history. This
  // must NEVER fail the write: any git trouble degrades to a receipt note.
  let git: GitCommitInfo | undefined;
  try {
    git = await gitCommitFileWrite(projectId, relPath, incoming);
  } catch (err) {
    git = { committed: false, note: `git commit skipped: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
  }
  return { path: relPath, bytes: incoming, created: !existed, ...(git !== undefined ? { git } : {}) };
}

export interface PatchResult {
  path: string;
  applied: boolean;
  reason?: string;
}

/** Apply a search/replace patch to a workspace file (exact match, once). */
export async function patchFile(
  projectId: string,
  relPath: string,
  find: string,
  replace: string
): Promise<PatchResult> {
  const content = await readFile(projectId, relPath);
  if (!content.includes(find)) {
    return { path: relPath, applied: false, reason: "search text not found (file may have changed)" };
  }
  const occurrences = content.split(find).length - 1;
  if (occurrences !== 1) {
    return { path: relPath, applied: false, reason: `search text matches ${occurrences} times — patch rejected (ambiguous)` };
  }
  await writeFile(projectId, relPath, content.replace(find, replace));
  return { path: relPath, applied: true };
}

// --- Repository materialization --------------------------------------------

/** Download a public GitHub repository tarball into the project workspace. */
export async function materializeGitHubRepo(projectId: string, owner: string, repo: string): Promise<{ ok: boolean; detail: string; files: number }> {
  const dir = await ensureWorkspace(projectId);
  const tarUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/HEAD`;
  const res = await fetch(tarUrl, {
    headers: { "user-agent": "REA-Platform/1.0" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    return { ok: false, detail: `tarball download failed: HTTP ${res.status} (repo may be private or renamed)`, files: 0 };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > 100 * 1024 * 1024) {
    return { ok: false, detail: `repository tarball too large (${Math.round(buf.byteLength / 1048576)} MB)`, files: 0 };
  }
  const tarPath = path.join(dir, "_repo.tar.gz");
  await fs.writeFile(tarPath, buf);
  // Extract with the system tar (allowlisted runner, no user input in args).
  const run = await runCommand(projectId, `tar -xzf _repo.tar.gz --strip-components=1`, 60_000);
  await fs.rm(tarPath, { force: true });
  if (run.exitCode !== 0) {
    return { ok: false, detail: `tar extraction failed: ${run.stderr.slice(0, 300) || run.stdout.slice(0, 300)}`, files: 0 };
  }
  const files = await listFiles(projectId);
  return { ok: true, detail: `extracted ${files.filter((f) => f.type === "file").length} entries`, files: files.length };
}

/** Materialize an uploaded target file into the workspace (copy, not move). */
export async function materializeTarget(projectId: string, targetId: string): Promise<{ ok: boolean; detail: string }> {
  const target = await db.target.findUnique({ where: { id: targetId } });
  if (!target) return { ok: false, detail: "target not found" };
  const absSource = path.resolve(process.cwd(), target.storedPath);
  if (!isPathInside(absSource, path.join(process.cwd(), "storage", "uploads"))) {
    return { ok: false, detail: "target storage path invalid" };
  }
  const dir = await ensureWorkspace(projectId);
  await fs.copyFile(absSource, path.join(dir, target.originalName));
  return { ok: true, detail: `copied ${target.originalName} (${target.sizeBytes} bytes)` };
}

// --- Terminal execution -----------------------------------------------------

/** Commands that may be executed inside a workspace. No shell is used. */
const COMMAND_ALLOWLIST = new Set([
  "node", "bun", "npm", "npx", "bunx", "python3", "pip3", "pip",
  "ls", "cat", "head", "tail", "wc", "grep", "find", "echo",
  "git", "mkdir", "touch", "cp", "mv", "rm", "tar", "sed", "awk",
  "which", "env", "date", "true",
]);

// The no-shell tokenizer (single/double quotes honored, shell never involved)
// lives in sandbox.ts and is shared with the container execution path — one
// implementation for both sandboxes, no drift.

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  blocked?: string;
  /**
   * Which sandbox actually executed the command — "docker" (container) or
   * "process" (jail). Absent on refusals (blocked) because nothing ran.
   * Tool outputs MUST derive their "executed in … sandbox" line from this
   * field, never from the requested mode: "auto" resolves at run time.
   */
  sandbox?: "docker" | "process";
}

export interface CommandOptions {
  /**
   * CHAT workspace mode — the stricter guard set for model-driven commands.
   * The project-workspace posture (allowlist, no shell, cwd jail) is kept and
   * additionally blocks binaries whose script/transport features can reach
   * outside the workspace (sed/awk/find/tar/git/env), interpreter eval flags
   * (node -e / python3 -c …), absolute-path arguments and `..` traversal
   * arguments. See the chat security posture: the boundary is PROCESS-level
   * (no OS namespace jail) — interpreters running workspace-resident files
   * execute with server privileges; that class is documented, not hidden.
   */
  chatMode?: boolean;
  /**
   * Execution context for this command:
   *   "auto" (default) — Docker container sandbox when a daemon is
   *     reachable, else the process-level jail below;
   *   "process" — always the process-level jail (pre-Docker behavior);
   *   "docker" — always the container sandbox; when Docker is unavailable
   *     the command is REFUSED with "Docker sandbox requested but not
   *     available" instead of silently downgrading.
   * Every mode passes the SAME command policy first: allowlist, chat-mode
   * guards, quota. The sandbox changes WHERE code runs, never WHAT may run.
   */
  sandbox?: SandboxMode;
}

/** Alias — runCommand's option contract (kept in sync with CommandOptions). */
export type RunCommandOptions = CommandOptions;

/** Binaries never permitted in chat workspaces (script/transport escape vectors). */
const CHAT_BLOCKED_BINS = new Set(["sed", "awk", "find", "tar", "git", "env"]);

/** Eval-style flags = arbitrary code smuggled through command args. */
const CHAT_EVAL_FLAGS: Record<string, Set<string>> = {
  node: new Set(["-e", "--eval", "-p", "--print"]),
  bun: new Set(["-e", "--eval", "-p", "--print"]),
  python3: new Set(["-c", "--command"]),
  npx: new Set(["-c", "--call"]),
  npm: new Set(["--exec"]),
};

/** The effective chat-mode allowlist (base allowlist minus blocked bins). */
export function chatCommandAllowlist(): string[] {
  return [...COMMAND_ALLOWLIST].filter((b) => !CHAT_BLOCKED_BINS.has(b)).sort();
}

function blockedResult(command: string, reason: string, hint: string): CommandResult {
  return {
    command,
    exitCode: 126,
    stdout: "",
    stderr: `${reason} ${hint}`,
    timedOut: false,
    durationMs: 0,
    blocked: reason,
  };
}

export async function runCommand(
  projectId: string,
  command: string,
  timeoutMs = 30_000,
  opts?: CommandOptions
): Promise<CommandResult> {
  const started = Date.now();
  const argv = tokenize(command);
  const blocked: CommandResult = {
    command, exitCode: 126, stdout: "", stderr: "", timedOut: false,
    durationMs: 0,
  };
  if (argv.length === 0) {
    return { ...blocked, blocked: "empty command", stderr: "empty command" };
  }
  const bin = argv[0];
  if (bin.includes("/") || bin.includes("\\")) {
    return { ...blocked, blocked: "absolute or relative binary paths are not allowed", stderr: "only allowlisted commands by bare name may run" };
  }
  if (!COMMAND_ALLOWLIST.has(bin)) {
    if (opts?.chatMode) {
      // Chat mode lists the EFFECTIVE chat allowlist — naming binaries that
      // chatMode blocks would be a dishonest advertisement.
      return blockedResult(
        command,
        `Command "${bin}" is not in the chat workspace allowlist.`,
        `Permitted in the chat workspace sandbox: ${chatCommandAllowlist().join(" ")}. Paths must be workspace-relative; no eval flags.`
      );
    }
    return {
      ...blocked,
      blocked: `command not in allowlist: ${bin}`,
      stderr: `Command "${bin}" is not in the workspace allowlist. Allowed: ${[...COMMAND_ALLOWLIST].sort().join(" ")}`,
    };
  }
  // rm safety: restrict to the workspace (cwd is the workspace; forbid absolute targets).
  if (bin === "rm" && argv.some((a) => a.startsWith("/"))) {
    return { ...blocked, blocked: "rm with absolute path rejected", stderr: "rm may only target workspace-relative paths" };
  }

  // Chat-mode guards: the model drives these commands, so every argument is
  // treated as untrusted input. Each rejection is an HONEST result string —
  // the command did not run, and the reason is precise (never fabricated).
  if (opts?.chatMode) {
    const chatHint = `Permitted in the chat workspace sandbox: ${chatCommandAllowlist().join(" ")}. Paths must be workspace-relative; no eval flags.`;
    if (CHAT_BLOCKED_BINS.has(bin)) {
      return blockedResult(
        command,
        `Command "${bin}" is not permitted in the chat workspace sandbox (its script/transport features can read or write outside the workspace).`,
        chatHint
      );
    }
    const evalFlags = CHAT_EVAL_FLAGS[bin];
    if (evalFlags) {
      const smuggled = argv.slice(1).find((a) => evalFlags.has(a));
      if (smuggled !== undefined) {
        return blockedResult(
          command,
          `"${bin} ${smuggled}" (inline code evaluation) is not permitted in the chat workspace — write the code to a file with workspace_write first, then run it as a file.`,
          chatHint
        );
      }
    }
    for (const a of argv.slice(1)) {
      if (a.startsWith("/")) {
        return blockedResult(
          command,
          `Argument "${a}" is an absolute path — chat workspace commands may only reference paths inside the workspace.`,
          chatHint
        );
      }
      if (a.split("/").includes("..") || a.split("\\").includes("..")) {
        return blockedResult(
          command,
          `Argument "${a}" escapes the workspace (".." traversal is not permitted in chat workspace commands).`,
          chatHint
        );
      }
    }
  }

  // Chat-mode disk-quota guard (LAST cheap→expensive guard, pre-spawn): a
  // workspace already at its quota must refuse further execution —
  // command-created files could otherwise grow it unbounded. Honest block:
  // the command did NOT run.
  if (opts?.chatMode) {
    const usage = await workspaceDiskUsage(projectId);
    if (usage.bytes >= CHAT_WORKSPACE_QUOTA_BYTES) {
      return blockedResult(
        command,
        `Workspace is at its disk quota (${usage.bytes} of ${CHAT_WORKSPACE_QUOTA_BYTES} bytes) — command NOT executed.`,
        "Free space first (e.g. rm an unused file), then re-run."
      );
    }
  }

  const cwd = await ensureWorkspace(projectId);
  const env: Record<string, string> = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: cwd,
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    CI: "1",
  };

  // Git snapshot BEFORE the command — compared against the working tree
  // after the run to detect (and commit) real file changes. null = git
  // unavailable or no repository: bookkeeping silently skipped.
  const gitBefore = await gitStatusSnapshot(projectId);

  // --- execution: resolve the sandbox mode and run --------------------------
  //
  // The command policy above is IDENTICAL for both sandboxes; only the
  // execution context differs. The result records the mode that ACTUALLY
  // ran (`sandbox`) so callers report honestly instead of echoing the ask.
  const mode: SandboxMode = opts?.sandbox ?? "auto";

  /** The historical process-level jail (no shell, cwd pinned, scrubbed env). */
  const runProcessJail = (): Promise<CommandResult> =>
    new Promise<CommandResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const MAX_OUT = 200 * 1024;
      const child = spawn(bin, argv.slice(1), {
        cwd,
        env: env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
        // A grandchild that outlived the command (a spawned test runner, a
        // daemon) inherits the stdio pipes and would keep "close" pending
        // until IT exits — destroy the streams so the timeout lands now.
        // (stdin is "ignore" — there is no stream to destroy on that side.)
        try { child.stdout?.destroy(); } catch { /* noop */ }
        try { child.stderr?.destroy(); } catch { /* noop */ }
      }, Math.min(timeoutMs, 120_000));
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        if (stdout.length < MAX_OUT) stdout += d;
      });
      child.stderr.on("data", (d: string) => {
        if (stderr.length < MAX_OUT) stderr += d;
      });
      const finish = (code: number) => {
        clearTimeout(timer);
        resolve({
          command,
          exitCode: code,
          stdout: stdout.slice(0, MAX_OUT),
          stderr: stderr.slice(0, MAX_OUT),
          timedOut,
          durationMs: Date.now() - started,
          sandbox: "process",
        });
      };
      child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));
      child.on("error", (err) => {
        stderr += String(err);
        finish(127);
      });
    });

  let result: CommandResult;
  if (mode === "process") {
    result = await runProcessJail();
  } else if (await detectDocker()) {
    // Container path: the SAME scrubbed env goes in via -e (runInContainer
    // translates the host workspace paths to /workspace), with PATH pinned
    // to the container-standard lookup dirs — the host PATH entries are
    // meaningless inside the image and could only break binary resolution.
    const containerEnv: Record<string, string> = {
      ...env,
      PATH: "/usr/local/bin:/usr/bin:/bin",
    };
    const c = await runInContainer(cwd, command, Math.min(timeoutMs, 120_000), containerEnv);
    if (c.refused) {
      // Mount-path rejection / runtime vanished between probe and spawn —
      // the command did NOT run; refuse honestly.
      result = {
        command,
        exitCode: c.exitCode,
        stdout: "",
        stderr: c.stderr,
        timedOut: false,
        durationMs: c.durationMs,
        blocked: c.refused,
      };
    } else {
      result = {
        command,
        exitCode: c.exitCode,
        stdout: c.stdout,
        stderr: c.stderr,
        timedOut: c.timedOut,
        durationMs: c.durationMs,
        sandbox: "docker",
      };
    }
  } else if (mode === "docker") {
    // Explicit container request, no daemon: refuse — never silently
    // downgrade an explicit security choice.
    return blockedResult(
      command,
      "Docker sandbox requested but not available",
      `No docker/podman daemon answered. Switch the sandbox mode to "auto" or "process" in Security settings, or start the container runtime (image: ${sandboxImage()}).`
    );
  } else {
    // "auto" with no container runtime: the historical process jail.
    result = await runProcessJail();
  }

  // Auto-commit a run that changed the working tree ("run: <command>").
  // Blocked commands never executed — nothing to commit. Git bookkeeping
  // must NEVER fail the command result: every failure degrades silently
  // (the working tree simply stays uncommitted until the next snapshot).
  if (!result.blocked && gitBefore !== null) {
    try {
      const after = await gitStatusSnapshot(projectId);
      if (after !== null && after !== gitBefore) {
        await withGitLock(projectId, async () => {
          const dir = workspaceDir(projectId);
          await gitSpawn(dir, ["add", "-A"], GIT_AUTO_TIMEOUT_MS);
          await gitSpawn(dir, ["commit", "--no-verify", "-m", `run: ${command.slice(0, 500)}`], GIT_AUTO_TIMEOUT_MS);
        });
      }
    } catch {
      /* degrade gracefully — honest tree state returns on the next snapshot */
    }
  }
  return result;
}

// --- Git version control -----------------------------------------------------
//
// Every workspace carries a built-in git repository:
//   * creation (ensureWorkspace) runs `git init`, stamps the repo-local
//     commit identity (REA Agent <agent@rea.local>) and records an initial
//     EMPTY commit as the root of the history;
//   * every successful file write is auto-committed ("write: <path> (N bytes)");
//   * every executed command that changed the working tree is auto-committed
//     ("run: <command>") — detected via `git status --porcelain` before/after;
//   * .git/ lives INSIDE the workspace, so it counts toward the disk quota
//     (workspaceDiskUsage walks it like any other directory).
//
// Sandbox guarantees (identical to terminal commands): no shell, cwd jailed
// to the workspace, scrubbed environment (plus git-specific hardening), hard
// timeout with SIGKILL, output caps. Arguments are validated BEFORE spawn:
// only an allowlist of git subcommands, only per-subcommand allowlisted
// flags — global options that could point git outside the workspace
// (--git-dir, --work-tree, -c, -C, …) are refused. All git invocations are
// constructed INTERNALLY from fixed templates plus validated revisions —
// the model never supplies raw git argv.
//
// Degradation: if the git binary is missing, workspaces keep working and
// git bookkeeping is skipped silently; the git tools return
// GIT_UNAVAILABLE_ERROR verbatim.

/** Commit identity stamped on every workspace commit (repo-local config). */
export const GIT_COMMIT_IDENTITY = { name: "REA Agent", email: "agent@rea.local" } as const;

/** Exact tool-facing error when the git binary is not installed. */
export const GIT_UNAVAILABLE_ERROR = "Error: git is not available on this platform.";

const GIT_BIN = "git";
const GIT_TIMEOUT_MS = 20_000;
const GIT_AUTO_TIMEOUT_MS = 30_000;
const GIT_MAX_OUT = 200 * 1024;

/** Subcommands a workspace git invocation may ever use. */
export const GIT_SUBCOMMAND_ALLOWLIST = new Set([
  "init", "add", "commit", "status", "diff", "log", "reset", "rev-parse",
]);

/** Global options that could point git OUTSIDE the workspace — never permitted. */
const GIT_FORBIDDEN_FLAGS = [
  "--git-dir", "--work-tree", "--exec-path", "--namespace", "--super-prefix", "--shallow-file",
] as const;

/**
 * Per-subcommand flag allowlist — an argument starting with "-" is only
 * accepted when it (or its "--flag=value" head) appears here. This is what
 * makes user-influenced flag injection impossible: every argv element is
 * either an allowlisted flag or a plain value (revision / path / message),
 * and the plain values are constructed from validated input.
 */
const GIT_FLAG_ALLOWLIST: Record<string, Set<string>> = {
  init: new Set([]),
  add: new Set(["-A", "--"]),
  commit: new Set(["--no-verify", "--allow-empty", "-m"]),
  status: new Set(["--porcelain"]),
  diff: new Set(["--no-color", "--no-ext-diff", "--stat", "--"]),
  log: new Set(["--no-color", "--max-count", "--format", "--date"]),
  reset: new Set(["--hard", "--mixed", "--soft", "--quiet", "-q"]),
  "rev-parse": new Set(["--verify", "--short", "--quiet"]),
};

/** Validate a git argv BEFORE spawn. Refusals are precise and honest. */
export function validateGitArgs(args: string[]): { ok: true } | { ok: false; error: string } {
  if (args.length === 0) return { ok: false, error: "empty git argv" };
  const sub = args[0];
  if (!GIT_SUBCOMMAND_ALLOWLIST.has(sub)) {
    return {
      ok: false,
      error: `git subcommand "${sub.slice(0, 60)}" is not allowlisted (allowed: ${[...GIT_SUBCOMMAND_ALLOWLIST].sort().join(", ")})`,
    };
  }
  const flags = GIT_FLAG_ALLOWLIST[sub] ?? new Set<string>();
  for (const a of args.slice(1)) {
    if (!a.startsWith("-")) continue; // plain value: revision, path or message
    if (GIT_FORBIDDEN_FLAGS.some((f) => a === f || a.startsWith(`${f}=`))) {
      return { ok: false, error: `git flag "${a.slice(0, 60)}" is forbidden — it can point git outside the workspace` };
    }
    if (a.startsWith("-c") || a.startsWith("-C")) {
      return { ok: false, error: `git flag "${a.slice(0, 60)}" is forbidden ("-c"/"-C" can execute arbitrary config or relocate the workspace)` };
    }
    const eq = a.indexOf("=");
    const head = eq === -1 ? a : a.slice(0, eq);
    if (!flags.has(a) && !flags.has(head)) {
      return { ok: false, error: `git flag "${a.slice(0, 60)}" is not permitted for "${sub}"` };
    }
  }
  return { ok: true };
}

/** Revisions accepted by the git tools: commit SHAs (7-40 hex) or HEAD/HEAD~N. */
export const GIT_REV_HINT = 'a commit SHA (7-40 hex chars — see workspace_log) or a HEAD reference ("HEAD", "HEAD~N")';

export function isValidGitRev(rev: string): boolean {
  return /^HEAD(~[0-9]+)?$/i.test(rev) || /^[0-9a-f]{7,40}$/i.test(rev);
}

// --- availability probe (cached for the process lifetime) -------------------

let gitAvailableCache: boolean | null = null;

/** Test hook: force the availability probe (null = re-probe naturally). */
export function setGitAvailabilityForTesting(v: boolean | null): void {
  gitAvailableCache = v;
}

function probeGitBinary(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const child = spawn(GIT_BIN, ["--version"], { stdio: "ignore", shell: false });
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

/** Whether the git binary is usable (probed once, then cached). */
export async function gitAvailable(): Promise<boolean> {
  if (gitAvailableCache !== null) return gitAvailableCache;
  gitAvailableCache = await probeGitBinary();
  return gitAvailableCache;
}

// --- sandboxed git spawn ------------------------------------------------------

export interface GitResult {
  args: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Scrubbed environment for git — same base as runCommand plus git hardening. */
function gitEnv(cwd: string): Record<string, string> {
  return {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: cwd, // a stray --global write would land inside the jail
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    CI: "1",
    GIT_CONFIG_NOSYSTEM: "1", // ignore system-level git config
    GIT_TERMINAL_PROMPT: "0", // never prompt for credentials
    GIT_AUTHOR_NAME: GIT_COMMIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: GIT_COMMIT_IDENTITY.email,
    GIT_COMMITTER_NAME: GIT_COMMIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: GIT_COMMIT_IDENTITY.email,
  };
}

function gitSpawn(cwd: string, args: string[], timeoutMs: number, started = Date.now()): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(GIT_BIN, args, {
      cwd,
      env: gitEnv(cwd) as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, Math.min(timeoutMs, 120_000));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { if (stdout.length < GIT_MAX_OUT) stdout += d; });
    child.stderr.on("data", (d: string) => { if (stderr.length < GIT_MAX_OUT) stderr += d; });
    const finish = (code: number) => {
      clearTimeout(timer);
      resolve({ args, exitCode: code, stdout: stdout.slice(0, GIT_MAX_OUT), stderr: stderr.slice(0, GIT_MAX_OUT), timedOut, durationMs: Date.now() - started });
    };
    child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));
    child.on("error", (err) => {
      stderr += String(err);
      finish(127);
    });
  });
}

/**
 * Run one validated, sandboxed git operation in a workspace. The caller is
 * responsible for the workspace existing (ensureWorkspace) — runGit only
 * makes sure the directory is present. Refusals (validation, availability)
 * return a result with a non-zero exit code and a precise stderr — they
 * never throw.
 */
export async function runGit(projectId: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  const started = Date.now();
  const refused = (exitCode: number, stderr: string): GitResult => ({
    args, exitCode, stdout: "", stderr, timedOut: false, durationMs: Date.now() - started,
  });
  const check = validateGitArgs(args);
  if (!check.ok) return refused(126, `Refused: ${check.error}`);
  if (!(await gitAvailable())) return refused(127, GIT_UNAVAILABLE_ERROR.replace(/^Error: /, ""));
  const dir = workspaceDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  return gitSpawn(dir, args, timeoutMs, started);
}

// --- per-workspace git lock ---------------------------------------------------
//
// Subagents share a session workspace and may run concurrently; git's index
// is single-writer. A tiny per-workspace promise-chain mutex serializes the
// mutation sequences (init / add+commit) so interleaved auto-commits fail
// with "index.lock" errors instead of corrupting bookkeeping.

const gitLocks = new Map<string, Promise<unknown>>();

async function withGitLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = gitLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  gitLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (gitLocks.get(key) === run) gitLocks.delete(key);
  }
}

// --- repository bootstrap ------------------------------------------------------

/** Repo-local commit identity (written as .git/config INI — no git subcommand needed). */
async function writeGitIdentity(dir: string): Promise<void> {
  const cfg = path.join(dir, ".git", "config");
  try {
    const content = await fs.readFile(cfg, "utf8");
    if (/\[user\]/i.test(content)) return; // already stamped
    await fs.appendFile(
      cfg,
      `\n[user]\n\tname = ${GIT_COMMIT_IDENTITY.name}\n\temail = ${GIT_COMMIT_IDENTITY.email}\n`,
      "utf8"
    );
  } catch {
    /* config unreadable — identity is still guaranteed via the GIT_AUTHOR / GIT_COMMITTER env vars */
  }
}

/**
 * Initialize the workspace git repository (idempotent, best-effort):
 * `git init` → repo-local identity → initial EMPTY commit → housekeeping
 * .gitignore (platform bookkeeping under .rea/ is not version-controlled
 * material). Any failure degrades silently — the workspace keeps working
 * without git.
 */
export async function ensureGitRepository(projectId: string, dir?: string): Promise<void> {
  const d = dir ?? workspaceDir(projectId);
  if (fsSync.existsSync(path.join(d, ".git"))) return; // fast path: one stat
  if (!(await gitAvailable())) return;
  await withGitLock(projectId, async () => {
    if (fsSync.existsSync(path.join(d, ".git"))) return; // lost the race
    const init = await gitSpawn(d, ["init"], GIT_TIMEOUT_MS);
    if (init.exitCode !== 0) return;
    await writeGitIdentity(d);
    // The initial EMPTY commit — the root of the workspace history.
    const empty = await gitSpawn(d, ["commit", "--no-verify", "--allow-empty", "-m", "init"], GIT_TIMEOUT_MS);
    if (empty.exitCode !== 0) return;
    const gitignore = ".rea/\n"; // verify-history bookkeeping stays out of VCS
    const giPath = path.join(d, ".gitignore");
    if (!fsSync.existsSync(giPath)) {
      try {
        await fs.writeFile(giPath, gitignore, "utf8");
        await gitSpawn(d, ["add", ".gitignore"], GIT_TIMEOUT_MS);
        await gitSpawn(d, ["commit", "--no-verify", "-m", `write: .gitignore (${Buffer.byteLength(gitignore, "utf8")} bytes)`], GIT_TIMEOUT_MS);
      } catch {
        /* .gitignore housekeeping is optional — history root already exists */
      }
    }
  });
}

// --- auto-commit receipts -------------------------------------------------------

export interface GitCommitInfo {
  committed: boolean;
  /** Short SHA of the new commit (committed=true). */
  sha?: string;
  /** Honest failure reason when the commit did not happen (committed=false). */
  note?: string;
}

function gitFirstLine(s: string): string {
  const line = s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.slice(0, 200);
}

/**
 * Auto-commit a successful file write. Returns undefined when there is
 * nothing git-flavored to report (git unavailable, no repository, or an
 * internal bookkeeping path). Never throws; a failed commit becomes a
 * receipt note — the write itself is already on disk and stays.
 */
async function gitCommitFileWrite(projectId: string, relPath: string, bytes: number): Promise<GitCommitInfo | undefined> {
  if (relPath.startsWith(".rea/")) return undefined; // gitignored bookkeeping
  if (!(await gitAvailable())) return undefined;
  const dir = workspaceDir(projectId);
  if (!fsSync.existsSync(path.join(dir, ".git"))) return undefined;
  return withGitLock(projectId, async () => {
    const add = await gitSpawn(dir, ["add", relPath], GIT_AUTO_TIMEOUT_MS);
    if (add.exitCode !== 0) {
      return { committed: false, note: `git add failed: ${gitFirstLine(add.stderr) || "unknown error"}` };
    }
    const commit = await gitSpawn(dir, ["commit", "--no-verify", "-m", `write: ${relPath} (${bytes} bytes)`], GIT_AUTO_TIMEOUT_MS);
    if (commit.exitCode !== 0) {
      return { committed: false, note: `git commit failed: ${gitFirstLine(commit.stderr) || "nothing to commit"}` };
    }
    const sha = await gitSpawn(dir, ["rev-parse", "--short", "HEAD"], GIT_TIMEOUT_MS);
    return { committed: true, sha: sha.stdout.trim() || undefined };
  });
}

/**
 * Working-tree snapshot for change detection (`git status --porcelain`).
 * null = git unavailable / no repository / status failed — no bookkeeping.
 */
async function gitStatusSnapshot(projectId: string): Promise<string | null> {
  if (!(await gitAvailable())) return null;
  const dir = workspaceDir(projectId);
  if (!fsSync.existsSync(path.join(dir, ".git"))) return null;
  const st = await gitSpawn(dir, ["status", "--porcelain"], GIT_TIMEOUT_MS);
  if (st.exitCode !== 0) return null;
  return st.stdout;
}

/** Quick workspace health probe: file count, manifest presence, entry doc. */
export async function workspaceStatus(projectId: string): Promise<{
  exists: boolean;
  fileCount: number;
  hasManifest: boolean;
  manifestKind: string | null;
  topEntries: WorkspaceEntry[];
}> {
  const dir = workspaceDir(projectId);
  let exists = false;
  try {
    exists = (await fs.stat(dir)).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) return { exists: false, fileCount: 0, hasManifest: false, manifestKind: null, topEntries: [] };
  const entries = await listFiles(projectId);
  const manifest = ["package.json", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml", "pyproject.toml"].find((m) =>
    entries.some((e) => e.path === m)
  );
  return {
    exists: true,
    fileCount: entries.filter((e) => e.type === "file").length,
    hasManifest: Boolean(manifest),
    manifestKind: manifest ?? null,
    topEntries: entries.slice(0, 40),
  };
}
