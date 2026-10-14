import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { audit, clientIp, isSafeId, rateLimit } from "@/lib/security";
import { activeTurns } from "@/server/agent/turn-control";

export const runtime = "nodejs";

/**
 * POST /api/chat/stop {sessionId} — explicitly cancel the session's in-flight
 * turn.
 *
 * With turn lifetime decoupled from the SSE viewer, a viewer disconnect no
 * longer cancels the turn (external proxies cut long responses; that is a
 * transport event, not an intent). The Stop button calls this endpoint so
 * cancellation stays an EXPLICIT user action: the running turn is aborted,
 * its completed work persists via the interrupted-turn path, and a retry
 * reuses the dedup cache instead of re-executing tools.
 *
 * Idempotent by design: stopping a session with no running turn returns
 * ok:true with stopped:false, so a double click or a race with the turn's
 * natural end never surfaces an error.
 */
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const rl = rateLimit(`chatstop:${user.id}`, 60, 60_000);
    if (!rl.allowed) {
      return NextResponse.json({ ok: false, error: "Too many requests" }, { status: 429 });
    }

    let body: { sessionId?: unknown };
    try {
      body = (await req.json()) as { sessionId?: unknown };
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
    }
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    if (!isSafeId(sessionId)) {
      return NextResponse.json({ ok: false, error: "Invalid session id" }, { status: 400 });
    }

    // Ownership: never let a session id probe stop someone else's turn.
    const session = await db.chatSession.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== user.id) {
      return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
    }

    const turn = activeTurns.get(sessionId);
    if (!turn) {
      // No turn running (already finished, or finished between check and
      // stop) — an honest no-op, never an error.
      return NextResponse.json({ ok: true, stopped: false });
    }
    turn.stop("Turn cancelled by user");

    await audit("chat.stop", {
      userId: user.id,
      ip: clientIp(req),
      detail: `session=${sessionId}`,
    });

    return NextResponse.json({ ok: true, stopped: true });
  } catch (err) {
    console.error("chat stop POST error:", err);
    return NextResponse.json({ ok: false, error: "Failed to stop the turn" }, { status: 500 });
  }
}
