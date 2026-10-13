import { NextResponse } from "next/server";
import { audit, clientIp, rateLimit } from "@/lib/security";
import { requireProject, unauthorized, badRequest, serverError } from "@/server/platform/api-helpers";
import {
  listFiles, readFile, writeFile, patchFile, runCommand, workspaceStatus,
} from "@/server/platform/builder";

export const runtime = "nodejs";
export const maxDuration = 120;

interface Ctx {
  params: Promise<{ id: string }>;
}

/** GET /api/projects/[id]/workspace — status + top-level entries. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const auth = await requireProject(id);
    if (auth instanceof NextResponse) return auth;
    const status = await workspaceStatus(id);
    return NextResponse.json({ ok: true, workspace: status });
  } catch (err) {
    console.error("workspace status error:", err);
    return serverError("Could not read workspace");
  }
}

/**
 * POST /api/projects/[id]/workspace — builder operations:
 *   read | write | patch | terminal | list
 * Every op is sandbox-checked, audited, and rate-limited.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const auth = await requireProject(id);
    if (auth instanceof NextResponse) return auth;
    const ip = clientIp(req);
    const body = (await req.json().catch(() => null)) as {
      op?: string; path?: string; content?: string; find?: string; replace?: string; command?: string;
    } | null;
    if (!body?.op) return badRequest("op is required (read|write|patch|terminal|list)");

    const op = body.op;
    const limit = rateLimit(
      `workspace:${op}:${auth.user.id}`,
      op === "terminal" ? 60 : 120,
      60 * 60 * 1000
    );
    if (!limit.allowed) {
      return NextResponse.json({ ok: false, error: `Rate limit reached. Try again in ${limit.retryAfterSec}s.` }, { status: 429 });
    }

    switch (op) {
      case "list": {
        const entries = await listFiles(id, (body.path ?? "").slice(0, 300));
        return NextResponse.json({ ok: true, entries });
      }
      case "read": {
        if (!body.path) return badRequest("path is required for read");
        const content = await readFile(id, body.path);
        return NextResponse.json({ ok: true, path: body.path, content: content.slice(0, 200_000) });
      }
      case "write": {
        if (!body.path || typeof body.content !== "string") return badRequest("path and content are required for write");
        const r = await writeFile(id, body.path, body.content);
        await audit("builder.write", { userId: auth.user.id, detail: `${auth.project.name}: ${body.path} (${r.bytes}B)`, ip });
        return NextResponse.json({ ok: true, ...r });
      }
      case "patch": {
        if (!body.path || typeof body.find !== "string" || typeof body.replace !== "string") {
          return badRequest("path, find and replace are required for patch");
        }
        const r = await patchFile(id, body.path, body.find, body.replace);
        await audit("builder.patch", {
          userId: auth.user.id,
          detail: `${auth.project.name}: ${body.path} → ${r.applied ? "applied" : r.reason}`,
          ip,
          severity: r.applied ? "info" : "warn",
        });
        return NextResponse.json({ ok: r.applied, ...r });
      }
      case "terminal": {
        if (!body.command || typeof body.command !== "string") return badRequest("command is required for terminal");
        const r = await runCommand(id, body.command, 60_000);
        await audit("builder.terminal", {
          userId: auth.user.id,
          detail: `${auth.project.name}: ${body.command.slice(0, 120)} → exit ${r.exitCode}${r.blocked ? " (blocked)" : ""}`,
          ip,
          severity: r.blocked ? "warn" : "info",
        });
        return NextResponse.json({ ok: !r.blocked && r.exitCode === 0, ...r });
      }
      default:
        return badRequest("op must be read|write|patch|terminal|list");
    }
  } catch (err) {
    console.error("workspace op error:", err);
    return serverError(err instanceof Error ? err.message.slice(0, 200) : "Workspace operation failed");
  }
}
