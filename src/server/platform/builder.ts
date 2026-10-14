import { spawn } from "child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { isPathInside } from "@/lib/security";
import { db } from "@/lib/db";

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

export interface WriteResult {
  path: string;
  bytes: number;
  created: boolean;
}

export interface WriteOptions {
  maxBytes?: number;
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
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new Error(`Content exceeds the ${Math.round(maxBytes / 1024)} KB write cap`);
  }
  await ensureWorkspace(projectId);
  const abs = resolveSafe(projectId, relPath);
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
        sizeBytes: Buffer.byteLength(content, "utf8"),
      },
    });
  }
  return { path: relPath, bytes: Buffer.byteLength(content, "utf8"), created: !existed };
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

/** Tokenizer honoring single/double quotes — the shell is never involved. */
function tokenize(input: string): string[] {
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

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  blocked?: string;
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
}

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

  const cwd = await ensureWorkspace(projectId);
  const env: Record<string, string> = {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    HOME: cwd,
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    CI: "1",
  };

  return new Promise<CommandResult>((resolve) => {
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
      });
    };
    child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));
    child.on("error", (err) => {
      stderr += String(err);
      finish(127);
    });
  });
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
