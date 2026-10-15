#!/usr/bin/env bun
/**
 * AREA leaderboard sync — record our latest MEASURED benchmark scores as
 * OBSERVED leaderboard entries (agent "AREA (measured)").
 *
 * Reads benchmarks/report.json (written by benchmarks/report.ts) and writes
 * one LeaderboardEntry per category average (binary|web|code|mixed) plus the
 * overall average, directly via Prisma — no HTTP round-trip needed.
 *
 * Idempotent: previous entries for agent "AREA (measured)" with the same
 * benchmark + category are deleted before inserting, so re-running after a
 * fresh benchmark run replaces (never duplicates) our rows.
 *
 * Provenance is OBSERVED because these scores come from the open harness in
 * benchmarks/ (runner.ts → scorer.ts → report.ts) — the only source allowed
 * to claim OBSERVED. Trials = number of scored tasks behind the average.
 *
 * Usage: bun benchmarks/leaderboard.ts   (npm script: leaderboard:sync)
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";

const PROJECT_ROOT = path.resolve(import.meta.dir, "..");
const REPORT_PATH = path.join(PROJECT_ROOT, "benchmarks", "report.json");
const REPO_URL = "https://github.com/arpitnayan123-bot/reverse-engineering-agent";

const AGENT_NAME = "AREA (measured)";
const BENCHMARK = "area-bench";

interface ReportAggregates {
  tasks: number;
  scoredTasks: number;
  avgScore: number | null;
  avgByCategory: { category: string; avg: number | null; scored: number; tasks: number }[];
  regressions: unknown[];
}

interface Report {
  runId: string;
  generatedAt: string;
  aggregates: ReportAggregates;
}

function methodologyFor(category: string, scored: number, runId: string): string {
  const base =
    `Measured by the open AREA benchmark harness (benchmarks/runner.ts → scorer.ts → report.ts): ` +
    `${scored} scored rubric/exact task${scored === 1 ? "" : "s"} in category "${category}", run ${runId} ` +
    `(benchmarks/report.json). LLM-judged with an anti-fabrication rule — no tool-trace evidence caps a criterion at half credit.`;
  return category === "overall"
    ? base + ` Overall average across all scored categories of the same run.`
    : base;
}

async function main(): Promise<void> {
  if (!existsSync(REPORT_PATH)) {
    console.error(
      "[leaderboard] benchmarks/report.json not found — run `bun run bench` (or bench:report) first."
    );
    process.exit(1);
  }

  let report: Report;
  try {
    report = JSON.parse(readFileSync(REPORT_PATH, "utf8")) as Report;
  } catch (err) {
    console.error(
      `[leaderboard] could not parse benchmarks/report.json: ${err instanceof Error ? err.message : err}`
    );
    process.exit(1);
  }

  const agg = report.aggregates;
  const measuredAt = new Date(report.generatedAt);
  if (Number.isNaN(measuredAt.getTime())) {
    console.error(`[leaderboard] report.generatedAt is not a valid date: ${report.generatedAt}`);
    process.exit(1);
  }

  // (category, avg, scored) rows to record — overall first, then per category.
  const planned: { category: string; avg: number; scored: number }[] = [];
  if (agg.avgScore != null) {
    planned.push({ category: "overall", avg: agg.avgScore, scored: Math.max(1, agg.scoredTasks) });
  }
  for (const c of agg.avgByCategory ?? []) {
    if (c.avg != null) {
      planned.push({ category: c.category, avg: c.avg, scored: Math.max(1, c.scored) });
    }
  }

  if (planned.length === 0) {
    console.error(
      "[leaderboard] nothing to sync — the report has no scored results (avgScore null). Run the benchmark first."
    );
    process.exit(1);
  }

  console.log(
    `[leaderboard] syncing run ${report.runId} as agent "${AGENT_NAME}" (${planned.length} entries, provenance OBSERVED)`
  );

  // Idempotent upsert: replace our previous rows per (benchmark, category).
  for (const p of planned) {
    const removed = await db.leaderboardEntry.deleteMany({
      where: { agent: AGENT_NAME, benchmark: BENCHMARK, category: p.category },
    });
    const created = await db.leaderboardEntry.create({
      data: {
        agent: AGENT_NAME,
        benchmark: BENCHMARK,
        category: p.category,
        score: p.avg,
        trials: p.scored,
        url: REPO_URL,
        methodology: methodologyFor(p.category, p.scored, report.runId),
        provenance: "OBSERVED",
        submittedBy: "system",
        measuredAt,
      },
    });
    console.log(
      `  ${p.category.padEnd(8)} score ${String(p.avg).padStart(3)}/100 · trials ${p.scored} · ${
        removed.count
      } previous replaced · id ${created.id}`
    );
  }

  console.log("[leaderboard] done — GET /api/leaderboard to view the public board.");
}

main()
  .then(() => db.$disconnect())
  .catch((err) => {
    console.error(`[leaderboard] fatal: ${err instanceof Error ? err.message : err}`);
    void db.$disconnect();
    process.exit(1);
  });
