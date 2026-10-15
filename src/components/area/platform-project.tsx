"use client";

import * as React from "react";
import {
  Loader2, Play, Square, Trash2, ChevronDown, ChevronRight, Globe, Github,
  FileArchive, ScrollText, Network, Hammer, ShieldCheck, Compass, CheckCircle2,
  XCircle, Clock, PauseCircle, ExternalLink, TerminalSquare, FileCode2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  platformApi,
  type ProjectDetail, type OrchestrationView, type OrchestrationStepView,
  type CrawlPageView, type WorkspaceStatusView, type VerifyRunView,
  type GraphSnapshotView, type ResearchReportView,
} from "@/lib/platform-client";
import { toastError, timeAgo, humanBytes, humanDuration, Markdown } from "@/components/area/shared";
import { KindBadge } from "@/components/area/platform-view";
import { PlatformGraph } from "@/components/area/platform-graph";

/**
 * A single project's universal workspace: pipeline orchestration with human
 * approval gates, explorer, knowledge graph, research, builder (file editor +
 * terminal), and verifier — all talking to the real backend.
 */

const POLL_MS = 3_000;

export function PlatformProject({ projectId, onDeleted }: { projectId: string; onDeleted: () => void }) {
  const [detail, setDetail] = React.useState<ProjectDetail | null>(null);
  const [notFound, setNotFound] = React.useState(false);
  const [goal, setGoal] = React.useState("");
  const [starting, setStarting] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const d = await platformApi.getProject(projectId);
      setDetail(d);
      return d;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("404")) setNotFound(true);
      else toastError(err, "Could not load project");
      return null;
    }
  }, [projectId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Poll while a pipeline runs or waits for approval.
  const active = detail?.orchestrations.some((o) => o.status === "running" || o.status === "awaiting_approval") ?? false;
  React.useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [active, load]);

  const start = async () => {
    if (!goal.trim() || starting) return;
    setStarting(true);
    try {
      await platformApi.orchestrate(projectId, goal.trim());
      toast.success("Pipeline started");
      setGoal("");
      await load();
    } catch (err) {
      toastError(err, "Could not start pipeline");
    } finally {
      setStarting(false);
    }
  };

  const cancel = async (orchestrationId: string) => {
    try {
      await platformApi.orchestrateCancel(projectId, orchestrationId);
      toast.success("Cancelling pipeline…");
      await load();
    } catch (err) {
      toastError(err, "Could not cancel");
    }
  };

  const remove = async () => {
    try {
      await platformApi.deleteProject(projectId);
      toast.success("Project deleted");
      onDeleted();
    } catch (err) {
      toastError(err, "Could not delete project");
    }
  };

  if (notFound) {
    return <div className="grid h-full place-items-center text-sm text-zinc-500">Project not found.</div>;
  }
  if (!detail) {
    return (
      <div className="grid h-full place-items-center">
        <Loader2 className="size-5 animate-spin text-zinc-600" aria-hidden />
      </div>
    );
  }

  const latest = detail.orchestrations[0] ?? null;
  const p = detail.project;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="shrink-0 border-b border-zinc-800/80 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {p.kind === "github" ? <Github className="size-4 text-zinc-400" aria-hidden />
            : p.kind === "file" ? <FileArchive className="size-4 text-amber-400" aria-hidden />
            : <Globe className="size-4 text-emerald-400" aria-hidden />}
          <h2 className="text-sm font-semibold text-zinc-100">{p.name}</h2>
          <KindBadge kind={p.kind} />
          <a
            href={p.kind === "github" ? `https://github.com/${p.reference}` : p.kind === "website" ? p.reference : "#"}
            target="_blank" rel="noreferrer noopener"
            className="inline-flex items-center gap-1 font-mono text-[11px] text-zinc-500 hover:text-emerald-400"
          >
            {p.reference}
            <ExternalLink className="size-3" aria-hidden />
          </a>
          <span className="ml-auto flex items-center gap-1.5">
            <Badge variant="outline" className="text-[9px] text-zinc-400">
              {detail.counts.pages} pages · {detail.counts.nodes} nodes · {detail.counts.edges} edges
            </Badge>
            <Button variant="ghost" size="icon" className="size-7 text-zinc-500 hover:text-red-400" aria-label="Delete project" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          </span>
        </div>
      </div>

      {/* Stage rail */}
      <StageRail orchestration={latest} />

      {/* Body tabs */}
      <Tabs defaultValue="pipeline" className="flex min-h-0 flex-1 flex-col gap-0">
        <TabsList className="h-9 shrink-0 justify-start gap-0 rounded-none border-b border-zinc-800/80 bg-transparent p-0">
          {([
            { id: "pipeline", label: "Pipeline", icon: Compass },
            { id: "explorer", label: "Explorer", icon: Globe },
            { id: "graph", label: "Graph", icon: Network },
            { id: "research", label: "Research", icon: ScrollText },
            { id: "builder", label: "Builder", icon: Hammer },
            { id: "verify", label: "Verify", icon: ShieldCheck },
          ] as const).map((t) => (
            <TabsTrigger
              key={t.id}
              value={t.id}
              className="relative rounded-none border-0 bg-transparent px-3 py-2 font-mono text-[11px] tracking-wide text-zinc-500 shadow-none transition-colors data-[state=active]:bg-transparent data-[state=active]:text-emerald-300 data-[state=active]:shadow-none"
            >
              <t.icon className="mr-1 size-3.5" aria-hidden />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="pipeline" className="min-h-0 flex-1 overflow-y-auto area-scroll p-4">
          {/* Goal + start */}
          <div className="mb-4 flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 sm:flex-row">
            <Input
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void start(); }}
              placeholder="Goal — e.g. “research this product, map the site, reconstruct the core flow, and test it”"
              className="min-w-0 flex-1 border-zinc-800 bg-zinc-950 text-sm"
              aria-label="Pipeline goal"
            />
            <Button onClick={() => void start()} disabled={starting || !goal.trim() || active} className="shrink-0 bg-emerald-600 text-white hover:bg-emerald-500">
              {starting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
              Run pipeline
            </Button>
          </div>

          {detail.orchestrations.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-600">
              No pipeline runs yet. Give a goal above and run the full
              DISCOVER → VERIFY pipeline. PLAN and BUILD pause for your approval.
            </p>
          ) : (
            <div className="space-y-4">
              {detail.orchestrations.map((o) => (
                <OrchestrationCard
                  key={o.id}
                  orchestration={o}
                  projectId={projectId}
                  onChanged={load}
                  onCancel={() => void cancel(o.id)}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="explorer" className="min-h-0 flex-1 overflow-y-auto area-scroll">
          {p.kind === "website" ? <ExplorerPanel projectId={projectId} reference={p.reference} /> : <ReconPanel projectId={projectId} kind={p.kind} onChanged={load} />}
        </TabsContent>

        <TabsContent value="graph" className="min-h-0 flex-1 overflow-hidden">
          <GraphPanel projectId={projectId} counts={detail.counts} />
        </TabsContent>

        <TabsContent value="research" className="min-h-0 flex-1 overflow-y-auto area-scroll p-4">
          <ResearchPanel projectId={projectId} defaultQuery={p.description ?? ""} onChanged={load} />
        </TabsContent>

        <TabsContent value="builder" className="min-h-0 flex-1 overflow-hidden">
          <BuilderPanel projectId={projectId} />
        </TabsContent>

        <TabsContent value="verify" className="min-h-0 flex-1 overflow-y-auto area-scroll p-4">
          <VerifyPanel projectId={projectId} defaultUrl={p.kind === "website" ? p.reference : ""} onChanged={load} />
        </TabsContent>
      </Tabs>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent className="border-zinc-800 bg-zinc-950">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-zinc-100">Delete this project?</AlertDialogTitle>
            <AlertDialogDescription className="text-zinc-500">
              Removes the project, its crawled pages, graph, reports, and
              orchestrations. The isolated workspace files are also discarded.
              This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-zinc-800 bg-transparent text-zinc-300">Keep</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()} className="bg-red-600 text-white hover:bg-red-500">Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// --- Stage rail ---------------------------------------------------------------

function StageRail({ orchestration }: { orchestration: OrchestrationView | null }) {
  const stageState = new Map<string, string>();
  if (orchestration) {
    for (const s of orchestration.steps) {
      const prev = stageState.get(s.stage);
      // Worst-case wins within a stage.
      const rank = (st: string) => st === "failed" ? 4 : st === "running" ? 3 : st === "awaiting_approval" ? 3 : st === "done" ? 1 : 2;
      if (!prev || rank(s.status) > rank(prev)) stageState.set(s.stage, s.status);
    }
  }
  const stages = ["discover", "collect", "understand", "map", "research", "plan", "build", "test", "verify"];
  return (
    <div className="shrink-0 overflow-x-auto border-b border-zinc-800/80 bg-zinc-950/60 px-4 py-2 area-scroll">
      <div className="flex min-w-max items-center gap-1.5" role="list" aria-label="Pipeline stages">
        {stages.map((st, i) => {
          const state = stageState.get(st) ?? (orchestration ? "pending" : null);
          return (
            <React.Fragment key={st}>
              {i > 0 && <span aria-hidden className="h-px w-3 bg-zinc-800" />}
              <StageChip stage={st} state={state} />
            </React.Fragment>
          );
        })}
        {orchestration?.status === "awaiting_approval" && (
          <span className="ml-2 inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 font-mono text-[10px] text-amber-300">
            <PauseCircle className="size-3" aria-hidden /> awaiting your approval
          </span>
        )}
      </div>
    </div>
  );
}

function StageChip({ stage, state }: { stage: string; state: string | null }) {
  if (!state) {
    return <span className="rounded-md border border-zinc-800 bg-zinc-900/70 px-2 py-1 font-mono text-[10px] text-zinc-500">{stage}</span>;
  }
  if (state === "done") {
    return <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 font-mono text-[10px] text-emerald-300"><CheckCircle2 className="size-3" aria-hidden />{stage}</span>;
  }
  if (state === "running") {
    return <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 font-mono text-[10px] text-emerald-200"><Loader2 className="size-3 animate-spin" aria-hidden />{stage}</span>;
  }
  if (state === "failed") {
    return <span className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 font-mono text-[10px] text-red-400"><XCircle className="size-3" aria-hidden />{stage}</span>;
  }
  if (state === "awaiting_approval") {
    return <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 font-mono text-[10px] text-amber-300"><PauseCircle className="size-3" aria-hidden />{stage}</span>;
  }
  return <span className="rounded-md border border-zinc-800 bg-zinc-900/70 px-2 py-1 font-mono text-[10px] text-zinc-500">{stage}</span>;
}

// --- Orchestration card ---------------------------------------------------------

function OrchestrationCard({
  orchestration, projectId, onChanged, onCancel,
}: {
  orchestration: OrchestrationView;
  projectId: string;
  onChanged: () => Promise<ProjectDetail | null> | void;
  onCancel: () => void;
}) {
  const [openSteps, setOpenSteps] = React.useState<Record<string, boolean>>({});
  const o = orchestration;
  const statusStyle: Record<string, string> = {
    running: "border-emerald-500/40 text-emerald-300",
    completed: "border-emerald-500/40 text-emerald-400",
    failed: "border-red-500/40 text-red-400",
    cancelled: "border-zinc-700 text-zinc-500",
    awaiting_approval: "border-amber-500/40 text-amber-300",
  };

  const approve = async (stepId: string, approved: boolean) => {
    try {
      await platformApi.orchestrateApprove(projectId, o.id, stepId, approved);
      toast.success(approved ? "Approved — pipeline resumed" : "Rejected — pipeline stopped");
      await onChanged();
    } catch (err) {
      toastError(err, "Approval failed");
    }
  };

  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800/80 px-3 py-2.5">
        <Badge variant="outline" className={`text-[10px] ${statusStyle[o.status] ?? ""}`}>{o.status.replace("_", " ")}</Badge>
        <span className="min-w-0 flex-1 truncate text-xs text-zinc-300" title={o.goal}>{o.goal}</span>
        <span className="font-mono text-[10px] text-zinc-500">{timeAgo(o.createdAt)}</span>
        {(o.status === "running" || o.status === "awaiting_approval") && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-zinc-400 hover:text-red-400" onClick={onCancel}>
            <Square className="size-3" aria-hidden /> Cancel
          </Button>
        )}
      </div>
      <div className="px-3 pt-2">
        <Progress value={o.progress} className="h-1 bg-zinc-800 [&_[data-slot=progress-indicator]]:bg-emerald-500" aria-label={`Pipeline progress ${o.progress}%`} />
      </div>
      {o.error && (
        <p className="mx-3 mt-2 rounded-md border border-red-500/30 bg-red-500/5 px-2.5 py-2 font-mono text-[11px] text-red-300">{o.error}</p>
      )}
      <ul className="p-2">
        {o.steps.map((s) => (
          <StepRow
            key={s.id}
            step={s}
            open={openSteps[s.id] ?? false}
            onToggle={() => setOpenSteps((m) => ({ ...m, [s.id]: !m[s.id] }))}
            onApprove={(ok) => void approve(s.id, ok)}
          />
        ))}
      </ul>
    </div>
  );
}

function StepRow({ step, open, onToggle, onApprove }: { step: OrchestrationStepView; open: boolean; onToggle: () => void; onApprove: (approved: boolean) => void }) {
  const icon = (() => {
    switch (step.status) {
      case "done": return <CheckCircle2 className="size-3.5 text-emerald-400" aria-hidden />;
      case "running": return <Loader2 className="size-3.5 animate-spin text-emerald-300" aria-hidden />;
      case "failed": return <XCircle className="size-3.5 text-red-400" aria-hidden />;
      case "awaiting_approval": return <PauseCircle className="size-3.5 text-amber-300" aria-hidden />;
      case "cancelled": return <XCircle className="size-3.5 text-zinc-600" aria-hidden />;
      case "skipped": return <XCircle className="size-3.5 text-zinc-600" aria-hidden />;
      default: return <Clock className="size-3.5 text-zinc-600" aria-hidden />;
    }
  })();

  const outputJson = step.output ? pretty(step.output) : null;

  return (
    <li className="rounded-lg">
      <div className="flex items-center gap-2 px-2 py-1.5">
        {icon}
        <Badge variant="outline" className="border-zinc-800 px-1.5 py-0 font-mono text-[9px] text-zinc-500">{step.stage}</Badge>
        <button type="button" onClick={onToggle} className="min-w-0 flex-1 truncate text-left font-mono text-[11px] text-zinc-300 hover:text-emerald-300" aria-expanded={open}>
          {step.name}
          {step.attempts > 1 && <span className="ml-1.5 text-[9px] text-amber-400">×{step.attempts}</span>}
        </button>
        {step.durationMs != null && <span className="font-mono text-[9px] text-zinc-600">{humanDuration(step.durationMs)}</span>}
        {(step.status === "awaiting_approval") && (
          <span className="flex items-center gap-1">
            <Button size="sm" className="h-6 bg-emerald-600 px-2 text-[10px] text-white hover:bg-emerald-500" onClick={() => onApprove(true)}>Approve</Button>
            <Button size="sm" variant="outline" className="h-6 border-zinc-700 px-2 text-[10px] text-zinc-300" onClick={() => onApprove(false)}>Reject</Button>
          </span>
        )}
        {open ? <ChevronDown className="size-3 text-zinc-600" aria-hidden /> : <ChevronRight className="size-3 text-zinc-600" aria-hidden />}
      </div>
      {step.error && (
        <p className="mx-2 mb-1 rounded-md border border-red-500/30 bg-red-500/5 px-2 py-1.5 font-mono text-[10px] text-red-300">{step.error}</p>
      )}
      {open && (
        <div className="mx-2 mb-2 rounded-md border border-zinc-800 bg-zinc-950 p-2">
          {outputJson ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-zinc-400 area-scroll">{outputJson}</pre>
          ) : (
            <p className="font-mono text-[10px] text-zinc-600">no output recorded</p>
          )}
        </div>
      )}
    </li>
  );
}

function pretty(v: unknown): string {
  try {
    const json = JSON.stringify(v, null, 1);
    return json.length > 12_000 ? json.slice(0, 12_000) + "\n…[truncated]" : json;
  } catch {
    return String(v);
  }
}

// --- Explorer panel (websites) ---------------------------------------------------

function ExplorerPanel({ projectId, reference }: { projectId: string; reference: string }) {
  const [pages, setPages] = React.useState<CrawlPageView[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [render, setRender] = React.useState(true);
  const [maxPages, setMaxPages] = React.useState("12");
  const [maxDepth, setMaxDepth] = React.useState("2");
  const [screenshot, setScreenshot] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      setPages(await platformApi.listCrawlPages(projectId));
    } catch (err) {
      toastError(err, "Could not load crawled pages");
      setPages([]);
    }
  }, [projectId]);

  React.useEffect(() => { void load(); }, [load]);

  const run = async () => {
    setBusy(true);
    setScreenshot(null);
    try {
      const r = await platformApi.crawl(projectId, {
        maxPages: Number(maxPages) || 12,
        maxDepth: Number(maxDepth) || 2,
        render,
      });
      toast.success(`Crawled ${r.summary.pages} pages · ${r.summary.tech.length} tech signals`);
      if (r.render?.available && r.render.screenshotBase64) {
        setScreenshot(`data:image/png;base64,${r.render.screenshotBase64}`);
      } else if (render && r.render && !r.render.available) {
        toast.message("Browser render unavailable", { description: r.render.detail?.slice(0, 160) });
      }
      await load();
    } catch (err) {
      toastError(err, "Crawl failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4">
      <div className="mb-3 flex flex-wrap items-end gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
        <label className="block w-24">
          <span className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-zinc-500">Max pages</span>
          <Input value={maxPages} onChange={(e) => setMaxPages(e.target.value)} inputMode="numeric" className="h-8 border-zinc-800 bg-zinc-950 text-xs" />
        </label>
        <label className="block w-20">
          <span className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-zinc-500">Depth</span>
          <Input value={maxDepth} onChange={(e) => setMaxDepth(e.target.value)} inputMode="numeric" className="h-8 border-zinc-800 bg-zinc-950 text-xs" />
        </label>
        <label className="flex h-8 items-center gap-1.5 text-[11px] text-zinc-400">
          <input type="checkbox" checked={render} onChange={(e) => setRender(e.target.checked)} className="accent-emerald-500" />
          headless render + screenshot
        </label>
        <Button onClick={() => void run()} disabled={busy} className="ml-auto h-8 bg-emerald-600 text-white hover:bg-emerald-500">
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          Crawl {reference.replace(/^https?:\/\//, "").slice(0, 24)}
        </Button>
      </div>

      {screenshot && (
        <div className="mb-3 overflow-hidden rounded-xl border border-zinc-800">
          <p className="border-b border-zinc-800/80 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">Live render — {reference}</p>
          <img src={screenshot} alt={`Headless Chromium render of ${reference}`} className="max-h-80 w-full object-cover object-top" />
        </div>
      )}

      {pages === null ? (
        <div className="grid place-items-center py-10"><Loader2 className="size-4 animate-spin text-zinc-600" aria-hidden /></div>
      ) : pages.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-600">Nothing crawled yet.</p>
      ) : (
        <ul className="space-y-1" aria-label="Crawled pages">
          {pages.map((pg) => (
            <li key={pg.id} className="rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <StatusDot status={pg.status} />
                <a href={pg.url} target="_blank" rel="noreferrer noopener" className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-300 hover:text-emerald-300">{pg.url}</a>
                <span className="font-mono text-[9px] text-zinc-600">d{pg.depth}</span>
              </div>
              {pg.title && <p className="mt-0.5 truncate text-[11px] text-zinc-400">{pg.title}</p>}
              {pg.tech.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {pg.tech.slice(0, 8).map((t) => (
                    <span key={t} className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[9px] text-teal-300">{t}</span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: number }) {
  const cls = status >= 200 && status < 400 ? "bg-emerald-500" : status === 0 ? "bg-red-500" : "bg-amber-500";
  return (
    <span className="inline-flex items-center gap-1" title={`HTTP ${status}`}>
      <span className={`size-1.5 rounded-full ${cls}`} aria-hidden />
      <span className="font-mono text-[9px] text-zinc-600">{status}</span>
    </span>
  );
}

// --- Recon panel (github / file) ---------------------------------------------------

function ReconPanel({ projectId, kind, onChanged }: { projectId: string; kind: string; onChanged: () => void }) {
  const [status, setStatus] = React.useState<WorkspaceStatusView | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [summary, setSummary] = React.useState<Record<string, unknown> | null>(null);

  const load = React.useCallback(async () => {
    try {
      setStatus(await platformApi.workspaceStatus(projectId));
    } catch {
      setStatus({ exists: false, fileCount: 0, hasManifest: false, manifestKind: null, topEntries: [] });
    }
  }, [projectId]);

  React.useEffect(() => { void load(); }, [load]);

  const act = async (action: "materialize" | "parse") => {
    setBusy(action);
    try {
      const r = await platformApi.recon(projectId, action);
      if (!r.ok) {
        toast.error(r.detail ?? `${action} failed`);
      } else if (action === "parse" && r.summary) {
        setSummary(r.summary as Record<string, unknown>);
        toast.success("Source parsed into the knowledge graph");
      } else {
        toast.success(r.detail ?? "Materialized into the workspace");
      }
      await load();
      onChanged();
    } catch (err) {
      toastError(err, `${action} failed`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
        {kind === "github" ? (
          <Button onClick={() => void act("materialize")} disabled={busy !== null} className="h-8 bg-emerald-600 text-white hover:bg-emerald-500">
            {busy === "materialize" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Github className="size-3.5" aria-hidden />}
            Materialize repository (tarball → workspace)
          </Button>
        ) : (
          <Button onClick={() => void act("materialize")} disabled={busy !== null} className="h-8 bg-emerald-600 text-white hover:bg-emerald-500">
            {busy === "materialize" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <FileArchive className="size-3.5" aria-hidden />}
            Copy target into workspace
          </Button>
        )}
        <Button onClick={() => void act("parse")} disabled={busy !== null} variant="outline" className="h-8 border-zinc-700 text-zinc-200">
          {busy === "parse" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <FileCode2 className="size-3.5" aria-hidden />}
          Parse source (tree-sitter → graph)
        </Button>
        {status && (
          <span className="ml-auto font-mono text-[10px] text-zinc-500">
            workspace: {status.exists ? `${status.fileCount} files${status.manifestKind ? ` · ${status.manifestKind}` : ""}` : "empty"}
          </span>
        )}
      </div>

      {summary && (
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {([
            ["files parsed", summary.filesParsed],
            ["symbols", summary.symbols],
            ["endpoints", Array.isArray(summary.endpoints) ? (summary.endpoints as unknown[]).length : 0],
            ["secret candidates", Array.isArray(summary.secretCandidates) ? (summary.secretCandidates as unknown[]).length : 0],
          ] as const).map(([label, v]) => (
            <div key={label} className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-center">
              <p className="text-lg font-semibold text-emerald-300">{String(v ?? 0)}</p>
              <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">{label}</p>
            </div>
          ))}
        </div>
      )}

      <p className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-[11px] leading-relaxed text-zinc-600">
        Parsing uses tree-sitter WASM grammars (22+ languages). Symbols and
        imports are recorded as OBSERVED; framework routes as DERIVED; secret
        patterns as UNKNOWN — flagged for human review, never auto-confirmed.
        Parsed source is never executed.
      </p>
    </div>
  );
}

// --- Graph panel -----------------------------------------------------------------

function GraphPanel({ projectId, counts }: { projectId: string; counts: { nodes: number; edges: number } }) {
  const [graph, setGraph] = React.useState<GraphSnapshotView | null>(null);

  const load = React.useCallback(async () => {
    try {
      setGraph(await platformApi.graph(projectId));
    } catch (err) {
      toastError(err, "Could not load graph");
      setGraph({ nodes: [], edges: [] });
    }
  }, [projectId]);

  React.useEffect(() => { void load(); }, [load]);

  if (!graph) {
    return <div className="grid h-full place-items-center"><Loader2 className="size-4 animate-spin text-zinc-600" aria-hidden /></div>;
  }
  if (graph.nodes.length === 0) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <Network className="mx-auto size-8 text-zinc-700" aria-hidden />
          <p className="mt-3 text-xs text-zinc-500">
            The knowledge graph is empty. Run the explorer or the recon parser —
            every page, symbol, endpoint, and technology lands here with provenance.
          </p>
        </div>
      </div>
    );
  }
  return <PlatformGraph snapshot={graph} />;
}

// --- Research panel ---------------------------------------------------------------

function ResearchPanel({ projectId, defaultQuery, onChanged }: { projectId: string; defaultQuery: string; onChanged: () => void }) {
  const [query, setQuery] = React.useState(defaultQuery);
  const [busy, setBusy] = React.useState(false);
  const [reports, setReports] = React.useState<ResearchReportView[] | null>(null);

  const load = React.useCallback(async () => {
    try {
      setReports(await platformApi.listResearch(projectId));
    } catch {
      setReports([]);
    }
  }, [projectId]);

  React.useEffect(() => { void load(); }, [load]);

  const run = async () => {
    if (!query.trim() || busy) return;
    setBusy(true);
    try {
      const r = await platformApi.research(projectId, query.trim());
      toast.success(`Report ready — ${r.result.sources.length} sources`);
      await load();
      onChanged();
    } catch (err) {
      toastError(err, "Research failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void run(); }}
          placeholder="Research query — mentions of owner/repo or YouTube links are auto-analyzed"
          className="min-w-0 flex-1 border-zinc-800 bg-zinc-950 text-sm"
          aria-label="Research query"
        />
        <Button onClick={() => void run()} disabled={busy || !query.trim()} className="bg-emerald-600 text-white hover:bg-emerald-500">
          {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ScrollText className="size-4" aria-hidden />}
          Research
        </Button>
      </div>

      {reports === null ? (
        <div className="grid place-items-center py-8"><Loader2 className="size-4 animate-spin text-zinc-600" aria-hidden /></div>
      ) : reports.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-xs text-zinc-600">
          No reports yet. Every report is synthesized with citations; unsourced
          claims are marked UNKNOWN, never invented.
        </p>
      ) : (
        reports.map((r) => (
          <Collapsible key={r.id} className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
            <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-zinc-900/60">
              <ScrollText className="size-3.5 shrink-0 text-emerald-400" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">{r.query}</span>
              <span className="font-mono text-[9px] text-zinc-600">{r.sources.length} sources · {timeAgo(r.createdAt)}</span>
              <ChevronDown className="size-3.5 text-zinc-600" aria-hidden />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="border-t border-zinc-800/80 px-3 py-3">
                <Markdown>{r.reportMd ?? "(empty report)"}</Markdown>
                <div className="mt-3 space-y-1">
                  {r.sources.slice(0, 12).map((s, i) => (
                    <a key={i} href={s.url} target="_blank" rel="noreferrer noopener" className="flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-zinc-900">
                      <Badge variant="outline" className="shrink-0 border-zinc-800 text-[8px] uppercase text-zinc-500">{s.kind}</Badge>
                      <span className="min-w-0 truncate text-[11px] text-zinc-400 hover:text-emerald-300">{s.title}</span>
                    </a>
                  ))}
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        ))
      )}
    </div>
  );
}

// --- Builder panel ------------------------------------------------------------------

function BuilderPanel({ projectId }: { projectId: string }) {
  const [status, setStatus] = React.useState<WorkspaceStatusView | null>(null);
  const [entries, setEntries] = React.useState<{ path: string; type: string; sizeBytes?: number }[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [content, setContent] = React.useState("");
  const [dirty, setDirty] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [cmd, setCmd] = React.useState("");
  const [termLines, setTermLines] = React.useState<string[]>([]);

  const refresh = React.useCallback(async () => {
    try {
      const s = await platformApi.workspaceStatus(projectId);
      setStatus(s);
      setEntries(s.topEntries);
    } catch {
      setStatus(null);
    }
  }, [projectId]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  const openFile = async (path: string) => {
    try {
      const r = await platformApi.workspaceRead(projectId, path);
      setSelected(path);
      setContent(r.content);
      setDirty(false);
    } catch (err) {
      toastError(err, "Could not read file");
    }
  };

  const save = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await platformApi.workspaceWrite(projectId, selected, content);
      toast.success(`Saved ${selected}`);
      setDirty(false);
      await refresh();
    } catch (err) {
      toastError(err, "Could not save file");
    } finally {
      setBusy(false);
    }
  };

  const runCmd = async () => {
    if (!cmd.trim()) return;
    const line = `$ ${cmd}`;
    setTermLines((l) => [...l.slice(-80), line]);
    setCmd("");
    try {
      const r = await platformApi.workspaceTerminal(projectId, cmd);
      const out = [
        r.stdout.trim(),
        r.stderr.trim() ? `[stderr] ${r.stderr.trim()}` : "",
        r.blocked ? `[blocked] ${r.blocked}` : "",
        `[exit ${r.exitCode}${r.timedOut ? " · timeout" : ""} · ${r.durationMs}ms]`,
      ].filter(Boolean).join("\n");
      setTermLines((l) => [...l, out || "(no output)"].slice(-120));
    } catch (err) {
      toastError(err, "Command failed");
    }
  };

  return (
    <div className="flex h-full min-h-0">
      {/* File tree */}
      <div className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-zinc-800/80">
        <div className="flex h-8 shrink-0 items-center justify-between border-b border-zinc-800/80 px-2.5">
          <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">Workspace</span>
          <button onClick={() => void refresh()} className="text-zinc-500 hover:text-emerald-400" aria-label="Refresh workspace">
            <Loader2 className={status ? "size-3" : "size-3 animate-spin"} aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto area-scroll p-1.5">
          {status && !status.exists && (
            <p className="p-2 text-[10px] leading-relaxed text-zinc-600">
              Workspace is empty. Run the pipeline (or the Explorer → materialize
              action) to populate it.
            </p>
          )}
          {status?.exists && (
            <p className="px-2 py-1 font-mono text-[9px] text-zinc-600">
              {status.fileCount} files{status.manifestKind ? ` · ${status.manifestKind}` : ""}
            </p>
          )}
          <ul aria-label="Workspace files">
            {entries.filter((e) => e.type === "file").map((e) => (
              <li key={e.path}>
                <button
                  type="button"
                  onClick={() => void openFile(e.path)}
                  className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left font-mono text-[10.5px] transition-colors ${
                    selected === e.path ? "bg-emerald-500/10 text-emerald-300" : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                  }`}
                >
                  <FileCode2 className="size-3 shrink-0 text-zinc-600" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{e.path}</span>
                  {e.sizeBytes != null && <span className="shrink-0 text-[8px] text-zinc-700">{humanBytes(e.sizeBytes)}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Editor + terminal */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-zinc-800/80 px-3">
            <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-500">{selected ?? "select a file"}</span>
            {selected && (
              <Button size="sm" onClick={() => void save()} disabled={busy || !dirty} className="h-6 bg-emerald-600 px-2 text-[10px] text-white hover:bg-emerald-500">
                {busy ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
                {dirty ? "Save" : "Saved"}
              </Button>
            )}
          </div>
          {selected ? (
            <textarea
              value={content}
              onChange={(e) => { setContent(e.target.value); setDirty(true); }}
              spellCheck={false}
              aria-label={`Editing ${selected}`}
              className="min-h-0 flex-1 resize-none bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-300 outline-none area-scroll"
            />
          ) : (
            <div className="grid flex-1 place-items-center text-xs text-zinc-600">
              Pick a file to view or edit it — writes are sandboxed to the
              workspace and logged to the audit trail.
            </div>
          )}
        </div>

        {/* Terminal */}
        <div className="flex h-56 shrink-0 flex-col border-t border-zinc-800/80">
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-zinc-800/80 px-3">
            <TerminalSquare className="size-3.5 text-emerald-500" aria-hidden />
            <span className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">Workspace terminal</span>
            <span className="ml-auto font-mono text-[9px] text-zinc-700">allowlist · no shell · 60s cap</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto area-scroll bg-zinc-950 px-3 py-2" aria-live="polite">
            {termLines.length === 0 ? (
              <p className="font-mono text-[10px] text-zinc-700">try: ls -la · node --version · cat package.json</p>
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-zinc-400">{termLines.join("\n")}</pre>
            )}
          </div>
          <form
            className="flex shrink-0 gap-2 border-t border-zinc-800/80 p-2"
            onSubmit={(e) => { e.preventDefault(); void runCmd(); }}
          >
            <Input
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              placeholder="command…"
              className="h-7 border-zinc-800 bg-zinc-900 font-mono text-[11px]"
              aria-label="Terminal command"
            />
            <Button type="submit" size="sm" className="h-7 bg-emerald-600 px-3 text-[10px] text-white hover:bg-emerald-500">Run</Button>
          </form>
        </div>
      </div>
    </div>
  );
}

// --- Verify panel ---------------------------------------------------------------------

function VerifyPanel({ projectId, defaultUrl, onChanged }: { projectId: string; defaultUrl: string; onChanged: () => void }) {
  const [url, setUrl] = React.useState(defaultUrl);
  const [refUrl, setRefUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [latest, setLatest] = React.useState<import("@/lib/platform-client").VerifyResultView | null>(null);
  const [runs, setRuns] = React.useState<VerifyRunView[]>([]);
  const [browser, setBrowser] = React.useState<{ available: boolean; detail: string } | null>(null);

  const load = React.useCallback(async () => {
    try {
      const r = await platformApi.listVerify(projectId);
      setRuns(r.runs);
      setBrowser(r.browser);
    } catch {
      setRuns([]);
    }
  }, [projectId]);

  React.useEffect(() => { void load(); }, [load]);

  const run = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    try {
      const r = await platformApi.verify(projectId, { url: url.trim(), referenceUrl: refUrl.trim() || undefined });
      setLatest(r);
      toast.success(`Verification complete — score ${r.score}/100`);
      await load();
      onChanged();
    } catch (err) {
      toastError(err, "Verification failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
        <label className="min-w-48 flex-1">
          <span className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-zinc-500">URL to verify</span>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className="h-8 border-zinc-800 bg-zinc-950 font-mono text-xs" />
        </label>
        <label className="min-w-48 flex-1">
          <span className="mb-1 block font-mono text-[9px] uppercase tracking-wider text-zinc-500">Reference URL (optional diff)</span>
          <Input value={refUrl} onChange={(e) => setRefUrl(e.target.value)} placeholder="https://reference…" className="h-8 border-zinc-800 bg-zinc-950 font-mono text-xs" />
        </label>
        <Button onClick={() => void run()} disabled={busy || !url.trim()} className="h-8 bg-emerald-600 text-white hover:bg-emerald-500">
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <ShieldCheck className="size-3.5" aria-hidden />}
          Verify
        </Button>
      </div>

      {browser && (
        <p className={`font-mono text-[10px] ${browser.available ? "text-emerald-400" : "text-zinc-600"}`}>
          browser runtime: {browser.available ? "available — rendered checks included" : browser.detail.slice(0, 140)}
        </p>
      )}

      {latest && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="flex items-center gap-4">
            <ScoreRing score={latest.score} />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[11px] text-zinc-300">{latest.url}</p>
              <p className="mt-0.5 font-mono text-[10px] text-zinc-500">
                {latest.regression == null ? "first run" : latest.regression ? "REGRESSION vs previous run" : "no regression vs previous run"}
                {latest.diffSummary ? ` · ${latest.diffSummary}` : ""}
              </p>
              <p className="mt-0.5 font-mono text-[10px] text-zinc-600">browser checks {latest.browserAvailable ? "included" : "skipped (no runtime)"}</p>
            </div>
          </div>
          <ul className="mt-3 space-y-1">
            {latest.checks.map((c) => (
              <li key={c.name} className="flex items-center gap-2 rounded-md border border-zinc-800/80 bg-zinc-950/60 px-2.5 py-1.5">
                {c.passed ? <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400" aria-hidden /> : <XCircle className="size-3.5 shrink-0 text-red-400" aria-hidden />}
                <span className="w-40 shrink-0 font-mono text-[10px] text-zinc-300">{c.name}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500" title={c.detail}>{c.detail}</span>
                {c.ms > 0 && <span className="font-mono text-[9px] text-zinc-700">{c.ms}ms</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {runs.length > 0 && (
        <div>
          <p className="mb-2 font-mono text-[9px] uppercase tracking-wider text-zinc-500">History</p>
          <ul className="space-y-1">
            {runs.map((r) => (
              <li key={r.id} className="flex items-center gap-2 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-1.5">
                <span className={`font-mono text-xs font-semibold ${r.score != null && r.score >= 70 ? "text-emerald-400" : r.score != null && r.score >= 40 ? "text-amber-400" : "text-red-400"}`}>
                  {r.score ?? "?"}/100
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-500">{r.url}</span>
                {r.regression != null && r.regression && <Badge variant="outline" className="border-red-500/40 text-[8px] text-red-400">REGRESSION</Badge>}
                <span className="font-mono text-[9px] text-zinc-600">{timeAgo(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ScoreRing({ score }: { score: number }) {
  const R = 26;
  const C = 2 * Math.PI * R;
  const fill = Math.max(0, Math.min(100, score)) / 100;
  const color = score >= 70 ? "#34d399" : score >= 40 ? "#fbbf24" : "#f87171";
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" role="img" aria-label={`Verification score ${score} of 100`} className="shrink-0">
      <circle cx="36" cy="36" r={R} fill="none" stroke="#27272a" strokeWidth="6" />
      <circle
        cx="36" cy="36" r={R} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
        strokeDasharray={`${C * fill} ${C}`} transform="rotate(-90 36 36)"
      />
      <text x="36" y="41" textAnchor="middle" fill="#e4e4e7" fontSize="18" fontWeight="600" fontFamily="ui-monospace, monospace">
        {score}
      </text>
    </svg>
  );
}
