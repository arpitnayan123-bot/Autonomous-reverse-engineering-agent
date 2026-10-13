import { NextResponse } from "next/server";
import type { AnalysisRun } from "@prisma/client";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { isSafeId } from "@/lib/security";

export const runtime = "nodejs";

function safeParsePayload(raw: string): unknown {
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
    const wantAll = url.searchParams.get("all") === "1";

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

    const evidence = await db.evidence.findMany({
      where: wantAll
        ? { run: { targetId: target.id } }
        : run
          ? { runId: run.id }
          : { runId: "__none__" },
      orderBy: { createdAt: "asc" },
      take: 200,
    });

    return NextResponse.json({
      ok: true,
      run: run
        ? {
            id: run.id,
            status: run.status,
            progress: run.progress,
            currentStep: run.currentStep,
          }
        : null,
      evidence: evidence.map((e) => ({
        id: e.id,
        runId: e.runId,
        evidenceId: e.evidenceId,
        kind: e.kind,
        predicateType: e.predicateType,
        operation: e.operation,
        subjectName: e.subjectName,
        confidence: e.confidence,
        authority: e.authority,
        payload: safeParsePayload(e.payload),
        createdAt: e.createdAt,
      })),
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not load evidence" },
      { status: 500 }
    );
  }
}
