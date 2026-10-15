#!/usr/bin/env bun
/**
 * REA MCP Server — expose the running REA platform to external coding agents
 * (Claude Code, Cursor, Codex, or any MCP client) over stdio.
 *
 * Design: a thin, honest bridge. Every tool maps 1:1 onto an existing
 * authenticated REA API route, so auth, ownership scoping, rate limits,
 * auditing, sandboxing and evidence doctrine stay in exactly one place —
 * the platform itself. This process never touches the database, the vault,
 * or the filesystem directly.
 *
 * Configuration (environment):
 *   REA_MCP_URL    — base URL of the running REA server
 *                    (default: http://127.0.0.1:3000)
 *   REA_MCP_TOKEN  — REQUIRED. The value of the user's `rea_session` cookie
 *                    (mint one with: bun scripts/mcp-token.ts --demo).
 *                    The token is renewed in-memory when the API slides the
 *                    session forward; it is never written anywhere.
 *
 * All diagnostics go to stderr — stdout carries only the MCP protocol.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const BASE = (process.env.REA_MCP_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
let TOKEN = process.env.REA_MCP_TOKEN ?? "";

if (!TOKEN) {
  console.error(
    "[rea-mcp] REA_MCP_TOKEN is required — the value of your rea_session cookie.\n" +
    "[rea-mcp] Mint one with:  bun scripts/mcp-token.ts --demo\n" +
    "[rea-mcp]   (or log in normally and copy the rea_session cookie value)"
  );
  process.exit(1);
}

const MAX_RESULT = 24_000;
const SLOW_MS = 300_000; // crawl / research / verify / recon are long-running

// --- HTTP bridge -------------------------------------------------------------

interface ApiResult {
  status: number;
  ok: boolean;
  body: unknown;
  raw: string;
}

async function api(
  path: string,
  init: RequestInit = {},
  timeoutMs = 60_000
): Promise<ApiResult> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (init.body !== undefined && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  if (TOKEN) headers.cookie = `rea_session=${TOKEN}`;

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(
      `REA API unreachable at ${BASE}${path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Sliding session renewal — adopt the refreshed token in memory only.
  const setCookies =
    typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const c of setCookies) {
    const m = c.match(/(?:^|;\s*)rea_session=([^;]+)/);
    if (m?.[1] && m[1] !== TOKEN) TOKEN = m[1];
  }

  const raw = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  return { status: res.status, ok: res.ok, body, raw };
}

// --- Argument helpers ----------------------------------------------------------

type Args = Record<string, unknown>;

function str(args: Args, key: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) {
    if (opts.required) throw new Error(`argument "${key}" is required`);
    return undefined;
  }
  return v.trim().slice(0, opts.max ?? 2_000);
}

function num(args: Args, key: string): number | undefined {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.trunc(v);
}

function bool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === "boolean" ? v : undefined;
}

function pid(args: Args): string {
  return encodeURIComponent(str(args, "projectId", { required: true, max: 64 })!);
}

// --- Tool registry --------------------------------------------------------------

const TOOLS: Tool[] = [
  {
    name: "rea_health",
    description:
      "Check the REA platform is reachable and report its banner/version info.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rea_re_tools",
    description:
      "List REA's classical RE toolchain (Ghidra, rizin, pycdc, angr; IDA/Hopper when licensed) with LIVE availability per tool: docker image, local binary, or unavailable-with-enable-instructions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rea_re_tool",
    description:
      "Run a classical RE tool from REA's registry on an input: operations decompile | disassemble | functions | info | symbolic. Input: targetId of an owned uploaded target, or path under platform storage. Sandboxed execution; real output only.",
    inputSchema: {
      type: "object",
      properties: {
        tool: { type: "string", description: 'Registry id: ghidra | rizin | pycdc | pycdas | angr | ida | hopper.' },
        operation: { type: "string", description: "decompile | disassemble | functions | info | symbolic" },
        targetId: { type: "string", description: "Id of an owned uploaded target." },
        path: { type: "string", description: "Alternative: absolute path under platform storage." },
      },
      required: ["tool", "operation"],
    },
  },
  {
    name: "rea_leaderboard_top",
    description:
      "Top entries of REA's public verification leaderboard (best score per agent/benchmark/category, provenance-graded: OBSERVED = measured by the open harness; INFERRED = external claim with methodology).",
    inputSchema: {
      type: "object",
      properties: {
        benchmark: { type: "string", description: "Optional filter, e.g. rea-bench." },
        category: { type: "string", description: "Optional filter: binary|web|code|mixed|overall." },
      },
    },
  },
  {
    name: "rea_list_projects",
    description:
      "List the authenticated user's REA projects with activity counters (pages, graph nodes, reports, orchestrations, verifications) and each project's latest pipeline status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rea_create_project",
    description:
      "Create an REA project. kind=website needs `reference` (public http(s) URL); kind=github needs `reference` (owner/repo or github.com URL); kind=file needs `targetId` of an uploaded target.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name (max 120 chars)" },
        kind: { type: "string", enum: ["website", "github", "file"] },
        reference: { type: "string", description: "URL for website, owner/repo for github" },
        targetId: { type: "string", description: "Uploaded target id for file projects" },
        description: { type: "string", description: "Optional description (max 500 chars)" },
      },
      required: ["name", "kind"],
    },
  },
  {
    name: "rea_get_project",
    description: "Fetch one REA project's full detail record by id.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
    },
  },
  {
    name: "rea_crawl",
    description:
      "Run a bounded polite crawl of a website project (robots.txt-aware, same-origin, depth-limited) with tech fingerprinting. Results land in the knowledge graph. Website projects only. Can take minutes.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        maxPages: { type: "number", description: "Page budget (server-capped)" },
        maxDepth: { type: "number", description: "Link depth budget" },
        render: { type: "boolean", description: "Also capture a headless-browser snapshot of the entry page when the browser runtime is available" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "rea_list_pages",
    description: "List crawled pages for a project: url, status, title, depth, detected tech, excerpt.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
    },
  },
  {
    name: "rea_recon",
    description:
      "GitHub/file projects only. action=materialize pulls the repo tarball (or uploaded target) into the isolated workspace; action=parse runs tree-sitter AST recon (functions/classes/imports/endpoints/secret candidates) into the knowledge graph. Parse requires a materialized workspace. Can take minutes.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        action: { type: "string", enum: ["materialize", "parse"], description: "default: parse" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "rea_workspace_status",
    description: "Report the project's isolated builder workspace state (exists, file count, top-level entries).",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
    },
  },
  {
    name: "rea_research",
    description:
      "Run a cited research pass: platform web search, GitHub repo analysis when the query references owner/repo, docs discovery for website projects, YouTube oEmbed metadata — then an LLM synthesis where every claim must cite a source (unsourced claims are marked UNKNOWN). Persists a report. Can take minutes.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        query: { type: "string", description: "Research query (max 500 chars)" },
      },
      required: ["projectId", "query"],
    },
  },
  {
    name: "rea_list_reports",
    description: "List this project's persisted research reports (query, summary, markdown, sources).",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
    },
  },
  {
    name: "rea_graph",
    description:
      "Fetch the project knowledge graph (nodes with OBSERVED/DERIVED/INFERRED/UNKNOWN provenance + edges). Optionally filter by node kind and cap the node count.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        kind: { type: "string", description: "Filter nodes by kind (e.g. page, function, endpoint, finding)" },
        limit: { type: "number", description: "Max nodes (server-capped at 600, default 400)" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "rea_verify",
    description:
      "Run the 11-check verification suite against a URL (defaults to the project reference for website projects): reachability, content substance, soft-404 heuristic, security headers, robots.txt, optional headless render, plus regression delta vs the previous run. Can take minutes.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        url: { type: "string", description: "Target URL (defaults to the project reference)" },
        referenceUrl: { type: "string", description: "Reference URL for diff-based comparison" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "rea_verify_history",
    description: "List past verification runs for a project (score, regression, check results).",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
    },
  },
  {
    name: "rea_workspace_op",
    description:
      "Operate on the project's isolated builder workspace (sandboxed, audited, rate-limited server-side). ops: list (path?), read (path), write (path, content), patch (path, find, replace — ambiguous patches are rejected), terminal (command — allowlisted, no shell, 60s cap).",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        op: { type: "string", enum: ["list", "read", "write", "patch", "terminal"] },
        path: { type: "string" },
        content: { type: "string" },
        find: { type: "string" },
        replace: { type: "string" },
        command: { type: "string" },
      },
      required: ["projectId", "op"],
    },
  },
  {
    name: "rea_orchestrate",
    description:
      "Drive the 9-stage pipeline (discover → collect → understand → map → research → plan → build → test → verify) for a project. action=start {goal} launches the persisted DAG in the background; action=approve {orchestrationId, stepId, approved} resolves a PLAN/BUILD human-approval gate (approved=false rejects and stops); action=cancel {orchestrationId} cancels between waves.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        action: { type: "string", enum: ["start", "approve", "cancel"] },
        goal: { type: "string", description: "Pipeline goal for action=start" },
        orchestrationId: { type: "string" },
        stepId: { type: "string" },
        approved: { type: "boolean", description: "approve=true resumes, false rejects (default true)" },
      },
      required: ["projectId", "action"],
    },
  },
  {
    name: "rea_orchestration_status",
    description:
      "Poll pipeline state for a project: every orchestration (or one by id) with stage-by-step status, attempts, durations, errors and JSON outputs. Poll this after rea_orchestrate start to find steps waiting at approval gates.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        orchestrationId: { type: "string", description: "Fetch a single orchestration instead of the last 10" },
      },
      required: ["projectId"],
    },
  },
  {
    name: "rea_list_connectors",
    description:
      "List the Universal Connector registry: built-in capabilities plus the user's registered HTTP and MCP-stdio connectors (secrets are never returned — only whether headers are configured).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rea_probe_url",
    description:
      "Fetch and analyze ONE public http(s) URL through the REA Explorer pipeline (no project needed): SSRF-guarded fetch with timeout and size cap, returning observed facts — requested/final URL, status, timing, content-type, sha256, title, meta description, h1/h2/h3, links, detected technologies and a bounded text excerpt. Private/internal addresses and non-http(s) schemes are refused with an honest error.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http(s) URL to probe (max 2000 chars)" },
        includeText: { type: "boolean", description: "Include the bounded visible-text excerpt (default true)" },
      },
      required: ["url"],
    },
  },
  {
    name: "rea_crawl_url",
    description:
      "Bounded same-domain recursive crawl of one public http(s) URL through the REA Explorer pipeline (no project needed): breadth-first, visited-URL set, configurable maxPages (1-20) and maxDepth (0-3), per-page timeouts, robots.txt respected. Returns structured results: visited URLs with final URL/status/title/depth, same-origin links per page, per-page errors, duplicates skipped, queued (unfetched) count and the effective limits. Internal addresses are refused by the SSRF guard.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http(s) start URL (max 2000 chars)" },
        maxPages: { type: "number", description: "Page budget 1-20 (default 5)" },
        maxDepth: { type: "number", description: "Link-depth budget 0-3 (default 1; 0 = entry page only)" },
      },
      required: ["url"],
    },
  },
  {
    name: "rea_connector_action",
    description:
      "Test or invoke a registered connector. action=test health-checks it (HTTP probe / MCP tools-list); action=invoke runs it with a JSON input (builtin web-search takes {query}; HTTP takes a JSON body; MCP takes the tool's arguments).",
    inputSchema: {
      type: "object",
      properties: {
        connectorId: { type: "string" },
        action: { type: "string", enum: ["test", "invoke"], description: "default: test" },
        input: { type: "object", description: "JSON input for action=invoke", additionalProperties: true },
      },
      required: ["connectorId"],
    },
  },
];

// --- Tool execution -------------------------------------------------------------

function truncate(text: string): string {
  if (text.length <= MAX_RESULT) return text;
  return `${text.slice(0, MAX_RESULT)}\n… [truncated ${text.length - MAX_RESULT} chars]`;
}

function toolText(text: string, isError = false) {
  return { content: [{ type: "text" as const, text: truncate(text) }], isError };
}

function toolJson(result: ApiResult): ReturnType<typeof toolText> {
  const label = result.body === null ? result.raw.slice(0, 2_000) : JSON.stringify(result.body, null, 2);
  return toolText(`HTTP ${result.status}\n${label}`, !result.ok);
}

async function executeTool(name: string, args: Args): Promise<ReturnType<typeof toolText>> {
  switch (name) {
    case "rea_health": {
      const r = await api("/api");
      return toolJson(r);
    }
    case "rea_re_tools": {
      const r = await api("/api/retools");
      return toolJson(r);
    }
    case "rea_re_tool": {
      const r = await api("/api/retools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          tool: args.tool,
          operation: args.operation,
          ...(args.targetId ? { targetId: args.targetId } : {}),
          ...(args.path ? { path: args.path } : {}),
        }),
      }, 300_000);
      return toolJson(r);
    }
    case "rea_leaderboard_top": {
      const qs = new URLSearchParams();
      if (args.benchmark) qs.set("benchmark", String(args.benchmark));
      if (args.category) qs.set("category", String(args.category));
      const r = await api(`/api/leaderboard${qs.toString() ? `?${qs}` : ""}`);
      return toolJson(r);
    }
    case "rea_list_projects": {
      const r = await api("/api/projects");
      return toolJson(r);
    }
    case "rea_create_project": {
      const body: Record<string, unknown> = {
        name: str(args, "name", { required: true, max: 120 }),
        kind: str(args, "kind", { required: true, max: 16 }),
      };
      const reference = str(args, "reference", { max: 2_000 });
      const targetId = str(args, "targetId", { max: 64 });
      const description = str(args, "description", { max: 500 });
      if (reference) body.reference = reference;
      if (targetId) body.targetId = targetId;
      if (description) body.description = description;
      const r = await api("/api/projects", { method: "POST", body: JSON.stringify(body) });
      return toolJson(r);
    }
    case "rea_get_project": {
      const r = await api(`/api/projects/${pid(args)}`);
      return toolJson(r);
    }
    case "rea_crawl": {
      const body: Record<string, unknown> = {};
      const maxPages = num(args, "maxPages");
      const maxDepth = num(args, "maxDepth");
      const render = bool(args, "render");
      if (maxPages !== undefined) body.maxPages = maxPages;
      if (maxDepth !== undefined) body.maxDepth = maxDepth;
      if (render !== undefined) body.render = render;
      const r = await api(`/api/projects/${pid(args)}/crawl`, { method: "POST", body: JSON.stringify(body) }, SLOW_MS);
      return toolJson(r);
    }
    case "rea_list_pages": {
      const r = await api(`/api/projects/${pid(args)}/crawl`);
      return toolJson(r);
    }
    case "rea_recon": {
      const action = str(args, "action", { max: 16 }) ?? "parse";
      const r = await api(
        `/api/projects/${pid(args)}/recon`,
        { method: "POST", body: JSON.stringify({ action }) },
        SLOW_MS
      );
      return toolJson(r);
    }
    case "rea_workspace_status": {
      const r = await api(`/api/projects/${pid(args)}/recon`);
      return toolJson(r);
    }
    case "rea_research": {
      const body = {
        query: str(args, "query", { required: true, max: 500 }),
      };
      const r = await api(`/api/projects/${pid(args)}/research`, { method: "POST", body: JSON.stringify(body) }, SLOW_MS);
      return toolJson(r);
    }
    case "rea_list_reports": {
      const r = await api(`/api/projects/${pid(args)}/research`);
      return toolJson(r);
    }
    case "rea_graph": {
      const params = new URLSearchParams();
      const kind = str(args, "kind", { max: 64 });
      const limit = num(args, "limit");
      if (kind) params.set("kind", kind);
      if (limit !== undefined) params.set("limit", String(Math.max(1, limit)));
      const qs = params.toString();
      const r = await api(`/api/projects/${pid(args)}/graph${qs ? `?${qs}` : ""}`);
      return toolJson(r);
    }
    case "rea_verify": {
      const body: Record<string, unknown> = {};
      const url = str(args, "url", { max: 2_000 });
      const referenceUrl = str(args, "referenceUrl", { max: 2_000 });
      if (url) body.url = url;
      if (referenceUrl) body.referenceUrl = referenceUrl;
      const r = await api(`/api/projects/${pid(args)}/verify`, { method: "POST", body: JSON.stringify(body) }, SLOW_MS);
      return toolJson(r);
    }
    case "rea_verify_history": {
      const r = await api(`/api/projects/${pid(args)}/verify`);
      return toolJson(r);
    }
    case "rea_workspace_op": {
      const body: Record<string, unknown> = {
        op: str(args, "op", { required: true, max: 16 }),
      };
      for (const key of ["path", "content", "find", "replace", "command"] as const) {
        const v = str(args, key, { max: key === "content" ? 400_000 : 2_000 });
        if (v !== undefined) body[key] = v;
      }
      const r = await api(
        `/api/projects/${pid(args)}/workspace`,
        { method: "POST", body: JSON.stringify(body) },
        120_000
      );
      return toolJson(r);
    }
    case "rea_orchestrate": {
      const body: Record<string, unknown> = {
        action: str(args, "action", { required: true, max: 16 }),
      };
      const goal = str(args, "goal", { max: 2_000 });
      const orchestrationId = str(args, "orchestrationId", { max: 64 });
      const stepId = str(args, "stepId", { max: 64 });
      const approved = bool(args, "approved");
      if (goal) body.goal = goal;
      if (orchestrationId) body.orchestrationId = orchestrationId;
      if (stepId) body.stepId = stepId;
      if (approved !== undefined) body.approved = approved;
      const r = await api(`/api/projects/${pid(args)}/orchestrate`, { method: "POST", body: JSON.stringify(body) }, 120_000);
      return toolJson(r);
    }
    case "rea_orchestration_status": {
      const orchId = str(args, "orchestrationId", { max: 64 });
      const qs = orchId ? `?orchestrationId=${encodeURIComponent(orchId)}` : "";
      const r = await api(`/api/projects/${pid(args)}/orchestrate${qs}`);
      return toolJson(r);
    }
    case "rea_list_connectors": {
      const r = await api("/api/connectors");
      return toolJson(r);
    }
    case "rea_probe_url": {
      const body: Record<string, unknown> = {
        url: str(args, "url", { required: true, max: 2_000 }),
      };
      const includeText = bool(args, "includeText");
      if (includeText !== undefined) body.includeText = includeText;
      const r = await api("/api/explore", { method: "POST", body: JSON.stringify(body) }, 60_000);
      return toolJson(r);
    }
    case "rea_crawl_url": {
      const body: Record<string, unknown> = {
        url: str(args, "url", { required: true, max: 2_000 }),
        mode: "crawl",
      };
      const maxPages = num(args, "maxPages");
      const maxDepth = num(args, "maxDepth");
      if (maxPages !== undefined) body.maxPages = maxPages;
      if (maxDepth !== undefined) body.maxDepth = maxDepth;
      const r = await api("/api/explore", { method: "POST", body: JSON.stringify(body) }, SLOW_MS);
      return toolJson(r);
    }
    case "rea_connector_action": {
      const cid = encodeURIComponent(str(args, "connectorId", { required: true, max: 64 })!);
      const body: Record<string, unknown> = {
        action: str(args, "action", { max: 16 }) ?? "test",
      };
      const input = args.input;
      if (input !== undefined && typeof input === "object" && input !== null) {
        body.input = input as Record<string, unknown>;
      }
      const r = await api(`/api/connectors/${cid}`, { method: "POST", body: JSON.stringify(body) }, 120_000);
      return toolJson(r);
    }
    default:
      return toolText(`Unknown tool: ${name}`, true);
  }
}

// --- Server bootstrap -------------------------------------------------------------

const server = new Server(
  { name: "rea-platform", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req: CallToolRequest) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Args;
  try {
    return await executeTool(name, args);
  } catch (err) {
    return toolText(
      `rea tool error: ${err instanceof Error ? err.message : String(err)}`,
      true
    );
  }
});

process.on("uncaughtException", (err) => {
  console.error("[rea-mcp] uncaught exception:", err.message);
});
process.on("unhandledRejection", (err) => {
  console.error("[rea-mcp] unhandled rejection:", err instanceof Error ? err.message : String(err));
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[rea-mcp] REA platform MCP server ready — bridging ${BASE} (${TOOLS.length} tools)`);
}

main().catch((err) => {
  console.error("[rea-mcp] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
