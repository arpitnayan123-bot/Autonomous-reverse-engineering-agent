import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { audit, clientIp, isSafeId, rateLimit } from "@/lib/security";
import { generateDocumentation } from "@/server/agent/agent";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/targets/[id]/report — generate reverse-engineering documentation
 * into Target.docs (and a 2-sentence Target.summary) via a single LLM pass.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!isSafeId(id)) {
      return NextResponse.json({ ok: false, error: "Invalid target id" }, { status: 400 });
    }
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const rl = rateLimit(`report:${user.id}`, 5, 60 * 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: "Rate limit exceeded (5 generations/hour)", retryAfterSec: rl.retryAfterSec },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
      );
    }

    const target = await db.target.findUnique({ where: { id } });
    if (!target || target.userId !== user.id) {
      return NextResponse.json({ ok: false, error: "Target not found" }, { status: 404 });
    }

    const { docs, summary } = await generateDocumentation(id, user.id);

    await audit("report.generate", {
      userId: user.id,
      ip: clientIp(req),
      detail: `target=${id} docsChars=${docs.length}`,
    });

    return NextResponse.json({ ok: true, docs, summary });
  } catch (err) {
    console.error("report generate error:", err);
    // Generic client message — raw LLM/provider errors can embed upstream
    // request bodies; they stay in the server log only.
    return NextResponse.json(
      { ok: false, error: "Documentation generation failed. Check that a working model is configured, then try again." },
      { status: 500 }
    );
  }
}
