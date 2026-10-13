import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { rea } from "@/server/engine/rea-bridge";
import {
  ANALYSIS_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  MAX_UPLOAD_BYTES,
} from "@/lib/security";

export const runtime = "nodejs";

interface PostureControl {
  control: string;
  status: "enforced" | "partial";
  detail: string;
}

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Authentication required" },
        { status: 401 }
      );
    }

    const posture: PostureControl[] = [
      {
        control: "Magic-byte format validation",
        status: "enforced",
        detail:
          "Uploads are identified by content magic bytes (not client MIME); detected format drives the analysis plan and mismatches are surfaced.",
      },
      {
        control: "Upload size cap",
        status: "enforced",
        detail: `Files larger than ${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB are rejected with HTTP 413 before storage.`,
      },
      {
        control: "Opaque storage paths",
        status: "enforced",
        detail:
          "Files are stored as storage/uploads/<cuid>/original; the original filename is sanitized and never used in filesystem paths.",
      },
      {
        control: "Sandboxed engine subprocess",
        status: "enforced",
        detail:
          "REA runs as a child process (node rea.mjs --mcp) with a scrubbed environment, cwd /tmp, and SIGKILL hard timeouts on every call.",
      },
      {
        control: "Engine output budgets",
        status: "enforced",
        detail: `Per-call output capped at ${Math.round(MAX_OUTPUT_BYTES / (1024 * 1024))} MB; tool timeouts at ${Math.round(ANALYSIS_TIMEOUT_MS / 1000)}s and stored evidence text truncated.`,
      },
      {
        control: "Rate limiting",
        status: "enforced",
        detail:
          "In-memory sliding-window limits: register 5/h/IP, login 10/15min/IP, uploads 20/h/user, analyses 10/h/user.",
      },
      {
        control: "Password hashing",
        status: "enforced",
        detail: "scrypt (node:crypto) with per-user random salt; constant-time comparison.",
      },
      {
        control: "Session cookies",
        status: "partial",
        detail:
          "HMAC-SHA256 signed, HttpOnly, SameSite=Lax, 7-day expiry. Secure flag is off because this sandbox serves plain HTTP.",
      },
      {
        control: "Audit logging",
        status: "enforced",
        detail:
          "Security-relevant events (login success/failure, registration, upload accept/reject, delete, analyze) are persisted to the AuditLog.",
      },
      {
        control: "SELECT-only SQL",
        status: "enforced",
        detail:
          "No user SQL is ever executed. The local SQLite inspector issues only fixed SELECT/PRAGMA templates against double-quote-escaped identifiers from sqlite_master.",
      },
      {
        control: "Read-only file parsing",
        status: "enforced",
        detail:
          "Uploaded artifacts are parsed, never executed. REA static-analysis providers run inert; no uploaded bytes are ever interpreted as code on the host.",
      },
      {
        control: "Path traversal protection",
        status: "enforced",
        detail:
          "IDs are validated (isSafeId), stored paths resolved strictly inside the storage root, and extraction targets are platform-owned directories.",
      },
    ];

    const recentThreats = await db.auditLog.findMany({
      where: { severity: { not: "info" } },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    return NextResponse.json({
      ok: true,
      posture,
      engineDiag: rea.getDiagnostics(),
      recentThreats,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not compute security posture" },
      { status: 500 }
    );
  }
}
