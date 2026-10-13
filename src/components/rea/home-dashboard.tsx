"use client";

import * as React from "react";
import {
  ArrowRight,
  Binary,
  FileUp,
  Github,
  KeyRound,
  MessageSquare,
  Paperclip,
  ScanSearch,
  SendHorizontal,
  Zap,
} from "lucide-react";

import { useReaStore } from "@/store/rea-store";
import { cn } from "@/lib/utils";
import { MAX_MESSAGE_CHARS } from "@/components/rea/chat-limits";
import { SlashMenu, filterPrompts, slashTokenOf, type PromptEntry } from "@/components/rea/prompt-library";
import { FormatBadge, humanBytes, timeAgo, toastError } from "@/components/rea/shared";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// HomeDashboard — the first screen after sign-in (empty state of a free chat).
//
// Design brief: composer-first and restrained. One prominent prompt composer,
// a few suggested tasks, recent investigations, and quiet status/credit lines.
// Everything the user already has elsewhere (full stats, quick actions, engine
// diagnostics) lives in the sidebar, palette, status bar and dialogs — this
// screen only needs to answer "how do I start?".
// ---------------------------------------------------------------------------

const REA_REPO_URL = "https://github.com/morluto/rea";

/** A small number of relevant suggested tasks (kept deliberately short). */
const STARTERS = [
  "What file formats can REA analyze?",
  "How do I start reverse engineering an unknown binary?",
  "Explain ELF program headers vs section headers",
  "What is the safest way to analyze a suspicious file?",
];

export function HomeDashboard({
  hasKey,
  onSuggest,
  onAttachFile,
}: {
  hasKey: boolean | null;
  onSuggest: (text: string) => void;
  /** Opens the file picker (upload → auto-analyze → file-bound draft chat). */
  onAttachFile?: () => void;
}) {
  const sessions = useReaStore((s) => s.sessions);
  const targets = useReaStore((s) => s.targets);
  const capabilities = useReaStore((s) => s.capabilities);
  const providerActive = useReaStore((s) => s.providerActive);
  const openSession = useReaStore((s) => s.openSession);
  const openInspector = useReaStore((s) => s.openInspector);
  const setDialog = useReaStore((s) => s.setDialog);
  const setPaletteOpen = useReaStore((s) => s.setPaletteOpen);

  const engine = capabilities?.engine ?? null;
  const recentChats = React.useMemo(() => sessions.slice(0, 3), [sessions]);
  const recentFiles = React.useMemo(() => targets.slice(0, 3), [targets]);

  // ---- Home composer (the entry point; the docked composer takes over
  // after the first message) ------------------------------------------------
  const [input, setInput] = React.useState("");
  const [slashIndex, setSlashIndex] = React.useState(0);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const slashToken = slashTokenOf(input);
  const slashEntries = React.useMemo(() => filterPrompts("free", slashToken), [slashToken]);
  const slashOpen = slashToken !== null && slashEntries.length > 0;

  React.useEffect(() => setSlashIndex(0), [input]);

  // Auto-resize (same behavior as the docked composer).
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  // Focus on mount (desktop only — on phones an autofocus pops the keyboard
  // over the suggestions before the user has read anything).
  React.useEffect(() => {
    if (window.matchMedia("(min-width: 640px)").matches) {
      textareaRef.current?.focus();
    }
  }, []);

  // Cursor-style: start typing anywhere on Home and it lands in the composer.
  const onHomeKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    if (e.key.length === 1 && e.key !== " ") {
      // Focus before the default insert so the character lands in the composer.
      textareaRef.current?.focus();
    }
  };

  const send = () => {
    const message = input.trim();
    if (!message) return;
    if (message.length > MAX_MESSAGE_CHARS) {
      toastError(new Error(`Message too long (${message.length}/${MAX_MESSAGE_CHARS} characters). Trim it first.`));
      return;
    }
    setInput("");
    onSuggest(message);
  };

  const pickPrompt = React.useCallback((entry: PromptEntry) => {
    setInput(entry.prompt);
    textareaRef.current?.focus();
  }, []);

  const onComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
      send();
    }
  };

  const totalMessages = React.useMemo(
    () => sessions.reduce((acc, s) => acc + s.messageCount, 0),
    [sessions]
  );

  return (
    <div className="min-h-full" onKeyDown={onHomeKeyDown}>
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 pt-[9vh] pb-8 sm:px-6">
        {/* ===================== Greeting + composer ===================== */}
        <h1 className="text-balance text-xl font-semibold tracking-tight text-zinc-100 sm:text-2xl">
          What are we investigating?
        </h1>
        <p className="mt-1.5 text-pretty text-[13px] leading-relaxed text-zinc-500">
          Ask anything, attach a file, or press{" "}
          <kbd className="rounded border border-zinc-800 bg-zinc-900 px-1 py-px font-mono text-[10px] text-zinc-400">
            /
          </kbd>{" "}
          for prompts. File chats run the real REA engine and grade every claim.
        </p>

        {/* --- Prominent composer --- */}
        <div className="relative mt-4">
          <SlashMenu
            visible={slashOpen}
            entries={slashEntries}
            activeIndex={slashIndex}
            onPick={pickPrompt}
            onHover={setSlashIndex}
          />
          <div
            className={cn(
              "rounded-xl border border-zinc-800 bg-zinc-900/70 shadow-lg shadow-black/20 transition-all duration-200",
              "focus-within:border-emerald-500/40 focus-within:bg-zinc-900 focus-within:shadow-[0_0_0_1px_rgba(16,185,129,0.18)]"
            )}
          >
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onComposerKeyDown}
              rows={2}
              placeholder="Describe what you want to investigate…"
              aria-label="Start an investigation"
              className="max-h-[200px] resize-none border-0 bg-transparent px-4 pt-3.5 pb-1 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-0"
            />
            <div className="flex items-center gap-2 px-3 pb-2.5">
              {onAttachFile && (
                <button
                  type="button"
                  onClick={onAttachFile}
                  aria-label="Attach a file to investigate (upload)"
                  title="Attach a file — uploads, auto-analyzes, and starts a tool-driven chat"
                  className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950/60 px-2 text-[11px] text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
                >
                  <FileUp className="size-3.5" aria-hidden />
                  <span className="hidden sm:inline">Attach file</span>
                </button>
              )}
              <span className="ml-auto hidden font-mono text-[10px] text-zinc-600 sm:inline">
                Enter to send · Shift+Enter for a new line
              </span>
              <Button
                type="button"
                size="sm"
                onClick={send}
                disabled={!input.trim() || input.length > MAX_MESSAGE_CHARS}
                aria-label="Start the investigation"
                className="h-7 gap-1.5 bg-emerald-600 px-3 text-xs text-white hover:bg-emerald-500 disabled:opacity-40"
              >
                <SendHorizontal className="size-3" aria-hidden />
                Send
              </Button>
            </div>
          </div>

          {/* BYOK hint — only when the platform model is in use. */}
          {hasKey === false && (
            <button
              type="button"
              onClick={() => setDialog("settings")}
              className="mt-2 flex w-full items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-3 py-2 text-left text-[11px] text-amber-300/90 transition-colors hover:bg-amber-500/10 focus-visible:ring-2 focus-visible:ring-amber-500/50 focus-visible:outline-none"
            >
              <KeyRound className="size-3.5 shrink-0" aria-hidden />
              <span className="flex-1">
                Running on the built-in platform model. Add your own API key for full control.
              </span>
              <span className="font-mono text-[10px] text-amber-400">ADD KEY</span>
            </button>
          )}
        </div>

        {/* ===================== Suggested tasks ===================== */}
        <section aria-label="Suggested tasks" className="mt-6">
          <div className="flex flex-wrap gap-2">
            {STARTERS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSuggest(s)}
                className="rounded-full border border-zinc-800 bg-zinc-900/50 px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
              >
                {s}
              </button>
            ))}
          </div>
        </section>

        {/* ===================== Recent activity ===================== */}
        <section
          aria-label="Recent investigations and files"
          className="mt-10 grid grid-cols-1 gap-x-8 gap-y-4 md:grid-cols-2"
        >
          {/* Investigations */}
          <div className="min-w-0">
            <div className="flex items-baseline justify-between border-b border-zinc-800/70 pb-1.5">
              <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                Recent investigations
              </h2>
              {sessions.length > 0 && (
                <button
                  type="button"
                  onClick={() => setPaletteOpen(true)}
                  aria-label="Browse all chats in the command palette"
                  className="rounded px-1 font-mono text-[10px] text-zinc-600 transition-colors hover:text-emerald-300 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
                >
                  all {sessions.length} →
                </button>
              )}
            </div>
            {recentChats.length === 0 ? (
              <p className="pt-2.5 text-xs leading-relaxed text-zinc-600">
                No chats yet — your investigations will appear here.
              </p>
            ) : (
              <ul>
                {recentChats.map((chat) => (
                  <li key={chat.id}>
                    <button
                      type="button"
                      onClick={() => openSession(chat.id)}
                      className="group flex w-full items-center gap-2.5 border-b border-zinc-800/40 px-1 py-2 text-left transition-colors last:border-b-0 hover:bg-zinc-900/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500/50 focus-visible:outline-none"
                    >
                      <MessageSquare className="size-3.5 shrink-0 text-zinc-600 transition-colors group-hover:text-emerald-400" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-zinc-300 group-hover:text-zinc-100">
                          {chat.title || "Untitled chat"}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-zinc-600">
                          {chat.targetName && (
                            <span className="max-w-[90px] truncate text-emerald-500/70">{chat.targetName}</span>
                          )}
                          <span>{chat.messageCount} msg</span>
                          <span>·</span>
                          <span>{timeAgo(chat.updatedAt)}</span>
                        </span>
                      </span>
                      <ArrowRight
                        className="size-3.5 shrink-0 -translate-x-1 text-zinc-700 opacity-0 transition-all group-hover:translate-x-0 group-hover:text-zinc-400 group-hover:opacity-100"
                        aria-hidden
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Files */}
          <div className="min-w-0">
            <div className="flex items-baseline justify-between border-b border-zinc-800/70 pb-1.5">
              <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                Files
              </h2>
              {onAttachFile && (
                <button
                  type="button"
                  onClick={onAttachFile}
                  aria-label="Upload a file to investigate"
                  className="rounded px-1 font-mono text-[10px] text-zinc-600 transition-colors hover:text-emerald-300 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
                >
                  upload →
                </button>
              )}
            </div>
            {recentFiles.length === 0 ? (
              <p className="pt-2.5 text-xs leading-relaxed text-zinc-600">
                Nothing uploaded yet. Drop a binary anywhere, or use{" "}
                <button
                  type="button"
                  onClick={onAttachFile}
                  className="font-mono text-[11px] text-zinc-400 underline decoration-zinc-700 underline-offset-2 hover:text-emerald-300 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
                >
                  attach file
                </button>
                .
              </p>
            ) : (
              <ul>
                {recentFiles.map((file) => (
                  <li key={file.id}>
                    <button
                      type="button"
                      onClick={() => openInspector(file.id)}
                      className="group flex w-full items-center gap-2.5 border-b border-zinc-800/40 px-1 py-2 text-left transition-colors last:border-b-0 hover:bg-zinc-900/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500/50 focus-visible:outline-none"
                    >
                      <FormatBadge format={file.detectedFormat} className="shrink-0 text-[9px]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-zinc-300 group-hover:text-zinc-100">
                          {file.originalName}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-zinc-600">
                          <span>{humanBytes(file.sizeBytes)}</span>
                          <span>·</span>
                          <span>{timeAgo(file.createdAt)}</span>
                          {file.lastRun && (
                            <>
                              <span>·</span>
                              <span className="text-emerald-500/70">{file.lastRun.status}</span>
                            </>
                          )}
                        </span>
                      </span>
                      <ArrowRight
                        className="size-3.5 shrink-0 -translate-x-1 text-zinc-700 opacity-0 transition-all group-hover:translate-x-0 group-hover:text-zinc-400 group-hover:opacity-100"
                        aria-hidden
                      />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* ================= Quiet status + credit ================= */}
        <footer className="mt-auto pt-10">
          {/* One quiet mono line instead of stat cards — each part still navigates. */}
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 font-mono text-[10px] text-zinc-600">
            <span>
              {sessions.length} chats{totalMessages > 0 ? ` · ${totalMessages} msgs` : ""} · {targets.length} files
            </span>
            <span aria-hidden className="text-zinc-800">·</span>
            {engine && (
              <button
                type="button"
                onClick={() => setDialog("system")}
                title="Engine & security details"
                className="inline-flex items-center gap-1 rounded px-1 transition-colors hover:text-emerald-300 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
              >
                <ScanSearch className="size-3" aria-hidden />
                engine v{engine.version} · {engine.toolCount} tools
              </button>
            )}
            <span aria-hidden className="text-zinc-800">·</span>
            <button
              type="button"
              onClick={() => setDialog("settings")}
              title="Model & API key settings"
              className="inline-flex items-center gap-1 rounded px-1 transition-colors hover:text-zinc-300 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
            >
              <Zap className="size-3 text-amber-400/70" aria-hidden />
              {providerActive ? `${providerActive.provider}/${providerActive.model}` : "platform model"}
            </button>
          </div>

          <a
            href={REA_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            title="REA is open source (MIT) — github.com/morluto/rea"
            className="mx-auto mt-3 flex w-fit items-center gap-1.5 rounded font-mono text-[10px] text-zinc-700 transition-colors hover:text-zinc-400 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
          >
            <Github className="size-3" aria-hidden />
            Powered by REA — Reverse Engineer Anything · MIT
            <span className="text-zinc-600">github.com/morluto/rea</span>
          </a>
          <span className="sr-only">
            <Binary aria-hidden /> REA evidence-first reverse engineering workspace
          </span>
        </footer>
      </div>
    </div>
  );
}
