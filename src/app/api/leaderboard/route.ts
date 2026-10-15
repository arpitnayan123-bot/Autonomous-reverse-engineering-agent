import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { audit, clientIp, rateLimit } from "@/lib/security";

export const runtime = "nodejs";
// Public GET must never be statically cached at build time — the leaderboard
// reflects live submissions, so every request re-reads the table.
export const dynamic = "force-dynamic";

/**
 * Capability 4 — public verification leaderboard.
 *
 * GET  /api/leaderboard   → PUBLIC (no auth). Returns the leaderboard grouped
 *                           to the latest best score per (agent, benchmark,
 *                           category), sorted descending, plus honest meta
 *                           (methodology statement + provenance counts).
 * POST /api/leaderboard   → AUTH. Submit an entry. External claims (RevEng.AI,
 *                           DecompileBench baselines, competitors…) are
 *                           INFERRED with a cited methodology — never
 *                           OBSERVED. Only scores measured by the open harness
 *                           in benchmarks/ (benchmark "rea-bench") may be
 *                           submitted as OBSERVED.
 */

const CATEGORIES = ["binary", "web", "code", "mixed", "overall"] as const;
const PROVENANCES = ["OBSERVED", "DERIVED", "INFERRED", "UNKNOWN"] as const;
const BENCH_BENCHMARK = "rea-bench"; // the open harness (benchmarks/)

/** Hard cap — the leaderboard is small; 2000 rows is far beyond honest scale. */
const MAX_ROWS = 2000;

const METHODOLOGY_STATEMENT =
  "Scores are 0-100 per (agent, benchmark, category); per triple only the best score is listed. " +
  "REA rows are OBSERVED — measured by the open benchmark harness in benchmarks/ " +
  "(runner.ts → scorer.ts → report.ts: rubric/exact scoring with an anti-fabrication rule). " +
  "Third-party rows carry provenance INFERRED (or UNKNOWN) and must cite a methodology of at least 30 characters; " +
  "external claims are never graded OBSERVED.";

interface PublicEntry {
  rank: number;
  agent: string;
  benchmark: string;
  category: string;
  score: number;
  trials: number;
  url: string | null;
  methodology: string | null;
  provenance: string;
  measuredAt: string;
}

type LeaderboardRow = {
  id: string;
  agent: string;
  url: string | null;
  benchmark: string;
  category: string;
  score: number;
  trials: number;
  methodology: string | null;
  provenance: string;
  measuredAt: Date;
  createdAt: Date;
};

function toPublicEntry(row: LeaderboardRow, rank: number): PublicEntry {
  return {
    rank,
    agent: row.agent,
    benchmark: row.benchmark,
    category: row.category,
    score: row.score,
    trials: row.trials,
    url: row.url,
    methodology: row.methodology,
    provenance: row.provenance,
    measuredAt: row.measuredAt.toISOString(),
  };
}

export async function GET() {
  try {
    const rows = (await db.leaderboardEntry.findMany({
      orderBy: [{ score: "desc" }, { measuredAt: "desc" }, { createdAt: "desc" }],
      take: MAX_ROWS,
    })) as LeaderboardRow[];

    // Group to the latest BEST score per (agent, benchmark, category): rows
    // arrive sorted best-first, so the first row seen for a triple wins.
    const seen = new Set<string>();
    const entries: PublicEntry[] = [];
    const agents = new Set<string>();
    const benchmarks = new Set<string>();
    const provenanceCounts: Record<string, number> = {
      OBSERVED: 0,
      DERIVED: 0,
      INFERRED: 0,
      UNKNOWN: 0,
    };

    for (const row of rows) {
      agents.add(row.agent);
      benchmarks.add(row.benchmark);
      provenanceCounts[row.provenance] = (provenanceCounts[row.provenance] ?? 0) + 1;
      const key = `${row.agent}\u0000${row.benchmark}\u0000${row.category}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(toPublicEntry(row, entries.length + 1));
    }

    return NextResponse.json({
      ok: true,
      entries,
      meta: {
        methodology: METHODOLOGY_STATEMENT,
        provenanceCounts,
        totalRows: rows.length,
        leaderboardCount: entries.length,
        agentCount: agents.size,
        benchmarkCount: benchmarks.size,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error("leaderboard GET error:", err);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}

interface SubmitBody {
  agent?: unknown;
  benchmark?: unknown;
  category?: unknown;
  score?: unknown;
  trials?: unknown;
  url?: unknown;
  methodology?: unknown;
  provenance?: unknown;
}

function badRequest(error: string) {
  return NextResponse.json({ ok: false, error }, { status: 400 });
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const limit = rateLimit(`leaderboard-submit:${user.id}`, 20, 60 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        { ok: false, error: `Too many submissions — retry in ${limit.retryAfterSec}s.` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
      );
    }

    let body: SubmitBody;
    try {
      body = (await req.json()) as SubmitBody;
    } catch {
      return badRequest("Request body must be JSON");
    }
    if (typeof body !== "object" || body === null) {
      return badRequest("Request body must be a JSON object");
    }

    const agent = typeof body.agent === "string" ? body.agent.trim() : "";
    if (!agent || agent.length > 120) {
      return badRequest("agent (1-120 chars) is required");
    }
    const benchmark = typeof body.benchmark === "string" ? body.benchmark.trim() : "";
    if (!benchmark || benchmark.length > 80) {
      return badRequest("benchmark (1-80 chars) is required");
    }
    const category = typeof body.category === "string" ? body.category.trim() : "";
    if (!(CATEGORIES as readonly string[]).includes(category)) {
      return badRequest(`category must be one of: ${CATEGORIES.join(", ")}`);
    }
    const score = typeof body.score === "number" ? body.score : Number.NaN;
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      return badRequest("score must be a number between 0 and 100");
    }
    let trials = 1;
    if (body.trials !== undefined && body.trials !== null) {
      trials = typeof body.trials === "number" ? body.trials : Number.NaN;
      if (!Number.isInteger(trials) || trials < 1 || trials > 10_000) {
        return badRequest("trials must be an integer between 1 and 10000");
      }
    }

    let url: string | null = null;
    if (body.url !== undefined && body.url !== null && body.url !== "") {
      if (typeof body.url !== "string" || body.url.length > 500) {
        return badRequest("url must be a string of at most 500 chars");
      }
      try {
        const parsed = new URL(body.url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          return badRequest("url must be an http(s) link");
        }
        url = parsed.toString();
      } catch {
        return badRequest("url must be a valid absolute http(s) link");
      }
    }

    const methodology =
      typeof body.methodology === "string" && body.methodology.trim() !== ""
        ? body.methodology.trim().slice(0, 2000)
        : null;
    const provenance =
      typeof body.provenance === "string" && body.provenance !== ""
        ? body.provenance
        : "OBSERVED";
    if (!(PROVENANCES as readonly string[]).includes(provenance)) {
      return badRequest(`provenance must be one of: ${PROVENANCES.join(", ")}`);
    }

    // Integrity rule (Capability 4): a non-OBSERVED claim is an external
    // claim — it MUST carry a cited methodology (>= 30 chars). And OBSERVED is
    // reserved for the open harness itself; anything else submitted as
    // OBSERVED would be an unverifiable self-claim.
    if (provenance !== "OBSERVED" && (!methodology || methodology.length < 30)) {
      return badRequest(
        "methodology (min 30 chars) is required for external claims — provenance INFERRED/UNKNOWN/DERIVED must cite how the score was measured"
      );
    }
    if (provenance === "OBSERVED" && benchmark !== BENCH_BENCHMARK) {
      return badRequest(
        `provenance OBSERVED is reserved for the open harness (benchmark "${BENCH_BENCHMARK}"); external claims must use provenance INFERRED with a cited methodology`
      );
    }

    const entry = await db.leaderboardEntry.create({
      data: {
        agent,
        benchmark,
        category,
        score,
        trials,
        url,
        methodology,
        provenance,
        submittedBy: user.id,
      },
    });

    await audit("leaderboard.submit", {
      userId: user.id,
      ip: clientIp(req),
      detail: `agent=${agent.slice(0, 80)} benchmark=${benchmark.slice(0, 40)} category=${category} score=${score} provenance=${provenance}`,
    });

    return NextResponse.json({ ok: true, entry: toPublicEntry(entry as LeaderboardRow, 0) });
  } catch (err) {
    console.error("leaderboard POST error:", err);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
