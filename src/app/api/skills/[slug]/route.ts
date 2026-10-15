import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { audit, clientIp, rateLimit } from "@/lib/security";
import { getSkill, installSkill, rateSkill } from "@/server/skills/registry";
import { runSkill, SkillRunError } from "@/server/skills/runtime";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * One skill — public detail + authenticated actions.
 *
 * GET  /api/skills/[slug]   → public: row metadata + parsed manifest +
 *                             ratings summary (recent comments included).
 * POST /api/skills/[slug]   → auth required. Body:
 *   { action: "install" }                         → install (counter once/user)
 *   { action: "rate", score: 1-5, comment? }      → upsert the user's rating
 *   { action: "run", question, targetId? }        → sandboxed execution; the
 *                             response carries the full transcript (answer +
 *                             tool-call receipts + audit trail).
 */

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;
    const skill = await getSkill(slug);
    if (!skill) {
      return NextResponse.json({ ok: false, error: "Skill not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, skill });
  } catch (err) {
    console.error("[api/skills/[slug]] GET failed:", err);
    return NextResponse.json(
      { ok: false, error: "Could not load skill" },
      { status: 500 }
    );
  }
}

interface SkillActionBody {
  action?: unknown;
  score?: unknown;
  comment?: unknown;
  question?: unknown;
  targetId?: unknown;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Authentication required" },
        { status: 401 }
      );
    }
    const { slug } = await params;

    let body: SkillActionBody;
    try {
      body = (await req.json()) as SkillActionBody;
    } catch {
      return NextResponse.json(
        { ok: false, error: "Body must be JSON: { action: install | rate | run }" },
        { status: 400 }
      );
    }
    const action = typeof body.action === "string" ? body.action : "";

    if (action === "install") {
      const limit = rateLimit(`skills.install:${user.id}`, 60, 60 * 60 * 1000);
      if (!limit.allowed) {
        return NextResponse.json(
          { ok: false, error: `Too many installs — retry in ${limit.retryAfterSec}s` },
          { status: 429 }
        );
      }
      try {
        const result = await installSkill(slug, user.id);
        void audit("skills.install", {
          userId: user.id,
          detail: `${slug} (${result.installed ? "first install" : "already installed"}) — total ${result.installs}`,
          ip: clientIp(req),
        });
        return NextResponse.json({ ok: true, ...result });
      } catch (err) {
        return NextResponse.json(
          { ok: false, error: err instanceof Error ? err.message : "Install failed" },
          { status: 404 }
        );
      }
    }

    if (action === "rate") {
      const limit = rateLimit(`skills.rate:${user.id}`, 60, 60 * 60 * 1000);
      if (!limit.allowed) {
        return NextResponse.json(
          { ok: false, error: `Too many ratings — retry in ${limit.retryAfterSec}s` },
          { status: 429 }
        );
      }
      const score = typeof body.score === "number" ? Math.floor(body.score) : Number.NaN;
      const comment =
        typeof body.comment === "string" && body.comment.trim()
          ? body.comment.trim().slice(0, 1000)
          : undefined;
      try {
        const result = await rateSkill(slug, user.id, score, comment);
        void audit("skills.rate", {
          userId: user.id,
          detail: `${slug} score=${result.score} → sum=${result.ratingSum} count=${result.ratingCount}`,
          ip: clientIp(req),
        });
        return NextResponse.json({ ok: true, ...result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Rating failed";
        const notFound = msg.includes("not found");
        return NextResponse.json(
          { ok: false, error: msg },
          { status: notFound ? 404 : 400 }
        );
      }
    }

    if (action === "run") {
      // A skill run is a constrained agent run: model calls + tool executions
      // — tight per-user rate limit, generous route duration (maxDuration).
      const limit = rateLimit(`skills.run:${user.id}`, 10, 10 * 60 * 1000);
      if (!limit.allowed) {
        void audit("skills.run_rejected", {
          userId: user.id,
          detail: `rate limited for ${slug}`,
          ip: clientIp(req),
          severity: "warn",
        });
        return NextResponse.json(
          { ok: false, error: `Too many skill runs — retry in ${limit.retryAfterSec}s` },
          { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
        );
      }
      const question = typeof body.question === "string" ? body.question : "";
      const targetId =
        typeof body.targetId === "string" && body.targetId.trim()
          ? body.targetId.trim()
          : undefined;
      if (!question.trim()) {
        return NextResponse.json(
          { ok: false, error: "Field 'question' is required to run a skill" },
          { status: 400 }
        );
      }
      try {
        const run = await runSkill(slug, { userId: user.id, question, targetId });
        return NextResponse.json({ ok: true, run });
      } catch (err) {
        if (err instanceof SkillRunError) {
          return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
        }
        console.error("[api/skills/[slug]] run failed:", err);
        return NextResponse.json(
          { ok: false, error: err instanceof Error ? err.message.slice(0, 400) : "Skill run failed" },
          { status: 500 }
        );
      }
    }

    return NextResponse.json(
      { ok: false, error: "Unknown action — expected install | rate | run" },
      { status: 400 }
    );
  } catch (err) {
    console.error("[api/skills/[slug]] POST failed:", err);
    return NextResponse.json(
      { ok: false, error: "Action failed" },
      { status: 500 }
    );
  }
}
