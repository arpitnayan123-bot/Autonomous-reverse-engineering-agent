"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  ArrowDown,
  Binary,
  Check,
  ChevronDown,
  CircleAlert,
  GitFork,
  KeyRound,
  Loader2,
  Paperclip,
  PanelRightOpen,
  Pencil,
  Quote,
  RotateCcw,
  SendHorizontal,
  Square,
  Timer,
  Wrench,
  X,
} from "lucide-react";

import {
  forkChatSession,
  getChatSession,
  streamChat,
  type ChatMessageRow,
  type ChatStreamEvent,
  type TargetSummary,
} from "@/lib/api-client";
import { useReaStore } from "@/store/rea-store";
import { CopyButton, Markdown, humanBytes, humanDuration, humanTokens, toastError } from "@/components/rea/shared";
import { estimateCostUsd, formatCostUsd } from "@/lib/pricing";
import { toast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// ChatWorkspace — Cursor/Claude-Code-style conversation area.
// Free chats (no file) and file chats share this surface; file chats can call
// REA tools (visible inline as collapsible trace steps).
// ---------------------------------------------------------------------------

const FREE_SUGGESTIONS = [
  "What file formats can REA analyze?",
  "How do I start reverse engineering an unknown binary?",
  "Explain ELF program headers vs section headers",
  "What is the safest way to analyze a suspicious file?",
];

const TARGET_SUGGESTIONS = [
  "What does this file do?",
  "Explain the main functionality with evidence",
  "List interesting strings and what they suggest",
  "What are the limitations of this analysis?",
];

interface TraceStep {
  id: string;
  tool: string;
  args?: unknown;
  preview?: string | null;
  pending: boolean;
}

interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  trace: TraceStep[];
  error?: string;
  createdAt?: string;
  /** Provider-reported tokens (assistant; null = provider did not report). */
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** Wall-clock agent turn duration in ms (assistant). */
  durationMs?: number | null;
}

interface ModelInfo {
  source: string;
  provider: string;
  model: string;
}

let localId = 0;
function nextId() {
  localId += 1;
  return `local-${localId}`;
}

export function ChatWorkspace({
  className,
  onSessionsChanged,
  onTargetsChanged,
  onAttachFile,
}: {
  className?: string;
  onSessionsChanged?: () => void;
  onTargetsChanged?: () => void;
  /** Opens the hidden file picker (composer paperclip → upload → draft chat). */
  onAttachFile?: () => void;
}) {
  const {
    sessions,
    activeSessionId,
    draftTargetId,
    targets,
    inspectorOpen,
    openSession,
    setActiveSessionId,
    setDraftTargetId,
    openInspector,
    setDialog,
  } = useReaStore();

  const activeSession = React.useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId]
  );
  const draftTarget = React.useMemo(
    () => targets.find((t) => t.id === draftTargetId) ?? null,
    [targets, draftTargetId]
  );
  /** Target bound to the current view (session target or draft target). */
  const boundTarget: TargetSummary | null = activeSession?.targetId
    ? (targets.find((t) => t.id === activeSession.targetId) ?? null)
    : draftTarget;

  const [entries, setEntries] = React.useState<ChatEntry[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [streaming, setStreaming] = React.useState(false);
  const [modelInfo, setModelInfo] = React.useState<ModelInfo | null>(null);
  const [input, setInput] = React.useState("");
  /** Id of the user message being edited inline (edit-and-resend). */
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editValue, setEditValue] = React.useState("");
  /** False while the user scrolled up — suppresses autoscroll + shows the jump button. */
  const [atBottom, setAtBottom] = React.useState(true);

  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  /**
   * Set when the in-flight stream itself switches the active session
   * (session_saved) — the history effect must not abort the stream or
   * overwrite the live transcript in that case.
   */
  const skipHistoryLoadRef = React.useRef(false);
  /**
   * True once the streaming turn revealed a ```tool fence — later deltas of
   * that turn are dropped so raw tool JSON never flashes in the transcript.
   */
  const turnBecameToolRef = React.useRef(false);

  // ---- Load history when switching sessions / clearing to a draft ---------
  React.useEffect(() => {
    if (skipHistoryLoadRef.current) {
      // Session change came from the live stream — keep the transcript.
      skipHistoryLoadRef.current = false;
      return;
    }
    abortRef.current?.abort();
    setModelInfo(null);
    setInput("");
    if (!activeSessionId) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    getChatSession(activeSessionId)
      .then(({ messages }) => {
        if (cancelled) return;
        setEntries(messages.map(rowToEntry));
      })
      .catch((err) => {
        if (!cancelled) toastError(err, "Could not load chat history");
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  // ---- Session token total (status bar) -----------------------------------
  React.useEffect(() => {
    let tokensIn = 0;
    let tokensOut = 0;
    let any = false;
    for (const e of entries) {
      if (e.role === "assistant" && (e.tokensIn != null || e.tokensOut != null)) {
        any = true;
        tokensIn += e.tokensIn ?? 0;
        tokensOut += e.tokensOut ?? 0;
      }
    }
    useReaStore.getState().setSessionTokens(any ? { tokensIn, tokensOut } : null);
  }, [entries]);

  // ---- Autoscroll (only while pinned to bottom) ---------------------------
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el || !atBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [entries, streaming, atBottom]);

  // ---- Jump-to-message (sidebar search hit) -------------------------------
  const [jumpFlashId, setJumpFlashId] = React.useState<string | null>(null);
  const jumpToMessageId = useReaStore((s) => s.jumpToMessageId);
  const clearJumpToMessage = useReaStore((s) => s.clearJumpToMessage);
  React.useEffect(() => {
    if (!jumpToMessageId || historyLoading) return;
    // Let the transcript settle a tick before measuring positions.
    const t = window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(jumpToMessageId)}"]`
      );
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        setAtBottom(false);
        setJumpFlashId(jumpToMessageId);
        window.setTimeout(
          () => setJumpFlashId((cur) => (cur === jumpToMessageId ? null : cur)),
          1900
        );
      }
      clearJumpToMessage();
    }, 90);
    return () => window.clearTimeout(t);
  }, [jumpToMessageId, historyLoading, clearJumpToMessage]);

  const onMessagesScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance < 80);
  };

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setAtBottom(true);
  };

  // ---- Composer auto-resize ----------------------------------------------
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  // ---- Streaming ----------------------------------------------------------
  /**
   * Core turn runner shared by send / edit-and-resend / regenerate.
   * `commit` transforms the local transcript BEFORE the fresh assistant entry
   * is appended (append the user entry, truncate at the edited turn, …).
   */
  const runTurn = async (opts: {
    message: string;
    editMessageId?: string;
    regenerate?: boolean;
    /** Local id of a just-appended user entry — renamed when user_saved arrives. */
    localUserId?: string;
    commit: (prev: ChatEntry[]) => ChatEntry[];
  }) => {
    const sessionId = activeSessionId;
    const targetId = boundTarget?.id ?? draftTargetId ?? null;
    const assistantEntry: ChatEntry = { id: nextId(), role: "assistant", content: "", trace: [] };
    setEntries((prev) => [...opts.commit(prev), assistantEntry]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const applyAssistant = (fn: (e: ChatEntry) => ChatEntry) =>
      setEntries((prev) => prev.map((e) => (e.id === assistantEntry.id ? fn(e) : e)));

    const onEvent = (ev: ChatStreamEvent) => {
      switch (ev.type) {
        case "session_saved": {
          // Pin the sidebar + future turns to the freshly created session
          // WITHOUT aborting the stream that created it.
          if (!sessionId) {
            skipHistoryLoadRef.current = true;
            setActiveSessionId(ev.sessionId);
            const s = useReaStore.getState();
            s.setSessions([
              {
                id: ev.sessionId,
                title: ev.title,
                targetId: ev.targetId,
                pinned: false,
                targetName: boundTarget?.originalName ?? null,
                detectedFormat: boundTarget?.detectedFormat ?? null,
                messageCount: 1,
                updatedAt: new Date().toISOString(),
              },
              ...s.sessions.filter((x) => x.id !== ev.sessionId),
            ]);
          }
          break;
        }
        case "user_saved":
          // Swap the optimistic local id for the persisted one so an
          // immediate edit-and-resend addresses a real server row.
          if (opts.localUserId) {
            const localId = opts.localUserId;
            setEntries((prev) =>
              prev.map((e) => (e.id === localId ? { ...e, id: ev.messageId } : e))
            );
          }
          break;
        case "model":
          setModelInfo({ source: ev.source, provider: ev.provider, model: ev.model });
          break;
        case "turn_start":
          // A fresh LLM turn began — reset the live draft buffer.
          turnBecameToolRef.current = false;
          applyAssistant((e) => ({ ...e, content: "" }));
          break;
        case "delta": {
          if (turnBecameToolRef.current) break; // tool JSON — never render
          applyAssistant((e) => {
            let content = e.content + ev.text;
            const fence = content.indexOf("```");
            if (fence >= 0) {
              // The model started emitting a tool block — keep only the
              // prose preamble and stop accepting this turn's deltas.
              turnBecameToolRef.current = true;
              content = content.slice(0, fence).trimEnd();
            }
            return { ...e, content };
          });
          break;
        }
        case "tool_call":
          turnBecameToolRef.current = true;
          applyAssistant((e) => ({
            ...e,
            trace: [
              ...e.trace,
              { id: nextId(), tool: ev.tool, args: ev.args, pending: true },
            ],
          }));
          break;
        case "tool_result":
          applyAssistant((e) => {
            const trace = [...e.trace];
            for (let i = trace.length - 1; i >= 0; i--) {
              if (trace[i].tool === ev.tool && trace[i].pending) {
                trace[i] = { ...trace[i], pending: false, preview: ev.preview ?? null };
                break;
              }
            }
            return { ...e, trace };
          });
          break;
        case "usage":
          // Authoritative turn totals from the provider (may be null when the
          // provider does not report usage — shown honestly as absent).
          applyAssistant((e) => ({
            ...e,
            tokensIn: ev.tokensIn,
            tokensOut: ev.tokensOut,
            durationMs: ev.durationMs,
          }));
          break;
        case "assistant":
          // Authoritative final text — replaces the streamed draft verbatim.
          turnBecameToolRef.current = false;
          applyAssistant((e) => ({ ...e, content: ev.content }));
          break;
        case "error":
          applyAssistant((e) => ({ ...e, error: ev.error }));
          toastError(new Error(ev.error), "Agent error");
          break;
        default:
          break;
      }
    };

    try {
      const { rateLimitRemaining } = await streamChat(
        {
          sessionId,
          targetId,
          message: opts.message,
          editMessageId: opts.editMessageId,
          regenerate: opts.regenerate,
          onEvent,
        },
        controller.signal
      );
      if (rateLimitRemaining !== null) {
        useReaStore.getState().setChatQuota({ limit: 20, remaining: rateLimitRemaining });
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        const msg = err instanceof Error ? err.message : "Chat failed";
        applyAssistant((e) => ({ ...e, error: msg }));
        toastError(err, "Chat failed");
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      onSessionsChanged?.();
      onTargetsChanged?.();
    }
  };

  /** Normal send: append the user turn and stream the answer. */
  const sendWithEvents = (raw: string) => {
    const message = raw.trim();
    if (!message || streaming) return;
    const userEntry: ChatEntry = { id: nextId(), role: "user", content: message, trace: [] };
    setInput("");
    void runTurn({
      message,
      localUserId: userEntry.id,
      commit: (prev) => [...prev, userEntry],
    });
  };

  /** Edit-and-resend: replace a user turn server-side, drop later turns, re-stream. */
  const submitEdit = (entryId: string) => {
    const content = editValue.trim();
    if (!content || streaming || !activeSessionId) return;
    setEditingId(null);
    void runTurn({
      message: content,
      editMessageId: entryId,
      commit: (prev) => {
        const idx = prev.findIndex((e) => e.id === entryId);
        if (idx < 0) return prev; // server replies 404 → error surfaces on the entry
        const edited: ChatEntry = { ...prev[idx], content, trace: [], error: undefined };
        return [...prev.slice(0, idx), edited];
      },
    });
  };

  /** Regenerate: drop the last assistant reply and re-run the last user turn. */
  const regenerateLast = () => {
    if (streaming || !activeSessionId) return;
    void runTurn({
      message: "",
      regenerate: true,
      commit: (prev) => {
        const last = prev[prev.length - 1];
        return last && last.role === "assistant" ? prev.slice(0, -1) : prev;
      },
    });
  };

  /**
   * Fork: branch a NEW chat that copies the history up to and including this
   * message. The original chat is left untouched.
   */
  const forkFrom = async (entry: ChatEntry) => {
    if (streaming || !activeSessionId || entry.id.startsWith("local-")) return;
    try {
      const summary = await forkChatSession(activeSessionId, entry.id);
      const s = useReaStore.getState();
      s.setSessions([summary, ...s.sessions]);
      s.openSession(summary.id);
      toast({
        title: "Chat forked",
        description: `“${summary.title}” continues from this point (${summary.messageCount} messages).`,
      });
      onSessionsChanged?.();
    } catch (err) {
      toastError(err, "Could not fork chat");
    }
  };

  const startEdit = (entry: ChatEntry) => {
    if (streaming) return;
    setEditingId(entry.id);
    setEditValue(entry.content);
  };

  /** Quote a message into the composer as a markdown blockquote. */
  const quoteIntoComposer = (entry: ChatEntry) => {
    if (streaming) return;
    const quoted = entry.content
      .split("\n")
      .slice(0, 6)
      .map((l) => `> ${l}`)
      .join("\n");
    const suffix = entry.content.split("\n").length > 6 ? "\n> …" : "";
    setInput((prev) => `${quoted}${suffix}\n\n${prev}`.trimStart());
    textareaRef.current?.focus();
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue("");
  };

  const stop = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendWithEvents(input);
    }
  };

  const showEmptyState = !historyLoading && entries.length === 0;
  const hasKey = useReaStore((s) => s.hasProviderKey);

  return (
    <section className={cn("relative flex min-h-0 flex-col bg-zinc-950", className)} aria-label="Chat">
      {/* Context strip (only when a file is attached) */}
      {boundTarget && (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-800/60 px-3 text-xs text-zinc-500">
          <Binary className="size-3.5 text-emerald-500/80" aria-hidden />
          <span className="truncate text-zinc-300">{boundTarget.originalName}</span>
          <span className="font-mono text-[10px] text-zinc-600">
            {humanBytes(boundTarget.sizeBytes)}
          </span>
          {boundTarget.status === "analyzing" && (
            <span className="flex items-center gap-1 font-mono text-[10px] text-amber-400">
              <Loader2 className="size-3 animate-spin" aria-hidden /> analyzing…
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 gap-1 px-2 text-[10px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            onClick={() => openInspector(boundTarget.id)}
          >
            <PanelRightOpen className="size-3" aria-hidden />
            Inspect
          </Button>
          {draftTarget && !activeSessionId && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-zinc-500 hover:text-zinc-200"
              aria-label="Detach file from this draft chat"
              onClick={() => setDraftTargetId(null)}
            >
              <X className="size-3" aria-hidden />
            </Button>
          )}
        </div>
      )}

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={onMessagesScroll}
        className="relative min-h-0 flex-1 overflow-y-auto rea-scroll"
      >
        {historyLoading ? (
          <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-8">
            <div className="h-16 animate-pulse rounded-lg bg-zinc-900" />
            <div className="h-24 animate-pulse rounded-lg bg-zinc-900" />
          </div>
        ) : showEmptyState ? (
          <EmptyState
            boundTarget={boundTarget}
            hasKey={hasKey}
            onSuggest={(text) => void sendWithEvents(text)}
            onOpenSettings={() => setDialog("settings")}
          />
        ) : (
          <div className="mx-auto w-full max-w-3xl px-4 py-6">
            <div className="flex flex-col gap-5">
              {entries.map((entry, idx) => (
                <motion.div
                  key={entry.id}
                  data-message-id={entry.id}
                  className={cn("px-1 py-0.5", jumpFlashId === entry.id && "rea-jump-flash")}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.18, ease: "easeOut" }}
                >
                  <MessageRow
                    entry={entry}
                    streaming={streaming && idx === entries.length - 1}
                    model={modelInfo}
                    editing={editingId === entry.id}
                    editValue={editValue}
                    onEditValue={setEditValue}
                    onEditSubmit={() => submitEdit(entry.id)}
                    onEditCancel={cancelEdit}
                    onEditStart={() => startEdit(entry)}
                    onRegenerate={regenerateLast}
                    onFork={() => void forkFrom(entry)}
                    onQuote={() => quoteIntoComposer(entry)}
                    canRegenerate={
                      !streaming &&
                      !!activeSessionId &&
                      entry.role === "assistant" &&
                      idx === entries.length - 1
                    }
                    canFork={
                      !streaming && !!activeSessionId && !entry.id.startsWith("local-")
                    }
                  />
                </motion.div>
              ))}
              {streaming && (() => {
                const last = entries[entries.length - 1];
                // Indicator only while nothing visible is happening yet
                // (no streamed text, no pending tool row).
                if (last?.content || last?.trace.some((t) => t.pending)) return null;
                return <ThinkingIndicator modelInfo={modelInfo} />;
              })()}
            </div>
          </div>
        )}
      </div>

      {/* Scroll-to-bottom (appears when the user scrolled up) */}
      {!atBottom && (
        <button
          type="button"
          onClick={jumpToBottom}
          aria-label="Scroll to latest message"
          className="absolute bottom-32 left-1/2 z-10 -translate-x-1/2 rounded-full border border-zinc-700 bg-zinc-900/90 p-2 text-zinc-300 shadow-lg shadow-black/40 backdrop-blur transition-colors hover:border-zinc-600 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
        >
          <ArrowDown className="size-4" aria-hidden />
        </button>
      )}

      {/* Composer */}
      <div className="shrink-0 px-3 pb-3 pt-1 sm:px-4 sm:pb-4" id="rea-composer">
        <div className="mx-auto w-full max-w-3xl">
          {/* First-run hint: platform model */}
          {hasKey === false && entries.length === 0 && (
            <button
              type="button"
              onClick={() => setDialog("settings")}
              className="mb-2 flex w-full items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-left text-[11px] text-amber-300/90 transition-colors hover:bg-amber-500/10 focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:outline-none"
            >
              <KeyRound className="size-3.5 shrink-0" aria-hidden />
              <span className="flex-1">
                Running on the built-in platform model. Add your own API key for full control.
              </span>
              <span className="font-mono text-[10px] text-amber-400">ADD KEY</span>
            </button>
          )}

          <div
            className="rounded-xl border border-zinc-800 bg-zinc-900/60 shadow-lg shadow-black/20 transition-all duration-200 focus-within:border-emerald-500/30 focus-within:shadow-[0_0_0_1px_rgba(16,185,129,0.15),0_12px_32px_-16px_rgba(16,185,129,0.25)]"
          >
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onComposerKeyDown}
              rows={1}
              placeholder={
                boundTarget
                  ? `Ask about ${boundTarget.originalName}…`
                  : "Ask anything about reverse engineering, or attach a file…"
              }
              aria-label="Chat message"
              className="max-h-[180px] resize-none border-0 bg-transparent px-3.5 pt-3 pb-1 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-0"
              disabled={streaming}
            />
            <div className="flex items-center gap-1 px-2.5 pb-2">
              {onAttachFile && (
                <button
                  type="button"
                  onClick={onAttachFile}
                  aria-label="Attach a file to investigate (upload)"
                  title="Attach a file — uploads and starts a tool-driven chat"
                  className="grid size-6 shrink-0 place-items-center rounded text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-emerald-400 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
                >
                  <Paperclip className="size-3.5" aria-hidden />
                </button>
              )}
              <span className="font-mono text-[10px] text-zinc-600">
                {boundTarget ? (
                  <span className="flex items-center gap-1 text-emerald-500/80">
                    <Binary className="size-3" aria-hidden />
                    {boundTarget.originalName}
                  </span>
                ) : (
                  "free chat · no tools"
                )}
              </span>
              <span className="ml-auto" />
              {streaming ? (
                <Button
                  type="button"
                  size="sm"
                  onClick={stop}
                  aria-label="Stop generating"
                  className="h-7 gap-1.5 bg-zinc-800 px-2.5 text-xs text-zinc-200 hover:bg-zinc-700"
                >
                  <Square className="size-3 fill-current" aria-hidden />
                  Stop
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void sendWithEvents(input)}
                  disabled={!input.trim()}
                  aria-label="Send message"
                  className="h-7 gap-1.5 bg-emerald-600 px-2.5 text-xs text-white hover:bg-emerald-500 disabled:opacity-40"
                >
                  <SendHorizontal className="size-3" aria-hidden />
                  Send
                </Button>
              )}
            </div>
          </div>
          <p className="mt-1.5 text-center font-mono text-[10px] text-zinc-700">
            Enter to send · Shift+Enter for a new line · file chats run real REA tools
          </p>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

function rowToEntry(m: ChatMessageRow): ChatEntry {
  let trace: TraceStep[] = [];
  if (m.toolCalls) {
    try {
      const parsed = JSON.parse(m.toolCalls) as {
        tool: string;
        args?: Record<string, unknown>;
        result?: string;
      }[];
      if (Array.isArray(parsed)) {
        trace = parsed.map((t) => ({
          id: nextId(),
          tool: t.tool,
          args: t.args,
          preview: typeof t.result === "string" ? t.result.slice(0, 1000) : null,
          pending: false,
        }));
      }
    } catch {
      trace = [];
    }
  }
  return {
    id: m.id,
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
    trace,
    tokensIn: m.tokensIn ?? null,
    tokensOut: m.tokensOut ?? null,
    durationMs: m.durationMs ?? null,
    createdAt: m.createdAt,
  };
}

function MessageRow({
  entry,
  streaming,
  model,
  editing,
  editValue,
  onEditValue,
  onEditSubmit,
  onEditCancel,
  onEditStart,
  onRegenerate,
  onFork,
  onQuote,
  canRegenerate,
  canFork,
}: {
  entry: ChatEntry;
  streaming?: boolean;
  model?: ModelInfo | null;
  editing?: boolean;
  editValue?: string;
  onEditValue?: (v: string) => void;
  onEditSubmit?: () => void;
  onEditCancel?: () => void;
  onEditStart?: () => void;
  onRegenerate?: () => void;
  onFork?: () => void;
  onQuote?: () => void;
  canRegenerate?: boolean;
  canFork?: boolean;
}) {
  if (entry.role === "user") {
    return (
      <div className="group flex items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border font-mono text-[10px]",
            editing
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
              : "border-zinc-800 bg-zinc-900 text-zinc-400"
          )}
        >
          ›_
        </span>
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="rounded-lg border border-emerald-500/40 bg-zinc-900/80 shadow-lg shadow-black/30">
              <textarea
                autoFocus
                value={editValue ?? ""}
                onChange={(e) => onEditValue?.(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onEditSubmit?.();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    onEditCancel?.();
                  }
                }}
                rows={Math.min(8, Math.max(2, (editValue ?? "").split("\n").length))}
                aria-label="Edit your message"
                className="w-full resize-none border-0 bg-transparent px-3.5 py-2.5 text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus-visible:outline-none"
              />
              <div className="flex items-center gap-1.5 border-t border-zinc-800/80 px-2.5 py-1.5">
                <span className="font-mono text-[10px] text-zinc-600">
                  editing · later turns will be re-run
                </span>
                <span className="ml-auto" />
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={onEditCancel}
                  aria-label="Cancel editing"
                  className="h-6 gap-1 px-2 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  <X className="size-3" aria-hidden />
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={onEditSubmit}
                  disabled={!(editValue ?? "").trim()}
                  aria-label="Save and resend this message"
                  className="h-6 gap-1 bg-emerald-600 px-2 text-[11px] text-white hover:bg-emerald-500 disabled:opacity-40"
                >
                  <Check className="size-3" aria-hidden />
                  Save & resend
                </Button>
              </div>
            </div>
          ) : (
            <div
              className={cn(
                "rounded-lg border bg-zinc-900/50 px-3.5 py-2.5 transition-colors",
                "border-zinc-800/80 group-hover:border-zinc-700/90"
              )}
            >
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-200">
                {entry.content}
              </p>
            </div>
          )}
          <MessageMeta entry={entry} model={null}>
            {!editing && canFork && (
              <MetaButton
                label="Fork chat from this message"
                onClick={onFork}
                hoverClass="hover:text-sky-400"
              >
                <GitFork className="size-3" aria-hidden />
              </MetaButton>
            )}
            {!editing && onQuote && (
              <MetaButton
                label="Quote this message in the composer"
                onClick={onQuote}
                hoverClass="hover:text-violet-400"
              >
                <Quote className="size-3" aria-hidden />
              </MetaButton>
            )}
            {!editing && (
              <MetaButton label={`Edit and resend: ${entry.content.slice(0, 40)}`} onClick={onEditStart}>
                <Pencil className="size-3" aria-hidden />
              </MetaButton>
            )}
          </MessageMeta>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-2.5">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border border-emerald-500/30 bg-emerald-500/10">
        <Binary className="size-3 text-emerald-400" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        {/* Tool trace */}
        {entry.trace.length > 0 && (
          <div className="flex flex-col gap-1">
            {entry.trace.map((step) => (
              <TraceRow key={step.id} step={step} />
            ))}
          </div>
        )}
        {entry.error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
          >
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {entry.error}
          </div>
        )}
        {entry.content && (
          <div className="rea-markdown text-sm leading-relaxed text-zinc-200">
            <Markdown>{entry.content}</Markdown>
            {streaming && <StreamingCaret />}
          </div>
        )}
        <MessageMeta entry={entry} model={model}>
          {canFork && (
            <MetaButton
              label="Fork chat from this message"
              onClick={onFork}
              hoverClass="hover:text-sky-400"
            >
              <GitFork className="size-3" aria-hidden />
            </MetaButton>
          )}
          {onQuote && (
            <MetaButton
              label="Quote this message in the composer"
              onClick={onQuote}
              hoverClass="hover:text-violet-400"
            >
              <Quote className="size-3" aria-hidden />
            </MetaButton>
          )}
          {canRegenerate && (
            <MetaButton
              label="Regenerate this response"
              onClick={onRegenerate}
              hoverClass="hover:text-emerald-400"
            >
              <RotateCcw className="size-3" aria-hidden />
            </MetaButton>
          )}
        </MessageMeta>
      </div>
    </div>
  );
}

/** Blinking block caret shown while assistant text is streaming in. */
function StreamingCaret() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-3.5 w-[7px] translate-y-[2px] animate-pulse rounded-[2px] bg-emerald-400/90"
    />
  );
}

/** Small icon button in the hover meta row (edit / regenerate). */
function MetaButton({
  label,
  onClick,
  children,
  hoverClass = "hover:text-zinc-200",
}: {
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
  hoverClass?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "grid size-5 place-items-center rounded text-zinc-600 transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none",
        hoverClass
      )}
    >
      {children}
    </button>
  );
}

/** Hover meta row: timestamp + token/duration + actions + copy (+ provider/model for assistant turns). */
function MessageMeta({
  entry,
  model,
  children,
}: {
  entry: ChatEntry;
  model?: ModelInfo | null;
  children?: React.ReactNode;
}) {
  const copyLabel =
    entry.role === "assistant" ? "Copy assistant message" : "Copy your message";
  const hasUsage = entry.tokensIn != null || entry.tokensOut != null;
  // Cost estimate: prefer the model that streamed this turn, else the active
  // provider's model (history rows don't carry their own model id).
  const providerActive = useReaStore((s) => s.providerActive);
  const costModel = model?.model ?? providerActive?.model ?? null;
  const costEstimate =
    entry.role === "assistant"
      ? estimateCostUsd(costModel, entry.tokensIn, entry.tokensOut)
      : null;
  const costLabel = formatCostUsd(costEstimate);
  return (
    <div className="touch-visible mt-1 flex h-5 items-center gap-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
      {entry.createdAt && (
        <time className="font-mono text-[10px] text-zinc-600" dateTime={entry.createdAt}>
          {new Date(entry.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      )}
      {entry.role === "assistant" && model && (
        <span className="truncate font-mono text-[10px] text-zinc-700">
          {model.provider}/{model.model}
        </span>
      )}
      {entry.role === "assistant" && (hasUsage || entry.durationMs != null) && (
        <span className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-600">
          {hasUsage && (
            <span
              className="flex items-center gap-0.5"
              title={`Provider-reported tokens — prompt: ${entry.tokensIn ?? "unknown"}, completion: ${entry.tokensOut ?? "unknown"}`}
            >
              <span className="text-zinc-700">↑</span>
              {humanTokens(entry.tokensIn)}
              <span className="text-zinc-700">↓</span>
              {humanTokens(entry.tokensOut)}
              <span className="text-zinc-700">tok</span>
            </span>
          )}
          {entry.durationMs != null && (
            <span className="flex items-center gap-0.5" title="Agent turn duration (tools included)">
              <Timer className="size-2.5" aria-hidden />
              {humanDuration(entry.durationMs)}
            </span>
          )}
          {costLabel && (
            <span
              className="text-amber-500/70"
              title={`Estimated cost at ${costModel ?? "model"} list price — real bills vary by endpoint, caching and discounts.`}
            >
              {costLabel}
              <span className="text-zinc-700"> est</span>
            </span>
          )}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        {children}
        <CopyButton value={entry.content} label={copyLabel} small />
      </div>
    </div>
  );
}

/** Claude-Code-style working indicator with animated dots. */
function ThinkingIndicator({ modelInfo }: { modelInfo: ModelInfo | null }) {
  return (
    <div className="flex items-center gap-2.5 pl-8.5" aria-live="polite">
      <span className="flex items-end gap-[3px]" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="size-[4px] animate-bounce rounded-full bg-emerald-500/80"
            style={{ animationDelay: `${i * 140}ms`, animationDuration: "900ms" }}
          />
        ))}
      </span>
      <span className="font-mono text-[10px] text-zinc-600">
        {modelInfo ? `${modelInfo.provider}/${modelInfo.model}` : "agent"} · working…
      </span>
    </div>
  );
}

/** Human-readable one-line preview of tool args: key=value pairs. */
function argsPreview(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const pairs = Object.entries(args as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return `${k}=${s.length > 42 ? `${s.slice(0, 42)}…` : s}`;
    });
  return pairs.join("  ");
}

function TraceRow({ step }: { step: TraceStep }) {
  const preview = argsPreview(step.args);
  return (
    <Collapsible>
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center gap-2 rounded-md border border-zinc-800/70 bg-zinc-900/40 px-2.5 py-1.5 text-left font-mono text-[11px] transition-colors hover:bg-zinc-900 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none",
          step.pending ? "text-amber-300" : "text-zinc-400"
        )}
      >
        {step.pending ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-amber-400" aria-hidden />
        ) : (
          <Wrench className="size-3 shrink-0 text-emerald-500/80" aria-hidden />
        )}
        <span className="truncate">
          <span className={step.pending ? "text-amber-200" : "text-zinc-300"}>{step.tool}</span>
          {preview && <span className="ml-1.5 text-zinc-600">{preview}</span>}
        </span>
        <span className="ml-auto flex items-center gap-1 text-[9px] uppercase tracking-wider text-zinc-600">
          {step.pending ? "running" : "done"}
          <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="relative mt-1">
          <pre className="max-h-48 overflow-auto rea-scroll rounded-md border border-zinc-800/70 bg-zinc-950 p-2.5 pr-9 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-zinc-400">
            {step.preview || "(no output)"}
          </pre>
          <div className="absolute top-1.5 right-1.5">
            <CopyButton value={step.preview ?? ""} label="Copy tool output" />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Empty state (Claude-Code-like "ready" screen)
// ---------------------------------------------------------------------------

function EmptyState({
  boundTarget,
  hasKey,
  onSuggest,
  onOpenSettings,
}: {
  boundTarget: TargetSummary | null;
  hasKey: boolean | null;
  onSuggest: (text: string) => void;
  onOpenSettings: () => void;
}) {
  const suggestions = boundTarget ? TARGET_SUGGESTIONS : FREE_SUGGESTIONS;

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-xl text-center">
        <span className="mx-auto mb-4 grid size-11 place-items-center rounded-lg border border-emerald-500/30 bg-emerald-500/5">
          <Binary className="size-5 text-emerald-400" aria-hidden />
        </span>
        <h2 className="text-lg font-semibold text-zinc-100">
          {boundTarget ? "What do you want to know about this file?" : "What are we investigating?"}
        </h2>
        <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-zinc-500">
          {boundTarget ? (
            <>
              <span className="text-zinc-300">{boundTarget.originalName}</span> is attached. The
              agent will run real REA engine tools (strings, hex, format inspectors) and back every
              claim with evidence.
            </>
          ) : (
            <>
              Ask anything about reverse engineering — or pick a file from the sidebar to open a
              tool-driven investigation chat.
            </>
          )}
        </p>

        {hasKey === false && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="mx-auto mt-3 flex items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/5 px-3 py-1 font-mono text-[10px] text-amber-300 transition-colors hover:bg-amber-500/15"
          >
            <KeyRound className="size-3" aria-hidden />
            platform model in use — add your API key
          </button>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSuggest(s)}
              className="rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
            >
              {s}
            </button>
          ))}
        </div>

        {/* Keyboard hints (Cursor-style) */}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 border-t border-zinc-800/60 pt-4">
          <KbdHint keys="⌘K" label="command palette" />
          <KbdHint keys="⌘B" label="toggle sidebar" />
          <KbdHint keys="⌘F" label="filter" />
          <KbdHint keys="⌘I" label="inspector" />
          <KbdHint keys="⌘⇧O" label="new chat" />
        </div>
      </div>
    </div>
  );
}

function KbdHint({ keys, label }: { keys: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-600">
      <kbd className="rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-400">
        {keys}
      </kbd>
      {label}
    </span>
  );
}
