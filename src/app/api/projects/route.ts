import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { audit, clientIp, rateLimit } from "@/lib/security";
import {
  requireProject, unauthorized, badRequest, serverError,
} from "@/server/platform/api-helpers";
import { parseGitHubRef } from "@/server/platform/research";
import { assertPublicUrl, BlockedUrlError } from "@/server/platform/net";

export const runtime = "nodejs";
export const maxDuration = 60;

/** GET /api/projects — list the user's projects with activity counters. */
export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const projects = await db.project.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: "desc" },
      include: {
        _count: { select: { pages: true, nodes: true, reports: true, orchestrations: true, verifications: true } },
        orchestrations: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, status: true, progress: true, currentStage: true },
        },
      },
    });
    return NextResponse.json({
      ok: true,
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        reference: p.reference,
        description: p.description,
        status: p.status,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        counts: {
          pages: p._count.pages,
          nodes: p._count.nodes,
          reports: p._count.reports,
          orchestrations: p._count.orchestrations,
          verifications: p._count.verifications,
        },
        lastOrchestration: p.orchestrations[0] ?? null,
      })),
    });
  } catch {
    return serverError("Could not list projects");
  }
}

/** POST /api/projects — create a website / github / file project. */
export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) return unauthorized();
    const ip = clientIp(req);
    const limit = rateLimit(`projects:create:${user.id}`, 30, 60 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        { ok: false, error: `Rate limit reached. Try again in ${limit.retryAfterSec}s.` },
        { status: 429 }
      );
    }

    const body = (await req.json().catch(() => null)) as {
      name?: string; kind?: string; reference?: string; description?: string; targetId?: string;
    } | null;
    if (!body) return badRequest("JSON body required");

    const kind = body.kind;
    if (kind !== "website" && kind !== "github" && kind !== "file") {
      return badRequest("kind must be website, github, or file");
    }
    const name = (body.name ?? "").trim().slice(0, 120);
    if (!name) return badRequest("name is required");

    let reference = "";
    if (kind === "website") {
      reference = (body.reference ?? "").trim();
      if (!/^https?:\/\//i.test(reference)) return badRequest("website projects need an http(s) reference URL");
      try {
        await assertPublicUrl(reference);
      } catch (err) {
        return badRequest(err instanceof BlockedUrlError ? err.message : "URL rejected");
      }
    } else if (kind === "github") {
      reference = (body.reference ?? "").trim();
      const parsed = parseGitHubRef(reference);
      if (!parsed) return badRequest("github projects need owner/repo or a github.com URL");
      reference = `${parsed.owner}/${parsed.repo}`;
    } else {
      // file project: reference points at an uploaded target owned by the user.
      const targetId = (body.targetId ?? "").trim();
      if (!targetId) return badRequest("file projects need targetId of an uploaded target");
      const target = await db.target.findFirst({ where: { id: targetId, userId: user.id } });
      if (!target) return badRequest("target not found");
      reference = `targets/${targetId}`;
    }

    const project = await db.project.create({
      data: {
        userId: user.id,
        name,
        kind,
        reference,
        description: (body.description ?? "").trim().slice(0, 500) || null,
      },
    });
    await audit("project.create", { userId: user.id, detail: `${kind}: ${name} → ${reference}`, ip });
    return NextResponse.json({ ok: true, project });
  } catch (err) {
    console.error("project create error:", err);
    return serverError("Could not create project");
  }
}
