import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { audit, clientIp, isSafeId, rateLimit } from "@/lib/security";
import { forget, listMemories, scopeOf } from "@/server/agent/memory";

export const runtime = "nodejs";

/**
 * Cross-session agent memory — security-scoped surface for the UI Memory tab
 * (same pattern as /api/security and /api/targets: every row is keyed by the
 * SESSION user id, ownership is re-checked server-side, and the agent's
 * memory namespace is never addressable across users).
 *
 * GET    /api/memory                     → { global: [...] }
 * GET    /api/memory?targetId=<id>       → { target: [...], global: [...], targetName }
 * DELETE /api/memory?key=<key>&scope=global
 * DELETE /api/memory?key=<key>&scope=target&targetId=<id>
 */

/** Serialize a Memory row for the client (scope label derived server-side). */
function toRow(m: {
  id: string;
  targetId: string | null;
  key: string;
  value: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: m.id,
    key: m.key,
    value: m.value,
    scope: scopeOf(m),
    targetId: m.targetId,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

export async function GET(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const targetId = new URL(req.url).searchParams.get("targetId");
    if (targetId && !isSafeId(targetId)) {
      return NextResponse.json({ ok: false, error: "Invalid target id" }, { status: 400 });
    }
    let targetName: string | null = null;
    let target: ReturnType<typeof toRow>[] | null = null;
    if (targetId) {
      // Ownership gate: memories of OTHER users' targets are never listable.
      const targetRow = await db.target.findUnique({ where: { id: targetId } });
      if (!targetRow || targetRow.userId !== user.id) {
        return NextResponse.json({ ok: false, error: "Target not found" }, { status: 404 });
      }
      targetName = targetRow.originalName;
      target = (await listMemories(user.id, targetId)).map(toRow);
    }
    const global = (await listMemories(user.id, null)).map(toRow);
    return NextResponse.json({ ok: true, target, global, targetName });
  } catch (err) {
    console.error("memory GET error:", err);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const limit = rateLimit(`memory-delete:${user.id}`, 60, 5 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        { ok: false, error: `Too many memory deletions — retry in ${limit.retryAfterSec}s.` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
      );
    }
    const params = new URL(req.url).searchParams;
    const key = (params.get("key") ?? "").trim();
    const scope = params.get("scope") ?? "global";
    const targetId = params.get("targetId");
    if (!key || key.length > 200) {
      return NextResponse.json(
        { ok: false, error: "key (1–200 chars) is required" },
        { status: 400 }
      );
    }
    if (scope !== "target" && scope !== "global") {
      return NextResponse.json(
        { ok: false, error: 'scope must be "target" or "global"' },
        { status: 400 }
      );
    }
    let scopedTargetId: string | null = null;
    if (scope === "target") {
      if (!targetId || !isSafeId(targetId)) {
        return NextResponse.json(
          { ok: false, error: "targetId is required for scope=target" },
          { status: 400 }
        );
      }
      // Ownership gate: deleting a memory scoped to another user's target
      // would be a cross-tenant write — refuse before touching the store.
      const targetRow = await db.target.findUnique({ where: { id: targetId } });
      if (!targetRow || targetRow.userId !== user.id) {
        return NextResponse.json({ ok: false, error: "Target not found" }, { status: 404 });
      }
      scopedTargetId = targetId;
    }
    const deleted = await forget(user.id, scopedTargetId, key);
    if (!deleted) {
      return NextResponse.json(
        { ok: false, error: `No memory with key "${key.slice(0, 120)}" in ${scope} scope.` },
        { status: 404 }
      );
    }
    await audit("memory.delete", {
      userId: user.id,
      ip: clientIp(req),
      detail: `key=${deleted.key.slice(0, 120)} scope=${scope}${scopedTargetId ? ` target=${scopedTargetId}` : ""}`,
    });
    return NextResponse.json({ ok: true, deleted: toRow(deleted) });
  } catch (err) {
    console.error("memory DELETE error:", err);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
