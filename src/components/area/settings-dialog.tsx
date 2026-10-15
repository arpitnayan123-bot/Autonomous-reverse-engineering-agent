"use client";

import * as React from "react";
import { KeyRound } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProviderSettings } from "@/components/area/provider-view";

/**
 * Global settings dialog — BYOK API key & model selection, wrapped around the
 * existing ProviderSettings surface.
 */
export function SettingsDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the dialog closes so parents can refresh provider state. */
  onChanged?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto area-scroll border-zinc-800 bg-zinc-950 sm:max-w-lg">
        <DialogHeader className="sr-only">
          <DialogTitle>API key &amp; model settings</DialogTitle>
          <DialogDescription>
            Bring your own API key or use the platform model.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-1 px-1">
          <div className="mb-3 flex items-center gap-2">
            <KeyRound className="size-4 text-emerald-400" aria-hidden />
            <h2 className="text-sm font-semibold text-zinc-100">API key &amp; model</h2>
          </div>
          <ProviderSettings />
        </div>
      </DialogContent>
    </Dialog>
  );
}
