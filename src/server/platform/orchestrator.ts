import { db } from "@/lib/db";
import { audit } from "@/lib/security";
import { zaiPlatformChat } from "@/server/agent/platform-llm";
import { crawlSite } from "./explorer";
import { reverseEngineerWorkspace } from "./recon";
import { runResearch, analyzeGitHubRepo, parseGitHubRef } from "./research";
import {
  materializeGitHubRepo, materializeTarget, writeFile, runCommand, workspaceStatus, ensureWorkspace,
} from "./builder";
import { runVerification, runCloneVerification } from "./verifier";
import { cloneDockerize, cloneDecompile, cloneRebuild } from "./clone";
import { tryBrowser } from "./browser";

/**
 * Agent Orchestration Engine.
 *
 * Runs the full platform pipeline as a persisted DAG:
 *   DISCOVER → COLLECT EVIDENCE → UNDERSTAND → MAP ARCHITECTURE →
 *   RESEARCH → PLAN → BUILD → TEST → VERIFY
 *
 * Properties (all real, all persisted):
 *  - topological waves; independent steps run in parallel
 *  - per-step retries with backoff, per-step timeouts
 *  - checkpoints: every step's output is JSON-persisted before the next wave
 *  - human approval gates on PLAN and BUILD (the runner parks the pipeline)
 *  - cancellation is checked between waves
 *  - shared context accumulates step outputs for later stages
 *  - honest failures: a step that cannot run (no browser, no model, 404 site)
 *    fails with the exact reason — nothing is simulated
 */

export type Stage =
  | "discover" | "collect" | "understand" | "map" | "research"
  | "plan" | "build" | "clone" | "test" | "verify";

const APPROVAL_STAGES = new Set<Stage>(["plan", "build"]);
const CONTEXT_LIMIT = 150_000; // chars

interface StepTemplate {
  stage: Stage;
  name: string;
  dependsOn: string[];
  timeoutMs: number;
  maxAttempts?: number;
  /** Optional steps record their error but mark "skipped" — the pipeline continues. */
  optional?: boolean;
}

interface Ctx {
  [k: string]: unknown;
}

function websitePipeline(): StepTemplate[] {
  return [
    { stage: "discover", name: "discover:probe", dependsOn: [], timeoutMs: 40_000 },
    { stage: "collect", name: "collect:crawl", dependsOn: ["discover:probe"], timeoutMs: 150_000 },
    { stage: "understand", name: "understand:stack", dependsOn: ["collect:crawl"], timeoutMs: 90_000 },
    { stage: "map", name: "map:navigation", dependsOn: ["collect:crawl"], timeoutMs: 60_000 },
    { stage: "research", name: "research:web", dependsOn: ["discover:probe"], timeoutMs: 120_000 },
    { stage: "plan", name: "plan:reconstruction", dependsOn: ["understand:stack", "map:navigation", "research:web"], timeoutMs: 120_000 },
    { stage: "build", name: "build:scaffold", dependsOn: ["plan:reconstruction"], timeoutMs: 90_000 },
    { stage: "clone", name: "clone:dockerize", dependsOn: ["build:scaffold"], timeoutMs: 300_000, optional: true },
    { stage: "test", name: "test:functional", dependsOn: ["build:scaffold"], timeoutMs: 150_000 },
    { stage: "verify", name: "verify:report", dependsOn: ["test:functional"], timeoutMs: 120_000 },
  ];
}

function githubPipeline(): StepTemplate[] {
  return [
    // discover:repo uses the GitHub REST API which is rate-limited
    // unauthenticated — it is OPTIONAL evidence. The tarball materialization
    // goes through codeload.github.com and works without the API.
    { stage: "discover", name: "discover:repo", dependsOn: [], timeoutMs: 60_000, optional: true },
    { stage: "collect", name: "collect:materialize", dependsOn: [], timeoutMs: 180_000 },
    { stage: "understand", name: "understand:parse", dependsOn: ["collect:materialize"], timeoutMs: 180_000 },
    { stage: "map", name: "map:architecture", dependsOn: ["understand:parse"], timeoutMs: 60_000 },
    { stage: "research", name: "research:web", dependsOn: [], timeoutMs: 120_000 },
    { stage: "plan", name: "plan:reconstruction", dependsOn: ["understand:parse", "map:architecture", "research:web"], timeoutMs: 120_000 },
    { stage: "build", name: "build:scaffold", dependsOn: ["plan:reconstruction"], timeoutMs: 90_000 },
    { stage: "clone", name: "clone:dockerize", dependsOn: ["build:scaffold"], timeoutMs: 300_000, optional: true },
    { stage: "test", name: "test:workspace", dependsOn: ["build:scaffold"], timeoutMs: 120_000 },
    { stage: "verify", name: "verify:report", dependsOn: ["test:workspace"], timeoutMs: 120_000 },
  ];
}

function filePipeline(): StepTemplate[] {
  return [
    { stage: "discover", name: "discover:target", dependsOn: [], timeoutMs: 60_000 },
    { stage: "collect", name: "collect:materialize", dependsOn: ["discover:target"], timeoutMs: 90_000 },
    { stage: "understand", name: "understand:parse", dependsOn: ["collect:materialize"], timeoutMs: 180_000 },
    { stage: "map", name: "map:architecture", dependsOn: ["understand:parse"], timeoutMs: 60_000 },
    { stage: "plan", name: "plan:analysis", dependsOn: ["understand:parse", "map:architecture"], timeoutMs: 120_000 },
    { stage: "clone", name: "clone:decompile", dependsOn: ["collect:materialize"], timeoutMs: 540_000, optional: true },
    { stage: "clone", name: "clone:rebuild", dependsOn: ["clone:decompile"], timeoutMs: 180_000, optional: true },
    { stage: "test", name: "test:workspace", dependsOn: ["collect:materialize"], timeoutMs: 120_000 },
    { stage: "verify", name: "verify:report", dependsOn: ["plan:analysis", "test:workspace"], timeoutMs: 120_000 },
  ];
}

// --- Context helpers --------------------------------------------------------

function readContext(json: string | null): Ctx {
  if (!json) return {};
  try {
    return JSON.parse(json) as Ctx;
  } catch {
    return {};
  }
}

function digest(ctx: Ctx, keys: string[]): string {
  const parts: string[] = [];
  for (const k of keys) {
    if (ctx[k] === undefined) continue;
    parts.push(`## ${k}\n${typeof ctx[k] === "string" ? (ctx[k] as string).slice(0, 6_000) : JSON.stringify(ctx[k]).slice(0, 6_000)}`);
  }
  return parts.join("\n\n").slice(0, 40_000) || "(no prior evidence)";
}

// --- Step executors ---------------------------------------------------------

async function execStep(
  projectId: string,
  stepName: string,
  ctx: Ctx,
  project: { kind: string; reference: string; name: string },
  goal: string
): Promise<unknown> {
  switch (stepName) {
    // ---------------- WEBSITE ----------------
    case "discover:probe": {
      const { safeFetch } = await import("./net");
      const res = await safeFetch(project.reference, { maxBytes: 512 * 1024 });
      return {
        finalUrl: res.url,
        status: res.status,
        contentType: res.contentType,
        ms: res.ms,
        server: res.headers["server"] ?? null,
        poweredBy: res.headers["x-powered-by"] ?? null,
      };
    }
    case "collect:crawl": {
      const summary = await crawlSite(projectId, project.reference, { maxPages: 15, maxDepth: 2, concurrency: 3 });
      return summary;
    }
    case "understand:stack": {
      const pages = await db.crawlPage.findMany({ where: { projectId }, take: 100 });
      const tech = new Map<string, number>();
      for (const p of pages) {
        let arr: string[] = [];
        try {
          arr = p.tech ? JSON.parse(p.tech) : [];
        } catch { /* none */ }
        for (const t of arr) tech.set(t, (tech.get(t) ?? 0) + 1);
      }
      const ranked = [...tech.entries()].sort((a, b) => b[1] - a[1]);
      let narrative = "";
      try {
        narrative = await zaiPlatformChat([
          { role: "system", content: "You analyze observed web evidence. Be factual; cite only what is listed. Max 120 words." },
          { role: "user", content: `Observed technology fingerprints for ${project.reference}:\n${ranked.map(([t, c]) => `${t} (on ${c} pages)`).join(", ")}\n\nSite goal: ${goal}\nWrite a short factual stack assessment.` },
        ]);
      } catch (err) {
        narrative = `LLM narrative unavailable (${err instanceof Error ? err.message.slice(0, 120) : "error"}); deterministic fingerprint ranking follows.`;
      }
      return {
        pagesCrawled: pages.filter((p) => p.status > 0).length,
        techRanking: ranked.slice(0, 20).map(([name, count]) => ({ name, count })),
        narrative,
      };
    }
    case "map:navigation": {
      const pages = await db.crawlPage.findMany({ where: { projectId }, orderBy: { depth: "asc" }, take: 60 });
      const edges = await db.graphEdge.count({ where: { projectId, kind: "links-to" } });
      return {
        pages: pages.map((p) => ({ url: p.url, title: p.title, depth: p.depth, status: p.status })),
        internalLinkEdges: edges,
        entryPoint: pages.find((p) => p.depth === 0)?.url ?? project.reference,
      };
    }
    case "research:web": {
      const r = await runResearch(projectId, goal.slice(0, 300));
      return { summary: r.summary, sourceCount: r.sources.length, topSources: r.sources.slice(0, 8).map((s) => ({ title: s.title, url: s.url })) };
    }
    case "plan:reconstruction": {
      const context = digest(ctx, ["discover:probe", "understand:stack", "map:navigation", "research:web", "discover:repo", "understand:parse", "map:architecture"]);
      try {
        const plan = await zaiPlatformChat([
          { role: "system", content: "You are the REA planning agent. Produce an implementation plan for reconstructing the target's MAIN FUNCTIONALITY from public evidence only. Markdown, sections: ## Scope, ## Architecture (observed vs assumed), ## Steps (numbered, each independently verifiable), ## Test plan, ## Honest gaps (what public evidence cannot tell us). Mark every assumption explicitly. Max 400 words." },
          { role: "user", content: `GOAL: ${goal}\n\nEVIDENCE:\n${context}` },
        ]);
        return { plan, model: "platform" };
      } catch (err) {
        return {
          plan: null,
          error: `planning model unavailable: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
          fallbackPlan: `# Deterministic fallback plan\n1. Catalog all collected evidence\n2. Identify the core user flows mentioned in the goal\n3. Scaffold a minimal reconstruction in the workspace\n4. Test every check the verifier supports\n5. Report unknowns honestly`,
        };
      }
    }
    case "build:scaffold": {
      await ensureWorkspace(projectId);
      const ctxPlan = (ctx["plan:reconstruction"] ?? {}) as { plan?: string | null; fallbackPlan?: string };
      const planText = ctxPlan.plan ?? ctxPlan.fallbackPlan ?? "(no plan)";
      const pages = await db.crawlPage.findMany({ where: { projectId }, take: 30, orderBy: { depth: "asc" } });
      const nav = pages.map((p) => `<li><a href="${escapeHtml(p.url)}">${escapeHtml(p.title ?? p.url)}</a></li>`).join("");
      const files: Array<{ path: string; content: string }> = [
        {
          path: "REA-PLAN.md",
          content: `# REA Reconstruction Plan\n\n${planText}\n\n> Generated from observed evidence. Assumptions are marked in the plan; anything unverifiable from public sources is listed under Honest gaps.`,
        },
        {
          path: "scaffold/index.html",
          content: `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${escapeHtml(project.name)} — REA reconstruction scaffold</title>\n</head>\n<body>\n<h1>${escapeHtml(project.name)}</h1>\n<p>Reconstruction scaffold generated by REA from public evidence. This is a starting point for the implementation plan, not a claim of completed reconstruction.</p>\n<h2>Observed site map</h2>\n<ul>\n${nav}\n</ul>\n</body>\n</html>\n`,
        },
        {
          path: "scaffold/evidence.json",
          content: JSON.stringify({ goal, reference: project.reference, pages: pages.map((p) => ({ url: p.url, title: p.title, status: p.status, depth: p.depth })) }, null, 2).slice(0, 40_000),
        },
      ];
      const written: Array<{ path: string; bytes: number }> = [];
      for (const f of files) {
        const r = await writeFile(projectId, f.path, f.content);
        written.push({ path: r.path, bytes: r.bytes });
      }
      return { written };
    }
    case "clone:dockerize": {
      return cloneDockerize(projectId, { name: project.name, reference: project.reference }, goal);
    }
    case "clone:decompile": {
      return cloneDecompile(projectId);
    }
    case "clone:rebuild": {
      return cloneRebuild(projectId);
    }
    case "test:functional": {
      const ctxProbe = (ctx["discover:probe"] ?? {}) as { finalUrl?: string };
      const url = ctxProbe.finalUrl ?? project.reference;
      const v = await runVerification(projectId, url);
      return { score: v.score, checks: v.checks, browserAvailable: v.browserAvailable, regression: v.regression };
    }
    case "verify:report": {
      // Unified final report across pipeline kinds: score only when a
      // deployable URL actually got verified.
      const context = digest(ctx, [
        "collect:crawl", "understand:stack", "understand:parse", "map:architecture",
        "plan:reconstruction", "plan:analysis", "build:scaffold",
        "clone:dockerize", "clone:decompile", "clone:rebuild",
        "test:functional", "test:workspace", "discover:repo",
      ]);
      let verificationScore: number | null = null;
      if (project.kind === "website") {
        verificationScore = ((ctx["test:functional"] ?? null) as { score?: number } | null)?.score ?? null;
      } else if (project.kind === "github") {
        const repo = (ctx["discover:repo"] ?? {}) as { homepage?: string };
        if (repo.homepage && /^https?:\/\//.test(repo.homepage)) {
          try {
            const v = await runVerification(projectId, repo.homepage);
            verificationScore = v.score;
          } catch {
            verificationScore = null;
          }
        }
      }
      // Clone equivalence: when the CLONE stage actually booted the clone,
      // the final score becomes the BEHAVIORAL EQUIVALENCE between the
      // original and the clone — a stronger claim than either side alone.
      const cloneOut = (ctx["clone:dockerize"] ?? null) as { boot?: { url?: string | null } } | null;
      const cloneBootUrl = cloneOut?.boot?.url ?? null;
      if (cloneBootUrl) {
        const originalUrl =
          project.kind === "website"
            ? ((ctx["discover:probe"] ?? {}) as { finalUrl?: string }).finalUrl ?? project.reference
            : ((ctx["discover:repo"] ?? {}) as { homepage?: string }).homepage ?? null;
        if (originalUrl && /^https?:\/\//.test(originalUrl)) {
          try {
            const eq = await runCloneVerification(projectId, { originalUrl, cloneUrl: cloneBootUrl });
            verificationScore = eq.score;
          } catch {
            // an equivalence-check failure must not erase the functional score
          }
        }
      }
      let report: string;
      try {
        report = await zaiPlatformChat([
          { role: "system", content: "You are the REA verification reporter. Markdown: ## What works (verified), ## What failed or is unverified, ## What remains incomplete, ## Next steps. Only claim what the evidence shows. If a verification score exists include it. Max 250 words." },
          { role: "user", content: `GOAL: ${goal}\n\nPIPELINE EVIDENCE:\n${context}\n\nVerification score: ${verificationScore ?? "n/a (no deployable URL)"}` },
        ]);
      } catch (err) {
        report = `> LLM report unavailable (${err instanceof Error ? err.message.slice(0, 120) : "error"}). Deterministic result: verification score ${verificationScore ?? "n/a"}. All step outputs are in the orchestration context.`;
      }
      return { report, verificationScore };
    }

    // ---------------- GITHUB ----------------
    case "discover:repo": {
      const ref = parseGitHubRef(project.reference);
      if (!ref) throw new Error(`invalid GitHub reference: ${project.reference}`);
      const { analysis, sources } = await analyzeGitHubRepo(project.reference);
      if (!analysis) throw new Error(sources[0]?.title ?? "GitHub API failed");
      return analysis;
    }
    case "collect:materialize": {
      if (project.kind === "github") {
        const ref = parseGitHubRef(project.reference)!;
        const m = await materializeGitHubRepo(projectId, ref.owner, ref.repo);
        if (!m.ok) throw new Error(m.detail);
        return m;
      }
      // file project: reference = targets/<id>
      const targetId = project.reference.replace(/^targets\//, "");
      const m = await materializeTarget(projectId, targetId);
      if (!m.ok) throw new Error(m.detail);
      return m;
    }
    case "understand:parse": {
      const summary = await reverseEngineerWorkspace(projectId, await import("./builder").then((m) => m.workspaceDir(projectId)));
      return { ...summary, secretCandidates: summary.secretCandidates.slice(0, 20) };
    }
    case "map:architecture": {
      const [nodes, edges] = await Promise.all([
        db.graphNode.groupBy({ by: ["kind"], where: { projectId }, _count: { kind: true } }),
        db.graphEdge.groupBy({ by: ["kind"], where: { projectId }, _count: { kind: true } }),
      ]);
      const topFiles = await db.graphNode.findMany({
        where: { projectId, kind: "component" },
        orderBy: { updatedAt: "desc" },
        take: 25,
      });
      return {
        nodeKinds: nodes.map((n) => ({ kind: n.kind, count: n._count.kind })),
        edgeKinds: edges.map((e) => ({ kind: e.kind, count: e._count.kind })),
        keyFiles: topFiles.map((f) => f.label),
      };
    }
    case "plan:analysis": {
      const context = digest(ctx, ["discover:target", "understand:parse", "map:architecture"]);
      try {
        const plan = await zaiPlatformChat([
          { role: "system", content: "You are the REA planning agent. Produce an analysis plan for a binary/file target from the evidence. Markdown sections: ## Observed structure, ## Analysis steps, ## Expected findings, ## Unknowns. Max 300 words." },
          { role: "user", content: `GOAL: ${goal}\n\nEVIDENCE:\n${context}` },
        ]);
        return { plan, model: "platform" };
      } catch (err) {
        return { plan: null, error: `planning model unavailable: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}` };
      }
    }
    case "test:workspace": {
      const status = await workspaceStatus(projectId);
      const ls = await runCommand(projectId, "ls -la", 15_000);
      const nodeV = await runCommand(projectId, "node --version", 15_000);
      return {
        workspace: { fileCount: status.fileCount, hasManifest: status.hasManifest, manifestKind: status.manifestKind },
        terminal: { lsExit: ls.exitCode, lsHead: ls.stdout.slice(0, 800), nodeVersion: nodeV.stdout.trim() || null },
      };
    }
    default:
      throw new Error(`no executor for step ${stepName}`);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- Runner ------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`step timed out after ${Math.round(ms / 1000)}s`)), ms)
    ),
  ]);
}

export async function createOrchestration(
  projectId: string,
  userId: string,
  goal: string
): Promise<{ ok: boolean; orchestrationId?: string; error?: string }> {
  const project = await db.project.findFirst({ where: { id: projectId, userId } });
  if (!project) return { ok: false, error: "project not found" };
  const active = await db.orchestration.findFirst({
    where: { projectId, status: { in: ["running", "awaiting_approval"] } },
  });
  if (active) return { ok: false, error: `an orchestration is already ${active.status} for this project (id ${active.id})` };

  const templates =
    project.kind === "website" ? websitePipeline() :
    project.kind === "github" ? githubPipeline() : filePipeline();

  const orchestration = await db.orchestration.create({
    data: {
      projectId,
      goal: goal.slice(0, 2_000),
      status: "running",
      context: JSON.stringify({}),
      steps: {
        create: templates.map((t) => ({
          stage: t.stage,
          name: t.name,
          maxAttempts: t.maxAttempts ?? 2,
          dependsOn: JSON.stringify(t.dependsOn),
          checkpoint: JSON.stringify({ optional: t.optional ?? false }),
        })),
      },
    },
    include: { steps: true },
  });

  await audit("orchestration.create", {
    userId,
    detail: `${project.kind} pipeline (${templates.length} steps) for ${project.name}`,
  });

  // Fire-and-forget runner: the API returns immediately; progress is persisted.
  void runOrchestration(orchestration.id).catch(() => undefined);
  return { ok: true, orchestrationId: orchestration.id };
}

export async function runOrchestration(orchestrationId: string): Promise<void> {
  const orch = await db.orchestration.findUnique({ where: { id: orchestrationId }, include: { steps: true, project: true } });
  if (!orch) return;
  if (orch.status !== "running") return;

  const project = { kind: orch.project.kind, reference: orch.project.reference, name: orch.project.name };
  const ctx = readContext(orch.context);

  for (;;) {
    // Cancellation checkpoint.
    const fresh = await db.orchestration.findUnique({ where: { id: orchestrationId } });
    if (!fresh || fresh.status === "cancelled") {
      await db.orchestrationStep.updateMany({
        where: { orchestrationId, status: { in: ["pending", "awaiting_approval"] } },
        data: { status: "cancelled", finishedAt: new Date() },
      });
      await db.orchestration.update({
        where: { id: orchestrationId },
        data: { status: "cancelled", finishedAt: new Date(), currentStage: null },
      });
      return;
    }

    const steps = await db.orchestrationStep.findMany({ where: { orchestrationId } });
    const done = new Set(steps.filter((s) => s.status === "done").map((s) => s.name));
    const runnable = steps.filter((s) => {
      if (s.status !== "pending") return false;
      const deps = safeParseArr(s.dependsOn);
      return deps.every((d) => done.has(d));
    });

    if (runnable.length === 0) {
      const busyLeft = steps.some((s) => s.status === "running" || s.status === "awaiting_approval");
      const pendingLeft = steps.filter((s) => s.status === "pending").length;
      if (!busyLeft && pendingLeft > 0) {
        // Unreachable steps: their dependencies failed/cancelled. Mark them
        // skipped so the orchestration terminates honestly instead of wedging.
        await db.orchestrationStep.updateMany({
          where: { orchestrationId, status: "pending" },
          data: { status: "skipped", error: "skipped — upstream dependency did not complete", finishedAt: new Date() },
        });
        continue; // re-evaluate → termination branch below
      }
      const anyFailed = steps.some((s) => s.status === "failed");
      if (!busyLeft && pendingLeft === 0) {
        const allDone = steps.every((s) => s.status === "done" || s.status === "skipped");
        await db.orchestration.update({
          where: { id: orchestrationId },
          data: {
            status: allDone && !anyFailed ? "completed" : "failed",
            progress: 100,
            finishedAt: new Date(),
            currentStage: null,
            error: anyFailed ? steps.filter((s) => s.status === "failed").map((s) => `${s.name}: ${s.error ?? "failed"}`).join("; ").slice(0, 1_000) : null,
          },
        });
      }
      return;
    }

    // Wave: parallel independent steps. Approval gates park the pipeline.
    const wave = runnable;
    const gated = wave.find((s) => APPROVAL_STAGES.has(s.stage as Stage));
    if (gated) {
      const checkpoint = safeParseObj(gated.checkpoint);
      if (!checkpoint.approved) {
        await db.orchestrationStep.update({
          where: { id: gated.id },
          data: { status: "awaiting_approval", error: null },
        });
        await db.orchestration.update({
          where: { id: orchestrationId },
          data: { status: "awaiting_approval", currentStage: gated.stage },
        });
        return;
      }
    }

    await db.orchestration.update({
      where: { id: orchestrationId },
      data: { currentStage: wave.map((s) => s.stage).join("+") },
    });

    await Promise.all(wave.map((step) => {
      const checkpoint = safeParseObj(step.checkpoint);
      return runStepWithRetry(
        orchestrationId, orch.projectId, project, ctx, step.id, step.name,
        step.maxAttempts, checkpoint.optional === true
      );
    }));

    // Persist accumulated context (bounded) and progress.
    const after = await db.orchestrationStep.findMany({ where: { orchestrationId } });
    const doneSteps = after.filter((s) => s.status === "done");
    let ctxJson = JSON.stringify(ctx);
    if (ctxJson.length > CONTEXT_LIMIT) {
      // Trim largest entries — checkpoints remain authoritative on each step row.
      ctxJson = JSON.stringify(Object.fromEntries(Object.entries(ctx).slice(-8)));
    }
    await db.orchestration.update({
      where: { id: orchestrationId },
      data: {
        context: ctxJson,
        progress: Math.round((doneSteps.length / Math.max(after.length, 1)) * 100),
      },
    });
  }
}

async function runStepWithRetry(
  orchestrationId: string,
  projectId: string,
  project: { kind: string; reference: string; name: string },
  ctx: Ctx,
  stepId: string,
  stepName: string,
  maxAttempts: number,
  optional = false
): Promise<void> {
  const goal = await getGoal(orchestrationId);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await db.orchestrationStep.update({
      where: { id: stepId },
      data: { status: "running", attempts: attempt, startedAt: new Date(), error: null },
    });
    const t0 = Date.now();
    try {
      const output = await withTimeout(
        execStep(projectId, stepName, ctx, project, goal),
        stepTimeout(stepName)
      );
      await db.orchestrationStep.update({
        where: { id: stepId },
        data: {
          status: "done",
          output: JSON.stringify(output).slice(0, 120_000),
          checkpoint: JSON.stringify({ finishedAttempt: attempt }),
          finishedAt: new Date(),
          durationMs: Date.now() - t0,
        },
      });
      ctx[stepName] = output;
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const last = attempt >= maxAttempts;
      await db.orchestrationStep.update({
        where: { id: stepId },
        data: {
          status: last ? "failed" : "pending",
          error: msg.slice(0, 1_000),
          finishedAt: last ? new Date() : null,
          durationMs: Date.now() - t0,
        },
      });
      if (last) {
        if (optional) {
          // Optional step: record the reason, mark skipped, keep going.
          await db.orchestrationStep.update({
            where: { id: stepId },
            data: {
              status: "skipped",
              error: msg.slice(0, 1_000),
              finishedAt: new Date(),
              durationMs: Date.now() - t0,
            },
          });
          return;
        }
        return;
      }
      await sleep(1_500 * attempt); // backoff before retry
    }
  }
}

async function getGoal(orchestrationId: string): Promise<string> {
  const orch = await db.orchestration.findUnique({ where: { id: orchestrationId }, select: { goal: true } });
  return orch?.goal ?? "";
}

function stepTimeout(stepName: string): number {
  if (stepName.startsWith("collect")) return 180_000;
  if (stepName.startsWith("understand")) return 180_000;
  if (stepName.startsWith("test")) return 150_000;
  return 120_000;
}

// --- Human approvals -----------------------------------------------------------

export async function approveStep(
  orchestrationId: string,
  stepId: string,
  userId: string,
  approved: boolean
): Promise<{ ok: boolean; error?: string }> {
  const orch = await db.orchestration.findFirst({
    where: { id: orchestrationId, project: { userId } },
    include: { steps: true },
  });
  if (!orch) return { ok: false, error: "orchestration not found" };
  if (orch.status !== "awaiting_approval") return { ok: false, error: `orchestration is ${orch.status}, not awaiting approval` };
  const step = orch.steps.find((s) => s.id === stepId);
  if (!step) return { ok: false, error: "step not found" };
  if (step.status !== "awaiting_approval") return { ok: false, error: `step is ${step.status}` };

  await audit("orchestration.approval", {
    userId,
    detail: `${approved ? "approved" : "rejected"} step ${step.name}`,
    severity: "info",
  });

  if (!approved) {
    // Rejection parks the whole pipeline as failed at this gate — honest stop.
    await db.orchestrationStep.update({
      where: { id: stepId },
      data: { status: "failed", error: "rejected by human approval gate", finishedAt: new Date() },
    });
    await db.orchestrationStep.updateMany({
      where: { orchestrationId, status: { in: ["pending", "awaiting_approval"] } },
      data: { status: "skipped", finishedAt: new Date() },
    });
    await db.orchestration.update({
      where: { id: orchestrationId },
      data: { status: "failed", error: `plan rejected at approval gate (${step.name})`, finishedAt: new Date() },
    });
    return { ok: true };
  }

  await db.orchestrationStep.update({
    where: { id: stepId },
    data: {
      status: "pending",
      checkpoint: JSON.stringify({ ...(safeParseObj(step.checkpoint)), approved: true }),
    },
  });
  await db.orchestration.update({
    where: { id: orchestrationId },
    data: { status: "running" },
  });
  void runOrchestration(orchestrationId).catch(() => undefined);
  return { ok: true };
}

export async function cancelOrchestration(orchestrationId: string, userId: string): Promise<{ ok: boolean; error?: string }> {
  const orch = await db.orchestration.findFirst({ where: { id: orchestrationId, project: { userId } } });
  if (!orch) return { ok: false, error: "orchestration not found" };
  if (orch.status !== "running" && orch.status !== "awaiting_approval") {
    return { ok: false, error: `orchestration already ${orch.status}` };
  }
  await db.orchestration.update({ where: { id: orchestrationId }, data: { status: "cancelled" } });
  await audit("orchestration.cancel", { userId, detail: orch.goal.slice(0, 120) });
  return { ok: true };
}

function safeParseArr(json: string | null): string[] {
  try {
    const v = json ? JSON.parse(json) : [];
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function safeParseObj(json: string | null): Record<string, unknown> {
  try {
    const v = json ? JSON.parse(json) : {};
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
