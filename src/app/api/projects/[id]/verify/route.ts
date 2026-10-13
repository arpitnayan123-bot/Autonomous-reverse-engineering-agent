import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/security";
import { requireProject, unauthorized, badRequest, serverError } from "@/server/platform/api-helpers";
import { runVerification } from "@/server/platform/verifier";
import { detectBrowser } from "@/server/platform/browser";

export const runtime = "nodejs";
export const maxDuration = 300;

interface Ctx {
  params: Promise<{ id: string }>;
}

/** GET /api/projects/[id]/verify — verification history. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const auth = await requireProject(id);
    if (auth instanceof NextResponse) return auth;
    const runs = await db.verificationRun.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
    return NextResponse.json({
      ok: true,
      browser: detectBrowser(),
      runs: runs.map((r) => ({
        id: r.id,
        url: r.url,
        score: r.score,
        regression: r.regression,
        diffSummary: r.diffSummary,
        checks: r.checks ? safeArr(r.checks) : [],
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    console.error("verify list error:", err);
    return serverError("Could not list verification runs");
  }
}

/** POST /api/projects/[id]/verify — run the verification suite. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const auth = await requireProject(id);
    if (auth instanceof NextResponse) return auth;
    const ip = clientIp(req);
    const limit = rateLimit(`verify:${auth.user.id}`, 20, 60 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json({ ok: false, error: `Rate limit reached. Try again in ${limit.retryAfterSec}s.` }, { status: 429 });
    }
    const body = (await req.json().catch(() => ({}))) as { url?: string; referenceUrl?: string };
    const url = (body.url ?? (auth.project.kind === "website" ? auth.project.reference : "")).trim();
    if (!url) {
      return badRequest("url is required (project has no default URL)");
    }

    const result = await runVerification(id, url, {
      referenceUrl: body.referenceUrl?.trim() || undefined,
    });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error("verify error:", err);
    return serverError("Verification failed");
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
