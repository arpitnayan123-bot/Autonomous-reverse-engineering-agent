import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { audit, clientIp, rateLimit } from "@/lib/security";
import { listSkills, publishSkill } from "@/server/skills/registry";

export const runtime = "nodejs";

/**
 * Community skills marketplace — the public catalog surface (Capability C5).
 *
 * GET  /api/skills          → list published skills (PUBLIC read: metadata,
 *                             checksum, rating aggregates, install counts).
 * POST /api/skills          → publish a skill (auth required). Body:
 *                             { manifest: <area-skill manifest v1 object> }
 *                             The manifest is validated, canonicalized and
 *                             checksummed; republishing a slug requires a
 *                             strictly greater semver.
 */

export async function GET() {
  try {
    const skills = await listSkills();
    return NextResponse.json({ ok: true, skills });
  } catch (err) {
    console.error("[api/skills] GET failed:", err);
    return NextResponse.json(
      { ok: false, error: "Could not list skills" },
      { status: 500 }
    );
  }
}

interface PublishBody {
  manifest?: unknown;
}

export async function POST(req: Request) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Authentication required" },
        { status: 401 }
      );
    }
    // Publishing is a heavyweight write — rate limit per user.
    const limit = rateLimit(`skills.publish:${user.id}`, 10, 60 * 60 * 1000);
    if (!limit.allowed) {
      void audit("skills.publish_rejected", {
        userId: user.id,
        detail: "rate limited",
        ip: clientIp(req),
        severity: "warn",
      });
      return NextResponse.json(
        {
          ok: false,
          error: `Too many publishes — retry in ${limit.retryAfterSec}s`,
        },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
      );
    }

    let body: PublishBody;
    try {
      body = (await req.json()) as PublishBody;
    } catch {
      return NextResponse.json(
        { ok: false, error: "Body must be JSON: { manifest: <object> }" },
        { status: 400 }
      );
    }
    if (typeof body?.manifest !== "object" || body.manifest === null) {
      return NextResponse.json(
        { ok: false, error: "Field 'manifest' is required (a area-skill manifest v1 object)" },
        { status: 400 }
      );
    }

    const result = await publishSkill({
      manifestJson: body.manifest,
      author: user.id,
    });
    if (!result.ok) {
      void audit("skills.publish_rejected", {
        userId: user.id,
        detail: result.errors.join("; ").slice(0, 500),
        ip: clientIp(req),
        severity: "warn",
      });
      const downgrade = result.errors.some((e) => e.includes("downgrade rejected"));
      return NextResponse.json(
        {
          ok: false,
          error: downgrade ? result.errors[0] : "Manifest validation failed",
          errors: result.errors,
        },
        { status: downgrade ? 409 : 400 }
      );
    }

    void audit("skills.publish", {
      userId: user.id,
      detail: `${result.skill.slug}@${result.skill.version} (${result.created ? "created" : "upgraded"}) checksum=${result.skill.checksum.slice(0, 16)}`,
      ip: clientIp(req),
    });

    return NextResponse.json({
      ok: true,
      created: result.created,
      skill: {
        id: result.skill.id,
        slug: result.skill.slug,
        name: result.skill.name,
        version: result.skill.version,
        checksum: result.skill.checksum,
        status: result.skill.status,
      },
    });
  } catch (err) {
    console.error("[api/skills] POST failed:", err);
    return NextResponse.json(
      { ok: false, error: "Could not publish skill" },
      { status: 500 }
    );
  }
}
