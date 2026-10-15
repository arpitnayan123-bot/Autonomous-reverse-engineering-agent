import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import path from "path";
import { ANALYSIS_TIMEOUT_MS, MAX_OUTPUT_BYTES } from "@/lib/security";

/**
 * AREA Engine Bridge.
 *
 * Drives the REAL AREA engine (`rea-agents` npm package) through its native
 * MCP (Model Context Protocol) stdio server using JSON-RPC 2.0.
 *
 * - `listReaTools()`  → live tool catalog (170 tools in v6.4.0)
 * - `callReaTool()`   → execute a tool with timeout, output caps, restart-on-death
 * - `withReaTarget()` → serialized open_binary/close_binary sessions
 * - `areaCli()`        → one-shot CLI commands (--json envelope)
 *
 * Fail-closed: every failure surfaces as a structured error; the MCP process
 * is restarted transparently after crashes/timeouts.
 */

const AREA_SCRIPT = path.join(
  process.cwd(),
  "node_modules",
  "rea-agents",
  "scripts",
  "rea.mjs"
);

const INIT_TIMEOUT_MS = 20_000;

/**
 * Cap for `structuredContent` returned by engine tools/call. Text content has
 * MAX_OUTPUT_BYTES, but structuredContent crossed the bridge UNCAPPED — a
 * hostile/broken engine tool could stream megabytes of JSON into the agent
 * context and the persisted trace. Serialized, byte-capped, honestly marked.
 */
export const STRUCTURED_CONTENT_MAX_BYTES = 512 * 1024;

/** Serialize + cap structured tool output. Exported for regression coverage. */
export function capStructured(content: unknown, maxBytes = STRUCTURED_CONTENT_MAX_BYTES): unknown {
  if (content == null) return content;
  let serialized: string;
  try {
    serialized = JSON.stringify(content);
  } catch {
    return {
      __platform: "structured-content-unserializable",
      note: "The engine returned structured content that could not be serialized; it was dropped, not passed through.",
    };
  }
  if (serialized == null || serialized.length <= maxBytes) return content;
  return {
    __platform: "structured-content-truncated",
    originalBytes: serialized.length,
    maxBytes,
    preview: serialized.slice(0, maxBytes),
    note: "Structured content exceeded the platform output budget and was truncated — the JSON preview above is NOT the complete payload.",
  };
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: JsonRpcResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

class AreaMcpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private starting: Promise<void> | null = null;
  private toolCatalog: McpToolDef[] | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  /**
   * >0 while a withTarget session body is executing. Calls made from inside
   * the session (the session already holds the lock) must NOT re-queue on the
   * lock — doing so deadlocks: withTarget awaits fn() → fn awaits callTool →
   * callTool awaits the lock held by withTarget. Re-entrant calls run
   * directly; external calls keep queueing normally.
   */
  private sessionDepth = 0;
  private stderrTail: string[] = [];

  private spawnProc(): ChildProcessWithoutNullStreams {
    // Minimal, scrubbed environment: no ambient secrets, no ambient AREA config.
    const env: Record<string, string> = {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME || "/tmp",
      TMPDIR: process.env.TMPDIR || "/tmp",
      LANG: "C.UTF-8",
      NODE_ENV: "production",
    };
    const proc = spawn(process.execPath, [AREA_SCRIPT, "--mcp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: env as NodeJS.ProcessEnv,
      cwd: "/tmp",
    }) as ChildProcessWithoutNullStreams;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    proc.on("exit", () => this.onDeath());
    proc.on("error", () => this.onDeath());
    return proc;
  }

  private onDeath() {
    this.proc = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("AREA engine process terminated unexpectedly"));
    }
    this.pending.clear();
    this.toolCatalog = null;
  }

  private onStdout(chunk: string) {
    this.buffer += chunk;
    // Bound the buffer: a hostile/noisy engine line without a newline must
    // not grow memory unbounded. Cap at ~4 MB, keep the tail.
    if (this.buffer.length > 4 * 1024 * 1024) {
      this.buffer = this.buffer.slice(-2 * 1024 * 1024);
    }
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // tolerate non-JSON noise (e.g. startup banners)
      }
      if (typeof msg.id === "number" || typeof msg.id === "string") {
        const pending = this.pending.get(Number(msg.id));
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(Number(msg.id));
          pending.resolve(msg);
        }
      }
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.proc) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const proc = this.spawnProc();
      this.proc = proc;
      try {
        const res = await this.request(
          "initialize",
          {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "area-platform", version: "1.0.0" },
          },
          INIT_TIMEOUT_MS
        );
        if (res.error) {
          throw new Error(`AREA engine init failed: ${res.error.message}`);
        }
        proc.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
            "\n"
        );
      } catch (err) {
        this.killProc();
        this.starting = null;
        throw err;
      }
      this.starting = null;
    })();
    return this.starting;
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const proc = this.proc;
    if (!proc) return Promise.reject(new Error("AREA engine not running"));
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A hung request poisons the pipe state; restart for a clean slate.
        this.killProc();
        reject(
          new Error(`AREA engine timeout after ${timeoutMs}ms on ${method}`)
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        proc.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
        );
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async listTools(force = false): Promise<McpToolDef[]> {
    if (this.toolCatalog && !force) return this.toolCatalog;
    await this.ensureStarted();
    const res = await this.request("tools/list", {}, 30_000);
    if (res.error) throw new Error(`tools/list failed: ${res.error.message}`);
    const result = res.result as { tools?: McpToolDef[] } | undefined;
    this.toolCatalog = result?.tools ?? [];
    return this.toolCatalog;
  }

  /**
   * Execute one AREA MCP tool. Serialized globally (the engine holds a single
   * binary session). Returns {structured?, text, isError}.
   *
   * Re-entrancy: when called from inside a withTarget session (which already
   * holds the lock), the request runs directly instead of queueing on the
   * lock — re-queueing would deadlock the session body.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs = ANALYSIS_TIMEOUT_MS
  ): Promise<{ structured: unknown; text: string; isError: boolean }> {
    if (this.sessionDepth > 0) {
      return this.runToolRequest(name, args, timeoutMs);
    }
    // Global serialization: run each call chained on the previous one.
    const chained = this.lock.then(
      () => this.runToolRequest(name, args, timeoutMs),
      () => this.runToolRequest(name, args, timeoutMs)
    );
    this.lock = chained.catch(() => undefined);
    return chained;
  }

  /** Single tools/call request — assumes the caller already holds the lock. */
  private async runToolRequest(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number
  ): Promise<{ structured: unknown; text: string; isError: boolean }> {
    await this.ensureStarted();
    const res = await this.request(
      "tools/call",
      { name, arguments: args },
      timeoutMs
    );
    if (res.error) {
      return {
        structured: null,
        text: `AREA engine error: ${res.error.message}`,
        isError: true,
      };
    }
    const result = (res.result ?? {}) as {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
      isError?: boolean;
    };
    let text = "";
    for (const c of result.content ?? []) {
      if (c.type === "text" && c.text) text += (text ? "\n" : "") + c.text;
    }
    if (text.length > MAX_OUTPUT_BYTES) {
      text =
        text.slice(0, MAX_OUTPUT_BYTES) +
        "\n…[truncated by platform output budget]";
    }
    return {
      structured: capStructured(result.structuredContent ?? null),
      text,
      isError: Boolean(result.isError),
    };
  }

  /**
   * Serialized open → run tools → close around a single analysis target.
   * The session body runs while the global lock is held; tools invoked from
   * inside fn() (the common chat-agent pattern) execute re-entrantly.
   */
  async withTarget<T>(
    targetPath: string,
    fn: () => Promise<T>,
    openTimeoutMs = 60_000
  ): Promise<T> {
    const run = async (): Promise<T> => {
      await this.ensureStarted();
      this.sessionDepth++;
      try {
        const open = await this.runToolRequest(
          "open_binary",
          { path: targetPath },
          openTimeoutMs
        );
        if (open.isError) {
          throw new Error(
            `AREA could not open target: ${open.text.slice(0, 500)}`
          );
        }
        try {
          return await fn();
        } finally {
          await this.runToolRequest("close_binary", {}, 15_000).catch(
            () => undefined
          );
        }
      } finally {
        this.sessionDepth--;
      }
    };
    const chained = this.lock.then(run, run);
    this.lock = chained.catch(() => undefined);
    return chained;
  }

  /** Terminate the engine child process (used on init failure + shutdown). */
  killProc() {
    if (this.proc) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      this.proc = null;
    }
  }

  getDiagnostics(): { running: boolean; stderr: string } {
    return {
      running: this.proc !== null,
      stderr: this.stderrTail.join("").slice(-2000),
    };
  }
}

// Module-level singleton (survives Next.js HMR via globalThis).
const globalForRea = globalThis as unknown as {
  areaClient?: AreaMcpClient;
  __reaShutdownHook?: boolean;
};
export const area: AreaMcpClient =
  globalForRea.areaClient ?? (globalForRea.areaClient = new AreaMcpClient());

// Kill the MCP child on server shutdown so it never outlives the platform.
if (!globalForRea.__reaShutdownHook) {
  globalForRea.__reaShutdownHook = true;
  const shutdown = () => {
    try {
      area.killProc();
    } catch {
      /* best effort */
    }
  };
  process.once("exit", shutdown);
  process.once("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// One-shot CLI helper (for capabilities/doctor and simple commands).
// ---------------------------------------------------------------------------

export interface AreaCliResult {
  ok: boolean;
  json: unknown;
  raw: string;
  code?: string;
}

export function areaCli(
  args: string[],
  timeoutMs = 60_000
): Promise<AreaCliResult> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME || "/tmp",
      TMPDIR: process.env.TMPDIR || "/tmp",
      LANG: "C.UTF-8",
    };
    const child = spawn(process.execPath, [AREA_SCRIPT, ...args], {
      env: env as NodeJS.ProcessEnv,
      cwd: "/tmp",
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as ChildProcessWithoutNullStreams;
    let out = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      if (out.length < MAX_OUTPUT_BYTES) out += d;
    });
    child.on("close", () => {
      clearTimeout(timer);
      const raw = out.slice(0, MAX_OUTPUT_BYTES);
      let json: unknown = null;
      try {
        json = JSON.parse(raw);
      } catch {
        /* non-JSON output */
      }
      const code =
        json &&
        typeof json === "object" &&
        "code" in (json as Record<string, unknown>)
          ? String((json as Record<string, unknown>).code)
          : undefined;
      resolve({ ok: !killed && Boolean(json), json, raw, code });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, json: null, raw: "" });
    });
  });
}

/** Engine identity + health, used by /api/capabilities. */
export async function areaEngineInfo(): Promise<{
  version: string;
  toolCount: number;
  healthy: boolean;
  detail: string;
}> {
  try {
    const tools = await area.listTools();
    return {
      version: "6.4.0",
      toolCount: tools.length,
      healthy: true,
      detail: "AREA MCP engine reachable",
    };
  } catch (err) {
    return {
      version: "6.4.0",
      toolCount: 0,
      healthy: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
