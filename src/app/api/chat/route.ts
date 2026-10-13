import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { audit, clientIp, isSafeId, rateLimit } from "@/lib/security";
import { runAgentLoop } from "@/server/agent/agent";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_MESSAGE_CHARS = 8000;
const HISTORY_TURNS = 20;
const MAX_SESSIONS_PER_USER = 100;

/** Shape of a chat session row as returned by the list endpoint. */
function toSessionSummary(
  s: {
    id: string;
    title: string;
    targetId: string | null;
    updatedAt: Date;
    target: { originalName: string; detectedFormat: string | null } | null;
    _count: { messages: number };
  }
) {
  return {
    id: s.id,
    title: s.title,
    targetId: s.targetId,
    targetName: s.target?.originalName ?? null,
    detectedFormat: s.target?.detectedFormat ?? null,
    messageCount: s._count.messages,
    updatedAt: s.updatedAt,
  };
}

/** GET /api/chat            → list the user's sessions (sidebar). */
/** GET /api/chat?sessionId= → message history for one session. */
export async function GET(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const sessionId = new URL(req.url).searchParams.get("sessionId");
    if (!sessionId) {
      const sessions = await db.chatSession.findMany({
        where: { userId: user.id },
        orderBy: { updatedAt: "desc" },
        take: 100,
        include: {
          target: { select: { originalName: true, detectedFormat: true } },
          _count: { select: { messages: true } },
        },
      });
      return NextResponse.json({ ok: true, sessions: sessions.map(toSessionSummary) });
    }

    if (!isSafeId(sessionId)) {
      return NextResponse.json({ ok: false, error: "Invalid session id" }, { status: 400 });
    }
    const session = await db.chatSession.findUnique({
      where: { id: sessionId },
      include: { target: { select: { originalName: true, detectedFormat: true } } },
    });
    if (!session || session.userId !== user.id) {
      return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
    }
    const messages = await db.chatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    return NextResponse.json({
      ok: true,
      session: {
        id: session.id,
        title: session.title,
        targetId: session.targetId,
        targetName: session.target?.originalName ?? null,
        detectedFormat: session.target?.detectedFormat ?? null,
      },
      messages: messages.map((m) => {
        let toolCalls: unknown = null;
        if (m.toolCalls) {
          try {
            toolCalls = JSON.parse(m.toolCalls);
          } catch {
            toolCalls = null;
          }
        }
        return {
          id: m.id,
          role: m.role,
          content: m.content,
          toolCalls,
          createdAt: m.createdAt,
        };
      }),
    });
  } catch (err) {
    console.error("chat GET error:", err);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}

/** DELETE /api/chat?sessionId= — delete one session and its messages. */
export async function DELETE(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
    if (!isSafeId(sessionId)) {
      return NextResponse.json({ ok: false, error: "Invalid session id" }, { status: 400 });
    }
    const session = await db.chatSession.findUnique({ where: { id: sessionId } });
    if (!session || session.userId !== user.id) {
      return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
    }
    await db.chatSession.delete({ where: { id: sessionId } });
    await audit("chat.session_delete", {
      userId: user.id,
      ip: clientIp(req),
      detail: `sessionId=${sessionId}`,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("chat DELETE error:", err);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}

/** POST /api/chat — SSE stream of one agent turn. */
/**
 * Body: { sessionId?, targetId?, message }
 * - sessionId given → continue that session (ownership verified).
 * - targetId given  → start a NEW chat bound to that target.
 * - neither         → start a NEW free chat (no file attached, no tools).
 */
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const rl = rateLimit(`chat:${user.id}`, 20, 5 * 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: "Rate limit exceeded", retryAfterSec: rl.retryAfterSec },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
      );
    }

    const body = (await req.json().catch(() => null)) as {
      sessionId?: unknown;
      targetId?: unknown;
      message?: unknown;
    } | null;
    const rawSessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
    const rawTargetId = typeof body?.targetId === "string" ? body.targetId : "";
    let message = typeof body?.message === "string" ? body.message : "";
    message = message.slice(0, MAX_MESSAGE_CHARS).trim();
    if (!message) {
      return NextResponse.json(
        { ok: false, error: "message is required (≤ 8000 chars)" },
        { status: 400 }
      );
    }
    if (rawSessionId && !isSafeId(rawSessionId)) {
      return NextResponse.json({ ok: false, error: "Invalid session id" }, { status: 400 });
    }
    if (rawTargetId && !isSafeId(rawTargetId)) {
      return NextResponse.json({ ok: false, error: "Invalid target id" }, { status: 400 });
    }

    // ---- Resolve or create the session -----------------------------------
    let session: {
      id: string;
      targetId: string | null;
    } | null = null;

    if (rawSessionId) {
      const existing = await db.chatSession.findUnique({ where: { id: rawSessionId } });
      if (!existing || existing.userId !== user.id) {
        return NextResponse.json({ ok: false, error: "Session not found" }, { status: 404 });
      }
      session = { id: existing.id, targetId: existing.targetId };
    } else {
      // Session count guard (abuse bound).
      const count = await db.chatSession.count({ where: { userId: user.id } });
      if (count >= MAX_SESSIONS_PER_USER) {
        return NextResponse.json(
          { ok: false, error: `Session limit reached (${MAX_SESSIONS_PER_USER}). Delete old chats first.` },
          { status: 400 }
        );
      }
      let targetId: string | null = null;
      if (rawTargetId) {
        const target = await db.target.findUnique({ where: { id: rawTargetId } });
        if (!target || target.userId !== user.id) {
          return NextResponse.json({ ok: false, error: "Target not found" }, { status: 404 });
        }
        targetId = target.id;
      }
      const created = await db.chatSession.create({
        data: { targetId, userId: user.id },
      });
      session = { id: created.id, targetId };
    }

    if (!session) {
      return NextResponse.json({ ok: false, error: "Could not resolve session" }, { status: 400 });
    }

    // ---- Load target (if any) + history, persist the user message --------
    const target = session.targetId
      ? await db.target.findUnique({ where: { id: session.targetId } })
      : null;
    if (session.targetId && !target) {
      return NextResponse.json({ ok: false, error: "Target not found" }, { status: 404 });
    }

    const historyRows = await db.chatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: "desc" },
      take: HISTORY_TURNS,
    });
    historyRows.reverse();
    if (historyRows.length === 0) {
      await db.chatSession
        .update({
          where: { id: session.id },
          data: { title: message.slice(0, 60) || "New investigation" },
        })
        .catch(() => undefined);
    }

    const userMessage = await db.chatMessage.create({
      data: { sessionId: session.id, role: "user", content: message },
    });

    await audit("chat.message", {
      userId: user.id,
      ip: clientIp(req),
      detail: `session=${session.id} target=${session.targetId ?? "free"} chars=${message.length}`,
    });

    const encoder = new TextEncoder();
    let closed = false;
    req.signal.addEventListener("abort", () => {
      closed = true;
    });

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          } catch {
            /* stream already gone */
          }
        };
        try {
          // First event: lets the client pin the sidebar to this session.
          send({
            type: "session_saved",
            sessionId: session!.id,
            title: message.slice(0, 60) || "New investigation",
            targetId: session!.targetId,
          });
          send({ type: "user_saved", messageId: userMessage.id });
          const { content } = await runAgentLoop({
            sessionId: session!.id,
            target: target ?? null,
            userId: user.id,
            userMessage: message,
            history: historyRows.map((m) => ({
              role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
              content: m.content.slice(0, 4000),
            })),
            events: {
              onModelResolved: (info) => send({ type: "model", ...info }),
              onToolCall: (tool, args) => send({ type: "tool_call", tool, args }),
              onToolResult: (tool, result) =>
                send({ type: "tool_result", tool, preview: result.slice(0, 1000) }),
              shouldCancel: () => closed || req.signal.aborted,
            },
          });
          send({ type: "assistant", content });
        } catch (err) {
          send({
            type: "error",
            error: err instanceof Error ? err.message : "Agent failure",
          });
        } finally {
          send({ type: "done" });
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
      cancel() {
        closed = true;
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    console.error("chat POST error:", err);
    return NextResponse.json({ ok: false, error: "Internal error" }, { status: 500 });
  }
}
