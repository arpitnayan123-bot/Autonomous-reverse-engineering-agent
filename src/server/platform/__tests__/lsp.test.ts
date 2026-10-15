#!/usr/bin/env bun
/**
 * LSP integration regression suite (lsp.ts + the lsp_* tools).
 *
 * Proves the whole stack end-to-end against a MOCK language server — a real
 * Node executable on PATH that speaks JSON-RPC 2.0 over stdio with
 * Content-Length framing (initialize → initialized → didOpen →
 * publishDiagnostics → definition/references/hover → shutdown → exit):
 *   - detection: the which-probe finds the mock on PATH, misses for languages
 *     whose server is not installed, and returns null for unknown languages;
 *   - lifecycle: start() spawns + initializes a REAL child process; shutdown()
 *     reaps it; post-shutdown requests are refused honestly;
 *   - diagnostics: the opened document's publishDiagnostics arrives with the
 *     exact positions/severities, client-side AND through the tool layer;
 *   - definition/references/hover: requests pipelined over one server,
 *     including several CONCURRENT requests interleaving on the same client;
 *   - honest refusals: the EXACT unavailable-server message for an installed-
 *     nowhere server (.py → pyright) and for unknown extensions;
 *   - lifecycle management: one cached server per (workspace, language),
 *     idle shutdown evicts it, and workspace paths outside the platform root
 *     are refused before any process is spawned.
 *
 * Run: bun test src/server/platform/__tests__/lsp.test.ts
 */
import { describe, test, expect, afterEach, afterAll } from "bun:test";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureWorkspace,
  setGitAvailabilityForTesting,
  workspaceDir,
} from "@/server/platform/builder";
import { runWorkspaceTool, AGENT_TOOLS, FREE_CHAT_TOOL_NAMES, nativeToolSchemas } from "@/server/agent/tools";
import {
  acquireServer,
  clearLspDetectionCacheForTesting,
  detectServer,
  formatLspUnavailableMessage,
  LANGUAGE_SERVERS,
  LSP_IDLE_SHUTDOWN_MS,
  lspCapabilityReport,
  lspLanguageForExtension,
  lspServerCacheSizeForTesting,
  setLspIdleTimeoutForTesting,
  shutdownAllServers,
  start,
} from "@/server/platform/lsp";

// ---------------------------------------------------------------------------
// Harness: a mock language server (real Node process, real JSON-RPC stdio)
// ---------------------------------------------------------------------------

const sid = `lsp-${crypto.randomUUID().slice(0, 8)}`;
const key = `chat-${sid}`;

const MOCK_DIR = fsSync.mkdtempSync(path.join(os.tmpdir(), "mock-lsp-bin-"));
const MOCK_BIN = path.join(MOCK_DIR, "typescript-language-server");

/** A language-server stand-in: full JSON-RPC 2.0 over stdio with
 * Content-Length framing. Exits when stdin closes or on `exit`. */
const MOCK_SCRIPT = [
  "#!/usr/bin/env node",
  'let buf = Buffer.alloc(0);',
  "process.stdin.on('data', (chunk) => {",
  "  buf = Buffer.concat([buf, chunk]);",
  "  for (;;) {",
  '    const sep = buf.indexOf("\\r\\n\\r\\n");',
  "    if (sep < 0) return;",
  '    const header = buf.subarray(0, sep).toString("latin1");',
  '    const m = /content-length:\\s*(\\d+)/i.exec(header);',
  "    if (!m) { buf = buf.subarray(sep + 4); continue; }",
  "    const len = parseInt(m[1], 10);",
  "    const bodyStart = sep + 4;",
  "    if (buf.length < bodyStart + len) return;",
  '    const body = buf.subarray(bodyStart, bodyStart + len).toString("utf8");',
  "    buf = buf.subarray(bodyStart + len);",
  "    let msg;",
  "    try { msg = JSON.parse(body); } catch { continue; }",
  "    handle(msg);",
  "  }",
  "});",
  "process.stdin.on('end', () => process.exit(0));",
  "function send(msg) {",
  '  const body = Buffer.from(JSON.stringify(msg), "utf8");',
  '  process.stdout.write("Content-Length: " + body.length + "\\r\\n\\r\\n");',
  "  process.stdout.write(body);",
  "}",
  "function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }",
  "function handle(msg) {",
  "  const method = msg.method;",
  "  if (msg.id !== undefined && !method) return; // a response, not for us",
  "  if (method === 'initialize') {",
  "    reply(msg.id, { capabilities: { textDocumentSync: 1, hoverProvider: true, definitionProvider: true, referencesProvider: true } });",
  "    return;",
  "  }",
  "  if (method === 'shutdown') { reply(msg.id, null); return; }",
  "  const params = msg.params || {};",
  "  if (method === 'textDocument/didOpen' || method === 'textDocument/didChange') {",
  "    const uri = params.textDocument && params.textDocument.uri;",
  "    if (!uri) return;",
  "    setTimeout(() => {",
  "      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [",
  "        { range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } }, severity: 1, source: 'mock-ls', message: 'mock error: something is wrong' },",
  "        { range: { start: { line: 5, character: 0 }, end: { line: 5, character: 3 } }, severity: 2, source: 'mock-ls', message: 'mock warning: consider this' }",
  "      ] } });",
  "    }, 20);",
  "    return;",
  "  }",
  "  if (method === 'textDocument/definition') {",
  "    reply(msg.id, { uri: params.textDocument.uri, range: { start: { line: 4, character: 6 }, end: { line: 4, character: 16 } } });",
  "    return;",
  "  }",
  "  if (method === 'textDocument/references') {",
  "    const uri = params.textDocument.uri;",
  "    reply(msg.id, [",
  "      { uri, range: { start: { line: 4, character: 6 }, end: { line: 4, character: 16 } } },",
  "      { uri, range: { start: { line: 9, character: 2 }, end: { line: 9, character: 12 } } }",
  "    ]);",
  "    return;",
  "  }",
  "  if (method === 'textDocument/hover') {",
  "    reply(msg.id, { contents: { kind: 'markdown', value: 'function mockSymbol(): void' }, range: { start: { line: 4, character: 6 }, end: { line: 4, character: 16 } } });",
  "    return;",
  "  }",
  "  if (method === 'exit') { process.exit(0); }",
  "  // Unknown server->client REQUEST: answer empty so the client never stalls.",
  "  if (msg.id !== undefined) { reply(msg.id, null); }",
  "}",
  "",
].join("\n");

const SAVED_PATH = process.env.PATH;

function useMockServer(): void {
  fsSync.writeFileSync(MOCK_BIN, MOCK_SCRIPT, { mode: 0o755 });
  process.env.PATH = `${MOCK_DIR}:${SAVED_PATH}`;
  clearLspDetectionCacheForTesting();
}

function useNoServers(): void {
  process.env.PATH = SAVED_PATH;
  clearLspDetectionCacheForTesting();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const SAMPLE_TS = [
  "const greeting: string = 'hello';",
  "function mockSymbol(n: number): number {",
  "  return n * 2;",
  "}",
  "const doubled = mockSymbol(21);",
  "",
].join("\n");

async function cleanWorkspace(): Promise<void> {
  await fs.rm(workspaceDir(key), { recursive: true, force: true });
}

afterEach(() => {
  useNoServers();
  setLspIdleTimeoutForTesting(null);
});

afterAll(async () => {
  setLspIdleTimeoutForTesting(null);
  clearLspDetectionCacheForTesting();
  setGitAvailabilityForTesting(null);
  await shutdownAllServers();
  await cleanWorkspace();
  await fs.rm(MOCK_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lsp integration", () => {
  test("registry wiring: four any-scoped tools advertised everywhere, routed in free chats", () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    for (const n of ["lsp_diagnostics", "lsp_definition", "lsp_references", "lsp_hover"]) {
      expect(names).toContain(n);
      const tool = AGENT_TOOLS.find((t) => t.name === n);
      expect(tool?.scope).toBe("any");
    }
    // Free-chat advertisement and native tool-calling schemas both DERIVE
    // from the registry — the tools cannot be advertised but unroutable.
    expect(FREE_CHAT_TOOL_NAMES).toContain("lsp_diagnostics");
    expect(FREE_CHAT_TOOL_NAMES).toContain("lsp_hover");
    const nativeNames = nativeToolSchemas("free").map((s) => s.function.name);
    expect(nativeNames).toContain("lsp_references");
    // Extension mapping sanity: the language each tool will resolve for a
    // sample path matches the server table.
    expect(lspLanguageForExtension("ts")).toBe("typescript");
    expect(lspLanguageForExtension("py")).toBe("python");
    expect(lspServerCacheSizeForTesting()).toBe(0);
  });

  test("detection: which-probe finds the mock, misses uninstalled servers, null for unknown languages", async () => {
    useMockServer();
    expect(await detectServer("typescript")).toBe("typescript-language-server");
    // Cached per binary: a second call agrees instantly.
    expect(await detectServer("typescript")).toBe("typescript-language-server");

    const report = await lspCapabilityReport();
    expect(report.length).toBe(Object.keys(LANGUAGE_SERVERS).length);
    const ts = report.find((r) => r.language === "typescript");
    expect(ts?.available).toBe(true);
    expect(ts?.server).toBe("typescript-language-server");
    expect(ts?.extensions).toContain("ts");
    // pyright-langserver is NOT installed on this machine (nor in the mock
    // dir) — reported honestly with the name to install.
    const py = report.find((r) => r.language === "python");
    expect(py?.available).toBe(false);
    expect(py?.server).toBe("pyright");

    useNoServers();
    expect(await detectServer("python")).toBe(null);
    expect(await detectServer("rust")).toBe(null);
    // Unknown language: no server is even configured.
    expect(await detectServer("brainfuck")).toBe(null);
    expect(await detectServer("")).toBe(null);
  });

  test("workspace validation: servers may only be rooted inside the platform workspace root", async () => {
    useMockServer();
    await ensureWorkspace(key);
    const wsDir = workspaceDir(key);

    await expect(start("/tmp", "typescript")).rejects.toThrow(/outside the platform workspace root/);
    await expect(start("relative/path", "typescript")).rejects.toThrow(/absolute and normalized/);
    await expect(start(wsDir + "/../elsewhere", "typescript")).rejects.toThrow(/normalized/);
    // Unknown language refused before any process is spawned.
    await expect(start(wsDir, "brainfuck")).rejects.toThrow(/no language server is configured/);
    // The real workspace root is fine — this spawns the mock (cleaned up below).
    const client = await start(wsDir, "typescript");
    expect(client.pid).toBeDefined();
    await client.shutdown();
  });

  test("start/shutdown lifecycle: real child process, graceful reaping, honest post-shutdown refusals", async () => {
    useMockServer();
    await ensureWorkspace(key);
    const wsDir = workspaceDir(key);

    const client = await start(wsDir, "typescript");
    expect(client.isAlive()).toBe(true);
    expect(client.pid).toBeDefined();
    expect(client.pid).toBeGreaterThan(0);

    // A real request/response round-trip against the live process.
    const caps = (await client.request("initialize", {})) as Record<string, unknown>;
    expect((caps.capabilities as Record<string, unknown>).hoverProvider).toBe(true);

    const pid = client.pid;
    await client.shutdown();
    expect(client.isAlive()).toBe(false);
    // The OS process is really gone.
    const ps = await new Promise((resolve) => {
      const check = Bun.spawnSync(["sh", "-c", `kill -0 ${pid} 2>/dev/null; echo $?`]);
      resolve(check.stdout.toString().trim());
    });
    expect(ps).not.toBe("0");
    // Requests after shutdown are refused honestly — never a hang, never a
    // fabricated answer.
    await expect(client.request("textDocument/definition", {})).rejects.toThrow(/not running/);
    // Idempotent: a second shutdown resolves without throwing.
    await client.shutdown();
  });

  test("diagnostics: publishDiagnostics for the opened document (client-level and tool-level)", async () => {
    useMockServer();
    await ensureWorkspace(key);
    const wsDir = workspaceDir(key);
    const abs = path.join(wsDir, "diagnostics.ts");
    await fs.writeFile(abs, SAMPLE_TS, "utf8");

    // Client-level: syncDocument (didOpen) → the mock publishes → the waiter
    // resolves with the exact positions/severities.
    const client = await start(wsDir, "typescript");
    const uri = pathToFileURL(abs).href;
    const since = Date.now();
    client.syncDocument(uri, "typescript", SAMPLE_TS);
    const { diagnostics, stale } = await client.waitForDiagnostics(uri, since, 5_000);
    expect(stale).toBe(false);
    expect(diagnostics.length).toBe(2);
    expect(diagnostics[0].line).toBe(2);
    expect(diagnostics[0].character).toBe(4);
    expect(diagnostics[0].label).toBe("error");
    expect(diagnostics[0].message).toBe("mock error: something is wrong");
    expect(diagnostics[0].source).toBe("mock-ls");
    expect(diagnostics[1].label).toBe("warning");
    await client.shutdown();

    // Tool-level: the full path — extension → language → server → jail-read →
    // didOpen → wait → honest formatting.
    const r = await runWorkspaceTool("lsp_diagnostics", { path: "diagnostics.ts" }, { sessionId: sid });
    expect(r).toContain("# lsp_diagnostics — 2 diagnostics for diagnostics.ts");
    expect(r).toContain("(server: typescript-language-server, language: typescript)");
    expect(r).toContain("error (line 2, col 4 — 0-based): mock error: something is wrong [mock-ls]");
    expect(r).toContain("warning (line 5, col 0 — 0-based): mock warning: consider this [mock-ls]");

    // A file that does not exist → honest error, nothing invented.
    const missing = await runWorkspaceTool("lsp_diagnostics", { path: "src/nope.ts" }, { sessionId: sid });
    expect(missing.startsWith("Error:")).toBe(true);
    expect(missing).toContain("cannot read");
  });

  test("definition and hover through the tool layer: locations rendered workspace-relative, 0-based", async () => {
    useMockServer();
    await ensureWorkspace(key);
    const wsDir = workspaceDir(key);
    await fs.writeFile(path.join(wsDir, "symbols.ts"), SAMPLE_TS, "utf8");

    const def = await runWorkspaceTool(
      "lsp_definition",
      { path: "symbols.ts", line: 1, character: 9 },
      { sessionId: sid }
    );
    expect(def).toContain("# lsp_definition — 1 location(s) for symbols.ts:1:9 (0-based)");
    expect(def).toContain("- symbols.ts:4:6 (0-based)");

    const hover = await runWorkspaceTool(
      "lsp_hover",
      { path: "symbols.ts", line: 1, character: 9 },
      { sessionId: sid }
    );
    expect(hover).toContain("# lsp_hover — symbols.ts:1:9 (0-based)");
    expect(hover).toContain("function mockSymbol(): void");
    expect(hover).toContain("symbol range: line 4, character 6 → line 4, character 16 (0-based)");

    // Position validation: negative / non-integer / missing are refused.
    const badPos = await runWorkspaceTool(
      "lsp_definition",
      { path: "symbols.ts", line: -1, character: 0 },
      { sessionId: sid }
    );
    expect(badPos.startsWith("Error:")).toBe(true);
    expect(badPos).toContain("0-based");
    const noPos = await runWorkspaceTool("lsp_definition", { path: "symbols.ts" }, { sessionId: sid });
    expect(noPos.startsWith("Error:")).toBe(true);
    expect(noPos).toContain("'line' and 'character' must be non-negative integers");
  });

  test("unavailable server: the EXACT honest refusal, verbatim, for missing and unknown languages", async () => {
    useNoServers(); // pyright-langserver is genuinely not installed here
    const py = await runWorkspaceTool("lsp_diagnostics", { path: "app.py" }, { sessionId: sid });
    expect(py).toBe("Error: no language server available for .py files. Install pyright to enable LSP features.");

    const rs = await runWorkspaceTool("lsp_definition", { path: "main.rs", line: 0, character: 0 }, { sessionId: sid });
    expect(rs).toBe("Error: no language server available for .rs files. Install rust-analyzer to enable LSP features.");

    // Unknown extension: no single server can be named — the supported set is.
    const unknown = await runWorkspaceTool("lsp_hover", { path: "notes.xyz", line: 0, character: 0 }, { sessionId: sid });
    expect(unknown).toBe(
      "Error: no language server available for .xyz files. Install a supported language server (typescript-language-server, rust-analyzer, gopls, pyright, clangd) to enable LSP features."
    );

    // The formatter is the single source of both messages.
    expect(formatLspUnavailableMessage("py", "pyright")).toBe(py);
    expect(formatLspUnavailableMessage("xyz", null)).toBe(unknown);
  });

  test("no workspace context: refused honestly, like every other workspace tool", async () => {
    const r = await runWorkspaceTool("lsp_diagnostics", { path: "src/main.ts" }, { sessionId: "" });
    expect(r).toBe(
      "Error: workspace tools require a chat session context — they are unavailable outside chat conversations."
    );
  });

  test("multiple concurrent requests pipeline over ONE server with interleaved ids", async () => {
    useMockServer();
    await ensureWorkspace(key);
    const wsDir = workspaceDir(key);
    const client = await acquireServer(wsDir, "typescript");
    const uri = pathToFileURL(path.join(wsDir, "symbols.ts")).href;
    const doc = { textDocument: { uri }, position: { line: 1, character: 9 } };

    // Three requests IN FLIGHT simultaneously — unique ids, responses matched
    // by id, every caller gets ITS answer.
    const [definition, references, hover] = await Promise.all([
      client.request("textDocument/definition", doc),
      client.request("textDocument/references", { ...doc, context: { includeDeclaration: true } }),
      client.request("textDocument/hover", doc),
    ]) as [Record<string, unknown>, unknown[], Record<string, unknown>];

    expect((definition.range as Record<string, unknown>).start).toEqual({ line: 4, character: 6 });
    expect(references.length).toBe(2);
    expect((hover.contents as Record<string, unknown>).value).toBe("function mockSymbol(): void");

    // Still alive after the burst, and exactly ONE server for the pair.
    expect(client.isAlive()).toBe(true);
    expect(lspServerCacheSizeForTesting()).toBe(1);
  });

  test("lazy cache + idle shutdown: one server per workspace+language, evicted after inactivity", async () => {
    useMockServer();
    await ensureWorkspace(key);
    const wsDir = workspaceDir(key);

    // Two acquisitions share ONE client (max 1 server per language per ws).
    const c1 = await acquireServer(wsDir, "typescript");
    const c2 = await acquireServer(wsDir, "typescript");
    expect(c2).toBe(c1);
    expect(lspServerCacheSizeForTesting()).toBe(1);
    const firstPid = c1.pid;

    // Idle shutdown fires (10 min default — shortened by the hook) and evicts.
    setLspIdleTimeoutForTesting(50);
    await sleep(400);
    expect(lspServerCacheSizeForTesting()).toBe(0);
    expect(c1.isAlive()).toBe(false);

    // The next acquisition respawns a FRESH server (new pid) honestly.
    const c3 = await acquireServer(wsDir, "typescript");
    expect(c3.isAlive()).toBe(true);
    expect(c3.pid).not.toBe(firstPid);
    await c3.shutdown();
    expect(LSP_IDLE_SHUTDOWN_MS).toBe(10 * 60_000);
  });
});
