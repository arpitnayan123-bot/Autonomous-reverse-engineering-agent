import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit, clientIp, rateLimit } from "@/lib/security";
import { getSessionUser, } from "@/lib/auth";
import { unauthorized, badRequest, serverError } from "@/server/platform/api-helpers";
import { BUILTINS, sealHeaders } from "@/server/platform/connectors";
import { assertPublicUrl, BlockedUrlError } from "@/server/platform/net";

export const runtime = "nodejs";
export const maxDuration = 60;

/** GET /api/connectors — builtins + the user's registered connectors. */
export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const connectors = await db.connector.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
    });
    return NextResponse.json({
      ok: true,
      builtins: BUILTINS,
      connectors: connectors.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        endpoint: c.kind === "mcp" ? `${c.endpoint} ${(safeArgs(c.config)).join(" ")}`.trim() : c.endpoint,
        hasSecrets: Boolean(c.sealedHeaders),
        status: c.status,
        lastCheckedAt: c.lastCheckedAt,
        lastError: c.lastError,
        createdAt: c.createdAt,
      })),
    });
  } catch {
    return serverError("Could not list connectors");
  }
}

/** POST /api/connectors — register an http or mcp connector. */
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const ip = clientIp(req);
    const limit = rateLimit(`connectors:create:${user.id}`, 30, 60 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json({ ok: false, error: "Rate limit reached" }, { status: 429 });
    }

    const body = (await req.json().catch(() => null)) as {
      name?: string; kind?: string; endpoint?: string; headers?: Record<string, string>;
      config?: { args?: string[]; method?: string; tool?: string };
    } | null;
    if (!body) return badRequest("JSON body required");
    const name = (body.name ?? "").trim().slice(0, 100);
    if (!name) return badRequest("name is required");
    const kind = body.kind;
    if (kind !== "http" && kind !== "mcp") return badRequest("kind must be http or mcp (builtins are pre-registered)");

    let endpoint: string;
    let configJson: string | null = null;
    if (kind === "http") {
      endpoint = (body.endpoint ?? "").trim();
      if (!/^https?:\/\//i.test(endpoint)) return badRequest("http connectors need an http(s) endpoint");
      try {
        await assertPublicUrl(endpoint);
      } catch (err) {
        return badRequest(err instanceof BlockedUrlError ? err.message : "URL rejected");
      }
      if (body.config?.method && !["GET", "POST"].includes(body.config.method)) {
        return badRequest("config.method must be GET or POST");
      }
      configJson = JSON.stringify({ method: body.config?.method ?? "POST" });
    } else {
      // MCP stdio: command must be a bare allowlisted binary; args are
      // tokenized server-side and re-serialized (no shell ever involved).
      endpoint = (body.endpoint ?? "").trim();
      const allowed = ["node", "bun", "npx", "bunx", "python3", "uvx"];
      if (!allowed.includes(endpoint)) {
        return badRequest(`mcp connector command must be one of: ${allowed.join(", ")} (bare name, no paths)`);
      }
      const args = Array.isArray(body.config?.args)
        ? body.config!.args!.map((a) => String(a).slice(0, 300)).slice(0, 12)
        : [];
      configJson = JSON.stringify({ args });
    }

    // Headers may carry auth secrets — seal them with the vault.
    const headers = body.headers && typeof body.headers === "object" ? body.headers : {};
    const sealed = sealHeaders(headers);

    const connector = await db.connector.create({
      data: {
        userId: user.id,
        name,
        kind,
        endpoint,
        config: configJson,
        sealedHeaders: sealed,
      },
    });
    await audit("connector.create", { userId: user.id, detail: `${kind}: ${name}`, ip });
    return NextResponse.json({ ok: true, connector: { id: connector.id, name: connector.name, kind: connector.kind } });
  } catch (err) {
    console.error("connector create error:", err);
    return serverError("Could not create connector");
  }
}

function safeArgs(configJson: string | null): string[] {
  if (!configJson) return [];
  try {
    const v = JSON.parse(configJson) as { args?: string[] };
    return Array.isArray(v.args) ? v.args : [];
  } catch {
    return [];
  }
}
