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
  Loader2,
  Paperclip,
  PanelRightOpen,
  Pencil,
  Quote,
  RotateCcw,
  ScanSearch,
  SearchCheck,
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
import { HomeDashboard } from "@/components/rea/home-dashboard";
import { MAX_MESSAGE_CHARS, CHAR_COUNTER_AT } from "@/components/rea/chat-limits";
import { SlashMenu, filterPrompts, slashTokenOf, type PromptEntry } from "@/components/rea/prompt-library";
import { SpeakButton } from "@/components/rea/speak-button";
import { estimateCostUsd, formatCostUsd } from "@/lib/pricing";
import { PenLine } from "lucide-react";
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
  /** Client timestamp when the tool call started (drives the live elapsed timer). */
  startedAt?: number;
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
  /** Canonical model id for this turn ("openai/gpt-4o-mini" | "glm-platform"). */
  modelId?: string | null;
}

/** Display label for a provider+model pair — collapses redundant prefixes.
 *  "glm-platform" + "glm-platform" → "glm-platform"; "openai" + "openai/gpt-4o" → "openai/gpt-4o". */
function modelLabel(provider: string, model: string): string {
  if (!provider || model === provider || model.startsWith(`${provider}/`)) return model;
  return `${provider}/${model}`;
}

/**
 * Best-effort parse of a PARTIALLY streamed tool block. The agent protocol is
 * a ```tool fenced JSON object ({ tool, args }); while it streams, quotes and
 * braces are unbalanced. Balances them naively to surface the tool name and
 * whatever arguments are already complete — pure preview, never executed.
 */
function parsePartialToolBlock(raw: string): ToolIntent | null {
  const fence = raw.indexOf("```");
  if (fence < 0) return null;
  let body = raw.slice(fence + 3);
  const nl = body.indexOf("\n");
  if (nl >= 0) body = body.slice(nl + 1);
  else body = body.replace(/^tool/, "");
  const brace = body.indexOf("{");
  if (brace < 0) return { tool: null, args: null };
  let partial = body.slice(brace);
  const quotes = (partial.match(/"/g) ?? []).length;
  if (quotes % 2 === 1) partial += '"';
  partial = partial.replace(/,\s*$/, "");
  const opens = (partial.match(/\{/g) ?? []).length - (partial.match(/\}/g) ?? []).length;
  partial += "}".repeat(Math.max(0, opens));
  try {
    const parsed = JSON.parse(partial) as { tool?: unknown; args?: unknown };
    return {
      tool: typeof parsed.tool === "string" ? parsed.tool : null,
      args: parsed.args ?? null,
    };
  } catch {
    return { tool: null, args: null };
  }
}

/** Shallow intent equality — avoids re-rendering the preview on every delta. */
function sameIntent(a: ToolIntent | null, b: ToolIntent | null): boolean {
  return a?.tool === b?.tool && JSON.stringify(a?.args ?? null) === JSON.stringify(b?.args ?? null);
}

interface ModelInfo {
  source: string;
  provider: string;
  model: string;
}

/** Live preview while the model is still writing a ```tool block. */
interface ToolIntent {
  tool: string | null;
  args: unknown;
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
  /** Raw delta buffer for the current LLM turn (kept even past the tool fence). */
  const rawTurnRef = React.useRef("");
  /** Live preview while the model writes a tool block (replaced by the real trace row). */
  const [toolIntent, setToolIntent] = React.useState<ToolIntent | null>(null);

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
  // Home dashboard (empty transcript): land on the hero at the top. The reset
  // fires on NAVIGATION (session/draft/history changes) only — never on the
  // scroll handler's atBottom flips, which would fight the user scrolling.
  const navKeyRef = React.useRef("");
  const navKey = `${activeSessionId ?? "draft"}:${draftTargetId ?? "free"}:${historyLoading ? "l" : "r"}`;
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (entries.length === 0) {
      if (navKeyRef.current !== navKey) {
        navKeyRef.current = navKey;
        el.scrollTop = 0;
      }
      return;
    }
    navKeyRef.current = navKey;
    if (!atBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [entries, streaming, atBottom, navKey]);

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
    rawTurnRef.current = "";
    setToolIntent(null);

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
          // A fresh LLM turn began — reset the live draft buffer + intent.
          turnBecameToolRef.current = false;
          rawTurnRef.current = "";
          setToolIntent(null);
          applyAssistant((e) => ({ ...e, content: "" }));
          break;
        case "delta": {
          // Accumulate the raw turn text ALWAYS — the prose rendering stops at
          // the tool fence, but the buffer keeps feeding the intent preview.
          rawTurnRef.current += ev.text;
          const raw = rawTurnRef.current;
          const fenceAt = raw.indexOf("```");
          if (fenceAt >= 0) {
            // The model started writing a tool block: freeze the prose and
            // preview the pending call from the partial JSON.
            turnBecameToolRef.current = true;
            const intent = parsePartialToolBlock(raw);
            const next = intent ?? null;
            setToolIntent((prev) => (sameIntent(prev, next) ? prev : next));
            const prose = raw.slice(0, fenceAt).trimEnd();
            applyAssistant((e) => (e.content === prose ? e : { ...e, content: prose }));
          } else {
            applyAssistant((e) => (e.content === raw ? e : { ...e, content: raw }));
          }
          break;
        }
        case "tool_call":
          turnBecameToolRef.current = true;
          setToolIntent(null); // the real row replaces the live preview
          applyAssistant((e) => ({
            ...e,
            trace: [
              ...e.trace,
              { id: nextId(), tool: ev.tool, args: ev.args, pending: true, startedAt: Date.now() },
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
            modelId: ev.modelId ?? e.modelId ?? null,
          }));
          break;
        case "assistant":
          // Authoritative final text — replaces the streamed draft verbatim.
          turnBecameToolRef.current = false;
          rawTurnRef.current = "";
          setToolIntent(null);
          applyAssistant((e) => ({ ...e, content: ev.content }));
          break;
        case "error":
          rawTurnRef.current = "";
          setToolIntent(null);
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
    if (message.length > MAX_MESSAGE_CHARS) {
      toastError(new Error(`Message too long (${message.length}/8000 characters). Trim it first.`));
      return;
    }
    // Sending from the Home dashboard: re-pin to bottom so the first turn is
    // visible even if the user had scrolled the dashboard away from it.
    if (entries.length === 0) setAtBottom(true);
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

  // ---- Slash-command prompt library ("/" at the start of the composer) ----
  const [slashIndex, setSlashIndex] = React.useState(0);
  const slashToken = slashTokenOf(input);
  const slashScope: "file" | "free" = boundTarget ? "file" : "free";
  const slashEntries = React.useMemo(
    () => filterPrompts(slashScope, slashToken),
    [slashScope, slashToken]
  );
  const slashOpen = slashToken !== null && slashEntries.length > 0 && !streaming;
  React.useEffect(() => setSlashIndex(0), [input]);

  const pickPrompt = React.useCallback((entry: PromptEntry) => {
    setInput(entry.prompt);
    textareaRef.current?.focus();
  }, []);

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue("");
  };

  const stop = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash menu owns navigation keys while open.
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashEntries.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashEntries.length) % slashEntries.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const picked = slashEntries[slashIndex] ?? slashEntries[0];
        if (picked) pickPrompt(picked);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setInput("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendWithEvents(input);
    }
  };

  const showEmptyState = !historyLoading && entries.length === 0;
  const hasKey = useReaStore((s) => s.hasProviderKey);
  /** Home view owns its own prominent composer — the docked one would duplicate it. */
  const homeOwnsComposer = showEmptyState && !boundTarget;

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
            onClick={() => openInspector(boundTarget.id, "findings")}
          >
            <ScanSearch className="size-3" aria-hidden />
            Findings
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-2 text-[10px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
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
            onAttachFile={onAttachFile}
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
                    intent={streaming && idx === entries.length - 1 ? toolIntent : null}
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
                    evidenceTargetId={
                      entry.role === "assistant" && boundTarget ? boundTarget.id : null
                    }
                    onOpenEvidence={
                      boundTarget ? () => openInspector(boundTarget.id, "evidence") : undefined
                    }
                  />
                </motion.div>
              ))}
              {streaming && (() => {
                const last = entries[entries.length - 1];
                // Indicator only while nothing visible is happening yet
                // (no streamed text, no pending tool row, no live intent).
                if (last?.content || last?.trace.some((t) => t.pending) || toolIntent) return null;
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

      {/* Composer — hidden while the Home dashboard's own composer is showing */}
      {!homeOwnsComposer && (
      <div className="shrink-0 px-3 pb-3 pt-1 sm:px-4 sm:pb-4" id="rea-composer">
        <div className="mx-auto w-full max-w-3xl">
          <div
            className="relative rounded-xl border border-zinc-800 bg-zinc-900/60 shadow-lg shadow-black/20 transition-all duration-200 focus-within:border-emerald-500/30 focus-within:shadow-[0_0_0_1px_rgba(16,185,129,0.15),0_12px_32px_-16px_rgba(16,185,129,0.25)]"
          >
            <SlashMenu
              visible={slashOpen}
              entries={slashEntries}
              activeIndex={slashIndex}
              onPick={pickPrompt}
              onHover={setSlashIndex}
            />
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
              {!streaming && input.length >= CHAR_COUNTER_AT && (
                <span
                  className={cn(
                    "mr-1 font-mono text-[10px] tabular-nums",
                    input.length > MAX_MESSAGE_CHARS ? "text-rose-400" : "text-amber-400/80"
                  )}
                  title={
                    input.length > MAX_MESSAGE_CHARS
                      ? "Over the 8000-character limit — trim the message"
                      : "Approaching the 8000-character message limit"
                  }
                >
                  {input.length}/{MAX_MESSAGE_CHARS}
                </span>
              )}
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
                  disabled={!input.trim() || input.length > MAX_MESSAGE_CHARS}
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
            Enter to send · Shift+Enter new line · <span className="text-zinc-600">/</span> prompts
            <QuotaHint />
          </p>
        </div>
      </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

/**
 * Maps raw agent/network failures to a human-readable explanation. The raw
 * message stays available under a collapsed "Technical details" section —
 * advanced users can always see exactly what happened.
 */
function friendlyError(raw: string): { title: string; hint?: string } {
  const m = raw.toLowerCase();
  if (/aborted|aborterror/.test(m)) {
    return { title: "Stopped before finishing.", hint: "The request was cancelled — nothing was saved for this turn." };
  }
  if (/rate.?limit|too many requests|\b429\b|quota/.test(m)) {
    return {
      title: "Message limit reached for this window.",
      hint: "The 5-minute quota resets automatically — wait a moment and send again.",
    };
  }
  if (/api key|unauthorized|invalid.api.?key|\b401\b|\b403\b|forbidden/.test(m)) {
    return {
      title: "The model rejected the credentials.",
      hint: "If you use your own API key, check it in Settings → API key & model. Otherwise the platform model may be temporarily unavailable.",
    };
  }
  if (/insufficient|billing|credit|\b402\b|exceeded.*balance/.test(m)) {
    return {
      title: "The provider reported a billing problem.",
      hint: "Check the account behind your API key, or switch models in Settings → API key & model.",
    };
  }
  if (/timeout|etimedout|econnreset|econnrefused|fetch failed|network|socket|enotfound|dns/i.test(m)) {
    return {
      title: "Lost contact with the model mid-answer.",
      hint: "Usually a temporary network hiccup — retry the message.",
    };
  }
  if (/too long|too large|\b413\b|payload|max.*chars|character/.test(m)) {
    return {
      title: "The message exceeded the size limit.",
      hint: "Trim or split it — the limit is 8,000 characters per message.",
    };
  }
  if (/engine|rea-agents|mcp|spawn|tool .*fail/.test(m)) {
    return {
      title: "The REA engine hit a problem.",
      hint: "The analysis tool failed inside the sandbox. Details below; the rest of the chat still works.",
    };
  }
  return {
    title: "This turn could not be completed.",
    hint: "Retry the message — if it keeps failing, check Settings → Engine & security for diagnostics.",
  };
}

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
    modelId: m.modelId ?? null,
    createdAt: m.createdAt,
  };
}

function MessageRow({
  entry,
  streaming,
  model,
  intent,
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
  evidenceTargetId,
  onOpenEvidence,
}: {
  entry: ChatEntry;
  streaming?: boolean;
  model?: ModelInfo | null;
  /** Live tool-call preview while the model writes the block (streaming only). */
  intent?: ToolIntent | null;
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
  /** Set for file-bound chats — enables the "view evidence" deep-link. */
  evidenceTargetId?: string | null;
  onOpenEvidence?: () => void;
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
        {/* Live preview while the model writes the next tool block */}
        {streaming && intent && <ToolIntentRow intent={intent} />}
        {entry.error && (() => {
          const friendly = friendlyError(entry.error);
          return (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2.5"
            >
              <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-rose-400" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-rose-200">{friendly.title}</p>
                {friendly.hint && (
                  <p className="mt-0.5 text-[11px] leading-relaxed text-rose-300/70">{friendly.hint}</p>
                )}
                <details className="group mt-1.5">
                  <summary className="w-fit cursor-pointer select-none font-mono text-[10px] text-rose-400/60 transition-colors hover:text-rose-300">
                    Technical details
                  </summary>
                  <pre className="rea-scroll mt-1 max-h-32 overflow-auto rounded-md border border-rose-500/20 bg-zinc-950/80 p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-rose-200/60">
                    {entry.error}
                  </pre>
                </details>
              </div>
              {canRegenerate && onRegenerate && (
                <Button
                  type="button"
                  size="sm"
                  onClick={onRegenerate}
                  aria-label="Retry this message"
                  className="h-6 shrink-0 gap-1 border border-rose-500/40 bg-rose-500/15 px-2 text-[11px] text-rose-200 hover:bg-rose-500/25"
                  variant="outline"
                >
                  <RotateCcw className="size-3" aria-hidden />
                  Retry
                </Button>
              )}
            </div>
          );
        })()}
        {entry.content && (
          <div className="rea-markdown text-sm leading-relaxed text-zinc-200">
            <Markdown>{entry.content}</Markdown>
            {streaming && <StreamingCaret />}
          </div>
        )}
        <MessageMeta entry={entry} model={model} streaming={streaming}>
          {evidenceTargetId && onOpenEvidence && (
            <MetaButton
              label="View the evidence behind this answer"
              onClick={onOpenEvidence}
              hoverClass="hover:text-teal-300"
            >
              <SearchCheck className="size-3" aria-hidden />
            </MetaButton>
          )}
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
  streaming,
  children,
}: {
  entry: ChatEntry;
  model?: ModelInfo | null;
  /** True while this message is still streaming (read-aloud hidden — text incomplete). */
  streaming?: boolean;
  children?: React.ReactNode;
}) {
  const copyLabel =
    entry.role === "assistant" ? "Copy assistant message" : "Copy your message";
  const hasUsage = entry.tokensIn != null || entry.tokensOut != null;
  // Cost + model chip: the model that actually produced THIS turn (persisted
  // per row), falling back to the live stream info, then the active provider
  // (older rows pre-date per-turn model persistence).
  const providerActive = useReaStore((s) => s.providerActive);
  const costModel = entry.modelId ?? model?.model ?? providerActive?.model ?? null;
  const modelChip =
    entry.modelId ??
    (model ? modelLabel(model.provider, model.model) : null);
  const modelTooltip = model
    ? `${modelLabel(model.provider, model.model)} · ${model.source === "byok" ? "your API key" : "platform model"}`
    : modelChip ?? "model";
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
      {entry.role === "assistant" && modelChip && (
        <span
          className="truncate font-mono text-[10px] text-zinc-700"
          title={modelTooltip}
        >
          {modelChip}
        </span>
      )}
      {entry.role === "assistant" && (hasUsage || entry.durationMs != null) && (
        <span className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-600">
          {hasUsage && (
            <span
              className="flex items-center gap-0.5 whitespace-nowrap"
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
              className="whitespace-nowrap text-amber-500/70"
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
        {entry.role === "assistant" && entry.content && !streaming && (
          <SpeakButton content={entry.content} />
        )}
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
        {modelInfo ? `${modelLabel(modelInfo.provider, modelInfo.model)} · working…` : "agent · working…"}
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
  // Live elapsed timer while the tool is running (Cursor-style "running 1.2s").
  const [elapsed, setElapsed] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!step.pending || !step.startedAt) {
      setElapsed(null);
      return;
    }
    const tick = () => setElapsed((Date.now() - step.startedAt!) / 1000);
    tick();
    const iv = window.setInterval(tick, 100);
    return () => window.clearInterval(iv);
  }, [step.pending, step.startedAt]);
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
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-[9px] tracking-wider text-zinc-600 uppercase">
          {step.pending ? (
            <>
              running
              {elapsed != null && (
                <span className="rounded bg-amber-500/10 px-1 py-px font-mono text-[9px] text-amber-300/90 tabular-nums">
                  {elapsed < 10 ? elapsed.toFixed(1) : Math.round(elapsed)}s
                </span>
              )}
            </>
          ) : (
            "done"
          )}
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

/**
 * Dimmed live preview shown while the model is still WRITING a tool block
 * (before the executed tool_call row replaces it). Dashed border + pulsing
 * caret distinguish "composing" from the amber "running" state.
 */
function ToolIntentRow({ intent }: { intent: ToolIntent }) {
  const preview =
    intent.args && typeof intent.args === "object" ? argsPreview(intent.args) : "";
  return (
    <div
      aria-live="polite"
      className="rea-intent-pulse flex items-center gap-2 rounded-md border border-dashed border-zinc-800/80 bg-zinc-900/30 px-2.5 py-1.5 font-mono text-[11px] text-zinc-500"
    >
      <PenLine className="size-3 shrink-0 text-zinc-600" aria-hidden />
      <span className="truncate">
        {intent.tool ? (
          <span className="text-zinc-400">{intent.tool}</span>
        ) : (
          "composing tool call"
        )}
        {preview && <span className="ml-1.5 text-zinc-600">{preview}</span>}
      </span>
      <span
        aria-hidden
        className="ml-auto inline-block h-3 w-[6px] shrink-0 animate-pulse rounded-[2px] bg-emerald-500/70"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state — free chats render the full Home dashboard; file-bound drafts
// keep a focused, file-centric prompt screen.
// ---------------------------------------------------------------------------

function EmptyState({
  boundTarget,
  hasKey,
  onSuggest,
  onAttachFile,
}: {
  boundTarget: TargetSummary | null;
  hasKey: boolean | null;
  onSuggest: (text: string) => void;
  onAttachFile?: () => void;
}) {
  if (!boundTarget) {
    return <HomeDashboard hasKey={hasKey} onSuggest={onSuggest} onAttachFile={onAttachFile} />;
  }

  const suggestions = TARGET_SUGGESTIONS;

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-xl text-center">
        <span className="mx-auto mb-4 grid size-11 place-items-center rounded-lg border border-emerald-500/30 bg-emerald-500/5">
          <Binary className="size-5 text-emerald-400" aria-hidden />
        </span>
        <h2 className="text-lg font-semibold text-zinc-100">
          What do you want to know about{" "}
          <span className="font-mono text-emerald-300">{boundTarget.originalName}</span>?
        </h2>
        <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-zinc-500">
          The agent will run real REA engine tools (strings, hex, format inspectors) and back
          every claim with graded evidence.
        </p>

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

        {/* Engine status line — the real REA engine version, from /api/capabilities */}
        <EngineLine />
      </div>
    </div>
  );
}

/**
 * Whisper-quiet quota notice — appears ONLY when the 5-minute message window
 * is nearly exhausted (≤3 left). Zero noise when quota is healthy.
 */
function QuotaHint() {
  const chatQuota = useReaStore((s) => s.chatQuota);
  if (!chatQuota || chatQuota.remaining > 3) return null;
  return (
    <span
      className={cn(
        "text-amber-400/80",
        chatQuota.remaining === 0 && "text-rose-400/90"
      )}
      aria-label={`Message quota: ${chatQuota.remaining} of ${chatQuota.limit} remaining in this window`}
    >
      {" · "}
      {chatQuota.remaining === 0 ? "quota used — wait a moment" : `${chatQuota.remaining} left this window`}
    </span>
  );
}

/** Tiny mono engine-status line under the keyboard hints. */
function EngineLine() {
  const engine = useReaStore((s) => s.capabilities?.engine ?? null);
  if (!engine) return null;
  return (
    <p
      className="mt-3 flex items-center justify-center gap-1.5 font-mono text-[10px] text-zinc-700"
      title="The real REA engine runs in a sandboxed child process via MCP stdio"
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          engine.healthy ? "bg-emerald-500/80" : "bg-rose-500/80"
        )}
      />
      engine {engine.version} · {engine.toolCount} tools ·{" "}
      {engine.healthy ? "ready" : "degraded"}
    </p>
  );
}


