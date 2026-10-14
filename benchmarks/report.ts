#!/usr/bin/env bun
/**
 * REA benchmark report — aggregates scored results into summary artifacts.
 *
 * Reads the LATEST run (and the run before it, for regression detection)
 * from benchmarks/results/ and writes:
 *   - benchmarks/report.json   (machine-readable summary + full rows)
 *   - benchmarks/report.html   (self-contained dashboard, inline CSS)
 *
 * A task is flagged as a REGRESSION when its score dropped by more than
 * 10 points vs the previous run.
 *
 * Usage: bun benchmarks/report.ts [--run=<runId>]
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { estimateCostUsd, formatCostUsd } from "@/lib/pricing";

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const RESULTS_DIR = path.join(PROJECT_ROOT, "benchmarks", "results");
const RUNS_DIR = path.join(RESULTS_DIR, "_runs");

const REGRESSION_DROP = 10;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function listRuns(): string[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

interface ScoredFile {
  runId: string;
  taskId: string;
  scoringType: "rubric" | "exact" | "human";
  score: number | null;
  needsHuman: boolean;
  judgeError: string | null;
  rubric?: {
    criteria: { criterion: string; weight: number; points: number; comment: string }[];
    earned: number;
    total: number;
    totalComment: string | null;
  } | null;
  exact?: { expected: string; matched: boolean } | null;
  scoredAt: string;
}

interface RawFile {
  runId: string;
  taskId: string;
  category: string;
  difficulty: string;
  modelId: string | null;
  usage: { tokensIn: number | null; tokensOut: number | null; durationMs: number | null; compactionCount: number | null };
  wallMs: number;
  error: string | null;
  timedOut: boolean;
  finalContent: string;
  toolTrace: { tool: string }[];
}

interface ReportRow {
  taskId: string;
  category: string;
  difficulty: string;
  scoringType: string;
  score: number | null;
  previousScore: number | null;
  delta: number | null;
  regression: boolean;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number | null;
  costUsd: number | null;
  costLabel: string;
  status: "ok" | "error" | "timeout" | "human" | "unscored";
  error: string | null;
  toolCalls: number;
  judgeError: string | null;
}

function loadRow(runId: string, taskId: string): ReportRow | null {
  const rawPath = path.join(RESULTS_DIR, taskId, `${runId}.json`);
  const scoredPath = path.join(RESULTS_DIR, taskId, `${runId}.scored.json`);
  if (!existsSync(rawPath)) return null;
  const raw = JSON.parse(readFileSync(rawPath, "utf8")) as RawFile;
  const scored: ScoredFile | null = existsSync(scoredPath)
    ? (JSON.parse(readFileSync(scoredPath, "utf8")) as ScoredFile)
    : null;

  const status: ReportRow["status"] = raw.timedOut
    ? "timeout"
    : raw.error
      ? "error"
      : scored?.needsHuman
        ? "human"
        : scored?.score != null
          ? "ok"
          : "unscored";

  return {
    taskId,
    category: raw.category,
    difficulty: raw.difficulty,
    scoringType: scored?.scoringType ?? "?",
    score: scored?.score ?? null,
    previousScore: null,
    delta: null,
    regression: false,
    tokensIn: raw.usage.tokensIn,
    tokensOut: raw.usage.tokensOut,
    durationMs: raw.usage.durationMs ?? raw.wallMs,
    costUsd: estimateCostUsd(raw.modelId, raw.usage.tokensIn, raw.usage.tokensOut),
    costLabel: formatCostUsd(estimateCostUsd(raw.modelId, raw.usage.tokensIn, raw.usage.tokensOut)),
    status,
    error: raw.error,
    toolCalls: raw.toolTrace?.length ?? 0,
    judgeError: scored?.judgeError ?? null,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface Aggregates {
  tasks: number;
  scoredTasks: number;
  avgScore: number | null;
  avgByCategory: { category: string; avg: number | null; tasks: number; scored: number }[];
  totalTokens: number | null;
  totalCostUsd: number | null;
  totalDurationMs: number;
  regressions: ReportRow[];
  humanReview: string[];
}

function aggregate(rows: ReportRow[]): Aggregates {
  const scoredRows = rows.filter((r) => r.score != null);
  const categories = Array.from(new Set(rows.map((r) => r.category))).sort();
  const totalTokens =
    rows.every((r) => r.tokensIn == null && r.tokensOut == null)
      ? null
      : rows.reduce((s, r) => s + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0);
  const costs = rows.map((r) => r.costUsd).filter((c): c is number => c != null);
  return {
    tasks: rows.length,
    scoredTasks: scoredRows.length,
    avgScore: scoredRows.length ? Math.round(scoredRows.reduce((s, r) => s + (r.score ?? 0), 0) / scoredRows.length) : null,
    avgByCategory: categories.map((category) => {
      const catRows = rows.filter((r) => r.category === category);
      const catScored = catRows.filter((r) => r.score != null);
      return {
        category,
        tasks: catRows.length,
        scored: catScored.length,
        avg: catScored.length
          ? Math.round(catScored.reduce((s, r) => s + (r.score ?? 0), 0) / catScored.length)
          : null,
      };
    }),
    totalTokens,
    totalCostUsd: costs.length ? costs.reduce((s, c) => s + c, 0) : null,
    totalDurationMs: rows.reduce((s, r) => s + (r.durationMs ?? 0), 0),
    regressions: rows.filter((r) => r.regression),
    humanReview: rows.filter((r) => r.status === "human").map((r) => r.taskId),
  };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function scoreBadge(row: ReportRow): string {
  if (row.status === "human") return `<span class="pill pill-human">human</span>`;
  if (row.status === "timeout") return `<span class="pill pill-err">timeout</span>`;
  if (row.status === "error") return `<span class="pill pill-err">error</span>`;
  if (row.score == null) return `<span class="pill pill-warn">unscored</span>`;
  const cls = row.score >= 80 ? "pill-ok" : row.score >= 50 ? "pill-warn" : "pill-err";
  return `<span class="pill ${cls}">${row.score}</span>`;
}

function fmtMs(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderHtml(runId: string, previousRunId: string | null, rows: ReportRow[], agg: Aggregates): string {
  const categoryCells = agg.avgByCategory
    .map(
      (c) =>
        `<div class="cat"><div class="cat-name">${esc(c.category)}</div><div class="cat-avg">${
          c.avg == null ? "—" : c.avg
        }</div><div class="cat-sub">${c.scored}/${c.tasks} scored</div></div>`
    )
    .join("");

  const bodyRows = rows
    .map((r) => {
      const delta =
        r.delta == null
          ? `<span class="dim">—</span>`
          : r.delta > 0
            ? `<span class="up">▲+${r.delta}</span>`
            : r.delta < 0
              ? `<span class="${r.regression ? "down-bad" : "down"}">▼${r.delta}</span>`
              : `<span class="dim">=</span>`;
      return `<tr>
  <td class="mono">${esc(r.taskId)}</td>
  <td>${esc(r.category)}</td>
  <td><span class="diff diff-${esc(r.difficulty)}">${esc(r.difficulty)}</span></td>
  <td>${scoreBadge(r)}</td>
  <td>${delta}</td>
  <td class="mono">${r.tokensIn ?? "—"} / ${r.tokensOut ?? "—"}</td>
  <td class="mono">${fmtMs(r.durationMs)}</td>
  <td class="mono">${esc(r.costLabel || "—")}</td>
  <td class="mono">${r.toolCalls}</td>
  <td class="mono dim">${esc(r.judgeError ? r.judgeError.slice(0, 60) : r.status !== "ok" && r.error ? r.error.slice(0, 60) : "")}</td>
</tr>`;
    })
    .join("\n");

  const regressionSection =
    agg.regressions.length === 0
      ? `<p class="ok-note">No regressions detected${previousRunId ? ` vs <span class="mono">${esc(previousRunId)}</span>` : " (no previous run to compare)"}.</p>`
      : `<div class="reg-list">${agg.regressions
          .map(
            (r) =>
              `<div class="reg-item"><span class="mono">${esc(r.taskId)}</span> dropped ${Math.abs(
                r.delta ?? 0
              )} points (${r.previousScore ?? "?"} → ${r.score ?? "?"})</div>`
          )
          .join("")}</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>REA Benchmark Report — ${esc(runId)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0e14; color: #e6e9f0; font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: .2px; }
  h2 { font-size: 15px; margin: 32px 0 12px; color: #aab3c5; text-transform: uppercase; letter-spacing: .8px; }
  .meta { color: #7d8698; font-size: 13px; margin-bottom: 24px; }
  .meta .mono { color: #aab3c5; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 20px 0; }
  .card { background: #12161f; border: 1px solid #232a38; border-radius: 10px; padding: 14px 16px; }
  .card .k { color: #7d8698; font-size: 12px; text-transform: uppercase; letter-spacing: .6px; }
  .card .v { font-size: 22px; font-weight: 650; margin-top: 2px; }
  .cats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin: 16px 0 8px; }
  .cat { background: #12161f; border: 1px solid #232a38; border-radius: 10px; padding: 12px 14px; text-align: center; }
  .cat-name { color: #aab3c5; font-size: 12px; text-transform: uppercase; letter-spacing: .6px; }
  .cat-avg { font-size: 24px; font-weight: 700; margin: 2px 0; }
  .cat-sub { color: #7d8698; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; background: #12161f; border: 1px solid #232a38; border-radius: 10px; overflow: hidden; }
  th { text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: .6px; color: #8d97ab; padding: 10px 12px; border-bottom: 1px solid #232a38; background: #161b26; }
  td { padding: 9px 12px; border-bottom: 1px solid #1a2030; vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  .dim { color: #6b7488; }
  .pill { display: inline-block; min-width: 34px; text-align: center; border-radius: 999px; padding: 2px 10px; font-size: 12px; font-weight: 650; }
  .pill-ok { background: rgba(52, 199, 123, .16); color: #4ade80; }
  .pill-warn { background: rgba(250, 179, 52, .14); color: #fbbf24; }
  .pill-err { background: rgba(255, 99, 99, .14); color: #f87171; }
  .pill-human { background: rgba(140, 140, 160, .16); color: #b7bdc9; }
  .diff { font-size: 12px; border-radius: 6px; padding: 2px 8px; }
  .diff-easy { background: rgba(52, 199, 123, .12); color: #4ade80; }
  .diff-medium { background: rgba(250, 179, 52, .12); color: #fbbf24; }
  .diff-hard { background: rgba(255, 99, 99, .12); color: #f87171; }
  .up { color: #4ade80; }
  .down { color: #fbbf24; }
  .down-bad { color: #f87171; font-weight: 700; }
  .ok-note { color: #4ade80; background: rgba(52, 199, 123, .08); border: 1px solid rgba(52, 199, 123, .25); padding: 10px 14px; border-radius: 8px; }
  .reg-list { display: flex; flex-direction: column; gap: 8px; }
  .reg-item { background: rgba(255, 99, 99, .08); border: 1px solid rgba(255, 99, 99, .3); color: #fca5a5; padding: 10px 14px; border-radius: 8px; }
  footer { margin-top: 40px; color: #5b6478; font-size: 12px; }
  @media (max-width: 720px) { .wrap { padding: 20px 12px 40px; } td, th { padding: 7px 8px; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>REA Benchmark Report</h1>
  <div class="meta">run <span class="mono">${esc(runId)}</span>${
    previousRunId ? ` &nbsp;·&nbsp; previous <span class="mono">${esc(previousRunId)}</span>` : " &nbsp;·&nbsp; first recorded run"
  }</div>

  <div class="cards">
    <div class="card"><div class="k">Avg score</div><div class="v">${agg.avgScore ?? "—"}</div></div>
    <div class="card"><div class="k">Tasks</div><div class="v">${agg.tasks}</div></div>
    <div class="card"><div class="k">Scored</div><div class="v">${agg.scoredTasks}</div></div>
    <div class="card"><div class="k">Regressions</div><div class="v" style="color:${agg.regressions.length ? "#f87171" : "#4ade80"}">${agg.regressions.length}</div></div>
    <div class="card"><div class="k">Total tokens</div><div class="v">${agg.totalTokens ?? "—"}</div></div>
    <div class="card"><div class="k">Est. cost</div><div class="v">${agg.totalCostUsd == null ? "—" : formatCostUsd(agg.totalCostUsd)}</div></div>
  </div>

  <h2>By category</h2>
  <div class="cats">${categoryCells}</div>

  <h2>Results</h2>
  <table>
    <thead><tr>
      <th>Task</th><th>Category</th><th>Difficulty</th><th>Score</th><th>Δ</th>
      <th>Tokens (in/out)</th><th>Duration</th><th>Est. cost</th><th>Tool calls</th><th>Notes</th>
    </tr></thead>
    <tbody>
${bodyRows}
    </tbody>
  </table>

  <h2>Regressions (drop &gt; ${REGRESSION_DROP} points)</h2>
  ${regressionSection}

  <footer>Generated ${esc(new Date().toISOString())} · REA benchmark suite · scores are LLM-judged estimates, not guarantees.</footer>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const runs = listRuns();
  if (runs.length === 0) {
    console.error("No runs found in benchmarks/results/_runs/ — run benchmarks/runner.ts first.");
    process.exit(1);
  }
  const runArg = process.argv.find((a) => a.startsWith("--run="));
  const runId = runArg ? runArg.slice(6) : runs[runs.length - 1];
  if (!runs.includes(runId)) {
    console.error(`Run ${runId} not found. Available: ${runs.join(", ")}`);
    process.exit(1);
  }
  const idx = runs.indexOf(runId);
  const previousRunId = idx > 0 ? runs[idx - 1] : null;

  const manifest = JSON.parse(readFileSync(path.join(RUNS_DIR, `${runId}.json`), "utf8")) as {
    tasks: { taskId: string }[];
  };

  const rows: ReportRow[] = [];
  for (const { taskId } of manifest.tasks) {
    const row = loadRow(runId, taskId);
    if (!row) continue;
    if (previousRunId) {
      const prev = loadRow(previousRunId, taskId);
      row.previousScore = prev?.score ?? null;
      row.delta = row.score != null && row.previousScore != null ? row.score - row.previousScore : null;
      row.regression = row.delta != null && row.delta <= -REGRESSION_DROP;
    }
    rows.push(row);
  }

  const agg = aggregate(rows);

  const report = {
    runId,
    previousRunId,
    generatedAt: new Date().toISOString(),
    regressionDrop: REGRESSION_DROP,
    aggregates: agg,
    rows,
  };
  writeFileSync(path.join(PROJECT_ROOT, "benchmarks", "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(path.join(PROJECT_ROOT, "benchmarks", "report.html"), renderHtml(runId, previousRunId, rows, agg));

  // Console summary table.
  console.log(`\nRun ${runId}${previousRunId ? `  (vs ${previousRunId})` : "  (first run)"}\n`);
  console.log(
    "  task".padEnd(26) +
      "cat".padEnd(7) +
      "diff".padEnd(8) +
      "score".padEnd(7) +
      "delta".padEnd(7) +
      "tokens".padEnd(12) +
      "duration".padEnd(10) +
      "cost"
  );
  for (const r of rows) {
    const delta = r.delta == null ? "—" : `${r.delta > 0 ? "+" : ""}${r.delta}${r.regression ? " ⚠" : ""}`;
    const tokens = `${r.tokensIn ?? "—"}/${r.tokensOut ?? "—"}`;
    const score = r.status === "human" ? "human" : r.score == null ? "—" : String(r.score);
    console.log(
      `  ${r.taskId.padEnd(24)}${r.category.padEnd(7)}${r.difficulty.padEnd(8)}${score.padEnd(7)}${String(delta).padEnd(7)}${tokens.padEnd(12)}${fmtMs(r.durationMs).padEnd(10)}${r.costLabel || "—"}`
    );
  }
  console.log(
    `\n  avg ${agg.avgScore ?? "—"} · scored ${agg.scoredTasks}/${agg.tasks} · regressions ${agg.regressions.length} · est cost ${agg.totalCostUsd == null ? "—" : formatCostUsd(agg.totalCostUsd)}`
  );
  console.log(`\n  wrote benchmarks/report.json + benchmarks/report.html`);
}

main();
