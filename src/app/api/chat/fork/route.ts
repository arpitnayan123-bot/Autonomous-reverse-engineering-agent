import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { audit, clientIp, isSafeId, rateLimit } from "@/lib/security";

export const runtime = "nodejs";

const MAX_SESSIONS_PER_USER = 100;
/** Upper bound of messages copied into a fork. */
const MAX_FORK_MESSAGES = 400;

/**
 * POST /api/chat/fork — branch a chat at any message.
 *
 * Body: { sessionId, messageId }
 * Creates a NEW session owned by the same user, copying the target-bound file
 * and every message up to AND INCLUDING `messageId` (tool-call traces are
 * preserved verbatim). The original session is left untouched — this is a
 * branch point, not a truncation.
 */
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    // Forks copy up to 400 messages — bound the copy rate.
    const rl = rateLimit(`fork:${user.id}`, 10, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: "Too many forks — try again in a moment", retryAfterSec: rl.retryAfterSec },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
      );
    }

    const body = (await req.json().catch(() => null)) as {
      sessionId?: unknown;
      messageId?: unknown;
    } | null;
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
    const messageId = typeof body?.messageId === "string" ? body.messageId : "";
    if (!isSafeId(sessionId) || !isSafeId(messageId)) {
      return NextResponse.json(
        { ok: false, error: "sessionId and messageId are required" },
        { status: 400 }
      );
    }

    const session = await db.chatSession.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== user.id) {
      return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
    }

    const count = await db.chatSession.count({ where: { userId: user.id } });
    if (count >= MAX_SESSIONS_PER_USER) {
      return NextResponse.json(
        {
          ok: false,
          error: `Session limit reached (${MAX_SESSIONS_PER_USER}). Delete old chats first.`,
        },
        { status: 409 }
      );
    }

    const rows = await db.chatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: "asc" },
      take: MAX_FORK_MESSAGES,
    });
    const idx = rows.findIndex((m) => m.id === messageId);
    if (idx < 0) {
      return NextResponse.json(
        { ok: false, error: "Message not found in this session" },
        { status: 404 }
      );
    }
    const copied = rows.slice(0, idx + 1);
    if (copied.length === 0) {
      return NextResponse.json({ ok: false, error: "Nothing to fork" }, { status: 400 });
    }

    const title = `Fork · ${session.title}`.slice(0, 120);
    const forked = await db.chatSession.create({
      data: {
        targetId: session.targetId,
        userId: user.id,
        title,
      },
    });
    await db.chatMessage.createMany({
      data: copied.map((m) => ({
        sessionId: forked.id,
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls,
      })),
    });

    await audit("chat.session_fork", {
      userId: user.id,
      ip: clientIp(req),
      detail: `from=${session.id} to=${forked.id} messages=${copied.length}`,
    });

    let targetName: string | null = null;
    let detectedFormat: string | null = null;
    if (session.targetId) {
      const target = await db.target.findUnique({
        where: { id: session.targetId },
        select: { originalName: true, detectedFormat: true },
      });
      targetName = target?.originalName ?? null;
      detectedFormat = target?.detectedFormat ?? null;
    }

    return NextResponse.json({
      ok: true,
      session: {
        id: forked.id,
        title: forked.title,
        targetId: forked.targetId,
        pinned: forked.pinned,
        targetName,
        detectedFormat,
        messageCount: copied.length,
        updatedAt: forked.updatedAt,
      },
      forkedMessages: copied.length,
    });
  } catch (err) {
    console.error("chat fork error:", err);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
