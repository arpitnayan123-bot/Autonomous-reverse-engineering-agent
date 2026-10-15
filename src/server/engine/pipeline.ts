import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { db } from "@/lib/db";
import { detectFormat } from "@/lib/formats";
import { area, type McpToolDef } from "@/server/engine/area-bridge";
import {
  extractStrings,
  resolveStoragePath,
  writeStringsCache,
} from "@/server/engine/strings";

/**
 * AREA analysis pipeline.
 *
 * Drives the REAL AREA engine (via the MCP bridge) per detected format,
 * records Evidence/Finding rows for every observation, and maintains
 * run progress for live UI polling.
 *
 * Engine notes (verified against rea-agents 6.4.0):
 *  - `inspect_artifact` / `extract_artifact` operate on the currently OPEN
 *    binary session and take no path argument. extract_artifact writes to an
 *    engine-chosen temp dir surfaced as `normalized_result.output_root`.
 *  - `analyze_javascript_application` takes `input_path` and needs no session.
 *  - `inspect_evm_interface` takes `{path, encoding}` and needs no session.
 *  - `inspect_plist` requires an open session despite accepting `path`.
 *  - v6.4.0 has NO sqlite/wasm tools → platform-local fallbacks/limitations.
 *  - We open/close the session manually (rather than area.withTarget) because
 *    a pipeline runs MANY tools per session; withTarget would reopen the
 *    binary for every single call. (withTarget itself is now re-entrancy
 *    safe — the chat agent's area_tool uses it.)
 */

const ENGINE_VERSION = "rea-6.4.0";
const FINDINGS_CAP_PER_TOOL = 500;
const SQLITE_TABLES_MAX = 12;

interface AreaOutcome {
  structured: unknown;
  text: string;
  isError: boolean;
}

interface PendingFinding {
  type: string;
  name: string;
  sizeBytes?: number | null;
  meta?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Start an analysis run for a target (fire-and-forget). Returns the runId. */
export async function startAnalysis(
  targetId: string,
  goal?: string
): Promise<string> {
  // Reap orphans: a server restart mid-run leaves queued/running rows that
  // would otherwise block re-analysis forever.
  await db.analysisRun.updateMany({
    where: {
      targetId,
      status: { in: ["queued", "running"] },
      createdAt: { lt: new Date(Date.now() - 30 * 60_000) },
    },
    data: {
      status: "failed",
      error: "Aborted: the platform restarted while this run was in progress.",
      finishedAt: new Date(),
    },
  });

  // Concurrency guard: never stack runs on the same target.
  const existing = await db.analysisRun.findFirst({
    where: { targetId, status: { in: ["queued", "running"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  if (existing) return existing.id;

  const run = await db.analysisRun.create({
    data: {
      targetId,
      status: "running",
      progress: 0,
      currentStep: "Preparing",
      engine: ENGINE_VERSION,
      goal: goal?.trim() ? goal.trim().slice(0, 500) : null,
    },
  });
  // Fire-and-forget: the route responds immediately; run state is polled.
  void executeRun(run.id, targetId);
  return run.id;
}

export interface RunProgress {
  id: string;
  targetId: string;
  status: string;
  progress: number;
  currentStep: string | null;
  error: string | null;
  result: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
}

export async function getRunProgress(
  runId: string
): Promise<RunProgress | null> {
  return db.analysisRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      targetId: true,
      status: true,
      progress: true,
      currentStep: true,
      error: true,
      result: true,
      createdAt: true,
      finishedAt: true,
      durationMs: true,
    },
  });
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function step(runId: string, progress: number, currentStep: string) {
  await db.analysisRun
    .update({ where: { id: runId }, data: { progress, currentStep } })
    .catch(() => undefined);
}

async function executeRun(runId: string, targetId: string): Promise<void> {
  const startedAt = Date.now();
  const toolsUsed: string[] = [];
  const limitations: string[] = [];

  try {
    await step(runId, 8, "Loading target");
    const target = await db.target.findUnique({ where: { id: targetId } });
    if (!target) throw new Error(`Target ${targetId} not found`);
    const absPath = resolveStoragePath(target.storedPath);
    if (!absPath || !existsSync(absPath)) {
      throw new Error("Uploaded file is missing from storage");
    }
    const buf = await fs.readFile(absPath);

    const detection = detectFormat(buf, target.originalName);
    const toolDefs: McpToolDef[] = await area
      .listTools()
      .catch(() => [] as McpToolDef[]);
    const toolSet = new Set(toolDefs.map((t) => t.name));
    if (toolSet.size === 0) {
      limitations.push(
        "AREA engine tool catalog unavailable — platform-local analysis only."
      );
    }

    await step(runId, 15, "Detecting format");
    await recordPlatformEvidence(
      runId,
      "platform.detect",
      "observed",
      target.originalName,
      {
        format: detection.format,
        family: detection.family,
        label: detection.label,
        confidence: detection.confidence,
        details: detection.details,
        sizeBytes: buf.length,
        sha256: target.sha256,
      }
    );
    await db.finding.create({
      data: {
        runId,
        type: "format",
        name: detection.format,
        meta: JSON.stringify({
          label: detection.label,
          family: detection.family,
          confidence: detection.confidence,
          details: detection.details,
        }),
      },
    });

    await step(runId, 25, "Extracting strings");
    const strings = extractStrings(buf, { minLength: 5, max: 8000 });
    await writeStringsCache(targetId, strings);
    await recordPlatformEvidence(
      runId,
      "platform.strings",
      "observed",
      target.originalName,
      {
        count: strings.length,
        sample: strings
          .slice(0, 20)
          .map((s) => ({ ...s, value: s.value.slice(0, 100) })),
      }
    );

    await step(runId, 40, "AREA engine analysis");
    switch (detection.format) {
      case "zip":
      case "apk":
      case "jar":
      case "gzip":
      case "tar":
        await runContainerFlow(
          runId,
          targetId,
          target.originalName,
          absPath,
          toolSet,
          toolsUsed,
          limitations
        );
        break;
      case "asar":
        await runAsarFlow(
          runId,
          target.originalName,
          absPath,
          toolSet,
          toolsUsed,
          limitations
        );
        break;
      case "javascript":
        limitations.push(
          "Single JavaScript file — upload a zipped app directory for full application analysis."
        );
        break;
      case "sqlite":
        await runSqliteFlow(
          runId,
          target.originalName,
          absPath,
          toolDefs,
          toolsUsed,
          limitations
        );
        break;
      case "evm":
        await runEvmFlow(
          runId,
          target.originalName,
          absPath,
          toolSet,
          toolsUsed,
          limitations
        );
        break;
      case "wasm":
        await runWasmFlow(runId, absPath, toolDefs, toolsUsed, limitations);
        break;
      case "plist":
      case "bplist":
        await runPlistFlow(
          runId,
          target.originalName,
          absPath,
          toolSet,
          toolsUsed,
          limitations
        );
        break;
      case "elf":
      case "pe":
      case "macho":
      case "dex":
        await runNativeFlow(
          runId,
          target.originalName,
          absPath,
          toolSet,
          toolsUsed,
          limitations
        );
        break;
      default:
        // text / json / unknown / script / solidity / pcap / pdf / png …
        limitations.push(
          `Format '${detection.format}' has no dedicated AREA tool plan; platform strings/hex analysis only.`
        );
        break;
    }

    await step(runId, 92, "Finalizing");
    const findingsCount = await db.finding.count({ where: { runId } });
    const evidenceCount = await db.evidence.count({ where: { runId } });
    const durationMs = Date.now() - startedAt;
    const summary = `${detection.label} — ${toolsUsed.length} AREA tool call${toolsUsed.length === 1 ? "" : "s"}, ${findingsCount} finding${findingsCount === 1 ? "" : "s"}, ${evidenceCount} evidence record${evidenceCount === 1 ? "" : "s"}${limitations.length > 0 ? `; ${limitations.length} limitation${limitations.length === 1 ? "" : "s"}` : ""}`;

    await db.analysisRun.update({
      where: { id: runId },
      data: {
        status: "completed",
        progress: 100,
        currentStep: "Done",
        durationMs,
        finishedAt: new Date(),
        engineTools: JSON.stringify(toolsUsed),
        result: JSON.stringify({
          toolsUsed,
          findingsCount,
          evidenceCount,
          limitations,
        }),
      },
    });
    await db.target
      .update({
        where: { id: targetId },
        data: { status: "analyzed", summary },
      })
      .catch(() => undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startedAt;
    await db.analysisRun
      .update({
        where: { id: runId },
        data: {
          status: "failed",
          error: message.slice(0, 1000),
          currentStep: "Failed",
          finishedAt: new Date(),
          durationMs,
        },
      })
      .catch(() => undefined);
    await db.target
      .update({ where: { id: targetId }, data: { status: "failed" } })
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Format flows
// ---------------------------------------------------------------------------

async function closeSession(
  runId: string,
  toolsUsed: string[]
): Promise<void> {
  try {
    const outcome = await area.callTool("close_binary", {}, 15_000);
    await recordReaEvidence(
      "close_binary",
      outcome,
      runId,
      "",
      toolsUsed
    );
  } catch {
    /* session already gone */
  }
}

async function openSession(
  runId: string,
  absPath: string,
  toolsUsed: string[],
  limitations: string[]
): Promise<boolean> {
  try {
    const open = await area.callTool("open_binary", { path: absPath }, 60_000);
    await recordReaEvidence("open_binary", open, runId, "", toolsUsed);
    return !open.isError;
  } catch (err) {
    limitations.push(
      `open_binary threw: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
}

/** zip/apk/jar/gzip/tar: open → inspect_artifact → extract_artifact → optional JS app analysis. */
async function runContainerFlow(
  runId: string,
  targetId: string,
  subjectName: string,
  absPath: string,
  toolSet: Set<string>,
  toolsUsed: string[],
  limitations: string[]
): Promise<void> {
  if (!toolSet.has("inspect_artifact")) {
    limitations.push("AREA inspect_artifact is not in the engine catalog.");
    return;
  }
  if (!(await openSession(runId, absPath, toolsUsed, limitations))) {
    limitations.push("AREA could not open the artifact (open_binary failed).");
    await closeSession(runId, toolsUsed);
    return;
  }
  try {
    const ins = await area.callTool("inspect_artifact", {});
    await recordReaEvidence("inspect_artifact", ins, runId, subjectName, toolsUsed);
    await storeToolFindings("inspect_artifact", ins, runId);
    if (ins.isError) {
      limitations.push(`inspect_artifact failed: ${firstLine(ins.text)}`);
      return;
    }
    if (!toolSet.has("extract_artifact")) {
      limitations.push("AREA extract_artifact is not in the engine catalog.");
      return;
    }
    const ext = await area.callTool("extract_artifact", {});
    await recordReaEvidence("extract_artifact", ext, runId, subjectName, toolsUsed);
    await storeToolFindings("extract_artifact", ext, runId);
    if (ext.isError) {
      limitations.push(
        `extract_artifact failed (recorded as limitation): ${firstLine(ext.text)}`
      );
      return;
    }
    const outputRoot = deepGet(ext.structured, [
      "normalized_result",
      "output_root",
    ]);
    if (typeof outputRoot !== "string" || !existsSync(outputRoot)) {
      limitations.push(
        "extract_artifact returned no materialized output_root; extraction not available for JS analysis."
      );
      return;
    }
    const dest = path.join(process.cwd(), "storage", "extract", targetId);
    await fs.rm(dest, { recursive: true, force: true });
    await fs.mkdir(dest, { recursive: true });
    await fs.cp(outputRoot, dest, { recursive: true });
    const appRoot = await findAppRoot(dest);
    if (!appRoot) return; // no JS application detected — that's fine
    if (!toolSet.has("analyze_javascript_application")) {
      limitations.push(
        "JavaScript application detected but analyze_javascript_application is not in the engine catalog."
      );
      return;
    }
    await step(runId, 60, "Analyzing JavaScript application");
    const js = await area.callTool("analyze_javascript_application", {
      input_path: appRoot,
    });
    await recordReaEvidence(
      "analyze_javascript_application",
      js,
      runId,
      subjectName,
      toolsUsed
    );
    await storeToolFindings("analyze_javascript_application", js, runId);
    if (js.isError) {
      limitations.push(
        `analyze_javascript_application failed: ${firstLine(js.text)}`
      );
    }
  } finally {
    await closeSession(runId, toolsUsed);
  }
}

/** asar: open → inspect_artifact only. */
async function runAsarFlow(
  runId: string,
  subjectName: string,
  absPath: string,
  toolSet: Set<string>,
  toolsUsed: string[],
  limitations: string[]
): Promise<void> {
  if (!toolSet.has("inspect_artifact")) {
    limitations.push("AREA inspect_artifact is not in the engine catalog.");
    return;
  }
  if (!(await openSession(runId, absPath, toolsUsed, limitations))) {
    limitations.push("AREA could not open the ASAR archive.");
    await closeSession(runId, toolsUsed);
    return;
  }
  try {
    const ins = await area.callTool("inspect_artifact", {});
    await recordReaEvidence("inspect_artifact", ins, runId, subjectName, toolsUsed);
    await storeToolFindings("inspect_artifact", ins, runId);
    if (ins.isError) {
      limitations.push(
        `inspect_artifact failed on ASAR: ${firstLine(ins.text)}`
      );
    }
  } finally {
    await closeSession(runId, toolsUsed);
  }
}

/** sqlite: AREA catalog check first, then platform-local read-only inspector. */
async function runSqliteFlow(
  runId: string,
  subjectName: string,
  absPath: string,
  toolDefs: McpToolDef[],
  toolsUsed: string[],
  limitations: string[]
): Promise<void> {
  const areaSqlite = toolDefs.find((t) => /sqlite/i.test(t.name));
  if (areaSqlite) {
    try {
      const res = await area.callTool(areaSqlite.name, { path: absPath });
      await recordReaEvidence(areaSqlite.name, res, runId, subjectName, toolsUsed);
      await storeToolFindings(areaSqlite.name, res, runId);
      if (res.isError) {
        limitations.push(
          `AREA SQLite tool '${areaSqlite.name}' failed: ${firstLine(res.text)}`
        );
      }
    } catch (err) {
      limitations.push(
        `AREA SQLite tool '${areaSqlite.name}' threw: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return;
  }
  limitations.push(
    "No AREA SQLite tool exists in the engine catalog (v6.4.0); used the platform-local read-only SQLite inspector."
  );
  const outcome = await inspectSqliteLocal(absPath);
  await recordPlatformEvidence(
    runId,
    "platform.sqlite",
    outcome.error ? "unknown" : "observed",
    subjectName,
    outcome.error ? { error: outcome.error } : outcome.summary
  );
  if (outcome.error) {
    limitations.push(`Local SQLite inspection failed: ${outcome.error}`);
    return;
  }
  const rows = outcome.tables.slice(0, FINDINGS_CAP_PER_TOOL);
  if (rows.length > 0) {
    await db.finding.createMany({
      data: rows.map((t) => ({
        runId,
        type: "sqlite_table",
        name: t.name.slice(0, 500),
        meta: JSON.stringify({
          kind: t.kind,
          rowCount: t.rowCount,
          columnCount: t.columns.length,
          columns: t.columns.slice(0, 40),
        }),
      })),
    });
  }
}

/** evm: inspect_evm_interface with encoding=hex, retry encoding=raw. */
async function runEvmFlow(
  runId: string,
  subjectName: string,
  absPath: string,
  toolSet: Set<string>,
  toolsUsed: string[],
  limitations: string[]
): Promise<void> {
  if (!toolSet.has("inspect_evm_interface")) {
    limitations.push("AREA inspect_evm_interface is not in the engine catalog.");
    return;
  }
  const hexAttempt = await area.callTool("inspect_evm_interface", {
    path: absPath,
    encoding: "hex",
  });
  await recordReaEvidence(
    "inspect_evm_interface",
    hexAttempt,
    runId,
    subjectName,
    toolsUsed
  );
  if (!hexAttempt.isError) {
    await storeToolFindings("inspect_evm_interface", hexAttempt, runId);
    return;
  }
  limitations.push(
    `inspect_evm_interface (encoding=hex) failed: ${firstLine(hexAttempt.text)}; retrying with encoding=raw.`
  );
  const rawAttempt = await area.callTool("inspect_evm_interface", {
    path: absPath,
    encoding: "raw",
  });
  await recordReaEvidence(
    "inspect_evm_interface",
    rawAttempt,
    runId,
    subjectName,
    toolsUsed
  );
  if (!rawAttempt.isError) {
    await storeToolFindings("inspect_evm_interface", rawAttempt, runId);
  } else {
    limitations.push(
      `inspect_evm_interface (encoding=raw) also failed: ${firstLine(rawAttempt.text)}`
    );
  }
}

/** wasm: v6.4.0 ships no wasm tool → limitation evidence. */
async function runWasmFlow(
  runId: string,
  absPath: string,
  toolDefs: McpToolDef[],
  toolsUsed: string[],
  limitations: string[]
): Promise<void> {
  const wasmTool = toolDefs.find((t) => /wasm/i.test(t.name));
  if (wasmTool) {
    try {
      const res = await area.callTool(wasmTool.name, { path: absPath });
      await recordReaEvidence(wasmTool.name, res, runId, "", toolsUsed);
      await storeToolFindings(wasmTool.name, res, runId);
      if (res.isError) {
        limitations.push(
          `AREA wasm tool '${wasmTool.name}' failed: ${firstLine(res.text)}`
        );
      }
    } catch (err) {
      limitations.push(
        `AREA wasm tool '${wasmTool.name}' threw: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return;
  }
  limitations.push(
    "No WASM inspection tool exists in the AREA engine catalog (wabt unavailable on host); strings/hex analysis only."
  );
  await recordPlatformEvidence(runId, "platform.limitation", "unknown", "", {
    limitation:
      "WASM deep inspection unavailable: AREA engine v6.4.0 advertises no wasm tool and the wabt toolkit is not installed on this host.",
  });
}

/** plist/bplist: inspect_plist requires an open session. */
async function runPlistFlow(
  runId: string,
  subjectName: string,
  absPath: string,
  toolSet: Set<string>,
  toolsUsed: string[],
  limitations: string[]
): Promise<void> {
  if (!toolSet.has("inspect_plist")) {
    limitations.push("AREA inspect_plist is not in the engine catalog.");
    return;
  }
  if (!(await openSession(runId, absPath, toolsUsed, limitations))) {
    limitations.push("AREA could not open the plist file.");
    await closeSession(runId, toolsUsed);
    return;
  }
  try {
    const res = await area.callTool("inspect_plist", { path: absPath });
    await recordReaEvidence("inspect_plist", res, runId, subjectName, toolsUsed);
    await storeToolFindings("inspect_plist", res, runId);
    if (res.isError) {
      limitations.push(`inspect_plist failed: ${firstLine(res.text)}`);
    }
  } finally {
    await closeSession(runId, toolsUsed);
  }
}

/** elf/pe/macho/dex: attempt inspect_binary_layout (deep native provider), else strings/hex only. */
async function runNativeFlow(
  runId: string,
  subjectName: string,
  absPath: string,
  toolSet: Set<string>,
  toolsUsed: string[],
  limitations: string[]
): Promise<void> {
  if (!toolSet.has("inspect_binary_layout")) {
    limitations.push(
      "AREA inspect_binary_layout is not in the engine catalog; strings/hex analysis only."
    );
    return;
  }
  const layout = await area.callTool("inspect_binary_layout", { path: absPath });
  await recordReaEvidence(
    "inspect_binary_layout",
    layout,
    runId,
    subjectName,
    toolsUsed
  );
  await storeToolFindings("inspect_binary_layout", layout, runId);
  if (layout.isError) {
    limitations.push(
      `Deep native analysis unavailable on this host (deep-analysis provider missing): ${firstLine(layout.text)}. Strings/hex view remains fully available.`
    );
  }
}

// ---------------------------------------------------------------------------
// Evidence recording
// ---------------------------------------------------------------------------

/** Record Evidence for one AREA tool call and track it in toolsUsed. */
async function recordReaEvidence(
  operation: string,
  outcome: AreaOutcome,
  runId: string,
  subjectName: string,
  toolsUsed: string[]
): Promise<void> {
  if (!toolsUsed.includes(operation)) toolsUsed.push(operation);
  await insertEvidence(runId, operation, outcome, subjectName, "area");
}

async function insertEvidence(
  runId: string,
  operation: string,
  outcome: AreaOutcome,
  subjectName: string,
  source: "area" | "platform"
): Promise<void> {
  try {
    const evidenceId =
      findEvidenceId(outcome.structured) ??
      `ev_local_${createHash("sha1")
        .update(operation + outcome.text.slice(0, 2048))
        .digest("hex")
        .slice(0, 16)}`;
    const predicate = deepGet(outcome.structured, ["predicate_type"]);
    const confidence = deepGet(outcome.structured, ["confidence"]);
    const authority = deepGet(outcome.structured, ["authority"]);
    await db.evidence.create({
      data: {
        runId,
        evidenceId,
        kind: outcome.isError ? "unknown" : "observed",
        predicateType:
          typeof predicate === "string"
            ? predicate
            : source === "area"
              ? "area.analysis"
              : "platform.analysis",
        operation,
        subjectName: subjectName || null,
        confidence: outcome.isError
          ? null
          : typeof confidence === "string"
            ? confidence
            : "observed",
        authority:
          typeof authority === "string"
            ? authority
            : source === "area"
              ? "external-service"
              : "platform-local",
        payload: JSON.stringify({
          structured: outcome.structured ?? null,
          text: outcome.text.slice(0, 20000),
          isError: outcome.isError,
        }),
      },
    });
  } catch {
    // evidence persistence must never break the pipeline
  }
}

async function recordPlatformEvidence(
  runId: string,
  operation: string,
  kind: "observed" | "unknown",
  subjectName: string,
  data: unknown
): Promise<void> {
  await insertEvidence(
    runId,
    operation,
    { structured: data, text: "", isError: kind === "unknown" },
    subjectName,
    "platform"
  );
}

function findEvidenceId(node: unknown, depth = 0): string | null {
  if (depth > 8 || node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findEvidenceId(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const rec = node as Record<string, unknown>;
  if (typeof rec.evidence_id === "string") return rec.evidence_id;
  for (const value of Object.values(rec)) {
    const found = findEvidenceId(value, depth + 1);
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Findings extraction
// ---------------------------------------------------------------------------

/** Store a 'report' finding per tool call + structured findings (capped). */
async function storeToolFindings(
  toolName: string,
  outcome: AreaOutcome,
  runId: string
): Promise<void> {
  try {
    if (outcome.isError) {
      await db.finding.create({
        data: {
          runId,
          type: "report",
          name: `${toolName} report`,
          meta: JSON.stringify({
            isError: true,
            text: outcome.text.slice(0, 4000),
          }),
        },
      });
      return;
    }
    const produced = extractFindings(toolName, outcome.structured);
    const capped = produced.slice(0, FINDINGS_CAP_PER_TOOL);
    const overflow = Math.max(0, produced.length - capped.length);
    if (capped.length > 0) {
      await db.finding.createMany({
        data: capped.map((f) => ({
          runId,
          type: f.type,
          name: f.name.slice(0, 500),
          sizeBytes:
            typeof f.sizeBytes === "number" && Number.isFinite(f.sizeBytes)
              ? Math.min(Math.max(Math.round(f.sizeBytes), 0), 2_147_483_647)
              : null,
          meta: f.meta,
        })),
      });
    }
    await db.finding.create({
      data: {
        runId,
        type: "report",
        name: `${toolName} report`,
        meta: JSON.stringify({
          text: outcome.text.slice(0, 4000),
          produced: produced.length,
          overflow,
        }),
      },
    });
  } catch {
    // findings persistence must never break the pipeline
  }
}

/**
 * Heuristically walk AREA structured Evidence and derive Finding rows.
 * Generic: any object with an identifying string + size/bytes qualifies as an
 * artifact entry; JS app graph nodes become js_module rows; tool-specific
 * summaries get dedicated finding types.
 */
function extractFindings(
  toolName: string,
  structured: unknown
): PendingFinding[] {
  const out: PendingFinding[] = [];
  const seen = new Set<string>();
  const push = (f: PendingFinding) => {
    const key = `${f.type}|${f.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };

  walkJson(structured, (node) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const rec = node as Record<string, unknown>;

    // Generic artifact entries: identifying path/name + a size-ish field.
    const name = pickString(rec, [
      "relative_path",
      "path",
      "entry_path",
      "file",
      "entry",
      "name",
    ]);
    const size = pickNumber(rec, [
      "bytes_written",
      "bytes",
      "size",
      "sizeBytes",
      "unpacked_bytes",
      "uncompressed_size",
    ]);
    if (name && size !== null && typeof rec.evidence_id !== "string") {
      push({ type: "artifact_entry", name, sizeBytes: size });
      return;
    }
    // Named artifacts without explicit size (e.g. inventory nodes).
    if (
      name &&
      typeof rec.sha256 === "string" &&
      (rec.format !== undefined || rec.artifact_id !== undefined) &&
      rec.operation === undefined
    ) {
      push({ type: "artifact_entry", name, sizeBytes: null });
      return;
    }
    // JavaScript application graph nodes (kind: artifact/module/file).
    if (
      (rec.kind === "artifact" ||
        rec.kind === "module" ||
        rec.kind === "file") &&
      Array.isArray(rec.observations)
    ) {
      for (const obs of rec.observations) {
        if (!obs || typeof obs !== "object") continue;
        const props = (obs as Record<string, unknown>).properties;
        if (props && typeof props === "object") {
          const p = props as Record<string, unknown>;
          if (typeof p.path === "string") {
            push({
              type: "js_module",
              name: p.path,
              sizeBytes: typeof p.bytes === "number" ? p.bytes : null,
            });
          }
        }
      }
    }
  });

  if (toolName === "analyze_javascript_application") {
    const summary = deepGet(structured, ["normalized_result", "summary"]);
    const statistics = deepGet(structured, ["normalized_result", "statistics"]);
    if (summary !== null || statistics !== null) {
      push({
        type: "js_summary",
        name: "JavaScript application summary",
        meta: JSON.stringify({ summary, statistics }),
      });
    }
  }
  if (toolName === "inspect_evm_interface" && structured) {
    push({
      type: "evm_interface",
      name: "EVM interface",
      meta: JSON.stringify({
        normalized: deepGet(structured, ["normalized_result"]),
        provider: deepGet(structured, ["provider"]),
        confidence: deepGet(structured, ["confidence"]),
      }),
    });
  }
  if (toolName === "inspect_plist" && structured) {
    const normalized = deepGet(structured, ["normalized_result"]);
    if (normalized !== null) {
      push({
        type: "plist",
        name: "Property list",
        meta: JSON.stringify({ normalized }),
      });
    }
  }
  return out;
}

function walkJson(
  node: unknown,
  visit: (n: unknown) => void,
  depth = 0,
  budget = { left: 60_000 }
): void {
  if (budget.left <= 0 || depth > 12) return;
  if (node === null || typeof node !== "object") return;
  budget.left--;
  visit(node);
  if (Array.isArray(node)) {
    for (const item of node) walkJson(item, visit, depth + 1, budget);
  } else {
    for (const value of Object.values(node as Record<string, unknown>)) {
      walkJson(value, visit, depth + 1, budget);
    }
  }
}

function pickString(
  rec: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0 && v.length <= 500) return v;
  }
  return null;
}

function pickNumber(
  rec: Record<string, unknown>,
  keys: string[]
): number | null {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function deepGet(node: unknown, path: string[]): unknown {
  let cur: unknown = node;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur === undefined ? null : cur;
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.slice(0, 300);
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** dest/package.json, or package.json inside the single top-level dir. */
async function findAppRoot(dest: string): Promise<string | null> {
  try {
    const hasPkg = async (p: string): Promise<boolean> => {
      try {
        return (await fs.stat(path.join(p, "package.json"))).isFile();
      } catch {
        return false;
      }
    };
    if (await hasPkg(dest)) return dest;
    const entries = await fs.readdir(dest, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => path.join(dest, e.name));
    if (dirs.length === 1 && (await hasPkg(dirs[0]))) return dirs[0];
    return null;
  } catch {
    return null;
  }
}

interface SqliteColumn {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
}
interface SqliteTable {
  name: string;
  kind: string;
  rowCount: number | null;
  columns: SqliteColumn[];
}

/**
 * Read-only SQLite inspection using node:sqlite (DatabaseSync).
 * NEVER executes user SQL — table names come from sqlite_master and are
 * double-quote escaped; every query is a fixed SELECT/PRAGMA template.
 */
function inspectSqliteLocal(absPath: string): Promise<{
  tables: SqliteTable[];
  summary: Record<string, unknown>;
  error?: string;
}> {
  return new Promise((resolve) => {
    let client: InstanceType<typeof DatabaseSync> | null = null;
    try {
      client = new DatabaseSync(absPath, { readOnly: true });
      const tables: SqliteTable[] = [];
      const masterRows = client
        .prepare(
          `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`
        )
        .all() as Array<{ name: unknown; type: unknown }>;
      const selected = masterRows.slice(0, SQLITE_TABLES_MAX);
      for (const row of selected) {
        const tableName = typeof row.name === "string" ? row.name : "";
        if (!tableName) continue;
        const quoted = `"${tableName.replace(/"/g, '""')}"`;
        let columns: SqliteColumn[] = [];
        try {
          const pragmaRows = client
            .prepare(`PRAGMA table_info(${quoted})`)
            .all() as Array<Record<string, unknown>>;
          columns = pragmaRows.map((c) => ({
            name: String(c.name ?? ""),
            type: String(c.type ?? ""),
            notNull: Number(c.notnull ?? 0) === 1,
            pk: Number(c.pk ?? 0) > 0,
          }));
        } catch {
          columns = [];
        }
        let rowCount: number | null = null;
        try {
          const countRow = client
            .prepare(`SELECT COUNT(*) AS n FROM ${quoted}`)
            .get() as Record<string, unknown> | undefined;
          if (countRow && countRow.n !== undefined) {
            rowCount = Number(countRow.n);
          }
        } catch {
          rowCount = null;
        }
        tables.push({
          name: tableName,
          kind: typeof row.type === "string" ? row.type : "table",
          rowCount,
          columns,
        });
      }
      resolve({
        tables,
        summary: {
          tableCount: masterRows.length,
          inspected: tables.length,
          engine: "node:sqlite (read-only)",
          tables: tables.map((t) => ({
            name: t.name,
            kind: t.kind,
            rowCount: t.rowCount,
            columnCount: t.columns.length,
          })),
        },
      });
    } catch (err) {
      resolve({
        tables: [],
        summary: {},
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      try {
        client?.close();
      } catch {
        /* already closed */
      }
    }
  });
}
