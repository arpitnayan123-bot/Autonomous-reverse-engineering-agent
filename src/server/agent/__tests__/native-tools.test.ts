#!/usr/bin/env bun
/**
 * Native provider tool-calling regression suite.
 *
 * Proves the dual-protocol agent loop executes REAL tools on the native
 * function-calling path with every integrity guarantee of the text path:
 *   - single tool call: executed, traced, result fed back as role:"tool";
 *   - parallel tool calls: executed SEQUENTIALLY (tools are not thread-safe),
 *     all results reported back in one protocol-valid turn;
 *   - malformed provider arguments: never executed, answered with an honest
 *     error (loop level AND real provider SSE level);
 *   - providers without the native flag transparently use the text protocol;
 *   - the fabrication gate (finalizeTurnContent) fires on the native path;
 *   - serialization contracts: OpenAI role:"tool"/tool_calls wire format,
 *     Anthropic tool_use/tool_result blocks (merged into ONE user turn);
 *   - transient-error retry discipline on callTurnTools (no retry after
 *     deltas, never retrying cancellation).
 *
 * No external network: the provider-level test runs against a local SSE
 * fixture server (Bun.serve on an ephemeral port).
 * Run:  bun test src/server/agent/__tests__/native-tools.test.ts
 */
import { describe, test, expect, afterAll } from "bun:test";
import {
  runAgentLoop,
  callTurnTools,
  finalizeTurnContent,
  type AgentToolTrace,
  type AgentEventHandlers,
} from "@/server/agent/agent";
import {
  toNativeSchema,
  nativeToolSchemas,
  FREE_CHAT_TOOL_NAMES,
  TOOL_REFUSAL_MARKER,
} from "@/server/agent/tools";
import {
  PROVIDERS,
  providerChatTools,
  coerceToolCallArguments,
  openAiCompatibleTools,
  openAiNativeMessages,
  anthropicNativeMessages,
  type LlmMessage,
  type LlmToolCall,
  type LlmToolsResult,
  type ResolvedLlm,
  type ToolSchema,
  type TokenUsage,
} from "@/server/agent/providers";
import { db } from "@/lib/db";
import type { Target } from "@prisma/client";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const TOOL_FENCE = "```tool";

/** Scripted NATIVE LLM: each callLLMTools call consumes the next scripted
 * turn; records every (messages, tools) pair for transcript assertions. */
function fakeNativeLlm(script: LlmToolsResult[]): ResolvedLlm & {
  calls: () => number;
  captured: Array<{ messages: LlmMessage[]; tools: ToolSchema[] }>;
} {
  let call = 0;
  const captured: Array<{ messages: LlmMessage[]; tools: ToolSchema[] }> = [];
  return {
    source: "byok" as const,
    provider: "openai" as const,
    model: "gpt-4o-mini",
    supportsNativeTools: true,
    callLLM: async () => {
      throw new Error("callLLM must not be used on the native path");
    },
    callLLMTools: async (messages, tools) => {
      captured.push({ messages, tools });
      const turn = script[Math.min(call, script.length - 1)];
      call++;
      return turn;
    },
    calls: () => call,
    captured,
  } as unknown as ResolvedLlm & {
    calls: () => number;
    captured: Array<{ messages: LlmMessage[]; tools: ToolSchema[] }>;
  };
}

/** Scripted TEXT-path LLM (no native capability declared). */
function fakeTextLlm(
  script: string[]
): ResolvedLlm & { calls: () => number; captured: LlmMessage[][] } {
  let call = 0;
  const captured: LlmMessage[][] = [];
  return {
    source: "platform" as const,
    provider: "glm-platform" as const,
    model: "glm-platform",
    callLLM: async (messages) => {
      captured.push(messages);
      const text = script[Math.min(call, script.length - 1)];
      call++;
      return text;
    },
    calls: () => call,
    captured,
  } as unknown as ResolvedLlm & { calls: () => number; captured: LlmMessage[][] };
}

const planArgs = (title: string) => ({
  tasks: [
    { title, status: "in_progress" },
    { title: "Report findings", status: "pending" },
  ],
});

const freeChatOpts = {
  target: null,
  userId: "nt-regression",
  history: [],
} as const;

afterAll(async () => {
  // The loop persists assistant rows for real — clean the synthetic ones so
  // the suite leaves no garbage (same hygiene as regression-agent.ts).
  await db.chatMessage.deleteMany({ where: { sessionId: { startsWith: "nt-" } } });
});

// ---------------------------------------------------------------------------
// Capability surface (registry → native schemas, per-provider flags)
// ---------------------------------------------------------------------------

describe("native tool schema surface", () => {
  test("toNativeSchema emits the OpenAI function-calling shape from the registry", () => {
    const tool = {
      name: "update_plan",
      description: "Maintain a plan.",
      args: { type: "object", properties: {}, required: [] },
    };
    const schema = toNativeSchema(tool as Parameters<typeof toNativeSchema>[0]);
    expect(schema.type).toBe("function");
    expect(schema.function.name).toBe("update_plan");
    expect(schema.function.description).toBe("Maintain a plan.");
    expect(schema.function.parameters).toEqual({ type: "object", properties: {}, required: [] });
  });

  test("free scope advertises exactly the routable any-scoped tools; target scope advertises all", () => {
    const free = nativeToolSchemas("free");
    const target = nativeToolSchemas("target");
    expect(free.map((s) => s.function.name).sort()).toEqual([...FREE_CHAT_TOOL_NAMES].sort());
    // The model must never see a tool the loop cannot route in a free chat.
    expect(free.map((s) => s.function.name)).not.toContain("rea_tool");
    expect(free.map((s) => s.function.name)).not.toContain("read_hex");
    expect(target.length).toBeGreaterThanOrEqual(free.length);
    expect(target.map((s) => s.function.name)).toContain("rea_tool");
    // Every schema carries a non-empty description + object parameters.
    for (const s of free) {
      expect(s.type).toBe("function");
      expect(s.function.description.length).toBeGreaterThan(0);
      expect((s.function.parameters as Record<string, unknown>).type).toBe("object");
    }
  });

  test("per-provider capability flags are honest: implemented providers true, gemini false", () => {
    const flags = Object.fromEntries(PROVIDERS.map((p) => [p.id, p.supportsNativeTools]));
    expect(flags).toEqual({
      openai: true,
      anthropic: true,
      deepseek: true,
      kimi: true,
      glm: true,
      gemini: false,
    });
  });

  test("providerChatTools refuses providers without a native implementation", async () => {
    await expect(
      providerChatTools("gemini", "key", "gemini-2.5-flash", [{ role: "user", content: "hi" }], [], () => {})
    ).rejects.toThrow(/does not support native tool calling/);
  });

  test("coerceToolCallArguments: empty is a valid no-arg call; non-object and unparsable are malformed", () => {
    expect(coerceToolCallArguments("")).toEqual({ args: {} });
    expect(coerceToolCallArguments("null")).toEqual({ args: {} });
    expect(coerceToolCallArguments('{"tasks":[]}').args).toEqual({ tasks: [] });
    const scalar = coerceToolCallArguments('"just a string"');
    expect(scalar.malformedArguments).toBe('"just a string"');
    const array = coerceToolCallArguments("[1,2,3]");
    expect(array.malformedArguments).toBe("[1,2,3]");
    const broken = coerceToolCallArguments('{"tasks": [oops');
    expect(broken.malformedArguments).toBe('{"tasks": [oops');
    expect(broken.args).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Wire-format serialization contracts
// ---------------------------------------------------------------------------

describe("native wire formats", () => {
  test("openAiNativeMessages: system role conversion, tool_calls round-trip, role:tool answers", () => {
    const messages: LlmMessage[] = [
      { role: "assistant", content: "###SYSTEM###\nYou are REA." },
      { role: "user", content: "investigate" },
      {
        role: "assistant",
        content: "Checking.",
        toolCalls: [
          { id: "call_1", name: "update_plan", arguments: { tasks: [] } },
          { id: "call_2", name: "workspace_list", arguments: {} },
        ],
      },
      { role: "tool", content: "Plan updated.", toolCallId: "call_1" },
      { role: "tool", content: "[]", toolCallId: "call_2" },
    ];
    const wire = openAiNativeMessages(messages);
    expect(wire[0]).toEqual({ role: "system", content: "You are REA." });
    expect(wire[1]).toEqual({ role: "user", content: "investigate" });
    expect(wire[2]).toEqual({
      role: "assistant",
      content: "Checking.",
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "update_plan", arguments: '{"tasks":[]}' } },
        { id: "call_2", type: "function", function: { name: "workspace_list", arguments: "{}" } },
      ],
    });
    expect(wire[3]).toEqual({ role: "tool", tool_call_id: "call_1", content: "Plan updated." });
    expect(wire[4]).toEqual({ role: "tool", tool_call_id: "call_2", content: "[]" });
  });

  test("anthropicNativeMessages: tool_use blocks + consecutive tool results merge into ONE user turn", () => {
    const messages: LlmMessage[] = [
      { role: "user", content: "investigate" },
      {
        role: "assistant",
        content: "Checking two things.",
        toolCalls: [
          { id: "tu_1", name: "update_plan", arguments: { tasks: [] } },
          { id: "tu_2", name: "workspace_list", arguments: {} },
        ],
      },
      { role: "tool", content: "Plan updated.", toolCallId: "tu_1" },
      { role: "tool", content: "[]", toolCallId: "tu_2" },
    ];
    const wire = anthropicNativeMessages(messages);
    expect(wire).toHaveLength(3); // user, assistant, ONE merged user turn
    expect(wire[1].role).toBe("assistant");
    const blocks = wire[1].content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "text", text: "Checking two things." });
    expect(blocks[1]).toEqual({ type: "tool_use", id: "tu_1", name: "update_plan", input: { tasks: [] } });
    expect(blocks[2]).toEqual({ type: "tool_use", id: "tu_2", name: "workspace_list", input: {} });
    expect(wire[2].role).toBe("user");
    const results = wire[2].content as Array<Record<string, unknown>>;
    expect(results).toHaveLength(2);
    expect(results[0].type).toBe("tool_result");
    expect(results[0].tool_use_id).toBe("tu_1");
    expect(results[1].tool_use_id).toBe("tu_2");
  });
});

// ---------------------------------------------------------------------------
// Loop-level native path
// ---------------------------------------------------------------------------

describe("runAgentLoop native tool-calling path", () => {
  test(
    "single native tool call executes for real and the result returns as a role:tool message",
    async () => {
      const llm = fakeNativeLlm([
        {
          content: "Tracking the work first.",
          toolCalls: [{ id: "call_1", name: "update_plan", arguments: planArgs("Inspect target") }],
        },
        { content: "Plan is tracked. Ready to investigate.", toolCalls: [] },
      ]);
      const toolEvents: Array<{ tool: string; result: string }> = [];
      const result = await runAgentLoop({
        sessionId: `nt-single-${Date.now()}`,
        userMessage: "Start a plan",
        events: {
          onToolResult: (tool, res) => toolEvents.push({ tool, result: res }),
        } satisfies AgentEventHandlers,
        ...freeChatOpts,
        llmOverride: llm,
      });

      expect(result.content).toBe("Plan is tracked. Ready to investigate.");
      // The tool GENUINELY executed (applyPlanUpdate ran through the shared core).
      expect(result.toolCalls).toHaveLength(1);
      const trace: AgentToolTrace[] = result.toolCalls;
      expect(trace[0].tool).toBe("update_plan");
      expect(trace[0].args).toEqual(planArgs("Inspect target"));
      expect(trace[0].result).toContain("Plan updated");
      expect(toolEvents).toHaveLength(1);
      expect(toolEvents[0].result).toContain("Plan updated");

      // Transcript for the second model turn: schemas were offered on turn 1,
      // and the result came back as a protocol-valid role:"tool" message.
      expect(llm.calls()).toBe(2);
      expect(llm.captured[0].tools.map((s) => s.function.name)).toContain("update_plan");
      const second = llm.captured[1].messages;
      const assistant = second.find((m) => m.role === "assistant" && m.toolCalls?.length);
      expect(assistant?.toolCalls?.[0].id).toBe("call_1");
      expect(assistant?.toolCalls?.[0].name).toBe("update_plan");
      const toolMsg = second.find((m) => m.role === "tool");
      expect(toolMsg?.toolCallId).toBe("call_1");
      expect(toolMsg?.content).toContain("Plan updated");
      // The native system prompt carries the protocol override (no text fences).
      expect(second[0].content).toContain("NATIVE tool calling");
      expect(second[0].content).toContain("Do NOT emit ```tool blocks");
    },
    20_000
  );

  test(
    "parallel native tool calls execute SEQUENTIALLY and all results return in one turn",
    async () => {
      const llm = fakeNativeLlm([
        {
          content: "Two independent calls.",
          toolCalls: [
            { id: "call_a", name: "update_plan", arguments: planArgs("First step") },
            { id: "call_b", name: "update_plan", arguments: planArgs("Second different step") },
          ],
        },
        { content: "Both results received; synthesizing.", toolCalls: [] },
      ]);
      const executionOrder: string[] = [];
      const result = await runAgentLoop({
        sessionId: `nt-parallel-${Date.now()}`,
        userMessage: "Run two things",
        events: {
          onToolResult: (tool, res) => executionOrder.push(`${tool}:${res.slice(0, 30)}`),
        },
        ...freeChatOpts,
        llmOverride: llm,
      });

      expect(result.content).toBe("Both results received; synthesizing.");
      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].args).toEqual(planArgs("First step"));
      expect(result.toolCalls[1].args).toEqual(planArgs("Second different step"));
      expect(executionOrder).toHaveLength(2); // both actually ran
      // The second model turn received BOTH results as two role:"tool"
      // messages after a single assistant tool_calls message.
      const second = llm.captured[1].messages;
      const toolMsgs = second.filter((m) => m.role === "tool");
      expect(toolMsgs).toHaveLength(2);
      expect(toolMsgs[0].toolCallId).toBe("call_a");
      expect(toolMsgs[0].content).toContain("Plan updated");
      expect(toolMsgs[1].toolCallId).toBe("call_b");
      expect(toolMsgs[1].content).toContain("Plan updated");
      const assistantMsg = second.find((m) => m.role === "assistant" && m.toolCalls?.length);
      expect(assistantMsg?.toolCalls).toHaveLength(2);
    },
    20_000
  );

  test(
    "malformed provider arguments are NEVER executed — honest error answered per call id",
    async () => {
      const llm = fakeNativeLlm([
        {
          content: "Calling with broken args.",
          toolCalls: [
            {
              id: "call_bad",
              name: "update_plan",
              arguments: {},
              malformedArguments: '{"tasks": [oops',
            },
          ],
        },
        { content: "Understood — retrying with valid JSON next time.", toolCalls: [] },
      ]);
      const result = await runAgentLoop({
        sessionId: `nt-malformed-${Date.now()}`,
        userMessage: "Do a thing",
        ...freeChatOpts,
        llmOverride: llm,
      });

      // Nothing executed: the trace records the failed call, not a plan update.
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].result).toContain("malformed JSON arguments");
      expect(result.toolCalls[0].result).toContain("nothing was executed");
      expect(result.toolCalls[0].result).not.toContain("Plan updated");
      // The provider gets a protocol-valid tool answer stating the truth.
      const second = llm.captured[1].messages;
      const toolMsg = second.find((m) => m.role === "tool");
      expect(toolMsg?.toolCallId).toBe("call_bad");
      expect(toolMsg?.content).toContain("malformed JSON arguments");
      expect(toolMsg?.content).toContain('{"tasks": [oops');
    },
    20_000
  );

  test(
    "native path without toolCalls treats content as final and the fabrication gate fires on text fences",
    async () => {
      const fabricated = `${TOOL_FENCE}\n{"tool":"update_plan","args":{"tasks":[]}}\n${"```"}\nPlan updated: 2 steps (simulated terminal output).`;
      const llm = fakeNativeLlm([
        { content: `I ran the tool for you.\n${fabricated}\nAll done.`, toolCalls: [] },
      ]);
      const result = await runAgentLoop({
        sessionId: `nt-fabrication-${Date.now()}`,
        userMessage: "Update the plan",
        ...freeChatOpts,
        llmOverride: llm,
      });
      // No tool ran; the final answer is the simulated prose PLUS the gate note.
      expect(result.toolCalls).toHaveLength(0);
      expect(result.content).toContain("I ran the tool for you.");
      expect(result.content).toContain("Integrity note");
      expect(result.content).toContain("simulated by the model");
      expect(result.content).toContain("did NOT execute on the platform");
    },
    20_000
  );
});

// ---------------------------------------------------------------------------
// Fallback: no native flag → the original text protocol, unchanged
// ---------------------------------------------------------------------------

describe("text-protocol fallback", () => {
  test(
    "a provider without supportsNativeTools transparently uses the text path",
    async () => {
      const llm = fakeTextLlm([
        `Thought: track the work.\n${TOOL_FENCE}\n{"tool":"update_plan","args":{"tasks":[{"title":"Inspect","status":"in_progress"},{"title":"Report","status":"pending"}]}}\n${"```"}`,
        "Final answer from the TEXT path.",
      ]);
      const result = await runAgentLoop({
        sessionId: `nt-fallback-${Date.now()}`,
        userMessage: "Plan please",
        ...freeChatOpts,
        llmOverride: llm,
      });

      expect(result.content).toBe("Final answer from the TEXT path.");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].tool).toBe("update_plan");
      expect(result.toolCalls[0].result).toContain("Plan updated");
      expect(llm.calls()).toBe(2);
      // Text-path feedback shape: TOOL RESULT arrives as a user message.
      const second = llm.captured[1];
      expect(
        second.some((m) => m.role === "user" && m.content.startsWith("TOOL RESULT for update_plan"))
      ).toBe(true);
      expect(second.some((m) => m.role === "tool")).toBe(false);
    },
    20_000
  );

  test("finalizeTurnContent labels simulated fences with the executed-tool list (path-agnostic gate)", () => {
    const out = finalizeTurnContent(
      `Here you go:\n${TOOL_FENCE}\n{"tool":"rea_tool","args":{}}\n${"```"}\nstrings found: fake`,
      [{ tool: "update_plan", args: {}, result: "Plan updated: 2 steps." }],
      ["update_plan", "explore_url"]
    );
    expect(out).toContain("Integrity note");
    expect(out).toContain("update_plan"); // genuinely executed list
    expect(out).toContain("Tools actually available here: update_plan, explore_url");
  });
});

// ---------------------------------------------------------------------------
// Provider-level SSE parsing against a LOCAL fixture server (no network)
// ---------------------------------------------------------------------------

describe("openAiCompatibleTools against a local SSE fixture", () => {
  test(
    "accumulates streamed tool_call fragments, parses valid args, flags malformed args",
    async () => {
      let capturedBody: Record<string, unknown> | null = null;
      const server = Bun.serve({
        port: 0,
        fetch: async (req) => {
          capturedBody = (await req.json()) as Record<string, unknown>;
          const frames = [
            `data: {"choices":[{"delta":{"content":"Let me check the workspace."}}]}`,
            `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"update_plan","arguments":"{\\"tas"}}]}}]}`,
            `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ks\\":[{\\"title\\":\\"T\\",\\"status\\":\\"pending\\"}]}"}}]}}]}`,
            `data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"rea_tool","arguments":"not-json-at-all"}}]}}]}`,
            `data: {"choices":[{"delta":{"tool_calls":[{"index":2,"id":"call_c","function":{"name":"workspace_list"}}]}}]}`,
            `data: {"usage":{"prompt_tokens":11,"completion_tokens":7}}`,
            `data: [DONE]`,
          ];
          const stream = new ReadableStream({
            start(controller) {
              for (const f of frames) controller.enqueue(new TextEncoder().encode(`${f}\n\n`));
              controller.close();
            },
          });
          return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
        },
      });
      try {
        const deltas: string[] = [];
        const usage: TokenUsage[] = [];
        const messages: LlmMessage[] = [
          { role: "assistant", content: "###SYSTEM###\nYou are REA." },
          { role: "user", content: "go" },
          { role: "assistant", content: "Earlier.", toolCalls: [{ id: "x", name: "t", arguments: {} }] },
          { role: "tool", content: "res", toolCallId: "x" },
        ];
        const res = await openAiCompatibleTools(
          `http://localhost:${server.port}/v1`,
          "test-key",
          "gpt-test",
          messages,
          nativeToolSchemas("free"),
          { onUsage: (u) => usage.push(u) },
          (d) => deltas.push(d)
        );

        expect(res.content).toBe("Let me check the workspace.");
        expect(deltas).toEqual(["Let me check the workspace."]);
        expect(res.toolCalls).toHaveLength(3);
        // Fragmented arguments were concatenated then parsed into a REAL object.
        expect(res.toolCalls[0]).toMatchObject({ id: "call_a", name: "update_plan" });
        expect(res.toolCalls[0].arguments).toEqual({ tasks: [{ title: "T", status: "pending" }] });
        expect(res.toolCalls[0].malformedArguments).toBeUndefined();
        // Unparsable arguments: flagged, never guessed into an execution.
        expect(res.toolCalls[1].malformedArguments).toBe("not-json-at-all");
        expect(res.toolCalls[1].arguments).toEqual({});
        // No-arg call (no arguments field at all): valid empty object.
        expect(res.toolCalls[2]).toMatchObject({ id: "call_c", name: "workspace_list", arguments: {} });
        expect(usage).toEqual([{ promptTokens: 11, completionTokens: 7 }]);

        // The wire request carried native schemas + protocol-valid transcript.
        const body = capturedBody as unknown as {
          tools: ToolSchema[];
          messages: Array<Record<string, unknown>>;
          stream: boolean;
        };
        expect(body.stream).toBe(true);
        expect(body.tools.map((t) => t.function.name)).toContain("update_plan");
        expect(body.messages[0]).toEqual({ role: "system", content: "You are REA." });
        expect(body.messages[2]).toMatchObject({ role: "assistant", content: "Earlier." });
        expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "x", content: "res" });
      } finally {
        server.stop(true);
      }
    },
    20_000
  );

  test(
    "tools field omitted entirely when no schemas are offered (synthesis turn)",
    async () => {
      let capturedBody: Record<string, unknown> | null = null;
      const server = Bun.serve({
        port: 0,
        fetch: async (req) => {
          capturedBody = (await req.json()) as Record<string, unknown>;
          return new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(
                  new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"Final prose."}}]}\n\n`)
                );
                c.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
                c.close();
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } }
          );
        },
      });
      try {
        const res = await openAiCompatibleTools(
          `http://localhost:${server.port}/v1`,
          "k",
          "m",
          [{ role: "user", content: "synthesize" }],
          [],
          {},
          () => {}
        );
        expect(res.content).toBe("Final prose.");
        expect(res.toolCalls).toHaveLength(0);
        expect(capturedBody).not.toHaveProperty("tools");
      } finally {
        server.stop(true);
      }
    },
    20_000
  );

  test("HTTP errors surface scrubbed and honest", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("upstream exploded", { status: 502 }),
    });
    try {
      await expect(
        openAiCompatibleTools(
          `http://localhost:${server.port}/v1`,
          "k",
          "m",
          [{ role: "user", content: "hi" }],
          [],
          {},
          () => {}
        )
      ).rejects.toThrow(/Provider HTTP 502/);
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// callTurnTools retry discipline
// ---------------------------------------------------------------------------

describe("callTurnTools retry discipline", () => {
  const schemas: ToolSchema[] = nativeToolSchemas("free");

  test("transient provider failure is retried before any delta and then succeeds", async () => {
    let attempts = 0;
    const llm = {
      source: "byok",
      provider: "openai",
      model: "gpt-test",
      supportsNativeTools: true,
      callLLM: async () => "",
      callLLMTools: async (): Promise<LlmToolsResult> => {
        attempts++;
        if (attempts === 1) throw new Error("Provider HTTP 429: rate limited");
        return { content: "ok", toolCalls: [] };
      },
    } as unknown as ResolvedLlm;
    const res = await callTurnTools(llm, [{ role: "user", content: "hi" }], schemas, 0);
    expect(res.content).toBe("ok");
    expect(attempts).toBe(2);
  }, 20_000);

  test("non-transient failure is never retried", async () => {
    let attempts = 0;
    const llm = {
      callLLM: async () => "",
      callLLMTools: async () => {
        attempts++;
        throw new Error("Provider HTTP 401: invalid key");
      },
    } as unknown as ResolvedLlm;
    await expect(
      callTurnTools(llm, [{ role: "user", content: "hi" }], schemas, 0)
    ).rejects.toThrow(/401/);
    expect(attempts).toBe(1);
  }, 20_000);

  test("no retry after content deltas reached the client (duplicate prevention)", async () => {
    let attempts = 0;
    const llm = {
      callLLM: async () => "",
      callLLMTools: async (_m: LlmMessage[], _t: ToolSchema[], onDelta: (s: string) => void) => {
        attempts++;
        onDelta("partial ");
        throw new Error("socket hang up");
      },
    } as unknown as ResolvedLlm;
    await expect(
      callTurnTools(llm, [{ role: "user", content: "hi" }], schemas, 0)
    ).rejects.toThrow(/socket hang up/);
    expect(attempts).toBe(1);
  }, 20_000);

  test("resolving a non-native LLM through callTurnTools fails the contract check honestly", async () => {
    const llm = fakeTextLlm(["x"]);
    await expect(
      callTurnTools(llm, [{ role: "user", content: "hi" }], schemas, 0)
    ).rejects.toThrow(/does not implement native tool calling/);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Integrity guarantees identical on both paths
// ---------------------------------------------------------------------------

describe("shared integrity guarantees", () => {
  test(
    "retry-dedup cache serves the identical native call from cache with an explicit annotation",
    async () => {
      // Two consecutive loops in the SAME session re-emitting the identical
      // native call: the second must reuse the prior result, not re-execute.
      const sessionId = `nt-dedup-${Date.now()}`;
      const script = (final: string): LlmToolsResult[] => [
        {
          content: "c",
          toolCalls: [
            { id: `call_${Math.random()}`, name: "update_plan", arguments: planArgs("Same step") },
          ],
        },
        { content: final, toolCalls: [] },
      ];
      const first = await runAgentLoop({
        sessionId,
        userMessage: "plan",
        ...freeChatOpts,
        llmOverride: fakeNativeLlm(script("first done")),
      });
      const second = await runAgentLoop({
        sessionId,
        userMessage: "plan again",
        ...freeChatOpts,
        llmOverride: fakeNativeLlm(script("second done")),
      });
      expect(first.toolCalls[0].result).toContain("Plan updated");
      expect(first.toolCalls[0].result).not.toContain("reused from the earlier identical execution");
      expect(second.toolCalls[0].result).toContain("reused from the earlier identical execution");
    },
    20_000
  );

  test(
    "repeat guard halts identical native calls (target chat) and the synthesis turn runs WITHOUT schemas",
    async () => {
      // The repeat guard lives in the target-chat execution core (free chats
      // rely on the retry-dedup cache instead) — drive it with a stub target.
      const target = {
        id: `nt-tgt-${Date.now()}`,
        originalName: "repeat.bin",
        sizeBytes: 10,
        sha256: "nt-sha",
        status: "ready",
        detectedFormat: null,
        formatFamily: null,
        summary: null,
        mimeType: null,
        createdAt: new Date(),
      } as unknown as Target;
      const toolCall = (): LlmToolCall => ({
        id: `call_${Math.random()}`,
        name: "update_plan",
        arguments: planArgs("Identical"),
      });
      const llm = fakeNativeLlm([
        { content: "c1", toolCalls: [toolCall()] },
        { content: "c2", toolCalls: [toolCall()] },
        { content: "c3", toolCalls: [toolCall()] }, // 3rd identical → guard fires
        // Reached ONLY by the forced synthesis turn (schemas stripped).
        { content: "Synthesized final answer from gathered evidence.", toolCalls: [] },
      ]);
      const result = await runAgentLoop({
        sessionId: `nt-repeat-${Date.now()}`,
        target,
        userId: "nt-regression",
        userMessage: "loop",
        history: [],
        llmOverride: llm,
      });
      // The forced synthesis turn produced the final answer.
      expect(result.content).toBe("Synthesized final answer from gathered evidence.");
      // Identical calls before the guard genuinely executed; every provider
      // tool_call still received a protocol-valid tool answer.
      const executed = result.toolCalls.filter((t) => t.result.startsWith("Plan updated"));
      expect(executed.length).toBe(3);
      // The synthesis call went out with NO schemas (model cannot call tools
      // it cannot see) and an explicit halt message.
      const synthesisCall = llm.captured[llm.captured.length - 1];
      expect(synthesisCall.tools).toHaveLength(0);
      const lastUser = synthesisCall.messages[synthesisCall.messages.length - 1];
      expect(lastUser.content).toContain("Do not emit any more tool calls");
      expect(lastUser.content).toContain("was repeated");
    },
    20_000
  );

  test(
    "free-chat refusal for a target-scoped native call records NOT EXECUTED and redirects",
    async () => {
      const llm = fakeNativeLlm([
        {
          content: "Trying a file tool.",
          toolCalls: [{ id: "call_f", name: "read_hex", arguments: { offset: 0 } }],
        },
        { content: "Got it — that tool needs an uploaded target.", toolCalls: [] },
      ]);
      const refusals: string[] = [];
      const result = await runAgentLoop({
        sessionId: `nt-refusal-${Date.now()}`,
        userMessage: "read hex",
        events: { onToolResult: (_t, r) => refusals.push(r) },
        ...freeChatOpts,
        llmOverride: llm,
      });
      expect(result.toolCalls[0].result.startsWith(TOOL_REFUSAL_MARKER)).toBe(true);
      expect(refusals[0]).toContain("unavailable in this chat");
      // Scoped redirect notice reached the model as a user message.
      const second = llm.captured[1].messages;
      expect(
        second.some(
          (m) => m.role === "user" && m.content.includes('read_hex" operates on an uploaded file target')
        )
      ).toBe(true);
    },
    20_000
  );
});
