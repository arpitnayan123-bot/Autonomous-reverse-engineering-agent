"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  ArrowRight,
  ArrowUpRight,
  Binary,
  Command,
  FileUp,
  Github,
  KeyRound,
  MessageSquarePlus,
  MessagesSquare,
  MonitorDot,
  ScanSearch,
  ShieldCheck,
  Star,
  Zap,
} from "lucide-react";

import { estimateCostUsd, formatCostUsd } from "@/lib/pricing";
import { useReaStore } from "@/store/rea-store";
import { cn } from "@/lib/utils";
import { FormatBadge, humanBytes, humanTokens, timeAgo } from "@/components/rea/shared";

// ---------------------------------------------------------------------------
// HomeDashboard — the app "homepage": the empty state of a fresh free chat.
// Every tile is live-wired to the same store data the sidebar/status bar use,
// so the dashboard is always in sync with reality (no stale mock numbers).
// ---------------------------------------------------------------------------

const REA_REPO_URL = "https://github.com/morluto/rea";

const STARTERS = [
  "What file formats can REA analyze?",
  "How do I start reverse engineering an unknown binary?",
  "Explain ELF program headers vs section headers",
  "What is the safest way to analyze a suspicious file?",
];

const fadeUp = {
  hidden: { opacity: 0, y: 10 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.28, ease: "easeOut" as const, delay: i * 0.05 },
  }),
};

export function HomeDashboard({
  hasKey,
  onSuggest,
}: {
  hasKey: boolean | null;
  onSuggest: (text: string) => void;
}) {
  const sessions = useReaStore((s) => s.sessions);
  const targets = useReaStore((s) => s.targets);
  const capabilities = useReaStore((s) => s.capabilities);
  const providerActive = useReaStore((s) => s.providerActive);
  const chatQuota = useReaStore((s) => s.chatQuota);
  const openSession = useReaStore((s) => s.openSession);
  const openInspector = useReaStore((s) => s.openInspector);
  const setDialog = useReaStore((s) => s.setDialog);
  const setPaletteOpen = useReaStore((s) => s.setPaletteOpen);
  const setShortcutsOpen = useReaStore((s) => s.setShortcutsOpen);
  const newFreeChat = useReaStore((s) => s.newFreeChat);

  const engine = capabilities?.engine ?? null;
  const recentChats = React.useMemo(() => sessions.slice(0, 4), [sessions]);
  const recentFiles = React.useMemo(() => targets.slice(0, 4), [targets]);

  // Session-scope cost rollup across visible chats (sum of per-chat estimates).
  const visibleCost = React.useMemo(
    () => sessions.reduce((acc, s) => acc + (s.costUsd ?? 0), 0),
    [sessions]
  );
  const visibleCostLabel = formatCostUsd(visibleCost > 0 ? visibleCost : null);

  const totalMessages = React.useMemo(
    () => sessions.reduce((acc, s) => acc + s.messageCount, 0),
    [sessions]
  );

  return (
    <div className="relative min-h-full overflow-hidden">
      {/* ---------- ambient background: grid + glow + scanline ---------- */}
      <div aria-hidden className="rea-home-bg pointer-events-none absolute inset-0">
        <div className="rea-home-glow" />
        <div className="rea-home-grid" />
        <div className="rea-home-scan" />
      </div>

      <div className="relative mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
        {/* ============================ Hero ============================ */}
        <motion.header
          variants={fadeUp}
          custom={0}
          initial="hidden"
          animate="show"
          className="text-center"
        >
          <div className="mx-auto mb-4 flex w-fit items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/70 py-1 pl-1 pr-3 shadow-[0_0_24px_rgb(16_185_129/0.08)] backdrop-blur">
            <span className="grid size-7 place-items-center rounded-full border border-emerald-500/40 bg-emerald-500/10">
              <Binary className="size-3.5 text-emerald-400" aria-hidden />
            </span>
            <span className="font-mono text-[11px] tracking-[0.22em] text-zinc-400">
              REA&nbsp;
              <span className="text-zinc-600">·</span>
              <span className="ml-1.5 text-zinc-500">REVERSE ENGINEER ANYTHING</span>
            </span>
          </div>

          <h1 className="text-balance text-2xl font-semibold tracking-tight text-zinc-100 sm:text-[28px]">
            Your reverse-engineering{" "}
            <span className="bg-gradient-to-r from-emerald-300 via-emerald-400 to-teal-300 bg-clip-text text-transparent">
              workspace
            </span>
          </h1>
          <p className="mx-auto mt-2 max-w-md text-pretty text-[13px] leading-relaxed text-zinc-500">
            Chat with a real binary-analysis agent. Attach a file and it runs the actual REA
            engine — every claim graded with evidence.
          </p>

          {/* live engine + model chips */}
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {engine && (
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px]",
                  engine.healthy
                    ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-300"
                    : "border-rose-500/25 bg-rose-500/5 text-rose-300"
                )}
                title={engine.detail ?? "REA engine status"}
              >
                <span className="relative flex size-1.5">
                  {engine.healthy && (
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  )}
                  <span
                    className={cn(
                      "relative inline-flex size-1.5 rounded-full",
                      engine.healthy ? "bg-emerald-400" : "bg-rose-400"
                    )}
                  />
                </span>
                engine v{engine.version} · {engine.toolCount} tools
              </span>
            )}
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-900/60 px-2.5 py-1 font-mono text-[10px] text-zinc-400"
              title={providerActive ? "Running on your own API key" : "Running on the built-in platform model"}
            >
              <Zap className="size-3 text-amber-400/80" aria-hidden />
              {providerActive ? `${providerActive.provider}/${providerActive.model}` : "platform model"}
            </span>
            {hasKey === false && (
              <button
                type="button"
                onClick={() => setDialog("settings")}
                className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/25 bg-amber-500/5 px-2.5 py-1 font-mono text-[10px] text-amber-300 transition-colors hover:bg-amber-500/15"
              >
                <KeyRound className="size-3" aria-hidden />
                add your API key
                <ArrowUpRight className="size-3" aria-hidden />
              </button>
            )}
          </div>
        </motion.header>

        {/* ======================= Stat cards ======================= */}
        <motion.section
          variants={fadeUp}
          custom={1}
          initial="hidden"
          animate="show"
          aria-label="Workspace stats"
          className="mt-7 grid grid-cols-2 gap-2.5 sm:grid-cols-4"
        >
          <StatCard
            icon={MessagesSquare}
            label="chats"
            value={String(sessions.length)}
            detail={`${totalMessages} messages`}
            onClick={() => {
              newFreeChat();
              setPaletteOpen(true);
            }}
            hint="Browse chats (⌘K)"
          />
          <StatCard
            icon={FileUp}
            label="files"
            value={String(targets.length)}
            detail={targets.length > 0 ? `latest ${timeAgo(targets[0].createdAt)}` : "none uploaded yet"}
            onClick={() => {
              if (targets.length > 0) openInspector(targets[0].id);
              else setDialog("settings");
            }}
            hint={targets.length > 0 ? "Inspect latest file" : "Upload from the sidebar"}
          />
          <StatCard
            icon={ScanSearch}
            label="engine tools"
            value={engine ? String(engine.toolCount) : "—"}
            detail={engine ? `v${engine.version} ${engine.healthy ? "· ready" : "· degraded"}` : "probing…"}
            onClick={() => setDialog("system")}
            hint="Engine & security"
          />
          <StatCard
            icon={ShieldCheck}
            label="msg quota"
            value={chatQuota ? `${chatQuota.remaining}/${chatQuota.limit}` : "—"}
            detail={chatQuota ? "per 5-minute window" : "resets on first message"}
            onClick={() => setShortcutsOpen(true)}
            hint="Rate-limit info (?)"
          />
        </motion.section>

        {/* ================== Recent chats + files ================== */}
        <motion.section
          variants={fadeUp}
          custom={2}
          initial="hidden"
          animate="show"
          className="mt-3 grid grid-cols-1 gap-2.5 sm:mt-4 md:grid-cols-2"
        >
          {/* -------- Recent chats -------- */}
          <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 backdrop-blur">
            <div className="flex items-center justify-between border-b border-zinc-800/60 px-3.5 py-2.5">
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                Recent chats
              </p>
              <span className="font-mono text-[10px] tabular-nums text-zinc-600">
                {sessions.length}
              </span>
            </div>
            <ul className="p-1.5">
              {recentChats.length === 0 && (
                <li className="px-2.5 py-3 text-xs text-zinc-600">
                  No chats yet — send your first message below.
                </li>
              )}
              {recentChats.map((chat) => (
                <li key={chat.id}>
                  <button
                    type="button"
                    onClick={() => openSession(chat.id)}
                    className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-zinc-800/50 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
                  >
                    <MessageSquarePlus
                      className="size-3.5 shrink-0 text-zinc-600 transition-colors group-hover:text-emerald-400"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-zinc-300 group-hover:text-zinc-100">
                        {chat.title || "Untitled chat"}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-zinc-600">
                        {chat.targetName && (
                          <span className="max-w-[90px] truncate text-emerald-500/70">
                            {chat.targetName}
                          </span>
                        )}
                        <span>{chat.messageCount} msg</span>
                        <span>·</span>
                        <span>{timeAgo(chat.updatedAt)}</span>
                        {chat.costUsd != null && chat.costUsd > 0 && (
                          <>
                            <span>·</span>
                            <span className="text-amber-500/70">~{formatCostUsd(chat.costUsd)}</span>
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
          </div>

          {/* -------- Recent files -------- */}
          <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/40 backdrop-blur">
            <div className="flex items-center justify-between border-b border-zinc-800/60 px-3.5 py-2.5">
              <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
                Recent files
              </p>
              <span className="font-mono text-[10px] tabular-nums text-zinc-600">
                {targets.length}
              </span>
            </div>
            <ul className="p-1.5">
              {recentFiles.length === 0 && (
                <li className="px-2.5 py-3 text-xs text-zinc-600">
                  No files yet — upload one from the sidebar to start a tool-driven chat.
                </li>
              )}
              {recentFiles.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    onClick={() => openInspector(file.id)}
                    className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-zinc-800/50 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
                  >
                    <span className="shrink-0">
                      <FormatBadge format={file.detectedFormat} className="text-[9px]" />
                    </span>
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
          </div>
        </motion.section>

        {/* ===================== Quick actions ===================== */}
        <motion.section
          variants={fadeUp}
          custom={3}
          initial="hidden"
          animate="show"
          aria-label="Quick actions"
          className="mt-3 grid grid-cols-2 gap-2.5 sm:mt-4 sm:grid-cols-4"
        >
          <QuickAction icon={MessageSquarePlus} label="New chat" kbd="⌘⇧O" onClick={() => newFreeChat()} />
          <QuickAction icon={KeyRound} label="API key" kbd="" onClick={() => setDialog("settings")} />
          <QuickAction icon={MonitorDot} label="Engine" kbd="" onClick={() => setDialog("system")} />
          <QuickAction icon={Command} label="Palette" kbd="⌘K" onClick={() => setPaletteOpen(true)} />
        </motion.section>

        {/* ================== Starter prompts ================== */}
        <motion.section
          variants={fadeUp}
          custom={4}
          initial="hidden"
          animate="show"
          aria-label="Starter prompts"
          className="mt-5 sm:mt-6"
        >
          <p className="mb-2.5 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-600">
            try asking
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {STARTERS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onSuggest(s)}
                className="rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-xs text-zinc-400 transition-all hover:-translate-y-px hover:border-emerald-500/30 hover:bg-zinc-900 hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
              >
                {s}
              </button>
            ))}
          </div>
          {visibleCostLabel && (
            <p className="mt-4 text-center font-mono text-[10px] text-zinc-700">
              est. spend across {sessions.length} chats:{" "}
              <span className="text-amber-500/80">~{visibleCostLabel}</span>
              {totalMessages > 0 && (
                <>
                  {" "}· {humanTokens(totalMessages)} messages
                </>
              )}
            </p>
          )}
        </motion.section>

        {/* ==================== REA repo credit ==================== */}
        <motion.section
          variants={fadeUp}
          custom={5}
          initial="hidden"
          animate="show"
          className="mt-6 sm:mt-8"
        >
          <a
            href={REA_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex items-center gap-3.5 rounded-xl border border-zinc-800/80 bg-gradient-to-r from-zinc-900/80 via-zinc-900/50 to-zinc-900/80 px-4 py-3.5 transition-all hover:border-emerald-500/30 hover:shadow-[0_0_32px_rgb(16_185_129/0.07)] focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
            title="Open the REA repository on GitHub"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-zinc-800 bg-zinc-950 transition-colors group-hover:border-emerald-500/40">
              <Github className="size-4.5 text-zinc-300 transition-colors group-hover:text-emerald-300" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-xs font-semibold text-zinc-200">
                  Powered by REA — Reverse Engineer Anything
                </span>
                <span className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-zinc-950 px-1 font-mono text-[9px] text-zinc-500">
                  <Star className="size-2.5 text-amber-400/80" aria-hidden />
                  MIT
                </span>
              </span>
              <span className="mt-0.5 block truncate font-mono text-[10px] text-zinc-600 group-hover:text-zinc-500">
                github.com/morluto/rea
                {engine && <> · rea-agents v{engine.version} · {engine.toolCount} MCP tools</>}
              </span>
            </span>
            <ArrowUpRight
              className="size-4 shrink-0 text-zinc-600 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-emerald-300"
              aria-hidden
            />
          </a>
        </motion.section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  onClick,
  hint,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  label: string;
  value: string;
  detail: string;
  onClick: () => void;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className="group relative overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/40 p-3 text-left backdrop-blur transition-all hover:-translate-y-px hover:border-zinc-700 hover:bg-zinc-900/70 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-3 -top-3 size-14 rounded-full bg-emerald-500/5 opacity-0 blur-xl transition-opacity duration-300 group-hover:opacity-100"
      />
      <div className="flex items-center justify-between">
        <Icon className="size-3.5 text-zinc-600 transition-colors group-hover:text-emerald-400" aria-hidden />
        <ArrowUpRight
          className="size-3 text-zinc-800 transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-zinc-500"
          aria-hidden
        />
      </div>
      <p className="mt-2 font-mono text-lg font-semibold tabular-nums leading-none text-zinc-100">
        {value}
      </p>
      <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-zinc-500">
        {label}
      </p>
      <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-600">{detail}</p>
    </button>
  );
}

function QuickAction({
  icon: Icon,
  label,
  kbd,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  label: string;
  kbd: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center justify-center gap-2 rounded-lg border border-zinc-800/80 bg-zinc-900/40 px-3 py-2.5 text-xs text-zinc-400 backdrop-blur transition-all hover:border-emerald-500/30 hover:bg-zinc-900 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-emerald-500/50 focus-visible:outline-none"
    >
      <Icon className="size-3.5 text-zinc-500 transition-colors group-hover:text-emerald-400" aria-hidden />
      {label}
      {kbd && (
        <kbd className="rounded border border-zinc-800 bg-zinc-950 px-1 font-mono text-[9px] text-zinc-600">
          {kbd}
        </kbd>
      )}
    </button>
  );
}
