"use client";

import * as React from "react";
import {
  BookOpen,
  Braces,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  FileQuestion,
  FolderOpen,
  Loader2,
  RefreshCw,
  ScrollText,
  Target as TargetIcon,
  Zap,
} from "lucide-react";

import {
  apiGet,
  apiPost,
  type EvidenceRow,
  type Finding,
  type HexPage,
  type Run,
  type StringsPage,
  type TargetDetail,
} from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  ConfidenceBadge,
  CopyButton,
  EmptyState,
  EvidenceKindBadge,
  FormatBadge,
  Markdown,
  SectionCard,
  StatusBadge,
  humanBytes,
  humanDuration,
  parseJsonSafe,
  prettyJson,
  timeAgo,
  toastError,
} from "@/components/area/shared";
import { MemoryView } from "@/components/area/memory-view";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// ---------------------------------------------------------------------------
// Constants / helpers
// ---------------------------------------------------------------------------

const HEX_PAGE_BYTES = 256; // 16 bytes × 16 rows
const STRINGS_PAGE_SIZE = 100;

const PANEL_TABS = [
  { value: "overview", label: "Overview" },
  { value: "hex", label: "Hex" },
  { value: "strings", label: "Strings" },
  { value: "findings", label: "Findings" },
  { value: "evidence", label: "Evidence" },
  { value: "docs", label: "Docs" },
  { value: "memory", label: "Memory" },
] as const;

function isRunActive(status: string | null | undefined): boolean {
  return status === "running" || status === "queued" || status === "analyzing";
}

function extractLimitations(result: unknown): string[] {
  const obj = typeof result === "string" ? parseJsonSafe<Record<string, unknown>>(result) : result;
  if (!obj || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;
  if (Array.isArray(o.limitations)) {
    return o.limitations.filter((x): x is string => typeof x === "string");
  }
  if (o.summary && typeof o.summary === "object") {
    const s = o.summary as Record<string, unknown>;
    if (Array.isArray(s.limitations)) {
      return s.limitations.filter((x): x is string => typeof x === "string");
    }
  }
  return [];
}

/**
 * SectionCard tuned for a ~400px side panel: tighter paddings and radii while
 * keeping the shared header/content structure.
 */
function PanelCard({
  className,
  contentClassName,
  ...props
}: React.ComponentProps<typeof SectionCard>) {
  return (
    <SectionCard
      {...props}
      className={cn(
        "gap-0 rounded-lg border-zinc-800 bg-zinc-900/60 py-3 [&_[data-slot=card-header]]:px-3",
        className
      )}
      contentClassName={cn("px-3", contentClassName)}
    />
  );
}

// ---------------------------------------------------------------------------
// TargetPanel
// ---------------------------------------------------------------------------

export function TargetPanel({
  targetId,
  className,
  /** Store-driven tab request (evidence deep-link from chat); null = leave as-is. */
  externalTab,
  /** Bumped on every openInspector — re-fires the tab sync for repeat links. */
  externalTabNonce,
}: {
  targetId: string;
  className?: string;
  externalTab?: string | null;
  externalTabNonce?: number;
}) {
  const [target, setTarget] = React.useState<TargetDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [tab, setTab] = React.useState<string>("overview");
  const [goalOpen, setGoalOpen] = React.useState(false);
  const [goal, setGoal] = React.useState("");
  const [rerunning, setRerunning] = React.useState(false);
  const [docs, setDocs] = React.useState<string | null>(null);
  const [docsSummary, setDocsSummary] = React.useState<string | null>(null);
  const [generatingDocs, setGeneratingDocs] = React.useState(false);

  const fetchTarget = React.useCallback(async () => {
    if (!targetId) {
      setLoading(false);
      return;
    }
    try {
      const res = await apiGet<{ target: TargetDetail }>(`/api/targets/${targetId}`);
      setTarget(res.target);
      // Docs ride on the target detail payload — the old code fetched a
      // /docs sub-endpoint that does not exist, so docs never hydrated.
      setDocs(res.target.docs ?? null);
      setDocsSummary(res.target.summary ?? null);
    } catch (err) {
      toastError(err, "Could not load target");
    } finally {
      setLoading(false);
    }
  }, [targetId]);

  React.useEffect(() => {
    setLoading(true);
    setTarget(null);
    setDocs(null);
    setDocsSummary(null);
    setGoal("");
    setGoalOpen(false);
    setTab("overview");
    void fetchTarget();
  }, [fetchTarget]);

  // Deep-link: when the caller requests a specific tab (e.g. Evidence from a
  // chat message), jump there. The nonce re-fires this even when the same
  // tab is requested twice in a row (the second "view evidence" click must
  // win over a manual tab switch made in between).
  React.useEffect(() => {
    if (externalTab) setTab(externalTab);
  }, [externalTab, externalTabNonce]);

  // Poll every 4s while the latest run is active so progress updates live.
  const running = isRunActive(target?.runs?.[0]?.status);
  React.useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => void fetchTarget(), 4000);
    return () => window.clearInterval(interval);
  }, [running, fetchTarget]);

  const generateDocs = async () => {
    if (!targetId || generatingDocs) return;
    setGeneratingDocs(true);
    setTab("docs");
    try {
      const res = await apiPost<{ docs: string; summary?: string }>(
        `/api/targets/${targetId}/report`,
        { action: "generate-docs" }
      );
      setDocs(res.docs);
      if (res.summary) setDocsSummary(res.summary);
    } catch (err) {
      toastError(err, "Documentation generation failed");
    } finally {
      setGeneratingDocs(false);
    }
  };

  const rerun = async () => {
    if (!targetId || rerunning) return;
    setRerunning(true);
    try {
      await apiPost(`/api/targets/${targetId}/analyze`, goal.trim() ? { goal: goal.trim() } : {});
      setGoalOpen(false);
      setGoal("");
      await fetchTarget();
    } catch (err) {
      toastError(err, "Could not start analysis");
    } finally {
      setRerunning(false);
    }
  };

  if (!targetId) {
    return (
      <div className={cn("flex flex-col p-3", className)}>
        <EmptyState
          icon={FolderOpen}
          title="No target selected"
          description="Pick a target from the dashboard to inspect its hex, strings, findings and evidence ledger."
          className="px-4 py-8"
        />
      </div>
    );
  }

  if (loading && !target) {
    return (
      <div className={cn("space-y-3 p-3", className)} aria-busy="true">
        <Skeleton className="h-5 w-2/3 bg-zinc-800/70" />
        <Skeleton className="h-3.5 w-1/3 bg-zinc-800/70" />
        <Skeleton className="h-7 w-full bg-zinc-800/50" />
        <Skeleton className="h-48 w-full bg-zinc-800/50" />
      </div>
    );
  }

  if (!target) {
    return (
      <div className={cn("flex flex-col p-3", className)}>
        <EmptyState
          icon={FileQuestion}
          title="Target not found"
          description="It may have been deleted. Head back to the dashboard and pick another target."
          className="px-4 py-8"
        />
      </div>
    );
  }

  const latestRun: Run | null = target.runs?.[0] ?? null;

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {/* Header */}
      <div className="shrink-0 space-y-2 border-b border-zinc-800 p-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h2
            className="min-w-0 flex-1 truncate font-mono text-sm font-semibold text-zinc-100"
            title={target.originalName}
          >
            {target.originalName}
          </h2>
          <FormatBadge
            format={target.detectedFormat}
            label={target.formatLabel ?? undefined}
            className="shrink-0"
          />
          <StatusBadge status={latestRun?.status ?? target.status} className="shrink-0" />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
          <span className="font-mono">{humanBytes(target.sizeBytes)}</span>
          <span className="flex min-w-0 items-center gap-1 font-mono">
            <span className="text-zinc-600">sha256</span>
            <span className="truncate text-zinc-400">
              {target.sha256 ? `${target.sha256.slice(0, 12)}…` : "—"}
            </span>
            <CopyButton value={target.sha256 ?? ""} label="Copy full SHA-256" className="size-5" />
          </span>
          <span className="shrink-0">uploaded {timeAgo(target.createdAt)}</span>
        </div>
        <div className="flex items-center gap-2">
          <Popover open={goalOpen} onOpenChange={setGoalOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 flex-1 gap-1 border-emerald-500/40 bg-emerald-500/10 px-2 text-xs text-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-300"
                disabled={rerunning}
              >
                {rerunning ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  <RefreshCw className="size-3.5" aria-hidden />
                )}
                Re-run analysis
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 border-zinc-800 bg-zinc-900 p-3">
              <div className="space-y-2.5">
                <p className="text-xs font-medium text-zinc-200">Optional goal</p>
                <Input
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="e.g. focus on network-related functionality"
                  className="h-8 border-zinc-800 bg-zinc-950 text-xs"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void rerun();
                  }}
                />
                <Button
                  className="h-8 w-full bg-emerald-600 text-xs text-white hover:bg-emerald-500"
                  onClick={() => void rerun()}
                  disabled={rerunning}
                >
                  {rerunning && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                  Start AREA investigation
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          <Button
            variant="outline"
            size="sm"
            className="h-7 flex-1 gap-1 border-amber-500/40 bg-amber-500/10 px-2 text-xs text-amber-400 hover:bg-amber-500/20 hover:text-amber-300"
            onClick={() => void generateDocs()}
            disabled={generatingDocs}
          >
            {generatingDocs ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <BookOpen className="size-3.5" aria-hidden />
            )}
            Generate docs
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-col gap-0">
        <div className="area-scroll shrink-0 overflow-x-auto border-b border-zinc-800 px-2">
          <TabsList className="h-8 w-max min-w-full justify-start gap-0.5 rounded-none bg-transparent p-0">
            {PANEL_TABS.map((t) => (
              <TabsTrigger
                key={t.value}
                value={t.value}
                className="h-7 rounded-md px-2.5 text-xs data-[state=active]:bg-zinc-800/80 data-[state=active]:text-emerald-300"
              >
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="overview" className="mt-0 min-h-0 outline-none">
          <div className="area-scroll max-h-[calc(100dvh-11rem)] space-y-3 overflow-y-auto p-3 pr-2">
            <OverviewTab target={target} latestRun={latestRun} runStamp={latestRun?.id ?? "none"} />
          </div>
        </TabsContent>
        <TabsContent value="hex" className="mt-2 outline-none">
          <HexTab targetId={target.id} />
        </TabsContent>
        <TabsContent value="strings" className="mt-2 outline-none">
          <StringsTab targetId={target.id} />
        </TabsContent>
        <TabsContent value="findings" className="mt-2 outline-none">
          <FindingsTab targetId={target.id} />
        </TabsContent>
        <TabsContent value="evidence" className="mt-0 min-h-0 outline-none">
          <div className="area-scroll max-h-[calc(100dvh-11rem)] overflow-y-auto p-3 pr-2">
            <EvidenceTab targetId={target.id} />
          </div>
        </TabsContent>
        <TabsContent value="docs" className="mt-0 min-h-0 outline-none">
          <div className="area-scroll max-h-[calc(100dvh-11rem)] overflow-y-auto p-3 pr-2">
            <DocsTab
              docs={docs}
              summary={docsSummary}
              generating={generatingDocs}
              onGenerate={() => void generateDocs()}
            />
          </div>
        </TabsContent>
        <TabsContent value="memory" className="mt-0 min-h-0 outline-none">
          <div className="area-scroll max-h-[calc(100dvh-11rem)] overflow-y-auto p-3 pr-2">
            <MemoryView targetId={target.id} className="space-y-3" showHeader={false} />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewTab({
  target,
  latestRun,
  runStamp,
}: {
  target: TargetDetail;
  latestRun: Run | null;
  /** Latest run id — refetches the type counts when a (re-)run appears. */
  runStamp: string;
}) {
  const [counts, setCounts] = React.useState<{ type: string; count: number }[] | null>(null);
  const [totalFindings, setTotalFindings] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    apiGet<{ findings: Finding[]; total: number }>(`/api/targets/${target.id}/findings`, { limit: 500 })
      .then((res) => {
        if (cancelled) return;
        setTotalFindings(res.total ?? res.findings.length);
        const byType = new Map<string, number>();
        for (const f of res.findings) byType.set(f.type, (byType.get(f.type) ?? 0) + 1);
        setCounts(
          [...byType.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count)
        );
      })
      .catch(() => {
        if (!cancelled) setCounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [target.id, runStamp]);

  const limitations = extractLimitations(latestRun?.result);

  return (
    <div className="space-y-3">
      <PanelCard title="Format detection" description="Magic-byte analysis on upload" icon={TargetIcon}>
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <FormatBadge format={target.detectedFormat} label={target.formatLabel ?? undefined} />
            {target.formatConfidence && (
              <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400">
                confidence: <span className="text-zinc-200">{target.formatConfidence}</span>
              </Badge>
            )}
            {target.formatFamily && (
              <Badge variant="outline" className="border-zinc-700 font-mono text-[10px] text-zinc-400">
                family: <span className="text-zinc-200">{target.formatFamily}</span>
              </Badge>
            )}
          </div>
          <p className="text-xs leading-relaxed text-zinc-400">
            {target.formatDetails ?? target.summary ?? "No additional format details recorded."}
          </p>
        </div>
      </PanelCard>

      <PanelCard
        title="Latest run"
        description={latestRun ? `Run ${latestRun.id.slice(0, 8)} · started ${timeAgo(latestRun.createdAt)}` : "No analysis run yet"}
        icon={Zap}
      >
        {latestRun ? (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <StatusBadge status={latestRun.status} />
              <span className="font-mono text-[11px] text-zinc-500">
                {humanDuration(latestRun.durationMs)} · {latestRun.progress ?? 0}%
              </span>
            </div>
            {isRunActive(latestRun.status) && (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                  style={{ width: `${Math.min(100, latestRun.progress ?? 0)}%` }}
                />
              </div>
            )}
            <p className="text-xs text-zinc-400">
              {latestRun.currentStep ??
                (isRunActive(latestRun.status) ? "Working…" : latestRun.error ? "—" : "Finished.")}
            </p>
            {latestRun.error && (
              <Alert variant="destructive" className="border-rose-500/40 bg-rose-500/10 px-3 py-2">
                <AlertTitle className="text-xs text-rose-300">Run failed</AlertTitle>
                <AlertDescription className="font-mono text-[11px] break-all text-rose-300/80">
                  {latestRun.error}
                </AlertDescription>
              </Alert>
            )}
          </div>
        ) : (
          <p className="text-xs text-zinc-500">
            Use <span className="font-mono text-zinc-300">Re-run analysis</span> above to send this
            artifact through the AREA engine.
          </p>
        )}
      </PanelCard>

      <PanelCard
        title="Findings by type"
        description={
          totalFindings > (counts?.reduce((a, c) => a + c.count, 0) ?? 0)
            ? `${totalFindings} in the ledger · top types shown`
            : "Counts from the findings ledger"
        }
        icon={Braces}
      >
        {counts === null ? (
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-20 bg-zinc-800/70" />
            ))}
          </div>
        ) : counts.length === 0 ? (
          <p className="text-xs text-zinc-500">No findings recorded yet. Run the analysis first.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {counts.map(({ type, count }) => (
              <Badge
                key={type}
                variant="outline"
                className="gap-1.5 border-zinc-800 bg-zinc-950 font-mono text-[10px] text-zinc-300"
              >
                {type}
                <span className="rounded bg-emerald-500/15 px-1.5 text-emerald-400">{count}</span>
              </Badge>
            ))}
          </div>
        )}
      </PanelCard>

      <PanelCard title="Limitations" description="Honest boundaries of this run" icon={Eye}>
        {limitations.length > 0 ? (
          <ul className="list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-zinc-400">
            {limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-zinc-500">
            {latestRun
              ? isRunActive(latestRun.status)
                ? "The run is still in progress — limitations will appear when it finishes."
                : "The engine did not report explicit limitations for this run."
              : "Run the analysis to see what the engine could and could not establish."}
          </p>
        )}
      </PanelCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hex
// ---------------------------------------------------------------------------

function HexTab({ targetId }: { targetId: string }) {
  const [offset, setOffset] = React.useState(0);
  const [page, setPage] = React.useState<HexPage | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [jump, setJump] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<HexPage>(`/api/targets/${targetId}/hex`, { offset, length: HEX_PAGE_BYTES })
      .then((res) => {
        if (!cancelled) setPage(res);
      })
      .catch((err) => {
        if (!cancelled) toastError(err, "Could not load hex");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [targetId, offset]);

  const fileSize = page?.fileSize ?? 0;
  const maxOffset = Math.max(0, fileSize - HEX_PAGE_BYTES);

  const doJump = () => {
    const trimmed = jump.trim().toLowerCase();
    if (!trimmed) return;
    const parsed = trimmed.startsWith("0x") ? parseInt(trimmed.slice(2), 16) : parseInt(trimmed, 16);
    if (Number.isNaN(parsed)) {
      toastError(new Error("Enter a hex offset like 0x1F40 or 1F40"), "Invalid offset");
      return;
    }
    setOffset(Math.min(maxOffset, Math.max(0, parsed)));
    setJump("");
  };

  return (
    <PanelCard
      title="Hex viewer"
      description={`${humanBytes(fileSize)} · ${HEX_PAGE_BYTES} B/page`}
      icon={ScrollText}
      actions={
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 border-zinc-700 px-2 text-xs"
            disabled={offset <= 0 || loading}
            onClick={() => setOffset(Math.max(0, offset - HEX_PAGE_BYTES))}
          >
            <ChevronLeft className="size-3.5" aria-hidden />
            Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 border-zinc-700 px-2 text-xs"
            disabled={offset >= maxOffset || loading}
            onClick={() => setOffset(Math.min(maxOffset, offset + HEX_PAGE_BYTES))}
          >
            Next
            <ChevronRight className="size-3.5" aria-hidden />
          </Button>
          <Input
            aria-label="Jump to hex offset"
            value={jump}
            onChange={(e) => setJump(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doJump()}
            onBlur={doJump}
            placeholder="0x0000"
            className="h-7 w-20 border-zinc-700 bg-zinc-950 px-2 font-mono text-xs"
          />
        </div>
      }
      contentClassName="p-0!"
    >
      <div className="area-scroll max-h-[55vh] overflow-auto rounded-b-lg">
        {loading && !page ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full bg-zinc-800/60" />
            ))}
          </div>
        ) : !page || page.hex.length === 0 ? (
          <p className="p-6 text-center text-xs text-zinc-500">No hex content available.</p>
        ) : (
          <table className="w-full min-w-[560px] border-collapse font-mono text-xs">
            <thead className="sticky top-0 z-10 bg-zinc-900 shadow-[0_1px_0_0_rgba(39,39,42,1)]">
              <tr>
                <th scope="col" className="px-2 py-1.5 text-right font-medium text-zinc-500">
                  Offset
                </th>
                <th scope="col" className="px-2 py-1.5 text-left font-medium text-zinc-500">
                  Hex bytes
                </th>
                <th scope="col" className="w-32 px-2 py-1.5 text-left font-medium text-zinc-500">
                  ASCII
                </th>
              </tr>
            </thead>
            <tbody>
              {page.hex.map((row) => (
                <tr key={row.offset} className="border-b border-zinc-900/80 transition-colors hover:bg-zinc-800/60">
                  <td className="px-2 py-1 text-right text-zinc-600 select-all">
                    {row.offset.toString(16).padStart(8, "0")}
                  </td>
                  <td className="px-2 py-1 text-zinc-300 select-all">
                    {row.bytes.map((b, i) => (
                      <span
                        key={i}
                        className={b === 0 ? "text-zinc-600" : b >= 32 && b < 127 ? "" : "text-amber-400/80"}
                      >
                        {b.toString(16).padStart(2, "0")}
                        {i === 7 ? "  " : " "}
                      </span>
                    ))}
                  </td>
                  <td className="w-32 px-2 py-1 text-zinc-500 select-all">{row.ascii}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </PanelCard>
  );
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

function StringsTab({ targetId }: { targetId: string }) {
  const [input, setInput] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [data, setData] = React.useState<StringsPage | null>(null);
  const [loading, setLoading] = React.useState(true);

  // Debounce search input (300ms) and reset pagination on query change.
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      setQuery(input);
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [input]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<StringsPage>(`/api/targets/${targetId}/strings`, {
      q: query || undefined,
      page,
      pageSize: STRINGS_PAGE_SIZE,
    })
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) toastError(err, "Could not load strings");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [targetId, query, page]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <PanelCard
      title="Extracted strings"
      description={data ? `${data.total} found` : "Searching printable sequences"}
      icon={ScrollText}
      actions={
        <Input
          aria-label="Search strings"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Filter strings…"
          className="h-7 w-32 border-zinc-700 bg-zinc-950 px-2 font-mono text-xs"
        />
      }
      contentClassName="p-0!"
    >
      <div className="area-scroll max-h-[55vh] overflow-x-auto overflow-y-auto rounded-b-lg">
        {loading && !data ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full bg-zinc-800/60" />
            ))}
          </div>
        ) : !data || data.strings.length === 0 ? (
          <p className="p-6 text-center text-xs text-zinc-500">
            {query ? `No strings match “${query}”.` : "No strings extracted for this target yet."}
          </p>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-zinc-900">
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="w-24 text-zinc-500">Offset</TableHead>
                <TableHead className="text-zinc-500">Value</TableHead>
                <TableHead className="w-20 text-zinc-500">Encoding</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.strings.map((s, i) => (
                <TableRow key={`${s.offset}-${i}`} className="border-zinc-800/70">
                  <TableCell className="font-mono text-[11px] text-zinc-600">
                    0x{s.offset.toString(16).padStart(8, "0")}
                  </TableCell>
                  <TableCell className="max-w-0 font-mono text-[11px] text-zinc-300">
                    <span className="block truncate" title={s.value}>
                      {s.value}
                    </span>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className="border-zinc-800 font-mono text-[9px] text-zinc-500"
                    >
                      {s.encoding}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-zinc-800 px-3 py-1.5">
        <span className="font-mono text-[10px] text-zinc-500">
          page {data?.page ?? page} / {totalPages}
        </span>
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-6 border-zinc-700 px-2 text-[11px]"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="size-3" aria-hidden />
            Prev
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 border-zinc-700 px-2 text-[11px]"
            disabled={!data || page >= totalPages || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
            <ChevronRight className="size-3" aria-hidden />
          </Button>
        </div>
      </div>
    </PanelCard>
  );
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function FindingsTab({ targetId }: { targetId: string }) {
  const [findings, setFindings] = React.useState<Finding[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [typeFilter, setTypeFilter] = React.useState("all");
  const [search, setSearch] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    apiGet<{ findings: Finding[]; total: number }>(`/api/targets/${targetId}/findings`, { limit: 500 })
      .then((res) => {
        if (!cancelled) {
          setFindings(res.findings);
          setTotal(res.total ?? res.findings.length);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          toastError(err, "Could not load findings");
          setFindings([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [targetId]);

  const types = React.useMemo(
    () => (findings ? [...new Set(findings.map((f) => f.type))].sort() : []),
    [findings]
  );

  const filtered = React.useMemo(() => {
    if (!findings) return [];
    const q = search.trim().toLowerCase();
    return findings.filter((f) => {
      if (typeFilter !== "all" && f.type !== typeFilter) return false;
      if (!q) return true;
      return f.name.toLowerCase().includes(q) || (f.address ?? "").toLowerCase().includes(q);
    });
  }, [findings, typeFilter, search]);

  return (
    <PanelCard
      title="Findings"
      description={
        findings
          ? `${filtered.length} shown${findings.length < total ? ` · ${total} in the ledger` : ""
          }`
          : "Structures and symbols from the engine"
      }
      icon={Braces}
      actions={
        <div className="flex items-center gap-1.5">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger
              aria-label="Filter findings by type"
              className="h-7 w-28 border-zinc-700 bg-zinc-950 text-xs"
            >
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent className="max-h-64 border-zinc-800 bg-zinc-900">
              <SelectItem value="all" className="text-xs">
                All types
              </SelectItem>
              {types.map((t) => (
                <SelectItem key={t} value={t} className="font-mono text-xs">
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            aria-label="Search findings"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Name or address…"
            className="h-7 w-28 border-zinc-700 bg-zinc-950 px-2 font-mono text-xs"
          />
        </div>
      }
      contentClassName="p-0!"
    >
      <div className="area-scroll max-h-[55vh] overflow-auto rounded-b-lg">
        {findings === null ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full bg-zinc-800/60" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="p-6 text-center text-xs text-zinc-500">
            {findings.length === 0
              ? "No findings yet — they appear once the AREA engine has analyzed this target."
              : "No findings match the current filters."}
          </p>
        ) : (
          <Table className="min-w-[440px]">
            <TableHeader className="sticky top-0 z-10 bg-zinc-900">
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="text-zinc-500">Name</TableHead>
                <TableHead className="w-28 text-zinc-500">Type</TableHead>
                <TableHead className="w-32 text-zinc-500">Address</TableHead>
                <TableHead className="w-16 text-zinc-500">Size</TableHead>
                <TableHead className="w-16 text-zinc-500">Meta</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((f) => (
                <FindingsRow key={f.id} finding={f} />
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </PanelCard>
  );
}

function FindingsRow({ finding }: { finding: Finding }) {
  const [open, setOpen] = React.useState(false);
  const meta = prettyJson(finding.meta);
  return (
    <TableRow className="border-zinc-800/70">
      <TableCell className="max-w-[180px] font-mono text-[11px] break-all text-zinc-200">
        <span className="block truncate" title={finding.name}>
          {finding.name}
        </span>
      </TableCell>
      <TableCell>
        <Badge
          variant="outline"
          className="border-emerald-500/30 bg-emerald-500/10 font-mono text-[9px] text-emerald-400"
        >
          {finding.type}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-[11px] text-zinc-500">
        {finding.address ? (
          <span className="flex items-center gap-0.5">
            <span className="truncate">{finding.address}</span>
            <CopyButton value={finding.address} label="Copy address" className="size-5" />
          </span>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="font-mono text-[11px] text-zinc-500">
        {humanBytes(finding.sizeBytes)}
      </TableCell>
      <TableCell>
        {meta ? (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[10px] text-zinc-400 hover:text-zinc-100"
              >
                {open ? "Hide" : "View"}
                <ChevronDown
                  className={"size-3 transition-transform " + (open ? "rotate-180" : "")}
                  aria-hidden
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="area-scroll mt-1 mb-2 max-h-40 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed break-all whitespace-pre-wrap text-zinc-400">
                {meta}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <span className="text-[11px] text-zinc-600">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

const KIND_BORDER: Record<string, string> = {
  observed: "border-l-emerald-500",
  derived: "border-l-amber-500",
  inferred: "border-l-orange-500",
  unknown: "border-l-rose-500",
};

function EvidenceTab({ targetId }: { targetId: string }) {
  const [evidence, setEvidence] = React.useState<EvidenceRow[] | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    apiGet<{ evidence: EvidenceRow[] }>(`/api/targets/${targetId}/evidence`)
      .then((res) => {
        if (!cancelled) setEvidence(res.evidence);
      })
      .catch((err) => {
        if (!cancelled) {
          toastError(err, "Could not load evidence");
          setEvidence([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [targetId]);

  if (evidence === null) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full bg-zinc-800/50" />
        ))}
      </div>
    );
  }

  if (evidence.length === 0) {
    return (
      <EmptyState
        icon={Eye}
        title="No evidence recorded"
        description="The evidence ledger fills up as the AREA engine investigates this target. Every claim in the final report must cite one of these rows."
        className="px-4 py-8"
      />
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] leading-relaxed text-zinc-500">
        {evidence.length} entr{evidence.length === 1 ? "y" : "ies"} ·
        <span className="text-emerald-400"> observed</span> = read directly ·
        <span className="text-amber-400"> derived</span> = computed ·
        <span className="text-orange-400"> inferred</span> = hypothesis ·
        <span className="text-rose-400"> unknown</span> = unresolved
      </p>
      <div className="space-y-2">
        {evidence.map((row) => {
          const kind = (row.kind ?? "unknown").toLowerCase();
          return (
            <Card
              key={row.id}
              className={
                "gap-2 border-zinc-800 border-l-4 bg-zinc-900/60 py-2.5 transition-colors hover:bg-zinc-900 " +
                (KIND_BORDER[kind] ?? "border-l-zinc-600")
              }
            >
              <CardContent className="space-y-1.5 px-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <EvidenceKindBadge kind={row.kind} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200" title={row.operation}>
                    {row.operation}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <ConfidenceBadge confidence={row.confidence} />
                    <span className="text-[10px] text-zinc-600">{timeAgo(row.createdAt)}</span>
                  </span>
                </div>
                {row.subjectName && (
                  <p className="truncate font-mono text-[10px] text-zinc-500" title={row.subjectName}>
                    on {row.subjectName}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-zinc-500">
                  <span className="truncate font-mono">evidenceId: {row.evidenceId}</span>
                  {row.predicateType && <span className="truncate font-mono">predicate: {row.predicateType}</span>}
                  {row.authority && <span>authority: {row.authority}</span>}
                </div>
                {row.payload && (
                  <Collapsible>
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 gap-1 px-1.5 text-[10px] text-zinc-400 hover:text-zinc-100"
                      >
                        Payload
                        <ChevronDown
                          className="size-3 transition-transform [[data-state=open]>&]:rotate-180"
                          aria-hidden
                        />
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <ScrollArea className="mt-1 max-h-44 rounded-md border border-zinc-800 bg-zinc-950">
                        <pre className="p-2 font-mono text-[10px] leading-relaxed break-all whitespace-pre-wrap text-zinc-400">
                          {prettyJson(row.payload)}
                        </pre>
                      </ScrollArea>
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------

function DocsTab({
  docs,
  summary,
  generating,
  onGenerate,
}: {
  docs: string | null;
  summary: string | null;
  generating: boolean;
  onGenerate: () => void;
}) {
  if (generating) {
    return (
      <div className="space-y-2.5">
        <div className="flex items-center gap-2 text-xs text-amber-400">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          The AREA engine is synthesizing documentation from the evidence ledger…
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton
            key={i}
            className={"h-3.5 bg-zinc-800/50 " + (i % 3 === 0 ? "w-2/3" : i % 3 === 1 ? "w-full" : "w-5/6")}
          />
        ))}
      </div>
    );
  }

  if (!docs) {
    return (
      <EmptyState
        icon={BookOpen}
        title="No documentation yet"
        description="Generate a structured reverse-engineering report: what the artifact is, how the engine investigated it, key findings with evidence references, and honest limitations."
        action={
          <Button
            size="sm"
            className="h-8 bg-amber-600 text-xs text-white hover:bg-amber-500"
            onClick={onGenerate}
          >
            <BookOpen className="size-3.5" aria-hidden />
            Generate documentation
          </Button>
        }
        className="px-4 py-8"
      />
    );
  }

  return (
    <div className="space-y-2.5">
      {summary && (
        <Alert className="border-emerald-500/30 bg-emerald-500/5 px-3 py-2">
          <AlertTitle className="text-xs text-emerald-400">Summary</AlertTitle>
          <AlertDescription className="text-xs text-zinc-400">{summary}</AlertDescription>
        </Alert>
      )}
      <PanelCard
        title="Generated documentation"
        description="AI synthesis grounded in evidence"
        icon={BookOpen}
        actions={<CopyButton value={docs} label="Copy markdown" className="size-7" />}
        contentClassName="px-3!"
      >
        <div className="area-scroll max-h-[55vh] overflow-y-auto">
          <Markdown className="text-xs">{docs}</Markdown>
        </div>
      </PanelCard>
    </div>
  );
}
