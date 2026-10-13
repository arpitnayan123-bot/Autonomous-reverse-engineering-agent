import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/security";
import { requireProject, unauthorized, badRequest, serverError } from "@/server/platform/api-helpers";
import { crawlSite } from "@/server/platform/explorer";
import { tryBrowser } from "@/server/platform/browser";

export const runtime = "nodejs";
export const maxDuration = 300;

interface Ctx {
  params: Promise<{ id: string }>;
}

/** GET /api/projects/[id]/crawl — list crawled pages. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const auth = await requireProject(id);
    if (auth instanceof NextResponse) return auth;
    const pages = await db.crawlPage.findMany({
      where: { projectId: id },
      orderBy: [{ depth: "asc" }, { fetchedAt: "desc" }],
      take: 200,
    });
    return NextResponse.json({
      ok: true,
      pages: pages.map((p) => ({
        id: p.id,
        url: p.url,
        status: p.status,
        title: p.title,
        description: p.description,
        depth: p.depth,
        tech: p.tech ? safeArr(p.tech) : [],
        excerpt: p.textExcerpt?.slice(0, 400) ?? null,
        contentHash: p.contentHash,
        fetchedAt: p.fetchedAt,
      })),
    });
  } catch (err) {
    console.error("crawl list error:", err);
    return serverError("Could not list crawled pages");
  }
}

/** POST /api/projects/[id]/crawl — run a bounded polite crawl. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const auth = await requireProject(id);
    if (auth instanceof NextResponse) return auth;
    if (auth.project.kind !== "website") {
      return badRequest("crawling applies to website projects only");
    }
    const ip = clientIp(req);
    const limit = rateLimit(`crawl:${auth.user.id}`, 10, 30 * 60 * 1000);
    if (!limit.allowed) {
      return NextResponse.json(
        { ok: false, error: `Crawl rate limit reached. Try again in ${limit.retryAfterSec}s.` },
        { status: 429 }
      );
    }

    const body = (await req.json().catch(() => ({}))) as { maxPages?: number; maxDepth?: number; render?: boolean };
    const summary = await crawlSite(id, auth.project.reference, {
      maxPages: body.maxPages,
      maxDepth: body.maxDepth,
      concurrency: 3,
    });

    // Optional live browser snapshot of the entry page (capability-detected).
    let render: { available: boolean; title?: string; detail?: string; screenshotBase64?: string } | null = null;
    if (body.render) {
      const b = await tryBrowser(auth.project.reference, { screenshot: true, timeoutMs: 25_000 });
      render = b.available
        ? { available: true, title: b.title, screenshotBase64: b.screenshotBase64 }
        : { available: false, detail: b.detail };
    }

    await db.project.update({ where: { id }, data: { updatedAt: new Date() } });
    return NextResponse.json({ ok: true, summary, render });
  } catch (err) {
    console.error("crawl error:", err);
    return serverError("Crawl failed");
  }
}

function safeArr(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}
