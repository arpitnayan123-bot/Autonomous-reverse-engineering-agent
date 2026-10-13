"use client";

import * as React from "react";
import {
  Binary,
  ChevronDown,
  CircleAlert,
  KeyRound,
  Loader2,
  PanelRightOpen,
  SendHorizontal,
  Square,
  Wrench,
  X,
} from "lucide-react";

import {
  getChatSession,
  streamChat,
  type ChatMessageRow,
  type ChatStreamEvent,
  type TargetSummary,
} from "@/lib/api-client";
import { useReaStore } from "@/store/rea-store";
import { Markdown, humanBytes, toastError } from "@/components/rea/shared";
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
}: {
  className?: string;
  onSessionsChanged?: () => void;
  onTargetsChanged?: () => void;
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

  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  /**
   * Set when the in-flight stream itself switches the active session
   * (session_saved) — the history effect must not abort the stream or
   * overwrite the live transcript in that case.
   */
  const skipHistoryLoadRef = React.useRef(false);

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

  // ---- Autoscroll ---------------------------------------------------------
  React.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries, streaming]);

  // ---- Composer auto-resize ----------------------------------------------
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  // ---- Streaming ----------------------------------------------------------
  /** Sends with the live event handler wired to the assistant entry. */
  const sendWithEvents = async (raw: string) => {
    const message = raw.trim();
    if (!message || streaming) return;

    const sessionId = activeSessionId;
    const targetId = boundTarget?.id ?? draftTargetId ?? null;

    const userEntry: ChatEntry = { id: nextId(), role: "user", content: message, trace: [] };
    const assistantEntry: ChatEntry = { id: nextId(), role: "assistant", content: "", trace: [] };
    setEntries((prev) => [...prev, userEntry, assistantEntry]);
    setInput("");
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
        case "model":
          setModelInfo({ source: ev.source, provider: ev.provider, model: ev.model });
          break;
        case "tool_call":
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
        case "assistant":
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
      await streamChat({ sessionId, targetId, message, onEvent }, controller.signal);
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
    <section className={cn("flex min-h-0 flex-col bg-zinc-950", className)} aria-label="Chat">
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
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto rea-scroll">
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
              {entries.map((entry) => (
                <MessageRow key={entry.id} entry={entry} />
              ))}
              {streaming && (
                <div className="flex items-center gap-2 font-mono text-[10px] text-zinc-600">
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                  {modelInfo ? `${modelInfo.provider}/${modelInfo.model} · thinking…` : "working…"}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

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

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 shadow-lg shadow-black/20 transition-colors focus-within:border-zinc-700">
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
    createdAt: m.createdAt,
  };
}

function MessageRow({ entry }: { entry: ChatEntry }) {
  if (entry.role === "user") {
    return (
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border border-zinc-800 bg-zinc-900 font-mono text-[10px] text-zinc-400">
          ›_
        </span>
        <div className="min-w-0 flex-1 rounded-lg border border-zinc-800/80 bg-zinc-900/50 px-3.5 py-2.5">
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-200">
            {entry.content}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5">
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
          </div>
        )}
      </div>
    </div>
  );
}

function TraceRow({ step }: { step: TraceStep }) {
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
          {step.tool}
          {typeof step.args === "object" && step.args !== null && Object.keys(step.args).length > 0 && (
            <span className="ml-1.5 text-zinc-600">{JSON.stringify(step.args).slice(0, 80)}</span>
          )}
        </span>
        <span className="ml-auto flex items-center gap-1 text-[9px] uppercase tracking-wider text-zinc-600">
          {step.pending ? "running" : "done"}
          <ChevronDown className="size-3 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="mt-1 max-h-48 overflow-auto rea-scroll rounded-md border border-zinc-800/70 bg-zinc-950 p-2.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-zinc-400">
          {step.preview || "(no output)"}
        </pre>
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
      </div>
    </div>
  );
}
