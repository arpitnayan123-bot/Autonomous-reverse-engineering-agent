"use client";

import * as React from "react";
import { MotionConfig } from "framer-motion";
import { Loader2, Terminal } from "lucide-react";

import { apiGet, type ProviderCatalog, type ReaUser } from "@/lib/api-client";
import { useReaStore } from "@/store/rea-store";
import { AppShell } from "@/components/rea/app-shell";
import { AuthView } from "@/components/rea/auth-view";

export function ReaApp() {
  const { booted, user, setUser } = useReaStore();

  // Resolve the session once on boot.
  React.useEffect(() => {
    let cancelled = false;
    apiGet<{ user: ReaUser | null }>("/api/auth/me")
      .then((res) => {
        if (!cancelled) setUser(res.user ?? null);
      })
      .catch(() => {
        // Not signed in (or server unreachable) — show the auth gate.
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) useReaStore.getState().setBooted(true);
      });
    return () => {
      cancelled = true;
    };
  }, [setUser]);

  // Mid-session 401s (revoked session, rotated signing secret, stale cookie)
  // return the user to the sign-in screen instead of stranding the shell.
  React.useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener("rea:session-expired", onExpired);
    return () => window.removeEventListener("rea:session-expired", onExpired);
  }, [setUser]);

  if (!booted) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-zinc-950">
        <div className="grid size-10 place-items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10">
          <Terminal className="size-5 text-emerald-400" aria-hidden />
        </div>
        <p className="flex items-center gap-2 font-mono text-xs text-zinc-500">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          booting REA engine…
        </p>
      </div>
    );
  }

  if (!user) {
    return <AuthView onAuthenticated={(u) => setUser(u)} />;
  }

  return (
    // Respect the OS "reduce motion" preference for every framer-motion
    // transition in the shell (message entry, sheet slides…).
    <MotionConfig reducedMotion="user">
      <AppShell user={user} />
    </MotionConfig>
  );
}

/** Refresh provider state from the server into the store (used by shell + dialog). */
export async function refreshProviderInStore(): Promise<void> {
  try {
    const res = await apiGet<ProviderCatalog>("/api/provider");
    const s = useReaStore.getState();
    s.setProviderLoaded(true);
    s.setHasProviderKey(res.active !== null);
    s.setProviderActive(res.active);
  } catch {
    useReaStore.getState().setProviderLoaded(true);
  }
}
