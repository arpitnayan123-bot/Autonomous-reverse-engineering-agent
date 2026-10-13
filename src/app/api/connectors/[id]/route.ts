import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit, clientIp, isSafeId, rateLimit } from "@/lib/security";
import { getSessionUser } from "@/lib/auth";
import { unauthorized, badRequest, serverError } from "@/server/platform/api-helpers";
import { testConnector, invokeConnector } from "@/server/platform/connectors";

export const runtime = "nodejs";
export const maxDuration = 120;

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/connectors/[id] — actions:
 *   test    → health-check the connector (http probe / MCP tools/list)
 *   invoke  → run the connector with a JSON input
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    if (!isSafeId(id)) return badRequest("invalid connector id");
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const ip = clientIp(req);
    const body = (await req.json().catch(() => ({}))) as {
      action?: string; input?: Record<string, unknown>;
    };
    const action = body.action ?? "test";

    const limit = rateLimit(`connectors:${action}:${user.id}`, 40, 60 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json({ ok: false, error: "Rate limit reached" }, { status: 429 });
    }

    if (action === "test") {
      const result = await testConnector(id, user.id);
      // Envelope ok = the test RAN. result.ok carries reachability — an
      // unreachable connector is a valid, well-formed test outcome.
      return NextResponse.json({ ok: true, result });
    }
    if (action === "invoke") {
      const connector = await db.connector.findFirst({ where: { id, userId: user.id } });
      if (!connector) return badRequest("connector not found");
      const result = await invokeConnector(id, user.id, body.input ?? {});
      return NextResponse.json({ ok: true, result: { ok: result.ok, detail: result.detail, kind: result.kind } });
    }
    return badRequest("action must be test or invoke");
  } catch (err) {
    console.error("connector action error:", err);
    return serverError("Connector action failed");
  }
}

/** DELETE /api/connectors/[id] — unregister a connector. */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    if (!isSafeId(id)) return badRequest("invalid connector id");
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const ip = clientIp(req);
    const connector = await db.connector.findFirst({ where: { id, userId: user.id } });
    if (!connector) return badRequest("connector not found");
    await db.connector.delete({ where: { id } });
    await audit("connector.delete", { userId: user.id, detail: connector.name, ip, severity: "warn" });
    return NextResponse.json({ ok: true });
  } catch {
    return serverError("Could not delete connector");
  }
}
