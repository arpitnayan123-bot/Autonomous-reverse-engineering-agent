"use client";

import * as React from "react";
import { ExternalLink, Info, Loader2, RefreshCw, ScrollText, Trophy } from "lucide-react";

import { apiGet } from "@/lib/api-client";
import { EmptyState, SectionCard, timeAgo, toastError } from "@/components/area/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * /leaderboard — the PUBLIC verification leaderboard (Capability 4).
 *
 * Reads the public GET /api/leaderboard (no auth required on the endpoint).
 * One row per (agent, benchmark, category) — the latest best score — ranked
 * descending. Honest provenance is the point: AREA's own rows are OBSERVED
 * (open harness in benchmarks/), external systems are INFERRED claims that
 * must cite a methodology.
 */

interface LeaderboardEntry {
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

interface LeaderboardMeta {
  methodology: string;
  provenanceCounts: Record<string, number>;
  totalRows: number;
  leaderboardCount: number;
  agentCount: number;
  benchmarkCount: number;
  generatedAt: string;
}

interface LeaderboardResponse {
  ok: boolean;
  entries: LeaderboardEntry[];
  meta: LeaderboardMeta;
}

const CATEGORY_FILTERS = ["all", "binary", "web", "code", "mixed", "overall"] as const;
type CategoryFilter = (typeof CATEGORY_FILTERS)[number];

/** Provenance badge styling — OBSERVED green, INFERRED amber, UNKNOWN gray. */
const PROVENANCE_BADGE: Record<string, string> = {
  OBSERVED: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  DERIVED: "border-teal-500/40 bg-teal-500/10 text-teal-300",
  INFERRED: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  UNKNOWN: "border-zinc-700 bg-zinc-800/60 text-zinc-400",
};

function scoreTone(score: number): { bar: string; text: string } {
  if (score >= 80) return { bar: "bg-emerald-500/70", text: "text-emerald-300" };
  if (score >= 50) return { bar: "bg-amber-400/70", text: "text-amber-300" };
  return { bar: "bg-rose-500/70", text: "text-rose-300" };
}

function ProvenanceBadge({ provenance }: { provenance: string }) {
  const cls = PROVENANCE_BADGE[provenance] ?? PROVENANCE_BADGE.UNKNOWN;
  return (
    <Badge
      variant="outline"
      title={
        provenance === "OBSERVED"
          ? "Measured by the open benchmark harness in benchmarks/"
          : "Third-party claim with cited methodology — not measured by this platform"
      }
      className={`px-1.5 py-0 font-mono text-[9px] tracking-widest ${cls}`}
    >
      {provenance}
    </Badge>
  );
}

function ScoreCell({ score }: { score: number }) {
  const tone = scoreTone(score);
  return (
    <div className="flex min-w-20 flex-col gap-1">
      <span className={`font-mono text-xs font-semibold ${tone.text}`}>
        {Number.isInteger(score) ? score : score.toFixed(1)}
        <span className="text-zinc-600">/100</span>
      </span>
      {/* Subtle 0-100 bar */}
      <div className="h-1 w-16 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full rounded-full ${tone.bar}`}
          style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
        />
      </div>
    </div>
  );
}

function MethodologyCell({ entry }: { entry: LeaderboardEntry }) {
  if (entry.url) {
    return (
      <a
        href={entry.url}
        target="_blank"
        rel="noreferrer"
        title={entry.methodology ?? entry.url}
        className="inline-flex items-center gap-1 font-mono text-[11px] text-emerald-400 underline-offset-2 hover:text-emerald-300 hover:underline"
      >
        citation
        <ExternalLink className="size-3" aria-hidden />
      </a>
    );
  }
  if (entry.methodology) {
    return (
      <span
        title={entry.methodology}
        className="block max-w-56 truncate font-mono text-[11px] text-zinc-500"
      >
        {entry.methodology}
      </span>
    );
  }
  return <span className="font-mono text-[11px] text-zinc-700">—</span>;
}

function MetaTile({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  const valueCls =
    tone === "ok" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : "text-zinc-200";
  return (
    <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3">
      <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`mt-0.5 font-mono text-sm font-semibold ${valueCls}`}>{value}</p>
    </div>
  );
}

export function LeaderboardView() {
  const [data, setData] = React.useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<CategoryFilter>("all");

  const fetchBoard = React.useCallback(async () => {
    try {
      const res = await apiGet<LeaderboardResponse>("/api/leaderboard");
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      toastError(err, "Could not load the leaderboard");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void fetchBoard();
  }, [fetchBoard]);

  const entries = data?.entries ?? [];
  const filtered = filter === "all" ? entries : entries.filter((e) => e.category === filter);
  const meta = data?.meta ?? null;
  const observedCount = meta?.provenanceCounts?.OBSERVED ?? 0;
  const inferredCount = meta?.provenanceCounts?.INFERRED ?? 0;
  const unknownCount = (meta?.provenanceCounts?.UNKNOWN ?? 0) + (meta?.provenanceCounts?.DERIVED ?? 0);

  return (
    <div className="min-h-0 w-full flex-1 overflow-y-auto area-scroll">
      <div className="mx-auto w-full max-w-5xl p-4 md:p-6">
        <header className="mb-5 flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 font-mono text-sm font-semibold tracking-widest text-zinc-200">
              <Trophy className="size-4 text-emerald-400" aria-hidden />
              PUBLIC LEADERBOARD
            </h1>
            <p className="mt-1 text-xs text-zinc-500">
              Verification &amp; reconstruction scores — best result per agent, benchmark and
              category. Public endpoint: GET /api/leaderboard.
              {meta && <span className="ml-1 font-mono text-[10px]">updated {timeAgo(meta.generatedAt)}</span>}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1.5 px-2 font-mono text-[10px] text-zinc-500"
            onClick={() => {
              setLoading(true);
              void fetchBoard().finally(() => setLoading(false));
            }}
          >
            <RefreshCw className="size-3" aria-hidden />
            Reload
          </Button>
        </header>

        {/* Honest provenance banner */}
        <div
          className="mb-5 flex items-start gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3"
          role="note"
        >
          <Info className="mt-0.5 size-3.5 shrink-0 text-emerald-400" aria-hidden />
          <p className="text-xs leading-relaxed text-zinc-400">
            AREA entries are measured by the open benchmark harness (
            <code className="font-mono text-[11px] text-emerald-300">benchmarks/</code>). External
            entries are third-party claims with cited methodology — provenance{" "}
            <span className="font-mono text-[11px] text-amber-300">INFERRED</span>.
          </p>
        </div>

        {/* Provenance counts + scale */}
        {meta && (
          <section className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Leaderboard meta">
            <MetaTile label="Ranked entries" value={String(meta.leaderboardCount)} />
            <MetaTile label="Agents" value={String(meta.agentCount)} />
            <MetaTile label="Observed rows" value={String(observedCount)} tone="ok" />
            <MetaTile
              label="Claimed rows"
              value={`${inferredCount + unknownCount}`}
              tone={inferredCount + unknownCount > 0 ? "warn" : undefined}
            />
          </section>
        )}

        {/* Category filter tabs */}
        <div
          className="mb-3 inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900/70 p-0.5"
          role="tablist"
          aria-label="Filter by category"
        >
          {CATEGORY_FILTERS.map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={filter === c}
              onClick={() => setFilter(c)}
              className={`rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-wide transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none ${
                filter === c ? "bg-emerald-500/15 text-emerald-300" : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {c}
            </button>
          ))}
        </div>

        {/* Board */}
        {loading && !data ? (
          <div className="space-y-2" aria-busy>
            <Skeleton className="h-10 w-full bg-zinc-800/50" />
            <Skeleton className="h-14 w-full bg-zinc-800/40" />
            <Skeleton className="h-14 w-full bg-zinc-800/40" />
          </div>
        ) : error && !data ? (
          <p className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 font-mono text-xs text-rose-300">
            {error}
          </p>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Trophy}
            title={filter === "all" ? "No entries yet" : `No ${filter} entries yet`}
            description="Run the open benchmark (bun run bench) and sync it with npm run leaderboard:sync, or POST /api/leaderboard to submit the first score."
            className="border-dashed"
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/40">
            <Table>
              <TableHeader>
                <TableRow className="border-zinc-800/80 hover:bg-transparent">
                  <TableHead className="px-3 font-mono text-[10px] tracking-wider text-zinc-500">Rank</TableHead>
                  <TableHead className="px-3 font-mono text-[10px] tracking-wider text-zinc-500">Agent</TableHead>
                  <TableHead className="px-3 font-mono text-[10px] tracking-wider text-zinc-500">Benchmark</TableHead>
                  <TableHead className="px-3 font-mono text-[10px] tracking-wider text-zinc-500">Category</TableHead>
                  <TableHead className="px-3 font-mono text-[10px] tracking-wider text-zinc-500">Score</TableHead>
                  <TableHead className="px-3 text-right font-mono text-[10px] tracking-wider text-zinc-500">Trials</TableHead>
                  <TableHead className="px-3 font-mono text-[10px] tracking-wider text-zinc-500">Measured</TableHead>
                  <TableHead className="px-3 font-mono text-[10px] tracking-wider text-zinc-500">Methodology</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((e) => (
                  <TableRow key={`${e.rank}-${e.agent}`} className="border-zinc-800/60">
                    <TableCell className="px-3 font-mono text-xs">
                      <span className={e.rank <= 3 ? "font-semibold text-emerald-300" : "text-zinc-500"}>
                        {e.rank}
                      </span>
                    </TableCell>
                    <TableCell className="max-w-56 px-3">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-medium text-zinc-200" title={e.agent}>
                          {e.agent}
                        </span>
                        <ProvenanceBadge provenance={e.provenance} />
                      </div>
                    </TableCell>
                    <TableCell className="px-3 font-mono text-[11px] text-zinc-400">{e.benchmark}</TableCell>
                    <TableCell className="px-3">
                      <span className="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 font-mono text-[9px] tracking-wider text-zinc-400">
                        {e.category}
                      </span>
                    </TableCell>
                    <TableCell className="px-3">
                      <ScoreCell score={e.score} />
                    </TableCell>
                    <TableCell className="px-3 text-right font-mono text-[11px] text-zinc-400">
                      {e.trials}
                    </TableCell>
                    <TableCell className="px-3 font-mono text-[10px] whitespace-nowrap text-zinc-500" title={e.measuredAt}>
                      {timeAgo(e.measuredAt)}
                    </TableCell>
                    <TableCell className="px-3">
                      <MethodologyCell entry={e} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Server-side methodology statement */}
        {meta?.methodology && (
          <SectionCard
            title="Methodology"
            description="How scores on this board are graded and grouped"
            icon={ScrollText}
            className="mt-6"
          >
            <p className="font-mono text-[11px] leading-relaxed text-zinc-500">{meta.methodology}</p>
          </SectionCard>
        )}
      </div>
    </div>
  );
}
