#!/usr/bin/env bun
/**
 * Context window management (compaction) regression suite.
 *
 * Proves the agent loop keeps long investigations inside the model's context
 * window WITHOUT losing integrity guarantees:
 *   - compaction triggers only when estimated tokens cross 80% of the
 *     model's known context window, and only BETWEEN iterations (never while
 *     a tool result is being processed);
 *   - the injected state document is labeled [COMPACTED INVESTIGATION STATE],
 *     carries the summarizer output, and keeps the system prompt + last 6
 *     messages verbatim;
 *   - tool receipts SURVIVE compaction: the state document always contains a
 *     tool execution summary rebuilt from native role:"tool" results,
 *     text-path TOOL RESULT rows, and cross-turn toolReceiptSuffix blocks;
 *   - short conversations are never compacted (no summarizer call at all);
 *   - the boundary never splits native tool traffic (assistant tool_calls
 *     messages stay glued to their role:"tool" answers).
 *
 * Threshold math uses the moonshot-v1-8k table entry (window 8000 →
 * compaction above floor(8000 * 0.8) = 6400 estimated tokens) so tests stay
 * small while exercising the real getContextWindowSize lookup.
 * Run:  bun test src/server/agent/__tests__/compaction.test.ts
 */
import { describe, test, expect, afterAll } from "bun:test";
import {
  runAgentLoop,
  computeCompactionBoundary,
  extractToolExecutionSummary,
  buildCompactedStateMessage,
  toolReceiptSuffix,
  COMPACTION_KEEP_LAST,
  COMPACTION_LABEL,
  COMPACTION_PROMPT,
  COMPACTION_THRESHOLD_RATIO,
  type AgentEventHandlers,
  type AgentLoopResult,
} from "@/server/agent/agent";
import {
  getContextWindowSize,
  estimateTokens,
  DEFAULT_CONTEXT_WINDOW,
  ENGLISH_CHARS_PER_TOKEN,
  CODE_CHARS_PER_TOKEN,
  MESSAGE_OVERHEAD_TOKENS,
  type LlmMessage,
  type LlmToolsResult,
  type ResolvedLlm,
} from "@/server/agent/providers";
import { TOOL_REFUSAL_MARKER } from "@/server/agent/tools";
import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const TOOL_FENCE = "```tool";

const FAKE_STATE_SUMMARY =
  "## Target info\nSynthetic target from the compaction suite.\n" +
  "## Tools used\nupdate_plan ×3.\n## Key findings\n[OBSERVED] plan steps tracked.\n" +
  "## Dead ends\nnone.\n## Current hypothesis\ncompaction preserves state.\n## Next steps\nfinal answer.";

/**
 * Scripted NATIVE LLM with a separate summarizer channel: model turns come
 * from callLLMTools (native protocol), the compaction summarizer comes from
 * callLLM (branching on the exact COMPACTION_PROMPT prefix). Records the
 * full captured transcript per model turn + every summarizer input + a
 * shared event order log so tests can prove compaction never interleaves
 * with tool-result processing.
 */
function fakeNativeLlmWithSummarizer(script: LlmToolsResult[]): ResolvedLlm & {
  calls: () => number;
  captured: LlmMessage[][];
  summarizerInputs: string[];
  order: Array<"tool" | "compact" | "turn">;
} {
  let call = 0;
  const captured: LlmMessage[][] = [];
  const summarizerInputs: string[] = [];
  const order: Array<"tool" | "compact" | "turn"> = [];
  return {
    source: "byok" as const,
    provider: "kimi" as const,
    // moonshot-v1-8k → known 8k window in the lookup table; the fake still
    // declares native capability (the flag is per resolved LLM, not per def).
    model: "moonshot-v1-8k",
    supportsNativeTools: true,
    callLLM: async (messages) => {
      const content = messages[0]?.content ?? "";
      if (!content.startsWith(COMPACTION_PROMPT)) {
        throw new Error(
          `unexpected callLLM on the native path (only the summarizer may call it): ${content.slice(0, 80)}`
        );
      }
      summarizerInputs.push(content);
      order.push("compact");
      return FAKE_STATE_SUMMARY;
    },
    callLLMTools: async (messages) => {
      captured.push(messages.map((m) => ({ ...m })));
      order.push("turn");
      const turn = script[Math.min(call, script.length - 1)];
      call++;
      return turn;
    },
    calls: () => call,
    captured,
    summarizerInputs,
    order,
  } as unknown as ResolvedLlm & {
    calls: () => number;
    captured: LlmMessage[][];
    summarizerInputs: string[];
    order: Array<"tool" | "compact" | "turn">;
  };
}

/** Scripted TEXT-path LLM (no native capability): callLLM serves both model
 * turns and the compaction summarizer, branched on the prompt marker. */
function fakeTextLlmWithSummarizer(script: string[]): ResolvedLlm & {
  calls: () => number;
  captured: LlmMessage[][];
  summarizerInputs: string[];
} {
  let call = 0;
  const captured: LlmMessage[][] = [];
  const summarizerInputs: string[] = [];
  return {
    source: "byok" as const,
    // Same small window as the native fake (moonshot-v1-8k → 8k in the
    // lookup table). NO supportsNativeTools / callLLMTools: the loop must
    // take the TEXT protocol regardless of provider identity.
    provider: "kimi" as const,
    model: "moonshot-v1-8k",
    callLLM: async (messages) => {
      const content = messages[0]?.content ?? "";
      if (content.startsWith(COMPACTION_PROMPT)) {
        summarizerInputs.push(content);
        return FAKE_STATE_SUMMARY;
      }
      captured.push(messages.map((m) => ({ ...m })));
      const text = script[Math.min(call, script.length - 1)];
      call++;
      return text;
    },
    calls: () => call,
    captured,
    summarizerInputs,
  } as unknown as ResolvedLlm & {
    calls: () => number;
    captured: LlmMessage[][];
    summarizerInputs: string[];
  };
}

const planArgs = (step: string) => ({
  tasks: [
    { title: step, status: "in_progress" },
    { title: "Report findings", status: "pending" },
  ],
});

const freeChatOpts = {
  target: null,
  userId: "cp-regression",
  history: [] as Array<{ role: "user" | "assistant"; content: string }>,
};

/** Long prose user message: ceil(chars/4) tokens ≈ 7,500 — crosses the 6,400
 * token compaction threshold of the 8k test window by itself. */
const LONG_USER = "x".repeat(30_000);

function toolResultRecorder(order?: Array<"tool" | "compact" | "turn">) {
  const results: string[] = [];
  const handler: AgentEventHandlers = {
    onToolResult: (_tool, result) => {
      results.push(result);
      order?.push("tool");
    },
  };
  return { results, handler };
}

const toolBlock = (step: string) =>
  `${TOOL_FENCE}\n${JSON.stringify({ tool: "update_plan", args: planArgs(step) })}\n${"```"}`;

afterAll(async () => {
  // The loop persists assistant rows for real — clean the synthetic ones.
  await db.chatMessage.deleteMany({ where: { sessionId: { startsWith: "cp-" } } });
});

// ---------------------------------------------------------------------------
// Helper units: window lookup + token estimate + protocol-safe boundary
// ---------------------------------------------------------------------------

describe("getContextWindowSize", () => {
  test("exact table hits for every advertised catalog model class", () => {
    expect(getContextWindowSize("openai", "gpt-4o")).toBe(128_000);
    expect(getContextWindowSize("openai", "gpt-4o-mini")).toBe(128_000);
    expect(getContextWindowSize("openai", "gpt-4.1")).toBe(1_000_000);
    expect(getContextWindowSize("anthropic", "claude-sonnet-4-20250514")).toBe(200_000);
    expect(getContextWindowSize("anthropic", "claude-opus-4-20250514")).toBe(200_000);
    expect(getContextWindowSize("deepseek", "deepseek-chat")).toBe(64_000);
    expect(getContextWindowSize("deepseek", "deepseek-reasoner")).toBe(64_000);
    expect(getContextWindowSize("glm", "glm-4")).toBe(128_000);
    expect(getContextWindowSize("glm", "glm-4.6")).toBe(200_000);
    expect(getContextWindowSize("kimi", "moonshot-v1-8k")).toBe(8_000);
    expect(getContextWindowSize("kimi", "moonshot-v1-32k")).toBe(32_000);
    expect(getContextWindowSize("kimi", "moonshot-v1-128k")).toBe(128_000);
    expect(getContextWindowSize("gemini", "gemini-2.5-flash")).toBe(1_000_000);
    // Platform fallback resolves provider=model="glm-platform".
    expect(getContextWindowSize("glm-platform", "glm-platform")).toBe(128_000);
  });

  test("prefix, suffix and case tolerance + the 128k default", () => {
    // Dated vendor id resolving through its base entry (prefix match).
    expect(getContextWindowSize("anthropic", "claude-sonnet-4-29990101")).toBe(200_000);
    // Kimi-style "-Nk" suffix encodes the window even for unlisted sizes.
    expect(getContextWindowSize("kimi", "moonshot-v1-16k")).toBe(16_000);
    // Case-insensitive + whitespace tolerant.
    expect(getContextWindowSize("openai", " GPT-4O ")).toBe(128_000);
    // Unknown / empty → conservative default.
    expect(getContextWindowSize("openai", "totally-unknown-model")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(getContextWindowSize("openai", "")).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(getContextWindowSize("openai", "some-future-99k-model".replace("99k", "x"))).toBe(
      DEFAULT_CONTEXT_WINDOW
    );
  });
});

describe("estimateTokens", () => {
  test("empty input → 0; prose counts at ~4 chars/token plus per-message overhead", () => {
    expect(estimateTokens([])).toBe(0);
    const one: LlmMessage[] = [{ role: "user", content: "a".repeat(400) }];
    expect(estimateTokens(one)).toBe(MESSAGE_OVERHEAD_TOKENS + 400 / ENGLISH_CHARS_PER_TOKEN);
  });

  test("fenced code counts at ~2 chars/token, prose around it at ~4", () => {
    const content = `look:\n${TOOL_FENCE}\n${"a".repeat(200)}\n${"```"}`;
    // Fence match: "```tool\n" (8) + 200 + "\n```" (4) = 212 code chars.
    const tokens = estimateTokens([{ role: "assistant", content }]);
    const expected =
      MESSAGE_OVERHEAD_TOKENS +
      Math.ceil("look:\n".length / ENGLISH_CHARS_PER_TOKEN) +
      Math.ceil(212 / CODE_CHARS_PER_TOKEN);
    expect(tokens).toBe(expected);
    // Code must weigh MORE tokens per char than prose — the whole point of
    // the split (2 chars/token doubles the estimate for the same chars).
    const proseSameLength = estimateTokens([{ role: "user", content: "b".repeat(212) }]);
    expect(tokens).toBeGreaterThan(
      MESSAGE_OVERHEAD_TOKENS + Math.ceil(6 / ENGLISH_CHARS_PER_TOKEN)
    );
    expect(tokens - MESSAGE_OVERHEAD_TOKENS).toBeGreaterThan(
      proseSameLength - MESSAGE_OVERHEAD_TOKENS
    );
  });

  test("unterminated fences count as code; native toolCalls arguments count as code + framing", () => {
    const unterminated = estimateTokens([
      { role: "assistant", content: `${TOOL_FENCE}\n${"a".repeat(100)}` },
    ]);
    expect(unterminated).toBe(MESSAGE_OVERHEAD_TOKENS + Math.ceil(108 / CODE_CHARS_PER_TOKEN));

    const withCall: LlmMessage[] = [
      {
        role: "assistant",
        content: "checking",
        toolCalls: [{ id: "c1", name: "update_plan", arguments: { a: "x" } }],
      },
    ];
    // '{"a":"x"}' = 9 chars at the code rate + 8 framing tokens.
    expect(estimateTokens(withCall)).toBe(
      MESSAGE_OVERHEAD_TOKENS +
        Math.ceil("checking".length / ENGLISH_CHARS_PER_TOKEN) +
        Math.ceil(9 / CODE_CHARS_PER_TOKEN) +
        8
    );
  });
});

describe("computeCompactionBoundary", () => {
  const m = (role: LlmMessage["role"], content: string, toolCalls?: unknown): LlmMessage =>
    ({ role, content, ...(toolCalls ? { toolCalls } : {}) } as LlmMessage);

  test("nothing to compact when the transcript barely exceeds system prompt + tail", () => {
    const msgs = [m("assistant", "sys"), m("user", "u1"), m("user", "u2"), m("user", "u3")];
    expect(computeCompactionBoundary(msgs, COMPACTION_KEEP_LAST)).toBeNull();
  });

  test("plain transcript: middle = everything between the system prompt and the last 6", () => {
    const msgs = [
      m("assistant", "sys"),
      m("user", "u1"),
      m("user", "u2"),
      m("assistant", "a1"),
      m("user", "t1"),
      m("assistant", "a2"),
      m("user", "t2"),
      m("assistant", "a3"),
      m("user", "t3"),
    ];
    const b = computeCompactionBoundary(msgs, 6);
    expect(b).toEqual({ from: 1, to: 3 });
    expect(b).not.toBeNull();
    const cut = b as { from: number; to: number };
    // Middle excludes system prompt and tail; tail stays verbatim.
    expect(msgs.slice(cut.from, cut.to).map((x) => x.content)).toEqual(["u1", "u2"]);
    expect(msgs.slice(cut.to).map((x) => x.content)).toEqual(["a1", "t1", "a2", "t2", "a3", "t3"]);
  });

  test("never orphans native tool traffic: tail starting on role:tool pulls its assistant in", () => {
    const tc = [{ id: "c", name: "update_plan", arguments: {} }];
    const msgs = [
      m("assistant", "sys"),
      m("user", "u1"),
      m("assistant", "a1", tc), // group 1 — compacted whole
      m("tool", "r1", undefined),
      m("assistant", "a2", tc), // group 2 — its answer would be orphaned
      m("tool", "r2", undefined),
      m("user", "u2"),
      m("assistant", "a3"),
      m("user", "u3"),
    ];
    // to = 9 - 4 = 5 → messages[5] is r2 (a tool answer) → the tail extends
    // left to start at a2 so the answer group stays whole.
    const b = computeCompactionBoundary(msgs, 4);
    expect(b).toEqual({ from: 1, to: 4 });
    expect(b).not.toBeNull();
    const cut = b as { from: number; to: number };
    const tail = msgs.slice(cut.to);
    expect(tail[0].role).not.toBe("tool");
    expect(tail.map((x) => x.content)).toContain("a2");
    expect(tail.map((x) => x.content)).toContain("r2");
    // Group 1 stays in the compacted middle (compacted together, not split).
    const middle = msgs.slice(cut.from, cut.to);
    expect(middle.map((x) => x.content)).toEqual(["u1", "a1", "r1"]);
  });

  test("the walk covers CONSECUTIVE tool answers, not just the first one", () => {
    const tc = [{ id: "c", name: "update_plan", arguments: {} }];
    const msgs = [
      m("assistant", "sys"),
      m("user", "u1"),
      m("assistant", "a1", tc),
      m("tool", "r1", undefined),
      m("tool", "r1b", undefined), // two parallel answers, one group
      m("user", "u2"),
      m("assistant", "a2"),
      m("user", "u3"),
      m("user", "u4"),
    ];
    // to = 9 - 5 = 4 → messages[4] is r1b → walk to r1 → walk to a1.
    const b = computeCompactionBoundary(msgs, 5);
    expect(b).toEqual({ from: 1, to: 2 });
    expect(b).not.toBeNull();
    const cut = b as { from: number; to: number };
    const tail = msgs.slice(cut.to);
    expect(tail[0].content).toBe("a1");
    expect(tail.map((x) => x.content)).toContain("r1");
    expect(tail.map((x) => x.content)).toContain("r1b");
  });

  test("assistant tool_calls immediately before the tail is compacted together with its answers", () => {
    const tc = [{ id: "c", name: "update_plan", arguments: {} }];
    const msgs = [
      m("assistant", "sys"),
      m("user", "u1"),
      m("user", "u2"),
      m("assistant", "a1", tc),
      m("tool", "r1", undefined),
      m("user", "u3"),
      m("assistant", "a2"),
      m("user", "u4"),
      m("user", "u5"),
    ];
    // to = 9 - 4 = 5 → messages[5] = u3 (plain) → no walk needed; a1 + r1
    // land in the middle TOGETHER (never split across the boundary).
    const b = computeCompactionBoundary(msgs, 4);
    expect(b).toEqual({ from: 1, to: 5 });
    expect(b).not.toBeNull();
    const cut = b as { from: number; to: number };
    const middle = msgs.slice(cut.from, cut.to).map((x) => x.content);
    const tail = msgs.slice(cut.to).map((x) => x.content);
    expect(middle).toContain("a1");
    expect(middle).toContain("r1");
    expect(tail).not.toContain("r1");
    expect(tail[0]).toBe("u3");
  });
});

describe("extractToolExecutionSummary / buildCompactedStateMessage", () => {
  test("collects native tool results, text-path TOOL RESULT rows, and receipt bullets; empty → honest none", () => {
    const receipt = toolReceiptSuffix(
      JSON.stringify([
        { tool: "explore_url", args: { url: "https://example.com" }, result: "HTTP 200 — 1.2 KB" },
      ])
    );
    const middle: LlmMessage[] = [
      {
        role: "tool",
        content: "Plan updated: 2 steps.",
        toolCallId: "call_9",
      },
      { role: "user", content: `TOOL RESULT for workspace_run:\nexit 0` },
      { role: "assistant", content: `Earlier work.${receipt}` },
      { role: "user", content: "nothing here" },
    ];
    const summary = extractToolExecutionSummary(middle);
    expect(summary).toContain("### Tool execution summary");
    expect(summary).toContain("- tool result (call call_9): Plan updated: 2 steps.");
    expect(summary).toContain("- TOOL RESULT for workspace_run:");
    expect(summary).toContain("- explore_url(");
    expect(summary).toContain("HTTP 200 — 1.2 KB");
    // Refused receipt entries keep their honest never-ran label.
    expect(
      extractToolExecutionSummary([
        {
          role: "assistant",
          content: toolReceiptSuffix(
            JSON.stringify([{ tool: "area_tool", args: {}, result: `${TOOL_REFUSAL_MARKER} — nope` }])
          ),
        },
      ])
    ).toContain("[REFUSED — did not run]");
    expect(extractToolExecutionSummary([{ role: "user", content: "nothing" }])).toContain(
      "(no tool executions recorded in the compacted segment)"
    );
  });

  test("buildCompactedStateMessage: labeled, carries the summary, always includes the receipt section", () => {
    const msg = buildCompactedStateMessage("  STATE BODY  ", [{ role: "user", content: "u" }]);
    expect(msg.role).toBe("user");
    expect(msg.content.startsWith(COMPACTION_LABEL)).toBe(true);
    expect(msg.content).toContain("STATE BODY");
    expect(msg.content).toContain("### Tool execution summary");
    // Empty summarizer output degrades honestly instead of vanishing.
    const empty = buildCompactedStateMessage("   \n", []);
    expect(empty.content).toContain("(the summarizer returned no content)");
  });
});

// ---------------------------------------------------------------------------
// Loop-level compaction (native path): triggers, ordering, injection
// ---------------------------------------------------------------------------

describe("runAgentLoop compaction — native path", () => {
  test(
    "compaction triggers at the 80% threshold, never mid-tool-execution, and replaces the middle",
    async () => {
      const llm = fakeNativeLlmWithSummarizer([
        { content: "Tracking step 1.", toolCalls: [{ id: "c1", name: "update_plan", arguments: planArgs("step 1") }] },
        { content: "Tracking step 2.", toolCalls: [{ id: "c2", name: "update_plan", arguments: planArgs("step 2") }] },
        { content: "Tracking step 3.", toolCalls: [{ id: "c3", name: "update_plan", arguments: planArgs("step 3") }] },
        { content: "Final answer from the compacted transcript.", toolCalls: [] },
      ]);
      const { handler } = toolResultRecorder(llm.order);
      const result = await runAgentLoop({
        sessionId: `cp-native-threshold-${Date.now()}`,
        userMessage: LONG_USER,
        events: handler,
        ...freeChatOpts,
        llmOverride: llm,
      });

      expect(result.content).toBe("Final answer from the compacted transcript.");
      expect(result.compactionCount).toBe(1);
      expect(llm.summarizerInputs).toHaveLength(1);

      // Ordering: EVERY tool result of the turn was processed BEFORE the
      // compaction checkpoint ran (compaction only ever runs between
      // iterations, never while a tool result is being processed).
      expect(llm.order).toEqual(["turn", "tool", "turn", "tool", "turn", "tool", "compact", "turn"]);

      // The summarizer received the verbatim required prompt.
      expect(llm.summarizerInputs[0].startsWith(COMPACTION_PROMPT)).toBe(true);
      expect(llm.summarizerInputs[0]).toContain("INVESTIGATION TRANSCRIPT");
      expect(llm.summarizerInputs[0]).toContain(LONG_USER.slice(0, 50));

      // The final model turn saw the compacted transcript: exactly one
      // labeled state document, the huge original user message GONE.
      const final = llm.captured[llm.captured.length - 1];
      const compacted = final.filter((m) => m.content.includes(COMPACTION_LABEL));
      expect(compacted).toHaveLength(1);
      expect(compacted[0].role).toBe("user");
      expect(compacted[0].content).toContain(FAKE_STATE_SUMMARY);
      expect(compacted[0].content).toContain("### Tool execution summary");
      expect(final.some((m) => m.content === LONG_USER)).toBe(false);
      // System prompt and the last-6 tail stayed verbatim (3 tool exchanges).
      expect(final[0].content).toContain("NATIVE tool calling"); // system prompt + native addendum
      const tail = final.slice(2);
      expect(tail).toHaveLength(6);
      expect(tail.filter((m) => m.role === "tool")).toHaveLength(3);
      expect(tail[0].content).toBe("Tracking step 1.");
      // Tool results genuinely executed and were traced.
      expect(result.toolCalls).toHaveLength(3);
      expect(result.toolCalls.every((t) => t.result.includes("Plan updated"))).toBe(true);
    },
    20_000
  );

  test(
    "tool receipts survive compaction: toolReceiptSuffix blocks flow into the state document",
    async () => {
      const receiptRow = toolReceiptSuffix(
        JSON.stringify([
          {
            tool: "explore_url",
            args: { url: "https://example.com/target" },
            result: "HTTP 200 — 1.2 KB text/html, 3 scripts",
          },
          {
            tool: "area_tool",
            args: { tool: "strings" },
            result: `${TOOL_REFUSAL_MARKER} — not allowlisted`,
          },
        ])
      );
      const llm = fakeNativeLlmWithSummarizer([
        { content: "Continuing.", toolCalls: [{ id: "c1", name: "update_plan", arguments: planArgs("carry on") }] },
        { content: "More.", toolCalls: [{ id: "c2", name: "update_plan", arguments: planArgs("carry on 2") }] },
        { content: "More still.", toolCalls: [{ id: "c3", name: "update_plan", arguments: planArgs("carry on 3") }] },
        { content: "Receipts preserved; done.", toolCalls: [] },
      ]);
      const result = await runAgentLoop({
        sessionId: `cp-native-receipts-${Date.now()}`,
        ...freeChatOpts,
        userMessage: LONG_USER,
        // The chat route replays history exactly like this: past assistant
        // rows carry their toolCalls JSON as a toolReceiptSuffix block.
        // (history must come AFTER the spread — freeChatOpts carries history: [].)
        history: [
          { role: "assistant", content: `Earlier I fetched the target.${receiptRow}` },
          { role: "user", content: "keep going" },
        ],
        events: toolResultRecorder().handler,
        llmOverride: llm,
      });

      expect(result.content).toBe("Receipts preserved; done.");
      // TWO compactions fire in this fixture: (1) the receipt-bearing history
      // row compacts; (2) the still-huge long user message compacts again —
      // and the receipt section must SURVIVE the second round via the state
      // document carry-forward.
      expect(result.compactionCount).toBe(2);
      const final = llm.captured[llm.captured.length - 1];
      const compacted = final.find((m) => m.content.includes(COMPACTION_LABEL));
      expect(compacted).toBeDefined();
      // The receipt block from the compacted-away history row survives in the
      // state document — executions AND the honest refusal label.
      expect(compacted!.content).toContain("- explore_url(");
      expect(compacted!.content).toContain("https://example.com/target");
      expect(compacted!.content).toContain("HTTP 200 — 1.2 KB text/html");
      expect(compacted!.content).toContain("[REFUSED — did not run]");
      expect(compacted!.content).toContain("tool executions GENUINELY ran");
      // The original receipt-bearing row itself is gone from the transcript.
      expect(final.some((m) => m.content.includes("Earlier I fetched the target"))).toBe(false);
    },
    20_000
  );

  test(
    "no compaction under threshold: zero summarizer calls, zero labels, loop untouched",
    async () => {
      const llm = fakeNativeLlmWithSummarizer([
        { content: "Step one.", toolCalls: [{ id: "c1", name: "update_plan", arguments: planArgs("a") }] },
        { content: "Step two.", toolCalls: [{ id: "c2", name: "update_plan", arguments: planArgs("b") }] },
        { content: "Final answer, no compaction needed.", toolCalls: [] },
      ]);
      const result = await runAgentLoop({
        sessionId: `cp-native-under-${Date.now()}`,
        userMessage: "Short investigation, please.",
        events: toolResultRecorder().handler,
        ...freeChatOpts,
        llmOverride: llm,
      });

      expect(result.content).toBe("Final answer, no compaction needed.");
      expect(result.compactionCount).toBe(0);
      expect(llm.summarizerInputs).toHaveLength(0);
      // No labeled message was ever injected into any model turn.
      for (const turn of llm.captured) {
        expect(turn.some((m) => m.content.includes(COMPACTION_LABEL))).toBe(false);
      }
      expect(llm.calls()).toBe(3);
      // And the tools really ran.
      expect(result.toolCalls).toHaveLength(2);
    },
    20_000
  );
});

// ---------------------------------------------------------------------------
// Loop-level compaction (text path): protocol-agnostic behavior
// ---------------------------------------------------------------------------

describe("runAgentLoop compaction — text path", () => {
  test(
    "state document is injected correctly on the text protocol (position, label, receipts)",
    async () => {
      // History mirrors what the chat route replays: a past assistant row
      // carrying its toolReceiptSuffix block. Two compactions fire: (1) the
      // receipt row compacts; (2) the still-huge long user message compacts
      // again — the receipt section must survive BOTH rounds.
      const receiptRow = toolReceiptSuffix(
        JSON.stringify([
          {
            tool: "explore_url",
            args: { url: "https://example.com/a" },
            result: "HTTP 200 — 900 bytes text/html",
          },
        ])
      );
      const llm = fakeTextLlmWithSummarizer([
        toolBlock("step 1"),
        toolBlock("step 2"),
        toolBlock("step 3"),
        "Final answer from the TEXT path after compaction.",
      ]);
      const result = await runAgentLoop({
        sessionId: `cp-text-inject-${Date.now()}`,
        ...freeChatOpts,
        userMessage: LONG_USER,
        history: [
          { role: "assistant", content: `Earlier I probed the target.${receiptRow}` },
          { role: "user", content: "continue the investigation" },
        ],
        events: toolResultRecorder().handler,
        llmOverride: llm,
      });

      expect(result.content).toBe("Final answer from the TEXT path after compaction.");
      expect(result.compactionCount).toBe(2);
      expect(llm.summarizerInputs).toHaveLength(2);
      for (const input of llm.summarizerInputs) {
        expect(input.startsWith(COMPACTION_PROMPT)).toBe(true);
      }

      const final = llm.captured[llm.captured.length - 1];
      // Injected EXACTLY where the middle was: right after the system prompt.
      expect(final[0].role).toBe("assistant"); // system prompt (text protocol marker)
      expect(final[1].role).toBe("user");
      expect(final[1].content.startsWith(COMPACTION_LABEL)).toBe(true);
      expect(final[1].content).toContain(FAKE_STATE_SUMMARY);
      // Receipts from the compacted-away history row survive BOTH compaction
      // rounds and land in the final state document.
      expect(final[1].content).toContain("- explore_url(");
      expect(final[1].content).toContain("https://example.com/a");
      expect(final[1].content).toContain("HTTP 200 — 900 bytes text/html");
      expect(final[1].content).toContain("tool executions GENUINELY ran");
      // The huge original user message and the receipt-bearing history row
      // are compacted away; the 6-message tail stayed verbatim.
      expect(final.some((m) => m.content === LONG_USER)).toBe(false);
      expect(final.some((m) => m.content.includes("Earlier I probed the target"))).toBe(false);
      const tail = final.slice(2);
      expect(tail).toHaveLength(6);
      expect(tail.filter((m) => m.content.startsWith("TOOL RESULT for update_plan"))).toHaveLength(3);
      expect(tail[0].content).toContain('"step 1"');
      // Threshold math sanity for THIS fixture (documented, not coincidental):
      // 8k window → 6400-token budget; the long user alone ≈ 7.5k tokens.
      expect(Math.floor(8000 * COMPACTION_THRESHOLD_RATIO)).toBe(6400);
      expect(estimateTokens([{ role: "user", content: LONG_USER }])).toBeGreaterThan(6400);
    },
    20_000
  );

  test(
    "no compaction occurs under threshold on the text path either",
    async () => {
      const llm = fakeTextLlmWithSummarizer([
        toolBlock("only step"),
        "Text-path final answer, small transcript.",
      ]);
      const result: AgentLoopResult = await runAgentLoop({
        sessionId: `cp-text-under-${Date.now()}`,
        userMessage: "Small question.",
        events: toolResultRecorder().handler,
        ...freeChatOpts,
        llmOverride: llm,
      });
      expect(result.content).toBe("Text-path final answer, small transcript.");
      expect(result.compactionCount).toBe(0);
      expect(llm.summarizerInputs).toHaveLength(0);
      for (const turn of llm.captured) {
        expect(turn.some((m) => m.content.includes(COMPACTION_LABEL))).toBe(false);
      }
    },
    20_000
  );
});
