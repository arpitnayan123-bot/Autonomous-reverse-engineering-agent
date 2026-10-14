import { promises as fs } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { rea } from "@/server/engine/rea-bridge";
import { CHAT_TOOL_TIMEOUT_MS } from "@/lib/security";
// Shared strings helper owned by task 2-a (use as-is): cache-first extraction
// against storage/uploads/<targetId>/strings-cache.json.
import { getStringsForTarget } from "@/server/engine/strings";
import { probeUrl, PROBE_TIMEOUT_MS } from "@/server/platform/explorer";
import {
  CHAT_WORKSPACE_QUOTA_BYTES,
  chatCommandAllowlist,
  listFiles as workspaceListFiles,
  readFile as workspaceReadFile,
  runCommand as workspaceRunCommand,
  writeFile as workspaceWriteFile,
  workspaceDiskUsage,
} from "@/server/platform/builder";
import { BlockedUrlError } from "@/server/platform/net";
import { platformWebSearch } from "@/server/platform/research";
import type { Target } from "@prisma/client";
import type { ToolSchema } from "./providers";

/**
 * Server-side tools exposed to the REA investigation agent.
 *
 * Security model:
 * - The agent never supplies filesystem paths. Every REA tool call is forced
 *   onto the current target's stored path (absolute, under storage/uploads).
 * - REA tools are allowlisted; everything else is rejected.
 * - SQL tools run against a readOnly SQLite connection with a strict
 *   SELECT-only grammar guard.
 * - All outputs are truncated before they reach the LLM.
 */

export const TOOL_RESULT_MAX_CHARS = 6000;

/**
 * Prefix for a tool-trace result recording a REFUSED call — the model asked
 * for a tool that this session cannot route (e.g. a file-bound tool in a
 * free chat, or an unknown name). The marker is part of the persisted trace
 * JSON and the receipt format: it is how the platform distinguishes
 * "attempted but unavailable" from "executed with a result" and from
 * "never called at all". Never cache or present these as successes.
 */
export const TOOL_REFUSAL_MARKER = "NOT EXECUTED";

const REA_ALLOWLIST = new Set([
  "inspect_artifact",
  "analyze_javascript_application",
  "inspect_plist",
  "inspect_evm_interface",
  "inspect_wasm_artifact",
  "inspect_go_binary",
  "inspect_sqlite_database",
  "inspect_binary_layout",
  "extract_artifact",
  "inspect_firmware_regions",
  "inspect_packet_fields",
  "inspect_pcap_capture",
  "inspect_web_network_capture",
  "inspect_managed_artifact",
  "inspect_managed_members",
  "inspect_pe_resources",
  "inspect_keyed_archive",
  "decode_interface_builder",
  "search",
  "inspect_analysis_view",
  "close_binary",
  "open_binary",
  "binary_overview",
  "list_strings",
  "list_names",
  "list_procedures",
  "list_segments",
  "inspect_native_load_image",
]);

/** Tools that must NOT be wrapped in an open/close session. */
const NO_OPEN_TOOLS = new Set([
  "close_binary",
  "list_documents",
  "capabilities",
  "inspect_analysis_view",
]);

/** Key names that would smuggle a filesystem path into a tool call. */
const PATH_KEY_RE =
  /\b(path|filepath|filename|file_name|file|directory|dirname|dir|destination|dest|target|uri|url|location)\b/i;

export interface AgentToolContext {
  target: Target;
  userId: string;
  /**
   * Chat session id, when the call comes from the chat loop. Enables the
   * retry-dedup cache: after an interrupted turn is retried (resend or
   * regenerate), an identical tool call (same tool + same args in the same
   * session) returns the PRIOR result instead of executing again — no
   * duplicate fetches/queries/writes. Absent → no dedup (MCP/REST paths).
   */
  sessionId?: string;
}

export interface AgentTool {
  name: string;
  description: string;
  /** JSON-schema-ish description of accepted args (for the system prompt). */
  args: Record<string, unknown>;
  /**
   * "any" — routable in BOTH target chats and FREE chats (no file target
   * needed). "target" — operates on the attached target, unavailable in
   * free chats. The free-chat availability list, the loop's routing, the
   * refusal wording and both system prompts all DERIVE from this flag, so
   * a tool cannot be advertised but unroutable (or vice versa).
   */
  scope: "any" | "target";
  /**
   * Apply the cross-turn retry-dedup cache (default true). Stateful/mutating
   * tools set false: re-running them after a retry or a workspace change is
   * the POINT — a cached prior result would be stale, not honest.
   */
  dedup?: boolean;
  run: (args: Record<string, unknown>, ctx: AgentToolContext) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function argStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args?.[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function absoluteStoredPath(storedPath: string): string {
  return path.isAbsolute(storedPath)
    ? storedPath
    : path.join(process.cwd(), storedPath);
}

function hexdump(buf: Buffer, baseOffset: number): string {
  const rows: string[] = [];
  for (let i = 0; i < buf.length; i += 16) {
    const slice = buf.subarray(i, Math.min(i + 16, buf.length));
    const hex = Array.from(slice)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(" ")
      .padEnd(47, " ");
    const ascii = Array.from(slice)
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
      .join("");
    rows.push(`0x${(baseOffset + i).toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  return rows.join("\n");
}

function qIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ---------------------------------------------------------------------------
// (strings-cache handled by task 2-a's getStringsForTarget in @/server/engine/strings)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

const targetInfoTool: AgentTool = {
  name: "target_info",
  scope: "target",
  description:
    "Full metadata of the current investigation target (name, size, sha256, detected format, status, summary) plus its recent analysis runs.",
  args: { type: "object", properties: {}, additionalProperties: false },
  async run(_args, ctx) {
    const t = ctx.target;
    const runs = await db.analysisRun.findMany({
      where: { targetId: t.id },
      orderBy: { createdAt: "desc" },
      take: 5,
    });
    const lines = [
      `# Target: ${t.originalName}`,
      `- id: ${t.id}`,
      `- size: ${t.sizeBytes} bytes (${fmtBytes(t.sizeBytes)})`,
      `- sha256: ${t.sha256}`,
      `- mime: ${t.mimeType ?? "unknown"}`,
      `- detected format: ${t.detectedFormat ?? "unknown"} (family: ${t.formatFamily ?? "unknown"})`,
      `- platform status: ${t.status}`,
      `- summary: ${t.summary ?? "(none yet)"}`,
      `- uploaded: ${t.createdAt.toISOString()}`,
      "",
      "## Analysis runs (latest first)",
    ];
    if (runs.length === 0) {
      lines.push("(no runs yet — run analysis from the platform, or investigate directly with rea_tool)");
    } else {
      for (const r of runs) {
        lines.push(
          `- ${r.id} | status=${r.status} | engine=${r.engine} | step=${r.currentStep ?? "-"} | duration=${r.durationMs ?? "-"}ms | created=${r.createdAt.toISOString()}${r.error ? ` | error=${r.error.slice(0, 200)}` : ""}`
        );
      }
    }
    return lines.join("\n");
  },
};

const listFindingsTool: AgentTool = {
  name: "list_findings",
  scope: "target",
  description:
    "Query findings recorded by prior REA analysis runs on this target. Filter by type and/or name substring.",
  args: {
    type: "object",
    properties: {
      type: { type: "string", description: "Finding type filter (exact match, e.g. 'function', 'string', 'import')." },
      q: { type: "string", description: "Case-insensitive substring filter on the finding name." },
      limit: { type: "integer", description: "Max rows to return (1-100, default 50)." },
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    const limit = clampInt(args?.limit, 50, 1, 100);
    const type = argStr(args, "type");
    const q = argStr(args, "q");
    const where: Record<string, unknown> = { run: { targetId: ctx.target.id } };
    if (type) where.type = type;
    if (q) where.name = { contains: q };
    const [rows, total] = await Promise.all([
      db.finding.findMany({
        where,
        orderBy: [{ type: "asc" }, { createdAt: "desc" }],
        take: limit,
      }),
      db.finding.count({ where }),
    ]);
    if (rows.length === 0) return `No findings match (total ${total}). Available types: run list_findings without filters, or check target_info.`;
    const byType = new Map<string, string[]>();
    for (const f of rows) {
      const row = `| ${f.name.replace(/\|/g, "\\|").slice(0, 80)} | ${f.address ?? "-"} | ${f.sizeBytes ?? "-"} |`;
      if (!byType.has(f.type)) byType.set(f.type, []);
      byType.get(f.type)!.push(row);
    }
    const out: string[] = [`Total matching findings: ${total} (showing ${rows.length}).`];
    for (const [t, rws] of byType) {
      out.push("", `### type: ${t} (${rws.length} shown)`, "| name | address | size |", "|---|---|---|", ...rws);
    }
    return out.join("\n");
  },
};

const getEvidenceTool: AgentTool = {
  name: "get_evidence",
  scope: "target",
  description:
    "Recent evidence ledger entries (raw REA engine observations) for this target, newest first, with payload snippets.",
  args: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "Max entries (1-20, default 10)." },
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    const limit = clampInt(args?.limit, 10, 1, 20);
    const rows = await db.evidence.findMany({
      where: { run: { targetId: ctx.target.id } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    if (rows.length === 0) return "No evidence recorded yet. Use rea_tool to generate observations (e.g. binary_overview, inspect_artifact, list_strings).";
    return rows
      .map((e, i) => {
        const head = `[${i + 1}] kind=${e.kind} operation=${e.operation ?? "-"} subject=${e.subjectName ?? "-"} confidence=${e.confidence ?? "-"}${e.predicateType ? ` predicate=${e.predicateType}` : ""}`;
        return `${head}\n${e.payload.slice(0, 1000)}${e.payload.length > 1000 ? "…[truncated]" : ""}`;
      })
      .join("\n\n");
  },
};

const readStringsTool: AgentTool = {
  name: "read_strings",
  scope: "target",
  description:
    "Extracted printable strings (ASCII + UTF-16LE) from the target file with their hex offsets. Filter by substring.",
  args: {
    type: "object",
    properties: {
      q: { type: "string", description: "Case-insensitive substring filter." },
      limit: { type: "integer", description: "Max strings to return (1-50, default 30)." },
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    const limit = clampInt(args?.limit, 30, 1, 50);
    const q = argStr(args, "q");
    const strings = await getStringsForTarget(
      ctx.target.id,
      absoluteStoredPath(ctx.target.storedPath)
    );
    const filtered = q
      ? strings.filter((s) => s.value.toLowerCase().includes(q.toLowerCase()))
      : strings;
    const head = `Strings total: ${strings.length}${q ? `, matching "${q}": ${filtered.length}` : ""}. Showing up to ${limit}.`;
    if (filtered.length === 0) return head;
    const rows = filtered.slice(0, limit).map(
      (s) =>
        `| 0x${s.offset.toString(16).padStart(8, "0")} | ${s.encoding} | ${s.value.replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 200)} |`
    );
    return `${head}\n\n| offset | encoding | value |\n|---|---|---|\n${rows.join("\n")}`;
  },
};

const readHexTool: AgentTool = {
  name: "read_hex",
  scope: "target",
  description:
    "Hexdump of a byte range of the target file (max 1024 bytes per call). Use for header / structure inspection.",
  args: {
    type: "object",
    properties: {
      offset: { type: "integer", description: "Start offset in bytes (default 0)." },
      length: { type: "integer", description: "Number of bytes (1-1024, default 256)." },
    },
    additionalProperties: false,
  },
  async run(args, ctx) {
    const offset = clampInt(args?.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const length = clampInt(args?.length, 256, 1, 1024);
    const abs = absoluteStoredPath(ctx.target.storedPath);
    const fh = await fs.open(abs, "r");
    try {
      const size = (await fh.stat()).size;
      if (offset >= size) {
        return `Offset 0x${offset.toString(16)} is beyond end of file (size ${size} = 0x${size.toString(16)}).`;
      }
      const len = Math.min(length, size - offset);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      return `File size: ${size} (0x${size.toString(16)}) bytes. Range 0x${offset.toString(16)}..0x${(offset + len).toString(16)}:\n\n${hexdump(buf, offset)}`;
    } finally {
      await fh.close().catch(() => undefined);
    }
  },
};

// ---------------------------------------------------------------------------
// Explorer — SSRF-guarded single-page web probe (works with or without a target)
// ---------------------------------------------------------------------------

/**
 * Fetch ONE public page through the Explorer and format a bounded, evidence-
 * first report. Shared by the `explore_url` registry tool (target-attached
 * chat) and the free-chat loop (agent.ts) — no target context required.
 */
export async function runExploreUrlTool(args: Record<string, unknown>): Promise<string> {
  const url = argStr(args, "url");
  if (!url) {
    return 'Error: \'url\' is required. Example: {"url":"https://example.com"}. Only public http(s) URLs are fetchable.';
  }
  if (url.length > 2048) return "Error: URL exceeds 2048 characters.";
  const includeText = args["include_text"] !== false;
  try {
    const r = await probeUrl(url, { includeText, timeoutMs: PROBE_TIMEOUT_MS });
    const lines: string[] = [
      "# explore_url — OBSERVED fetch",
      `- requested: ${r.requestUrl}`,
      `- final URL: ${r.finalUrl}`,
      `- status: ${r.status} | time: ${r.ms}ms | content-type: ${r.contentType || "(none)"}`,
      `- sha256: ${r.contentHash.slice(0, 32)}…`,
      "",
      "## Title",
      r.title ?? "(none)",
      "",
      "## Description",
      r.description ?? "(none)",
    ];
    const hs = [
      ...r.headings.h1.map((t) => `- h1: ${t}`),
      ...r.headings.h2.map((t) => `- h2: ${t}`),
      ...r.headings.h3.map((t) => `- h3: ${t}`),
    ];
    lines.push("", "## Headings", ...(hs.length ? hs : ["(none)"]));
    lines.push(
      "",
      "## Technology fingerprints (headers + markup)",
      ...(r.tech.length ? r.tech.map((t) => `- ${t}`) : ["(none detected)"])
    );
    lines.push("", `## Links (${r.links.length} captured)`);
    if (r.links.length) {
      lines.push("| href | text |", "|---|---|");
      for (const l of r.links.slice(0, 40)) {
        lines.push(`| ${l.href.slice(0, 120).replace(/\|/g, "%7C")} | ${l.text.slice(0, 60).replace(/\|/g, "%7C")} |`);
      }
      if (r.links.length > 40) lines.push(`… (+${r.links.length - 40} more)`);
    } else {
      lines.push("(none)");
    }
    if (r.textExcerpt) lines.push("", "## Text excerpt", r.textExcerpt);
    return lines.join("\n");
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      return `Error: ${err.message}. The Explorer only fetches PUBLIC http(s) pages — private/internal/metadata addresses, non-http(s) schemes and embedded credentials are refused by the SSRF guard.`;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/abort|timeout|timed out/i.test(msg)) {
      return `Error: fetch timed out for ${url} (Explorer cap ${PROBE_TIMEOUT_MS / 1000}s). The site may be slow or blocking automated clients.`;
    }
    return `Error: fetch failed for ${url}: ${msg.slice(0, 300)}. DNS failures mean the domain does not resolve; connection failures mean the host refused or dropped the connection.`;
  }
}

const exploreUrlTool: AgentTool = {
  name: "explore_url",
  scope: "any",
  description:
    "Fetch ONE public web page (http/https) through the SSRF-guarded Explorer and return REAL observations: final URL after redirects, HTTP status, response time, title, meta description, headings (h1-h3), links (href+text), technology fingerprints from headers/markup, sha256 and a short text excerpt. Use this for any analyze/open/check-this-URL request instead of answering from memory. Internal/private/metadata addresses are refused.",
  args: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute public http(s) URL to fetch, e.g. https://example.com" },
      include_text: { type: "boolean", description: "Include a short visible-text excerpt (default true)." },
    },
    required: ["url"],
    additionalProperties: false,
  },
  async run(args) {
    return runExploreUrlTool(args);
  },
};

const reaTool: AgentTool = {
  name: "rea_tool",
  scope: "target",
  description:
    "THE core tool: execute a REAL REA engine (MCP) tool against the current target. The platform opens/closes the binary session and injects the target path automatically — never pass a path.",
  args: {
    type: "object",
    properties: {
      tool: {
        type: "string",
        description: `REA tool name. Allowed: ${[...REA_ALLOWLIST].join(", ")}`,
      },
      args: {
        type: "object",
        description: "Arguments object for the REA tool (NO path/file keys — the platform injects them).",
      },
    },
    required: ["tool"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const tool = argStr(args, "tool");
    if (!tool) return "Error: 'tool' is required.";
    if (!REA_ALLOWLIST.has(tool)) {
      return `Error: REA tool "${tool}" is not allowlisted. Allowed tools: ${[...REA_ALLOWLIST].join(", ")}.`;
    }
    const rawArgs =
      args?.args && typeof args.args === "object" && !Array.isArray(args.args)
        ? (args.args as Record<string, unknown>)
        : {};
    // (2) The agent NEVER supplies paths: strip every path-ish key, then force
    // the target's stored path for session-wrapped calls.
    const cleanArgs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawArgs)) {
      if (PATH_KEY_RE.test(k)) continue;
      cleanArgs[k] = v;
    }
    try {
      if (NO_OPEN_TOOLS.has(tool)) {
        const res = await rea.callTool(tool, cleanArgs, CHAT_TOOL_TIMEOUT_MS);
        return formatReaResult(tool, res);
      }
      const abs = absoluteStoredPath(ctx.target.storedPath);
      // Inject the stored path ONLY for tools whose input schema declares a
      // `path` property — the engine validates strictly and rejects unknown
      // keys (e.g. binary_overview after open_binary). Most session tools are
      // already bound to the opened target.
      let toolArgs: Record<string, unknown> = { ...cleanArgs, path: abs };
      try {
        const defs = await rea.listTools();
        const def = defs.find((d) => d.name === tool);
        const props = def?.inputSchema?.["properties"] as
          | Record<string, unknown>
          | undefined;
        if (props && !("path" in props)) {
          toolArgs = cleanArgs;
        }
      } catch {
        /* catalog unavailable — keep the always-inject fallback */
      }
      const res = await rea.withTarget(abs, () =>
        rea.callTool(tool, toolArgs, CHAT_TOOL_TIMEOUT_MS)
      );
      return formatReaResult(tool, res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error executing REA tool "${tool}": ${msg.slice(0, 500)}. The engine may be busy or the format may not be supported; try a different tool.`;
    }
  },
};

function formatReaResult(
  tool: string,
  res: { structured: unknown; text: string; isError: boolean }
): string {
  const body = res.text.trim()
    ? res.text
    : res.structured
      ? JSON.stringify(res.structured)
      : "(empty output)";
  return `REA tool ${tool} → isError: ${res.isError}\n${body.slice(0, TOOL_RESULT_MAX_CHARS)}`;
}

// ---------------------------------------------------------------------------
// SQLite tools (readOnly, SELECT-only)
// ---------------------------------------------------------------------------

interface SqliteDb {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => Record<string, unknown>[];
  };
  close: () => void;
}

async function openTargetSqlite(ctx: AgentToolContext): Promise<SqliteDb> {
  // Dynamic import keeps node:sqlite off the module-eval path for non-sqlite targets.
  const { DatabaseSync } = (await import("node:sqlite")) as {
    DatabaseSync: new (p: string, opts?: Record<string, unknown>) => SqliteDb;
  };
  const abs = absoluteStoredPath(ctx.target.storedPath);
  return new DatabaseSync(abs, { readOnly: true });
}

const sqlSchemaTool: AgentTool = {
  name: "sql_schema",
  scope: "target",
  description:
    "List tables, columns, and row counts of the target SQLite database (readOnly). Only valid when the target is a SQLite database.",
  args: { type: "object", properties: {}, additionalProperties: false },
  async run(_args, ctx) {
    if (ctx.target.detectedFormat !== "sqlite") {
      return `Error: target format is "${ctx.target.detectedFormat ?? "unknown"}", not sqlite — sql_schema is unavailable. Use rea_tool (e.g. binary_overview, list_strings) instead.`;
    }
    let dbh: SqliteDb | null = null;
    try {
      dbh = await openTargetSqlite(ctx);
      const tables = dbh
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all() as Array<{ name: string }>;
      if (tables.length === 0) return "No user tables found in the SQLite database.";
      const validNames = new Set(tables.map((t) => t.name));
      const out: string[] = [`Tables: ${tables.length}`];
      for (const { name } of tables) {
        if (!validNames.has(name) || name.includes('"')) continue; // validated against sqlite_master
        out.push("", `## ${name}`);
        try {
          const cols = dbh.prepare(`PRAGMA table_info(${qIdent(name)})`).all() as Array<{
            cid: number;
            name: string;
            type: string;
            notnull: number;
            pk: number;
          }>;
          out.push("| cid | column | type | notnull | pk |", "|---|---|---|---|---|");
          for (const c of cols) {
            out.push(`| ${c.cid} | ${c.name} | ${c.type || "-"} | ${c.notnull} | ${c.pk} |`);
          }
          const count = dbh.prepare(`SELECT COUNT(*) AS n FROM ${qIdent(name)}`).all() as Array<{ n: number }>;
          out.push(`rows: ${count[0]?.n ?? "?"}`);
        } catch (e) {
          out.push(`(introspection failed: ${e instanceof Error ? e.message.slice(0, 120) : "error"})`);
        }
      }
      return out.join("\n");
    } catch (err) {
      return `Error reading SQLite schema: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      try {
        dbh?.close();
      } catch {
        /* ignore */
      }
    }
  },
};

const SQL_FORBIDDEN_RE =
  /\b(insert|update|delete|drop|alter|attach|detach|pragma|create|vacuum|reindex|replace)\b/i;

const sqlQueryTool: AgentTool = {
  name: "sql_query",
  scope: "target",
  description:
    "Run a read-only SELECT against the target SQLite database (max 25 rows, auto-LIMIT enforced). Only valid when the target is a SQLite database.",
  args: {
    type: "object",
    properties: {
      query: { type: "string", description: "A single SELECT statement. No semicolons, no writes." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async run(args, ctx) {
    if (ctx.target.detectedFormat !== "sqlite") {
      return `Error: target format is "${ctx.target.detectedFormat ?? "unknown"}", not sqlite — sql_query is unavailable. Use rea_tool instead.`;
    }
    const query = argStr(args, "query");
    if (!query) return "Error: 'query' is required.";
    let q = query.trim();
    if (!/^\s*select[\s\S]*$/i.test(q)) {
      return "Error: only SELECT statements are allowed.";
    }
    if (q.endsWith(";")) q = q.slice(0, -1).trim();
    if (q.includes(";")) return "Error: multiple statements are not allowed (remove the semicolon).";
    if (SQL_FORBIDDEN_RE.test(q)) {
      return "Error: forbidden keyword detected (insert/update/delete/drop/alter/attach/detach/pragma/create/vacuum/reindex/replace). SELECT only.";
    }
    // Force a LIMIT unless one is already present (ignore LIMITs inside string literals).
    const withoutLiterals = q.replace(/'(?:[^']|'')*'/g, "''");
    if (!/\blimit\b/i.test(withoutLiterals)) q = `${q} LIMIT 25`;
    let dbh: SqliteDb | null = null;
    try {
      dbh = await openTargetSqlite(ctx);
      const rows = dbh.prepare(q).all().slice(0, 25);
      return `Query OK, ${rows.length} row(s) (max 25):\n${JSON.stringify(rows, null, 1).slice(0, 5000)}`;
    } catch (err) {
      return `SQL error: ${err instanceof Error ? err.message.slice(0, 400) : String(err)}`;
    } finally {
      try {
        dbh?.close();
      } catch {
        /* ignore */
      }
    }
  },
};

// ---------------------------------------------------------------------------
// Planning (visible multi-step progress for the analyst)
// ---------------------------------------------------------------------------

export interface PlanTask {
  title: string;
  status: "pending" | "in_progress" | "done";
}

const PLAN_STATUSES = new Set(["pending", "in_progress", "done"]);

/**
 * Validate + normalize an update_plan payload. Returns null when malformed.
 * At most one step may be in_progress (later duplicates are downgraded to
 * pending) so the rendered plan always has an honest single focus.
 */
export function parsePlanTasks(args: Record<string, unknown>): PlanTask[] | null {
  const raw = args?.tasks;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 8) return null;
  const tasks: PlanTask[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const t = item as { title?: unknown; status?: unknown };
    if (typeof t.title !== "string") return null;
    const title = t.title.trim().slice(0, 160);
    if (!title) return null;
    const status =
      typeof t.status === "string" && PLAN_STATUSES.has(t.status)
        ? (t.status as PlanTask["status"])
        : "pending";
    tasks.push({ title, status });
  }
  let seenActive = false;
  return tasks.map((t) => {
    if (t.status === "in_progress") {
      if (seenActive) return { ...t, status: "pending" as const };
      seenActive = true;
    }
    return t;
  });
}

/**
 * Execute an update_plan call. Pure planning — no target, no I/O — so it is
 * also available in FREE chats (the agent.ts loop routes it here explicitly).
 */
export async function applyPlanUpdate(args: Record<string, unknown>): Promise<string> {
  const tasks = parsePlanTasks(args ?? {});
  if (!tasks) {
    return "Error: tasks must be an array of 2-8 items, each {\"title\": string, \"status\": \"pending\"|\"in_progress\"|\"done\"}. Re-emit the FULL list each time (it replaces the previous plan).";
  }
  const done = tasks.filter((t) => t.status === "done").length;
  const active = tasks.find((t) => t.status === "in_progress");
  return `Plan updated: ${tasks.length} steps (${done} done${active ? `, now working on: ${active.title}` : ""}).`;
}

const planTool: AgentTool = {
  name: "update_plan",
  scope: "any",
  description:
    "Maintain a visible task plan for multi-step work. Call FIRST with 2-8 concrete steps (first in_progress, rest pending), then re-emit the FULL updated list whenever a step starts or finishes. The plan renders live in the UI as a checklist.",
  args: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        description: "2-8 steps, in execution order.",
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short imperative step, e.g. 'Extract strings'." },
            status: { type: "string", enum: ["pending", "in_progress", "done"] },
          },
          required: ["title", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["tasks"],
    additionalProperties: false,
  },
  async run(args) {
    return applyPlanUpdate(args ?? {});
  },
};

// ---------------------------------------------------------------------------
// Chat workspace tools — REAL sandboxed file read/write + command execution
// ---------------------------------------------------------------------------

/**
 * Per-chat-session sandboxed workspace under storage/workspaces/chat-<sessionId>/
 * (same root and the same battle-tested jail as project workspaces:
 * isPathInside path prison, no-shell tokenizer, allowlisted binaries, hard
 * timeout, scrubbed env, output caps). This closes the round-33 gap for real:
 * the calculator/Jest class of request ("create a project and run the tests")
 * no longer must be refused — the model can genuinely create files and run
 * them, and every result is a genuine platform execution.
 *
 * Chat-mode guards (stricter than project workspaces) are enforced inside
 * builder.runCommand: sed/awk/find/tar/git/env blocked (script/transport
 * escape vectors), interpreter eval flags blocked (node -e, python3 -c),
 * absolute-path and ".." arguments blocked. Honest limits (documented in the
 * security posture, not hidden): the jail is process-level, NOT an OS
 * namespace jail — workspace-resident code run by an interpreter executes
 * with server privileges; env is scrubbed (no secrets), HOME is the
 * workspace, and the deployment model is self-hosted single-tenant.
 */

/** Chat workspace command cap — leaves headroom under CHAT_TOOL_TIMEOUT_MS. */
const WORKSPACE_RUN_TIMEOUT_MS = 55_000;

/** Workspace dir key for a chat session: chat-<sessionId>. */
function chatWorkspaceKey(sessionId: string): string {
  return `chat-${sessionId}`;
}

const WORKSPACE_TOOL_NAMES = [
  "workspace_list",
  "workspace_read",
  "workspace_write",
  "workspace_run",
] as const;

export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

function workspaceErr(context: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `Error: ${context}: ${msg.slice(0, 400)}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated after ${max} chars]` : text;
}

/**
 * Execute a chat-workspace tool for a session. Every result is an honest
 * string: a REAL outcome (bytes written, exit code, stdout/stderr), a
 * precise Error: failure (missing file, cap exceeded, sandbox rejection —
 * the command did not run), or never a fabrication. Throws nothing except
 * on programmer error; callers still wrap with runToolWithDedup, which
 * converts throws to error strings.
 */
export async function runWorkspaceTool(
  name: string,
  args: Record<string, unknown>,
  session: { sessionId: string }
): Promise<string> {
  if (!session?.sessionId) {
    return `Error: workspace tools require a chat session context — they are unavailable outside chat conversations.`;
  }
  const key = chatWorkspaceKey(session.sessionId);

  switch (name) {
    case "workspace_list": {
      const sub = argStr(args, "sub") ?? "";
      let entries;
      try {
        entries = await workspaceListFiles(key, sub);
      } catch (err) {
        return workspaceErr(`cannot list "${sub || "."}" in the workspace (paths must stay inside it)`, err);
      }
      // Honest usage line: the model sees the REAL disk state and the quota,
      // so it can plan before a refused write teaches it the hard way.
      const usage = await workspaceDiskUsage(key);
      const usageLine = `Workspace usage: ${usage.files} file(s), ${fmtBytes(usage.bytes)}${usage.truncated ? "+" : ""} of ${fmtBytes(CHAT_WORKSPACE_QUOTA_BYTES)} quota.`;
      if (entries.length === 0) {
        return `Workspace listing for "${sub || "."}": empty. ${usageLine}${sub ? "" : " Create files with workspace_write — writes are real and land on disk."}`;
      }
      const rows = entries
        .slice(0, 100)
        .map((e) => `| ${e.path} | ${e.type}${e.sizeBytes !== undefined ? ` (${fmtBytes(e.sizeBytes)})` : ""} |`);
      return `Workspace listing for "${sub || "."}" — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}. ${usageLine}\n\n| path | type |\n|---|---|\n${rows.join("\n")}`;
    }

    case "workspace_read": {
      const rel = argStr(args, "path");
      if (!rel) return "Error: 'path' is required (workspace-relative, e.g. \"calculator.js\"). List files with workspace_list.";
      try {
        const content = await workspaceReadFile(key, rel);
        return `# workspace_read — OBSERVED file content\n- path: ${rel}\n- bytes: ${Buffer.byteLength(content, "utf8")}\n\n${truncate(content, 5500)}`;
      } catch (err) {
        return workspaceErr(`cannot read "${rel}" from the workspace (1 MB read cap; paths must stay inside it)`, err);
      }
    }

    case "workspace_write": {
      const rel = argStr(args, "path");
      if (!rel) return "Error: 'path' is required (workspace-relative, e.g. \"calculator.js\").";
      const content = args?.["content"];
      if (typeof content !== "string" || content.length === 0) {
        return "Error: 'content' is required (the full file content as a string).";
      }
      try {
        const r = await workspaceWriteFile(key, rel, content, {
          audit: false,
          quotaBytes: CHAT_WORKSPACE_QUOTA_BYTES,
        });
        // Post-write usage is best-effort reporting — the write itself already
        // succeeded and is attested by r.bytes; a failed usage walk must not
        // turn an OBSERVED write into an error.
        let usageNote = "";
        try {
          const usage = await workspaceDiskUsage(key);
          usageNote = `\n- workspace now: ${usage.files} file(s), ${fmtBytes(usage.bytes)} of ${fmtBytes(CHAT_WORKSPACE_QUOTA_BYTES)} quota`;
        } catch {
          /* usage reporting is best-effort */
        }
        return `# workspace_write — OBSERVED write\n- path: ${r.path}\n- bytes written: ${r.bytes}\n- ${r.created ? "created new file" : "overwrote existing file"}${usageNote}\nThe file is now on disk in this session's workspace (verify with workspace_read or workspace_list).`;
      } catch (err) {
        return workspaceErr(
          `write failed for "${rel}" (512 KB per-file cap, ${fmtBytes(CHAT_WORKSPACE_QUOTA_BYTES)} per-workspace quota; paths must stay inside the workspace)`,
          err
        );
      }
    }

    case "workspace_run": {
      const command = argStr(args, "command");
      if (!command) {
        return `Error: 'command' is required, e.g. {"command":"node calculator.js"}. One allowlisted binary per call, no shell (no pipes/globs/redirection).`;
      }
      const started = Date.now();
      const r = await workspaceRunCommand(key, command, WORKSPACE_RUN_TIMEOUT_MS, { chatMode: true });
      if (r.blocked) {
        // The command did NOT run — say exactly why (honest failure, never
        // fabricated output). tool-status classifies "Error:"-prefixed
        // results as failed, which is the honest state: processed, denied.
        return `Error: command NOT executed — ${r.stderr.slice(0, 500)}`;
      }
      const head = [
        // Honest classification: a non-zero exit is a FAILED execution — the
        // command genuinely ran and failed, and the result carries the real
        // stderr below. "Error:"-prefixing keeps the UI/state machine honest
        // (tool-status classifies it failed, never a green EXECUTED row).
        r.exitCode === 0
          ? `# workspace_run — OBSERVED execution`
          : `Error: command exited with code ${r.exitCode}${r.timedOut ? ` (killed: exceeded the ${WORKSPACE_RUN_TIMEOUT_MS / 1000}s cap)` : ""} — OBSERVED execution of the workspace command:`,
        `- command: ${command}`,
        `- exit code: ${r.exitCode}`,
        `- duration: ${r.durationMs}ms`,
      ].join("\n");
      return `${head}\n\n## stdout\n${r.stdout.trim() ? truncate(r.stdout.trim(), 4000) : "(empty)"}\n\n## stderr\n${r.stderr.trim() ? truncate(r.stderr.trim(), 2500) : "(empty)"}`;
    }

    case "workspace_verify": {
      const command = argStr(args, "command");
      if (!command) {
        return `Error: 'command' is required, e.g. {"command":"node test.js"} or {"command":"npm test"}. It runs under the SAME sandbox rules as workspace_run.`;
      }
      const name = (argStr(args, "name") ?? command).slice(0, 100);
      const history = await loadVerifyHistory(key);
      const previousAny = [...history].reverse().find((r) => r.command === command);

      const r = await workspaceRunCommand(key, command, WORKSPACE_RUN_TIMEOUT_MS, { chatMode: true });
      const verdict: VerificationRecord["verdict"] = r.blocked
        ? "COULD_NOT_RUN"
        : r.timedOut
          ? "TIMED_OUT"
          : r.exitCode === 0
            ? "PASSED"
            : "FAILED";
      const record: VerificationRecord = {
        ts: new Date().toISOString(),
        name,
        command: command.slice(0, 200),
        exitCode: r.blocked ? null : r.exitCode,
        verdict,
        durationMs: r.durationMs,
      };
      let recordNote = "verification record NOT persisted";
      try {
        await saveVerifyHistory(key, [...history, record]);
        recordNote = `recorded as run #${history.length + 1} in ${VERIFY_HISTORY_FILE} (regression detection compares against earlier runs of the same command)`;
      } catch {
        /* persistence failed (quota/path) — the verdict below is still REAL */
      }

      if (r.blocked) {
        return `Error: verification command NOT executed — ${r.stderr.slice(0, 400)}\n\nVerdict: COULD NOT RUN (recorded). No pass/fail claim is possible for a command the sandbox refused — never report this as a passing or failing test.`;
      }

      const notes: string[] = [];
      if (previousAny) {
        if (previousAny.verdict === "PASSED" && verdict === "FAILED") {
          notes.push(`REGRESSION: this command PASSED at ${previousAny.ts} (exit 0) and FAILS now (exit ${r.exitCode}).`);
        }
        if (previousAny.verdict === "FAILED" && verdict === "PASSED") {
          notes.push(`FIX VERIFIED: this command FAILED at ${previousAny.ts} and passes now (exit 0).`);
        }
      }

      // Honest classification identical to workspace_run: "Error:"-prefixed
      // results classify as FAILED in the UI; only a real exit 0 is a pass.
      const head =
        verdict === "PASSED"
          ? `# workspace_verify — PASSED (executed)`
          : verdict === "FAILED"
            ? `Error: workspace_verify — FAILED (executed)`
            : `Error: workspace_verify — TIMED OUT (killed: exceeded the ${WORKSPACE_RUN_TIMEOUT_MS / 1000}s cap)`;
      const body = [
        `- verification: ${name}`,
        `- command: ${command}`,
        `- exit code: ${r.exitCode}`,
        `- duration: ${r.durationMs}ms`,
        `- ${recordNote}`,
        ...(notes.length ? ["", ...notes.map((n) => `⚠️ ${n}`)] : []),
      ].join("\n");
      return `${head}\n${body}\n\n## stdout\n${r.stdout.trim() ? truncate(r.stdout.trim(), 3500) : "(empty)"}\n\n## stderr\n${r.stderr.trim() ? truncate(r.stderr.trim(), 2500) : "(empty)"}`;
    }

    default:
      return `Error: unknown workspace tool "${name}". Workspace tools: ${WORKSPACE_TOOL_NAMES.join(", ")}.`;
  }
}

// ---------------------------------------------------------------------------
// workspace_verify — the chat-side Verification Agent: run a REAL test command,
// record an honest verdict, detect regressions against earlier runs.
// ---------------------------------------------------------------------------

const VERIFY_HISTORY_FILE = ".rea/verifications.json";
const VERIFY_HISTORY_MAX = 50;

export interface VerificationRecord {
  ts: string;
  name: string;
  command: string;
  /** null = the command never ran (sandbox refusal) — no pass/fail exists. */
  exitCode: number | null;
  verdict: "PASSED" | "FAILED" | "TIMED_OUT" | "COULD_NOT_RUN";
  durationMs: number;
}

async function loadVerifyHistory(key: string): Promise<VerificationRecord[]> {
  try {
    const raw = await workspaceReadFile(key, VERIFY_HISTORY_FILE);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is VerificationRecord =>
        Boolean(r) && typeof r === "object" && "verdict" in (r as Record<string, unknown>)
    );
  } catch {
    return []; // no history yet (or unreadable) — an empty record is honest
  }
}

async function saveVerifyHistory(key: string, records: VerificationRecord[]): Promise<void> {
  await workspaceWriteFile(key, VERIFY_HISTORY_FILE, JSON.stringify(records.slice(-VERIFY_HISTORY_MAX), null, 2), {
    audit: false,
    quotaBytes: CHAT_WORKSPACE_QUOTA_BYTES,
  });
}

function workspaceRun(name: WorkspaceToolName | "workspace_verify") {
  return async (args: Record<string, unknown>, ctx: AgentToolContext) =>
    runWorkspaceTool(name, args ?? {}, { sessionId: ctx.sessionId ?? "" });
}

const workspaceListTool: AgentTool = {
  name: "workspace_list",
  scope: "any",
  description:
    "List files and directories in this chat's sandboxed workspace (a per-session directory on the platform server). Every chat session gets its own isolated workspace; paths are workspace-relative. Use it to verify what actually exists before claiming it.",
  args: {
    type: "object",
    properties: {
      sub: { type: "string", description: "Optional subdirectory to list (workspace-relative, default: root)." },
    },
    additionalProperties: false,
  },
  run: workspaceRun("workspace_list"),
};

const workspaceReadTool: AgentTool = {
  name: "workspace_read",
  scope: "any",
  description:
    "Read a file from this chat's sandboxed workspace and return its REAL content (1 MB cap). Paths are workspace-relative; nothing outside the workspace is readable. Use it to verify a write or inspect a file you or a command created.",
  args: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path, e.g. \"calculator.js\" or \"src/index.js\"." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  run: workspaceRun("workspace_read"),
};

const workspaceWriteTool: AgentTool = {
  name: "workspace_write",
  scope: "any",
  description:
    "Create or overwrite a file in this chat's sandboxed workspace — the write is REAL (result reports the actual byte count written). 512 KB per-file cap and an 8 MB per-workspace disk quota (over-quota writes are refused with nothing written), workspace-relative paths only, parent directories created automatically. Write code/config/docs here, then execute it with workspace_run.",
  args: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path, e.g. \"calculator.js\"." },
      content: { type: "string", description: "The FULL file content (UTF-8 text)." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  run: workspaceRun("workspace_write"),
};

const workspaceRunTool: AgentTool = {
  name: "workspace_run",
  scope: "any",
  description: `Execute ONE allowlisted command inside this chat's sandboxed workspace (cwd = the workspace) and return the REAL exit code, stdout and stderr. No shell: pipes, redirection, \`*\` globs and \`\$VAR\` interpolation are NOT interpreted — pass plain arguments. Blocked: non-allowlisted binaries, sed/awk/find/tar/git/env, absolute paths, ".." traversal, inline-eval flags (node -e, python3 -c); commands are also refused while the workspace sits at its 8 MB disk quota. Allowed binaries: ${chatCommandAllowlist().join(", ")}. To run code, workspace_write it to a file first, then run it as a file. Each call is capped at ${WORKSPACE_RUN_TIMEOUT_MS / 1000}s.`,
  args: {
    type: "object",
    properties: {
      command: { type: "string", description: 'One command with plain arguments, e.g. "node calculator.js" or "npm test".' },
    },
    required: ["command"],
    additionalProperties: false,
  },
  run: workspaceRun("workspace_run"),
};

// ---------------------------------------------------------------------------
// web_research — the chat-side Research Agent: a REAL platform web search plus
// SSRF-guarded page retrieval, with every source honestly labeled.
// ---------------------------------------------------------------------------

const RESEARCH_MAX_SEED_URLS = 5;
const RESEARCH_MAX_FETCHED_PAGES = 5;

interface ResearchSourceRow {
  url: string;
  title: string;
  status: "RETRIEVED" | "SEARCH-ONLY" | "INACCESSIBLE";
  httpStatus?: number;
  detail: string;
}

function renderResearchRow(s: ResearchSourceRow, i: number): string {
  return `${i + 1}. [${s.status}] **${s.title}** — ${s.url}${s.httpStatus !== undefined ? ` (HTTP ${s.httpStatus})` : ""}\n   ${s.detail}`;
}

/**
 * Multi-source research for the chat agent: search the real web, fetch the
 * top pages through the SAME SSRF-guarded Explorer as explore_url, and return
 * an evidence block whose integrity rules make fabricated citations visible:
 * only RETRIEVED rows were actually fetched; SEARCH-ONLY rows are unverified
 * snippets; INACCESSIBLE rows carry the real failure reason. Nothing here is
 * ever simulated — a search failure degrades to an honest Error.
 */
export async function runWebResearchTool(args: Record<string, unknown>): Promise<string> {
  const query = argStr(args, "query");
  if (!query) {
    return `Error: 'query' is required, e.g. {"query":"WebAssembly binary format specification"}.`;
  }
  if (query.length > 500) return "Error: 'query' exceeds 500 characters.";
  const seedUrls = Array.isArray(args?.["urls"])
    ? (args["urls"] as unknown[]).filter((u): u is string => typeof u === "string").slice(0, RESEARCH_MAX_SEED_URLS)
    : [];
  const rawFetch = typeof args?.["fetch_pages"] === "number" ? (args["fetch_pages"] as number) : 3;
  const fetchCount = Math.min(Math.max(Math.round(rawFetch), 1), RESEARCH_MAX_FETCHED_PAGES);

  // 1. Real platform web search (z-ai SDK). Failure is honest, never padded.
  let searchResults: Array<{ name: string; url: string; snippet: string }> = [];
  let searchError: string | null = null;
  try {
    searchResults = await platformWebSearch(query, 8);
  } catch (err) {
    searchError = err instanceof Error ? err.message : String(err);
  }
  if (!searchResults.length && !seedUrls.length) {
    return searchError
      ? `Error: web search unavailable (${searchError.slice(0, 200)}) and no seed URLs were provided. NO sources were retrieved — nothing can be cited. Try explore_url for a specific page.`
      : `Error: the web search returned no results for "${query.slice(0, 120)}" and no seed URLs were provided. NO sources were retrieved — nothing can be cited.`;
  }

  // 2. Pages to FETCH now: seed URLs first, then top search hits (deduped),
  //    capped at fetch_pages. Everything else stays SEARCH-ONLY.
  const fetchList: string[] = [];
  for (const u of [...seedUrls, ...searchResults.map((r) => r.url)]) {
    if (fetchList.length >= fetchCount) break;
    if (!fetchList.includes(u)) fetchList.push(u);
  }
  const fetchSet = new Set(fetchList);

  // 3. Fetch in parallel through the SSRF-guarded Explorer. Every failure is
  //    recorded as INACCESSIBLE with the real reason (SSRF refusal, DNS,
  //    timeout, HTTP error status) — never dropped, never guessed.
  const probed = await Promise.all(
    [...fetchSet].map(async (url): Promise<ResearchSourceRow> => {
      try {
        const r = await probeUrl(url, { includeText: true, timeoutMs: PROBE_TIMEOUT_MS });
        const ok = r.status >= 200 && r.status < 400;
        return {
          url: r.finalUrl,
          title: (r.title || "(no title)").slice(0, 120),
          status: ok ? "RETRIEVED" : "INACCESSIBLE",
          httpStatus: r.status,
          detail: (r.textExcerpt || `HTTP ${r.status} ${r.contentType || ""}`.trim()).slice(0, 350),
        };
      } catch (err) {
        const reason =
          err instanceof BlockedUrlError
            ? `refused by the SSRF guard: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        return { url, title: "(unreachable)", status: "INACCESSIBLE", detail: reason.slice(0, 220) };
      }
    })
  );

  const searchRows: ResearchSourceRow[] = searchResults
    .filter((r) => !fetchSet.has(r.url))
    .slice(0, 8)
    .map((r) => ({ url: r.url, title: r.name.slice(0, 120), status: "SEARCH-ONLY" as const, detail: r.snippet.slice(0, 300) }));

  const lines: string[] = [
    "# web_research — OBSERVED sources",
    `- query: ${query}`,
    `- search: ${searchError ? `UNAVAILABLE (${searchError.slice(0, 120)})` : `${searchResults.length} result(s)`}`,
    `- fetched now: ${probed.length} page(s) through the SSRF-guarded Explorer`,
    "",
    "## Pages retrieved THIS call (content actually fetched — safe to cite as verified)",
    ...(probed.length ? probed.map(renderResearchRow) : ["(none)"]),
    "",
    "## Search results NOT fetched (snippet-only — UNVERIFIED, do not cite as verified)",
    ...(searchRows.length ? searchRows.map(renderResearchRow) : ["(none)"]),
    "",
    "## Integrity rules for your report",
    "- Cite a source as verified ONLY if it appears under \"retrieved THIS call\" — and quote or paraphrase only what its row shows.",
    "- SEARCH-ONLY rows are unverified snippets: label them as such, or fetch the page with explore_url first.",
    "- Report INACCESSIBLE rows as inaccessible (with the given reason) — never guess their content.",
    "- NEVER cite a URL that does not appear in this result. Fabricated citations are a report-integrity violation.",
  ];
  return lines.join("\n");
}

const webResearchTool: AgentTool = {
  name: "web_research",
  scope: "any",
  description:
    "Run a REAL platform web search and fetch the top pages through the SSRF-guarded Explorer for research questions that need sources. Returns an evidence block marking every source as RETRIEVED (content fetched now — safe to cite as verified), SEARCH-ONLY (unverified snippet) or INACCESSIBLE (real failure reason). Optional seed URLs are probed too. Cite ONLY sources this tool returned; your report must distinguish verified facts from unverified snippets and inaccessible sources.",
  args: {
    type: "object",
    properties: {
      query: { type: "string", description: "The research question or search query, e.g. \"ECMAScript module resolution spec\"." },
      fetch_pages: { type: "number", description: "How many top pages to actually fetch (1-5, default 3)." },
      urls: { type: "array", items: { type: "string" }, description: "Optional specific http(s) URLs to probe (max 5) alongside the search." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async run(args) {
    return runWebResearchTool(args ?? {});
  },
};

const workspaceVerifyTool: AgentTool = {
  name: "workspace_verify",
  scope: "any",
  dedup: false,
  description: `Run a REAL verification command (a test suite) inside this chat's sandboxed workspace — same rules as workspace_run (allowlisted binaries, no shell, 55s cap) — and record an honest verdict: PASSED (executed, exit 0), FAILED (executed, non-zero), TIMED OUT, or COULD NOT RUN (sandbox refusal — never claim a result). Every run is persisted to ${VERIFY_HISTORY_FILE}; rerunning the same command detects REGRESSIONS (passed before, fails now) and FIX VERIFIED transitions (failed before, passes now). A fix counts as verified ONLY after a real passing rerun through this tool.`,
  args: {
    type: "object",
    properties: {
      command: { type: "string", description: 'One verification command with plain arguments, e.g. "node test.js" or "npm test".' },
      name: { type: "string", description: "Optional short label for this verification, e.g. \"calculator tests\"." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  run: workspaceRun("workspace_verify"),
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const AGENT_TOOLS: AgentTool[] = [
  planTool,
  targetInfoTool,
  listFindingsTool,
  getEvidenceTool,
  readStringsTool,
  readHexTool,
  reaTool,
  sqlSchemaTool,
  sqlQueryTool,
  exploreUrlTool,
  webResearchTool,
  workspaceListTool,
  workspaceReadTool,
  workspaceWriteTool,
  workspaceRunTool,
  workspaceVerifyTool,
];

/**
 * Tools routable in a FREE chat (no target attached) — DERIVED from the
 * registry scope flags, never hand-maintained: advertisement (prompts),
 * routing (the loop) and refusal wording all read this list, so a tool
 * cannot be advertised but unroutable, or routable but unadvertised.
 */
export const FREE_CHAT_TOOL_NAMES: string[] = AGENT_TOOLS.filter(
  (t) => t.scope === "any"
).map((t) => t.name);

// ---------------------------------------------------------------------------
// Native tool schemas (OpenAI function-calling format)
// ---------------------------------------------------------------------------

/**
 * Convert a registry tool into the OpenAI function-calling schema consumed
 * by the native tool-calling path (`callLLMTools`). The registry's `args`
 * object IS the JSON Schema for the parameters — advertisement (system
 * prompt catalog) and the native wire format derive from the same source,
 * so the model can never be shown a different tool surface per protocol.
 */
export function toNativeSchema(tool: AgentTool): ToolSchema {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.args,
    },
  };
}

/**
 * Native schemas for the tools a chat can actually route — ALL registry
 * tools for a target chat, only "any"-scoped tools for a FREE chat. The
 * model only ever sees tool schemas for tools the loop will genuinely
 * execute (advertisement parity with the text protocol's prompt catalog,
 * derived from the same registry, never hand-maintained).
 */
export function nativeToolSchemas(scope: "target" | "free"): ToolSchema[] {
  return AGENT_TOOLS.filter((t) => (scope === "target" ? true : t.scope === "any")).map(
    toNativeSchema
  );
}

/**
 * Dispatch an "any"-scoped tool by name for the FREE-chat loop (no target
 * context exists there, so target-scoped tools never reach this).
 */
export async function runFreeChatTool(
  name: string,
  args: Record<string, unknown>,
  session: { sessionId: string }
): Promise<string> {
  if (name === "update_plan") return applyPlanUpdate(args ?? {});
  if (name === "explore_url") return runExploreUrlTool(args ?? {});
  if (name === "web_research") return runWebResearchTool(args ?? {});
  if ((WORKSPACE_TOOL_NAMES as readonly string[]).includes(name) || name === "workspace_verify") {
    return runWorkspaceTool(name, args ?? {}, session);
  }
  return `Error: "${name}" cannot be routed in a free chat. Available here: ${FREE_CHAT_TOOL_NAMES.join(", ")}.`;
}

/** Execute a registry tool; never throws — returns an error string instead. */
export async function executeAgentTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentToolContext
): Promise<string> {
  const tool = AGENT_TOOLS.find((t) => t.name === name);
  if (!tool) {
    // LLMs sometimes call a REA engine tool directly (inspect_artifact,
    // list_strings, …). Those are reachable ONLY through rea_tool — route the
    // call there transparently so the model's tool choice still works. The
    // routing keeps every guarantee: allowlist, path-key scrubbing, forced
    // target binding, session open/close, output truncation.
    if (REA_ALLOWLIST.has(name)) {
      return executeAgentTool(
        "rea_tool",
        { tool: name, args: args ?? {} },
        ctx
      );
    }
    return `Error: unknown tool "${name}". Available tools: ${AGENT_TOOLS.map((t) => t.name).join(", ")}. REA engine tools (inspect_artifact, list_strings, …) run via the rea_tool wrapper.`;
  }
  // Stateful tools (dedup:false — workspace_write/workspace_run) bypass the
  // retry-dedup cache: re-executing them IS the honest behavior, both across
  // a turn retry and after the workspace changed between turns.
  return runToolWithDedup(
    tool.dedup === false ? undefined : ctx.sessionId,
    name,
    args ?? {},
    () => tool.run(args ?? {}, ctx)
  );
}

/**
 * Retry dedup shared by ALL tool surfaces (registry tools AND the free-chat
 * direct paths, which bypass the registry). An identical call (same session
 * + tool + args) that already succeeded within the TTL returns its prior
 * result with an explicit annotation instead of executing again — retrying
 * an interrupted turn must not duplicate fetches, queries or extractions.
 */
export async function runToolWithDedup(
  sessionId: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
  run: () => Promise<string>
): Promise<string> {
  const key = sessionId ? toolDedupKey(sessionId, toolName, args) : null;
  if (key) {
    const cached = getCachedToolResult(key);
    if (cached !== null) {
      return `${cached}\n\n(reused from the earlier identical execution in this session — NOT re-executed; identical calls within 10 minutes are deduplicated across retries)`;
    }
  }
  let result: string;
  try {
    result = (await run()).slice(0, TOOL_RESULT_MAX_CHARS);
  } catch (err) {
    // The tool-execution contract: never throw — return an error string.
    return `Error running tool ${toolName}: ${err instanceof Error ? err.message : String(err)}`.slice(
      0,
      TOOL_RESULT_MAX_CHARS
    );
  }
  if (key) storeToolResult(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// Retry-dedup cache (session-scoped, in-memory)
// ---------------------------------------------------------------------------

const TOOL_DEDUP_TTL_MS = 10 * 60_000;
const TOOL_DEDUP_MAX_ENTRIES = 200;
const toolDedupCache = new Map<string, { result: string; at: number }>();

/** Stable, order-independent key: sorted object keys, arrays in order. */
export function toolDedupKey(
  sessionId: string,
  tool: string,
  args: Record<string, unknown>
): string {
  const stable = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
        .join(",")}}`;
    }
    return JSON.stringify(v ?? null);
  };
  return `${sessionId}|${tool}|${stable(args)}`;
}

function getCachedToolResult(key: string): string | null {
  const hit = toolDedupCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TOOL_DEDUP_TTL_MS) {
    toolDedupCache.delete(key);
    return null;
  }
  return hit.result;
}

/** Store a result for dedup. Failures are NEVER cached — a transient error
 * must stay retryable — and neither are refusals (a tool that was refused is
 * not a successful execution, so a later retry must not read "NOT
 * re-executed" from a refusal). */
function storeToolResult(key: string, result: string): void {
  if (
    /^error\b/i.test(result) ||
    result.slice(0, 100).includes("isError: true") ||
    result.startsWith(TOOL_REFUSAL_MARKER)
  )
    return;
  if (toolDedupCache.size >= TOOL_DEDUP_MAX_ENTRIES) {
    const oldest = toolDedupCache.keys().next().value;
    if (oldest !== undefined) toolDedupCache.delete(oldest);
  }
  toolDedupCache.set(key, { result, at: Date.now() });
}

// ---------------------------------------------------------------------------
// Target context (injected as the first user message of every loop)
// ---------------------------------------------------------------------------

export async function buildTargetContext(target: Target): Promise<string> {
  const [findings, evidence, latestRun] = await Promise.all([
    db.finding.findMany({
      where: { run: { targetId: target.id } },
      orderBy: { createdAt: "desc" },
      take: 40,
    }),
    db.evidence.findMany({
      where: { run: { targetId: target.id } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
    db.analysisRun.findFirst({
      where: { targetId: target.id },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const findingsByType: Record<string, Array<{ name: string; address?: string; size?: number }>> = {};
  for (const f of findings) {
    (findingsByType[f.type] ??= []).push({
      name: f.name.slice(0, 120),
      address: f.address ?? undefined,
      size: f.sizeBytes ?? undefined,
    });
  }

  const context = {
    target: {
      id: target.id,
      name: target.originalName,
      sizeBytes: target.sizeBytes,
      sha256: target.sha256,
      mimeType: target.mimeType ?? undefined,
      detectedFormat: target.detectedFormat ?? "unknown",
      formatFamily: target.formatFamily ?? "unknown",
      status: target.status,
      summary: target.summary ?? undefined,
      uploadedAt: target.createdAt.toISOString(),
      note: "The file lives in platform storage; tools operate on it automatically. Never ask for or supply paths.",
    },
    latestRun: latestRun
      ? {
          id: latestRun.id,
          status: latestRun.status,
          goal: latestRun.goal ?? undefined,
          engine: latestRun.engine,
          currentStep: latestRun.currentStep ?? undefined,
          durationMs: latestRun.durationMs ?? undefined,
          error: latestRun.error ?? undefined,
          createdAt: latestRun.createdAt.toISOString(),
        }
      : null,
    findingsByType,
    recentEvidence: evidence.map((e) => ({
      operation: e.operation ?? e.kind,
      kind: e.kind,
      subject: e.subjectName ?? undefined,
      confidence: e.confidence ?? undefined,
      snippet: e.payload.slice(0, 300),
    })),
  };

  return JSON.stringify(context, null, 2);
}
