import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/security";
import { requireProject, unauthorized, badRequest, serverError } from "@/server/platform/api-helpers";
import { runResearch } from "@/server/platform/research";

export const runtime = "nodejs";
export const maxDuration = 300;

interface Ctx {
  params: Promise<{ id: string }>;
}

/** GET /api/projects/[id]/research — list research reports. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const auth = await requireProject(id);
    if (auth instanceof NextResponse) return auth;
    const reports = await db.researchReport.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    return NextResponse.json({
      ok: true,
      reports: reports.map((r) => ({
        id: r.id,
        query: r.query,
        summary: r.summary,
        reportMd: r.reportMd,
        sources: r.sources ? safeArr(r.sources) : [],
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    console.error("research list error:", err);
    return serverError("Could not list research reports");
  }
}

/** POST /api/projects/[id]/research — run a cited research pass. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const auth = await requireProject(id);
    if (auth instanceof NextResponse) return auth;
    const ip = clientIp(req);
    const limit = rateLimit(`research:${auth.user.id}`, 20, 60 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json({ ok: false, error: `Rate limit reached. Try again in ${limit.retryAfterSec}s.` }, { status: 429 });
    }
    const body = (await req.json().catch(() => null)) as { query?: string } | null;
    const query = (body?.query ?? "").trim().slice(0, 500);
    if (!query) return badRequest("query is required");

    const result = await runResearch(id, query);
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error("research error:", err);
    return serverError("Research failed");
  }
}

function safeArr(json: string): Array<Record<string, unknown>> {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
  } catch {
    return [];
  }
}
