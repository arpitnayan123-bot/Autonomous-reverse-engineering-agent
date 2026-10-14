"use client";

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  Container,
  Cpu,
  Layers,
  Lock,
  MonitorSmartphone,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";

import { apiGet, apiPatch, apiPost, type PreferencesData, type SecurityData, type SandboxMode } from "@/lib/api-client";
import { EmptyState, SectionCard, timeAgo, toastError } from "@/components/rea/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/hooks/use-toast";

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

/** Human-readable device label from a raw User-Agent (browser · OS). */
function deviceLabel(ua: string | null): string {
  if (!ua) return "Unknown device";
  const os =
    /Windows/i.test(ua) ? "Windows"
    : /Android/i.test(ua) ? "Android"
    : /iPhone|iPad|iPod/i.test(ua) ? "iOS"
    : /Mac OS X|Macintosh/i.test(ua) ? "macOS"
    : /Linux/i.test(ua) ? "Linux"
    : null;
  const browser =
    /Edg\//i.test(ua) ? "Edge"
    : /OPR\//i.test(ua) ? "Opera"
    : /SamsungBrowser/i.test(ua) ? "Samsung Internet"
    : /Firefox/i.test(ua) ? "Firefox"
    : /Chrome/i.test(ua) ? "Chrome"
    : /Safari/i.test(ua) ? "Safari"
    : null;
  return [browser, os].filter(Boolean).join(" · ") || "Unknown device";
}

const SANDBOX_MODE_META: Record<
  SandboxMode,
  { label: string; icon: React.ComponentType<{ className?: string }>; blurb: string }
> = {
  auto: {
    label: "Auto",
    icon: Layers,
    blurb: "Docker container sandbox when a daemon is reachable, process jail otherwise.",
  },
  process: {
    label: "Process",
    icon: TerminalSquare,
    blurb: "Always the process-level jail — no shell, allowlist, workspace cwd, hard timeout.",
  },
  docker: {
    label: "Docker",
    icon: Container,
    blurb: "Always the container sandbox (no network, read-only rootfs, 512 MB, 1 CPU). Refused when Docker is unavailable.",
  },
};

export function SecurityView() {
  const [data, setData] = React.useState<SecurityData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [signingOutOthers, setSigningOutOthers] = React.useState(false);
  const [prefs, setPrefs] = React.useState<PreferencesData | null>(null);
  const [savingMode, setSavingMode] = React.useState<SandboxMode | null>(null);

  const loadPrefs = React.useCallback(() => {
    apiGet<PreferencesData>("/api/preferences")
      .then(setPrefs)
      .catch(() => setPrefs(null)); // the card degrades to an unavailable note
  }, []);

  const setSandboxMode = async (mode: SandboxMode) => {
    if (!prefs || prefs.sandboxMode === mode || savingMode) return;
    setSavingMode(mode);
    try {
      await apiPatch<{ ok: boolean; sandboxMode: SandboxMode }>("/api/preferences", { sandboxMode: mode });
      setPrefs((prev) => (prev ? { ...prev, sandboxMode: mode } : prev));
      toast({
        title: `Sandbox mode set to ${SANDBOX_MODE_META[mode].label}`,
        description:
          mode === "docker"
            ? "Workspace commands now require the container sandbox — they are refused honestly when no daemon is reachable."
            : mode === "process"
              ? "Workspace commands always run in the process-level jail from now on."
              : "Workspace commands use the container sandbox when available and the process jail otherwise.",
      });
    } catch (err) {
      toastError(err, "Could not save sandbox mode");
    } finally {
      setSavingMode(null);
    }
  };

  const signOutOthers = async () => {
    setSigningOutOthers(true);
    try {
      const res = await apiPost<{ ok: boolean; revoked: number; sessions: SecurityData["sessions"] }>(
        "/api/security",
        { signOutOthers: true }
      );
      setData((prev) => (prev ? { ...prev, sessions: res.sessions } : prev));
      toast({
        title: res.revoked > 0 ? `Signed out ${res.revoked} other session${res.revoked === 1 ? "" : "s"}` : "No other active sessions",
        description:
          res.revoked > 0
            ? "Those devices must sign in again. This device stays signed in."
            : "This browser is the only active session for your account.",
      });
    } catch (err) {
      toastError(err, "Could not sign out other sessions");
    } finally {
      setSigningOutOthers(false);
    }
  };

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
    loadPrefs();
    return () => {
      cancelled = true;
    };
  }, [loadPrefs]);

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
        title="Command sandbox"
        description="Where chat-workspace commands execute — container isolation or the process-level jail"
        icon={Cpu}
      >
        {!prefs ? (
          <p className="text-xs text-zinc-500">
            Sandbox preference unavailable — commands fall back to the platform default (auto).
          </p>
        ) : (
          <div className="space-y-4">
            <div
              className="grid grid-cols-1 gap-2 sm:grid-cols-3"
              role="radiogroup"
              aria-label="Workspace command sandbox mode"
            >
              {prefs.modes.map((mode) => {
                const meta = SANDBOX_MODE_META[mode];
                const selected = prefs.sandboxMode === mode;
                const Icon = meta.icon;
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={savingMode !== null}
                    onClick={() => void setSandboxMode(mode)}
                    className={
                      "flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 disabled:cursor-wait disabled:opacity-60 " +
                      (selected
                        ? "border-emerald-500/50 bg-emerald-500/10"
                        : "border-zinc-800 bg-zinc-950/60 hover:border-zinc-700 hover:bg-zinc-900/60")
                    }
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-zinc-100">
                        <Icon className={"size-3.5 " + (selected ? "text-emerald-400" : "text-zinc-500")} aria-hidden />
                        {meta.label}
                      </span>
                      {selected && (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/30 bg-emerald-500/10 font-mono text-[10px] uppercase tracking-widest text-emerald-400"
                        >
                          active
                        </Badge>
                      )}
                    </span>
                    <span className="text-[11px] leading-relaxed text-zinc-500">{meta.blurb}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-zinc-500">
              <span className="flex items-center gap-1.5">
                <span
                  className={
                    "inline-flex size-1.5 rounded-full " +
                    (prefs.docker.available ? "animate-pulse bg-emerald-400" : "bg-zinc-600")
                  }
                  aria-hidden
                />
                {prefs.docker.available
                  ? `Container runtime online (${prefs.docker.runtime})`
                  : "No container runtime detected — Docker mode refuses commands"}
              </span>
              <span className="font-mono">
                image: {prefs.docker.image}
              </span>
            </div>

            {prefs.sandboxMode === "docker" && !prefs.docker.available && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed text-amber-400">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  Docker is selected but no daemon is reachable — every workspace command will be
                  refused ("Docker sandbox requested but not available") until a runtime comes up or
                  the mode is switched back to Auto / Process.
                </span>
              </div>
            )}

            <p className="text-[11px] leading-relaxed text-zinc-600">
              The sandbox decides WHERE commands run — the command allowlist and chat guards apply
              identically in every mode. Container runs mount the workspace at /workspace with no
              network, a read-only rootfs, tmpfs /tmp, 512 MB memory and 1 CPU; the image must
              contain the allowlisted binaries (see README → REA_SANDBOX_IMAGE).
            </p>
          </div>
        )}
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
        title="Active sessions"
        description="Devices currently signed in to this account"
        icon={MonitorSmartphone}
        contentClassName="p-0!"
      >
        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <p className="text-xs leading-relaxed text-zinc-500">
            Sessions are stored server-side and can be revoked — a stolen cookie
            stops working immediately, before its 7-day expiry.
          </p>
          {(data.sessions?.length ?? 0) > 1 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void signOutOthers()}
              disabled={signingOutOthers}
              className="h-7 shrink-0 gap-1.5 border-zinc-700 px-2.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
            >
              {signingOutOthers ? "Signing out…" : "Sign out other sessions"}
            </Button>
          )}
        </div>
        {!data.sessions || data.sessions.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={MonitorSmartphone}
              title="No active sessions listed"
              description="Live sessions appear here as devices sign in."
              className="border-none bg-transparent"
            />
          </div>
        ) : (
          <div className="rea-scroll max-h-72 divide-y divide-zinc-800/70 overflow-y-auto rounded-b-lg">
            {data.sessions.map((s) => (
              <div key={s.id} className="flex items-start gap-3 px-4 py-3">
                <MonitorSmartphone className="mt-0.5 size-3.5 shrink-0 text-zinc-500" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-zinc-200">
                    {deviceLabel(s.userAgent)}
                    {s.current && (
                      <Badge
                        variant="outline"
                        className="border-emerald-500/30 bg-emerald-500/10 font-mono text-[10px] uppercase tracking-widest text-emerald-400"
                      >
                        this device
                      </Badge>
                    )}
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] leading-relaxed text-zinc-500">
                    signed in {timeAgo(s.createdAt)}
                    {s.ip ? ` · ${s.ip}` : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
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
