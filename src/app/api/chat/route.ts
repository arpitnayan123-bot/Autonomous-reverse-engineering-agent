import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { audit, clientIp, rateLimit } from "@/lib/security";
import { runAgentLoop } from "@/server/agent/agent";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_MESSAGE_CHARS = 8000;
const HISTORY_TURNS = 20;

/** POST /api/chat — SSE stream of an agent investigation turn. */
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
      targetId?: unknown;
      message?: unknown;
    } | null;
    const targetId = typeof body?.targetId === "string" ? body.targetId : "";
    let message = typeof body?.message === "string" ? body.message : "";
    message = message.slice(0, MAX_MESSAGE_CHARS).trim();
    if (!targetId || !message) {
      return NextResponse.json(
        { ok: false, error: "targetId and message are required (message ≤ 8000 chars)" },
        { status: 400 }
      );
    }

    const target = await db.target.findUnique({ where: { id: targetId } });
    if (!target || target.userId !== user.id) {
      return NextResponse.json({ ok: false, error: "Target not found" }, { status: 404 });
    }

    // Get-or-create the per-(target,user) chat session.
    const session = await db.chatSession.upsert({
      where: { targetId_userId: { targetId, userId: user.id } },
      update: {},
      create: { targetId, userId: user.id },
    });

    // History BEFORE persisting the new user message; also tells us if it's
    // the first message (title = first 60 chars).
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
      detail: `target=${targetId} chars=${message.length}`,
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
          send({ type: "user_saved", messageId: userMessage.id });
          const { content } = await runAgentLoop({
            sessionId: session.id,
            target,
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

/** GET /api/chat?targetId= — message history for the session. */
export async function GET(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    const targetId = new URL(req.url).searchParams.get("targetId") ?? "";
    if (!targetId) {
      return NextResponse.json({ ok: false, error: "targetId is required" }, { status: 400 });
    }
    const target = await db.target.findUnique({ where: { id: targetId } });
    if (!target || target.userId !== user.id) {
      return NextResponse.json({ ok: false, error: "Target not found" }, { status: 404 });
    }
    const session = await db.chatSession.findUnique({
      where: { targetId_userId: { targetId, userId: user.id } },
    });
    if (!session) {
      return NextResponse.json({ ok: true, session: null, messages: [] });
    }
    const messages = await db.chatMessage.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: "asc" },
      take: 200,
    });
    return NextResponse.json({
      ok: true,
      session: { id: session.id, title: session.title },
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
