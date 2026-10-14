#!/usr/bin/env bun
/**
 * REA benchmark scorer — turns raw runner captures into 0-100 scores.
 *
 * Scoring types (from task.toml):
 *   - rubric: an LLM judge (the platform default model) scores the agent's
 *     final answer against weighted criteria, with the compact tool trace as
 *     supporting evidence. Judge verdicts are CACHED (content-addressed) so
 *     re-scoring the same result never re-bills the model.
 *   - exact: normalized substring match of the expected string → 0 or 100.
 *   - human: no auto score (score = null, flagged for human review).
 *
 * Scores are normalized to 0-100 regardless of rubric weight sums.
 *
 * Usage:
 *   bun benchmarks/scorer.ts [--run=<runId>] [--force] [--tasks=a,b]
 * Defaults to the LATEST run in benchmarks/results/_runs/.
 */
import { parse } from "smol-toml";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { zaiPlatformChat } from "@/server/agent/platform-llm";

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const TASKS_DIR = path.join(PROJECT_ROOT, "benchmarks", "tasks");
const RESULTS_DIR = path.join(PROJECT_ROOT, "benchmarks", "results");
const RUNS_DIR = path.join(RESULTS_DIR, "_runs");
const JUDGE_CACHE_PATH = path.join(RESULTS_DIR, "judge-cache.json");

/** Bump when the judge prompt/protocol changes — old cache entries stop matching. */
const JUDGE_PROMPT_VERSION = "v1";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Cli {
  run: string | null;
  force: boolean;
  tasks: string[];
}

function parseCli(): Cli {
  const cli: Cli = { run: null, force: false, tasks: [] };
  for (const a of process.argv.slice(2)) {
    if (a === "--force") cli.force = true;
    else if (a.startsWith("--run=")) cli.run = a.slice(6);
    else if (a.startsWith("--tasks=")) cli.tasks = a.slice(8).split(",").map((s) => s.trim()).filter(Boolean);
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return cli;
}

// ---------------------------------------------------------------------------
// Task + result discovery
// ---------------------------------------------------------------------------

interface TaskDef {
  id: string;
  prompt: string;
  scoring: {
    type: "rubric" | "exact" | "human";
    rubric?: { criterion: string; weight: number }[];
    expected?: string;
  };
}

function loadTaskDef(taskId: string): TaskDef {
  const raw = parse(readFileSync(path.join(TASKS_DIR, taskId, "task.toml"), "utf8")) as {
    task: { prompt: unknown };
    scoring: TaskDef["scoring"];
  };
  return { id: taskId, prompt: String(raw.task.prompt), scoring: raw.scoring };
}

function listRuns(): string[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

// ---------------------------------------------------------------------------
// Exact scoring
// ---------------------------------------------------------------------------

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function scoreExact(expected: string, finalContent: string): { score: number; matched: boolean } {
  const matched = normalizeText(finalContent).includes(normalizeText(expected));
  return { score: matched ? 100 : 0, matched };
}

// ---------------------------------------------------------------------------
// Rubric scoring via the platform-default LLM judge (with cache)
// ---------------------------------------------------------------------------

interface JudgeVerdict {
  scores: { criterion: string; points: number; comment: string }[];
  total_comment: string;
}

function loadJudgeCache(): Record<string, unknown> {
  if (!existsSync(JUDGE_CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(JUDGE_CACHE_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function saveJudgeCache(cache: Record<string, unknown>): void {
  writeFileSync(JUDGE_CACHE_PATH, JSON.stringify(cache, null, 2));
}

function judgeKey(parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/** Compact the tool trace so the judge can verify "evidence" claims cheaply. */
function compactTrace(
  trace: { tool: string; args: Record<string, unknown>; preview: string }[]
): string {
  if (trace.length === 0) return "(no tool calls)";
  return trace
    .slice(0, 40)
    .map((t, i) => {
      const args = JSON.stringify(t.args ?? {}).slice(0, 200);
      const out = (t.preview || "").replace(/\s+/g, " ").slice(0, 220);
      return `${i + 1}. ${t.tool}(${args}) -> ${out}`;
    })
    .join("\n");
}

function buildJudgePrompt(taskId: string, prompt: string, rubric: { criterion: string; weight: number }[], finalContent: string, trace: string): { system: string; user: string } {
  const criteria = rubric
    .map((r) => `- ${JSON.stringify(r.criterion)} (max points: ${r.weight})`)
    .join("\n");
  const system =
    "You are a strict but fair evaluation judge for a reverse-engineering-agent benchmark. " +
    "Score an agent's FINAL ANSWER against weighted rubric criteria, using the tool trace as supporting evidence. " +
    "Rules: score each criterion independently with an integer number of points between 0 and its max; " +
    "award full points ONLY when the answer clearly satisfies the criterion with specific, correct content; " +
    "award half credit (in steps of 5 points) when partially satisfied; award 0 when absent or wrong. " +
    "Anti-fabrication rule: if a criterion requires evidence from tools (e.g. 'cites OBSERVED evidence', " +
    "'performs a real fetch') and the trace does NOT show such an observation, award at most half credit. " +
    "Respond with ONLY a JSON object, no prose, in this exact shape: " +
    '{"scores":[{"criterion":"<exact criterion text>","points":<int>,"comment":"<one line why>"}],"total_comment":"<one line overall>"}';
  const user = [
    `BENCHMARK TASK: ${taskId}`,
    `TASK PROMPT (given to the agent):`,
    prompt,
    "",
    `RUBRIC (score each):`,
    criteria,
    "",
    `AGENT'S FINAL ANSWER:`,
    finalContent.slice(0, 12_000) || "(empty — the turn errored or timed out)",
    "",
    `TOOL TRACE (observations the agent actually collected):`,
    trace,
  ].join("\n");
  return { system, user };
}

function parseJudgeVerdict(text: string): JudgeVerdict | null {
  // Tolerant parse: strip code fences and grab the outermost JSON object.
  let candidate = text.trim();
  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidate = fence[1].trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(candidate.slice(start, end + 1)) as {
      scores?: { criterion?: unknown; points?: unknown; comment?: unknown }[];
      total_comment?: unknown;
    };
    if (!Array.isArray(raw.scores)) return null;
    const scores = raw.scores.map((s) => ({
      criterion: String(s.criterion ?? ""),
      points: Number(s.points ?? 0),
      comment: String(s.comment ?? ""),
    }));
    return { scores, total_comment: String(raw.total_comment ?? "") };
  } catch {
    return null;
  }
}

async function judgeRubric(
  task: TaskDef,
  result: { finalContent: string; toolTrace: { tool: string; args: Record<string, unknown>; preview: string }[]; error: string | null }
): Promise<{ earned: number; total: number; score: number | null; verdict: JudgeVerdict | null; error: string | null; cached: boolean }> {
  const rubric = task.scoring.rubric ?? [];
  const total = rubric.reduce((s, r) => s + r.weight, 0);
  if (rubric.length === 0 || total <= 0) {
    return { earned: 0, total, score: null, verdict: null, error: "empty rubric", cached: false };
  }
  const trace = compactTrace(result.toolTrace);
  const { system, user } = buildJudgePrompt(task.id, task.prompt, rubric, result.finalContent, trace);
  const key = judgeKey([JUDGE_PROMPT_VERSION, task.id, JSON.stringify(rubric), result.finalContent, trace]);

  const cache = loadJudgeCache();
  if (!cli.force && typeof cache[key] !== "undefined") {
    const verdict = parseJudgeVerdict(String(cache[key]));
    if (verdict) {
      return { ...aggregate(verdict, rubric, total), error: null, cached: true };
    }
  }

  const messages = [
    { role: "assistant" as const, content: system },
    { role: "user" as const, content: user },
  ];
  let raw: string;
  try {
    raw = await zaiPlatformChat(messages, { maxTokens: 1600 });
  } catch (err) {
    return {
      earned: 0,
      total,
      score: null,
      verdict: null,
      error: `judge call failed: ${err instanceof Error ? err.message : String(err)}`,
      cached: false,
    };
  }
  const verdict = parseJudgeVerdict(raw);
  if (!verdict) {
    return { earned: 0, total, score: null, verdict: null, error: "judge returned unparsable output", cached: false };
  }
  cache[key] = raw;
  saveJudgeCache(cache);
  return { ...aggregate(verdict, rubric, total), error: null, cached: false };
}

function aggregate(
  verdict: JudgeVerdict,
  rubric: { criterion: string; weight: number }[],
  total: number
): { earned: number; total: number; score: number; verdict: JudgeVerdict } {
  // Match verdict rows back to rubric criteria by text; missing rows score 0.
  let earned = 0;
  for (const r of rubric) {
    const row = verdict.scores.find((s) => normalizeText(s.criterion) === normalizeText(r.criterion));
    if (row) earned += Math.max(0, Math.min(r.weight, row.points));
  }
  const score = Math.round((earned / total) * 100);
  return { earned, total, score, verdict };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const cli = parseCli();

async function main(): Promise<void> {
  const runs = listRuns();
  if (runs.length === 0) {
    console.error("No runs found in benchmarks/results/_runs/ — run benchmarks/runner.ts first.");
    process.exit(1);
  }
  const runId = cli.run ?? runs[runs.length - 1];
  if (!runs.includes(runId)) {
    console.error(`Run ${runId} not found. Available: ${runs.join(", ")}`);
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(path.join(RUNS_DIR, `${runId}.json`), "utf8")) as {
    tasks: { taskId: string }[];
  };
  console.log(`[scorer] scoring run ${runId} (${manifest.tasks.length} tasks)\n`);

  let scored = 0;
  let failed = 0;
  for (const entry of manifest.tasks) {
    const taskId = entry.taskId;
    if (cli.tasks.length > 0 && !cli.tasks.includes(taskId)) continue;
    const rawPath = path.join(RESULTS_DIR, taskId, `${runId}.json`);
    if (!existsSync(rawPath)) {
      console.log(`  ${taskId.padEnd(24)} ✗ raw result missing`);
      failed++;
      continue;
    }
    const result = JSON.parse(readFileSync(rawPath, "utf8")) as {
      finalContent: string;
      toolTrace: { tool: string; args: Record<string, unknown>; preview: string }[];
      error: string | null;
    };
    const task = loadTaskDef(taskId);
    const scoredAt = new Date().toISOString();

    if (task.scoring.type === "exact") {
      const { score, matched } = scoreExact(task.scoring.expected ?? "", result.finalContent);
      writeFileSync(
        path.join(RESULTS_DIR, taskId, `${runId}.scored.json`),
        JSON.stringify(
          { runId, taskId, scoringType: "exact", score, exact: { expected: task.scoring.expected, matched }, rubric: null, needsHuman: false, judgeError: null, scoredAt },
          null,
          2
        )
      );
      console.log(`  ${taskId.padEnd(24)} exact   ${score}/100 ${matched ? "✓" : "✗ (no match)"}`);
      scored++;
    } else if (task.scoring.type === "human") {
      writeFileSync(
        path.join(RESULTS_DIR, taskId, `${runId}.scored.json`),
        JSON.stringify(
          { runId, taskId, scoringType: "human", score: null, exact: null, rubric: null, needsHuman: true, judgeError: null, scoredAt },
          null,
          2
        )
      );
      console.log(`  ${taskId.padEnd(24)} human   —/100 (flagged for human review)`);
      scored++;
    } else {
      const r = await judgeRubric(task, result);
      const out = {
        runId,
        taskId,
        scoringType: "rubric",
        score: r.score,
        exact: null,
        rubric: {
          criteria: (task.scoring.rubric ?? []).map((c) => {
            const row = r.verdict?.scores.find((s) => normalizeText(s.criterion) === normalizeText(c.criterion));
            return {
              criterion: c.criterion,
              weight: c.weight,
              points: row ? row.points : 0,
              comment: row ? row.comment : "(not scored — missing from judge output)",
            };
          }),
          earned: r.earned,
          total: r.total,
          totalComment: r.verdict?.total_comment ?? null,
        },
        needsHuman: false,
        judgeError: r.error,
        judgeCache: r.cached ? "hit" : "miss",
        scoredAt,
      };
      writeFileSync(path.join(RESULTS_DIR, taskId, `${runId}.scored.json`), JSON.stringify(out, null, 2));
      const display = r.score === null ? "ERR" : `${r.score}/100`;
      console.log(
        `  ${taskId.padEnd(24)} rubric   ${display}${r.cached ? " (cache)" : ""}${r.error ? ` ⚠ ${r.error.slice(0, 80)}` : ""}`
      );
      if (r.score === null) failed++;
      else scored++;
    }
  }

  console.log(`\n[scorer] done: ${scored} scored, ${failed} failed/unscorable.`);
  console.log(`[scorer] next: bun benchmarks/report.ts`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[scorer] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
