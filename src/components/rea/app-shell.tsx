"use client";

import * as React from "react";
import Image from "next/image";
import {
  Binary,
  Check,
  CircleDot,
  CircleUserRound,
  Download,
  KeyRound,
  LogOut,
  MessageSquare,
  MonitorDot,
  MoreHorizontal,
  PanelLeft,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Radar,
  SearchIcon,
  Settings2,
  Sparkles,
  Upload,
  X,
} from "lucide-react";

import {
  apiGet,
  apiPost,
  apiUpload,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  renameChatSession,
  searchChatMessages,
  setChatSessionPinned,
  type Capabilities,
  type ReaUser,
  type SessionSummary,
  type TargetDetail,
  type TargetSummary,
} from "@/lib/api-client";
import { exportChat, exportTargetReport } from "@/lib/export";
import { formatCostUsd } from "@/lib/pricing";
import { useReaStore } from "@/store/rea-store";
import { refreshProviderInStore } from "@/components/rea/rea-app";
import { ChatWorkspace } from "@/components/rea/chat-workspace";
import { PlatformView } from "@/components/rea/platform-view";
import type { MessageSearchHit } from "@/lib/api-client";
import { CommandPalette } from "@/components/rea/command-palette";
import { SettingsDialog } from "@/components/rea/settings-dialog";
import { ShortcutsDialog } from "@/components/rea/shortcuts-dialog";
import { SystemDialog } from "@/components/rea/system-dialog";
import { TargetPanel } from "@/components/rea/target-panel";
import { humanBytes, timeAgo, toastError } from "@/components/rea/shared";
import { toast } from "@/hooks/use-toast";
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
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// AppShell — Cursor/Claude-Code-style chrome:
// slim top bar · left sidebar (chats + files) · chat-first main area ·
// optional right inspector panel · VSCode-style status bar.
// ---------------------------------------------------------------------------

/** SSR-safe matchMedia hook (desktop = lg breakpoint, 1024px). */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isDesktop;
}

export function AppShell({ user, onLogout }: { user: ReaUser; onLogout?: () => void }) {
  const isDesktop = useIsDesktop();
  const {
    sessions,
    sessionsLoaded,
    targets,
    targetsLoaded,
    activeSessionId,
    draftTargetId,
    inspectorOpen,
    inspectorTargetId,
    inspectorTab,
    dialog,
    shortcutsOpen,
    setSessions,
    setSessionsLoaded,
    setTargets,
    setTargetsLoaded,
    setDialog,
    openSession,
    newFreeChat,
    closeInspector,
    setCapabilities,
    workspaceMode,
    setWorkspaceMode,
  } = useReaStore();
  const inspectorTabNonce = useReaStore((s) => s.inspectorTabNonce);

  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const [deletingSession, setDeletingSession] = React.useState<SessionSummary | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [renamingSession, setRenamingSession] = React.useState<SessionSummary | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [exportingChat, setExportingChat] = React.useState(false);
  const [exportingReport, setExportingReport] = React.useState(false);
  /** Depth counter for the drag-and-drop upload overlay (only real file drags). */
  const [dragDepth, setDragDepth] = React.useState(0);
  const sidebarOpen = useReaStore((s) => s.sidebarOpen);

  const activeSession = React.useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );
  const draftTarget = React.useMemo(
    () => targets.find((t) => t.id === draftTargetId) ?? null,
    [targets, draftTargetId]
  );

  // ---- Initial data ------------------------------------------------------
  React.useEffect(() => {
    void refreshProviderInStore();
    listChatSessions()
      .then((rows) => {
        setSessions(rows);
        setSessionsLoaded(true);
      })
      .catch(() => setSessionsLoaded(true));
    apiGet<{ targets: TargetSummary[] }>("/api/targets")
      .then((res) => {
        setTargets(res.targets);
        setTargetsLoaded(true);
      })
      .catch(() => setTargetsLoaded(true));
    apiGet<Capabilities>("/api/capabilities")
      .then((res) => setCapabilities(res))
      .catch(() => undefined);
  }, []);

  /** Re-fetch sessions (after a stream finishes, delete, or new chat). */
  const refreshSessions = React.useCallback(async () => {
    try {
      const rows = await listChatSessions();
      useReaStore.getState().setSessions(rows);
      useReaStore.getState().setSessionsLoaded(true);
    } catch {
      /* sidebar stays as-is */
    }
  }, []);

  const refreshTargets = React.useCallback(async () => {
    try {
      const res = await apiGet<{ targets: TargetSummary[] }>("/api/targets");
      useReaStore.getState().setTargets(res.targets);
      useReaStore.getState().setTargetsLoaded(true);
    } catch {
      /* ignore */
    }
  }, []);

  const doLogout = async () => {
    try {
      await apiPost("/api/auth/logout");
    } catch {
      /* ignore */
    }
    onLogout?.();
    window.location.reload();
  };

  // ---- Global keyboard shortcuts (Cursor-style) ---------------------------
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) {
        // "?" — keyboard cheat sheet (only when not typing in a field).
        if (e.key === "?") {
          const el = e.target as HTMLElement | null;
          const typing =
            !!el &&
            (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
          if (!typing) {
            e.preventDefault();
            useReaStore.getState().setShortcutsOpen(true);
          }
        }
        return;
      }
      const key = e.key.toLowerCase();
      const s = useReaStore.getState();
      if (key === "k") {
        e.preventDefault();
        s.setPaletteOpen(!s.paletteOpen);
      } else if (key === "b" && !e.shiftKey) {
        e.preventDefault();
        s.toggleSidebar();
      } else if (key === "i" && !e.shiftKey) {
        e.preventDefault();
        if (s.inspectorOpen) {
          s.closeInspector();
        } else {
          const st = useReaStore.getState();
          const tid =
            st.inspectorTargetId ??
            st.sessions.find((x) => x.id === st.activeSessionId)?.targetId ??
            st.draftTargetId ??
            null;
          if (tid) st.openInspector(tid);
        }
      } else if (key === "o" && e.shiftKey) {
        e.preventDefault();
        s.newFreeChat();
      } else if (key === "f" && !e.shiftKey) {
        // ⌘F — focus the sidebar quick filter (Cursor-style). Must not yank
        // focus out of a field the user is typing in (composer, rename…).
        const el = e.target as HTMLElement | null;
        const typing =
          !!el &&
          (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) &&
          el.id !== "rea-sidebar-filter";
        if (typing) return;
        e.preventDefault();
        if (!s.sidebarOpen) s.setSidebarOpen(true);
        requestAnimationFrame(() => {
          document.getElementById("rea-sidebar-filter")?.focus();
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- Upload flow: upload → auto-analyze → draft chat on the new file ---
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const onPickFile = () => fileInputRef.current?.click();

  const onFileSelected = async (file: File) => {
    if (uploading) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await apiUpload<{ target: TargetSummary }>("/api/targets", fd);
      // Fire-and-forget auto-analysis (chat agent benefits from findings).
      void apiPost(`/api/targets/${res.target.id}/analyze`, {}).catch(() => undefined);
      await refreshTargets();
      useReaStore.getState().newTargetChat(res.target.id);
      setMobileNavOpen(false);
    } catch (err) {
      toastError(err, "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const onDeleteSession = async () => {
    if (!deletingSession) return;
    const target = deletingSession;
    setDeletingSession(null);
    try {
      await deleteChatSession(target.id);
      if (useReaStore.getState().activeSessionId === target.id) {
        useReaStore.getState().newFreeChat();
      }
      await refreshSessions();
    } catch (err) {
      toastError(err, "Could not delete chat");
    }
  };

  const startRename = (s: SessionSummary) => {
    setRenamingSession(s);
    setRenameValue(s.title);
  };

  /** Pin or unpin a chat (pinned chats get their own sidebar section). */
  const onTogglePin = async (s: SessionSummary) => {
    try {
      await setChatSessionPinned(s.id, !s.pinned);
      await refreshSessions();
    } catch (err) {
      toastError(err, "Could not update pin");
    }
  };

  const commitRename = async () => {
    const session = renamingSession;
    if (!session) return;
    const title = renameValue.trim().slice(0, 120);
    setRenamingSession(null);
    if (!title || title === session.title) return;
    try {
      await renameChatSession(session.id, title);
      await refreshSessions();
    } catch (err) {
      toastError(err, "Could not rename chat");
    }
  };

  /** Download the active chat transcript as Markdown. */
  const onExportChat = async () => {
    if (!activeSession || exportingChat) return;
    setExportingChat(true);
    try {
      const { session, messages } = await getChatSession(activeSession.id);
      exportChat(session.title, messages, {
        targetName: session.targetName,
        detectedFormat: session.detectedFormat,
      });
    } catch (err) {
      toastError(err, "Could not export chat");
    } finally {
      setExportingChat(false);
    }
  };

  /** Download the investigation report for the current file context as Markdown. */
  const onExportReport = async () => {
    // Same fallback chain as ⌘I — the palette offers this action whenever any
    // file context exists, so a silent no-op (inspector never opened) was a
    // broken promise.
    const st = useReaStore.getState();
    const reportTargetId =
      st.inspectorTargetId ?? activeSession?.targetId ?? st.draftTargetId ?? null;
    if (!reportTargetId || exportingReport) return;
    setExportingReport(true);
    try {
      const res = await apiGet<{ target: TargetDetail }>(`/api/targets/${reportTargetId}`);
      await exportTargetReport(res.target);
    } catch (err) {
      toastError(err, "Could not export report");
    } finally {
      setExportingReport(false);
    }
  };

  const openSessionAndClose = (id: string) => {
    openSession(id);
    setMobileNavOpen(false);
  };

  /** Open a message search hit in its chat and flash-highlight the message. */
  const openMessageHit = (hit: MessageSearchHit) => {
    const st = useReaStore.getState();
    st.requestJumpToMessage(hit.messageId);
    if (hit.sessionId !== st.activeSessionId) {
      openSession(hit.sessionId);
    }
    setMobileNavOpen(false);
  };

  // ---- Drag & drop upload (whole shell; only real file drags) ------------
  const isFileDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDragEnter = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setDragDepth((d) => d + 1);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); // required for the drop event to fire
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    setDragDepth((d) => Math.max(0, d - 1));
  };
  const onDrop = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    setDragDepth(0);
    const files = Array.from(e.dataTransfer?.files ?? []);
    const file = files[0];
    if (file) {
      if (files.length > 1) {
        toast({
          title: "One file at a time",
          description: `Dropped ${files.length} files — “${file.name}” was added; drag the next file when ready.`,
        });
      }
      void onFileSelected(file);
    }
  };

  const topBarTitle = workspaceMode === "universal"
    ? "Universal Platform"
    : activeSession
      ? activeSession.title
      : draftTarget
        ? draftTarget.originalName
        : "New chat";

  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-100"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* Drop-zone overlay (pointer-events-none so the drop reaches the shell) */}
      {dragDepth > 0 && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-emerald-500/5 backdrop-blur-[2px]"
        >
          <div className="rounded-xl border-2 border-dashed border-emerald-500/60 bg-zinc-950/85 px-10 py-7 text-center shadow-2xl shadow-emerald-500/10">
            <Upload className="mx-auto size-6 text-emerald-400" aria-hidden />
            <p className="mt-2.5 text-sm font-medium text-zinc-100">Drop to investigate</p>
            <p className="mt-1 font-mono text-[10px] text-zinc-500">
              parsed read-only · never executed
            </p>
          </div>
        </div>
      )}

      {/* ============================== Top bar ============================== */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-800/80 bg-zinc-950 px-2 sm:px-3">
        {/* Mobile sidebar trigger */}
        <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-zinc-400 md:hidden"
              aria-label="Open sidebar"
            >
              <PanelLeft className="size-4" aria-hidden />
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 border-zinc-800 bg-zinc-950 p-0">
            <SheetHeader className="border-b border-zinc-800/80 px-4 py-3">
              <SheetTitle className="flex items-center gap-2 font-mono text-xs tracking-widest text-zinc-200">
                <Image src="/rea-logo-256.png" alt="" width={16} height={16} className="size-4 rounded-[5px] ring-1 ring-zinc-700/60" aria-hidden />
                REA
              </SheetTitle>
            </SheetHeader>
            <SidebarBody
              sessions={sessions}
              sessionsLoaded={sessionsLoaded}
              targets={targets}
              targetsLoaded={targetsLoaded}
              activeSessionId={activeSessionId}
              draftTargetId={draftTargetId}
              uploading={uploading}
              renamingSession={renamingSession}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              onNewChat={() => {
                newFreeChat();
                setMobileNavOpen(false);
              }}
              onOpenSession={openSessionAndClose}
              onOpenMessageHit={openMessageHit}
              onDeleteSession={(s) => setDeletingSession(s)}
              onStartRename={startRename}
              onCommitRename={() => void commitRename()}
              onCancelRename={() => setRenamingSession(null)}
              onTogglePin={(s) => void onTogglePin(s)}
              onUpload={onPickFile}
              onOpenTargetChat={(id) => {
                useReaStore.getState().newTargetChat(id);
                setMobileNavOpen(false);
              }}
              onInspect={(id) => {
                useReaStore.getState().openInspector(id);
                setMobileNavOpen(false);
              }}
              onOpenSettings={() => {
                setDialog("settings");
                setMobileNavOpen(false);
              }}
              onOpenSystem={() => {
                setDialog("system");
                setMobileNavOpen(false);
              }}
              user={user}
              onLogout={() => void doLogout()}
            />
          </SheetContent>
        </Sheet>

        {/* Brand — clicking returns to the Home dashboard (fresh free chat). */}
        <button
          type="button"
          onClick={() => { newFreeChat(); setWorkspaceMode("chat"); }}
          title="Back to Home"
          aria-label="REA home — start a fresh chat"
          className="flex items-center gap-2 rounded font-mono text-xs font-bold tracking-widest text-zinc-200 transition-colors hover:text-emerald-300 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
        >
          <Image src="/rea-logo-256.png" alt="" width={20} height={20} className="size-5 rounded-md ring-1 ring-zinc-700/60" aria-hidden />
          REA
        </button>

        {/* Mode switch — chat investigator vs universal platform. */}
        <div className="ml-1 flex items-center rounded-lg border border-zinc-800 bg-zinc-900/70 p-0.5" role="tablist" aria-label="Workspace mode">
          <button
            type="button"
            role="tab"
            aria-selected={workspaceMode === "chat"}
            onClick={() => setWorkspaceMode("chat")}
            title="Chat workspace"
            className={`flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] tracking-wide transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none ${
              workspaceMode === "chat" ? "bg-emerald-500/15 text-emerald-300" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <MessageSquare className="size-3" aria-hidden />
            <span className="hidden sm:inline">CHAT</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={workspaceMode === "universal"}
            onClick={() => setWorkspaceMode("universal")}
            title="Universal platform — crawl, parse, research, build, verify"
            className={`flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] tracking-wide transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none ${
              workspaceMode === "universal" ? "bg-emerald-500/15 text-emerald-300" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <Radar className="size-3" aria-hidden />
            <span className="hidden sm:inline">PLATFORM</span>
          </button>
        </div>

        {/* Context title */}
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-300">{topBarTitle}</span>

        {/* Model chip → settings */}
        <ModelChip />

        {/* Export chat transcript */}
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "size-8 text-zinc-400",
            (!activeSession || workspaceMode !== "chat") && "hidden"
          )}
          aria-label="Export chat as Markdown"
          disabled={exportingChat}
          onClick={() => void onExportChat()}
        >
          <Download className="size-4" aria-hidden />
        </Button>

        {/* Inspector toggle (desktop, chat mode) */}
        {workspaceMode === "chat" && (
        <Button
          variant="ghost"
          size="icon"
          className="hidden size-8 text-zinc-400 lg:inline-flex"
          aria-label={inspectorOpen ? "Close inspector panel" : "Open inspector panel"}
          onClick={() => {
            if (inspectorOpen) closeInspector();
            else if (inspectorTargetId) useReaStore.getState().setInspectorOpen(true);
            else if (draftTarget) useReaStore.getState().openInspector(draftTarget.id);
            else if (activeSession?.targetId)
              useReaStore.getState().openInspector(activeSession.targetId);
          }}
        >
          {inspectorOpen ? (
            <PanelRightClose className="size-4" aria-hidden />
          ) : (
            <PanelRightOpen className="size-4" aria-hidden />
          )}
        </Button>
        )}

      </header>

      {/* ============================ Body row ============================== */}
      <div className="flex min-h-0 flex-1">
        {/* Desktop sidebar (collapsible via ⌘B) */}
        <aside
          aria-hidden={!sidebarOpen}
          className={cn(
            "w-64 shrink-0 border-r border-zinc-800/80 bg-zinc-950",
            sidebarOpen ? "hidden md:flex md:flex-col" : "hidden"
          )}
        >
          <SidebarBody
            sessions={sessions}
            sessionsLoaded={sessionsLoaded}
            targets={targets}
            targetsLoaded={targetsLoaded}
            activeSessionId={activeSessionId}
            draftTargetId={draftTargetId}
            uploading={uploading}
            renamingSession={renamingSession}
            renameValue={renameValue}
            setRenameValue={setRenameValue}
            onNewChat={newFreeChat}
            onOpenSession={openSession}
            onOpenMessageHit={openMessageHit}
            onDeleteSession={(s) => setDeletingSession(s)}
            onStartRename={startRename}
            onCommitRename={() => void commitRename()}
            onCancelRename={() => setRenamingSession(null)}
            onTogglePin={(s) => void onTogglePin(s)}
            onUpload={onPickFile}
            onOpenTargetChat={(id) => useReaStore.getState().newTargetChat(id)}
            onInspect={(id) => useReaStore.getState().openInspector(id)}
            onOpenSettings={() => setDialog("settings")}
            onOpenSystem={() => setDialog("system")}
            user={user}
            onLogout={() => void doLogout()}
          />
        </aside>

        {/* Main: universal platform OR chat + optional inspector */}
        <main className="flex min-w-0 flex-1">
          {workspaceMode === "universal" ? (
            <div className="relative min-w-0 flex-1">
              <PlatformView />
            </div>
          ) : (
            <>
              <ChatWorkspace
                className="min-w-0 flex-1"
                onSessionsChanged={refreshSessions}
                onTargetsChanged={refreshTargets}
                onAttachFile={onPickFile}
              />

              {/* Desktop inspector (lg+) */}
              {isDesktop && inspectorOpen && inspectorTargetId && (
                <aside
                  className="flex w-[420px] shrink-0 flex-col overflow-hidden border-l border-zinc-800/80 bg-zinc-950"
                  aria-label="Target inspector"
                >
                  <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-800/80 px-3">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                      Inspector
                    </span>
                    <div className="flex items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-zinc-500 hover:text-emerald-400"
                        aria-label="Export investigation report as Markdown"
                        disabled={exportingReport}
                        onClick={() => void onExportReport()}
                      >
                        <Download className="size-3.5" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-zinc-500 hover:text-zinc-200"
                        aria-label="Close inspector"
                        onClick={closeInspector}
                      >
                        <PanelRightClose className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto rea-scroll">
                    <TargetPanel
                      targetId={inspectorTargetId}
                      externalTab={inspectorTab}
                      externalTabNonce={inspectorTabNonce}
                    />
                  </div>
                </aside>
              )}
            </>
          )}
        </main>
      </div>

      {/* Mobile inspector overlay (<lg only) */}
      {!isDesktop && inspectorOpen && inspectorTargetId && (
        <Sheet open onOpenChange={(open) => !open && closeInspector()}>
          <SheetContent side="right" className="w-full border-zinc-800 bg-zinc-950 p-0 sm:w-[420px]">
            <SheetHeader className="border-b border-zinc-800/80 px-4 py-2.5">
              <SheetTitle className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                Inspector
              </SheetTitle>
            </SheetHeader>
            <div className="h-[calc(100%-3rem)] overflow-y-auto rea-scroll">
              <TargetPanel
                targetId={inspectorTargetId}
                externalTab={inspectorTab}
                externalTabNonce={inspectorTabNonce}
              />
            </div>
          </SheetContent>
        </Sheet>
      )}

      {/* ========================= Command palette ========================== */}
      {/* Inline actions object: CommandDialog renders nothing while closed,
          so the per-render allocation is free; reading the current session
          from the store keeps the pin action staleness-proof. */}
      <CommandPalette
        actions={{
          onUpload: onPickFile,
          onExportChat: () => void onExportChat(),
          onExportReport: () => void onExportReport(),
          onLogout: () => void doLogout(),
          onTogglePinCurrent: () => {
            const st = useReaStore.getState();
            const current = st.sessions.find((x) => x.id === st.activeSessionId);
            if (current) void onTogglePin(current);
          },
        }}
      />

      {/* ============================== Dialogs ============================= */}
      <SettingsDialog
        open={dialog === "settings"}
        onOpenChange={(open) => setDialog(open ? "settings" : "none")}
        onChanged={() => void refreshProviderInStore()}
      />
      <SystemDialog
        open={dialog === "system"}
        onOpenChange={(open) => setDialog(open ? "system" : "none")}
        targetId={
          useReaStore.getState().inspectorTargetId ??
          activeSession?.targetId ??
          useReaStore.getState().draftTargetId ??
          null
        }
      />
      <ShortcutsDialog
        open={shortcutsOpen}
        onOpenChange={(open) => useReaStore.getState().setShortcutsOpen(open)}
      />

      {/* Delete-chat confirmation */}
      <AlertDialog open={deletingSession !== null} onOpenChange={(o) => !o && setDeletingSession(null)}>
        <AlertDialogContent className="border-zinc-800 bg-zinc-900">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-zinc-100">Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription className="text-zinc-400">
              “{deletingSession?.title}” and its messages will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-zinc-700 bg-transparent text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-500"
              onClick={(e) => {
                e.preventDefault();
                void onDeleteSession();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Hidden file input for uploads */}
      <input
        ref={fileInputRef}
        type="file"
        className="sr-only"
        aria-label="Upload a file to investigate"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onFileSelected(f);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model chip (top bar) — click opens settings.
// ---------------------------------------------------------------------------

function ModelChip() {
  const { providerActive, hasProviderKey, providerLoaded, setDialog } = useReaStore();

  const label = providerActive
    ? `${providerActive.provider} · ${providerActive.model}`
    : "Platform model";

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => setDialog("settings")}
      aria-label={`Active AI model: ${label}. Open API key settings.`}
      className="hidden h-7 gap-1.5 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 font-mono text-[10px] tracking-wide text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 sm:inline-flex"
    >
      <CircleDot
        className={cn(
          "size-3",
          hasProviderKey === false ? "text-amber-400" : "text-emerald-500"
        )}
        aria-hidden
      />
      <span className="max-w-[160px] truncate">{label}</span>
      {!providerLoaded && <span className="text-zinc-600">…</span>}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Sidebar body — shared between desktop aside and mobile Sheet.
// ---------------------------------------------------------------------------

interface SidebarBodyProps {
  sessions: SessionSummary[];
  sessionsLoaded: boolean;
  targets: TargetSummary[];
  targetsLoaded: boolean;
  activeSessionId: string | null;
  draftTargetId: string | null;
  uploading: boolean;
  renamingSession: SessionSummary | null;
  renameValue: string;
  setRenameValue: (v: string) => void;
  onNewChat: () => void;
  onOpenSession: (id: string) => void;
  onOpenMessageHit: (hit: MessageSearchHit) => void;
  onDeleteSession: (s: SessionSummary) => void;
  onStartRename: (s: SessionSummary) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onTogglePin: (s: SessionSummary) => void;
  onUpload: () => void;
  onOpenTargetChat: (targetId: string) => void;
  onInspect: (targetId: string) => void;
  onOpenSettings: () => void;
  onOpenSystem: () => void;
  user: ReaUser;
  onLogout: () => void;
}

function SidebarBody(p: SidebarBodyProps) {
  /** Client-side filter for chats + files (Cursor-style quick search). */
  const [search, setSearch] = React.useState("");
  const q = search.trim().toLowerCase();

  /** Server-side message-content search results (debounced, q ≥ 2 chars). */
  const [msgHits, setMsgHits] = React.useState<MessageSearchHit[]>([]);
  const [msgSearching, setMsgSearching] = React.useState(false);
  const searchQuery = search.trim();
  React.useEffect(() => {
    if (searchQuery.length < 2) {
      setMsgHits([]);
      setMsgSearching(false);
      return;
    }
    let cancelled = false;
    setMsgSearching(true);
    const t = setTimeout(() => {
      searchChatMessages(searchQuery)
        .then((hits) => {
          if (!cancelled) setMsgHits(hits.slice(0, 8));
        })
        .catch(() => {
          if (!cancelled) setMsgHits([]);
        })
        .finally(() => {
          if (!cancelled) setMsgSearching(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [searchQuery]);

  /** Wrap occurrences of the query in an emerald <mark> inside a snippet. */
  const highlight = (snippet: string, query: string): React.ReactNode => {
    if (!query) return snippet;
    const parts: React.ReactNode[] = [];
    const lower = snippet.toLowerCase();
    const needle = query.toLowerCase();
    let i = 0;
    let key = 0;
    while (true) {
      const at = lower.indexOf(needle, i);
      if (at === -1) {
        parts.push(snippet.slice(i));
        break;
      }
      if (at > i) parts.push(snippet.slice(i, at));
      parts.push(
        <mark
          key={key++}
          className="rounded-sm bg-emerald-500/20 px-0.5 text-emerald-300"
        >
          {snippet.slice(at, at + needle.length)}
        </mark>
      );
      i = at + needle.length;
    }
    return parts;
  };
  const matchSessions = q
    ? p.sessions.filter(
        (s) =>
          (s.title || "new chat").toLowerCase().includes(q) ||
          (s.targetName ?? "").toLowerCase().includes(q)
      )
    : p.sessions;
  const shownPinned = matchSessions.filter((s) => s.pinned);
  const shownChats = matchSessions.filter((s) => !s.pinned);
  const shownTargets = q
    ? p.targets.filter((t) => t.originalName.toLowerCase().includes(q))
    : p.targets;

  /** One chat row (shared by the Pinned and Chats sections). */
  const renderSessionRow = (s: SessionSummary) => {
    const active = s.id === p.activeSessionId && !p.draftTargetId;
    const renaming = p.renamingSession?.id === s.id;
    return (
      <div
        key={s.id}
        className={cn(
          "group relative flex items-center gap-1.5 rounded-md pr-1 transition-colors",
          active ? "bg-zinc-800/80" : "hover:bg-zinc-900"
        )}
      >
        {/* Active accent (VSCode-style left bar) */}
        <span
          aria-hidden
          className={cn(
            "absolute top-1 bottom-1 left-0 w-0.5 rounded-full transition-opacity",
            active ? "bg-emerald-500 opacity-90" : "opacity-0"
          )}
        />
        {renaming ? (
          <div className="flex min-w-0 flex-1 items-center gap-1 px-1.5 py-1">
            <input
              autoFocus
              value={p.renameValue}
              onChange={(e) => p.setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void p.onCommitRename();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  p.onCancelRename();
                }
              }}
              aria-label="Rename chat"
              maxLength={120}
              className="h-6 min-w-0 flex-1 rounded border border-emerald-500/40 bg-zinc-950 px-1.5 font-mono text-[11px] text-zinc-100 focus-visible:outline-none"
            />
            <button
              type="button"
              aria-label="Save chat name"
              onClick={() => void p.onCommitRename()}
              className="rounded p-1 text-emerald-400 hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
            >
              <Check className="size-3.5" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Cancel renaming"
              onClick={p.onCancelRename}
              className="rounded p-1 text-zinc-500 hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => p.onOpenSession(s.id)}
              aria-current={active ? "true" : undefined}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
            >
              {s.targetId ? (
                <Binary className="size-3.5 shrink-0 text-emerald-500/80" aria-hidden />
              ) : (
                <MessageSquare className="size-3.5 shrink-0 text-zinc-500" aria-hidden />
              )}
              <span
                className={cn(
                  "block min-w-0 flex-1 truncate text-[13px]",
                  active ? "text-zinc-100" : "text-zinc-400"
                )}
                title={[
                  s.targetName,
                  s.messageCount > 0 ? `${s.messageCount} messages` : null,
                  timeAgo(s.updatedAt),
                  s.costUsd != null ? `est. ~${formatCostUsd(s.costUsd)}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                {s.title || "New chat"}
              </span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Chat options: ${s.title}`}
                  onClick={(e) => e.stopPropagation()}
                  className="touch-visible mr-0.5 shrink-0 rounded p-1 text-zinc-500 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-zinc-800 hover:text-zinc-200 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
                >
                  <MoreHorizontal className="size-3.5" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="w-44 border-zinc-800 bg-zinc-900"
              >
                <DropdownMenuItem onClick={() => p.onTogglePin(s)}>
                  {s.pinned ? "Unpin" : "Pin"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => p.onStartRename(s)}>
                  Rename
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-zinc-800" />
                <DropdownMenuItem
                  onClick={() => p.onDeleteSession(s)}
                  className="text-rose-400 focus:bg-rose-500/10 focus:text-rose-300"
                >
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    );
  };

  /** Cursor-style time grouping (only when NOT filtering — search stays flat). */
  const chatBuckets = (() => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfYesterday = new Date(startOfToday);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    const startOf7d = new Date(startOfToday);
    startOf7d.setDate(startOf7d.getDate() - 7);
    const buckets = [
      { label: "Today", items: [] as SessionSummary[] },
      { label: "Yesterday", items: [] as SessionSummary[] },
      { label: "Previous 7 days", items: [] as SessionSummary[] },
      { label: "Older", items: [] as SessionSummary[] },
    ];
    for (const s of shownChats) {
      const d = new Date(s.updatedAt);
      if (d >= startOfToday) buckets[0].items.push(s);
      else if (d >= startOfYesterday) buckets[1].items.push(s);
      else if (d >= startOf7d) buckets[2].items.push(s);
      else buckets[3].items.push(s);
    }
    return buckets.filter((b) => b.items.length > 0);
  })();
  const showTimeGroups = !q; // always group — labels stay consistent whether one bucket or many
  const chatsBody = showTimeGroups ? (
    chatBuckets.map((b) => (
      <div key={b.label} className="mb-1">
        <div className="flex items-center gap-2 px-2 pt-2.5 pb-1">
          <span className="font-mono text-[9px] tracking-widest text-zinc-600 uppercase">
            {b.label}
          </span>
          <span aria-hidden className="h-px flex-1 bg-zinc-800/60" />
          <span className="font-mono text-[9px] text-zinc-700 tabular-nums">{b.items.length}</span>
        </div>
        {b.items.map(renderSessionRow)}
      </div>
    ))
  ) : (
    shownChats.map(renderSessionRow)
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* New chat */}
      <div className="p-2 pb-1">
        <Button
          type="button"
          onClick={p.onNewChat}
          className="h-8 w-full justify-start gap-2 bg-zinc-900 text-xs text-zinc-200 hover:bg-zinc-800"
          aria-label="Start a new free chat"
        >
          <Plus className="size-3.5 text-emerald-400" aria-hidden />
          New chat
        </Button>
      </div>

      {/* Quick filter (chats & files) */}
      <div className="px-2 pb-1">
        <div className="group relative">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-zinc-600 transition-colors group-focus-within:text-emerald-500/80"
            aria-hidden
          />
          <input
            id="rea-sidebar-filter"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setSearch("");
              }
            }}
            placeholder="Filter & search messages…"
            aria-label="Filter chats, files and message content"
            className="h-7 w-full rounded-md border border-zinc-800/80 bg-zinc-900/50 pr-2 pl-7 font-mono text-[11px] text-zinc-200 transition-colors placeholder:text-zinc-600 focus:border-emerald-500/40 focus:bg-zinc-900 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rea-scroll">
        {/* Pinned chats */}
        {p.sessionsLoaded && shownPinned.length > 0 && (
          <SidebarSection label={`Pinned${q ? ` (${shownPinned.length})` : ""}`}>
            {shownPinned.map(renderSessionRow)}
          </SidebarSection>
        )}

        {/* Chats */}
        <SidebarSection label={`Chats${q ? ` (${shownChats.length})` : ""}`}>
          {!p.sessionsLoaded ? (
            <div className="space-y-1.5 px-2 py-1">
              <div className="h-6 animate-pulse rounded bg-zinc-900" />
              <div className="h-6 animate-pulse rounded bg-zinc-900" />
            </div>
          ) : p.sessions.length === 0 ? (
            <p className="px-2 py-1 text-[11px] leading-relaxed text-zinc-600">
              No chats yet. Ask anything, or pick a file below.
            </p>
          ) : matchSessions.length === 0 ? (
            <p className="px-2 py-1 font-mono text-[10px] text-zinc-600">
              no chats match “{search.trim()}”
            </p>
          ) : (
            chatsBody
          )}
        </SidebarSection>

        {/* Messages (server-side content search; only when filtering) */}
        {q.length >= 2 && (
          <SidebarSection
            label={`Messages${
              msgSearching
                ? " · searching…"
                : msgHits.length >= 8
                  ? " (first 8 — refine query)"
                  : msgHits.length > 0
                    ? ` (${msgHits.length})`
                    : ""
            }`}
          >
            {msgSearching && msgHits.length === 0 ? (
              <div className="space-y-1.5 px-2 py-1">
                <div className="h-7 animate-pulse rounded bg-zinc-900" />
                <div className="h-7 animate-pulse rounded bg-zinc-900" />
              </div>
            ) : msgHits.length === 0 ? (
              <p className="px-2 py-1 font-mono text-[10px] text-zinc-600">
                no message content matches
              </p>
            ) : (
              msgHits.map((hit) => (
                <div
                  key={hit.messageId}
                  className="group rounded-md transition-colors hover:bg-zinc-900"
                >
                  <button
                    type="button"
                    onClick={() => p.onOpenMessageHit(hit)}
                    aria-label={`Open ${hit.sessionTitle} at matching message`}
                    className="w-full rounded-md px-2 py-1.5 text-left focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
                  >
                    <span className="flex items-center gap-1.5">
                      {hit.role === "user" ? (
                        <CircleUserRound className="size-3 shrink-0 text-sky-500/70" aria-hidden />
                      ) : (
                        <Sparkles className="size-3 shrink-0 text-emerald-500/70" aria-hidden />
                      )}
                      <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-500">
                        {hit.sessionTitle || "New chat"}
                      </span>
                      <span className="shrink-0 text-[9px] text-zinc-600">
                        {timeAgo(hit.createdAt)}
                      </span>
                    </span>
                    <span className="mt-0.5 block line-clamp-2 text-[11px] leading-snug text-zinc-400 group-hover:text-zinc-300">
                      {highlight(hit.snippet, searchQuery)}
                    </span>
                  </button>
                </div>
              ))
            )}
          </SidebarSection>
        )}

        {/* Files */}
        <SidebarSection
          label={`Files${q ? ` (${shownTargets.length})` : ""}`}
          action={
          <button
            type="button"
            onClick={p.onUpload}
            aria-label="Upload a file"
            disabled={p.uploading}
            className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-emerald-400 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
          >
            <Upload className="size-3.5" aria-hidden />
          </button>
        }>
          {!p.targetsLoaded ? (
            <div className="space-y-1.5 px-2 py-1">
              <div className="h-8 animate-pulse rounded bg-zinc-900" />
            </div>
          ) : p.targets.length === 0 ? (
            <p className="px-2 py-1 text-[11px] leading-relaxed text-zinc-600">
              Upload a binary, database or app bundle to investigate it with the REA engine.
            </p>
          ) : shownTargets.length === 0 ? (
            <p className="px-2 py-1 font-mono text-[10px] text-zinc-600">
              no files match “{search.trim()}”
            </p>
          ) : (
            shownTargets.map((t) => (
              <div
                key={t.id}
                className={cn(
                  "group flex items-center rounded-md transition-colors",
                  t.id === p.draftTargetId ? "bg-zinc-800/80" : "hover:bg-zinc-900"
                )}
              >
                <button
                  type="button"
                  onClick={() => p.onOpenTargetChat(t.id)}
                  aria-label={`Start a chat about ${t.originalName}`}
                  title={`${t.detectedFormat ?? "file"} · ${humanBytes(t.sizeBytes)} · analysis: ${t.status}`}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
                >
                  <Binary className="size-3.5 shrink-0 text-zinc-500" aria-hidden />
                  <span className="block min-w-0 flex-1 truncate text-[13px] text-zinc-400 group-hover:text-zinc-200">
                    {t.originalName}
                  </span>
                </button>
                <span
                  role="img"
                  aria-label={`Analysis status: ${t.status}`}
                  title={`analysis: ${t.status}`}
                  className={cn(
                    "mr-0.5 size-1.5 shrink-0 rounded-full",
                    targetStatusDot(t.status)
                  )}
                />
                <button
                  type="button"
                  aria-label={`Inspect ${t.originalName}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    p.onInspect(t.id);
                  }}
                  className="touch-visible mr-0.5 shrink-0 rounded p-1 text-zinc-600 opacity-0 transition-all hover:text-emerald-400 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
                >
                  <MonitorDot className="size-3.5" aria-hidden />
                </button>
              </div>
            ))
          )}
        </SidebarSection>
      </div>

      {/* Account — Claude-style bottom user card (menu: keys, engine, sign out) */}
      <div className="shrink-0 border-t border-zinc-800/80 p-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Account options"
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-zinc-900 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-full border border-emerald-500/40 bg-emerald-500/10 font-mono text-[11px] text-emerald-400">
                {(p.user.name?.[0] ?? "U").toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs text-zinc-300">{p.user.name}</span>
                  {p.user.isDemo && (
                    <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1 font-mono text-[8px] tracking-wider text-emerald-400">
                      DEMO
                    </span>
                  )}
                </span>
                <span className="block truncate font-mono text-[10px] text-zinc-600">
                  {p.user.email}
                </span>
              </span>
              <Settings2 className="size-3.5 shrink-0 text-zinc-500" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            className="w-56 border-zinc-800 bg-zinc-900"
          >
            <DropdownMenuItem onClick={p.onOpenSettings} className="gap-2">
              <KeyRound className="size-3.5" aria-hidden />
              API key & model
            </DropdownMenuItem>
            <DropdownMenuItem onClick={p.onOpenSystem} className="gap-2">
              <MonitorDot className="size-3.5" aria-hidden />
              Engine & security
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-zinc-800" />
            <DropdownMenuItem
              onClick={p.onLogout}
              className="gap-2 text-rose-400 focus:bg-rose-500/10 focus:text-rose-300"
            >
              <LogOut className="size-3.5" aria-hidden />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function SidebarSection({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="px-2 pb-2" aria-label={label}>
      <div className="flex items-center justify-between px-2 pt-3 pb-1">
        <span className="text-[11px] font-medium tracking-wide text-zinc-500">{label}</span>
        {action && <span className="pr-1">{action}</span>}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

/** Sidebar status dot for a file's analysis state. */
function targetStatusDot(status: string): string {
  switch (status) {
    case "analyzed":
    case "completed":
      return "bg-emerald-500";
    case "failed":
      return "bg-rose-500";
    case "queued":
    case "analyzing":
    case "running":
      return "animate-pulse bg-amber-400";
    default:
      return "bg-zinc-600";
  }
}

// ---------------------------------------------------------------------------
// Status bar — intentionally removed. All of that information still exists in
// its honest home: engine/model in Settings & System dialog, quota next to the
// composer (only when it matters), per-message tokens on hover.
// ---------------------------------------------------------------------------
