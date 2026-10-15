import { spawn, type ChildProcess } from "child_process";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInside } from "@/lib/security";
import { workspaceRoot } from "@/server/platform/builder";

/**
 * Language Server Protocol (LSP) integration — deeper code intelligence for
 * workspace files.
 *
 * The platform talks JSON-RPC over stdio to standard language servers:
 *
 *   typescript-language-server  → TypeScript / JavaScript (.ts .tsx .js .jsx …)
 *   rust-analyzer               → Rust (.rs)
 *   gopls                       → Go (.go)
 *   pyright (pyright-langserver)→ Python (.py .pyi)
 *   clangd                      → C/C++ (.c .h .cpp .hpp …)
 *
 * Lifecycle and resource guarantees:
 *   - a server is spawned LAZILY on the first LSP tool call that needs it,
 *   - at most ONE server process per (workspace, language) pair — cached and
 *     shared by every later call,
 *   - an idle server is shut down after 10 minutes without use,
 *   - every server is rooted at the workspace (initialize rootUri = the
 *     workspace directory) and can only ever see files inside it: every
 *     request path is resolved through builder's workspace jail first.
 *
 * Security model: the language server binary comes from the PLATFORM PATH —
 * never from the model, never from workspace content. The model supplies
 * only workspace-relative file paths and 0-based positions; they are jailed
 * by resolveSafe (tools layer) before anything reaches a server. Server
 * responses are parsed defensively and truncated before reaching the LLM.
 *
 * Honesty: when no server is installed for a file's language the tools
 * return the exact unavailable message ("Error: no language server
 * available for .<ext> files. Install <server-name> to enable LSP
 * features.") — they never fabricate diagnostics, definitions or hovers.
 */

// --- language → server spec -------------------------------------------------

export interface LspServerSpec {
  /** The server's advertised name (tool messages, capabilities UI). */
  label: string;
  /** The actual binary spawned for JSON-RPC over stdio. */
  bin: string;
  /** Fixed spawn arguments (e.g. pyright's LSP entrypoint needs --stdio). */
  args: string[];
}

/**
 * The supported language servers, keyed by language id. `pyright` is the
 * advertised server name; the process actually spawned is
 * `pyright-langserver --stdio` (the pyright distribution's LSP entrypoint —
 * the `pyright` CLI itself is a checker, not a language server).
 */
export const LANGUAGE_SERVERS: Record<string, LspServerSpec> = {
  typescript: { label: "typescript-language-server", bin: "typescript-language-server", args: ["--stdio"] },
  rust: { label: "rust-analyzer", bin: "rust-analyzer", args: [] },
  go: { label: "gopls", bin: "gopls", args: [] },
  python: { label: "pyright", bin: "pyright-langserver", args: ["--stdio"] },
  c: { label: "clangd", bin: "clangd", args: [] },
  cpp: { label: "clangd", bin: "clangd", args: [] },
};

/** File extension → LSP language family (which server handles it). */
const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "typescript",
  mjs: "typescript",
  cjs: "typescript",
  jsx: "typescript",
  rs: "rust",
  go: "go",
  py: "python",
  pyi: "python",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
};

/** File extension → the LSP languageId sent in textDocument/didOpen. */
const EXTENSION_LANGUAGE_ID: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  rs: "rust",
  go: "go",
  py: "python",
  pyi: "python",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
};

/** The language family for a file extension (without the dot), or null. */
export function lspLanguageForExtension(ext: string): string | null {
  return EXTENSION_LANGUAGE[ext.toLowerCase().replace(/^\./, "")] ?? null;
}

/** The LSP languageId for a file extension (falls back to the family). */
export function lspLanguageIdForExtension(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, "");
  return EXTENSION_LANGUAGE_ID[e] ?? EXTENSION_LANGUAGE[e] ?? e;
}

/** The server spec for a language family, or null for unknown languages. */
export function lspServerSpec(language: string): LspServerSpec | null {
  return LANGUAGE_SERVERS[language] ?? null;
}

/** Extensions handled by a language's server (for the capabilities UI). */
export function lspExtensionsFor(language: string): string[] {
  return Object.entries(EXTENSION_LANGUAGE)
    .filter(([, lang]) => lang === language)
    .map(([ext]) => ext);
}

/**
 * The EXACT honest refusal used by every LSP tool when a file's language has
 * no usable server (unknown extension → no single server can be named, so
 * the supported set is listed instead).
 */
export function formatLspUnavailableMessage(ext: string, serverLabel: string | null): string {
  const install = serverLabel ?? "a supported language server (typescript-language-server, rust-analyzer, gopls, pyright, clangd)";
  return `Error: no language server available for .${ext || "?"} files. Install ${install} to enable LSP features.`;
}

// --- server binary detection (which/where, cached) --------------------------

const PROBE_TIMEOUT_MS = 5_000;
const binProbeCache = new Map<string, boolean>();

/** Test hook: forget every cached probe so PATH changes are honored again. */
export function clearLspDetectionCacheForTesting(): void {
  binProbeCache.clear();
}

function probeWithWhich(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    try {
      const whichBin = process.platform === "win32" ? "where" : "which";
      const child = spawn(whichBin, [bin], { stdio: "ignore", shell: false });
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
        done(false);
      }, PROBE_TIMEOUT_MS);
      child.on("error", () => {
        clearTimeout(timer);
        // `which` itself missing → fall back to a manual PATH scan so the
        // detection question still gets an honest answer.
        done(manualPathScan(bin));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done(code === 0);
      });
    } catch {
      done(manualPathScan(bin));
    }
  });
}

function manualPathScan(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      fsSync.accessSync(path.join(dir, bin), fsSync.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Whether the language server binary for `language` is installed and
 * executable right now. Returns the server's ADVERTISED name (e.g.
 * "pyright") when available, null when not (or for unknown languages).
 * Probed once per binary, then cached for the process lifetime.
 */
export async function detectServer(language: string): Promise<string | null> {
  const spec = lspServerSpec(language);
  if (!spec) return null;
  let available = binProbeCache.get(spec.bin);
  if (available === undefined) {
    available = await probeWithWhich(spec.bin);
    binProbeCache.set(spec.bin, available);
  }
  return available ? spec.label : null;
}

// --- workspace path validation ----------------------------------------------

/**
 * A language server may only ever be rooted at a directory INSIDE the
 * platform workspace root (chat workspaces and project workspaces both live
 * there). Anything else is refused before a process is spawned.
 */
export function validateLspWorkspacePath(workspacePath: string): { ok: true } | { ok: false; error: string } {
  if (typeof workspacePath !== "string" || workspacePath.trim() === "") {
    return { ok: false, error: "LSP workspace validation failed: empty workspace path" };
  }
  const resolved = path.resolve(workspacePath);
  if (resolved !== workspacePath) {
    return {
      ok: false,
      error: `LSP workspace validation failed: path must be absolute and normalized (got "${workspacePath.slice(0, 200)}")`,
    };
  }
  if (!isPathInside(resolved, workspaceRoot())) {
    return {
      ok: false,
      error: `LSP workspace validation failed: "${resolved.slice(0, 200)}" is outside the platform workspace root — language servers may only be rooted at directories under ${workspaceRoot()}`,
    };
  }
  return { ok: true };
}

// --- diagnostics (protocol shape → honest structured shape) -----------------

export interface LspDiagnostic {
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  severity: number;
  /** "error" | "warning" | "information" | "hint" — protocol number 1..4. */
  label: string;
  source?: string;
  message: string;
}

const SEVERITY_LABELS: Record<number, string> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
};

/** Defensive conversion of a raw publishDiagnostics entry. Never throws. */
export function toLspDiagnostic(raw: unknown): LspDiagnostic | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const range = (o.range ?? {}) as Record<string, unknown>;
  const start = (range.start ?? {}) as Record<string, unknown>;
  const end = (range.end ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);
  const severity = typeof o.severity === "number" && o.severity >= 1 && o.severity <= 4 ? Math.floor(o.severity) : 1;
  const message = typeof o.message === "string" ? o.message : String(o.message ?? "");
  return {
    line: num(start.line),
    character: num(start.character),
    endLine: num(end.line),
    endCharacter: num(end.character),
    severity,
    label: SEVERITY_LABELS[severity] ?? "error",
    source: typeof o.source === "string" ? o.source : undefined,
    message: message.slice(0, 400),
  };
}

// --- the client --------------------------------------------------------------

/** Per-request timeout — comfortably under the chat tool budget (60 s). */
const REQUEST_TIMEOUT_MS = 15_000;
/** Timeout for the initialize handshake. */
const INIT_TIMEOUT_MS = 15_000;
/** stdout/stderr tails kept for honest error reporting. */
const STDERR_TAIL_MAX = 2_000;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One language server process, spoken to with JSON-RPC 2.0 over stdio
 * (Content-Length framing, per the LSP base protocol).
 *
 * Concurrency: requests are pipelined — each gets a unique id and pending
 * responses are matched by id, so many requests may be in flight at once.
 * Server→client REQUESTS (configuration, progress creation, …) are answered
 * with an empty result so real servers never stall waiting on us.
 */
export class LspClient {
  readonly language: string;
  readonly workspacePath: string;
  private readonly spec: LspServerSpec;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly openedUris = new Set<string>();
  private readonly docVersions = new Map<string, number>();
  private readonly diagnostics = new Map<string, { diags: LspDiagnostic[]; at: number }>();
  private buffer: Buffer = Buffer.alloc(0);
  private stderrTail = "";
  private exited = false;
  private exitCode: number | null = null;
  private ready = false;

  constructor(spec: LspServerSpec, language: string, workspacePath: string) {
    this.spec = spec;
    this.language = language;
    this.workspacePath = workspacePath;
  }

  /** OS pid of the server process, when it is (was) running. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  isAlive(): boolean {
    return this.child !== null && !this.exited;
  }

  /** Synchronous last-resort kill used by the process-exit hook. */
  killForExit(): void {
    const child = this.child;
    if (!child || this.exited) return;
    try { child.kill("SIGKILL"); } catch { /* already dead */ }
    try { child.stdin?.destroy(); } catch { /* noop */ }
    try { child.stdout?.destroy(); } catch { /* noop */ }
    try { child.stderr?.destroy(); } catch { /* noop */ }
    this.child = null;
  }

  /** The process exit code, once the server has exited. */
  get serverExitCode(): number | null {
    return this.exitCode;
  }

  /** stderr tail — for honest error messages when a server dies. */
  get serverStderrTail(): string {
    return this.stderrTail.slice(0, STDERR_TAIL_MAX);
  }

  /** Spawn the server process and complete the LSP initialize handshake. */
  async start(): Promise<void> {
    if (this.child) throw new Error("LSP client already started");
    const mount = validateLspWorkspacePath(this.workspacePath);
    if (!mount.ok) throw new Error(mount.error);

    // Trimmed environment: the server is a platform-side analysis tool, not
    // a model-driven command — it needs PATH/HOME/TMPDIR (caches, temp files)
    // and nothing else from the platform environment.
    const env: Record<string, string> = {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME || "/tmp",
      TMPDIR: process.env.TMPDIR || "/tmp",
      LANG: process.env.LANG || "C.UTF-8",
    };

    let child: ChildProcess;
    try {
      child = spawn(this.spec.bin, this.spec.args, {
        cwd: this.workspacePath,
        env: env as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false, // never a shell — argv goes straight to execvp
      });
    } catch (err) {
      throw new Error(
        `failed to start language server "${this.spec.label}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.feed(Buffer.from(chunk, "utf8")));
    child.stderr?.on("data", (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-STDERR_TAIL_MAX);
    });
    child.on("error", (err) => this.failAllPending(new Error(`language server "${this.spec.label}" process error: ${err.message}`)));
    child.on("close", (code) => {
      this.exited = true;
      this.exitCode = code;
      this.failAllPending(
        new Error(
          `language server "${this.spec.label}" exited unexpectedly (code ${code ?? "unknown"})${this.stderrTail.trim() ? ` — stderr: ${this.stderrTail.trim().slice(-500)}` : ""}`
        )
      );
    });

    // The initialize handshake: request → response → initialized notification.
    const rootUri = `file://${this.workspacePath}`;
    try {
      await this.request(
        "initialize",
        {
          processId: process.pid,
          rootUri,
          rootPath: this.workspacePath,
          workspaceFolders: [{ uri: rootUri, name: path.basename(this.workspacePath) }],
          clientInfo: { name: "REA", version: "1.0.0" },
          initializationOptions: {},
          capabilities: {
            workspace: { configuration: false, workspaceFolders: false },
            textDocument: {
              // Full-sync: didChange always carries the whole document text.
              synchronization: { dynamicRegistration: false, didSave: false },
              hover: { contentFormat: ["markdown", "plaintext"] },
              definition: { linkSupport: true },
              references: {},
              publishDiagnostics: { relatedInformation: false },
            },
            general: {},
          },
        },
        INIT_TIMEOUT_MS
      );
    } catch (err) {
      // The server never became usable — kill it and surface the honest cause.
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      this.child = null;
      throw new Error(
        `language server "${this.spec.label}" failed to initialize: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    this.notify("initialized", {});
    this.ready = true;
  }

  /**
   * Send a JSON-RPC request and resolve with the server's `result`.
   * Rejects on timeout, transport failure, JSON-RPC error response, or a
   * server that died before answering.
   */
  request(method: string, params: unknown, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.child || this.exited) {
      return Promise.reject(
        new Error(`language server "${this.spec.label}" is not running (it was shut down or never started)`)
      );
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request "${method}" timed out after ${timeoutMs}ms (server: ${this.spec.label})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params: unknown): void {
    if (!this.child || this.exited) return; // notifications are fire-and-forget
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  /**
   * Push the CURRENT on-disk content of a document into the server: didOpen
   * the first time, a full-text didChange afterwards (the server must never
   * analyze stale text). `text` is read by the CALLER through the workspace
   * jail — this method is pure protocol.
   */
  syncDocument(uri: string, languageId: string, text: string): void {
    if (this.openedUris.has(uri)) {
      const version = (this.docVersions.get(uri) ?? 1) + 1;
      this.docVersions.set(uri, version);
      this.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
    } else {
      this.openedUris.add(uri);
      this.docVersions.set(uri, 1);
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
    }
  }

  /**
   * Resolve with the diagnostics published for `uri` AFTER `sinceMs` —
   * either the first publishDiagnostics notification that arrives while
   * waiting, or (on timeout) null with whatever the server had sent before.
   * Returns { diagnostics, stale } — stale=true means the wait timed out and
   * the returned diagnostics (possibly empty) may not reflect the latest
   * content, so callers must say so honestly.
   */
  waitForDiagnostics(
    uri: string,
    sinceMs: number,
    timeoutMs: number
  ): Promise<{ diagnostics: LspDiagnostic[]; stale: boolean }> {
    const existing = this.diagnostics.get(uri);
    if (existing && existing.at >= sinceMs) {
      return Promise.resolve({ diagnostics: existing.diags, stale: false });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        const stored = this.diagnostics.get(uri);
        resolve({ diagnostics: stored?.diags ?? [], stale: true });
      }, timeoutMs);
      const onDiags = (diagUri: string, entry: { diags: LspDiagnostic[]; at: number }) => {
        if (diagUri !== uri || entry.at < sinceMs) return;
        cleanup();
        resolve({ diagnostics: entry.diags, stale: false });
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.diagnosticWaiters = this.diagnosticWaiters.filter((w) => w !== onDiags);
      };
      this.diagnosticWaiters.push(onDiags);
    });
  }

  private diagnosticWaiters: Array<(uri: string, entry: { diags: LspDiagnostic[]; at: number }) => void> = [];

  /**
   * Graceful shutdown: shutdown request → exit notification → SIGTERM →
   * SIGKILL. Idempotent; resolves once the process is (being) reaped.
   */
  async shutdown(): Promise<void> {
    this.ready = false;
    const child = this.child;
    if (!child || this.exited) {
      this.child = null;
      return;
    }
    // Ask nicely (best effort — a wedged server must not stall shutdown).
    try {
      await this.request("shutdown", null, 3_000);
    } catch {
      /* timeout/refusal — proceed to kill */
    }
    this.notify("exit", null);
    await new Promise<void>((resolve) => {
      if (this.exited) {
        resolve();
        return;
      }
      const killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }, 1_500);
      const onClose = () => {
        clearTimeout(killTimer);
        resolve();
      };
      if (child.exitCode !== null || this.exited) onClose();
      else child.once("close", onClose);
    });
    try { child.kill("SIGTERM"); } catch { /* already dead */ }
    try { child.stdin?.destroy(); } catch { /* noop */ }
    try { child.stdout?.destroy(); } catch { /* noop */ }
    try { child.stderr?.destroy(); } catch { /* noop */ }
    this.child = null;
  }

  // --- transport internals ---------------------------------------------------

  private write(msg: Record<string, unknown>): void {
    const body = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    try {
      this.child?.stdin?.write(header + body);
    } catch {
      /* EPIPE — the close handler fails pending requests honestly */
    }
  }

  /** Accumulate bytes and dispatch every complete JSON-RPC message. */
  private feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const sep = this.buffer.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const header = this.buffer.subarray(0, sep).toString("latin1");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Malformed framing — drop this header block rather than wedging.
        this.buffer = this.buffer.subarray(sep + 4);
        continue;
      }
      const length = parseInt(match[1], 10);
      const bodyStart = sep + 4;
      if (this.buffer.length < bodyStart + length) return; // wait for the rest
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(body) as Record<string, unknown>;
      } catch {
        continue; // unparseable body — skip it, keep the transport alive
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = typeof msg.id === "number" ? msg.id : typeof msg.id === "string" ? Number(msg.id) : undefined;
    const hasMethod = typeof msg.method === "string";

    if (id !== undefined && !hasMethod) {
      // A response to one of OUR requests.
      const entry = this.pending.get(id);
      if (!entry) return; // unknown id (e.g. after a timeout) — ignore
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (msg.error !== undefined && msg.error !== null) {
        const err = msg.error as Record<string, unknown>;
        entry.reject(new Error(`LSP ${typeof msg.method === "string" ? msg.method : "request"} error ${err.code ?? ""}: ${String(err.message ?? "unknown error").slice(0, 300)}`));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (id !== undefined && hasMethod) {
      // A server→client REQUEST. Real servers send these (progress creation,
      // configuration) — answer with an empty result so they never stall.
      this.write({ jsonrpc: "2.0", id, result: null });
      return;
    }

    if (hasMethod && msg.method === "textDocument/publishDiagnostics") {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const uri = typeof params.uri === "string" ? params.uri : null;
      if (!uri) return;
      const raw = Array.isArray(params.diagnostics) ? params.diagnostics : [];
      const diags = raw
        .map(toLspDiagnostic)
        .filter((d): d is LspDiagnostic => d !== null)
        .slice(0, 200);
      const entry = { diags, at: Date.now() };
      this.diagnostics.set(uri, entry);
      for (const waiter of [...this.diagnosticWaiters]) waiter(uri, entry);
      return;
    }

    // Other notifications (window/logMessage, progress, …) — ignored.
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}

// --- lifecycle management (lazy start, per-workspace cache, idle shutdown) --

export const LSP_IDLE_SHUTDOWN_MS = 10 * 60_000;

let idleTimeoutMs = LSP_IDLE_SHUTDOWN_MS;

/** Test hook: shorten/lengthen the idle shutdown window (null = default).
 * Re-arms already-scheduled timers so the new window applies immediately. */
export function setLspIdleTimeoutForTesting(ms: number | null): void {
  idleTimeoutMs = ms ?? LSP_IDLE_SHUTDOWN_MS;
  for (const key of [...idleTimers.keys()]) armIdleTimer(key);
}

const serverCache = new Map<string, Promise<LspClient>>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

function serverCacheKey(workspacePath: string, language: string): string {
  return `${workspacePath}\u0000${language}`;
}

/** Test hook: how many servers are currently cached (per workspace+language). */
export function lspServerCacheSizeForTesting(): number {
  return serverCache.size;
}

/**
 * The lazily-started, cached client for (workspacePath, language). Max ONE
 * server per language per workspace — concurrent first calls share a single
 * spawn. Dead servers are evicted and respawned on the next call. Every
 * acquisition re-arms the 10-minute idle shutdown timer.
 */
export async function acquireServer(workspacePath: string, language: string): Promise<LspClient> {
  installExitHook();
  const key = serverCacheKey(workspacePath, language);
  const existing = serverCache.get(key);
  if (existing) {
    let client: LspClient;
    try {
      client = await existing;
    } catch (err) {
      serverCache.delete(key);
      throw err;
    }
    if (client.isAlive()) {
      armIdleTimer(key);
      return client;
    }
    serverCache.delete(key); // died since its last use — respawn fresh below
  }
  const creating = start(workspacePath, language);
  serverCache.set(key, creating);
  try {
    const client = await creating;
    armIdleTimer(key);
    return client;
  } catch (err) {
    serverCache.delete(key);
    throw err;
  }
}

function armIdleTimer(key: string): void {
  const prev = idleTimers.get(key);
  if (prev) clearTimeout(prev);
  const timer = setTimeout(() => {
    idleTimers.delete(key);
    const pending = serverCache.get(key);
    if (!pending) return;
    serverCache.delete(key);
    void pending
      .then((client) => client.shutdown())
      .catch(() => {
        /* a dying idle server must never crash the platform */
      });
  }, idleTimeoutMs);
  idleTimers.set(key, timer);
  // An idle timer must never keep the platform process alive on its own.
  timer.unref?.();
}

/**
 * Start a NEW language server rooted at `workspacePath` for `language`.
 * Throws (honestly) when the language has no configured server or the
 * workspace path is outside the platform workspace root.
 */
export async function start(workspacePath: string, language: string): Promise<LspClient> {
  const spec = lspServerSpec(language);
  if (!spec) throw new Error(`no language server is configured for "${language}"`);
  const client = new LspClient(spec, language, workspacePath);
  await client.start();
  return client;
}

/** Shut down every cached server (platform hygiene + tests). */
export async function shutdownAllServers(): Promise<void> {
  for (const [key, timer] of idleTimers) {
    clearTimeout(timer);
    idleTimers.delete(key);
  }
  const pending = [...serverCache.values()];
  serverCache.clear();
  await Promise.allSettled(pending.map((p) => p.then((c) => c.shutdown())));
}

// Best-effort orphan prevention: when the platform process exits, language
// servers spawned by it must not linger. `exit` handlers are synchronous —
// SIGKILL is.
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const pending of serverCache.values()) {
      void pending
        .then((c) => c.killForExit())
        .catch(() => { /* noop */ });
    }
  });
}

// --- capabilities report ------------------------------------------------------

export interface LspLanguageCapability {
  language: string;
  server: string;
  available: boolean;
  extensions: string[];
}

/** Per-language LSP availability for the capabilities endpoint/UI. */
export async function lspCapabilityReport(): Promise<LspLanguageCapability[]> {
  const languages = Object.keys(LANGUAGE_SERVERS);
  return Promise.all(
    languages.map(async (language) => {
      const spec = LANGUAGE_SERVERS[language] as LspServerSpec;
      const server = await detectServer(language);
      return {
        language,
        server: spec.label,
        available: server !== null,
        extensions: lspExtensionsFor(language),
      };
    })
  );
}

// Re-export for tool-layer convenience (file:// ↔ path conversion).
export { fileURLToPath };
