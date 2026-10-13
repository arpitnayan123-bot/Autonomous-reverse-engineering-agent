"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  Loader2,
  MessageSquareText,
  Send,
  Sparkles,
  Wrench,
} from "lucide-react";

import {
  apiGet,
  streamChat,
  type ChatMessageRow,
  type ChatSession,
} from "@/lib/api-client";
import { useReaStore } from "@/store/rea-store";
import {
  EmptyState,
  Markdown,
  SectionCard,
  timeAgo,
  toastError,
} from "@/components/rea/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const SUGGESTED_PROMPTS = [
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
  createdAt?: string;
}

let localId = 0;
function nextId() {
  localId += 1;
  return `local-${localId}`;
}

interface RawToolCall {
  tool?: string;
  name?: string;
  args?: unknown;
  arguments?: unknown;
  preview?: string;
  result?: string;
}

function traceFromToolCalls(raw: string | null): TraceStep[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => {
      const call = (item ?? {}) as RawToolCall;
      return {
        id: nextId(),
        tool: call.tool ?? call.name ?? "unknown tool",
        args: call.args ?? call.arguments,
        preview: call.preview ?? call.result ?? null,
        pending: false,
      };
    });
  } catch {
    return [];
  }
}

export function ChatView() {
  const { targets, activeTargetId } = useReaStore();
  const [chatTargetId, setChatTargetId] = React.useState<string>("");
  const [session, setSession] = React.useState<ChatSession | null>(null);
  const [entries, setEntries] = React.useState<ChatEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = React.useState(false);
  const [streaming, setStreaming] = React.useState(false);
  const [input, setInput] = React.useState("");
  const bottomRef = React.useRef<HTMLDivElement>(null);

  // Default the chat target to the active workspace target when present.
  React.useEffect(() => {
    if (activeTargetId) setChatTargetId(activeTargetId);
  }, [activeTargetId]);

  // Load conversation history whenever the picked target changes.
  React.useEffect(() => {
    if (!chatTargetId) {
      setSession(null);
      setEntries([]);
      return;
    }
    let cancelled = false;
    setLoadingHistory(true);
    apiGet<{ session: ChatSession | null; messages: ChatMessageRow[] }>("/api/chat", {
      targetId: chatTargetId,
    })
      .then((res) => {
        if (cancelled) return;
        setSession(res.session ?? null);
        setEntries(
          res.messages.map((m) => ({
            id: m.id,
            role: m.role === "user" ? "user" : "assistant",
            content: m.content,
            trace: traceFromToolCalls(m.toolCalls),
            createdAt: m.createdAt,
          }))
        );
      })
      .catch((err) => {
        if (!cancelled) toastError(err, "Could not load chat history");
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chatTargetId]);

  // Auto-scroll to the newest message.
  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries, streaming]);

  const send = React.useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || streaming || !chatTargetId) return;
      setInput("");

      const userEntry: ChatEntry = { id: nextId(), role: "user", content: message, trace: [] };
      const assistantEntry: ChatEntry = { id: nextId(), role: "assistant", content: "", trace: [] };
      setEntries((prev) => [...prev, userEntry, assistantEntry]);
      setStreaming(true);

      try {
        await streamChat(chatTargetId, message, (event) => {
          if (event.type === "tool_call") {
            const step: TraceStep = {
              id: nextId(),
              tool: String(event.tool ?? "tool"),
              args: event.args,
              pending: true,
            };
            setEntries((prev) =>
              prev.map((e) => (e.id === assistantEntry.id ? { ...e, trace: [...e.trace, step] } : e))
            );
          } else if (event.type === "tool_result") {
            const preview = typeof event.preview === "string" ? event.preview : JSON.stringify(event.preview ?? null);
            setEntries((prev) =>
              prev.map((e) => {
                if (e.id !== assistantEntry.id) return e;
                const trace = [...e.trace];
                const pendingIdx = trace.findIndex((t) => t.pending && t.tool === String(event.tool ?? "tool"));
                if (pendingIdx >= 0) {
                  trace[pendingIdx] = { ...trace[pendingIdx], pending: false, preview };
                } else {
                  trace.push({ id: nextId(), tool: String(event.tool ?? "tool"), preview, pending: false });
                }
                return { ...e, trace };
              })
            );
          } else if (event.type === "assistant") {
            const chunk = typeof event.content === "string" ? event.content : "";
            setEntries((prev) =>
              prev.map((e) => (e.id === assistantEntry.id ? { ...e, content: e.content + chunk } : e))
            );
          } else if (event.type === "error") {
            toastError(new Error(String(event.error ?? "Engine error")), "Chat error");
            setEntries((prev) =>
              prev.map((e) =>
                e.id === assistantEntry.id
                  ? { ...e, content: e.content || "_The engine reported an error. See the toast for details._" }
                  : e
              )
            );
          }
          // 'done' and any extra event types (e.g. user_saved) need no UI.
        });
      } catch (err) {
        toastError(err, "Chat failed");
        setEntries((prev) =>
          prev.map((e) =>
            e.id === assistantEntry.id
              ? { ...e, content: e.content || "_The assistant could not be reached._" }
              : e
          )
        );
      } finally {
        setStreaming(false);
      }
    },
    [chatTargetId, streaming]
  );

  const targetName =
    targets.find((t) => t.id === chatTargetId)?.originalName ?? session?.title ?? null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[290px_1fr]">
      {/* Left pane — target picker + suggestions */}
      <aside className="order-1 space-y-4" aria-label="Chat controls">
        <SectionCard
          title="Investigation target"
          description={targetName ? "Chatting about this artifact" : "Pick a target to ground the conversation"}
          icon={MessageSquareText}
        >
          {targets.length === 0 ? (
            <p className="text-xs text-zinc-500">
              No targets available yet — upload one from the dashboard first.
            </p>
          ) : (
            <Select value={chatTargetId || undefined} onValueChange={setChatTargetId}>
              <SelectTrigger aria-label="Pick chat target" className="w-full border-zinc-800 bg-zinc-950 text-xs">
                <SelectValue placeholder="Select a target…" />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900 max-h-72">
                {targets.map((t) => (
                  <SelectItem key={t.id} value={t.id} className="font-mono text-xs">
                    {t.originalName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {session?.title && (
            <p className="mt-2 truncate font-mono text-[11px] text-zinc-600">session: {session.title}</p>
          )}
        </SectionCard>

        <SectionCard title="Suggested prompts" description="Evidence-first questions to start with" icon={Sparkles}>
          <div className="flex flex-wrap gap-2">
            {SUGGESTED_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                type="button"
                disabled={!chatTargetId || streaming}
                onClick={() => void send(prompt)}
                className="rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-left text-[11px] leading-snug text-zinc-400 transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/5 hover:text-emerald-300 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
              >
                {prompt}
              </button>
            ))}
          </div>
        </SectionCard>
      </aside>

      {/* Right pane — conversation */}
      <section className="order-2 flex min-h-[70vh] flex-col rounded-lg border border-zinc-800 bg-zinc-900/60" aria-label="Conversation">
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <MessageSquareText className="size-4 text-emerald-400" aria-hidden />
          <h2 className="text-sm font-semibold text-zinc-200">AI analyst</h2>
          {streaming && (
            <Badge variant="outline" className="ml-2 gap-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-400">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              streaming
            </Badge>
          )}
          {targetName && (
            <span className="ml-auto truncate font-mono text-[11px] text-zinc-500">{targetName}</span>
          )}
        </div>

        <div className="flex-1 overflow-hidden">
          {!chatTargetId ? (
            <div className="flex h-full items-center justify-center p-6">
              <EmptyState
                icon={MessageSquareText}
                title="No target selected"
                description="Choose a target on the left (or pick one from the dashboard) and ask the AI analyst what the artifact does. Answers are grounded in REA engine evidence."
              />
            </div>
          ) : loadingHistory ? (
            <div className="space-y-3 p-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className={cn("h-16 bg-zinc-800/50", i % 2 ? "ml-auto w-2/3" : "w-3/4")} />
              ))}
            </div>
          ) : (
            <div className="rea-scroll h-full max-h-[62vh] space-y-4 overflow-y-auto p-4">
              {entries.length === 0 && (
                <EmptyState
                  icon={Sparkles}
                  title="Start the conversation"
                  description="Ask what the file does, request an explanation of the main functionality, or dig into specific findings. The analyst calls real REA tools and shows its work."
                  className="border-none bg-transparent py-8"
                />
              )}
              <AnimatePresence initial={false}>
                {entries.map((entry) => (
                  <motion.div
                    key={entry.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <MessageBubble entry={entry} />
                  </motion.div>
                ))}
              </AnimatePresence>
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        <div className="border-t border-zinc-800 p-3">
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <Textarea
              aria-label="Message"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder={chatTargetId ? "Ask about this target… (Enter to send, Shift+Enter for newline)" : "Select a target first"}
              disabled={streaming || !chatTargetId}
              rows={2}
              className="min-h-0 flex-1 resize-none border-zinc-800 bg-zinc-950 text-sm"
            />
            <Button
              type="submit"
              size="icon"
              aria-label="Send message"
              disabled={streaming || !input.trim() || !chatTargetId}
              className="size-9 shrink-0 bg-emerald-600 text-white hover:bg-emerald-500"
            >
              {streaming ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
            </Button>
          </form>
        </div>
      </section>
    </div>
  );
}

function MessageBubble({ entry }: { entry: ChatEntry }) {
  if (entry.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg rounded-br-sm border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-100">
          {entry.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="w-full max-w-[90%] space-y-2">
        {entry.trace.length > 0 && (
          <div className="space-y-1.5">
            {entry.trace.map((step) => (
              <ToolTraceRow key={step.id} step={step} />
            ))}
          </div>
        )}
        {entry.content ? (
          <div className="rounded-lg rounded-bl-sm border border-zinc-800 bg-zinc-950/80 px-3 py-2">
            <Markdown>{entry.content}</Markdown>
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-xs text-zinc-500">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Thinking…
          </div>
        )}
        {entry.createdAt && (
          <p className="text-[10px] text-zinc-600">{timeAgo(entry.createdAt)}</p>
        )}
      </div>
    </div>
  );
}

function ToolTraceRow({ step }: { step: TraceStep }) {
  const [open, setOpen] = React.useState(false);
  if (step.pending) {
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex items-center gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-1.5 font-mono text-[11px] text-emerald-400"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        calling REA tool {step.tool}…
      </motion.div>
    );
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-md border border-zinc-800 bg-zinc-950/80">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-mono text-[11px] text-zinc-400 transition-colors hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
            aria-expanded={open}
          >
            <Wrench className="size-3.5 shrink-0 text-emerald-500" aria-hidden />
            <span className="truncate">REA tool: {step.tool}</span>
            {step.preview && (
              <span className="ml-1 hidden min-w-0 flex-1 truncate text-zinc-600 sm:block">{step.preview}</span>
            )}
            <ChevronDown className={cn("ml-auto size-3.5 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ScrollArea className="max-h-40 border-t border-zinc-800">
            <pre className="p-2 font-mono text-[10px] leading-relaxed whitespace-pre-wrap text-zinc-500">
              {step.preview ?? (step.args ? JSON.stringify(step.args, null, 2) : "(no output captured)")}
            </pre>
          </ScrollArea>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
