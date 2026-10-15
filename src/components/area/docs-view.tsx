"use client";

import {
  BookOpen,
  Boxes,
  BrainCircuit,
  CircuitBoard,
  Coins,
  Database,
  FileCode,
  FileSearch,
  FileText,
  Github,
  HardDrive,
  Layers,
  ListChecks,
  Package,
  ScanSearch,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Network,
  Smartphone,
  Workflow,
} from "lucide-react";

import { SectionCard } from "@/components/area/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";

const PIPELINE = [
  {
    icon: HardDrive,
    title: "1 · Upload",
    text: "You upload a file (≤ 50 MB). Magic bytes are validated, the original is stored under a server-generated UUID and hashed with SHA-256 — the file is parsed read-only, never executed.",
  },
  {
    icon: ScanSearch,
    title: "2 · Detect",
    text: "Format detection classifies the artifact: ELF, PE, Mach-O, WASM, EVM, SQLite, ZIP/APK/JAR/ASAR, JavaScript, plist, pcap, DEX, or unknown-raw.",
  },
  {
    icon: Workflow,
    title: "3 · AREA engine investigation",
    text: "A sandboxed child process drives the real AREA engine (rea-agents) through its MCP stdio interface — 170 evidence-first tools — plus host analyzers like strings and objdump when available.",
  },
  {
    icon: ListChecks,
    title: "4 · Evidence ledger",
    text: "Every observation the engine makes is written to an immutable evidence ledger, graded observed / derived / inferred / unknown, so conclusions are auditable.",
  },
  {
    icon: BrainCircuit,
    title: "5 · AI synthesis",
    text: "The AI analyst cites that ledger to explain what the artifact does, answer questions in chat, and generate documentation. If evidence is missing, it says so.",
  },
];

const EVIDENCE_KINDS = [
  { kind: "observed", className: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10", text: "Read directly from the artifact bytes — the strongest form of evidence." },
  { kind: "derived", className: "text-amber-400 border-amber-500/30 bg-amber-500/10", text: "Computed from observed facts (e.g. entropy, offsets, unpacked structures)." },
  { kind: "inferred", className: "text-orange-400 border-orange-500/30 bg-orange-500/10", text: "A best-effort hypothesis consistent with the evidence — treated as provisional." },
  { kind: "unknown", className: "text-rose-400 border-rose-500/30 bg-rose-500/10", text: "The engine could not resolve this; it fails closed rather than guessing." },
];

const FORMATS = [
  { icon: CircuitBoard, label: "ELF / PE / Mach-O" },
  { icon: Boxes, label: "WebAssembly" },
  { icon: Coins, label: "EVM bytecode" },
  { icon: Database, label: "SQLite databases" },
  { icon: Package, label: "ZIP / APK / JAR" },
  { icon: Layers, label: "Electron ASAR" },
  { icon: FileCode, label: "JavaScript / TS" },
  { icon: FileText, label: "plists" },
  { icon: Network, label: "pcap captures" },
  { icon: Smartphone, label: "Android DEX" },
  { icon: Terminal, label: "Scripts" },
  { icon: FileSearch, label: "Raw unknown binaries" },
];

export function DocsView() {
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10">
          <BookOpen className="size-5 text-emerald-400" aria-hidden />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">About the AREA Platform</h2>
          <p className="max-w-2xl text-sm text-zinc-500">
            A browser-based front end for AREA — the autonomous reverse engineering agent —
            evidence-first binary analysis driven by an AI agent with 170 MCP tools.
          </p>
        </div>
      </div>

      <SectionCard title="How it works" description="From upload to auditable answers" icon={Workflow}>
        <ol className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {PIPELINE.map(({ icon: Icon, title, text }) => (
            <li key={title} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
              <div className="flex items-center gap-2">
                <Icon className="size-4 shrink-0 text-emerald-400" aria-hidden />
                <p className="font-mono text-xs font-semibold tracking-wide text-zinc-200">{title}</p>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-zinc-500">{text}</p>
            </li>
          ))}
        </ol>
      </SectionCard>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <SectionCard title="Evidence methodology" description="Every claim carries a grade" icon={ListChecks}>
          <ul className="space-y-3">
            {EVIDENCE_KINDS.map(({ kind, className, text }) => (
              <li key={kind} className="flex items-start gap-3">
                <Badge variant="outline" className={"mt-0.5 shrink-0 font-mono text-[10px] uppercase tracking-widest " + className}>
                  {kind}
                </Badge>
                <span className="text-xs leading-relaxed text-zinc-400">{text}</span>
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard title="Security model" description="Defense in depth, summarized" icon={ShieldCheck}>
          <ul className="list-disc space-y-2 pl-4 text-xs leading-relaxed text-zinc-400">
            <li>Uploads are capped at 50 MB and validated by magic bytes, not by client-supplied MIME types.</li>
            <li>Stored files use server-generated UUID names — user paths are never trusted.</li>
            <li>Analysis runs in child processes with timeouts, SIGKILL enforcement and output caps.</li>
            <li>Database inspection is guarded by SELECT-only SQL; destructive statements are rejected.</li>
            <li>API routes are rate-limited and every security-relevant event is written to an audit log.</li>
            <li>Sessions use HMAC-signed HttpOnly cookies; passwords are scrypt-hashed.</li>
          </ul>
        </SectionCard>
      </div>

      <SectionCard title="Supported formats" description="Detected automatically on upload" icon={Boxes}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {FORMATS.map(({ icon: Icon, label }) => (
            <div
              key={label}
              className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-300"
            >
              <Icon className="size-4 shrink-0 text-emerald-400" aria-hidden />
              {label}
            </div>
          ))}
        </div>
      </SectionCard>

      {/* --------------------- Upstream attribution --------------------- */}
      <SectionCard title="Credits & attribution" description="The engine behind this platform" icon={Github}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-zinc-100">
              AREA — Autonomous reverse engineering agent
            </p>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-zinc-500">
              This platform is a browser front end built on top of the open-source{" "}
              <a
                href="https://github.com/morluto/rea"
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-emerald-400 underline decoration-emerald-500/40 underline-offset-2 transition-colors hover:text-emerald-300"
              >
                morluto/rea
              </a>{" "}
              project (npm: <code className="rounded bg-zinc-900 px-1 py-0.5 font-mono text-[10px] text-zinc-300">rea-agents</code>
              , MIT license). All binary analysis — 170 MCP tools, evidence grading, format
              inspection — is performed by the real AREA engine running in a sandboxed child
              process.
            </p>
          </div>
          <a
            href="https://github.com/morluto/rea"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-[11px] text-zinc-300 transition-colors hover:border-emerald-500/30 hover:text-emerald-300"
          >
            <Github className="size-3.5" aria-hidden />
            github.com/morluto/rea
          </a>
        </div>
      </SectionCard>

      <Alert className="border-amber-500/30 bg-amber-500/5">
        <ShieldAlert className="size-4 text-amber-400" aria-hidden />
        <AlertTitle className="text-amber-400">Responsible use</AlertTitle>
        <AlertDescription className="text-xs leading-relaxed text-zinc-400">
          Only analyze files you are authorized to examine. Uploaded artifacts are parsed
          read-only and are never executed by the platform, but you remain responsible for
          complying with applicable laws, licenses and engagement scopes.
        </AlertDescription>
      </Alert>
    </div>
  );
}
