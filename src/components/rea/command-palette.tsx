"use client";

import * as React from "react";
import {
  Binary,
  Download,
  KeyRound,
  Keyboard,
  LogOut,
  MessagesSquare,
  MonitorDot,
  PanelLeft,
  PanelRight,
  Pin,
  PinOff,
  Plus,
  Upload,
} from "lucide-react";

import type { SessionSummary, TargetSummary } from "@/lib/api-client";
import { useReaStore } from "@/store/rea-store";
import { timeAgo } from "@/components/rea/shared";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";

// ---------------------------------------------------------------------------
// CommandPalette — Cursor-style ⌘K launcher: jump to any chat / file, run
// workspace actions. Open state lives in the store so global shortcuts and
// the top-bar button can toggle it from anywhere.
// ---------------------------------------------------------------------------

export interface CommandPaletteActions {
  onUpload: () => void;
  onExportChat: () => void;
  onExportReport: () => void;
  onLogout: () => void;
  /** Pin/unpin the active chat (optional — hidden when absent). */
  onTogglePinCurrent?: () => void;
}

const GROUP_HEADING_CLS =
  "[&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-zinc-600";

export function CommandPalette({
  actions,
}: {
  actions: CommandPaletteActions;
}) {
  const {
    paletteOpen,
    setPaletteOpen,
    sessions,
    targets,
    activeSessionId,
    setDialog,
    newFreeChat,
    openSession,
    newTargetChat,
    openInspector,
    toggleSidebar,
  } = useReaStore();
  const inspectorOpen = useReaStore((s) => s.inspectorOpen);
  const inspectorTargetId = useReaStore((s) => s.inspectorTargetId);
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;

  const close = () => setPaletteOpen(false);
  const run = (fn: () => void) => {
    close();
    // Let the dialog unmount before the action mutates heavy state.
    setTimeout(fn, 10);
  };

  return (
    <CommandDialog
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      showCloseButton={false}
      className="border-zinc-800 bg-zinc-950 [&_[cmdk-input-wrapper]]:border-b [&_[cmdk-input-wrapper]]:border-zinc-800/80 [&_[cmdk-input]]:h-11 [&_[cmdk-input]]:font-sans [&_[cmdk-input]]:text-sm [&_[cmdk-item]]:py-2 [&_[cmdk-item]_svg]:size-3.5"
    >
      <CommandInput
        placeholder="Search chats, files and commands…"
        className="text-zinc-100 placeholder:text-zinc-600"
      />
      <CommandList className="max-h-[380px] rea-scroll">
        <CommandEmpty className="py-6 text-center font-mono text-xs text-zinc-600">
          No matching chats, files or commands.
        </CommandEmpty>

        {/* ---------------- Actions ---------------- */}
        <CommandGroup heading="Actions" className={GROUP_HEADING_CLS}>
          <Item icon={Plus} label="New free chat" hint="⌘⇧O" onSelect={() => run(newFreeChat)} />
          <Item
            icon={Upload}
            label="Upload a file to investigate"
            onSelect={() => run(actions.onUpload)}
          />
          <Item
            icon={PanelLeft}
            label="Toggle sidebar"
            hint="⌘B"
            onSelect={() => run(toggleSidebar)}
          />
          <Item
            icon={PanelRight}
            label={inspectorOpen ? "Close inspector" : "Open inspector"}
            hint="⌘I"
            onSelect={() =>
              run(() => {
                const s = useReaStore.getState();
                if (s.inspectorOpen) {
                  s.closeInspector();
                  return;
                }
                const tid = s.inspectorTargetId ?? activeSession?.targetId ?? null;
                if (tid) s.openInspector(tid);
              })
            }
          />
          {activeSession && (
            <Item
              icon={Download}
              label="Export chat as Markdown"
              onSelect={() => run(actions.onExportChat)}
            />
          )}
          {activeSession && actions.onTogglePinCurrent && (
            <Item
              icon={activeSession.pinned ? PinOff : Pin}
              label={activeSession.pinned ? "Unpin current chat" : "Pin current chat"}
              onSelect={() => run(actions.onTogglePinCurrent!)}
            />
          )}
          {(inspectorTargetId ?? activeSession?.targetId) && (
            <Item
              icon={Download}
              label="Export investigation report"
              onSelect={() => run(actions.onExportReport)}
            />
          )}
        </CommandGroup>

        <CommandSeparator className="bg-zinc-800/70" />

        {/* ---------------- Chats ---------------- */}
        {sessions.length > 0 && (
          <>
            <CommandGroup heading="Recent chats" className={GROUP_HEADING_CLS}>
              {sessions.slice(0, 8).map((s) => (
                <ChatItem key={s.id} session={s} onSelect={() => run(() => openSession(s.id))} />
              ))}
            </CommandGroup>
            <CommandSeparator className="bg-zinc-800/70" />
          </>
        )}

        {/* ---------------- Files ---------------- */}
        {targets.length > 0 && (
          <CommandGroup heading="Files" className={GROUP_HEADING_CLS}>
            {targets.map((t) => (
              <FileItem
                key={t.id}
                target={t}
                onChat={() => run(() => newTargetChat(t.id))}
                onInspect={() => run(() => openInspector(t.id))}
              />
            ))}
          </CommandGroup>
        )}

        <CommandSeparator className="bg-zinc-800/70" />

        {/* ---------------- Settings ---------------- */}
        <CommandGroup heading="Settings" className={GROUP_HEADING_CLS}>
          <Item
            icon={KeyRound}
            label="API key & model…"
            onSelect={() => run(() => setDialog("settings"))}
          />
          <Item
            icon={MonitorDot}
            label="Engine & security…"
            onSelect={() => run(() => setDialog("system"))}
          />
          <Item
            icon={Keyboard}
            label="Keyboard shortcuts"
            onSelect={() => run(() => useReaStore.getState().setShortcutsOpen(true))}
          />
          <Item
            icon={LogOut}
            label="Sign out"
            danger
            onSelect={() => run(actions.onLogout)}
          />
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

function Item({
  icon: Icon,
  label,
  hint,
  danger,
  onSelect,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint?: string;
  danger?: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      onSelect={onSelect}
      className={cnItem(danger)}
    >
      <Icon className="shrink-0 text-zinc-500" aria-hidden />
      <span className="flex-1 truncate">{label}</span>
      {hint && <span className="font-mono text-[10px] text-zinc-600">{hint}</span>}
    </CommandItem>
  );
}

function cnItem(danger?: boolean): string {
  return danger
    ? "gap-2.5 rounded-md px-2.5 text-xs text-rose-400 aria-selected:bg-rose-500/10 aria-selected:text-rose-300"
    : "gap-2.5 rounded-md px-2.5 text-xs text-zinc-300 aria-selected:bg-zinc-800/80 aria-selected:text-zinc-100";
}

function ChatItem({
  session,
  onSelect,
}: {
  session: SessionSummary;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={`chat ${session.title} ${session.targetName ?? ""}`}
      onSelect={onSelect}
      className="gap-2.5 rounded-md px-2.5 text-xs aria-selected:bg-zinc-800/80 aria-selected:text-zinc-100"
    >
      {session.pinned ? (
        <Pin className="shrink-0 text-amber-400" aria-hidden />
      ) : session.targetId ? (
        <Binary className="shrink-0 text-emerald-500/80" aria-hidden />
      ) : (
        <MessagesSquare className="shrink-0 text-zinc-500" aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate text-zinc-300">{session.title || "New chat"}</span>
      <span className="shrink-0 font-mono text-[10px] text-zinc-600">
        {session.messageCount} msg · {timeAgo(session.updatedAt)}
      </span>
    </CommandItem>
  );
}

function FileItem({
  target,
  onChat,
  onInspect,
}: {
  target: TargetSummary;
  onChat: () => void;
  onInspect: () => void;
}) {
  return (
    <>
      <CommandItem
        value={`file ${target.originalName} chat`}
        onSelect={onChat}
        className="gap-2.5 rounded-md px-2.5 text-xs aria-selected:bg-zinc-800/80 aria-selected:text-zinc-100"
      >
        <Binary className="shrink-0 text-zinc-500" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-zinc-300">{target.originalName}</span>
        <span className="shrink-0 font-mono text-[10px] text-zinc-600">chat about</span>
      </CommandItem>
      <CommandItem
        value={`inspect ${target.originalName}`}
        onSelect={onInspect}
        className="gap-2.5 rounded-md px-2.5 text-[11px] aria-selected:bg-zinc-800/80 aria-selected:text-zinc-100"
      >
        <MonitorDot className="ml-5 shrink-0 text-zinc-600" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-zinc-500">
          inspect {target.originalName}
        </span>
      </CommandItem>
    </>
  );
}
