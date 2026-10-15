/**
 * Skill registry — DB helpers over the Skill / SkillInstall / SkillRating
 * tables (Capability C5, Community Skills Marketplace).
 *
 * Integrity model:
 *  - a published manifest is stored in its CANONICAL JSON form and its
 *    sha256 checksum travels on the row, so any tampering with the stored
 *    manifest is detectable by recomputing checksumOf(JSON.parse(manifest));
 *  - republishing a slug requires a STRICTLY GREATER semver — downgrades and
 *    same-version republishes are rejected (same-version republishes would
 *    silently change what a checksummed version means);
 *  - installs are counted ONCE per (skill, user) — a re-install is a no-op;
 *  - rating aggregates (ratingSum / ratingCount) are always RECOMPUTED from
 *    the SkillRating table after every upsert, never incremented in place,
 *    so a changed rating replaces the old one exactly.
 */

import { db } from "@/lib/db";
import {
  canonicalize,
  checksumOf,
  compareSemver,
  validateManifest,
  type SkillManifest,
} from "./manifest";
import type { Skill, SkillRating } from "@prisma/client";

// ---------------------------------------------------------------------------
// Read shapes
// ---------------------------------------------------------------------------

export interface SkillSummary {
  id: string;
  slug: string;
  name: string;
  version: string;
  author: string;
  description: string;
  status: string;
  checksum: string;
  bundled: boolean;
  signed: boolean;
  installs: number;
  rating: { sum: number; count: number; avg: number };
  createdAt: string;
  updatedAt: string;
}

export interface SkillDetail extends SkillSummary {
  manifest: SkillManifest;
  ratings: Array<Pick<SkillRating, "score" | "comment"> & { createdAt: string }>;
}

/** Public projection of a Skill row (rating avg derived, never stored). */
function toSummary(s: Skill): SkillSummary {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    version: s.version,
    author: s.author,
    description: s.description,
    status: s.status,
    checksum: s.checksum,
    bundled: s.bundled,
    signed: !!s.signature,
    installs: s.installs,
    rating: {
      sum: s.ratingSum,
      count: s.ratingCount,
      avg: s.ratingCount > 0 ? Math.round((s.ratingSum / s.ratingCount) * 10) / 10 : 0,
    },
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** List marketplace skills, most-installed first. Disabled skills are hidden
 * unless explicitly included (admin view). */
export async function listSkills(opts?: {
  includeDisabled?: boolean;
}): Promise<SkillSummary[]> {
  const rows = await db.skill.findMany({
    where: opts?.includeDisabled ? undefined : { status: "published" },
    orderBy: [{ installs: "desc" }, { createdAt: "asc" }],
  });
  return rows.map(toSummary);
}

/** One skill with its parsed manifest and a ratings summary (recent first). */
export async function getSkill(slug: string): Promise<SkillDetail | null> {
  const s = await db.skill.findUnique({ where: { slug } });
  if (!s) return null;
  let manifest: SkillManifest;
  try {
    manifest = JSON.parse(s.manifest) as SkillManifest;
  } catch {
    // A corrupt stored manifest must never 500 the read path — surface it as
    // an empty entry so the UI can still render the row's metadata.
    manifest = {
      slug: s.slug,
      name: s.name,
      version: s.version,
      description: s.description,
      entry: { system: "", opening: "" },
      permissions: [],
      limits: { toolCalls: 0, workspaceBytes: 0, timeoutMs: 0 },
    };
  }
  const ratings = await db.skillRating.findMany({
    where: { skillId: s.id },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return {
    ...toSummary(s),
    manifest,
    ratings: ratings.map((r) => ({
      score: r.score,
      comment: r.comment,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export type PublishResult =
  | { ok: true; skill: Skill; created: boolean }
  | { ok: false; errors: string[] };

/**
 * Validate and store a skill manifest. `manifestJson` may be an object or a
 * JSON string. The stored manifest is the CANONICAL form; the checksum is
 * computed over it. Republishing an existing slug requires a strictly
 * greater semver (downgrades and equal-version republishes are rejected).
 * Passing `bundled` only ever SETS the flag (a community republish cannot
 * unbundle a shipped skill).
 */
export async function publishSkill(opts: {
  manifestJson: unknown;
  author: string;
  bundled?: boolean;
}): Promise<PublishResult> {
  let json: unknown = opts.manifestJson;
  if (typeof json === "string") {
    try {
      json = JSON.parse(json);
    } catch (err) {
      return {
        ok: false,
        errors: [
          `manifestJson: not valid JSON — ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`,
        ],
      };
    }
  }
  const validated = validateManifest(json);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  const manifest = validated.manifest;

  const canonical = canonicalize(manifest);
  const checksum = checksumOf(manifest);

  const existing = await db.skill.findUnique({ where: { slug: manifest.slug } });
  if (existing) {
    const cmp = compareSemver(manifest.version, existing.version);
    if (Number.isNaN(cmp)) {
      return { ok: false, errors: [`manifest.version: "${manifest.version}" is not valid semver`] };
    }
    if (cmp <= 0) {
      return {
        ok: false,
        errors: [
          `version downgrade rejected: ${manifest.slug} is already at ${existing.version}; a republish requires a version GREATER than ${existing.version} (got ${manifest.version})`,
        ],
      };
    }
    const skill = await db.skill.update({
      where: { slug: manifest.slug },
      data: {
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        manifest: canonical,
        checksum,
        author: opts.author,
        ...(opts.bundled ? { bundled: true } : {}),
      },
    });
    return { ok: true, skill, created: false };
  }

  const skill = await db.skill.create({
    data: {
      slug: manifest.slug,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      manifest: canonical,
      checksum,
      author: opts.author,
      bundled: !!opts.bundled,
      status: "published",
    },
  });
  return { ok: true, skill, created: true };
}

/** Take a skill out of the marketplace (installs/runs refuse while disabled). */
export async function disableSkill(slug: string): Promise<Skill | null> {
  const existing = await db.skill.findUnique({ where: { slug } });
  if (!existing) return null;
  return db.skill.update({ where: { slug }, data: { status: "disabled" } });
}

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

export interface RateResult {
  skillId: string;
  slug: string;
  score: number;
  ratingSum: number;
  ratingCount: number;
  avg: number;
}

/**
 * Upsert the user's rating on (skillId, userId) — re-rating REPLACES the old
 * score — then recompute ratingSum/ratingCount from the table (never
 * incremented in place, so aggregates cannot drift).
 */
export async function rateSkill(
  slug: string,
  userId: string,
  score: number,
  comment?: string
): Promise<RateResult> {
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new Error(`score must be an integer 1-5 (got ${JSON.stringify(score)})`);
  }
  const skill = await db.skill.findUnique({ where: { slug } });
  if (!skill) throw new Error(`skill "${slug}" not found`);

  const trimmedComment =
    typeof comment === "string" && comment.trim() ? comment.trim().slice(0, 1000) : null;

  await db.skillRating.upsert({
    where: { skillId_userId: { skillId: skill.id, userId } },
    create: { skillId: skill.id, userId, score, comment: trimmedComment },
    update: { score, comment: trimmedComment },
  });

  const agg = await db.skillRating.aggregate({
    where: { skillId: skill.id },
    _sum: { score: true },
    _count: { _all: true },
  });
  const ratingSum = agg._sum.score ?? 0;
  const ratingCount = agg._count._all;

  await db.skill.update({
    where: { id: skill.id },
    data: { ratingSum, ratingCount },
  });

  return {
    skillId: skill.id,
    slug: skill.slug,
    score,
    ratingSum,
    ratingCount,
    avg: ratingCount > 0 ? Math.round((ratingSum / ratingCount) * 10) / 10 : 0,
  };
}

// ---------------------------------------------------------------------------
// Installs
// ---------------------------------------------------------------------------

export interface InstallResult {
  installed: boolean; // false = already installed (counter NOT re-incremented)
  installs: number;
}

/**
 * Upsert the SkillInstall for (skill, user) and increment the installs
 * counter ONLY on the first install. Disabled skills refuse installation.
 */
export async function installSkill(slug: string, userId: string): Promise<InstallResult> {
  const skill = await db.skill.findUnique({ where: { slug } });
  if (!skill) throw new Error(`skill "${slug}" not found`);
  if (skill.status !== "published") {
    throw new Error(`skill "${slug}" is ${skill.status} — installation refused`);
  }

  const existing = await db.skillInstall.findUnique({
    where: { skillId_userId: { skillId: skill.id, userId } },
  });
  if (existing) {
    return { installed: false, installs: skill.installs };
  }

  const created = await db.skillInstall.create({
    data: { skillId: skill.id, userId },
  });
  const updated = await db.skill.update({
    where: { id: skill.id },
    data: { installs: { increment: 1 } },
  });
  return { installed: !!created, installs: updated.installs };
}
