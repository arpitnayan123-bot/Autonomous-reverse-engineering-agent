import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit, clientIp, isSafeId, rateLimit } from "@/lib/security";
import { requireProject, unauthorized, badRequest, serverError } from "@/server/platform/api-helpers";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Ctx {
  params: Promise<{ id: string }>;
}

/** GET /api/projects/[id] — full project detail: counts + latest artifacts. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    if (!isSafeId(id)) return badRequest("invalid project id");
    const auth = await requireProject(id);
    if (auth instanceof NextResponse) return auth;

    const [pages, nodes, edges, reports, verifications, orchestrations] = await Promise.all([
      db.crawlPage.count({ where: { projectId: id } }),
      db.graphNode.count({ where: { projectId: id } }),
      db.graphEdge.count({ where: { projectId: id } }),
      db.researchReport.findMany({ where: { projectId: id }, orderBy: { createdAt: "desc" }, take: 5 }),
      db.verificationRun.findMany({ where: { projectId: id }, orderBy: { createdAt: "desc" }, take: 5 }),
      db.orchestration.findMany({ where: { projectId: id }, orderBy: { createdAt: "desc" }, take: 5, include: { steps: { orderBy: { createdAt: "asc" } } } }),
    ]);

    return NextResponse.json({
      ok: true,
      project: auth.project,
      counts: { pages, nodes, edges, reports: reports.length, verifications: verifications.length },
      reports: reports.map((r) => ({ id: r.id, query: r.query, summary: r.summary, createdAt: r.createdAt })),
      verifications: verifications.map((v) => ({ id: v.id, url: v.url, score: v.score, regression: v.regression, createdAt: v.createdAt })),
      orchestrations: orchestrations.map((o) => ({
        id: o.id,
        goal: o.goal,
        status: o.status,
        progress: o.progress,
        currentStage: o.currentStage,
        error: o.error,
        createdAt: o.createdAt,
        finishedAt: o.finishedAt,
        steps: o.steps.map((s) => ({
          id: s.id, stage: s.stage, name: s.name, status: s.status, attempts: s.attempts,
          error: s.error, durationMs: s.durationMs, output: s.output ? JSON.parse(s.output) : null,
        })),
      })),
    });
  } catch (err) {
    console.error("project detail error:", err);
    return serverError("Could not load project");
  }
}

/** DELETE /api/projects/[id] — remove a project and all its artifacts. */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    if (!isSafeId(id)) return badRequest("invalid project id");
    const auth = await requireProject(id);
    if (auth instanceof NextResponse) return auth;
    const ip = clientIp(req);
    const limit = rateLimit(`projects:delete:${auth.user.id}`, 20, 60 * 60 * 1000);
    if (!limit.allowed) return NextResponse.json({ ok: false, error: "Rate limit reached" }, { status: 429 });

    await db.project.delete({ where: { id } });
    await audit("project.delete", { userId: auth.user.id, detail: auth.project.name, ip, severity: "warn" });
    return NextResponse.json({ ok: true });
  } catch {
    return serverError("Could not delete project");
  }
}
