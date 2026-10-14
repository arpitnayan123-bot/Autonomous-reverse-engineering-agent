#!/usr/bin/env bun
/**
 * Cross-session persistent memory regression suite (memory.ts + the three
 * memory tools + the runAgentLoop injection).
 *
 * Proves, against the REAL database (Memory table, synthetic user/target
 * ids — plain columns, no FKs):
 *   - remember/recall/forget roundtrip, including the upsert contract
 *     (re-remembering the same key REPLACES the value, same row);
 *   - target vs global scoping: target-scope matches never leak into other
 *     targets' chats, global ones follow the user everywhere, and a
 *     target-scoped match outranks a global one regardless of score;
 *   - cross-user isolation (memories are keyed by userId, never shared);
 *   - memory injection into the system prompt: runAgentLoop appends the
 *     [RELEVANT MEMORIES FROM PAST SESSIONS] block BEFORE the first LLM
 *     call — target-scoped + global in target chats, GLOBAL ONLY in free
 *     chats — and injects nothing when no memories match;
 *   - the 2000-character hard cap on the injected block (unit + loop level),
 *     closed with an explicit omission marker instead of overflowing;
 *   - recall relevance ranking: exact key > key substring > value substring,
 *   - the tool layer: remember/recall/forget are registry tools with
 *     scope "any" and dedup disabled, routable in free chats (where scope
 *     "target" is honestly refused, never silently downgraded).
 *
 * Run:  bun test src/server/agent/__tests__/memory.test.ts
 */
import { describe, test, expect, afterAll } from "bun:test";
import {
  MEMORY_INJECTION_MAX_CHARS,
  MEMORY_SECTION_HEADER,
  buildMemoryInjection,
  forget,
  listMemories,
  recall,
  remember,
  scopeOf,
} from "@/server/agent/memory";
import {
  AGENT_TOOLS,
  FREE_CHAT_TOOL_NAMES,
  executeAgentTool,
  runFreeChatTool,
  runForgetTool,
  runRecallTool,
  runRememberTool,
  type AgentToolContext,
} from "@/server/agent/tools";
import { runAgentLoop } from "@/server/agent/agent";
import { freeChatSystemPrompt } from "@/server/agent/prompts";
import type { LlmMessage, ResolvedLlm } from "@/server/agent/providers";
import type { Memory, Target } from "@prisma/client";
import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const USER = `mem-test-u-${crypto.randomUUID().slice(0, 8)}`;
const OTHER_USER = `mem-test-u-${crypto.randomUUID().slice(0, 8)}`;
const TID_A = `mem-test-t-a-${crypto.randomUUID().slice(0, 8)}`;
const TID_B = `mem-test-t-b-${crypto.randomUUID().slice(0, 8)}`;

/** Plain Target-shaped object (no FK rows needed — Memory has no relations). */
function fakeTarget(id: string): Target {
  return {
    id,
    userId: USER,
    originalName: "sample.elf",
    storedPath: "storage/uploads/memtest/original",
    sizeBytes: 1024,
    sha256: "cafe".repeat(16),
    mimeType: "application/octet-stream",
    detectedFormat: "elf",
    formatFamily: "binary",
    status: "ready",
    summary: null,
    docs: null,
    docsAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Target;
}

/** Scripted TEXT-path LLM: captures every prompt, always answers prose. */
function fakeTextLlm(): ResolvedLlm & { captured: LlmMessage[][] } {
  const captured: LlmMessage[][] = [];
  return {
    source: "byok",
    provider: "kimi",
    // Big window → the compaction path never fires in these tests.
    model: "moonshot-v1-128k",
    supportsNativeTools: false,
    callLLM: async (messages: LlmMessage[]) => {
      captured.push(messages.map((m) => ({ ...m })));
      return "Final answer: memory behavior noted.";
    },
    captured,
  } as unknown as ResolvedLlm & { captured: LlmMessage[][] };
}

/** Memory row factory for injection unit tests (no DB involved). */
function memRow(key: string, value: string, targetId: string | null = null): Memory {
  const now = new Date();
  return {
    id: `mem-${key}`,
    userId: "unit",
    targetId,
    key,
    value,
    createdAt: now,
    updatedAt: now,
  } as Memory;
}

afterAll(async () => {
  await db.memory.deleteMany({ where: { userId: { startsWith: "mem-test-u-" } } });
  await db.chatMessage.deleteMany({ where: { sessionId: { startsWith: "mem-test-loop-" } } });
});

// ---------------------------------------------------------------------------
// remember / recall / forget roundtrip
// ---------------------------------------------------------------------------

describe("memory roundtrip", () => {
  test("remember → recall → forget, with upsert-on-same-key semantics", async () => {
    const saved = await remember(USER, TID_A, "roundtrip-key", "roundtrip value one");
    expect(saved.key).toBe("roundtrip-key");
    expect(saved.targetId).toBe(TID_A);
    expect(scopeOf(saved)).toBe("target");

    // Upsert: same (user, target, key) → SAME row, value replaced.
    const again = await remember(USER, TID_A, "roundtrip-key", "roundtrip value two");
    expect(again.id).toBe(saved.id);
    expect(again.value).toBe("roundtrip value two");
    const rows = await listMemories(USER, TID_A);
    expect(rows.filter((r) => r.key === "roundtrip-key")).toHaveLength(1);

    // Recall finds it (value match), forget removes exactly it, then it is
    // gone and a second forget honestly reports nothing.
    const hits = await recall(USER, TID_A, "roundtrip value two");
    expect(hits.some((m) => m.id === saved.id)).toBe(true);
    const del = await forget(USER, TID_A, "roundtrip-key");
    expect(del?.id).toBe(saved.id);
    expect(await forget(USER, TID_A, "roundtrip-key")).toBeNull();
    expect(await recall(USER, TID_A, "roundtrip value two")).toHaveLength(0);
  });

  test("global scope: targetId null roundtrip and listMemories(null)", async () => {
    const saved = await remember(USER, null, "global-roundtrip", "global roundtrip fact");
    expect(saved.targetId).toBeNull();
    expect(scopeOf(saved)).toBe("global");
    const hits = await recall(USER, null, "global roundtrip fact");
    expect(hits.map((m) => m.key)).toContain("global-roundtrip");
    expect((await listMemories(USER, null)).map((m) => m.key)).toContain("global-roundtrip");
    await forget(USER, null, "global-roundtrip");
    expect(await recall(USER, null, "global roundtrip fact")).toHaveLength(0);
  });

  test("validation: empty or oversized key/value refused with precise errors", async () => {
    await expect(remember(USER, null, "", "v")).rejects.toThrow(/non-empty/);
    await expect(remember(USER, null, "   ", "v")).rejects.toThrow(/non-empty/);
    await expect(remember(USER, null, "k", "")).rejects.toThrow(/non-empty/);
    await expect(remember(USER, null, "k".repeat(121), "v")).rejects.toThrow(/exceeds 120/);
    await expect(remember(USER, null, "k", "v".repeat(4001))).rejects.toThrow(/exceeds 4000/);
    await expect(forget(USER, null, "")).rejects.toThrow(/non-empty/); // forget validates too
  });
});

// ---------------------------------------------------------------------------
// Scoping: target vs global, cross-target isolation, cross-user isolation
// ---------------------------------------------------------------------------

describe("memory scoping", () => {
  test("target-scope memories never leak into other targets; global follows the user", async () => {
    await remember(USER, TID_A, "scope-alpha", "shared keyword alpha fact target A");
    await remember(USER, TID_B, "scope-beta", "shared keyword beta fact target B");
    await remember(USER, null, "scope-gamma", "shared keyword global fact");

    // Recall on target A: A's scoped entry FIRST (scope precedence), global
    // after, and NEVER target B's entry.
    const a = await recall(USER, TID_A, "shared keyword");
    expect(a.map((m) => m.key)).toContain("scope-alpha");
    expect(a.map((m) => m.key)).toContain("scope-gamma");
    expect(a.map((m) => m.key)).not.toContain("scope-beta");
    expect(scopeOf(a[0])).toBe("target");

    // Recall on target B: B's entry first, global after, never A's.
    const b = await recall(USER, TID_B, "shared keyword");
    expect(b.map((m) => m.key)).toContain("scope-beta");
    expect(b.map((m) => m.key)).not.toContain("scope-alpha");

    // Free-chat recall (targetId null): ONLY global.
    const free = await recall(USER, null, "shared keyword");
    expect(free.map((m) => m.key)).toEqual(["scope-gamma"]);

    // listMemories is per-scope: A's list has alpha, not gamma/beta.
    expect((await listMemories(USER, TID_A)).map((m) => m.key)).toEqual(["scope-alpha"]);
    expect((await listMemories(USER, TID_B)).map((m) => m.key)).toEqual(["scope-beta"]);
    const globals = (await listMemories(USER, null)).map((m) => m.key);
    expect(globals).toContain("scope-gamma");
    expect(globals).not.toContain("scope-alpha");
    expect(globals).not.toContain("scope-beta");
  });

  test("cross-user isolation: another user recalls nothing of this user's memories", async () => {
    await expect(recall(OTHER_USER, TID_A, "shared keyword")).resolves.toHaveLength(0);
    await expect(listMemories(OTHER_USER, TID_A)).resolves.toHaveLength(0);
    await expect(listMemories(OTHER_USER, null)).resolves.toHaveLength(0);
    // Cross-user forget deletes nothing.
    await expect(forget(OTHER_USER, TID_A, "scope-alpha")).resolves.toBeNull();
    await expect(recall(USER, TID_A, "scope-alpha")).resolves.toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Recall relevance ranking + top-10 cap
// ---------------------------------------------------------------------------

describe("recall ranking", () => {
  test("exact key > key substring > value substring; non-matches excluded", async () => {
    const uid = `mem-test-u-${crypto.randomUUID().slice(0, 8)}`;
    await remember(uid, null, "packer hypothesis", "the packer hypothesis is documented");
    await remember(uid, null, "packer hypothesis notes", "notes about the packer");
    await remember(uid, null, "transport-notes", "the packer hypothesis is UPX-like");
    await remember(uid, null, "weather-today", "sunny with mild wind");

    const hits = await recall(uid, null, "packer hypothesis");
    expect(hits.map((m) => m.key)).toEqual([
      "packer hypothesis", // exact key (highest score)
      "packer hypothesis notes", // key contains query
      "transport-notes", // value contains query
    ]);
    expect(hits.map((m) => m.key)).not.toContain("weather-today");
  });

  test("top-10 cap: recall returns at most 10 matches", async () => {
    const uid = `mem-test-u-${crypto.randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 12; i++) {
      await remember(uid, null, `bulk-${String(i).padStart(2, "0")}`, `bulk item number ${i}`);
    }
    const hits = await recall(uid, null, "bulk item number");
    expect(hits).toHaveLength(10);
    for (const h of hits) expect(h.key.startsWith("bulk-")).toBe(true);
  });

  test("empty/whitespace query matches nothing", async () => {
    const uid = `mem-test-u-${crypto.randomUUID().slice(0, 8)}`;
    await remember(uid, null, "something", "a stored fact");
    await expect(recall(uid, null, "")).resolves.toHaveLength(0);
    await expect(recall(uid, null, "   ")).resolves.toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// System-prompt injection: buildMemoryInjection + runAgentLoop wiring
// ---------------------------------------------------------------------------

describe("memory injection into the system prompt", () => {
  test("buildMemoryInjection: null on no matches, full block under the cap", () => {
    expect(buildMemoryInjection([])).toBeNull();

    const block = buildMemoryInjection([
      memRow("global-note", "The user prefers short, direct answers.", null),
      memRow("elf-packer-hypothesis", "UPX-derived packer suspected for sample.elf.", TID_A),
    ]);
    expect(block).not.toBeNull();
    expect(block!).toContain(MEMORY_SECTION_HEADER);
    expect(block!).toContain("[global] global-note");
    expect(block!).toContain("[target] elf-packer-hypothesis");
    expect(block!.length).toBeLessThanOrEqual(MEMORY_INJECTION_MAX_CHARS);
    expect(block).not.toContain("more memories omitted");
  });

  test("buildMemoryInjection: hard 2000-char cap with explicit omission marker", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      memRow(`cap-entry-${i}`, `X`.repeat(400), null)
    );
    const block = buildMemoryInjection(many);
    expect(block).not.toBeNull();
    expect(block!.length).toBeLessThanOrEqual(MEMORY_INJECTION_MAX_CHARS);
    expect(block).toContain(MEMORY_SECTION_HEADER);
    expect(block).toContain("cap-entry-0");
    expect(block).toContain("…[more memories omitted]");
    // Deterministic: the cap is respected even with one huge first entry.
    const huge = buildMemoryInjection([memRow("huge", "Y".repeat(5000), null)]);
    expect(huge!.length).toBeLessThanOrEqual(MEMORY_INJECTION_MAX_CHARS);
  });

  test("free-chat loop: global memories injected before the first LLM call", async () => {
    await remember(USER, null, "user-prefers-brief-answers", "The user prefers short, direct answers with no filler.");
    const llm = fakeTextLlm();
    await runAgentLoop({
      sessionId: `mem-test-loop-free-${crypto.randomUUID().slice(0, 6)}`,
      target: null,
      userId: USER,
      userMessage: "what output style do you use for answers?",
      history: [],
      llmOverride: llm,
    });
    expect(llm.captured.length).toBeGreaterThan(0);
    const sys = llm.captured[0][0].content;
    expect(sys).toContain(MEMORY_SECTION_HEADER);
    expect(sys).toContain("user-prefers-brief-answers");
    expect(sys).toContain("[global]");
  });

  test("free-chat loop with NO memories: prompt untouched (no section)", async () => {
    const llm = fakeTextLlm();
    await runAgentLoop({
      sessionId: `mem-test-loop-bare-${crypto.randomUUID().slice(0, 6)}`,
      target: null,
      userId: OTHER_USER, // this user has no memories
      userMessage: "hello there, general question about file formats",
      history: [],
      llmOverride: llm,
    });
    // Nothing injected → the prompt is EXACTLY the base free-chat prompt
    // (no native addendum: supportsNativeTools false; no subagent addendum).
    // Note the prompt itself MENTIONS the header in its memory bullet, so
    // absence is asserted by equality, not by substring search.
    expect(llm.captured[0][0].content).toBe(freeChatSystemPrompt());
  });

  test("free-chat loop recalls GLOBAL scope only (target-scoped never injected)", async () => {
    await remember(USER, TID_A, "target-only-secret", "shared keyword target scoped secret");
    await remember(USER, null, "global-shared-fact", "shared keyword global scoped fact");
    const llm = fakeTextLlm();
    await runAgentLoop({
      sessionId: `mem-test-loop-scope-${crypto.randomUUID().slice(0, 6)}`,
      target: null,
      userId: USER,
      userMessage: "tell me about the shared keyword",
      history: [],
      llmOverride: llm,
    });
    const sys = llm.captured[0][0].content;
    expect(sys).toContain(MEMORY_SECTION_HEADER);
    expect(sys).toContain("global-shared-fact");
    expect(sys).not.toContain("target-only-secret");
  });

  test("target-chat loop: target-scoped memories injected into the system prompt", async () => {
    await remember(USER, TID_A, "elf-packer-hypothesis", "UPX-derived packer suspected for this target");
    const llm = fakeTextLlm();
    await runAgentLoop({
      sessionId: `mem-test-loop-target-${crypto.randomUUID().slice(0, 6)}`,
      target: fakeTarget(TID_A),
      userId: USER,
      userMessage: "continue the packer investigation",
      history: [],
      llmOverride: llm,
    });
    const sys = llm.captured[0][0].content;
    expect(sys).toContain(MEMORY_SECTION_HEADER);
    expect(sys).toContain("elf-packer-hypothesis");
    expect(sys).toContain("[target]");
  });

  test("loop-level: injected memory section is capped at 2000 characters", async () => {
    for (let i = 0; i < 12; i++) {
      await remember(USER, null, `loop-cap-${i}`, `Z`.repeat(400));
    }
    const llm = fakeTextLlm();
    await runAgentLoop({
      sessionId: `mem-test-loop-cap-${crypto.randomUUID().slice(0, 6)}`,
      target: null,
      userId: USER,
      userMessage: "loop cap entries recall please",
      history: [],
      llmOverride: llm,
    });
    const sys = llm.captured[0][0].content;
    // The injected block is APPENDED to the prompt (which itself mentions
    // the header in its memory bullet) — the block is the LAST occurrence.
    const idx = sys.lastIndexOf(MEMORY_SECTION_HEADER);
    expect(idx).toBeGreaterThan(0);
    const section = sys.slice(idx);
    expect(section.length).toBeLessThanOrEqual(MEMORY_INJECTION_MAX_CHARS);
    expect(section).toContain("…[more memories omitted]");
  });
});

// ---------------------------------------------------------------------------
// Tool layer: registry integration, scoping refusals, free-chat routing
// ---------------------------------------------------------------------------

describe("memory tools", () => {
  test("registered with scope any + dedup disabled; free-chat derivation includes them", () => {
    for (const name of ["remember", "recall", "forget"]) {
      const tool = AGENT_TOOLS.find((t) => t.name === name);
      expect(tool).toBeDefined();
      expect(tool!.scope).toBe("any");
      expect(tool!.dedup).toBe(false);
      expect(tool!.description.length).toBeGreaterThan(0);
    }
    expect(FREE_CHAT_TOOL_NAMES).toContain("remember");
    expect(FREE_CHAT_TOOL_NAMES).toContain("recall");
    expect(FREE_CHAT_TOOL_NAMES).toContain("forget");
  });

  test("registry path (target ctx): remember defaults to target scope, roundtrips, forget works", async () => {
    const ctx: AgentToolContext = {
      target: fakeTarget(TID_B),
      userId: USER,
      sessionId: `mem-test-ctx-${crypto.randomUUID().slice(0, 6)}`,
    };
    const remembered = await executeAgentTool(
      "remember",
      { key: "ctx-key", value: "verified via executeAgentTool" },
      ctx
    );
    expect(remembered).toContain("Remembered [target]");
    expect(remembered).toContain("ctx-key");

    const recalled = await executeAgentTool("recall", { query: "verified executeAgentTool" }, ctx);
    expect(recalled).toContain("Recalled 1 memory");
    expect(recalled).toContain("[target] ctx-key");

    const forgotten = await executeAgentTool("forget", { key: "ctx-key" }, ctx);
    expect(forgotten).toContain("Forgot [target]");

    const notFound = await executeAgentTool("forget", { key: "ctx-key" }, ctx);
    expect(notFound).toContain("No memory with key");
    expect(notFound).toContain("nothing was deleted");
  });

  test("free-chat path: remember/recall/forget run with target null (global scope only)", async () => {
    const session = { sessionId: `mem-test-free-${crypto.randomUUID().slice(0, 6)}`, userId: USER };
    const out = await runFreeChatTool("remember", { key: "free-key", value: "stored from a free chat" }, session);
    expect(out).toContain("Remembered [global]");

    const recallOut = await runFreeChatTool("recall", { query: "stored from a free chat" }, session);
    expect(recallOut).toContain("[global] free-key");

    // A target-scoped request in a free chat is REFUSED honestly, never
    // silently downgraded to global.
    const refused = await runFreeChatTool(
      "remember",
      { key: "refused-key", value: "x", scope: "target" },
      session
    );
    expect(refused.startsWith("Error:")).toBe(true);
    expect(refused).toContain('scope "target" requires a target');
    const refusedForget = await runFreeChatTool(
      "forget",
      { key: "free-key", scope: "target" },
      session
    );
    expect(refusedForget.startsWith("Error:")).toBe(true);

    const badScope = await runFreeChatTool("remember", { key: "k", value: "v", scope: "session" }, session);
    expect(badScope).toContain("'scope' must be");

    const forgot = await runFreeChatTool("forget", { key: "free-key" }, session);
    expect(forgot).toContain("Forgot [global]");
  });

  test("free-chat recall surfaces global memories but NOT target-scoped ones", async () => {
    const session = { sessionId: `mem-test-free-${crypto.randomUUID().slice(0, 6)}`, userId: USER };
    // Target-scoped entry stored through the REAL registry path:
    const ctx: AgentToolContext = {
      target: fakeTarget(TID_A),
      userId: USER,
      sessionId: `mem-test-ctx-${crypto.randomUUID().slice(0, 6)}`,
    };
    await executeAgentTool(
      "remember",
      { key: "target-only-secret", value: "shared keyword target scoped secret" },
      ctx
    );
    const out = await runRecallTool({ query: "shared keyword" }, { userId: USER, target: null });
    expect(out).toContain("[global]");
    expect(out).not.toContain("target-only-secret");
  });

  test("tool layer validation errors are honest strings (never throws)", async () => {
    const mem = { userId: USER, target: null };
    expect(await runRememberTool({}, mem)).toContain("'key' is required");
    expect(await runRememberTool({ key: "k" }, mem)).toContain("'value' is required");
    expect(await runRememberTool({ key: "k".repeat(121), value: "v" }, mem)).toContain("exceeds 120");
    expect(await runRememberTool({ key: "k", value: "v".repeat(4001) }, mem)).toContain("exceeds 4000");
    expect(await runRecallTool({}, mem)).toContain("'query' is required");
    expect(await runForgetTool({}, mem)).toContain("'key' is required");
    expect(await runForgetTool({ key: "nope" }, mem)).toContain("nothing was deleted");
  });
});
