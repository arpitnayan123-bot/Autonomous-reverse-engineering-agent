"use client";

import * as React from "react";
import {
  Binary,
  BookOpen,
  FileSearch,
  ListTree,
  MessageSquareQuote,
  ScrollText,
  ShieldQuestion,
  Sparkles,
  Wand2,
} from "lucide-react";

import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Prompt library — "/" in the composer opens this menu (IDE/Cursor-style).
// Scope: "file" prompts only make sense with a file attached; "free" ones in
// plain chats. "both" entries always show.
// ---------------------------------------------------------------------------

export interface PromptEntry {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  /** Shown in the menu. */
  label: string;
  /** Inserted into the composer when picked. */
  prompt: string;
  scope: "file" | "free" | "both";
  /** One-line explanation. */
  hint: string;
}

export const PROMPT_LIBRARY: PromptEntry[] = [
  {
    icon: FileSearch,
    label: "Explain this file",
    prompt: "Explain what this file does, step by step, citing evidence.",
    scope: "file",
    hint: "Overview of purpose and behavior with graded evidence",
  },
  {
    icon: Binary,
    label: "Format deep-dive",
    prompt: "Identify the exact format and structure of this file. List headers, sections and notable offsets.",
    scope: "file",
    hint: "Headers, sections, magic bytes and layout",
  },
  {
    icon: ListTree,
    label: "Interesting strings",
    prompt: "List the most interesting strings in this file and explain what each suggests.",
    scope: "file",
    hint: "URLs, paths, secrets, symbols — and what they imply",
  },
  {
    icon: ShieldQuestion,
    label: "Is it safe?",
    prompt: "Assess whether this file looks suspicious. Point at concrete evidence, and say clearly what you cannot determine.",
    scope: "file",
    hint: "Suspicion assessment with honest unknowns",
  },
  {
    icon: ScrollText,
    label: "Write documentation",
    prompt: "Write reference documentation for this file based on the analysis so far.",
    scope: "file",
    hint: "Structured docs from the evidence ledger",
  },
  {
    icon: BookOpen,
    label: "Explain a concept",
    prompt: "Explain a reverse-engineering concept in plain language: ",
    scope: "free",
    hint: "Finish the sentence — e.g. ELF sections, entropy…",
  },
  {
    icon: MessageSquareQuote,
    label: "Compare formats",
    prompt: "Compare ELF, PE and Mach-O: layout, headers and how tooling differs between them.",
    scope: "free",
    hint: "Executable formats side by side",
  },
  {
    icon: Sparkles,
    label: "Getting started",
    prompt: "I have an unknown binary and no context. Walk me through a safe first analysis, step by step.",
    scope: "free",
    hint: "A safe REA-first workflow for unknown files",
  },
];

/** Parse the composer text: is the user actively on a "/…" slash token? */
export function slashTokenOf(input: string): string | null {
  if (!input.startsWith("/")) return null;
  const rest = input.slice(1);
  if (rest.includes("\n") || rest.slice(1).includes(" ")) return null;
  return rest.toLowerCase();
}

export function filterPrompts(scope: "file" | "free", token: string | null): PromptEntry[] {
  const pool = PROMPT_LIBRARY.filter((p) => p.scope === "both" || p.scope === scope);
  if (!token) return pool;
  return pool.filter(
    (p) =>
      p.label.toLowerCase().includes(token) ||
      p.prompt.toLowerCase().includes(token) ||
      p.hint.toLowerCase().includes(token)
  );
}

export function SlashMenu({
  visible,
  entries,
  activeIndex,
  onPick,
  onHover,
}: {
  visible: boolean;
  entries: PromptEntry[];
  activeIndex: number;
  onPick: (entry: PromptEntry) => void;
  onHover: (index: number) => void;
}) {
  if (!visible) return null;
  return (
    <div
      role="listbox"
      aria-label="Prompt library"
      className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/95 shadow-2xl shadow-black/50 backdrop-blur"
    >
      <div className="flex items-center justify-between border-b border-zinc-800/80 px-3 py-1.5">
        <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
          Prompt library
        </span>
        <span className="font-mono text-[9px] text-zinc-600">↑↓ navigate · ↵ insert · esc close</span>
      </div>
      <ul className="max-h-64 overflow-y-auto rea-scroll p-1.5">
        {entries.length === 0 && (
          <li className="px-2.5 py-3 text-xs text-zinc-600">No prompts match “{"/…"}”.</li>
        )}
        {entries.map((entry, i) => {
          const Icon = entry.icon;
          const active = i === activeIndex;
          return (
            <li key={entry.label}>
              <button
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => onPick(entry)}
                onMouseMove={() => onHover(i)}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                  active ? "bg-emerald-500/10" : "hover:bg-zinc-800/60"
                )}
              >
                <Icon
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0",
                    active ? "text-emerald-400" : "text-zinc-500"
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block text-xs font-medium",
                      active ? "text-emerald-200" : "text-zinc-200"
                    )}
                  >
                    {entry.label}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-zinc-500">
                    {entry.prompt} — {entry.hint}
                  </span>
                </span>
                {active && (
                  <kbd className="mt-0.5 shrink-0 rounded border border-zinc-800 bg-zinc-950 px-1 font-mono text-[9px] text-zinc-500">
                    ↵
                  </kbd>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Small helper chip shown in the composer footer when the menu is closed. */
export function SlashHint() {
  return (
    <span className="flex items-center gap-1 font-mono text-[10px] text-zinc-700">
      <Wand2 className="size-2.5" aria-hidden />/
    </span>
  );
}
