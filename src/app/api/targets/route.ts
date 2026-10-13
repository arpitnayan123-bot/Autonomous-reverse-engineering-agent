import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { detectFormat } from "@/lib/formats";
import {
  audit,
  clientIp,
  rateLimit,
  sanitizeFileName,
  MAX_UPLOAD_BYTES,
} from "@/lib/security";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Authentication required" },
        { status: 401 }
      );
    }

    const targets = await db.target.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      include: {
        runs: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { _count: { select: { findings: true, evidence: true } } },
        },
      },
    });

    return NextResponse.json({
      ok: true,
      targets: targets.map((t) => ({
        id: t.id,
        originalName: t.originalName,
        sizeBytes: t.sizeBytes,
        detectedFormat: t.detectedFormat,
        formatFamily: t.formatFamily,
        status: t.status,
        summary: t.summary,
        createdAt: t.createdAt,
        lastRun: t.runs[0]
          ? {
              id: t.runs[0].id,
              status: t.runs[0].status,
              progress: t.runs[0].progress,
              currentStep: t.runs[0].currentStep,
              findingsCount: t.runs[0]._count.findings,
              evidenceCount: t.runs[0]._count.evidence,
              createdAt: t.runs[0].createdAt,
            }
          : null,
      })),
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not list targets" },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Authentication required" },
        { status: 401 }
      );
    }
    const ip = clientIp(req);
    const limit = rateLimit(`upload:${user.id}`, 20, 60 * 60 * 1000);
    if (!limit.allowed) {
      await audit("target.upload_rejected", {
        userId: user.id,
        detail: "rate limited",
        ip,
        severity: "warn",
      });
      return NextResponse.json(
        {
          ok: false,
          error: `Upload rate limit reached. Try again in ${limit.retryAfterSec}s.`,
        },
        { status: 429 }
      );
    }

    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!form || !(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "Multipart field 'file' is required" },
        { status: 400 }
      );
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      await audit("target.upload_rejected", {
        userId: user.id,
        detail: `file too large: ${file.name} (${file.size} bytes)`,
        ip,
        severity: "warn",
      });
      return NextResponse.json(
        {
          ok: false,
          error: `File exceeds the ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB upload cap`,
        },
        { status: 413 }
      );
    }

    const buf = Buffer.from(await file.arrayBuffer());
    const originalName = sanitizeFileName(file.name || "file");
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const detection = detectFormat(buf, originalName);

    // Create row first (id needed for the storage path), then materialize.
    const target = await db.target.create({
      data: {
        userId: user.id,
        originalName,
        storedPath: "pending",
        sizeBytes: buf.length,
        sha256,
        mimeType: file.type || null,
        detectedFormat: detection.format,
        formatFamily: detection.family,
        status: "uploaded",
      },
    });

    const relDir = path.join("storage", "uploads", target.id);
    const absDir = path.join(process.cwd(), relDir);
    try {
      await fs.mkdir(absDir, { recursive: true });
      await fs.writeFile(path.join(absDir, "original"), buf);
    } catch (err) {
      await db.target.delete({ where: { id: target.id } }).catch(() => undefined);
      await audit("target.upload_rejected", {
        userId: user.id,
        detail: `storage write failed: ${err instanceof Error ? err.message : String(err)}`,
        ip,
        severity: "warn",
      });
      return NextResponse.json(
        { ok: false, error: "Could not store uploaded file" },
        { status: 500 }
      );
    }

    const storedPath = `${relDir}/original`;
    await db.target.update({ where: { id: target.id }, data: { storedPath } });

    await audit("target.upload", {
      userId: user.id,
      detail: `uploaded ${originalName} (${buf.length} bytes, format ${detection.format}, sha256 ${sha256.slice(0, 12)}…)`,
      ip,
    });

    return NextResponse.json({
      ok: true,
      target: {
        id: target.id,
        originalName,
        sizeBytes: buf.length,
        sha256,
        detectedFormat: detection.format,
        formatFamily: detection.family,
        formatLabel: detection.label,
        formatConfidence: detection.confidence,
        formatDetails: detection.details,
        mimeType: file.type || null,
        status: "uploaded",
        createdAt: target.createdAt,
      },
    });
  } catch (err) {
    console.error("target upload error:", err);
    // Generic client message — fs errors can embed absolute server paths.
    return NextResponse.json(
      { ok: false, error: "Upload failed. The file may be too large or unreadable — try again." },
      { status: 500 }
    );
  }
}
