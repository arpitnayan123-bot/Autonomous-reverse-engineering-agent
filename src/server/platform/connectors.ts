import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { db } from "@/lib/db";
import { audit } from "@/lib/security";
import { sealHeaders, openHeaders } from "@/server/agent/vault";
import { safeFetch, assertPublicUrl, BlockedUrlError } from "./net";
import { platformWebSearch } from "./research";

// Header sealing lives in the vault (next to the AES-256-GCM primitives) so
// research.ts can reuse it without importing this module — keeps the
// dependency graph acyclic. Re-exported here for existing callers.
export { sealHeaders, openHeaders };

/**
 * Universal Connector System.
 *
 * Three kinds of reusable external capability:
 *  - builtin  — platform-level services (web search, GitHub analysis, safe fetch)
 *  - http     — arbitrary user HTTP endpoints (SSRF-guarded like everything else)
 *  - mcp      — external MCP servers over stdio (allowlisted binaries, no shell)
 *
 * Header secrets are sealed with the same AES-256-GCM vault as provider keys
 * and are never returned to the client — only "configured: yes/no".
 */

// --- Builtins (global, no DB row) ------------------------------------------

export interface BuiltinDef {
  id: string;
  name: string;
  description: string;
  inputHint: string;
}

export const BUILTINS: BuiltinDef[] = [
  {
    id: "builtin:web-search",
    name: "Platform web search",
    description: "Cited web search via the platform search function.",
    inputHint: '{"query": "string"}',
  },
  {
    id: "builtin:github-api",
    name: "GitHub repository analysis",
    description: "Public repository metadata, languages, tree, license.",
    inputHint: '{"repo": "owner/repo"}',
  },
  {
    id: "builtin:http-fetch",
    name: "SSRF-guarded fetch",
    description: "GET a public URL through the platform network guard.",
    inputHint: '{"url": "https://…"}',
  },
];

// --- MCP connector support ---------------------------------------------------

const MCP_BINARIES = new Set(["node", "bun", "npx", "bunx", "python3", "uvx"]);

export interface McpProbeResult {
  ok: boolean;
  detail: string;
  tools?: Array<{ name: string; description?: string }>;
}

async function withMcpClient(
  connector: { endpoint: string; args: string[] },
  fn: (client: Client) => Promise<McpProbeResult>,
  timeoutMs = 20_000
): Promise<McpProbeResult> {
  const bin = connector.endpoint;
  if (bin.includes("/") || !MCP_BINARIES.has(bin)) {
    return { ok: false, detail: `MCP server binary must be one of ${[...MCP_BINARIES].join(", ")} (no paths, no shell)` };
  }
  const transport = new StdioClientTransport({
    command: bin,
    args: connector.args,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: "/tmp",
      LANG: "C.UTF-8",
    } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "rea-connector", version: "1.0.0" });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    return await fn(client);
  } catch (err) {
    return { ok: false, detail: `MCP connection failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) };
  } finally {
    try {
      await client.close();
    } catch {
      /* transport already dead */
    }
  }
}

export async function probeMcpServer(endpoint: string, args: string[]): Promise<McpProbeResult> {
  return withMcpClient({ endpoint, args }, async (client) => {
    const tools = await client.listTools();
    return {
      ok: true,
      detail: `MCP server responded with ${tools.tools?.length ?? 0} tools`,
      tools: (tools.tools ?? []).slice(0, 50).map((t) => ({ name: t.name, description: t.description?.slice(0, 160) })),
    };
  });
}

export async function invokeMcpTool(endpoint: string, args: string[], toolName: string, toolArgs: Record<string, unknown>): Promise<McpProbeResult> {
  return withMcpClient({ endpoint, args }, async (client) => {
    const result = await client.callTool({ name: toolName, arguments: toolArgs });
    const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
    const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n").slice(0, 20_000);
    return { ok: !(result as { isError?: boolean }).isError, detail: text || "tool returned no text content" };
  });
}

// --- HTTP connector support ---------------------------------------------------

export async function testHttpConnector(endpoint: string, headers: Record<string, string>): Promise<{ ok: boolean; detail: string; status?: number }> {
  try {
    await assertPublicUrl(endpoint);
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "URL rejected" };
  }
  try {
    const res = await safeFetch(endpoint, { headers, timeoutMs: 15_000, maxBytes: 256 * 1024 });
    return {
      ok: res.status >= 200 && res.status < 400,
      detail: `HTTP ${res.status} (${res.ms}ms)`,
      status: res.status,
    };
  } catch (err) {
    const msg = err instanceof BlockedUrlError ? err.message : err instanceof Error ? err.message : String(err);
    return { ok: false, detail: msg.slice(0, 300) };
  }
}

export async function invokeHttpConnector(
  endpoint: string,
  headers: Record<string, string>,
  input: Record<string, unknown>,
  method = "POST"
): Promise<{ ok: boolean; status: number; body: string }> {
  await assertPublicUrl(endpoint); // SSRF guard before ANY request
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(endpoint, {
      method: method.toUpperCase() === "GET" ? "GET" : "POST",
      headers: { "content-type": "application/json", ...headers },
      body: method.toUpperCase() === "GET" ? undefined : JSON.stringify(input),
      signal: controller.signal,
    });
    const body = (await res.text()).slice(0, 20_000);
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// --- Registry operations -------------------------------------------------------

export interface ConnectorTestResult {
  ok: boolean;
  detail: string;
  tools?: Array<{ name: string; description?: string }>;
}

export async function testConnector(connectorId: string, userId: string): Promise<ConnectorTestResult> {
  const connector = await db.connector.findFirst({ where: { id: connectorId, userId } });
  if (!connector) return { ok: false, detail: "connector not found" };

  const headers = openHeaders(connector.sealedHeaders);
  const cfg = safeParse(connector.config) as { args?: string[]; method?: string } | null;

  let result: ConnectorTestResult;
  if (connector.kind === "builtin") {
    result = { ok: true, detail: "built-in platform capability (always available)" };
  } else if (connector.kind === "http") {
    if (!connector.endpoint) {
      result = { ok: false, detail: "no endpoint configured" };
    } else {
      const t = await testHttpConnector(connector.endpoint, headers);
      result = { ok: t.ok, detail: t.detail };
    }
  } else if (connector.kind === "mcp") {
    if (!connector.endpoint) {
      result = { ok: false, detail: "no command configured" };
    } else {
      const p = await probeMcpServer(connector.endpoint, cfg?.args ?? []);
      result = { ok: p.ok, detail: p.detail, tools: p.tools };
    }
  } else {
    result = { ok: false, detail: `unknown connector kind: ${connector.kind}` };
  }

  await db.connector.update({
    where: { id: connector.id },
    data: {
      status: result.ok ? "healthy" : "unreachable",
      lastCheckedAt: new Date(),
      lastError: result.ok ? null : result.detail.slice(0, 300),
    },
  });
  await audit("connector.test", {
    userId,
    detail: `${connector.name} (${connector.kind}) → ${result.ok ? "healthy" : "unreachable"}`,
  });
  return result;
}

export async function invokeConnector(
  connectorId: string,
  userId: string,
  input: Record<string, unknown>
): Promise<{ ok: boolean; detail: string; kind?: string }> {
  const connector = await db.connector.findFirst({ where: { id: connectorId, userId } });
  if (!connector) return { ok: false, detail: "connector not found" };
  const cfg = safeParse(connector.config) as { args?: string[]; method?: string; tool?: string } | null;
  const headers = openHeaders(connector.sealedHeaders);

  let result: { ok: boolean; detail: string };
  if (connector.kind === "builtin") {
    if (connector.endpoint === "builtin:web-search" || connector.name === BUILTINS[0].name) {
      try {
        const results = await platformWebSearch(String(input.query ?? ""), 6);
        result = { ok: true, detail: JSON.stringify(results).slice(0, 18_000) };
      } catch (err) {
        result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    } else {
      result = { ok: false, detail: `builtin invocation for ${connector.endpoint} is not implemented` };
    }
  } else if (connector.kind === "http") {
    if (!connector.endpoint) {
      result = { ok: false, detail: "no endpoint configured" };
    } else {
      try {
        const r = await invokeHttpConnector(connector.endpoint, headers, input, cfg?.method ?? "POST");
        result = { ok: r.ok, detail: `HTTP ${r.status}: ${r.body.slice(0, 2000)}` };
      } catch (err) {
        result = { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    }
  } else if (connector.kind === "mcp") {
    if (!connector.endpoint) {
      result = { ok: false, detail: "no command configured" };
    } else if (!cfg?.tool) {
      result = { ok: false, detail: "no tool configured in connector config (set config.tool)" };
    } else {
      const r = await invokeMcpTool(connector.endpoint, cfg.args ?? [], cfg.tool, input);
      result = { ok: r.ok, detail: r.detail };
    }
  } else {
    result = { ok: false, detail: `unknown connector kind: ${connector.kind}` };
  }

  await audit("connector.invoke", {
    userId,
    detail: `${connector.name} (${connector.kind}) → ${result.ok ? "ok" : "failed"}`,
  });
  return { ...result, kind: connector.kind };
}

function safeParse(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
