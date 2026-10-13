import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientIp, isSafeId, rateLimit } from "@/lib/security";
import { requireProject, unauthorized, badRequest, serverError } from "@/server/platform/api-helpers";
import {
  createOrchestration, approveStep, cancelOrchestration,
} from "@/server/platform/orchestrator";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Ctx {
  params: Promise<{ id: string }>;
}

/** GET /api/projects/[id]/orchestrate?orchestrationId=… — pipeline state. */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const auth = await requireProject(id);
    if (auth instanceof NextResponse) return auth;
    const url = new URL(req.url);
    const orchestrationId = url.searchParams.get("orchestrationId");

    if (orchestrationId) {
      if (!isSafeId(orchestrationId)) return badRequest("invalid orchestration id");
      const orch = await db.orchestration.findFirst({
        where: { id: orchestrationId, projectId: id },
        include: { steps: { orderBy: { createdAt: "asc" } } },
      });
      if (!orch) return badRequest("orchestration not found");
      return NextResponse.json({ ok: true, orchestration: shapeOrchestration(orch) });
    }

    const list = await db.orchestration.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { steps: { orderBy: { createdAt: "asc" } } },
    });
    return NextResponse.json({
      ok: true,
      orchestrations: list.map(shapeOrchestration),
    });
  } catch (err) {
    console.error("orchestration get error:", err);
    return serverError("Could not load orchestration");
  }
}

/**
 * POST /api/projects/[id]/orchestrate — actions:
 *   start   {goal}               → create + run the full pipeline (background)
 *   approve {orchestrationId, stepId, approved} → human approval gate
 *   cancel  {orchestrationId}    → cancel a running pipeline
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const auth = await requireProject(id);
    if (auth instanceof NextResponse) return auth;
    const ip = clientIp(req);
    const limit = rateLimit(`orchestrate:${auth.user.id}`, 12, 60 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json({ ok: false, error: `Rate limit reached. Try again in ${limit.retryAfterSec}s.` }, { status: 429 });
    }

    const body = (await req.json().catch(() => null)) as {
      action?: string; goal?: string; orchestrationId?: string; stepId?: string; approved?: boolean;
    } | null;
    if (!body?.action) return badRequest("action is required (start|approve|cancel)");

    if (body.action === "start") {
      const goal = (body.goal ?? "").trim().slice(0, 2_000);
      if (!goal) return badRequest("goal is required");
      const r = await createOrchestration(id, auth.user.id, goal);
      if (!r.ok) return badRequest(r.error ?? "could not start orchestration");
      return NextResponse.json({ ok: true, orchestrationId: r.orchestrationId });
    }

    if (body.action === "approve") {
      if (!body.orchestrationId || !body.stepId) return badRequest("orchestrationId and stepId are required");
      if (!isSafeId(body.orchestrationId) || !isSafeId(body.stepId)) return badRequest("invalid ids");
      const r = await approveStep(body.orchestrationId, body.stepId, auth.user.id, body.approved !== false);
      if (!r.ok) return badRequest(r.error ?? "approval failed");
      return NextResponse.json({ ok: true });
    }

    if (body.action === "cancel") {
      if (!body.orchestrationId) return badRequest("orchestrationId is required");
      if (!isSafeId(body.orchestrationId)) return badRequest("invalid orchestration id");
      const r = await cancelOrchestration(body.orchestrationId, auth.user.id);
      if (!r.ok) return badRequest(r.error ?? "cancel failed");
      return NextResponse.json({ ok: true });
    }

    return badRequest("action must be start|approve|cancel");
  } catch (err) {
    console.error("orchestration post error:", err);
    return serverError("Orchestration action failed");
  }
}

function shapeOrchestration(o: {
  id: string; goal: string; status: string; progress: number; currentStage: string | null;
  error: string | null; createdAt: Date; finishedAt: Date | null;
  steps: Array<{
    id: string; stage: string; name: string; status: string; attempts: number;
    maxAttempts: number; error: string | null; durationMs: number | null;
    output: string | null; startedAt: Date | null; finishedAt: Date | null;
  }>;
}) {
  return {
    id: o.id,
    goal: o.goal,
    status: o.status,
    progress: o.progress,
    currentStage: o.currentStage,
    error: o.error,
    createdAt: o.createdAt,
    finishedAt: o.finishedAt,
    steps: o.steps.map((s) => ({
      id: s.id,
      stage: s.stage,
      name: s.name,
      status: s.status,
      attempts: s.attempts,
      maxAttempts: s.maxAttempts,
      error: s.error,
      durationMs: s.durationMs,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      output: s.output ? safeParse(s.output) : null,
    })),
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
