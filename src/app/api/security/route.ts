import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  getSessionUser,
  listActiveSessions,
  revokeOtherSessions,
} from "@/lib/auth";
import { audit, clientIp, rateLimit } from "@/lib/security";
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
          "HMAC-SHA256 signed, HttpOnly, SameSite=Lax, 7-day expiry, backed by revocable server-side session records — logout and 'sign out other sessions' invalidate outstanding cookies immediately. Secure flag is active in production; this sandbox serves plain HTTP.",
      },
      {
        control: "Tenant isolation",
        status: "enforced",
        detail:
          "Every chat, file, analysis, provider key, and audit event is scoped to the owning account; cross-account access returns 404.",
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
        control: "Chat workspace sandbox",
        status: "partial",
        detail:
          "Per-chat workspaces (storage/workspaces/chat-<sessionId>/) give chats REAL file write/read and command execution: isPathInside path jail, no-shell tokenizer, allowlisted binaries only, sed/awk/find/tar/git/env + eval flags (node -e) + absolute/.. paths blocked, 55s SIGKILL cap, scrubbed env, output caps, and an 8 MB per-workspace disk quota enforced on every chat write and re-checked before each chat command (over-quota operations are refused honestly, nothing written/run). Built-in git version control: each workspace gets a git repo at creation (identity REA Agent <agent@rea.local>, initial empty commit); writes and file-changing runs are auto-committed, and git is exposed to the model ONLY through the workspace_diff/log/reset tools — sandboxed spawns (no shell, cwd jail, scrubbed env, timeout), an 8-subcommand allowlist, per-subcommand flag allowlists, and revision validation refuse --git-dir/--work-tree/-c style escapes; raw git via workspace_run stays blocked, and .git/ counts toward the disk quota. When the git binary is missing the workspace degrades gracefully (tools return an honest error, writes/runs unaffected). PARTIAL by design: the jail is process-level, not an OS namespace jail — code written INTO the workspace and run by an interpreter executes with server privileges (env carries no secrets, HOME is the workspace, single-tenant self-hosted deployment).",
      },
      {
        control: "Path traversal protection",
        status: "enforced",
        detail:
          "IDs are validated (isSafeId), stored paths resolved strictly inside the storage root, and extraction targets are platform-owned directories.",
      },
    ];

    // TENANT ISOLATION: threats relevant to THIS user's account only.
    const recentThreats = await db.auditLog.findMany({
      where: { severity: { not: "info" }, userId: user.id },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    const sessions = await listActiveSessions(user.id);

    return NextResponse.json({
      ok: true,
      posture,
      engineDiag: rea.getDiagnostics(),
      recentThreats,
      sessions,
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not compute security posture" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/security { signOutOthers: true } — revoke every live session of
 * the account except the one making the request. A stolen cookie from another
 * device stops working immediately; the current device stays signed in.
 */
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Authentication required" },
        { status: 401 }
      );
    }
    const rl = rateLimit(`secops:${user.id}`, 6, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: "Rate limit exceeded", retryAfterSec: rl.retryAfterSec },
        { status: 429 }
      );
    }
    const body = (await req.json().catch(() => null)) as {
      signOutOthers?: unknown;
    } | null;
    if (body?.signOutOthers !== true) {
      return NextResponse.json(
        { ok: false, error: "signOutOthers must be true" },
        { status: 400 }
      );
    }
    const revoked = await revokeOtherSessions(user.id);
    await audit("auth.sessions_revoked", {
      userId: user.id,
      ip: clientIp(req),
      detail: `signed out ${revoked} other session(s)`,
      severity: revoked > 0 ? "warn" : "info",
    });
    const sessions = await listActiveSessions(user.id);
    return NextResponse.json({ ok: true, revoked, sessions });
  } catch {
    return NextResponse.json(
      { ok: false, error: "Could not revoke sessions" },
      { status: 500 }
    );
  }
}
