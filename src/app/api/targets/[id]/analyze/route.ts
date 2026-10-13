import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { audit, clientIp, isSafeId, rateLimit } from "@/lib/security";
import { startAnalysis } from "@/server/engine/pipeline";

export const runtime = "nodejs";
export const maxDuration = 300;

interface AnalyzeBody {
  goal?: unknown;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Authentication required" },
        { status: 401 }
      );
    }
    const { id } = await params;
    if (!isSafeId(id)) {
      return NextResponse.json(
        { ok: false, error: "Invalid target id" },
        { status: 400 }
      );
    }
    const target = await db.target.findUnique({ where: { id } });
    if (!target || target.userId !== user.id) {
      return NextResponse.json(
        { ok: false, error: "Target not found" },
        { status: 404 }
      );
    }

    const limit = rateLimit(`analyze:${user.id}`, 10, 60 * 60 * 1000);
    if (!limit.allowed) {
      await audit("target.analyze_rejected", {
        userId: user.id,
        detail: `rate limited for target ${id}`,
        ip: clientIp(req),
        severity: "warn",
      });
      return NextResponse.json(
        {
          ok: false,
          error: `Analysis rate limit reached. Try again in ${limit.retryAfterSec}s.`,
        },
        { status: 429 }
      );
    }

    const body = (await req.json().catch(() => null)) as AnalyzeBody | null;
    const goal =
      typeof body?.goal === "string" && body.goal.trim().length > 0
        ? body.goal.trim().slice(0, 500)
        : undefined;

    // Concurrency-safe: returns the existing queued/running run if present.
    const runId = await startAnalysis(id, goal);

    await audit("target.analyze", {
      userId: user.id,
      detail: `analysis started for ${target.originalName} (run ${runId}${goal ? `, goal: ${goal.slice(0, 120)}` : ""})`,
      ip: clientIp(req),
    });

    return NextResponse.json({ ok: true, runId });
  } catch (err) {
    console.error("analyze start error:", err);
    // Generic client message — engine failures can embed paths/stack detail.
    return NextResponse.json(
      { ok: false, error: "Could not start analysis. The engine may be busy or the format unsupported — try again." },
      { status: 500 }
    );
  }
}
