"use client";

import * as React from "react";
import { motion, type Variants } from "framer-motion";
import {
  Binary,
  BookOpen,
  FileSearch,
  FileUp,
  Github,
  SendHorizontal,
  ShieldCheck,
} from "lucide-react";

import { useReaStore } from "@/store/rea-store";
import { cn } from "@/lib/utils";
import { MAX_MESSAGE_CHARS, CHAR_COUNTER_AT } from "@/components/rea/chat-limits";
import { SlashMenu, filterPrompts, slashTokenOf, type PromptEntry } from "@/components/rea/prompt-library";
import { toastError } from "@/components/rea/shared";
import {
  getChatMood,
  pulseChatMood,
  setChatMood,
} from "@/components/rea/chat-mood";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";

// ---------------------------------------------------------------------------
// HomeDashboard — the first screen after sign-in (empty state of a free chat).
//
// Design brief: a living, premium entry point. The particle field behind the
// panel reacts to the conversation (chat-mood.ts); the panel itself layers
// morphisms — a glassmorphism composer wrapped in an animated beam border,
// glass starter pills with a hover sheen, a shimmering gradient hero, and a
// real engine-status chip. One greeting, ONE composer, a handful of starters,
// two whisper-quiet footer lines. No filler, no fake data.
// ---------------------------------------------------------------------------

const REA_REPO_URL = "https://github.com/morluto/rea";

/** A small number of relevant suggested tasks (kept deliberately short). */
const STARTERS = [
  { icon: FileSearch, text: "What file formats can REA analyze?" },
  { icon: Binary, text: "How do I start reverse engineering an unknown binary?" },
  { icon: BookOpen, text: "Explain ELF program headers vs section headers" },
  { icon: ShieldCheck, text: "What is the safest way to analyze a suspicious file?" },
] as const;

/** Staggered entrance choreography (respects the app-wide MotionConfig). */
const STAGGER: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.04 } },
};
const RISE: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.55, ease: [0.21, 0.47, 0.32, 0.98] },
  },
};

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
  const setDialog = useReaStore((s) => s.setDialog);
  const engine = useReaStore((s) => s.capabilities?.engine ?? null);

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

  // If we unmount while the "focus" mood is latched (e.g. the user just sent
  // from Home and the workspace took over), hand the field back to idle —
  // but never clobber a streaming/thinking/tool mood the turn already set.
  React.useEffect(
    () => () => {
      if (getChatMood() === "focus") setChatMood("idle");
    },
    []
  );

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
  const sendBlocked = input.trim().length === 0 || input.length > MAX_MESSAGE_CHARS;

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
    // IME safety: Enter that CONFIRMS a CJK composition must not send.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="min-h-full" onKeyDown={onHomeKeyDown}>
      <motion.div
        variants={STAGGER}
        initial="hidden"
        animate="show"
        className="mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 pt-[11vh] pb-8 sm:px-6"
      >
        {/* ===================== Engine chip (real, from /api/capabilities) */}
        {engine && (
          <motion.div variants={RISE} className="mb-4 flex">
            <span
              className="rea-glass inline-flex items-center gap-2 rounded-full px-3 py-1.5 font-mono text-[10px] tracking-wide text-zinc-400"
              title={
                engine.healthy
                  ? "The real REA engine is connected via MCP stdio"
                  : "The REA engine is degraded — some tools may fail"
              }
            >
              <span className="relative flex size-1.5" aria-hidden>
                {engine.healthy && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                )}
                <span
                  className={cn(
                    "relative inline-flex size-1.5 rounded-full",
                    engine.healthy ? "bg-emerald-500" : "bg-rose-500"
                  )}
                />
              </span>
              rea engine {engine.version} · {engine.toolCount} tools{" "}
              {engine.healthy ? "online" : "degraded"}
            </span>
          </motion.div>
        )}

        {/* ===================== Greeting ===================== */}
        <motion.h1
          variants={RISE}
          className="text-balance text-[28px] font-semibold leading-tight tracking-tighter text-zinc-50 sm:text-[36px]"
        >
          What are we <span className="rea-hero-shimmer">investigating</span>?
        </motion.h1>
        <motion.p
          variants={RISE}
          className="mt-2.5 max-w-md text-pretty text-sm leading-relaxed text-zinc-500"
        >
          Ask anything, attach a file, or press{" "}
          <kbd className="rounded border border-zinc-800 bg-zinc-900 px-1 py-px font-mono text-[10px] text-zinc-400">
            /
          </kbd>{" "}
          for prompts. Every claim lands in an evidence ledger.
        </motion.p>

        {/* ===================== Prominent composer ===================== */}
        <motion.div variants={RISE} className="relative mt-6">
          <SlashMenu
            visible={slashOpen}
            entries={slashEntries}
            activeIndex={slashIndex}
            onPick={pickPrompt}
            onHover={setSlashIndex}
          />
          {/* Beam border (animated rim) → glassmorphism core */}
          <div className="rea-beam rounded-2xl">
            <div className="rea-glass rounded-[15px]">
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  // Typing pulls the field into a halo around the composer.
                  pulseChatMood("focus");
                }}
                onKeyDown={onComposerKeyDown}
                rows={2}
                placeholder="Describe what you want to investigate…"
                aria-label="Start an investigation"
                aria-expanded={slashOpen}
                aria-controls={slashOpen ? "rea-prompt-listbox" : undefined}
                aria-activedescendant={slashOpen ? `rea-prompt-opt-${slashIndex}` : undefined}
                role={slashOpen ? "combobox" : undefined}
                className="max-h-[200px] resize-none border-0 bg-transparent px-4 pt-3.5 pb-1 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:ring-0"
              />
              <div className="flex items-center gap-2 px-3 pb-2.5">
                {onAttachFile && (
                  <button
                    type="button"
                    onClick={onAttachFile}
                    aria-label="Attach a file to investigate (upload)"
                    title="Attach a file — uploads, auto-analyzes, and starts a tool-driven chat"
                    className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-zinc-800/80 bg-zinc-950/50 px-2 text-[11px] text-zinc-400 backdrop-blur-sm transition-all duration-200 hover:-translate-y-px hover:border-zinc-700 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
                  >
                    <FileUp className="size-3.5" aria-hidden />
                    <span className="hidden sm:inline">Attach file</span>
                  </button>
                )}
                <span className="ml-auto flex items-center gap-2">
                  {!sendBlocked && input.length >= CHAR_COUNTER_AT && (
                    <span
                      className={cn(
                        "font-mono text-[10px] tabular-nums",
                        input.length > MAX_MESSAGE_CHARS ? "text-rose-400" : "text-amber-400/80"
                      )}
                    >
                      {input.length}/{MAX_MESSAGE_CHARS}
                    </span>
                  )}
                  <span className="hidden font-mono text-[10px] text-zinc-600 sm:inline">
                    Enter to send · Shift+Enter for a new line
                  </span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  onClick={send}
                  disabled={sendBlocked}
                  aria-label="Start the investigation"
                  className="h-7 gap-1.5 rounded-lg bg-gradient-to-b from-emerald-500 to-emerald-600 px-3 text-xs font-medium text-white shadow-[0_2px_12px_-2px_rgba(16,185,129,0.55)] transition-all duration-200 hover:from-emerald-400 hover:to-emerald-500 hover:shadow-[0_4px_18px_-2px_rgba(16,185,129,0.7)] active:translate-y-px disabled:from-zinc-700 disabled:to-zinc-800 disabled:text-zinc-400 disabled:shadow-none"
                >
                  <SendHorizontal className="size-3" aria-hidden />
                  Send
                </Button>
              </div>
            </div>
          </div>
        </motion.div>

        {/* ===================== Suggested tasks ===================== */}
        <motion.section variants={RISE} aria-label="Suggested tasks" className="mt-7">
          <div className="flex flex-wrap gap-2">
            {STARTERS.map(({ icon: Icon, text }) => (
              <button
                key={text}
                type="button"
                onClick={() => onSuggest(text)}
                className="rea-card-shine group flex items-center gap-2 rounded-full border border-zinc-800/60 bg-zinc-900/30 px-3.5 py-2 text-xs text-zinc-500 transition-all duration-200 hover:-translate-y-0.5 hover:border-emerald-500/30 hover:bg-zinc-900/60 hover:text-zinc-100 hover:shadow-[0_10px_28px_-14px_rgba(16,185,129,0.45)] focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
              >
                <Icon
                  className="size-3.5 shrink-0 text-emerald-500/60 transition-colors duration-200 group-hover:text-emerald-400"
                  aria-hidden
                />
                <span>{text}</span>
              </button>
            ))}
          </div>
        </motion.section>

        {/* ================= Quiet footer ================= */}
        <motion.footer variants={RISE} className="mt-auto pt-12">
          {/* Gradient hairline — the single ornamental line on the page. */}
          <div
            aria-hidden
            className="mx-auto mb-6 h-px w-24 bg-gradient-to-r from-transparent via-emerald-500/30 to-transparent"
          />
          {/* BYOK state — one whisper-quiet line, only when it matters. */}
          {hasKey === false && (
            <button
              type="button"
              onClick={() => setDialog("settings")}
              className="mx-auto mb-2.5 block w-fit text-[11px] text-zinc-600 transition-colors hover:text-zinc-400 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
            >
              Using the built-in platform model — add your API key for full control
            </button>
          )}
          <a
            href={REA_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            title="REA is open source (MIT) — github.com/morluto/rea"
            className="mx-auto flex w-fit items-center gap-1.5 rounded font-mono text-[10px] text-zinc-700 transition-colors hover:text-zinc-400 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
          >
            <Github className="size-3" aria-hidden />
            Powered by REA — Reverse Engineer Anything · MIT
          </a>
        </motion.footer>
      </motion.div>
    </div>
  );
}
