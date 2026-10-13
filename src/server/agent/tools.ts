import { promises as fs } from "fs";
import path from "path";
import { db } from "@/lib/db";
import { rea } from "@/server/engine/rea-bridge";
import { CHAT_TOOL_TIMEOUT_MS } from "@/lib/security";
// Shared strings helper owned by task 2-a (use as-is): cache-first extraction
// against storage/uploads/<targetId>/strings-cache.json.
import { getStringsForTarget } from "@/server/engine/strings";
import type { Target } from "@prisma/client";

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
const PATH_KEY_RE = /path|file|directory|destination|target/i;

export interface AgentToolContext {
  target: Target;
  userId: string;
}

export interface AgentTool {
  name: string;
  description: string;
  /** JSON-schema-ish description of accepted args (for the system prompt). */
  args: Record<string, unknown>;
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

const reaTool: AgentTool = {
  name: "rea_tool",
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
      const res = await rea.withTarget(abs, () =>
        rea.callTool(tool, { ...cleanArgs, path: abs }, CHAT_TOOL_TIMEOUT_MS)
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
  /\b(insert|update|delete|drop|alter|attach|detach|pragma|create|vacuum|reindex)\b/i;

const sqlQueryTool: AgentTool = {
  name: "sql_query",
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
      return "Error: forbidden keyword detected (insert/update/delete/drop/alter/attach/detach/pragma/create/vacuum/reindex). SELECT only.";
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
// Registry
// ---------------------------------------------------------------------------

export const AGENT_TOOLS: AgentTool[] = [
  targetInfoTool,
  listFindingsTool,
  getEvidenceTool,
  readStringsTool,
  readHexTool,
  reaTool,
  sqlSchemaTool,
  sqlQueryTool,
];

/** Execute a registry tool; never throws — returns an error string instead. */
export async function executeAgentTool(
  name: string,
  args: Record<string, unknown>,
  ctx: AgentToolContext
): Promise<string> {
  const tool = AGENT_TOOLS.find((t) => t.name === name);
  if (!tool) {
    return `Error: unknown tool "${name}". Available tools: ${AGENT_TOOLS.map((t) => t.name).join(", ")}.`;
  }
  try {
    const result = await tool.run(args ?? {}, ctx);
    return result.slice(0, TOOL_RESULT_MAX_CHARS);
  } catch (err) {
    return `Error running tool ${name}: ${err instanceof Error ? err.message : String(err)}`.slice(
      0,
      TOOL_RESULT_MAX_CHARS
    );
  }
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
