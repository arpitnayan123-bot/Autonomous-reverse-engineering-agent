/**
 * rea-skill manifest v1 — the publishable contract of a community skill.
 *
 * A manifest is a pure JSON object (no code): { slug, name, version,
 * description, entry: { system, opening }, permissions: string[],
 * limits: { toolCalls, workspaceBytes, timeoutMs } }. `entry.system` is the
 * skill's system prompt (executed inside the sandboxed runner), `permissions`
 * names agent registry tools the skill may call (the runtime intersects them
 * with the real registry — a permission that names no real tool is simply
 * never executable), and `limits` bounds every run.
 *
 * The repo has no zod (checked package.json) — validation is hand-rolled and
 * returns PRECISE errors ("manifest.description: 612 chars — max 500"), not
 * a single opaque failure, so skill authors can fix their JSON in one pass.
 *
 * `canonicalize` produces a deterministic JSON form (recursively sorted
 * object keys, no whitespace variance) and `checksumOf` hashes it — the
 * checksum stored on the Skill row anchors integrity: anyone can recompute
 * sha256(canonical(manifest)) and detect tampering.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillEntry {
  /** The skill's system prompt — executed inside the sandboxed runner. */
  system: string;
  /** Shown to the user when the skill starts a run. */
  opening: string;
}

export interface SkillLimits {
  /** Max tool calls in ONE run (1-50). Default 12. */
  toolCalls: number;
  /** Declared workspace byte budget (≤ 8 MB, default 1 MB). The platform's
   * own 8 MB per-workspace quota is the hard backstop. */
  workspaceBytes: number;
  /** Wall-clock cap for one run, 5s-120s. Default 60s. */
  timeoutMs: number;
}

export interface SkillManifest {
  slug: string;
  name: string;
  version: string;
  description: string;
  entry: SkillEntry;
  /** Agent registry tool names the skill may call. */
  permissions: string[];
  limits: SkillLimits;
}

export type ManifestValidation =
  | { ok: true; manifest: SkillManifest }
  | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// Limits / regexes
// ---------------------------------------------------------------------------

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;
/** Strict semver (official regex): MAJOR.MINOR.PATCH[-prerelease][+build]. */
export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
/** Registry tool names look like `read_strings`, `update_plan`, `re_tool`. */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

const MAX_NAME_CHARS = 100;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_SYSTEM_CHARS = 4000;
const MAX_OPENING_CHARS = 1000;
const MAX_PERMISSIONS = 64;
const MAX_PERMISSION_CHARS = 64;

export const DEFAULT_LIMITS: SkillLimits = Object.freeze({
  toolCalls: 12,
  workspaceBytes: 1024 * 1024,
  timeoutMs: 60_000,
});

const LIMIT_BOUNDS = {
  toolCalls: { min: 1, max: 50 },
  workspaceBytes: { min: 1, max: 8 * 1024 * 1024 },
  timeoutMs: { min: 5_000, max: 120_000 },
} as const;

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

/**
 * Validate an unknown JSON value as a rea-skill manifest v1. On success the
 * manifest is NORMALIZED: only known keys survive and limits defaults are
 * applied — so canonicalize(manifest) is deterministic for every equivalent
 * input (missing limits === explicit defaults).
 */
export function validateManifest(json: unknown): ManifestValidation {
  const errors: string[] = [];

  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return {
      ok: false,
      errors: ["manifest: expected a JSON object, got " + describeType(json)],
    };
  }
  const raw = json as Record<string, unknown>;

  // -- slug -----------------------------------------------------------------
  const slug = raw.slug;
  if (typeof slug !== "string") {
    errors.push(`manifest.slug: expected string, got ${describeType(slug)}`);
  } else if (!SLUG_RE.test(slug)) {
    errors.push(
      `manifest.slug: "${slug}" does not match ^[a-z0-9][a-z0-9-]{1,48}$ (lowercase kebab-case, 2-49 chars)`
    );
  }

  // -- name -----------------------------------------------------------------
  const name = raw.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    errors.push("manifest.name: expected a non-empty string");
  } else if (name.length > MAX_NAME_CHARS) {
    errors.push(`manifest.name: ${name.length} chars — max ${MAX_NAME_CHARS}`);
  }

  // -- version --------------------------------------------------------------
  const version = raw.version;
  if (typeof version !== "string") {
    errors.push(`manifest.version: expected string, got ${describeType(version)}`);
  } else if (!SEMVER_RE.test(version)) {
    errors.push(
      `manifest.version: "${version}" is not valid semver (expected MAJOR.MINOR.PATCH with optional -prerelease/+build)`
    );
  }

  // -- description ----------------------------------------------------------
  const description = raw.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    errors.push("manifest.description: expected a non-empty string");
  } else if (description.length > MAX_DESCRIPTION_CHARS) {
    errors.push(
      `manifest.description: ${description.length} chars — max ${MAX_DESCRIPTION_CHARS}`
    );
  }

  // -- entry ----------------------------------------------------------------
  const entry = raw.entry;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    errors.push(`manifest.entry: expected object, got ${describeType(entry)}`);
  } else {
    const e = entry as Record<string, unknown>;
    const system = e.system;
    if (typeof system !== "string" || system.trim().length === 0) {
      errors.push(
        "manifest.entry.system: expected a non-empty string (the skill's system prompt)"
      );
    } else if (system.length > MAX_SYSTEM_CHARS) {
      errors.push(`manifest.entry.system: ${system.length} chars — max ${MAX_SYSTEM_CHARS}`);
    }
    const opening = e.opening;
    if (typeof opening !== "string") {
      errors.push(`manifest.entry.opening: expected string, got ${describeType(opening)}`);
    } else if (opening.length > MAX_OPENING_CHARS) {
      errors.push(`manifest.entry.opening: ${opening.length} chars — max ${MAX_OPENING_CHARS}`);
    }
  }

  // -- permissions ------------------------------------------------------------
  const permissions = raw.permissions;
  const permsOut: string[] = [];
  if (!Array.isArray(permissions)) {
    errors.push(
      `manifest.permissions: expected array of strings, got ${describeType(permissions)}`
    );
  } else {
    if (permissions.length > MAX_PERMISSIONS) {
      errors.push(
        `manifest.permissions: ${permissions.length} entries — max ${MAX_PERMISSIONS}`
      );
    }
    const seen = new Set<string>();
    permissions.forEach((p, i) => {
      if (typeof p !== "string" || !TOOL_NAME_RE.test(p)) {
        errors.push(
          `manifest.permissions[${i}]: ${JSON.stringify(p ?? null)} is not a valid agent tool name (expected lowercase [a-z][a-z0-9_]{1,63}, e.g. "read_strings")`
        );
        return;
      }
      if (p.length > MAX_PERMISSION_CHARS) {
        errors.push(
          `manifest.permissions[${i}]: ${p.length} chars — max ${MAX_PERMISSION_CHARS}`
        );
        return;
      }
      if (seen.has(p)) {
        errors.push(`manifest.permissions[${i}]: duplicate entry "${p}"`);
        return;
      }
      seen.add(p);
      permsOut.push(p);
    });
  }

  // -- limits -----------------------------------------------------------------
  let limitsOut: SkillLimits = { ...DEFAULT_LIMITS };
  const limits = raw.limits;
  if (limits !== undefined) {
    if (typeof limits !== "object" || limits === null || Array.isArray(limits)) {
      errors.push(`manifest.limits: expected object, got ${describeType(limits)}`);
    } else {
      const l = limits as Record<string, unknown>;
      limitsOut = { ...DEFAULT_LIMITS };
      for (const key of ["toolCalls", "workspaceBytes", "timeoutMs"] as const) {
        const v = l[key];
        if (v === undefined) continue;
        const { min, max } = LIMIT_BOUNDS[key];
        if (typeof v !== "number" || !Number.isInteger(v)) {
          errors.push(`manifest.limits.${key}: expected integer, got ${describeType(v)}`);
          continue;
        }
        if (v < min || v > max) {
          errors.push(`manifest.limits.${key}: ${v} — must be between ${min} and ${max}`);
          continue;
        }
        limitsOut[key] = v;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const entryObj = raw.entry as Record<string, unknown>;
  return {
    ok: true,
    manifest: {
      slug: slug as string,
      name: (name as string).trim(),
      version: version as string,
      description: (description as string).trim(),
      entry: {
        system: entryObj.system as string,
        opening: entryObj.opening as string,
      },
      permissions: permsOut,
      limits: limitsOut,
    },
  };
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// ---------------------------------------------------------------------------
// Canonical form + checksum
// ---------------------------------------------------------------------------

/**
 * Stable JSON: object keys sorted recursively at every depth, arrays kept in
 * order. Two manifests that differ only in key order canonicalize to the
 * SAME string — the checksum is a property of the content, not the author's
 * formatting.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** sha256 hex of the canonical JSON form of a manifest. */
export function checksumOf(manifest: SkillManifest | unknown): string {
  return createHash("sha256").update(canonicalize(manifest)).digest("hex");
}

// ---------------------------------------------------------------------------
// Semver comparison (registry downgrade guard)
// ---------------------------------------------------------------------------

/**
 * Compare two semver strings per precedence rules: numeric fields first,
 * then a prerelease LOSES to a release of the same numerics (1.0.0-alpha <
 * 1.0.0), prerelease identifiers compared field-by-field (numeric < alpha,
 * longer set wins when all shared fields equal). Build metadata is ignored.
 * Returns <0 / 0 / >0 like a comparator. Invalid input → NaN.
 */
export function compareSemver(a: string, b: string): number {
  const ma = SEMVER_RE.exec(a);
  const mb = SEMVER_RE.exec(b);
  if (!ma || !mb) return Number.NaN;
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d;
  }
  const preA = ma[4] ? ma[4].split(".") : null;
  const preB = mb[4] ? mb[4].split(".") : null;
  if (!preA && !preB) return 0;
  if (!preA) return 1; // release > prerelease
  if (!preB) return -1;
  const len = Math.max(preA.length, preB.length);
  for (let i = 0; i < len; i++) {
    const x = preA[i];
    const y = preB[i];
    if (x === undefined) return -1; // shorter prerelease set < longer set
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1; // numeric identifiers < alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}
