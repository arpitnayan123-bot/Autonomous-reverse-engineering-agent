#!/usr/bin/env bun
/**
 * Subagent support regression suite (spawn_subagent).
 *
 * Proves the delegation feature end-to-end WITHOUT touching the network or
 * the workspace tools:
 *   - a successful subagent: fresh history (system prompt + task only),
 *     SUBAGENT RESULT tool result, dedicated start/delta/end events, and
 *     [subagent]-prefixed tool events for the nested executions;
 *   - the iteration budget: a subagent that keeps emitting tool blocks is
 *     force-synthesized at max_iterations (default 8, hard cap 15);
 *   - subagent FAILURE: the error comes back as the spawn_subagent tool
 *     result and the parent loop finishes normally (never crashes);
 *   - the per-session concurrency cap (max 3 active subagents) — both on
 *     the SubagentManager directly and through the loop's refusal;
 *   - cancellation propagation: parent-signal abort reaches the nested
 *     loop (composed signal), the record ends cancelled, the tool result
 *     is an honest SUBAGENT CANCELLED;
 *   - the depth limit: a subagent that emits spawn_subagent gets the
 *     NOT EXECUTED refusal and no nested loop ever runs (recursion max 2);
 *   - dedup isolation: the retry-dedup cache key is prefixed with the
 *     subagent id — identical parent/subagent calls each execute fresh,
 *     while same-namespace repeats still dedup.
 *
 * Harness notes: everything runs on the TEXT protocol with a scripted LLM
 * (llmOverride) that branches parent vs subagent turns on the subagent
 * system addendum. update_plan is the only tool exercised (pure planning —
 * no network, no disk). The parent loop persists chat rows for real; every
 * test uses a unique "sub-test-" session id cleaned up in afterAll.
 * Run:  bun test src/server/agent/__tests__/subagents.test.ts
 */
import { describe, test, expect, afterAll } from "bun:test";
import {
  runAgentLoop,
  SUBAGENT_ADDENDUM_MARKER,
  type AgentEventHandlers,
  type AgentLoopResult,
} from "@/server/agent/agent";
import {
  parseSubagentArgs,
  SUBAGENT_DEFAULT_TOOLS,
  SUBAGENT_DEFAULT_MAX_ITERATIONS,
  SUBAGENT_MAX_ITERATIONS_CAP,
  TOOL_REFUSAL_MARKER,
} from "@/server/agent/tools";
import {
  SubagentManager,
  SUBAGENT_MAX_CONCURRENT,
  SUBAGENT_DEPTH_LIMIT,
  subagentManagerFor,
  resetSubagentManagersForTests,
} from "@/server/agent/subagents";
import type { LlmMessage, ResolvedLlm } from "@/server/agent/providers";
import { db } from "@/lib/db";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const TOOL_FENCE = "```tool";
const CLOSE = "```";

const planBlock = (title: string) =>
  `${TOOL_FENCE}\n${JSON.stringify({
    tool: "update_plan",
    args: {
      tasks: [
        { title, status: "in_progress" },
        { title: "Report", status: "pending" },
      ],
    },
  })}\n${CLOSE}`;

const spawnBlock = (args: Record<string, unknown>) =>
  `${TOOL_FENCE}\n${JSON.stringify({ tool: "spawn_subagent", args })}\n${CLOSE}`;

/** Events captured from a runAgentLoop run. */
interface CapturedEvents {
  started: Array<{ id: string; task: string; tools: string[]; maxIterations: number }>;
  deltas: Array<{ id: string; text: string }>;
  ended: Array<{
    id: string;
    status: string;
    durationMs: number;
    iterations: number;
    toolsUsed: number;
    summary: string;
  }>;
  toolCalls: string[];
  toolResults: Array<{ tool: string; result: string }>;
}

function captureEvents(): { events: AgentEventHandlers; captured: CapturedEvents } {
  const captured: CapturedEvents = {
    started: [],
    deltas: [],
    ended: [],
    toolCalls: [],
    toolResults: [],
  };
  const events: AgentEventHandlers = {
    onSubagentStart: (info) => captured.started.push({ ...info }),
    onSubagentDelta: (id, text) => captured.deltas.push({ id, text }),
    onSubagentEnd: (info) => captured.ended.push({ ...info }),
    onToolCall: (tool) => captured.toolCalls.push(tool),
    onToolResult: (tool, result) => captured.toolResults.push({ tool, result }),
  };
  return { events, captured };
}

/**
 * Scripted TEXT-path LLM. Parent turns and subagent turns share ONE object
 * (the subagent inherits the parent's resolved LLM via llmOverride) and are
 * branched on the subagent system addendum — the ONLY structural difference
 * between the two loops' transcripts.
 */
function fakeLlm(opts: {
  parentTurns: string[];
  subagentTurns: string[];
  /** Side effect on each SUBAGENT LLM call (pre-return). */
  onSubagentTurn?: (call: number, messages: LlmMessage[]) => void;
  /** When set, the subagent branch throws this instead of scripting. */
  subThrow?: Error;
}) {
  let parentCalls = 0;
  let subCalls = 0;
  const subTurnInputs: LlmMessage[][] = [];
  const impl = {
    source: "byok" as const,
    provider: "kimi" as const,
    // Big window → the compaction path never fires in these tests.
    model: "moonshot-v1-128k",
    callLLM: async (messages: LlmMessage[]) => {
      const sys = messages[0]?.content ?? "";
      if (sys.includes(SUBAGENT_ADDENDUM_MARKER)) {
        subTurnInputs.push(messages.map((m) => ({ ...m })));
        opts.onSubagentTurn?.(subCalls, messages);
        if (opts.subThrow) throw opts.subThrow;
        const turn = opts.subagentTurns[Math.min(subCalls, opts.subagentTurns.length - 1)];
        subCalls++;
        return turn;
      }
      const turn = opts.parentTurns[Math.min(parentCalls, opts.parentTurns.length - 1)];
      parentCalls++;
      return turn;
    },
    calls: () => ({ parent: parentCalls, sub: subCalls }),
    subTurnInputs,
  };
  return impl as unknown as ResolvedLlm &
    ReturnType<typeof impl> & { calls: () => { parent: number; sub: number }; subTurnInputs: LlmMessage[][] };
}

const baseOpts = (sessionId: string) => ({
  sessionId,
  target: null,
  userId: "sub-test-user",
  history: [] as Array<{ role: "user" | "assistant"; content: string }>,
});

afterAll(async () => {
  // Parent loops persist assistant rows for real — clean the synthetic ones.
  await db.chatMessage.deleteMany({ where: { sessionId: { startsWith: "sub-test-" } } });
  resetSubagentManagersForTests();
});

// ---------------------------------------------------------------------------
// Argument parsing (defaults, clamp, honest refusals)
// ---------------------------------------------------------------------------

describe("parseSubagentArgs", () => {
  test("defaults per spec: 6 default tools, max_iterations 8", () => {
    const parsed = parseSubagentArgs({ task: "Investigate the crate format" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.tools).toEqual([...SUBAGENT_DEFAULT_TOOLS]);
    expect(parsed.value.tools).toContain("explore_url");
    expect(parsed.value.tools).toContain("web_research");
    expect(parsed.value.tools).toContain("workspace_read");
    expect(parsed.value.tools).toContain("workspace_list");
    expect(parsed.value.tools).toContain("workspace_run");
    expect(parsed.value.tools).toContain("workspace_write");
    expect(parsed.value.maxIterations).toBe(SUBAGENT_DEFAULT_MAX_ITERATIONS);
    expect(SUBAGENT_DEFAULT_MAX_ITERATIONS).toBe(8);
  });

  test("max_iterations clamps into 1..15 (hard cap)", () => {
    expect(SUBAGENT_MAX_ITERATIONS_CAP).toBe(15);
    const hi = parseSubagentArgs({ task: "t", max_iterations: 99 });
    expect(hi.ok && hi.value.maxIterations).toBe(15);
    const lo = parseSubagentArgs({ task: "t", max_iterations: 0 });
    expect(lo.ok && lo.value.maxIterations).toBe(1);
    const str = parseSubagentArgs({ task: "t", max_iterations: "3" });
    expect(str.ok && str.value.maxIterations).toBe(3);
  });

  test("honest refusals: empty task, unknown tool, self-grant", () => {
    expect(parseSubagentArgs({}).ok).toBe(false);
    expect(parseSubagentArgs({ task: "   " }).ok).toBe(false);
    const unknown = parseSubagentArgs({ task: "t", tools: ["definitely_not_a_tool"] });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("definitely_not_a_tool");
    const self = parseSubagentArgs({ task: "t", tools: ["spawn_subagent"] });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error).toContain("cannot spawn sub-subagents");
    const badType = parseSubagentArgs({ task: "t", tools: "update_plan" });
    expect(badType.ok).toBe(false);
    const empty = parseSubagentArgs({ task: "t", tools: [] });
    expect(empty.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SubagentManager: per-session concurrency cap + cancellation primitives
// ---------------------------------------------------------------------------

describe("SubagentManager", () => {
  test("max 3 concurrent active subagents per session", () => {
    expect(SUBAGENT_MAX_CONCURRENT).toBe(3);
    const m = new SubagentManager("sub-test-cap-unit");
    const specs = { task: "unit task", tools: ["update_plan"], maxIterations: 2 };
    const a = m.begin(specs, SUBAGENT_DEPTH_LIMIT);
    const b = m.begin(specs, SUBAGENT_DEPTH_LIMIT);
    const c = m.begin(specs, SUBAGENT_DEPTH_LIMIT);
    expect(a && b && c).toBeTruthy();
    expect(m.activeCount()).toBe(3);
    expect(m.canSpawn()).toBe(false);
    // The 4th spawn is refused (null) — never silently queued or dropped.
    expect(m.begin(specs, SUBAGENT_DEPTH_LIMIT)).toBeNull();
    // Finishing one frees exactly one slot.
    m.finish(a!.id, { status: "completed", result: "done" });
    expect(m.canSpawn()).toBe(true);
    const d = m.begin(specs, SUBAGENT_DEPTH_LIMIT);
    expect(d).not.toBeNull();
  });

  test("cancelAll aborts every active subagent controller (idempotent)", () => {
    const m = new SubagentManager("sub-test-cancel-unit");
    const r1 = m.begin({ task: "one", tools: [], maxIterations: 1 }, SUBAGENT_DEPTH_LIMIT)!;
    const r2 = m.begin({ task: "two", tools: [], maxIterations: 1 }, SUBAGENT_DEPTH_LIMIT)!;
    m.finish(r2.id, { status: "completed" });
    const controller1 = m.controllerFor(r1.id);
    expect(controller1.signal.aborted).toBe(false);
    expect(m.cancelAll("parent turn cancelled")).toBe(1);
    expect(controller1.signal.aborted).toBe(true);
    // The aborted record is marked cancelled (no longer active).
    expect(m.recordFor(r1.id)?.status).toBe("cancelled");
    expect(m.activeCount()).toBe(0);
    // Idempotent: the second call finds nothing active.
    expect(m.cancelAll("again")).toBe(0);
  });

  test("shared per-session registry returns the SAME manager instance", () => {
    const a = subagentManagerFor("sub-test-registry");
    const b = subagentManagerFor("sub-test-registry");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// The loop: successful delegation
// ---------------------------------------------------------------------------

describe("runAgentLoop — spawn_subagent", () => {
  test("successful subagent: fresh history, SUBAGENT RESULT, dedicated events, [subagent] tool events", async () => {
    const SESSION = "sub-test-success";
    const TASK = "Plan the two-phase investigation and report the phase names.";
    const llm = fakeLlm({
      parentTurns: [
        spawnBlock({ task: TASK, tools: ["update_plan"], max_iterations: 4 }),
        "Delegation complete; the subagent report is in the trace above.",
      ],
      subagentTurns: [planBlock("Phase one: recon"), "SUBAGENT FINAL REPORT: phases planned and observed."],
    });
    const { events, captured } = captureEvents();

    const result: AgentLoopResult = await runAgentLoop({
      ...baseOpts(SESSION),
      userMessage: "Delegate the planning work please",
      llmOverride: llm,
      events,
    });

    // Parent turn 2 became the final answer; the spawn row is in the trace.
    expect(result.content).toContain("Delegation complete");
    const spawnTrace = result.toolCalls.find((t) => t.tool === "spawn_subagent");
    expect(spawnTrace).toBeDefined();
    expect(spawnTrace!.result.startsWith("SUBAGENT RESULT:")).toBe(true);
    expect(spawnTrace!.result).toContain("SUBAGENT FINAL REPORT: phases planned and observed.");

    // Dedicated lifecycle events: exactly one start / one completed end.
    expect(captured.started.length).toBe(1);
    expect(captured.started[0].task).toBe(TASK);
    expect(captured.started[0].tools).toEqual(["update_plan"]);
    expect(captured.started[0].maxIterations).toBe(4);
    expect(captured.ended.length).toBe(1);
    expect(captured.ended[0].id).toBe(captured.started[0].id);
    expect(captured.ended[0].status).toBe("completed");
    expect(captured.ended[0].iterations).toBe(2);
    expect(captured.ended[0].toolsUsed).toBe(1);

    // The subagent's final text streamed through the dedicated delta channel.
    const deltaText = captured.deltas.map((d) => d.text).join("");
    expect(deltaText).toContain("SUBAGENT FINAL REPORT: phases planned and observed.");
    // Nested tool executions stream as [subagent]-prefixed tool events…
    expect(captured.toolCalls).toContain("[subagent] update_plan");
    // …and the spawn row itself as the plain tool event.
    expect(captured.toolCalls).toContain("spawn_subagent");

    // Fresh history: the subagent's FIRST LLM turn saw ONLY the system
    // prompt (+ addendum) and the task — no parent traffic.
    const calls = llm.calls();
    expect(calls.parent).toBe(2);
    expect(calls.sub).toBe(2);
    const firstSubTurn = llm.subTurnInputs[0];
    expect(firstSubTurn.length).toBe(2);
    expect(firstSubTurn[0].content).toContain(SUBAGENT_ADDENDUM_MARKER);
    expect(firstSubTurn[1].content).toBe(TASK);

    // Manager record: own tool trace, usage counters, duration.
    const manager = subagentManagerFor(SESSION);
    const record = manager.recordFor(captured.started[0].id);
    expect(record).not.toBeNull();
    expect(record!.status).toBe("completed");
    expect(record!.task).toBe(TASK);
    expect(record!.toolTrace).toHaveLength(1);
    expect(record!.toolTrace[0].tool).toBe("update_plan");
    expect(record!.usage).toEqual({ tokensIn: null, tokensOut: null });
    expect(record!.durationMs).not.toBeNull();
    expect(record!.result).toContain("SUBAGENT FINAL REPORT");
  });

  test("subagent that exceeds max_iterations is force-synthesized, not failed", async () => {
    const SESSION = "sub-test-iterations";
    const llm = fakeLlm({
      parentTurns: [
        spawnBlock({ task: "Endless planner", tools: ["update_plan"], max_iterations: 2 }),
        "Subagent hit its budget; result captured.",
      ],
      // The subagent never stops emitting tool blocks — every scripted turn
      // is another plan block (the script repeats its last entry).
      subagentTurns: [planBlock("Another iteration")],
    });
    const { events, captured } = captureEvents();

    const result = await runAgentLoop({
      ...baseOpts(SESSION),
      userMessage: "spawn the endless planner",
      llmOverride: llm,
      events,
    });

    const spawnTrace = result.toolCalls.find((t) => t.tool === "spawn_subagent");
    expect(spawnTrace).toBeDefined();
    expect(spawnTrace!.result.startsWith("SUBAGENT RESULT:")).toBe(true);

    // Budget accounting: 2 tool iterations + 1 forced synthesis turn.
    expect(captured.ended.length).toBe(1);
    expect(captured.ended[0].iterations).toBe(3);
    expect(captured.ended[0].status).toBe("completed");
    const record = subagentManagerFor(SESSION).allRecords()[0];
    expect(record.maxIterations).toBe(2);
    expect(record.iterations).toBe(3);
    // The forced synthesis turn ran WITHOUT tools (no third plan execution):
    // the sub agent used exactly 2 tool calls.
    expect(record.toolTrace).toHaveLength(2);
    // The synthesis turn's fence triggered the integrity gate in the report.
    expect(record.result).toContain("Integrity note");
  });

  test("subagent failure returns the error as the tool result and never crashes the parent loop", async () => {
    const SESSION = "sub-test-failure";
    const llm = fakeLlm({
      parentTurns: [
        spawnBlock({ task: "This will fail", tools: ["update_plan"] }),
        "Recovered from the subagent failure and answered anyway.",
      ],
      subagentTurns: [],
      // 401 is non-transient: no retry storm, immediate honest failure.
      subThrow: new Error("401 unauthorized — provider key rejected"),
    });
    const { events, captured } = captureEvents();

    const result = await runAgentLoop({
      ...baseOpts(SESSION),
      userMessage: "spawn a doomed subagent",
      llmOverride: llm,
      events,
    });

    // THE key guarantee: the parent loop finished normally.
    expect(result.content).toContain("Recovered from the subagent failure");
    const spawnTrace = result.toolCalls.find((t) => t.tool === "spawn_subagent");
    expect(spawnTrace).toBeDefined();
    expect(spawnTrace!.result.startsWith("Error: subagent")).toBe(true);
    expect(spawnTrace!.result).toContain("401 unauthorized");

    expect(captured.ended.length).toBe(1);
    expect(captured.ended[0].status).toBe("failed");
    expect(captured.ended[0].summary).toContain("401 unauthorized");
    const record = subagentManagerFor(SESSION).allRecords()[0];
    expect(record.status).toBe("failed");
    expect(record.error).toContain("401 unauthorized");
    expect(record.result).toBeNull();
  });

  test("concurrent subagent limit: loop refuses a spawn while 3 are active", async () => {
    const SESSION = "sub-test-cap-loop";
    // Pre-occupy the session's manager with 3 active subagents.
    const manager = subagentManagerFor(SESSION);
    const specs = { task: "pre-existing", tools: [], maxIterations: 1 };
    const dummies = [manager.begin(specs, 2), manager.begin(specs, 2), manager.begin(specs, 2)];
    expect(dummies.every(Boolean)).toBe(true);

    const llm = fakeLlm({
      parentTurns: [
        spawnBlock({ task: "one too many", tools: ["update_plan"] }),
        "Acknowledged the cap; continuing without delegation.",
      ],
      subagentTurns: [], // must NEVER be reached — nothing may spawn
    });
    const { events, captured } = captureEvents();

    const result = await runAgentLoop({
      ...baseOpts(SESSION),
      userMessage: "spawn a fourth subagent",
      llmOverride: llm,
      events,
    });

    expect(llm.calls().sub).toBe(0); // no nested loop ran
    const spawnTrace = result.toolCalls.find((t) => t.tool === "spawn_subagent");
    expect(spawnTrace).toBeDefined();
    expect(spawnTrace!.result).toContain("concurrent subagent limit");
    expect(spawnTrace!.result).toContain("3 currently active");
    expect(result.content).toContain("Acknowledged the cap");
    expect(captured.started.length).toBe(0);
  });

  test("cancellation propagation: parent-signal abort reaches the nested loop", async () => {
    const SESSION = "sub-test-cancel";
    const parentController = new AbortController();
    const llm = fakeLlm({
      parentTurns: [
        spawnBlock({ task: "Long research side-quest", tools: ["update_plan"] }),
        "Turn wrapped up after the cancelled delegation.",
      ],
      subagentTurns: [planBlock("Working...")],
      // The parent signal fires while the subagent is mid-flight (during
      // its first LLM call) — the composed signal must stop the nested loop.
      onSubagentTurn: () => parentController.abort(),
    });
    const { events, captured } = captureEvents();

    const result = await runAgentLoop({
      ...baseOpts(SESSION),
      userMessage: "spawn then get cancelled",
      llmOverride: llm,
      signal: parentController.signal,
      events,
    });

    const spawnTrace = result.toolCalls.find((t) => t.tool === "spawn_subagent");
    expect(spawnTrace).toBeDefined();
    expect(spawnTrace!.result.startsWith("SUBAGENT CANCELLED:")).toBe(true);
    expect(spawnTrace!.result).toContain("cancellation propagated from the parent turn");

    expect(captured.ended.length).toBe(1);
    expect(captured.ended[0].status).toBe("cancelled");
    const record = subagentManagerFor(SESSION).allRecords()[0];
    expect(record.status).toBe("cancelled");
  });

  test("depth limit: a subagent cannot spawn a sub-subagent (recursion max 2)", async () => {
    const SESSION = "sub-test-depth";
    const llm = fakeLlm({
      parentTurns: [
        spawnBlock({ task: "Outer task", tools: ["update_plan"] }),
        "Depth-limited delegation resolved.",
      ],
      // Sub turn 0 tries the forbidden spawn; sub turn 1 reports anyway.
      subagentTurns: [
        spawnBlock({ task: "sub-sub attempt" }),
        "SUBAGENT REPORT: attempted nesting was refused; finished directly.",
      ],
    });
    const { events, captured } = captureEvents();

    const result = await runAgentLoop({
      ...baseOpts(SESSION),
      userMessage: "spawn the nesting attempt",
      llmOverride: llm,
      events,
    });

    // Exactly TWO LLM-call layers ran (parent + one subagent level); the
    // refused sub-sub attempt never opened a third loop.
    expect(llm.calls().parent).toBe(2);
    expect(llm.calls().sub).toBe(2);

    // The nested attempt came back as an honest NOT EXECUTED refusal.
    const refused = captured.toolResults.find(
      (r) => r.tool === "[subagent] spawn_subagent"
    );
    expect(refused).toBeDefined();
    expect(refused!.result.startsWith(TOOL_REFUSAL_MARKER)).toBe(true);
    expect(refused!.result).toContain("cannot spawn sub-subagents");

    // The subagent still completed its own task.
    const spawnTrace = result.toolCalls.find((t) => t.tool === "spawn_subagent");
    expect(spawnTrace!.result.startsWith("SUBAGENT RESULT:")).toBe(true);
    expect(spawnTrace!.result).toContain("finished directly");
    const record = subagentManagerFor(SESSION).allRecords()[0];
    expect(record.status).toBe("completed");
    expect(record.depth).toBe(SUBAGENT_DEPTH_LIMIT);
  });

  test("dedup isolation: subagent calls never reuse the parent's cached results", async () => {
    const SESSION = "sub-test-dedup";
    const planArgs = {
      tasks: [
        { title: "Shared step", status: "in_progress" },
        { title: "Report", status: "pending" },
      ],
    };
    const sharedPlan = `${TOOL_FENCE}\n${JSON.stringify({ tool: "update_plan", args: planArgs })}\n${CLOSE}`;
    const llm = fakeLlm({
      // Parent turn 0: the same plan call TWICE (proves the parent-side dedup
      // cache works within its own namespace) + the spawn in one message.
      parentTurns: [
        `${sharedPlan}\n${sharedPlan}\n${spawnBlock({ task: "Re-plan identically", tools: ["update_plan"] })}`,
        "Dedup isolation verified.",
      ],
      subagentTurns: [
        // Identical args to the parent's call — a fresh execution must run.
        sharedPlan,
        "SUBAGENT REPORT: plan executed fresh in my own namespace.",
      ],
    });
    const { events, captured } = captureEvents();

    const result = await runAgentLoop({
      ...baseOpts(SESSION),
      userMessage: "plan twice then delegate",
      llmOverride: llm,
      events,
    });

    // Parent-side, same namespace: first call executes, the identical
    // second call is served from the retry-dedup cache.
    const parentPlanResults = captured.toolResults.filter(
      (r) => r.tool === "update_plan"
    );
    expect(parentPlanResults.length).toBe(2);
    expect(parentPlanResults[0].result).toContain("Plan updated: 2 steps");
    expect(parentPlanResults[0].result).not.toContain("reused from the earlier identical execution");
    expect(parentPlanResults[1].result).toContain("reused from the earlier identical execution");

    // Subagent-side, namespaced key: the IDENTICAL call executes FRESH.
    const subPlan = captured.toolResults.find((r) => r.tool === "[subagent] update_plan");
    expect(subPlan).toBeDefined();
    expect(subPlan!.result).toContain("Plan updated: 2 steps");
    expect(subPlan!.result).not.toContain("reused from the earlier identical execution");
    expect(result.content).toContain("Dedup isolation verified");
  });

  test("subagent tool allowlist: a tool outside `tools` is refused, never executed", async () => {
    const SESSION = "sub-test-allowlist";
    const llm = fakeLlm({
      parentTurns: [
        spawnBlock({ task: "Only planning allowed", tools: ["update_plan"] }),
        "Allowlist enforcement verified.",
      ],
      // The subagent tries a workspace tool it was never granted.
      subagentTurns: [
        `${TOOL_FENCE}\n${JSON.stringify({ tool: "workspace_write", args: { path: "x.txt", content: "nope" } })}\n${CLOSE}`,
        "SUBAGENT REPORT: the off-allowlist call was refused.",
      ],
    });
    const { events, captured } = captureEvents();

    const result = await runAgentLoop({
      ...baseOpts(SESSION),
      userMessage: "spawn a restricted subagent",
      llmOverride: llm,
      events,
    });

    const refused = captured.toolResults.find((r) => r.tool === "[subagent] workspace_write");
    expect(refused).toBeDefined();
    expect(refused!.result.startsWith(TOOL_REFUSAL_MARKER)).toBe(true);
    expect(refused!.result).toContain("not in this subagent's tool allowlist");
    // Nothing was written anywhere for that call.
    const record = subagentManagerFor(SESSION).allRecords()[0];
    expect(record.toolTrace[0].result.startsWith(TOOL_REFUSAL_MARKER)).toBe(true);
    expect(result.content).toContain("Allowlist enforcement verified");
  });
});
