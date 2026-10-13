import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { audit, clientIp, rateLimit } from "@/lib/security";
import { requireProject, unauthorized, badRequest, serverError } from "@/server/platform/api-helpers";
import { reverseEngineerWorkspace } from "@/server/platform/recon";
import {
  materializeGitHubRepo, materializeTarget, workspaceStatus, workspaceDir,
} from "@/server/platform/builder";
import { parseGitHubRef } from "@/server/platform/research";
import fsSync from "node:fs";

export const runtime = "nodejs";
export const maxDuration = 300;

interface Ctx {
  params: Promise<{ id: string }>;
}

/** GET /api/projects/[id]/recon — workspace status (what recon can parse). */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const auth = await requireProject(id);
    if (auth instanceof NextResponse) return auth;
    const status = await workspaceStatus(id);
    return NextResponse.json({ ok: true, workspace: status });
  } catch (err) {
    console.error("recon status error:", err);
    return serverError("Could not read workspace status");
  }
}

/**
 * POST /api/projects/[id]/recon — actions:
 *   materialize: pull the GitHub tarball / uploaded target into the workspace
 *   parse:       run tree-sitter recon over the workspace → knowledge graph
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const auth = await requireProject(id);
    if (auth instanceof NextResponse) return auth;
    if (auth.project.kind === "website") {
      return badRequest("recon parsing applies to github and file projects (websites use /crawl)");
    }
    const ip = clientIp(req);
    const limit = rateLimit(`recon:${auth.user.id}`, 15, 60 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json({ ok: false, error: `Rate limit reached. Try again in ${limit.retryAfterSec}s.` }, { status: 429 });
    }

    const body = (await req.json().catch(() => ({}))) as { action?: string };
    const action = body.action ?? "parse";

    if (action === "materialize") {
      if (auth.project.kind === "github") {
        const ref = parseGitHubRef(auth.project.reference);
        if (!ref) return badRequest("invalid github reference");
        const m = await materializeGitHubRepo(id, ref.owner, ref.repo);
        await audit("recon.materialize", { userId: auth.user.id, detail: `${auth.project.name}: ${m.detail}`, ip });
        return NextResponse.json({ ok: m.ok, detail: m.detail, workspace: await workspaceStatus(id) });
      }
      const targetId = auth.project.reference.replace(/^targets\//, "");
      const m = await materializeTarget(id, targetId);
      await audit("recon.materialize", { userId: auth.user.id, detail: `${auth.project.name}: ${m.detail}`, ip });
      return NextResponse.json({ ok: m.ok, detail: m.detail, workspace: await workspaceStatus(id) });
    }

    if (action === "parse") {
      const dir = workspaceDir(id);
      if (!fsSync.existsSync(dir)) {
        return badRequest("workspace is empty — run the materialize action first");
      }
      const summary = await reverseEngineerWorkspace(id, dir);
      await db.project.update({ where: { id }, data: { updatedAt: new Date() } });
      await audit("recon.parse", {
        userId: auth.user.id,
        detail: `${auth.project.name}: ${summary.filesParsed}/${summary.filesTotal} files, ${summary.symbols} symbols, ${summary.endpoints.length} endpoints`,
        ip,
      });
      return NextResponse.json({ ok: true, summary });
    }

    return badRequest("action must be materialize or parse");
  } catch (err) {
    console.error("recon error:", err);
    return serverError(err instanceof Error ? err.message.slice(0, 200) : "Recon failed");
  }
}
