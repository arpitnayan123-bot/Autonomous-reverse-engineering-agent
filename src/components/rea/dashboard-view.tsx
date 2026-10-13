"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  Activity,
  Binary,
  Boxes,
  CircuitBoard,
  Coins,
  Database,
  FileCode,
  FileQuestion,
  FileText,
  FolderSearch,
  Network,
  Package,
  PackageOpen,
  Play,
  Smartphone,
  Sparkles,
  Trash2,
  UploadCloud,
  Wrench,
} from "lucide-react";

import {
  apiDelete,
  apiGet,
  apiPost,
  apiUpload,
  type Capabilities,
  type TargetSummary,
} from "@/lib/api-client";
import { useReaStore } from "@/store/rea-store";
import {
  FormatBadge,
  StatusBadge,
  EmptyState,
  SectionCard,
  TiltCard,
  TooltipIconButton,
  humanBytes,
  timeAgo,
  toastError,
} from "@/components/rea/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const SUPPORTED: { label: string; icon: typeof Binary }[] = [
  { label: "ELF", icon: CircuitBoard },
  { label: "PE / EXE", icon: CircuitBoard },
  { label: "Mach-O", icon: CircuitBoard },
  { label: "WASM", icon: Boxes },
  { label: "EVM", icon: Coins },
  { label: "SQLite", icon: Database },
  { label: "ZIP / APK / JAR", icon: Package },
  { label: "ASAR", icon: PackageOpen },
  { label: "JavaScript", icon: FileCode },
  { label: "plist", icon: FileText },
  { label: "pcap", icon: Network },
  { label: "DEX", icon: Smartphone },
  { label: "raw binary", icon: Binary },
  { label: "unknown", icon: FileQuestion },
];

function isRunActive(status: string | null | undefined): boolean {
  return status === "running" || status === "queued" || status === "analyzing";
}

export function DashboardView() {
  const { targets, setTargets, capabilities, setCapabilities, openTarget } = useReaStore();
  const [loading, setLoading] = React.useState(true);
  const [deleteTarget, setDeleteTarget] = React.useState<TargetSummary | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const res = await apiGet<{ targets: TargetSummary[] }>("/api/targets");
      setTargets(res.targets);
    } catch (err) {
      toastError(err, "Could not load targets");
    } finally {
      setLoading(false);
    }
  }, [setTargets]);

  // Initial fetch.
  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Capabilities are cached in the store; fetch once if absent.
  React.useEffect(() => {
    if (capabilities) return;
    let cancelled = false;
    apiGet<Capabilities>("/api/capabilities")
      .then((res) => {
        if (!cancelled) setCapabilities(res);
      })
      .catch(() => {
        // Non-fatal: stat card shows an em-dash.
      });
    return () => {
      cancelled = true;
    };
  }, [capabilities, setCapabilities]);

  // Poll every 4s while any run is active.
  const anyRunning = targets.some(
    (t) => isRunActive(t.status) || isRunActive(t.lastRun?.status)
  );
  React.useEffect(() => {
    if (!anyRunning) return;
    const interval = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(interval);
  }, [anyRunning, refresh]);

  const latestActivity = React.useMemo(() => {
    const active = targets.find((t) => isRunActive(t.lastRun?.status));
    if (active?.lastRun?.currentStep) {
      return { running: true, text: active.lastRun.currentStep, sub: active.originalName };
    }
    if (targets.length === 0) return { running: false, text: "No activity yet", sub: "Upload a target to begin" };
    return {
      running: false,
      text: `Last upload ${timeAgo(targets[0].createdAt)}`,
      sub: targets[0].originalName,
    };
  }, [targets]);

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            label: "Targets analyzed",
            value: loading ? null : String(targets.length),
            hint: "Files investigated by REA",
            icon: FolderSearch,
          },
          {
            label: "Engine tools",
            value: capabilities ? String(capabilities.engine.toolCount) : null,
            hint: capabilities ? `rea-agents v${capabilities.engine.version}` : "Loading engine…",
            icon: Wrench,
          },
          {
            label: "Engine status",
            value: capabilities ? (capabilities.engine.healthy ? "Healthy" : "Degraded") : null,
            hint: capabilities?.engine.detail ?? "MCP stdio bridge",
            icon: Activity,
            tone: capabilities ? (capabilities.engine.healthy ? "ok" : "warn") : "idle",
          },
          {
            label: "Recent activity",
            value: latestActivity.text,
            hint: latestActivity.sub,
            icon: Sparkles,
            tone: latestActivity.running ? "warn" : "idle",
            spin: latestActivity.running,
          },
        ].map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 24, delay: i * 0.06 }}
          >
            <TiltCard maxTilt={5} className="h-full">
              <Card className="group relative h-full overflow-hidden border-zinc-800 bg-zinc-900/60 transition-colors hover:border-emerald-500/30">
                {/* Thin animated emerald top-accent bar (slides in on hover) */}
                <span
                  aria-hidden
                  className="absolute inset-x-0 top-0 h-0.5 origin-left scale-x-0 bg-gradient-to-r from-emerald-500 via-emerald-400 to-teal-400 transition-transform duration-500 ease-out group-hover:scale-x-100"
                />
                <CardContent className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1 [transform:translateZ(18px)]">
                    <p className="text-[11px] font-medium tracking-widest text-zinc-500 uppercase">
                      {stat.label}
                    </p>
                    {stat.value === null ? (
                      <Skeleton className="h-7 w-20 bg-zinc-800" />
                    ) : (
                      <p
                        className={
                          "truncate font-mono text-xl font-semibold tabular-nums " +
                          (stat.tone === "ok"
                            ? "text-emerald-400"
                            : stat.tone === "warn"
                              ? "text-amber-400"
                              : "text-zinc-100")
                        }
                      >
                        {stat.value}
                      </p>
                    )}
                    <p className="truncate text-xs text-zinc-500">{stat.hint}</p>
                  </div>
                  <stat.icon
                    className={"size-5 shrink-0 [transform:translateZ(24px)] " + (stat.tone === "warn" ? "text-amber-400" : "text-emerald-400")}
                    aria-hidden
                  />
                </CardContent>
              </Card>
            </TiltCard>
          </motion.div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* Upload */}
        <div className="lg:col-span-2">
          <UploadCard onUploaded={() => void refresh()} />
        </div>

        {/* Formats + engine note */}
        <div className="space-y-6 lg:col-span-3">
          <SectionCard
            title="Supported formats"
            description="Detected by magic bytes on upload — unknown formats still get strings + hex analysis."
            icon={Binary}
          >
            <div className="flex flex-wrap gap-2">
              {SUPPORTED.map(({ label, icon: Icon }) => (
                <TiltCard key={label} maxTilt={8} glow={false}>
                  <Badge
                    variant="outline"
                    className="gap-1.5 border-zinc-800 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:border-emerald-500/40 hover:text-emerald-300"
                  >
                    <Icon className="size-3.5 text-emerald-400" aria-hidden />
                    {label}
                  </Badge>
                </TiltCard>
              ))}
            </div>
          </SectionCard>

          <TargetsTable
            targets={targets}
            loading={loading}
            onOpen={(t) => openTarget(t.id)}
            onAnalyze={async (t) => {
              try {
                await apiPost(`/api/targets/${t.id}/analyze`, {});
                void refresh();
              } catch (err) {
                toastError(err, "Could not start analysis");
              }
            }}
            onDelete={(t) => setDeleteTarget(t)}
          />
        </div>
      </div>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="border-zinc-800 bg-zinc-900">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-zinc-100">Delete target?</AlertDialogTitle>
            <AlertDialogDescription className="text-zinc-400">
              This permanently removes <span className="font-mono text-zinc-200">{deleteTarget?.originalName}</span>,
              its analysis runs, evidence and findings. The uploaded file is deleted from storage.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-500"
              onClick={async () => {
                const t = deleteTarget;
                setDeleteTarget(null);
                if (!t) return;
                try {
                  await apiDelete(`/api/targets/${t.id}`);
                  void refresh();
                } catch (err) {
                  toastError(err, "Delete failed");
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload card
// ---------------------------------------------------------------------------

function UploadCard({ onUploaded }: { onUploaded: () => void }) {
  const { setActiveTargetId, setView } = useReaStore();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const [progress, setProgress] = React.useState<number | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);

  const uploading = progress !== null;

  const handleFile = React.useCallback(
    async (file: File) => {
      if (uploading) return;
      setFileName(file.name);
      setProgress(0);
      const formData = new FormData();
      formData.append("file", file);
      try {
        const res = await apiUpload<{ target: TargetSummary }>(
          "/api/targets",
          formData,
          (pct) => setProgress(pct)
        );
        const target = res.target;
        // Auto-open the workspace and kick off the REA engine immediately.
        setActiveTargetId(target.id);
        setView("workspace");
        try {
          await apiPost(`/api/targets/${target.id}/analyze`, {});
        } catch (err) {
          toastError(err, "Upload succeeded, but analysis could not start");
        }
        onUploaded();
      } catch (err) {
        toastError(err, "Upload failed");
      } finally {
        setProgress(null);
        setFileName(null);
        if (inputRef.current) inputRef.current.value = "";
      }
    },
    [onUploaded, setActiveTargetId, setView, uploading]
  );

  return (
    <SectionCard
      title="Upload a target"
      description="Max 50 MB · magic-byte validated · parsed read-only, never executed."
      icon={UploadCloud}
      contentClassName="p-0!"
    >
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload a target file"
        onClick={() => !uploading && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (!uploading) inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void handleFile(file);
        }}
        className={
          "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-b-lg border border-dashed px-6 py-10 text-center transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:outline-none " +
          (dragging
            ? "rea-dash-anim bg-emerald-500/5"
            : "border-zinc-700 bg-zinc-950/60 hover:border-emerald-500/40 hover:bg-zinc-900/60")
        }
      >
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          aria-label="Choose a file to analyze"
          disabled={uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
        {uploading ? (
          <div className="w-full max-w-xs space-y-2">
            <p className="truncate font-mono text-xs text-emerald-400">{fileName}</p>
            <Progress value={progress ?? 0} className="h-2 bg-zinc-800" />
            <p className="text-xs text-zinc-500">
              {progress !== null && progress < 100
                ? `Uploading… ${progress}%`
                : "Processing + starting analysis…"}
            </p>
          </div>
        ) : (
          <>
            <div className="grid size-12 place-items-center rounded-full border border-zinc-800 bg-zinc-900">
              <UploadCloud className="size-6 text-emerald-400" aria-hidden />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-zinc-200">
                Drag & drop a file, or <span className="text-emerald-400">browse</span>
              </p>
              <p className="text-xs text-zinc-500">
                Analysis starts automatically after upload.
              </p>
            </div>
          </>
        )}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Targets table
// ---------------------------------------------------------------------------

function TargetsTable({
  targets,
  loading,
  onOpen,
  onAnalyze,
  onDelete,
}: {
  targets: TargetSummary[];
  loading: boolean;
  onOpen: (t: TargetSummary) => void;
  onAnalyze: (t: TargetSummary) => void | Promise<void>;
  onDelete: (t: TargetSummary) => void;
}) {
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const startAnalysis = async (t: TargetSummary) => {
    setBusyId(t.id);
    try {
      await onAnalyze(t);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <SectionCard
      title="Targets"
      description={targets.length > 0 ? `${targets.length} target${targets.length === 1 ? "" : "s"} in this workspace` : undefined}
      icon={FolderSearch}
      contentClassName="p-0!"
    >
      {loading ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full bg-zinc-800/70" />
          ))}
        </div>
      ) : targets.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon={Binary}
            title="No targets yet"
            description="Upload a binary, database, archive or app package. The REA engine will detect the format and investigate it with evidence-backed tools."
          />
        </div>
      ) : (
        <div className="rea-scroll max-h-[460px] overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="text-zinc-500">Name</TableHead>
                <TableHead className="text-zinc-500">Format</TableHead>
                <TableHead className="text-zinc-500">Size</TableHead>
                <TableHead className="text-zinc-500">Status</TableHead>
                <TableHead className="hidden text-zinc-500 md:table-cell">Created</TableHead>
                <TableHead className="text-right text-zinc-500">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {targets.map((t) => {
                const running = isRunActive(t.lastRun?.status);
                return (
                  <TableRow key={t.id} className="border-zinc-800/70">
                    <TableCell className="max-w-[220px] font-mono text-xs break-all text-zinc-200">
                      {t.originalName}
                    </TableCell>
                    <TableCell>
                      <FormatBadge format={t.detectedFormat} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-zinc-400">
                      {humanBytes(t.sizeBytes)}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={t.lastRun?.status ?? t.status} />
                    </TableCell>
                    <TableCell className="hidden text-xs text-zinc-500 md:table-cell">
                      {timeAgo(t.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-0.5">
                        <TooltipIconButton label="Open workspace" onClick={() => onOpen(t)}>
                          <FolderSearch className="size-4" aria-hidden />
                        </TooltipIconButton>
                        <TooltipIconButton
                          label={running ? "Analysis running" : "Analyze with REA"}
                          disabled={running || busyId === t.id}
                          onClick={() => void startAnalysis(t)}
                        >
                          {running || busyId === t.id ? (
                            <Activity className="size-4 animate-pulse text-amber-400" aria-hidden />
                          ) : (
                            <Play className="size-4" aria-hidden />
                          )}
                        </TooltipIconButton>
                        <TooltipIconButton label="Delete target" onClick={() => onDelete(t)}>
                          <Trash2 className="size-4 hover:text-rose-400" aria-hidden />
                        </TooltipIconButton>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </SectionCard>
  );
}
