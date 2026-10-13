"use client";

import * as React from "react";
import { Keyboard } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** A single shortcut row. */
function Row({ keys, label, hint }: { keys: string[]; label: string; hint?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p className="truncate text-xs text-zinc-300">{label}</p>
        {hint && <p className="truncate text-[10px] text-zinc-600">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {keys.map((k) => (
          <kbd
            key={k}
            className={cn(
              "rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px]",
              "text-zinc-300 shadow-sm shadow-black/40"
            )}
          >
            {k}
          </kbd>
        ))}
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/30 p-3">
      <h3 className="mb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-600">
        {title}
      </h3>
      <div className="divide-y divide-zinc-800/50">{children}</div>
    </div>
  );
}

/**
 * Keyboard shortcuts cheat-sheet — opened with "?" outside inputs or from the
 * command palette. Read-only reference, nothing to configure.
 */
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto rea-scroll border-zinc-800 bg-zinc-950 sm:max-w-lg">
        <DialogHeader className="sr-only">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Every shortcut available in the REA workspace.
          </DialogDescription>
        </DialogHeader>
        <div className="mb-3 flex items-center gap-2">
          <Keyboard className="size-4 text-emerald-400" aria-hidden />
          <h2 className="text-sm font-semibold text-zinc-100">Keyboard shortcuts</h2>
          <kbd className="ml-auto rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
            ?
          </kbd>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Group title="Workspace">
            <Row keys={["⌘", "K"]} label="Command palette" hint="jump to chats, files, actions" />
            <Row keys={["⌘", "B"]} label="Toggle sidebar" />
            <Row keys={["⌘", "I"]} label="Toggle inspector" hint="file details, findings, evidence" />
            <Row keys={["⌘", "F"]} label="Filter chats & files" hint="also searches message content" />
            <Row keys={["⌘", "⇧", "O"]} label="New chat" />
            <Row keys={["?"]} label="This cheat sheet" />
          </Group>
          <Group title="Composer">
            <Row keys={["Enter"]} label="Send message" />
            <Row keys={["⇧", "Enter"]} label="New line" />
            <Row keys={["Esc"]} label="Close / cancel" hint="dialogs, rename, palette" />
          </Group>
          <Group title="Message actions (hover)">
            <Row keys={["…"]} label="Edit · Regenerate · Fork · Quote" hint="hover a message (tap on touch) for the action row" />
          </Group>
          <Group title="Security">
            <Row keys={["🔒"]} label="Keys & sessions" hint="HttpOnly cookies, keys never in the client bundle" />
            <Row keys={["📖"]} label="Files are read-only" hint="parsed, never executed" />
          </Group>
        </div>
      </DialogContent>
    </Dialog>
  );
}
