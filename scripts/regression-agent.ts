#!/usr/bin/env bun
/**
 * REA agent tool-execution reliability regression.
 *
 * Proves the model-to-tool handoff actually executes tools instead of
 * silently degrading them into prose, and that every refusal is honest:
 *   - the tool-block parser accepts the canonical fence AND the realistic
 *     spelling variants models emit (space/case/tilde/unterminated);
 *   - unknown tools, non-allowlisted engine tools and missing args return
 *     actionable error STRINGS (never thrown, never fabricated);
 *   - plan/explore tools execute for real (real network for explore_url);
 *   - cross-turn tool receipts and the scoped redirect notice exist so the
 *     model never concludes "I cannot access tools" after tools worked;
 *   - both system prompts carry the anti-refusal + capability-boundary
 *     clauses (contract tests).
 *
 * Live network: https://example.com only (the mandated safe host).
 * Run:  bun scripts/regression-agent.ts
 * Exit: 0 = all checks passed, 1 = at least one failure (printed).
 */
import {
  parseToolAction,
  toolReceiptSuffix,
  freeChatRedirectNotice,
  callTurn,
  isTransientLlmError,
  formatInterruptedTurnContent,
} from "@/server/agent/agent";
import {
  AGENT_TOOLS,
  executeAgentTool,
  applyPlanUpdate,
  runExploreUrlTool,
  toolDedupKey,
} from "@/server/agent/tools";
import { freeChatSystemPrompt, systemPrompt } from "@/server/agent/prompts";
import { BlockedUrlError } from "@/server/platform/net";
import { consumeModelStream, TurnAbortedError } from "@/server/agent/platform-llm";
import { readProviderSse } from "@/server/agent/providers";
import type { ResolvedLlm } from "@/server/agent/providers";
import type { Target } from "@prisma/client";

let failures = 0;

function check(name: string, ok: boolean, detail?: string): void {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function section(title: string): void {
  console.log(`\n## ${title}`);
}

// explore_url / allowlist-error paths never touch the target or engine.
const stubCtx = { target: {} as Target, userId: "regression" };

/** Bounded retry for transient sandbox-DNS hiccups on the real fetch. */
async function withDnsRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient = err instanceof BlockedUrlError === false && /dns/i.test(msg);
      if (!transient || attempt === 3) throw err;
      console.log(`  (${label} attempt ${attempt} hit transient DNS failure, retrying)`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

const TOOL_BLOCK = '```tool\n{"tool":"explore_url","args":{"url":"https://example.com"}}\n```';

async function main(): Promise<void> {
  console.log("REA agent tool-execution reliability regression\n");

  // ---------------------------------------------------------------------
  section("A. Tool-block parsing (model-to-tool handoff)");
  // ---------------------------------------------------------------------

  const canonical = parseToolAction(`Thought: fetch the page.\n${TOOL_BLOCK}`);
  check(
    "A1  canonical closed block parses",
    canonical?.tool === "explore_url" && canonical.args.url === "https://example.com",
    JSON.stringify(canonical)
  );

  const lastWins = parseToolAction(
    `${TOOL_BLOCK}\nand then:\n\`\`\`tool\n{"tool":"update_plan","args":{"tasks":[{"title":"a","status":"in_progress"},{"title":"b","status":"pending"}]}}\n\`\`\``
  );
  check("A2  LAST block wins when two are present", lastWins?.tool === "update_plan", JSON.stringify(lastWins));

  const spaced = parseToolAction('``` tool\n{"tool":"explore_url","args":{}}\n```');
  check(
    "A3  '``` tool' (space after fence) parses — was silently degraded to prose",
    spaced?.tool === "explore_url",
    JSON.stringify(spaced)
  );

  const upper = parseToolAction('```TOOL\n{"tool":"explore_url","args":{}}\n```');
  check("A4  '```TOOL' (upper-case) parses", upper?.tool === "explore_url", JSON.stringify(upper));

  const tilde = parseToolAction('~~~tool\n{"tool":"explore_url","args":{}}\n~~~');
  check("A5  tilde fence parses", tilde?.tool === "explore_url", JSON.stringify(tilde));

  const crlf = parseToolAction('```tool\r\n{"tool":"explore_url","args":{}}\r\n```');
  check("A6  CRLF block parses", crlf?.tool === "explore_url", JSON.stringify(crlf));

  const indented = parseToolAction('intro\n\n  ```tool\n  {"tool":"explore_url","args":{}}\n  ```');
  check("A7  indented fence parses", indented?.tool === "explore_url", JSON.stringify(indented));

  const unterminated = parseToolAction('```tool\n{"tool":"explore_url","args":{"url":"https://example.com"}}');
  check(
    "A8  unterminated block with valid JSON parses (forgot-closing-fence fallback)",
    unterminated?.tool === "explore_url" && unterminated.args.url === "https://example.com",
    JSON.stringify(unterminated)
  );

  const unterminatedGarbage = parseToolAction("```tool\nthis is prose, not json");
  check(
    "A9  unterminated block with non-JSON tail is NOT executed (null → final answer)",
    unterminatedGarbage === null,
    JSON.stringify(unterminatedGarbage)
  );

  check("A10 plain prose yields null", parseToolAction("Just answer, no tools needed.") === null);

  const malformed = parseToolAction('```tool\n{"tool": explore_url}\n```');
  check(
    "A11 malformed JSON inside a closed block yields null (existing behavior kept)",
    malformed === null,
    JSON.stringify(malformed)
  );

  const jsonFence = parseToolAction('```json\n{"tool":"explore_url","args":{}}\n```');
  check("A12 non-tool fence (```json) yields null", jsonFence === null, JSON.stringify(jsonFence));

  const closedBeatsTail = parseToolAction(
    `${TOOL_BLOCK}\n\nUnrelated trailing text with an unterminated opener:\n\`\`\`tool\n{"tool":"rea_tool","args":{"tool":"search"}}`
  );
  check(
    "A13 closed block takes priority over a later unterminated opener",
    closedBeatsTail?.tool === "explore_url",
    JSON.stringify(closedBeatsTail)
  );

  // ---------------------------------------------------------------------
  section("B. Registry execution + honest error handling");
  // ---------------------------------------------------------------------

  const unknown = await executeAgentTool("no_such_tool", {}, stubCtx);
  check(
    "B1  unknown tool returns actionable error string (never throws)",
    unknown.startsWith("Error: unknown tool") &&
      unknown.includes("target_info") &&
      unknown.includes("rea_tool"),
    unknown.slice(0, 120)
  );

  const notAllowed = await executeAgentTool(
    "rea_tool",
    { tool: "definitely_not_allowlisted", args: {} },
    stubCtx
  );
  check(
    "B2  non-allowlisted engine tool refused before any engine contact",
    notAllowed.includes('not allowlisted') && notAllowed.includes("inspect_artifact"),
    notAllowed.slice(0, 120)
  );

  const missingTool = await executeAgentTool("rea_tool", { args: {} }, stubCtx);
  check("B3  rea_tool without 'tool' arg returns usage error", missingTool.startsWith("Error: 'tool' is required."), missingTool.slice(0, 80));

  const plan = await applyPlanUpdate({
    tasks: [
      { title: "Step 1", status: "in_progress" },
      { title: "Step 2", status: "pending" },
      { title: "Step 3", status: "pending" },
    ],
  });
  check(
    "B4  update_plan executes for real",
    plan.includes("Plan updated: 3 steps") && plan.includes("now working on: Step 1"),
    plan
  );

  const planBad = await applyPlanUpdate({ tasks: [{ title: "only one" }] });
  check(
    "B5  malformed plan returns format help (honest error)",
    planBad.startsWith("Error:") && planBad.includes("2-8 items"),
    planBad.slice(0, 100)
  );

  const planDouble = await applyPlanUpdate({
    tasks: [
      { title: "First", status: "in_progress" },
      { title: "Second", status: "in_progress" },
    ],
  });
  check(
    "B6  two in_progress steps downgraded to a single focus",
    planDouble.includes("now working on: First") && !planDouble.includes("Second"),
    planDouble
  );

  const noUrl = await runExploreUrlTool({});
  check(
    "B7  explore_url without url returns usage error",
    noUrl.startsWith("Error:") && noUrl.includes("'url' is required"),
    noUrl.slice(0, 100)
  );

  const ftp = await runExploreUrlTool({ url: "ftp://example.com/x" });
  check(
    "B8  unsafe scheme refused through the SSRF guard",
    ftp.startsWith("Error:") && ftp.includes("SSRF guard"),
    ftp.slice(0, 140)
  );

  const unparseable = await runExploreUrlTool({ url: "not a url at all" });
  check(
    "B9  unparseable URL refused as BlockedUrlError path",
    unparseable.startsWith("Error:") && unparseable.includes("SSRF guard"),
    unparseable.slice(0, 140)
  );

  const live = await withDnsRetry(
    () => runExploreUrlTool({ url: "https://example.com" }),
    "example.com"
  );
  check(
    "B10 agent explore_url executes a REAL fetch of https://example.com",
    live.includes("# explore_url — OBSERVED fetch") &&
      live.includes("status: 200") &&
      live.includes("Example Domain"),
    live.split("\n").slice(0, 5).join(" | ")
  );

  // ---------------------------------------------------------------------
  section("C. Cross-turn receipts + scoped redirect + prompt contracts");
  // ---------------------------------------------------------------------

  check("C1  toolReceiptSuffix(null) → empty", toolReceiptSuffix(null) === "");
  check("C2  toolReceiptSuffix(garbage) → empty", toolReceiptSuffix("not json{") === "");
  check(
    "C3  toolReceiptSuffix(non-array json) → empty",
    toolReceiptSuffix('{"tool":"explore_url"}') === ""
  );

  const trace = JSON.stringify([
    {
      tool: "explore_url",
      args: { url: "https://example.com" },
      result: "# explore_url — OBSERVED fetch\n- status: 200\nExample Domain text",
    },
  ]);
  const receipt = toolReceiptSuffix(trace);
  check(
    "C4  receipt lists tool, args, result and is labeled as system-injected",
    receipt.includes("[SYSTEM receipt") &&
      receipt.includes("explore_url") &&
      receipt.includes("https://example.com") &&
      receipt.includes("status: 200"),
    receipt.slice(0, 160)
  );

  const many = JSON.stringify(
    Array.from({ length: 6 }, (_, i) => ({ tool: `t${i}`, args: {}, result: "r" }))
  );
  const capped = toolReceiptSuffix(many);
  check(
    "C5  receipt caps at 5 tool lines",
    (capped.match(/^- /gm) ?? []).length === 5,
    `${(capped.match(/^- /gm) ?? []).length} lines`
  );

  const longResult = "x".repeat(400);
  const truncated = toolReceiptSuffix(
    JSON.stringify([{ tool: "t", args: {}, result: longResult }])
  );
  check(
    "C6  long result truncated to 160 chars with ellipsis",
    truncated.includes("x".repeat(160) + "…") && !truncated.includes("x".repeat(200)),
    `len=${truncated.length}`
  );

  const notice = freeChatRedirectNotice("target_info");
  check(
    "C7  redirect notice scopes refusal to THAT tool and re-asserts working tools",
    notice.includes('"target_info"') &&
      notice.includes("unavailable here") &&
      notice.includes("update_plan and explore_url remain fully functional") &&
      !notice.includes("Do not emit tool blocks"),
    notice.slice(0, 120)
  );

  const freePrompt = freeChatSystemPrompt();
  check(
    "C8  free-chat prompt forbids denying tool access",
    freePrompt.includes('NEVER say that you "cannot access tools"') &&
      freePrompt.includes("Tool execution in this chat is REAL"),
    ""
  );
  check(
    "C9  free-chat prompt states the precise capability boundary",
    freePrompt.includes("NO tool for running shell commands") &&
      freePrompt.includes('not "tools are unavailable"'),
    ""
  );

  const fakeTarget = {
    id: "t",
    originalName: "sample.elf",
    sizeBytes: 1024,
    sha256: "ab".repeat(32),
    mimeType: "application/octet-stream",
    detectedFormat: "elf",
    formatFamily: "elf",
    status: "ready",
    summary: "",
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Target;
  const targetPrompt = systemPrompt(fakeTarget);
  check(
    "C10 target-chat prompt forbids denying tool access",
    targetPrompt.includes('NEVER claim you "cannot access tools"') &&
      targetPrompt.includes("tools are REAL and already work"),
    ""
  );
  check(
    "C11 target-chat prompt states the precise capability boundary",
    targetPrompt.includes("no shell or test-suite runner") &&
      targetPrompt.includes("THIS capability is unavailable"),
    ""
  );
  check(
    "C12 registry names all appear in the target-chat catalog (no prompt/registry drift)",
    AGENT_TOOLS.every((t) => targetPrompt.includes(`**${t.name}**`)),
    AGENT_TOOLS.map((t) => t.name).join(", ")
  );

  // ---------------------------------------------------------------------
  section("D. Interrupted streams, failed calls, continuation");
  // ---------------------------------------------------------------------

  /** Fake async-iterable model stream: yields the given chunks, then either
   * ends cleanly or STALLS (pending next() that never settles — the exact
   * upstream failure shape that used to hang the turn forever). */
  function fakeStream(chunks: unknown[], stall = false) {
    let closedCalls = 0;
    const iterable = {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            if (i < chunks.length) return { done: false, value: chunks[i++] };
            if (stall) await new Promise<never>(() => {}); // never resolves
            return { done: true, value: undefined };
          },
          return: async (): Promise<IteratorResult<unknown>> => {
            closedCalls++;
            return { done: true, value: undefined };
          },
        };
      },
    };
    return { iterable, closedRef: () => closedCalls };
  }

  const frame = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

  // D1 — a stalled stream must end with a retryable stall error, promptly,
  // and the underlying iterator must be closed.
  {
    const { iterable, closedRef } = fakeStream([frame("Hel"), frame("lo")], true);
    const t0 = Date.now();
    let stallErr: Error | null = null;
    try {
      await consumeModelStream(iterable, () => {}, { idleTimeoutMs: 400 });
    } catch (err) {
      stallErr = err instanceof Error ? err : null;
    }
    const elapsed = Date.now() - t0;
    check(
      "D1  stalled stream → prompt retryable stall error (was: silent forever-hang)",
      stallErr !== null &&
        /stalled.*timed out/i.test(stallErr.message) &&
        isTransientLlmError(stallErr) &&
        elapsed < 3000 &&
        elapsed >= 350 &&
        closedRef() === 1,
      `${stallErr?.message ?? "no error"} | elapsed=${elapsed}ms closed=${closedRef()}`
    );
  }

  // D2 — abort during a stall must surface as TurnAbortedError (never retried).
  {
    const { iterable, closedRef } = fakeStream([frame("abc")], true);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    let abortedOk = false;
    try {
      await consumeModelStream(iterable, () => {}, { signal: ac.signal, idleTimeoutMs: 10_000 });
    } catch (err) {
      abortedOk = err instanceof TurnAbortedError;
    }
    check(
      "D2  abort during stall → TurnAbortedError (cancellation is never retried)",
      abortedOk && closedRef() === 1,
      `abortedOk=${abortedOk} closed=${closedRef()}`
    );
  }

  // D3 — clean stream: full text, per-chunk deltas, single close.
  {
    const { iterable, closedRef } = fakeStream([frame("Hel"), frame("lo"), "data: [DONE]\n\n"]);
    const deltas: string[] = [];
    const full = await consumeModelStream(iterable, (d) => deltas.push(d));
    check(
      "D3  clean stream completes with deltas and releases the iterator",
      full === "Hello" && deltas.join("") === "Hello" && closedRef() === 1,
      `full=${full} deltas=${deltas.length} closed=${closedRef()}`
    );
  }

  // D4 — byte chunks (the SDK's raw SSE shape) parse identically.
  {
    const { iterable } = fakeStream([new TextEncoder().encode(frame("Byte")), "data: [DONE]\n\n"]);
    const full = await consumeModelStream(iterable, () => {});
    check("D4  Uint8Array SSE chunks parse", full === "Byte", `full=${full}`);
  }

  // D5 — callTurn: transient stream failure BEFORE deltas → retried, no
  // single-shot call needed.
  {
    let streamAttempts = 0;
    let singleShotCalls = 0;
    const llm: ResolvedLlm = {
      source: "platform",
      provider: "glm-platform",
      model: "glm-platform",
      callLLM: async () => {
        singleShotCalls++;
        return "unused";
      },
      callLLMStream: async () => {
        streamAttempts++;
        if (streamAttempts === 1) throw new Error("fetch failed: ECONNRESET");
        return "recovered answer";
      },
    };
    const out = await callTurn(llm, [], 0);
    check(
      "D5  transient pre-delta stream failure is retried and recovers",
      out === "recovered answer" && streamAttempts === 2 && singleShotCalls === 0,
      `attempts=${streamAttempts} singleShot=${singleShotCalls}`
    );
  }

  // D6 — callTurn: transient failure AFTER deltas → single-shot fallback
  // (final text replaces the partial draft; no retry storm).
  {
    let streamAttempts = 0;
    let singleShotCalls = 0;
    const llm: ResolvedLlm = {
      source: "platform",
      provider: "glm-platform",
      model: "glm-platform",
      callLLM: async () => {
        singleShotCalls++;
        return "single-shot full answer";
      },
      callLLMStream: async (_m, onDelta) => {
        streamAttempts++;
        onDelta("partial ");
        throw new Error("socket hang up");
      },
    };
    const out = await callTurn(llm, [], 0);
    check(
      "D6  post-delta stream failure falls back to single-shot continuation",
      out === "single-shot full answer" && streamAttempts === 1 && singleShotCalls === 1,
      `out=${out.slice(0, 40)} attempts=${streamAttempts} singleShot=${singleShotCalls}`
    );
  }

  // D7 — non-transient stream failure (auth): NO retry, straight to fallback.
  {
    let streamAttempts = 0;
    let singleShotCalls = 0;
    const llm: ResolvedLlm = {
      source: "platform",
      provider: "glm-platform",
      model: "glm-platform",
      callLLM: async () => {
        singleShotCalls++;
        return "fallback after auth error";
      },
      callLLMStream: async () => {
        streamAttempts++;
        throw new Error("Provider HTTP 401: invalid api key");
      },
    };
    const out = await callTurn(llm, [], 0);
    check(
      "D7  non-transient failure skips retries (no blind loop)",
      out === "fallback after auth error" && streamAttempts === 1 && singleShotCalls === 1,
      `attempts=${streamAttempts} singleShot=${singleShotCalls}`
    );
  }

  // D8 — the new stall error is classified transient (drives the retry).
  check(
    "D8  stall error classified transient for automatic recovery",
    isTransientLlmError(new Error("Platform model stream stalled (no data for 45s) — connection timed out")),
    ""
  );

  // E. Retry dedup + interrupted-turn preservation + BYOK watchdog

  const dedupCtx = (sid: string) => ({
    target: {} as Target,
    userId: "regression",
    sessionId: sid,
  });
  const planArgs = {
    tasks: [
      { title: "Fetch", status: "in_progress" },
      { title: "Report", status: "pending" },
    ],
  };

  const first = await executeAgentTool("update_plan", planArgs, dedupCtx("sess-e1"));
  const second = await executeAgentTool("update_plan", planArgs, dedupCtx("sess-e1"));
  check(
    "E1  identical retry returns the PRIOR result, not a re-execution",
    !first.includes("NOT re-executed") &&
      second.startsWith(first.split("\n")[0]) &&
      second.includes("NOT re-executed"),
    second.slice(-90)
  );

  const changed = await executeAgentTool("update_plan", { tasks: [{ title: "Other", status: "done" }, { title: "X", status: "pending" }] }, dedupCtx("sess-e1"));
  check(
    "E2  changed args execute fresh (no dedup marker)",
    changed.includes("Plan updated") && !changed.includes("NOT re-executed"),
    changed.slice(0, 60)
  );

  const otherSession = await executeAgentTool("update_plan", planArgs, dedupCtx("sess-e3"));
  check(
    "E3  dedup is session-scoped (same args, other session → fresh)",
    otherSession.includes("Plan updated") && !otherSession.includes("NOT re-executed"),
    ""
  );

  const errA = await executeAgentTool("rea_tool", { tool: "not_allowlisted_e4" }, dedupCtx("sess-e4"));
  const errB = await executeAgentTool("rea_tool", { tool: "not_allowlisted_e4" }, dedupCtx("sess-e4"));
  check(
    "E4  failures are never cached (transient errors stay retryable)",
    errA.startsWith("Error:") && errB.startsWith("Error:") && !errB.includes("NOT re-executed"),
    ""
  );

  check(
    "E5  dedup key is argument-order independent",
    toolDedupKey("s", "explore_url", { url: "https://example.com", include_text: true }) ===
      toolDedupKey("s", "explore_url", { include_text: true, url: "https://example.com" }),
    ""
  );

  const noteOnly = formatInterruptedTurnContent(undefined, new Error("Platform model stream stalled (no data for 45s)"));
  check(
    "E6  interrupted turn with no visible text → note only, honest reason",
    noteOnly.includes("Turn interrupted before completion") &&
      noteOnly.includes("stream stalled") &&
      noteOnly.includes("retry reuses their results"),
    noteOnly.slice(0, 90)
  );

  const withProse = formatInterruptedTurnContent("Partial findings: header at 0x0.", new Error("fetch failed"));
  check(
    "E7  interrupted turn preserves completed visible text",
    withProse.startsWith("Partial findings: header at 0x0.") && withProse.includes("Turn interrupted"),
    ""
  );

  const withToolBlock = formatInterruptedTurnContent(
    '```tool\n{"tool":"rea_tool","args":{}}\n```',
    new Error("socket hang up")
  );
  check(
    "E8  raw tool-block text is NOT surfaced as visible work",
    !withToolBlock.includes("```tool") && withToolBlock.includes("Turn interrupted"),
    ""
  );

  // readProviderSse — the shared BYOK SSE reader (OpenAI/Anthropic/Gemini).
  function fakeSseResponse(chunks: string[], stall = false): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(c));
        if (stall) return; // hold the stream open forever, never close
        controller.close();
      },
    });
    return new Response(stream);
  }

  const seen: string[] = [];
  let stallErr: Error | null = null;
  const t0 = Date.now();
  try {
    await readProviderSse(fakeSseResponse([`data: {"a":1}\n\n`], true), (d) => seen.push(d), {
      idleTimeoutMs: 400,
    });
  } catch (err) {
    stallErr = err instanceof Error ? err : null;
  }
  check(
    "E9  BYOK provider stream stall → prompt retryable error (was: silent hang)",
    stallErr !== null &&
      /stalled.*timed out/i.test(stallErr.message) &&
      isTransientLlmError(stallErr) &&
      Date.now() - t0 < 3000,
    `${stallErr?.message ?? "no error"} | frames=${seen.length}`
  );

  const cleanSeen: string[] = [];
  await readProviderSse(
    fakeSseResponse([
      `data: {"choices":[{"delta":{"content":"A"}}]}\n\n`,
      `data: [DONE]\n\n`,
    ]),
    (d) => cleanSeen.push(d)
  );
  check(
    "E10 clean BYOK stream parses frames and terminates",
    cleanSeen.length === 2 && cleanSeen[1] === "[DONE]",
    cleanSeen.join("|").slice(0, 60)
  );

  // ---------------------------------------------------------------------
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("regression-agent crashed:", err);
  process.exit(1);
});
