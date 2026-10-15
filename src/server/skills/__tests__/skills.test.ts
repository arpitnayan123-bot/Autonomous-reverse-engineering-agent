#!/usr/bin/env bun
/**
 * Skills marketplace suite (Capability C5) — manifest validation, canonical
 * checksum, the registry's publish/downgrade/rating/install contract, and
 * the RUNTIME'S PERMISSION ENFORCEMENT — all offline (no LLM call, no tool
 * execution): the sandbox's guarantee chain starts at
 * filterAllowedTools/resolveSkillTool and those are exercised directly
 * against the REAL agent registry.
 *
 * DB-backed tests run against the REAL database (same setup as the agent
 * suites — plain string keys, synthetic slugs, deleted in afterAll with the
 * SkillInstall/SkillRating cascade).
 *
 * Run:  bun test src/server/skills/__tests__/skills.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import {
  DEFAULT_LIMITS,
  canonicalize,
  checksumOf,
  compareSemver,
  validateManifest,
  type SkillManifest,
} from "@/server/skills/manifest";
import {
  disableSkill,
  installSkill,
  listSkills,
  publishSkill,
  rateSkill,
} from "@/server/skills/registry";
import {
  filterAllowedTools,
  parseToolCalls,
  resolveSkillTool,
} from "@/server/skills/runtime";
import { AGENT_TOOLS } from "@/server/agent/tools";
import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function rand8(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

let seq = 0;
function makeManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  seq += 1;
  return {
    slug: `test-skill-${rand8()}-${seq}`,
    name: `Test Skill ${seq}`,
    version: "1.0.0",
    description: "A skill used by the marketplace test suite.",
    entry: {
      system: "You are a test skill. Answer honestly.",
      opening: "Test skill starting.",
    },
    permissions: ["web_research", "read_hex"],
    limits: { toolCalls: 5, workspaceBytes: 1024 * 1024, timeoutMs: 30_000 },
    ...overrides,
  };
}

afterAll(async () => {
  await db.skill.deleteMany({ where: { slug: { startsWith: "test-skill-" } } });
  await db.$disconnect();
});

// ---------------------------------------------------------------------------
// (a) Manifest validation
// ---------------------------------------------------------------------------

describe("manifest validation", () => {
  test("accepts a valid manifest and applies limits defaults", () => {
    const raw = makeManifest() as unknown as Record<string, unknown>;
    delete raw.limits; // omitted limits must default
    const result = validateManifest(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.slug).toMatch(/^[a-z0-9][a-z0-9-]{1,48}$/);
    expect(result.manifest.limits).toEqual({ ...DEFAULT_LIMITS });
    // Normalized shape: only known keys survive.
    expect(Object.keys(result.manifest).sort()).toEqual(
      ["description", "entry", "limits", "name", "permissions", "slug", "version"]
    );
  });

  test("rejects a bad slug with a precise error", () => {
    const bad = makeManifest({ slug: "Bad_Slug!" });
    const result = validateManifest(bad);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("manifest.slug"))).toBe(true);
  });

  test("rejects a non-semver version", () => {
    const result = validateManifest(makeManifest({ version: "1.0" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("manifest.version") && e.includes("semver"))).toBe(
      true
    );
  });

  test("rejects oversize permissions (too many entries AND bad tool names)", () => {
    const many = Array.from({ length: 65 }, (_, i) => `tool_${i}`);
    const result = validateManifest(makeManifest({ permissions: many }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("65 entries — max 64"))).toBe(true);

    const result2 = validateManifest(
      makeManifest({ permissions: ["read_strings", "Not A Tool", "UPPER"] })
    );
    expect(result2.ok).toBe(false);
    if (result2.ok) return;
    expect(result2.errors.filter((e) => e.startsWith("manifest.permissions[")).length).toBe(2);
  });

  test("rejects an oversize description and system prompt", () => {
    const result = validateManifest(
      makeManifest({ description: "x".repeat(501) })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("manifest.description: 501 chars"))).toBe(true);

    const result2 = validateManifest({
      ...makeManifest(),
      entry: { system: "y".repeat(4001), opening: "ok" },
    });
    expect(result2.ok).toBe(false);
    if (result2.ok) return;
    expect(result2.errors.some((e) => e.includes("manifest.entry.system: 4001 chars"))).toBe(true);
  });

  test("rejects a non-object outright", () => {
    expect(validateManifest("nope").ok).toBe(false);
    expect(validateManifest(null).ok).toBe(false);
    expect(validateManifest([makeManifest()]).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (b) Canonical form + checksum stability
// ---------------------------------------------------------------------------

describe("canonicalize + checksum", () => {
  test("checksum is stable across key order", () => {
    const a = makeManifest();
    const b = {
      limits: a.limits,
      permissions: [...a.permissions],
      entry: { opening: a.entry.opening, system: a.entry.system },
      description: a.description,
      version: a.version,
      name: a.name,
      slug: a.slug,
    } as unknown as SkillManifest;
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(checksumOf(a)).toBe(checksumOf(b));
    // And it is a sha256 hex string.
    expect(checksumOf(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("different content yields a different checksum", () => {
    const a = makeManifest();
    const b = makeManifest({ ...a, description: `${a.description} (changed)` });
    expect(checksumOf(a)).not.toBe(checksumOf(b));
  });

  test("compareSemver follows semver precedence", () => {
    expect(compareSemver("1.2.3", "1.10.0")).toBeLessThan(0);
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10")).toBeLessThan(0);
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(compareSemver("1.0.0+build.5", "1.0.0")).toBe(0);
    expect(Number.isNaN(compareSemver("banana", "1.0.0"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (c) publishSkill against the REAL database (downgrade rejection included)
// ---------------------------------------------------------------------------

describe("publishSkill (real DB)", () => {
  test("publishes, stores canonical manifest + verifiable checksum", async () => {
    const manifest = makeManifest();
    const result = await publishSkill({ manifestJson: manifest, author: "tester" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.skill.slug).toBe(manifest.slug);
    expect(result.skill.version).toBe("1.0.0");

    // The stored manifest IS the canonical form and the checksum recomputes.
    expect(result.skill.manifest).toBe(canonicalize(manifest));
    expect(result.skill.checksum).toBe(checksumOf(manifest));

    // The row is listable and resolvable with derived rating aggregates.
    const listed = await listSkills();
    expect(listed.find((s) => s.slug === manifest.slug)?.rating).toEqual({
      sum: 0,
      count: 0,
      avg: 0,
    });
  });

  test("rejects a same-version republish and a version downgrade", async () => {
    const manifest = makeManifest();
    const first = await publishSkill({ manifestJson: manifest, author: "tester" });
    expect(first.ok).toBe(true);

    const same = await publishSkill({ manifestJson: manifest, author: "tester" });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.errors.join(" ")).toContain("downgrade rejected");

    const lower = await publishSkill({
      manifestJson: { ...manifest, version: "0.9.0" },
      author: "tester",
    });
    expect(lower.ok).toBe(false);
    if (!lower.ok) {
      expect(lower.errors[0]).toContain("version downgrade rejected");
      expect(lower.errors[0]).toContain("is already at 1.0.0");
    }
  });

  test("accepts a strictly greater version (upgrade path)", async () => {
    const manifest = makeManifest();
    await publishSkill({ manifestJson: manifest, author: "tester" });
    const up = await publishSkill({
      manifestJson: { ...manifest, version: "1.1.0", description: "Updated description." },
      author: "tester-2",
    });
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    expect(up.created).toBe(false);
    expect(up.skill.version).toBe("1.1.0");
    expect(up.skill.author).toBe("tester-2");
    expect(up.skill.checksum).toBe(
      checksumOf({ ...manifest, version: "1.1.0", description: "Updated description." })
    );
  });

  test("invalid manifests are rejected without touching the DB", async () => {
    const bad = { ...makeManifest(), version: "not-semver" };
    const result = await publishSkill({ manifestJson: bad, author: "tester" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("disableSkill hides a skill from the public list", async () => {
    const manifest = makeManifest();
    await publishSkill({ manifestJson: manifest, author: "tester" });
    const disabled = await disableSkill(manifest.slug);
    expect(disabled?.status).toBe("disabled");
    const listed = await listSkills();
    expect(listed.find((s) => s.slug === manifest.slug)).toBeUndefined();
    const all = await listSkills({ includeDisabled: true });
    expect(all.find((s) => s.slug === manifest.slug)?.status).toBe("disabled");
  });
});

// ---------------------------------------------------------------------------
// (d) rateSkill aggregates
// ---------------------------------------------------------------------------

describe("rateSkill (real DB)", () => {
  test("upserts per user and recomputes ratingSum/ratingCount", async () => {
    const manifest = makeManifest();
    await publishSkill({ manifestJson: manifest, author: "tester" });
    const userA = `rate-user-a-${rand8()}`;
    const userB = `rate-user-b-${rand8()}`;

    const r1 = await rateSkill(manifest.slug, userA, 5, "great");
    expect(r1).toMatchObject({ ratingSum: 5, ratingCount: 1, avg: 5 });

    // Re-rating REPLACES the user's score (upsert, not a second row).
    const r2 = await rateSkill(manifest.slug, userA, 3);
    expect(r2).toMatchObject({ ratingSum: 3, ratingCount: 1, avg: 3 });

    const r3 = await rateSkill(manifest.slug, userB, 4, "solid");
    expect(r3).toMatchObject({ ratingSum: 7, ratingCount: 2, avg: 3.5 });

    const row = await db.skill.findUnique({ where: { slug: manifest.slug } });
    expect(row?.ratingSum).toBe(7);
    expect(row?.ratingCount).toBe(2);
    expect(await db.skillRating.count({ where: { skill: { slug: manifest.slug } } })).toBe(2);
  });

  test("rejects out-of-range scores", async () => {
    const manifest = makeManifest();
    await publishSkill({ manifestJson: manifest, author: "tester" });
    await expect(rateSkill(manifest.slug, "u", 0)).rejects.toThrow(/integer 1-5/);
    await expect(rateSkill(manifest.slug, "u", 6)).rejects.toThrow(/integer 1-5/);
    await expect(rateSkill(manifest.slug, "u", 2.5)).rejects.toThrow(/integer 1-5/);
  });
});

// ---------------------------------------------------------------------------
// (d2) installSkill — counter increments ONLY on first install
// ---------------------------------------------------------------------------

describe("installSkill (real DB)", () => {
  test("increments once per user, then is a no-op", async () => {
    const manifest = makeManifest();
    await publishSkill({ manifestJson: manifest, author: "tester" });
    const user = `install-user-${rand8()}`;

    const first = await installSkill(manifest.slug, user);
    expect(first).toEqual({ installed: true, installs: 1 });

    const again = await installSkill(manifest.slug, user);
    expect(again).toEqual({ installed: false, installs: 1 });

    const row = await db.skill.findUnique({ where: { slug: manifest.slug } });
    expect(row?.installs).toBe(1);
    expect(
      await db.skillInstall.count({ where: { skill: { slug: manifest.slug }, userId: user } })
    ).toBe(1);
  });

  test("refuses to install a disabled skill", async () => {
    const manifest = makeManifest();
    await publishSkill({ manifestJson: manifest, author: "tester" });
    await disableSkill(manifest.slug);
    await expect(installSkill(manifest.slug, "u")).rejects.toThrow(/disabled/);
  });
});

// ---------------------------------------------------------------------------
// (e) Runtime permission enforcement — OFFLINE (no LLM, no tool execution)
// ---------------------------------------------------------------------------

describe("runtime sandbox permission enforcement", () => {
  test("filterAllowedTools intersects manifest permissions with the real registry", () => {
    const manifest = makeManifest({
      permissions: ["web_research", "read_hex", "not_a_real_tool", "rea_tool"],
    });
    const { allowed, unknown } = filterAllowedTools(manifest, AGENT_TOOLS);
    expect(allowed.map((t) => t.name).sort()).toEqual(["rea_tool", "read_hex", "web_research"]);
    expect(unknown).toEqual(["not_a_real_tool"]);
  });

  test("resolveSkillTool REFUSES a tool that is not in the manifest permissions", () => {
    const manifest = makeManifest({ permissions: ["web_research"] });
    const resolved = resolveSkillTool(manifest, AGENT_TOOLS, "read_hex");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    // The refusal names the violation AND the actual allowed set.
    expect(resolved.error).toContain('"read_hex" is NOT in this skill\'s manifest permissions');
    expect(resolved.error).toContain("web_research");
  });

  test("resolveSkillTool REFUSES a permitted tool that does not exist in the registry", () => {
    const manifest = makeManifest({ permissions: ["totally_made_up"] });
    const resolved = resolveSkillTool(manifest, AGENT_TOOLS, "totally_made_up");
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error).toContain("does not exist in the agent registry");
  });

  test("resolveSkillTool admits an allowlisted real tool", () => {
    const manifest = makeManifest({ permissions: ["web_research"] });
    const resolved = resolveSkillTool(manifest, AGENT_TOOLS, "web_research");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.tool.name).toBe("web_research");
    expect(typeof resolved.tool.run).toBe("function");
  });

  test("parseToolCalls is strict: valid lines parsed, malformed refused", () => {
    const reply = [
      "Thinking about it.",
      'TOOL_CALL web_research {"q":"rea skills"}',
      "TOOL_CALL read_hex",
      "TOOL_CALL bad_tool {not json}",
      'TOOL_CALL read_hex {"offset":0, "length":64}',
    ].join("\n");
    const parsed = parseToolCalls(reply);
    expect(parsed.calls).toEqual([
      { tool: "web_research", args: { q: "rea skills" } },
      { tool: "read_hex", args: {} },
      { tool: "read_hex", args: { offset: 0, length: 64 } },
    ]);
    expect(parsed.malformed).toEqual([{ tool: "bad_tool", error: expect.stringContaining("not valid JSON") }]);
  });
});
