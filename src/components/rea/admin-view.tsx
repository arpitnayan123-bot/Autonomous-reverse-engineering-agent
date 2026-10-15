"use client";

import * as React from "react";
import { Loader2, ShieldCheck, UserRound } from "lucide-react";

import { apiGet, type AuditEvent, type SecurityData } from "@/lib/api-client";
import { useReaStore } from "@/store/rea-store";
import { toastError } from "@/components/rea/shared";
import { Button } from "@/components/ui/button";

/**
 * /admin — the operations console. The platform API is tenant-isolated
 * (audit log, security posture and sessions are strictly per-user — see
 * /api/audit), so this console surfaces the signed-in account's own
 * operational data with an honest note about role-gated administration.
 */
export function AdminView() {
  const user = useReaStore((s) => s.user);
  const [events, setEvents] = React.useState<AuditEvent[] | null>(null);
  const [security, setSecurity] = React.useState<SecurityData | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [audit, sec] = await Promise.all([
          apiGet<{ events: AuditEvent[] }>("/api/audit"),
          apiGet<SecurityData>("/api/security").catch(() => null),
        ]);
        if (!cancelled) {
          setEvents(audit.events ?? []);
          setSecurity(sec);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setEvents([]);
          toastError(err, "Could not load operations data");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const liveSessions = security?.sessions?.filter((s) => !s.current).length ?? null;
  const passingControls = security?.posture.filter((c) => c.status === "pass").length ?? null;
  const totalControls = security?.posture.length ?? null;
  const engineRunning = security?.engineDiag.running ?? null;

  return (
    <div className="min-h-0 w-full flex-1 overflow-y-auto rea-scroll">
      <div className="mx-auto w-full max-w-4xl p-4 md:p-6">
        <header className="mb-5">
          <h1 className="flex items-center gap-2 font-mono text-sm font-semibold tracking-widest text-zinc-200">
            <ShieldCheck className="size-4 text-emerald-400" aria-hidden />
            OPERATIONS CONSOLE
          </h1>
          <p className="mt-1 text-xs text-zinc-500">
            Account posture and the audit trail for this workspace. The API is
            tenant-isolated — each account sees only its own events.
          </p>
        </header>

        {/* Account card */}
        <section className="mb-5 rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4" aria-label="Account">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-full border border-emerald-500/40 bg-emerald-500/10 font-mono text-sm text-emerald-400">
              <UserRound className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-zinc-200">
                {user?.name ?? user?.email ?? "Account"}
                {user?.isDemo && (
                  <span className="ml-2 rounded border border-emerald-500/30 bg-emerald-500/10 px-1 font-mono text-[8px] tracking-wider text-emerald-400">
                    DEMO
                  </span>
                )}
              </p>
              <p className="truncate font-mono text-[10px] text-zinc-500">
                {user?.email} · role: {user?.role ?? "unknown"}
              </p>
            </div>
          </div>
          {user?.role !== "admin" && (
            <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5 font-mono text-[10px] leading-relaxed text-amber-300/90">
              Role-gated platform administration requires the admin role
              (yours: {user?.role ?? "unknown"}). Everything below is this
              account&apos;s own operational data.
            </p>
          )}
        </section>

        {/* Posture quick stats */}
        <section className="mb-5 grid gap-3 sm:grid-cols-3" aria-label="Posture summary">
          <StatCard
            label="Engine"
            value={engineRunning == null ? "—" : engineRunning ? "running" : "stopped"}
            tone={engineRunning ? "ok" : "muted"}
          />
          <StatCard
            label="Security controls"
            value={totalControls ? `${passingControls ?? 0}/${totalControls} pass` : "—"}
            tone={passingControls != null && totalControls != null && passingControls === totalControls ? "ok" : "muted"}
          />
          <StatCard
            label="Other live sessions"
            value={liveSessions == null ? "—" : String(liveSessions)}
            tone={liveSessions ? "warn" : "ok"}
          />
        </section>

        {/* Audit trail */}
        <section aria-label="Audit trail">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              Audit trail
            </h2>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 font-mono text-[10px] text-zinc-500"
              onClick={() => {
                setEvents(null);
                void apiGet<{ events: AuditEvent[] }>("/api/audit")
                  .then((r) => setEvents(r.events ?? []))
                  .catch(() => setEvents([]));
              }}
            >
              Reload
            </Button>
          </div>
          {events === null ? (
            <div className="flex items-center justify-center rounded-xl border border-zinc-800/80 bg-zinc-900/40 py-10">
              <Loader2 className="size-4 animate-spin text-emerald-400" aria-hidden />
            </div>
          ) : error ? (
            <p className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-4 font-mono text-xs text-rose-300">
              {error}
            </p>
          ) : events.length === 0 ? (
            <p className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-xs text-zinc-600">
              No audit events yet — actions you take across the platform will appear here.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-800/60 overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/40">
              {events.map((e) => (
                <li key={e.id} className="flex items-start gap-3 px-4 py-2.5">
                  <SeverityDot severity={e.severity} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs text-zinc-300">
                      {e.action}
                    </span>
                    {e.detail && (
                      <span className="block truncate text-[11px] text-zinc-500" title={e.detail}>
                        {e.detail}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-right font-mono text-[9px] text-zinc-600">
                    {new Date(e.createdAt).toLocaleString()}
                    {e.ip ? <span className="block">{e.ip}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function StatCard({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "muted" }) {
  const valueCls =
    tone === "ok" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : "text-zinc-300";
  return (
    <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-4">
      <p className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`mt-1 font-mono text-sm ${valueCls}`}>{value}</p>
    </div>
  );
}

function SeverityDot({ severity }: { severity: string }) {
  const cls =
    severity === "error"
      ? "bg-red-500"
      : severity === "warn"
        ? "bg-amber-400"
        : "bg-zinc-600";
  return <span className={`mt-1.5 size-2 shrink-0 rounded-full ${cls}`} aria-hidden />;
}
