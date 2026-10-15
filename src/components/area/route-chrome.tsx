"use client";

import * as React from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Shared loading / error chrome for route segments. Rendered inside the app
 * shell (top bar + sidebar stay mounted), so these fill the main content area.
 */

export function RouteLoading({ label = "loading…" }: { label?: string }) {
  return (
    <div className="flex min-h-[60vh] w-full flex-1 flex-col items-center justify-center gap-3 bg-zinc-950">
      <div className="grid size-10 place-items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10">
        <Loader2 className="size-4 animate-spin text-emerald-400" aria-hidden />
      </div>
      <p className="font-mono text-xs text-zinc-500">{label}</p>
    </div>
  );
}

export function RouteError({
  error,
  reset,
  label = "This view hit an error",
}: {
  error: Error & { digest?: string };
  reset: () => void;
  label?: string;
}) {
  return (
    <div
      role="alert"
      className="flex min-h-[60vh] w-full flex-1 flex-col items-center justify-center gap-4 bg-zinc-950 p-6 text-center"
    >
      <div className="grid size-10 place-items-center rounded-lg border border-rose-500/40 bg-rose-500/10">
        <AlertTriangle className="size-4 text-rose-400" aria-hidden />
      </div>
      <div>
        <p className="font-mono text-sm text-zinc-200">{label}</p>
        <p className="mx-auto mt-1 max-w-md font-mono text-xs break-words text-zinc-500">
          {error.message}
          {error.digest ? ` (digest ${error.digest})` : ""}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
