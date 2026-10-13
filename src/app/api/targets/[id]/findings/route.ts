import { NextResponse } from "next/server";
import type { AnalysisRun } from "@prisma/client";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { isSafeId } from "@/lib/security";

export const runtime = "nodejs";

function safeParseMeta(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function GET(
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

    const url = new URL(req.url);
    const runIdParam = url.searchParams.get("runId");
    const typeParam = url.searchParams.get("type");
    const qParam = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
    const limitParam = Number(url.searchParams.get("limit") ?? "500");

    let run: AnalysisRun | null = null;
    if (runIdParam && isSafeId(runIdParam)) {
      run = await db.analysisRun.findFirst({
        where: { id: runIdParam, targetId: target.id },
      });
      if (!run) {
        return NextResponse.json(
          { ok: false, error: "Run not found for this target" },
          { status: 404 }
        );
      }
    } else {
      run = await db.analysisRun.findFirst({
        where: { targetId: target.id },
        orderBy: { createdAt: "desc" },
      });
    }

    const limit = Number.isFinite(limitParam)
      ? Math.min(Math.max(Math.round(limitParam), 1), 1000)
      : 500;

    // Prisma `contains` is case-sensitive on SQLite → filter q in JS.
    const rows = await db.finding.findMany({
      where: {
        runId: run ? run.id : "__none__",
        ...(typeParam ? { type: typeParam } : {}),
      },
      orderBy: { createdAt: "asc" },
      take: 5000,
    });
    const filtered = qParam
      ? rows.filter((f) => f.name.toLowerCase().includes(qParam))
      : rows;

    return NextResponse.json({
      ok: true,
      run: run ? { id: run.id, status: run.status } : null,
      total: filtered.length,
      findings: filtered.slice(0, limit).map((f) => ({
        id: f.id,
        type: f.type,
        name: f.name,
        address: f.address,
        sizeBytes: f.sizeBytes,
        meta: safeParseMeta(f.meta),
        createdAt: f.createdAt,
      })),
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not load findings" },
      { status: 500 }
    );
  }
}
