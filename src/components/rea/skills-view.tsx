"use client";

import * as React from "react";
import {
  Download,
  Eye,
  Loader2,
  Package,
  Play,
  Puzzle,
  RefreshCw,
  ShieldAlert,
  Star,
} from "lucide-react";

import { apiGet, apiPost } from "@/lib/api-client";
import { EmptyState, timeAgo, toastError } from "@/components/rea/shared";
import { CopyButton } from "@/components/rea/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "@/hooks/use-toast";

/**
 * /skills — the community skills marketplace (Capability C5). A grid of
 * checksummed, permission-declaring skills with a detail dialog: manifest
 * viewer, install, rating, and a sandboxed run with the full transcript
 * (answer + tool-call receipts + audit trail). Runs NEVER execute code from
 * a manifest — a manifest is pure JSON; the sandbox intersects the manifest
 * permissions with the real agent registry and enforces call/time budgets.
 */

// ---------------------------------------------------------------------------
// Wire types (mirror the API)
// ---------------------------------------------------------------------------

interface SkillRow {
  id: string;
  slug: string;
  name: string;
  version: string;
  author: string;
  description: string;
  status: string;
  checksum: string;
  bundled: boolean;
  signed: boolean;
  installs: number;
  rating: { sum: number; count: number; avg: number };
  createdAt: string;
  updatedAt: string;
}

interface SkillManifestView {
  slug: string;
  name: string;
  version: string;
  description: string;
  entry: { system: string; opening: string };
  permissions: string[];
  limits: { toolCalls: number; workspaceBytes: number; timeoutMs: number };
}

interface SkillDetailRow extends SkillRow {
  manifest: SkillManifestView;
  ratings: Array<{ score: number; comment: string | null; createdAt: string }>;
}

interface RunReceipt {
  tool: string;
  args: Record<string, unknown>;
  ms: number;
  chars: number;
  ok: boolean;
  refused: boolean;
  error?: string;
  result?: string;
}

interface RunTranscript {
  slug: string;
  version: string;
  checksum: string;
  answer: string;
  toolCalls: RunReceipt[];
  iterations: number;
  truncated: boolean;
  timedOut: boolean;
  auditTrail: string[];
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function StarRow({ avg, size = "size-3" }: { avg: number; size?: string }) {
  const filled = Math.round(avg);
  return (
    <span className="flex items-center gap-0.5" aria-label={`Rated ${avg} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={`${size} ${
            i <= filled ? "fill-amber-400 text-amber-400" : "text-zinc-700"
          }`}
          aria-hidden
        />
      ))}
    </span>
  );
}

function ChecksumChip({ checksum }: { checksum: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help font-mono text-[10px] text-zinc-600 hover:text-zinc-400">
          sha256 {checksum.slice(0, 10)}…
        </span>
      </TooltipTrigger>
      <TooltipContent className="border-zinc-700 bg-zinc-900 text-xs text-zinc-200">
        <p className="mb-1 font-medium text-zinc-300">Manifest checksum (integrity anchor)</p>
        <p className="max-w-xs break-all font-mono text-[10px] text-zinc-400">{checksum}</p>
        <p className="mt-1 max-w-xs text-[10px] text-zinc-500">
          sha256 of the canonical JSON — recompute it to verify the stored manifest was not tampered with.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

/** The honest security banner — shown above the grid, always. */
function SecurityBanner() {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3">
      <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-400" aria-hidden />
      <div className="space-y-0.5">
        <p className="text-xs font-medium text-amber-300">
          Skills run in a constrained sandbox: tool allowlist ∩ manifest permissions, call/time
          budgets, full audit. Checksummed manifests; unsigned skills are marked.
        </p>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          A manifest is pure JSON — there is no skill code to execute. Every tool call is checked
          against the manifest permissions AND the agent registry, truncated, budgeted and written
          to the audit log; target-scoped tools require a target owned by you.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function SkillsView() {
  const [skills, setSkills] = React.useState<SkillRow[] | null>(null);
  const [loading, setLoading] = React.useState(true);

  const fetchSkills = React.useCallback(async () => {
    try {
      const res = await apiGet<{ skills: SkillRow[] }>("/api/skills");
      setSkills(res.skills);
    } catch (err) {
      toastError(err, "Could not load skills");
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    setLoading(true);
    void fetchSkills();
  }, [fetchSkills]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-zinc-100">
            <Puzzle className="size-5 text-emerald-400" aria-hidden />
            Skills marketplace
          </h2>
          <p className="text-sm text-zinc-500">
            Community playbooks for the agent — checksummed manifests, declared tool permissions,
            sandboxed runs. {loading ? "" : `${skills?.length ?? 0} published.`}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setLoading(true);
            void fetchSkills();
          }}
          className="shrink-0 gap-1.5 border-zinc-700 text-zinc-400 hover:text-zinc-200"
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden />
          Refresh
        </Button>
      </div>

      <SecurityBanner />

      {loading && !skills ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 w-full bg-zinc-800/50" />
          ))}
        </div>
      ) : (skills?.length ?? 0) === 0 ? (
        <EmptyState
          icon={Puzzle}
          title="No skills published yet"
          description="Publish a rea-skill manifest v1 via POST /api/skills, or seed the bundled playbooks with `bun run skills:seed`."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(skills ?? []).map((s) => (
            <SkillCard key={s.id} skill={s} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function SkillCard({ skill }: { skill: SkillRow }) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Card
        className="group border-zinc-800 bg-zinc-900/60 transition hover:border-emerald-500/30"
        role="button"
        tabIndex={0}
        aria-label={`Open skill ${skill.name}`}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <CardContent className="flex h-full flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="flex items-center gap-2 truncate text-sm font-semibold text-zinc-100">
                <Puzzle className="size-3.5 shrink-0 text-emerald-400" aria-hidden />
                {skill.name}
              </p>
              <p className="mt-0.5 font-mono text-[10px] text-zinc-600">
                {skill.slug} · v{skill.version} · {shortAuthor(skill.author)}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
              {skill.bundled && (
                <Badge className="border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0 text-[9px] uppercase tracking-widest text-emerald-300">
                  <Package className="mr-1 size-2.5" aria-hidden />
                  bundled
                </Badge>
              )}
              {!skill.signed && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="outline"
                      className="border-zinc-700 px-1.5 py-0 text-[9px] uppercase tracking-widest text-zinc-500"
                    >
                      unsigned
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent className="border-zinc-700 bg-zinc-900 text-xs text-zinc-200">
                    No platform signature — the sandbox still applies in full (allowlist ∩
                    permissions, budgets, audit).
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          </div>

          <p className="line-clamp-3 text-xs leading-relaxed text-zinc-400">{skill.description}</p>

          <div className="mt-auto flex items-center justify-between gap-2 border-t border-zinc-800/70 pt-2.5">
            <div className="flex items-center gap-2">
              <StarRow avg={skill.rating.avg} />
              <span className="font-mono text-[10px] text-zinc-500">
                {skill.rating.count > 0 ? skill.rating.avg.toFixed(1) : "—"}
                {skill.rating.count > 0 ? ` (${skill.rating.count})` : ""}
              </span>
            </div>
            <div className="flex items-center gap-2 text-zinc-500">
              <span className="flex items-center gap-1 font-mono text-[10px]">
                <Download className="size-3" aria-hidden />
                {skill.installs}
              </span>
              <ChecksumChip checksum={skill.checksum} />
            </div>
          </div>
        </CardContent>
      </Card>
      {open && <SkillDetailDialog skill={skill} onClose={() => setOpen(false)} />}
    </>
  );
}

function shortAuthor(author: string): string {
  if (author === "rea-system") return author;
  return author.length > 12 ? `${author.slice(0, 9)}…` : author;
}

// ---------------------------------------------------------------------------
// Detail dialog
// ---------------------------------------------------------------------------

function SkillDetailDialog({ skill, onClose }: { skill: SkillRow; onClose: () => void }) {
  const [detail, setDetail] = React.useState<SkillDetailRow | null>(null);
  const [tab, setTab] = React.useState<"manifest" | "ratings" | "run">("manifest");

  React.useEffect(() => {
    let cancelled = false;
    apiGet<{ skill: SkillDetailRow }>(`/api/skills/${encodeURIComponent(skill.slug)}`)
      .then((res) => {
        if (!cancelled) setDetail(res.skill);
      })
      .catch((err) => toastError(err, "Could not load skill detail"));
    return () => {
      cancelled = true;
    };
  }, [skill.slug]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="grid max-h-[85vh] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden border-zinc-800 bg-zinc-950 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-zinc-800 px-6 py-4">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base text-zinc-100">
            <Puzzle className="size-4 text-emerald-400" aria-hidden />
            {skill.name}
            <span className="font-mono text-xs text-zinc-500">v{skill.version}</span>
            {skill.bundled && <BundledBadge />}
            {!skill.signed && <UnsignedBadge />}
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            {skill.slug} · by {skill.author} · installed {skill.installs}× ·{" "}
            {detail?.manifest.limits
              ? `limits: ${detail.manifest.limits.toolCalls} tool calls, ${Math.round(
                  detail.manifest.limits.timeoutMs / 1000
                )}s`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-col">
          <div className="flex shrink-0 gap-1 border-b border-zinc-800 px-6 pt-2">
            {(["manifest", "ratings", "run"] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`-mb-px border-b-2 px-3 py-2 text-xs font-medium capitalize transition ${
                  tab === t
                    ? "border-emerald-400 text-emerald-300"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {t === "manifest" ? "Manifest" : t === "ratings" ? `Ratings${detail ? ` (${detail.rating.count})` : ""}` : "Run skill"}
              </button>
            ))}
          </div>

          <div className="rea-scroll min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {!detail ? (
              <div className="space-y-3">
                <Skeleton className="h-16 w-full bg-zinc-800/50" />
                <Skeleton className="h-32 w-full bg-zinc-800/40" />
              </div>
            ) : tab === "manifest" ? (
              <ManifestTab detail={detail} />
            ) : tab === "ratings" ? (
              <RatingsTab detail={detail} />
            ) : (
              <RunTab slug={skill.slug} />
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-zinc-800 px-6 py-3">
            <ChecksumChip checksum={skill.checksum} />
            <div className="flex items-center gap-2">
              <InstallButton slug={skill.slug} />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onClose}
                className="border-zinc-700 text-zinc-400 hover:text-zinc-200"
              >
                Close
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BundledBadge() {
  return (
    <Badge className="border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0 text-[9px] uppercase tracking-widest text-emerald-300">
      <Package className="mr-1 size-2.5" aria-hidden />
      bundled
    </Badge>
  );
}

function UnsignedBadge() {
  return (
    <Badge
      variant="outline"
      className="border-zinc-700 px-1.5 py-0 text-[9px] uppercase tracking-widest text-zinc-500"
    >
      unsigned
    </Badge>
  );
}

function ManifestTab({ detail }: { detail: SkillDetailRow }) {
  const m = detail.manifest;
  return (
    <div className="space-y-4">
      {m.entry.opening && (
        <div className="rounded-md border-l-2 border-emerald-500/50 bg-emerald-500/5 px-3 py-2">
          <p className="text-[10px] uppercase tracking-widest text-emerald-400">Opening line</p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-300">{m.entry.opening}</p>
        </div>
      )}

      <div>
        <p className="text-[10px] uppercase tracking-widest text-zinc-500">Permissions</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {m.permissions.length === 0 ? (
            <span className="text-xs text-zinc-600">
              (none — the skill answers without tools)
            </span>
          ) : (
            m.permissions.map((p) => (
              <Badge
                key={p}
                variant="outline"
                className="border-zinc-700 bg-zinc-900 px-2 py-0.5 font-mono text-[10px] text-zinc-300"
              >
                {p}
              </Badge>
            ))
          )}
        </div>
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-widest text-zinc-500">Limits</p>
        <div className="mt-1.5 grid grid-cols-3 gap-2 font-mono text-[11px] text-zinc-400">
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5">
            <span className="text-zinc-600">toolCalls</span> {m.limits.toolCalls}
          </div>
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5">
            <span className="text-zinc-600">workspace</span> {m.limits.workspaceBytes} B
          </div>
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1.5">
            <span className="text-zinc-600">timeout</span> {Math.round(m.limits.timeoutMs / 1000)}s
          </div>
        </div>
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-widest text-zinc-500">
          entry.system — the skill&apos;s prompt (read-only)
        </p>
        <pre className="rea-scroll mt-1.5 max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-900/60 p-3 font-mono text-[11px] leading-relaxed text-zinc-400">
          {m.entry.system}
        </pre>
      </div>
    </div>
  );
}

function RatingsTab({ detail }: { detail: SkillDetailRow }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-2xl font-semibold text-zinc-100">
          {detail.rating.count > 0 ? detail.rating.avg.toFixed(1) : "—"}
        </span>
        <div className="space-y-0.5">
          <StarRow avg={detail.rating.avg} size="size-3.5" />
          <p className="font-mono text-[10px] text-zinc-500">
            {detail.rating.sum} / 5 · {detail.rating.count} rating{detail.rating.count === 1 ? "" : "s"}
          </p>
        </div>
      </div>
      {detail.ratings.length === 0 ? (
        <p className="text-xs text-zinc-600">
          No written ratings yet — rate the skill from the footer stars.
        </p>
      ) : (
        <div className="divide-y divide-zinc-800/70 rounded-md border border-zinc-800">
          {detail.ratings.map((r, i) => (
            <div key={i} className="px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <StarRow avg={r.score} />
                <span className="font-mono text-[10px] text-zinc-600">{timeAgo(r.createdAt)}</span>
              </div>
              {r.comment && (
                <p className="mt-1 text-xs leading-relaxed break-words text-zinc-400">{r.comment}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function InstallButton({ slug }: { slug: string }) {
  const [busy, setBusy] = React.useState(false);
  const install = async () => {
    setBusy(true);
    try {
      const res = await apiPost<{ installed: boolean; installs: number }>(
        `/api/skills/${encodeURIComponent(slug)}`,
        { action: "install" }
      );
      toast({
        title: res.installed ? "Skill installed" : "Already installed",
        description: res.installed
          ? `${slug} is now in your account (${res.installs} total installs).`
          : `You already installed ${slug} (${res.installs} total).`,
      });
    } catch (err) {
      toastError(err, "Could not install skill");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      type="button"
      size="sm"
      disabled={busy}
      onClick={() => void install()}
      className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-500"
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Download className="size-3.5" aria-hidden />}
      Install
    </Button>
  );
}

export function RateControls({
  slug,
  onRated,
}: {
  slug: string;
  onRated?: () => void;
}) {
  const [score, setScore] = React.useState(0);
  const [comment, setComment] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    if (score < 1) {
      toastError(new Error("Pick 1-5 stars first"), "Rating not submitted");
      return;
    }
    setBusy(true);
    try {
      const res = await apiPost<{ avg: number; ratingCount: number }>(
        `/api/skills/${encodeURIComponent(slug)}`,
        { action: "rate", score, comment: comment.trim() || undefined }
      );
      toast({
        title: "Rating saved",
        description: `${slug} is now rated ${res.avg.toFixed(1)} from ${res.ratingCount} rating(s).`,
      });
      setComment("");
      onRated?.();
    } catch (err) {
      toastError(err, "Could not save rating");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
      <p className="text-[10px] uppercase tracking-widest text-zinc-500">Rate this skill</p>
      <div className="flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((i) => (
          <button
            key={i}
            type="button"
            aria-label={`Rate ${i} star${i > 1 ? "s" : ""}`}
            onClick={() => setScore(i)}
            className="rounded p-0.5 transition hover:scale-110"
          >
            <Star
              className={`size-4 ${i <= score ? "fill-amber-400 text-amber-400" : "text-zinc-700"}`}
              aria-hidden
            />
          </button>
        ))}
      </div>
      <Input
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Optional comment (what worked, what didn't)"
        className="h-8 border-zinc-800 bg-zinc-950 text-xs text-zinc-300 placeholder:text-zinc-600"
        maxLength={1000}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={busy || score < 1}
        onClick={() => void submit()}
        className="gap-1.5 border-zinc-700 text-xs text-zinc-300"
      >
        {busy && <Loader2 className="size-3 animate-spin" aria-hidden />}
        Submit rating
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run tab — the sandbox transcript
// ---------------------------------------------------------------------------

function RunTab({ slug }: { slug: string }) {
  const [question, setQuestion] = React.useState("");
  const [targetId, setTargetId] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [run, setRun] = React.useState<RunTranscript | null>(null);

  const doRun = async () => {
    if (!question.trim()) return;
    setRunning(true);
    setRun(null);
    try {
      const res = await apiPost<{ run: RunTranscript }>(
        `/api/skills/${encodeURIComponent(slug)}`,
        {
          action: "run",
          question: question.trim(),
          ...(targetId.trim() ? { targetId: targetId.trim() } : {}),
        }
      );
      setRun(res.run);
    } catch (err) {
      toastError(err, "Skill run failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Question or task for the skill — e.g. 'Triage this .NET sample: what are the IOCs?'"
          className="min-h-20 resize-y border-zinc-800 bg-zinc-950 text-xs text-zinc-300 placeholder:text-zinc-600"
          maxLength={4000}
        />
        <Input
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          placeholder="Optional target id (enables target-scoped tools like read_strings — ownership enforced)"
          className="h-8 border-zinc-800 bg-zinc-950 font-mono text-[11px] text-zinc-300 placeholder:text-zinc-600"
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-zinc-600">
            The run is bounded by the manifest limits and audited end-to-end.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={running || !question.trim()}
            onClick={() => void doRun()}
            className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-500"
          >
            {running ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Play className="size-3.5" aria-hidden />
            )}
            {running ? "Running…" : "Run skill"}
          </Button>
        </div>
      </div>

      {running && (
        <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
          <Skeleton className="h-4 w-2/3 bg-zinc-800/70" />
          <Skeleton className="h-4 w-1/2 bg-zinc-800/70" />
          <Skeleton className="h-16 w-full bg-zinc-800/40" />
        </div>
      )}

      {run && (
        <div className="space-y-3">
          <div className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3">
            <p className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-zinc-500">
              <Eye className="size-3" aria-hidden />
              Answer · {run.version} · {run.iterations} model turn(s)
              {run.truncated && <span className="text-amber-400">· truncated</span>}
              {run.timedOut && <span className="text-amber-400">· timed out</span>}
            </p>
            <pre className="rea-scroll mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-zinc-200">
              {run.answer}
            </pre>
          </div>

          <div>
            <p className="text-[10px] uppercase tracking-widest text-zinc-500">
              Tool receipts ({run.toolCalls.length})
            </p>
            {run.toolCalls.length === 0 ? (
              <p className="mt-1 text-xs text-zinc-600">
                No tool calls — the skill answered directly.
              </p>
            ) : (
              <div className="rea-scroll mt-1.5 max-h-56 space-y-1.5 overflow-y-auto">
                {run.toolCalls.map((c, i) => (
                  <div
                    key={i}
                    className={`rounded-md border px-2.5 py-1.5 font-mono text-[10px] ${
                      c.refused
                        ? "border-amber-500/30 bg-amber-500/5 text-amber-300/90"
                        : c.ok
                          ? "border-zinc-800 bg-zinc-900/60 text-zinc-400"
                          : "border-rose-500/30 bg-rose-500/5 text-rose-300/90"
                    }`}
                  >
                    <span className="text-zinc-200">{c.tool}</span>
                    <span className="text-zinc-600">
                      {" "}
                      · {c.ms}ms · {c.chars} chars{c.refused ? " · refused" : c.ok ? "" : " · error"}
                    </span>
                    <span className="mt-0.5 block break-all text-zinc-500">
                      args: {JSON.stringify(c.args).slice(0, 160)}
                    </span>
                    {c.error && (
                      <span className="mt-0.5 block break-words text-amber-400/80">
                        {c.error.slice(0, 220)}
                      </span>
                    )}
                    {!c.error && c.result && (
                      <span className="mt-0.5 block max-h-16 overflow-hidden break-words whitespace-pre-wrap text-zinc-600">
                        {c.result.slice(0, 240)}
                        {c.chars > 240 ? "…" : ""}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <details className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2">
            <summary className="cursor-pointer text-[10px] uppercase tracking-widest text-zinc-500">
              Audit trail ({run.auditTrail.length} entries)
            </summary>
            <pre className="rea-scroll mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-zinc-500">
              {run.auditTrail.join("\n")}
            </pre>
          </details>

          <RateControls slug={slug} />
        </div>
      )}
    </div>
  );
}

// Re-export so the run transcript can deep-link from elsewhere if needed.
export type { RunTranscript, SkillRow };
