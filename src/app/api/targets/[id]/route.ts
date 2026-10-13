import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { audit, clientIp, isSafeId } from "@/lib/security";

export const runtime = "nodejs";

async function ownedTarget(id: string, userId: string) {
  if (!isSafeId(id)) return null;
  const target = await db.target.findUnique({ where: { id } });
  if (!target || target.userId !== userId) return null;
  return target;
}

export async function GET(
  _req: Request,
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
    const target = await ownedTarget(id, user.id);
    if (!target) {
      return NextResponse.json(
        { ok: false, error: "Target not found" },
        { status: 404 }
      );
    }

    const runs = await db.analysisRun.findMany({
      where: { targetId: target.id },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { _count: { select: { findings: true, evidence: true } } },
    });

    return NextResponse.json({
      ok: true,
      target: {
        id: target.id,
        originalName: target.originalName,
        storedPath: undefined, // never leak server paths to the client
        sizeBytes: target.sizeBytes,
        sha256: target.sha256,
        mimeType: target.mimeType,
        detectedFormat: target.detectedFormat,
        formatFamily: target.formatFamily,
        status: target.status,
        summary: target.summary,
        docs: target.docs,
        docsAt: target.docsAt,
        createdAt: target.createdAt,
        runs: runs.map((r) => ({
          id: r.id,
          status: r.status,
          progress: r.progress,
          currentStep: r.currentStep,
          engine: r.engine,
          engineTools: r.engineTools,
          goal: r.goal,
          result: r.result,
          error: r.error,
          durationMs: r.durationMs,
          createdAt: r.createdAt,
          finishedAt: r.finishedAt,
          findingsCount: r._count.findings,
          evidenceCount: r._count.evidence,
        })),
      },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not load target" },
      { status: 500 }
    );
  }
}

export async function DELETE(
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
    const target = await ownedTarget(id, user.id);
    if (!target) {
      return NextResponse.json(
        { ok: false, error: "Target not found" },
        { status: 404 }
      );
    }

    // Remove stored artifacts first (uploads + any engine extraction).
    const uploadsDir = path.join(process.cwd(), "storage", "uploads", target.id);
    const extractDir = path.join(process.cwd(), "storage", "extract", target.id);
    await fs.rm(uploadsDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);

    // Cascades to runs, evidence, findings, chat sessions, messages.
    await db.target.delete({ where: { id: target.id } });

    await audit("target.delete", {
      userId: user.id,
      detail: `deleted target ${target.id} (${target.originalName}, ${target.sizeBytes} bytes)`,
      ip: clientIp(req),
      severity: "warn",
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not delete target" },
      { status: 500 }
    );
  }
}
