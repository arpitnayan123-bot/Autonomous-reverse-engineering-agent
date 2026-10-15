"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";

/**
 * Client boundary around the authenticated shell. The shell itself stays
 * client-only (it reads cookies/local state and renders streaming UI), while
 * every (app) route page is a server component wrapper above this layout —
 * the same pattern the old single-route SPA root used.
 */
const ReaShell = dynamic(
  () => import("@/components/rea/rea-app").then((mod) => mod.ReaShell),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-zinc-950">
        <Loader2 className="size-5 animate-spin text-emerald-400" aria-hidden />
        <p className="font-mono text-xs text-zinc-500">loading REA Platform…</p>
      </div>
    ),
  }
);

export function AppShellLoader({ children }: { children: React.ReactNode }) {
  return <ReaShell>{children}</ReaShell>;
}
