"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Binary, MessageSquare, Plus, RefreshCw, ScanSearch } from "lucide-react";

import {
  apiGet,
  apiPost,
  type TargetSummary,
} from "@/lib/api-client";
import { useReaStore } from "@/store/rea-store";
import { humanBytes, timeAgo, toastError } from "@/components/rea/shared";
import { useShellActions } from "@/components/rea/shell-actions";
import { Button } from "@/components/ui/button";

/**
 * /targets — all uploaded targets with their latest analysis run. Cards open
 * the full target detail route; quick actions start a chat or an engine run.
 */
export function TargetsList() {
  const router = useRouter();
  const shell = useShellActions();
  const [targets, setTargets] = React.useState<TargetSummary[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [startingId, setStartingId] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const res = await apiGet<{ targets: TargetSummary[] }>("/api/targets");
      setTargets(res.targets);
      setError(null);
      // Keep the sidebar's file list in step.
      useReaStore.getState().setTargets(res.targets);
      useReaStore.getState().setTargetsLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTargets([]);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const startAnalysis = async (t: TargetSummary) => {
    if (startingId) return;
    setStartingId(t.id);
    try {
      await apiPost(`/api/targets/${t.id}/analyze`, {});
      await refresh();
    } catch (err) {
      toastError(err, "Could not start analysis");
    } finally {
      setStartingId(null);
    }
  };

  const chatAbout = (t: TargetSummary) => {
    useReaStore.getState().newTargetChat(t.id);
    router.push("/chat");
  };

  return (
    <div className="min-h-0 w-full flex-1 overflow-y-auto rea-scroll">
      <div className="mx-auto w-full max-w-5xl p-4 md:p-6">
        <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 font-mono text-sm font-semibold tracking-widest text-zinc-200">
              <Binary className="size-4 text-emerald-400" aria-hidden />
              TARGETS
            </h1>
            <p className="mt-1 text-xs text-zinc-500">
              Uploaded files under investigation — evidence, findings and analysis runs.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-zinc-700 text-zinc-300"
              onClick={() => void refresh()}
              aria-label="Refresh targets"
            >
              <RefreshCw className="size-3.5" aria-hidden />
              Refresh
            </Button>
            <Button
              size="sm"
              className="h-8 bg-emerald-600 text-white hover:bg-emerald-500"
              onClick={shell.openUploadPicker}
            >
              <Plus className="size-3.5" aria-hidden />
              Upload target
            </Button>
          </div>
        </header>

        {targets === null ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-hidden>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-36 animate-pulse rounded-xl border border-zinc-800/80 bg-zinc-900/40" />
            ))}
          </div>
        ) : error ? (
          <p className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 font-mono text-xs text-rose-300">
            {error}
          </p>
        ) : targets.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 p-10 text-center">
            <ScanSearch className="mx-auto size-6 text-zinc-600" aria-hidden />
            <p className="mt-3 text-sm text-zinc-400">No targets yet</p>
            <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-zinc-600">
              Upload a binary, database, or app bundle to start an
              evidence-backed investigation.
            </p>
            <Button
              size="sm"
              className="mt-4 h-8 bg-emerald-600 text-white hover:bg-emerald-500"
              onClick={shell.openUploadPicker}
            >
              <Plus className="size-3.5" aria-hidden />
              Upload target
            </Button>
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Targets">
            {targets.map((t) => (
              <li key={t.id}>
                <article className="flex h-full flex-col rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4 transition-colors hover:border-emerald-500/40">
                  <button
                    type="button"
                    onClick={() => router.push(`/targets/${t.id}`)}
                    className="text-left focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
                    title={`Open ${t.originalName}`}
                  >
                    <span className="flex items-center gap-2">
                      <TargetStatusDot status={t.lastRun?.status ?? t.status} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-200">
                        {t.originalName}
                      </span>
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[9px] text-emerald-300">
                        {t.detectedFormat || t.formatFamily || "unknown"}
                      </span>
                      <span className="font-mono text-[9px] text-zinc-600">
                        {humanBytes(t.sizeBytes)} · {timeAgo(t.createdAt)}
                      </span>
                    </span>
                    {t.summary && (
                      <span className="mt-2 line-clamp-2 block text-xs leading-relaxed text-zinc-500">
                        {t.summary}
                      </span>
                    )}
                  </button>
                  <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                    <span className="truncate font-mono text-[9px] text-zinc-600">
                      {t.lastRun
                        ? `run ${t.lastRun.status}${t.lastRun.currentStep ? ` · ${t.lastRun.currentStep}` : ""}`
                        : "no runs yet"}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-2 text-[11px] text-zinc-400 hover:text-emerald-300"
                        onClick={() => chatAbout(t)}
                        aria-label={`Chat about ${t.originalName}`}
                      >
                        <MessageSquare className="size-3" aria-hidden />
                        Chat
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-2 text-[11px] text-zinc-400 hover:text-emerald-300"
                        disabled={startingId === t.id}
                        onClick={() => void startAnalysis(t)}
                        aria-label={`Analyze ${t.originalName}`}
                      >
                        <ScanSearch className="size-3" aria-hidden />
                        {startingId === t.id ? "Starting…" : "Analyze"}
                      </Button>
                    </span>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TargetStatusDot({ status }: { status: string }) {
  const cls =
    status === "running" || status === "analyzing"
      ? "bg-emerald-400 animate-pulse"
      : status === "completed" || status === "analyzed"
        ? "bg-emerald-500"
        : status === "failed" || status === "error"
          ? "bg-red-500"
          : "bg-zinc-600";
  return <span className={`size-2 shrink-0 rounded-full ${cls}`} aria-hidden />;
}
