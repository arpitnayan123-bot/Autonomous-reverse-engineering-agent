import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { audit, clientIp, rateLimit } from "@/lib/security";

export const runtime = "nodejs";

/** Bounds for the content search. */
const MIN_QUERY_CHARS = 2;
const MAX_QUERY_CHARS = 120;
const MAX_RESULTS = 40;
/** Characters of context shown around each match. */
const SNIPPET_CONTEXT = 48;
/** Upper bound of recent messages scanned per query (SQLite LIKE scan). */
const SCAN_LIMIT = 2000;

/** Strip LIKE wildcards so user input cannot match-everything. */
function sanitizeQuery(raw: string): string {
  return raw.replace(/[%_\\]/g, " ").trim();
}

/** Collapse whitespace/newlines so snippets render on one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Build a ±SNIPPET_CONTEXT snippet around the first case-insensitive match. */
function snippetAround(content: string, query: string): string {
  const flat = oneLine(content);
  const idx = flat.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) {
    return flat.slice(0, SNIPPET_CONTEXT * 2) + (flat.length > SNIPPET_CONTEXT * 2 ? "…" : "");
  }
  const start = Math.max(0, idx - SNIPPET_CONTEXT);
  const end = Math.min(flat.length, idx + query.length + SNIPPET_CONTEXT);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < flat.length ? "…" : "";
  return prefix + flat.slice(start, end) + suffix;
}

/** GET /api/chat/search?q= — full-text search across the user's chat messages. */
export async function GET(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const ip = clientIp(req);
    const rl = rateLimit(`chat-search:${user.id}:${ip}`, 30, 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { ok: false, error: "Too many searches — slow down." },
        { status: 429, headers: { "Retry-After": String(Math.ceil(rl.retryAfterSec)) } }
      );
    }

    const q = sanitizeQuery(new URL(req.url).searchParams.get("q") ?? "");
    if (q.length < MIN_QUERY_CHARS) {
      return NextResponse.json({ ok: true, results: [], query: q });
    }
    if (q.length > MAX_QUERY_CHARS) {
      return NextResponse.json(
        { ok: false, error: `Query too long (max ${MAX_QUERY_CHARS} chars)` },
        { status: 400 }
      );
    }

    const rows = await db.chatMessage.findMany({
      where: {
        content: { contains: q },
        session: { userId: user.id },
        role: { in: ["user", "assistant"] },
      },
      orderBy: { createdAt: "desc" },
      take: SCAN_LIMIT,
      select: {
        id: true,
        sessionId: true,
        role: true,
        content: true,
        createdAt: true,
        session: {
          select: {
            title: true,
            target: { select: { originalName: true, detectedFormat: true } },
          },
        },
      },
    });

    // Rank: prefer messages whose match is earlier in the text (simple
    // relevance heuristic — a match at position 0 beats one at 4000),
    // then newest first.
    const results = rows
      .map((r) => {
        const idx = oneLine(r.content).toLowerCase().indexOf(q.toLowerCase());
        return {
          messageId: r.id,
          sessionId: r.sessionId,
          sessionTitle: r.session.title,
          targetName: r.session.target?.originalName ?? null,
          detectedFormat: r.session.target?.detectedFormat ?? null,
          role: r.role as "user" | "assistant",
          snippet: snippetAround(r.content, q),
          createdAt: r.createdAt,
          rank: idx === -1 ? Number.MAX_SAFE_INTEGER : idx,
        };
      })
      .sort((a, b) => a.rank - b.rank || +b.createdAt - +a.createdAt)
      .slice(0, MAX_RESULTS)
      .map(({ rank: _rank, ...rest }) => rest);

    if (results.length > 0) {
      void audit("chat.message_search", {
        userId: user.id,
        ip,
        detail: `q="${q.slice(0, 60)}" hits=${results.length}`,
      });
    }

    return NextResponse.json({ ok: true, results, query: q });
  } catch (err) {
    console.error("[chat/search] failed:", err);
    return NextResponse.json({ ok: false, error: "Search failed" }, { status: 500 });
  }
}
