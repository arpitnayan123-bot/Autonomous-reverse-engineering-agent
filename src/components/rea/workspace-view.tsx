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
import { useReaStore } from "@/store/rea-store";
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
} from "@/components/rea/shared";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const HEX_PAGE_BYTES = 256; // 16 bytes × 16 rows
const STRINGS_PAGE_SIZE = 100;

function isRunActive(status: string | null | undefined): boolean {
  return status === "running" || status === "queued" || status === "analyzing";
}

export function WorkspaceView() {
  const { activeTargetId, setView } = useReaStore();
  const [target, setTarget] = React.useState<TargetDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [tab, setTab] = React.useState("overview");
  const [goalOpen, setGoalOpen] = React.useState(false);
  const [goal, setGoal] = React.useState("");
  const [rerunning, setRerunning] = React.useState(false);
  const [docs, setDocs] = React.useState<string | null>(null);
  const [docsSummary, setDocsSummary] = React.useState<string | null>(null);
  const [generatingDocs, setGeneratingDocs] = React.useState(false);

  const fetchTarget = React.useCallback(async () => {
    if (!activeTargetId) {
      setLoading(false);
      return;
    }
    try {
      const res = await apiGet<{ target: TargetDetail }>(`/api/targets/${activeTargetId}`);
      setTarget(res.target);
    } catch (err) {
      toastError(err, "Could not load target");
    } finally {
      setLoading(false);
    }
  }, [activeTargetId]);

  React.useEffect(() => {
    setLoading(true);
    setTarget(null);
    setDocs(null);
    setDocsSummary(null);
    setTab("overview");
    void fetchTarget();
  }, [fetchTarget]);

  // Poll while the latest run is active so the overview progress updates live.
  const running = isRunActive(target?.runs?.[0]?.status);
  React.useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => void fetchTarget(), 4000);
    return () => window.clearInterval(interval);
  }, [running, fetchTarget]);

  // Hydrate existing documentation (endpoint may not exist yet — fail silently).
  React.useEffect(() => {
    if (!activeTargetId) return;
    let cancelled = false;
    apiGet<{ docs: string; summary?: string }>(`/api/targets/${activeTargetId}/docs`)
      .then((res) => {
        if (!cancelled && res.docs) {
          setDocs(res.docs);
          if (res.summary) setDocsSummary(res.summary);
        }
      })
      .catch(() => {
        /* no docs yet */
      });
    return () => {
      cancelled = true;
    };
  }, [activeTargetId]);

  const generateDocs = async () => {
    if (!activeTargetId || generatingDocs) return;
    setGeneratingDocs(true);
    setTab("docs");
    try {
      const res = await apiPost<{ docs: string; summary?: string }>(
        `/api/targets/${activeTargetId}/report`,
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
    if (!activeTargetId) return;
    setRerunning(true);
    try {
      await apiPost(`/api/targets/${activeTargetId}/analyze`, goal.trim() ? { goal: goal.trim() } : {});
      setGoalOpen(false);
      setGoal("");
      await fetchTarget();
    } catch (err) {
      toastError(err, "Could not start analysis");
    } finally {
      setRerunning(false);
    }
  };

  if (!activeTargetId) {
    return (
      <EmptyState
        icon={FolderOpen}
        title="No target selected"
        description="Pick a target from the dashboard to inspect its hex, strings, findings and evidence ledger."
        action={
          <Button className="bg-emerald-600 text-white hover:bg-emerald-500" onClick={() => setView("dashboard")}>
            <FolderOpen className="size-4" aria-hidden />
            Go to dashboard
          </Button>
        }
        className="mt-10"
      />
    );
  }

  if (loading && !target) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-2/3 bg-zinc-800/70" />
        <Skeleton className="h-4 w-1/3 bg-zinc-800/70" />
        <Skeleton className="h-64 w-full bg-zinc-800/50" />
      </div>
    );
  }

  if (!target) {
    return (
      <EmptyState
        icon={FileQuestion}
        title="Target not found"
        description="It may have been deleted. Head back to the dashboard and pick another target."
        action={
          <Button variant="outline" className="border-zinc-700" onClick={() => setView("dashboard")}>
            Back to dashboard
          </Button>
        }
        className="mt-10"
      />
    );
  }

  const latestRun = target.runs?.[0] ?? null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-mono text-lg font-semibold text-zinc-100">{target.originalName}</h2>
            <FormatBadge format={target.detectedFormat} label={target.formatLabel ?? undefined} />
            <StatusBadge status={latestRun?.status ?? target.status} />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
            <span className="font-mono">{humanBytes(target.sizeBytes)}</span>
            <span className="flex items-center gap-1 font-mono">
              <span className="text-zinc-600">sha256</span>
              <span className="text-zinc-400">{target.sha256 ? `${target.sha256.slice(0, 16)}…${target.sha256.slice(-8)}` : "—"}</span>
              <CopyButton value={target.sha256 ?? ""} label="Copy full SHA-256" />
            </span>
            <span>uploaded {timeAgo(target.createdAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Popover open={goalOpen} onOpenChange={setGoalOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-300"
                disabled={rerunning}
              >
                {rerunning ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
                Re-run analysis
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 border-zinc-800 bg-zinc-900">
              <div className="space-y-3">
                <p className="text-xs font-medium text-zinc-200">Optional goal</p>
                <Input
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="e.g. focus on network-related functionality"
                  className="border-zinc-800 bg-zinc-950 text-xs"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void rerun();
                  }}
                />
                <Button className="w-full bg-emerald-600 text-white hover:bg-emerald-500" onClick={() => void rerun()} disabled={rerunning}>
                  {rerunning && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  Start REA investigation
                </Button>
              </div>
            </PopoverContent>
          </Popover>
          <Button variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 hover:text-amber-300" onClick={() => void generateDocs()} disabled={generatingDocs}>
            {generatingDocs ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <BookOpen className="size-4" aria-hidden />}
            Generate documentation
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto w-full flex-wrap justify-start gap-1 bg-zinc-950 max-md:grid max-md:grid-cols-3">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="hex">Hex</TabsTrigger>
          <TabsTrigger value="strings">Strings</TabsTrigger>
          <TabsTrigger value="findings">Findings</TabsTrigger>
          <TabsTrigger value="evidence">Evidence</TabsTrigger>
          <TabsTrigger value="docs">Docs</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <OverviewTab target={target} latestRun={latestRun} />
        </TabsContent>
        <TabsContent value="hex" className="mt-4">
          <HexTab targetId={target.id} />
        </TabsContent>
        <TabsContent value="strings" className="mt-4">
          <StringsTab targetId={target.id} />
        </TabsContent>
        <TabsContent value="findings" className="mt-4">
          <FindingsTab targetId={target.id} />
        </TabsContent>
        <TabsContent value="evidence" className="mt-4">
          <EvidenceTab targetId={target.id} />
        </TabsContent>
        <TabsContent value="docs" className="mt-4">
          <DocsTab docs={docs} summary={docsSummary} generating={generatingDocs} onGenerate={() => void generateDocs()} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

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

function OverviewTab({ target, latestRun }: { target: TargetDetail; latestRun: Run | null }) {
  const [counts, setCounts] = React.useState<{ type: string; count: number }[] | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    apiGet<{ findings: Finding[] }>(`/api/targets/${target.id}/findings`, { limit: 500 })
      .then((res) => {
        if (cancelled) return;
        const byType = new Map<string, number>();
        for (const f of res.findings) byType.set(f.type, (byType.get(f.type) ?? 0) + 1);
        setCounts([...byType.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count));
      })
      .catch(() => {
        if (!cancelled) setCounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [target.id]);

  const limitations = extractLimitations(latestRun?.result);

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <SectionCard title="Format detection" description="Magic-byte analysis performed on upload" icon={TargetIcon}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <FormatBadge format={target.detectedFormat} label={target.formatLabel ?? undefined} />
            {target.formatConfidence && (
              <Badge variant="outline" className="text-[11px] text-zinc-400 border-zinc-700">
                confidence: <span className="text-zinc-200">{target.formatConfidence}</span>
              </Badge>
            )}
            {target.formatFamily && (
              <Badge variant="outline" className="text-[11px] text-zinc-400 border-zinc-700 font-mono">
                family: <span className="text-zinc-200">{target.formatFamily}</span>
              </Badge>
            )}
          </div>
          <p className="text-xs leading-relaxed text-zinc-400">
            {target.formatDetails ?? target.summary ?? "No additional format details recorded."}
          </p>
        </div>
      </SectionCard>

      <SectionCard title="Latest run" description={latestRun ? `Run ${latestRun.id.slice(0, 8)} · started ${timeAgo(latestRun.createdAt)}` : "No analysis run yet"} icon={Zap}>
        {latestRun ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <StatusBadge status={latestRun.status} />
              <span className="font-mono text-zinc-500">
                {humanDuration(latestRun.durationMs)} · {latestRun.progress ?? 0}%
              </span>
            </div>
            {isRunActive(latestRun.status) && (
              <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                  style={{ width: `${Math.min(100, latestRun.progress ?? 0)}%` }}
                />
              </div>
            )}
            <p className="text-xs text-zinc-400">
              {latestRun.currentStep ?? (isRunActive(latestRun.status) ? "Working…" : latestRun.error ? "—" : "Finished.")}
            </p>
            {latestRun.error && (
              <Alert variant="destructive" className="border-rose-500/40 bg-rose-500/10">
                <AlertTitle className="text-xs text-rose-300">Run failed</AlertTitle>
                <AlertDescription className="font-mono text-[11px] text-rose-300/80">
                  {latestRun.error}
                </AlertDescription>
              </Alert>
            )}
          </div>
        ) : (
          <p className="text-xs text-zinc-500">
            Use <span className="font-mono text-zinc-300">Re-run analysis</span> above to send this artifact through the REA engine.
          </p>
        )}
      </SectionCard>

      <SectionCard title="Findings by type" description="Quick counts from the findings ledger" icon={Braces}>
        {counts === null ? (
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-24 bg-zinc-800/70" />
            ))}
          </div>
        ) : counts.length === 0 ? (
          <p className="text-xs text-zinc-500">No findings recorded yet. Run the analysis first.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {counts.map(({ type, count }) => (
              <Badge key={type} variant="outline" className="gap-1.5 border-zinc-800 bg-zinc-950 font-mono text-[11px] text-zinc-300">
                {type}
                <span className="rounded bg-emerald-500/15 px-1.5 text-emerald-400">{count}</span>
              </Badge>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Analysis limitations" description="Honest boundaries of what the engine could establish" icon={Eye}>
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
      </SectionCard>
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
    <SectionCard
      title="Hex viewer"
      description={`${humanBytes(fileSize)} · ${HEX_PAGE_BYTES} bytes per page`}
      icon={ScrollText}
      actions={
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" className="h-7 border-zinc-700 px-2 text-xs" disabled={offset <= 0 || loading} onClick={() => setOffset(Math.max(0, offset - HEX_PAGE_BYTES))}>
            <ChevronLeft className="size-3.5" aria-hidden />
            Prev
          </Button>
          <Button variant="outline" size="sm" className="h-7 border-zinc-700 px-2 text-xs" disabled={offset >= maxOffset || loading} onClick={() => setOffset(Math.min(maxOffset, offset + HEX_PAGE_BYTES))}>
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
            className="h-7 w-24 border-zinc-700 bg-zinc-950 font-mono text-xs"
          />
        </div>
      }
      contentClassName="p-0!"
    >
      <div className="rea-scroll max-h-[60vh] overflow-auto rounded-b-lg">
        {loading && !page ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full bg-zinc-800/60" />
            ))}
          </div>
        ) : !page || page.hex.length === 0 ? (
          <p className="p-6 text-center text-xs text-zinc-500">No hex content available.</p>
        ) : (
          <table className="w-full border-collapse font-mono text-xs">
            <tbody>
              {page.hex.map((row) => (
                <tr key={row.offset} className="border-b border-zinc-900/80 hover:bg-zinc-900/50">
                  <td className="w-24 px-3 py-1 text-right text-zinc-600 select-all">
                    {row.offset.toString(16).padStart(8, "0")}
                  </td>
                  <td className="px-3 py-1 text-zinc-300 select-all">
                    {row.bytes.map((b, i) => (
                      <span key={i} className={b === 0 ? "text-zinc-600" : b >= 32 && b < 127 ? "" : "text-amber-400/80"}>
                        {b.toString(16).padStart(2, "0")}
                        {i === 7 ? "  " : " "}
                      </span>
                    ))}
                  </td>
                  <td className="w-40 px-3 py-1 text-zinc-500 select-all">{row.ascii}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </SectionCard>
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
    <SectionCard
      title="Extracted strings"
      description={data ? `${data.total} string${data.total === 1 ? "" : "s"} found` : "Searching printable sequences"}
      icon={ScrollText}
      actions={
        <Input
          aria-label="Search strings"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Filter strings…"
          className="h-8 w-44 border-zinc-700 bg-zinc-950 font-mono text-xs sm:w-60"
        />
      }
      contentClassName="p-0!"
    >
      <div className="rea-scroll max-h-[60vh] overflow-auto rounded-b-lg">
        {loading && !data ? (
          <div className="space-y-2 p-4">
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
                <TableHead className="w-28 text-zinc-500">Offset</TableHead>
                <TableHead className="text-zinc-500">Value</TableHead>
                <TableHead className="w-24 text-zinc-500">Encoding</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.strings.map((s, i) => (
                <TableRow key={`${s.offset}-${i}`} className="border-zinc-800/70">
                  <TableCell className="font-mono text-xs text-zinc-600">
                    0x{s.offset.toString(16).padStart(8, "0")}
                  </TableCell>
                  <TableCell className="max-w-0 font-mono text-xs break-all text-zinc-300">
                    <span className="block truncate">{s.value}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="border-zinc-800 font-mono text-[10px] text-zinc-500">
                      {s.encoding}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-2">
        <span className="font-mono text-[11px] text-zinc-500">
          page {data?.page ?? page} / {totalPages}
        </span>
        <div className="flex gap-1">
          <Button variant="outline" size="sm" className="h-7 border-zinc-700 px-2 text-xs" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            <ChevronLeft className="size-3.5" aria-hidden />
            Prev
          </Button>
          <Button variant="outline" size="sm" className="h-7 border-zinc-700 px-2 text-xs" disabled={!data || page >= totalPages || loading} onClick={() => setPage((p) => p + 1)}>
            Next
            <ChevronRight className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function FindingsTab({ targetId }: { targetId: string }) {
  const [findings, setFindings] = React.useState<Finding[] | null>(null);
  const [typeFilter, setTypeFilter] = React.useState("all");
  const [search, setSearch] = React.useState("");

  React.useEffect(() => {
    let cancelled = false;
    apiGet<{ findings: Finding[] }>(`/api/targets/${targetId}/findings`, { limit: 500 })
      .then((res) => {
        if (!cancelled) setFindings(res.findings);
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
    <SectionCard
      title="Findings"
      description={findings ? `${filtered.length} of ${findings.length} finding${findings.length === 1 ? "" : "s"}` : "Structures, symbols and artifacts reported by the engine"}
      icon={Braces}
      actions={
        <div className="flex items-center gap-2">
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger aria-label="Filter findings by type" className="h-8 w-40 border-zinc-700 bg-zinc-950 text-xs">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-900 max-h-64">
              <SelectItem value="all">All types</SelectItem>
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
            className="h-8 w-40 border-zinc-700 bg-zinc-950 font-mono text-xs"
          />
        </div>
      }
      contentClassName="p-0!"
    >
      <div className="rea-scroll max-h-[60vh] overflow-auto rounded-b-lg">
        {findings === null ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full bg-zinc-800/60" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="p-6 text-center text-xs text-zinc-500">
            {findings.length === 0
              ? "No findings yet — they appear once the REA engine has analyzed this target."
              : "No findings match the current filters."}
          </p>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-zinc-900">
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="text-zinc-500">Name</TableHead>
                <TableHead className="w-36 text-zinc-500">Type</TableHead>
                <TableHead className="w-40 text-zinc-500">Address</TableHead>
                <TableHead className="w-24 text-zinc-500">Size</TableHead>
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
    </SectionCard>
  );
}

function FindingsRow({ finding }: { finding: Finding }) {
  const [open, setOpen] = React.useState(false);
  const meta = prettyJson(finding.meta);
  return (
    <TableRow className="border-zinc-800/70">
      <TableCell className="max-w-[280px] font-mono text-xs break-all text-zinc-200">
        <span className="block truncate">{finding.name}</span>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 font-mono text-[10px] text-emerald-400">
          {finding.type}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-xs text-zinc-500">
        {finding.address ? (
          <span className="flex items-center gap-1">
            {finding.address}
            <CopyButton value={finding.address} label="Copy address" />
          </span>
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="font-mono text-xs text-zinc-500">{humanBytes(finding.sizeBytes)}</TableCell>
      <TableCell>
        {meta ? (
          <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[11px] text-zinc-400 hover:text-zinc-100">
                {open ? "Hide" : "View"}
                <ChevronDown className={"size-3 transition-transform " + (open ? "rotate-180" : "")} aria-hidden />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="rea-scroll mt-1 mb-2 max-h-48 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed text-zinc-400">
                {meta}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        ) : (
          <span className="text-xs text-zinc-600">—</span>
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
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full bg-zinc-800/50" />
        ))}
      </div>
    );
  }

  if (evidence.length === 0) {
    return (
      <EmptyState
        icon={Eye}
        title="No evidence recorded"
        description="The evidence ledger fills up as the REA engine investigates this target. Every claim in the final report must cite one of these rows."
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        {evidence.length} entr{evidence.length === 1 ? "y" : "ies"} in the evidence ledger ·
        <span className="text-emerald-400"> observed</span> = read directly from the artifact ·
        <span className="text-amber-400"> derived</span> = computed ·
        <span className="text-orange-400"> inferred</span> = best-effort hypothesis ·
        <span className="text-rose-400"> unknown</span> = unresolved
      </p>
      <div className="rea-scroll max-h-[65vh] space-y-2 overflow-y-auto pr-1">
        {evidence.map((row) => {
          const kind = (row.kind ?? "unknown").toLowerCase();
          return (
            <Card key={row.id} className={"border-zinc-800 border-l-2 bg-zinc-900/60 " + (KIND_BORDER[kind] ?? "border-l-zinc-600")}>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <EvidenceKindBadge kind={row.kind} />
                  <span className="font-mono text-xs text-zinc-200">{row.operation}</span>
                  {row.subjectName && (
                    <span className="font-mono text-[11px] text-zinc-500">on {row.subjectName}</span>
                  )}
                  <span className="ml-auto flex items-center gap-3">
                    <ConfidenceBadge confidence={row.confidence} />
                    <span className="text-[11px] text-zinc-600">{timeAgo(row.createdAt)}</span>
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-500">
                  <span className="font-mono">evidenceId: {row.evidenceId}</span>
                  {row.predicateType && <span className="font-mono">predicate: {row.predicateType}</span>}
                  {row.authority && <span>authority: {row.authority}</span>}
                </div>
                {row.payload && (
                  <Collapsible>
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[11px] text-zinc-400 hover:text-zinc-100">
                        Payload
                        <ChevronDown className="size-3 transition-transform [[data-state=open]>&]:rotate-180" aria-hidden />
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <ScrollArea className="mt-1 max-h-56 rounded-md border border-zinc-800 bg-zinc-950">
                        <pre className="p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-zinc-400">
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
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-xs text-amber-400">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          The REA engine is synthesizing documentation from the evidence ledger…
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className={"h-4 bg-zinc-800/50 " + (i % 3 === 0 ? "w-2/3" : i % 3 === 1 ? "w-full" : "w-5/6")} />
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
          <Button className="bg-amber-600 text-white hover:bg-amber-500" onClick={onGenerate}>
            <BookOpen className="size-4" aria-hidden />
            Generate documentation
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      {summary && (
        <Alert className="border-emerald-500/30 bg-emerald-500/5">
          <AlertTitle className="text-xs text-emerald-400">Summary</AlertTitle>
          <AlertDescription className="text-xs text-zinc-400">{summary}</AlertDescription>
        </Alert>
      )}
      <SectionCard
        title="Generated documentation"
        description="AI synthesis grounded in the evidence ledger"
        icon={BookOpen}
        actions={<CopyButton value={docs} label="Copy markdown" className="size-8" />}
      >
        <Markdown>{docs}</Markdown>
      </SectionCard>
    </div>
  );
}
