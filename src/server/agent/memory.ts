import { db } from "@/lib/db";
import type { Memory } from "@prisma/client";

/**
 * Cross-session persistent memory for the AREA agent.
 *
 * The agent can store durable facts ("remember") and search them in later
 * sessions ("recall"). Rows live in the Memory table, scoped per user:
 *   - targetId = null  → GLOBAL: recalled in every chat of this user,
 *     including free chats (no target attached).
 *   - targetId = <id>  → TARGET-scoped: recalled first in chats on that
 *     target, and never leaked into chats on other targets.
 *
 * Recall is a bounded full-text search (SQLite LIKE via Prisma `contains`,
 * case-insensitive for ASCII) with a deterministic relevance ranking applied
 * in JS — target-scope matches always outrank global ones, and within a
 * scope exact key hits > key substring > value substring > word overlap.
 *
 * Injection contract (runAgentLoop): recalled matches are appended to the
 * system prompt under [RELEVANT MEMORIES FROM PAST SESSIONS], capped at
 * MEMORY_INJECTION_MAX_CHARS total so memory can never blow up the prompt.
 */

/** Max characters for a memory key (keys are stable short labels). */
export const MEMORY_MAX_KEY_CHARS = 120;

/** Max characters for a stored memory value (tool layer refuses longer). */
export const MEMORY_MAX_VALUE_CHARS = 4000;

/** Top-N matches returned by recall(). */
export const RECALL_LIMIT = 10;

/** Hard cap for the [RELEVANT MEMORIES] block injected into the system prompt. */
export const MEMORY_INJECTION_MAX_CHARS = 2000;

/** Section header used in the system prompt injection (asserted by tests). */
export const MEMORY_SECTION_HEADER = "[RELEVANT MEMORIES FROM PAST SESSIONS]";

/** Candidate pool fetched per scope before JS ranking (bound the query). */
const RECALL_CANDIDATE_POOL = 50;

/** Query words below this length are too noisy to rank on. */
const MIN_WORD_CHARS = 3;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function normalizeKey(key: unknown): string {
  const k = typeof key === "string" ? key.trim().replace(/\s+/g, " ") : "";
  if (!k) {
    throw new Error("memory key must be a non-empty string (a short stable label)");
  }
  if (k.length > MEMORY_MAX_KEY_CHARS) {
    throw new Error(`memory key exceeds ${MEMORY_MAX_KEY_CHARS} characters`);
  }
  return k;
}

function normalizeValue(value: unknown): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) {
    throw new Error("memory value must be a non-empty string (the fact to remember)");
  }
  if (v.length > MEMORY_MAX_VALUE_CHARS) {
    throw new Error(`memory value exceeds ${MEMORY_MAX_VALUE_CHARS} characters`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Upsert a memory entry for (userId, targetId, key). targetId null = global.
 * Re-remembering an existing key REPLACES its value (and bumps updatedAt) —
 * the latest statement of a fact wins. Returns the stored row.
 */
export async function remember(
  userId: string,
  targetId: string | null,
  key: unknown,
  value: unknown
): Promise<Memory> {
  if (!userId || typeof userId !== "string") {
    throw new Error("memory requires a userId");
  }
  const k = normalizeKey(key);
  const v = normalizeValue(value);
  const where = { userId, targetId: targetId ?? null, key: k };
  const existing = await db.memory.findFirst({ where: { ...where } });
  if (existing) {
    return db.memory.update({ where: { id: existing.id }, data: { value: v } });
  }
  return db.memory.create({ data: { userId, targetId: targetId ?? null, key: k, value: v } });
}

/**
 * Deterministic relevance score for one memory against a (normalized) query.
 * Higher is better:
 *   +120  key equals the query (case-insensitive)
 *   +60   key contains the whole query
 *   +30   value contains the whole query
 *    +8   per query word (≥3 chars) appearing in the key
 *    +2   per query word (≥3 chars) appearing in the value
 * Exported for the relevance-ranking regression test.
 */
export function scoreMemoryRelevance(
  m: Pick<Memory, "key" | "value">,
  normalizedQuery: string
): number {
  const q = normalizedQuery.toLowerCase();
  const key = m.key.toLowerCase();
  const value = m.value.toLowerCase();
  let score = 0;
  if (key === q) score += 120;
  else if (key.includes(q)) score += 60;
  if (value.includes(q)) score += 30;
  const words = [
    ...new Set(
      q
        .split(/\s+/)
        .filter((w) => w.length >= MIN_WORD_CHARS)
    ),
  ];
  for (const w of words) {
    if (key.includes(w)) score += 8;
    if (value.includes(w)) score += 2;
  }
  return score;
}

/**
 * Full-text search across key and value. Scoped (userId + targetId) FIRST,
 * then (userId + global); a target-scope match always outranks a global one
 * regardless of score. Returns the top RECALL_LIMIT (10) matches. An empty
 * query matches nothing (recall is search, not a listing — use listMemories).
 */
export async function recall(
  userId: string,
  targetId: string | null,
  query: unknown,
  limit: number = RECALL_LIMIT
): Promise<Memory[]> {
  if (!userId || typeof userId !== "string") return [];
  const q = typeof query === "string" ? query.trim().replace(/\s+/g, " ") : "";
  if (!q) return [];
  const take = Math.max(1, Math.min(50, Math.floor(limit) || RECALL_LIMIT));

  // Candidate filter: the whole query OR any meaningful word, in key or value.
  const words = [
    ...new Set(
      q
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length >= MIN_WORD_CHARS)
    ),
  ].slice(0, 8);
  const contains = (s: string) => ({ contains: s });
  const or: Array<Record<string, unknown>> = [
    { key: contains(q) },
    { value: contains(q) },
    ...words.flatMap((w) => [{ key: contains(w) }, { value: contains(w) }]),
  ];
  const base = { userId, OR: or };

  const rank = (rows: Memory[]): Memory[] =>
    [...rows].sort((a, b) => {
      const d = scoreMemoryRelevance(b, q) - scoreMemoryRelevance(a, q);
      if (d !== 0) return d;
      const u = b.updatedAt.getTime() - a.updatedAt.getTime();
      if (u !== 0) return u;
      const c = b.createdAt.getTime() - a.createdAt.getTime();
      if (c !== 0) return c;
      return a.key.localeCompare(b.key);
    });

  // Target scope first, then global — concatenated ranks, capped at `take`.
  const [scoped, global] = await Promise.all([
    targetId
      ? db.memory.findMany({
          where: { ...base, targetId },
          orderBy: { updatedAt: "desc" },
          take: RECALL_CANDIDATE_POOL,
        })
      : Promise.resolve([] as Memory[]),
    db.memory.findMany({
      where: { ...base, targetId: null },
      orderBy: { updatedAt: "desc" },
      take: RECALL_CANDIDATE_POOL,
    }),
  ]);
  return [...rank(scoped), ...rank(global)].slice(0, take);
}

/**
 * Delete ONE memory entry (userId + targetId scope + exact key).
 * Returns the deleted row, or null when nothing matched (the caller decides
 * how to phrase the honest "nothing was forgotten" outcome).
 */
export async function forget(
  userId: string,
  targetId: string | null,
  key: unknown
): Promise<Memory | null> {
  if (!userId || typeof userId !== "string") return null;
  const k = normalizeKey(key);
  const existing = await db.memory.findFirst({
    where: { userId, targetId: targetId ?? null, key: k },
  });
  if (!existing) return null;
  await db.memory.delete({ where: { id: existing.id } });
  return existing;
}

/**
 * List memories for ONE scope: all entries of a target, or (targetId null)
 * all global entries of the user. Newest-updated first. The UI Memory tab
 * calls this once per scope via /api/memory.
 */
export async function listMemories(
  userId: string,
  targetId: string | null
): Promise<Memory[]> {
  if (!userId || typeof userId !== "string") return [];
  return db.memory.findMany({
    where: { userId, targetId: targetId ?? null },
    orderBy: { updatedAt: "desc" },
  });
}

// ---------------------------------------------------------------------------
// System-prompt injection
// ---------------------------------------------------------------------------

/** "target" | "global" label for a memory row (single source for tools/UI). */
export function scopeOf(m: Pick<Memory, "targetId">): "target" | "global" {
  return m.targetId ? "target" : "global";
}

function memoryLine(m: Memory, maxValueChars: number): string {
  const value = m.value.replace(/\s+/g, " ").trim();
  const truncated =
    value.length > maxValueChars ? `${value.slice(0, Math.max(1, maxValueChars - 1))}…` : value;
  return `- [${scopeOf(m)}] ${m.key} — ${truncated} (updated ${m.updatedAt.toISOString()})`;
}

/**
 * Build the [RELEVANT MEMORIES FROM PAST SESSIONS] block appended to the
 * system prompt by runAgentLoop. Returns null when there are no matches
 * (nothing is injected — the prompt stays untouched). The WHOLE block is
 * hard-capped at MEMORY_INJECTION_MAX_CHARS (2000) characters: entries are
 * added ranked-first, and when the cap is hit the block is closed with an
 * explicit "…[more memories omitted]" marker instead of silently overflowing.
 *
 * Cap proof (why this can never exceed the cap): every accepted candidate is
 * checked WITH the omission marker pre-reserved, and a truncated fragment's
 * value budget is computed as `cap − base − marker − body − separators`,
 * so the final `base + body [+ marker]` assembly is bounded by construction.
 */
export function buildMemoryInjection(matches: Memory[]): string | null {
  if (!matches || matches.length === 0) return null;
  const guidance =
    "Facts below were stored during EARLIER sessions on this platform. Treat them as trusted context: use them silently where relevant, never claim to remember the conversation itself, and re-check anything stale against live tool output.";
  const base = `${MEMORY_SECTION_HEADER}\n${guidance}\n`;
  const OMISSION = "\n…[more memories omitted]";
  let body = "";
  let omitted = false;
  for (let i = 0; i < matches.length; i++) {
    const candidate = memoryLine(matches[i], 280);
    const next = body ? `${body}\n${candidate}` : candidate;
    // Reserve the omission marker on EVERY acceptance so a later truncation
    // can always still afford the marker line.
    if (base.length + next.length + OMISSION.length <= MEMORY_INJECTION_MAX_CHARS) {
      body = next;
      continue;
    }
    omitted = true;
    // Cap reached: try to squeeze a meaningful fragment of THIS entry into
    // the remaining space (marker pre-reserved), then stop.
    const sep = body ? 1 : 0; // newline between existing body and this line
    const prefix = `- [${scopeOf(matches[i])}] ${matches[i].key} — `;
    const suffix = ` (updated ${matches[i].updatedAt.toISOString()})`;
    const maxVal =
      MEMORY_INJECTION_MAX_CHARS - base.length - OMISSION.length - sep - body.length -
      prefix.length - suffix.length - 1; // trailing ellipsis char
    if (maxVal >= 30) {
      const value = matches[i].value.replace(/\s+/g, " ").trim();
      const fragment = `${prefix}${value.slice(0, maxVal - 1)}…${suffix}`;
      body = body ? `${body}\n${fragment}` : fragment;
    }
    break;
  }
  if (!body) return null;
  return `${base}${body}${omitted ? OMISSION : ""}`;
}
