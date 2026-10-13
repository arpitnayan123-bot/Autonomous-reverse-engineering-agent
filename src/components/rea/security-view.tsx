"use client";

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  Lock,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";

import { apiGet, type SecurityData } from "@/lib/api-client";
import { EmptyState, SectionCard, timeAgo, toastError } from "@/components/rea/shared";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

const POSTURE_STYLES: Record<string, string> = {
  enforced: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  partial: "border-amber-500/30 bg-amber-500/10 text-amber-400",
  open: "border-rose-500/30 bg-rose-500/10 text-rose-400",
};

const SEVERITY_STYLES: Record<string, string> = {
  high: "border-rose-500/30 bg-rose-500/10 text-rose-400",
  medium: "border-amber-500/30 bg-amber-500/10 text-amber-400",
  low: "border-zinc-700 bg-zinc-800/60 text-zinc-400",
  info: "border-zinc-700 bg-zinc-800/60 text-zinc-400",
};

export function SecurityView() {
  const [data, setData] = React.useState<SecurityData | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    apiGet<SecurityData>("/api/security")
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err) => {
        if (!cancelled) toastError(err, "Could not load security posture");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full bg-zinc-800/50" />
        <Skeleton className="h-32 w-full bg-zinc-800/50" />
        <Skeleton className="h-48 w-full bg-zinc-800/40" />
      </div>
    );
  }

  if (!data) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Security endpoint unavailable"
        description="The security posture could not be loaded. It will be available once the platform services are running."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-zinc-100">Security posture</h2>
        <p className="text-sm text-zinc-500">
          Platform hardening state, live engine diagnostics and recently blocked or flagged activity.
        </p>
      </div>

      <SectionCard
        title="Controls"
        description="Upload validation, sandboxing and rate limiting"
        icon={Lock}
      >
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.posture.map((control) => (
            <div
              key={control.control}
              className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-zinc-200">{control.control}</p>
                <Badge
                  variant="outline"
                  className={"font-mono text-[10px] uppercase tracking-widest " + (POSTURE_STYLES[control.status.toLowerCase()] ?? POSTURE_STYLES.open)}
                >
                  {control.status}
                </Badge>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">{control.detail}</p>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title="Engine diagnostics"
        description="Live process state and stderr tail"
        icon={TerminalSquare}
        contentClassName="p-0!"
      >
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2 text-xs">
            <span
              className={
                "inline-flex size-2 rounded-full " +
                (data.engineDiag.running
                  ? "animate-pulse bg-emerald-400"
                  : "bg-zinc-600")
              }
              aria-hidden
            />
            <span className={data.engineDiag.running ? "text-emerald-400" : "text-zinc-500"}>
              {data.engineDiag.running ? "REA engine process running" : "REA engine process idle"}
            </span>
          </div>
          <pre className="rea-scroll max-h-64 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-400" aria-label="Engine stderr output">
            {data.engineDiag.stderr?.trim() ? data.engineDiag.stderr : "stderr is empty — no engine warnings."}
          </pre>
        </div>
      </SectionCard>

      <SectionCard
        title="Recent threats"
        description="Rejected uploads, blocked operations and rate-limit hits"
        icon={ShieldCheck}
        contentClassName="p-0!"
      >
        {data.recentThreats.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={ShieldCheck}
              title="No threats recorded"
              description="Nothing suspicious has been flagged. This list fills up when uploads fail validation or requests get rate-limited."
              className="border-none bg-transparent"
            />
          </div>
        ) : (
          <div className="rea-scroll max-h-80 divide-y divide-zinc-800/70 overflow-y-auto rounded-b-lg">
            {data.recentThreats.map((threat) => (
              <div key={threat.id} className="flex items-start gap-3 px-4 py-3">
                <Badge
                  variant="outline"
                  className={"shrink-0 font-mono text-[10px] uppercase tracking-widest " + (SEVERITY_STYLES[threat.severity.toLowerCase()] ?? SEVERITY_STYLES.info)}
                >
                  {threat.severity}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-xs text-zinc-200">{threat.action}</p>
                  <p className="mt-0.5 text-xs leading-relaxed break-words text-zinc-500">{threat.detail}</p>
                </div>
                <span className="shrink-0 text-[11px] text-zinc-600">{timeAgo(threat.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
