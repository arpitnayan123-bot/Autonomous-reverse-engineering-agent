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
  parseToolActions,
  toolReceiptSuffix,
  freeChatRedirectNotice,
  callTurn,
  isTransientLlmError,
  formatInterruptedTurnContent,
  finalizeTurnContent,
  runAgentLoop,
} from "@/server/agent/agent";
import {
  AGENT_TOOLS,
  executeAgentTool,
  applyPlanUpdate,
  runExploreUrlTool,
  runFreeChatTool,
  runWebResearchTool,
  runWorkspaceTool,
  FREE_CHAT_TOOL_NAMES,
  toolDedupKey,
  TOOL_REFUSAL_MARKER,
} from "@/server/agent/tools";
import {
  CHAT_WORKSPACE_QUOTA_BYTES,
  ensureWorkspace,
  runCommand,
  workspaceDiskUsage,
  writeFile as builderWriteFile,
} from "@/server/platform/builder";
import { capStructured } from "@/server/engine/rea-bridge";
import { promises as fs } from "fs";
import path from "path";
import { freeChatSystemPrompt, systemPrompt } from "@/server/agent/prompts";
import {
  classifyToolOutcome,
  extractTurnNote,
  turnNoteLines,
  TOOL_REFUSAL_MARKER as CLIENT_REFUSAL_MARKER,
  INTERRUPTED_TURN_MARKER as CLIENT_INTERRUPTED_MARKER,
  INTEGRITY_NOTE_MARKER as CLIENT_INTEGRITY_MARKER,
} from "@/lib/tool-status";
import { BlockedUrlError } from "@/server/platform/net";
import { consumeModelStream, TurnAbortedError } from "@/server/agent/platform-llm";
import { TurnControl, activeTurns } from "@/server/agent/turn-control";
import { readProviderSse } from "@/server/agent/providers";
import { db } from "@/lib/db";
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
    "C7  redirect notice scopes refusal to THAT tool and re-asserts the DERIVED working tools",
    notice.includes('"target_info"') &&
      notice.includes("unavailable here") &&
      FREE_CHAT_TOOL_NAMES.every((n) => notice.includes(n)) &&
      notice.includes("remain fully functional") &&
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
    "C9  free-chat prompt states the precise capability boundary (real sandbox advertised, limits precise)",
    freePrompt.includes('not "tools are unavailable"') &&
      freePrompt.includes("workspace_run") &&
      freePrompt.includes("not a full shell, OS environment or network sandbox") &&
      !freePrompt.includes("NO tool for running shell commands"),
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
    targetPrompt.includes("never executed") &&
      targetPrompt.includes("workspace_run") &&
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
  // F. Viewer-detached turn control (repository-analysis lost-contact fix)
  //
  // Real-world failure this locks in: the external preview proxy severs
  // long responses (~30s measured on genuine Express.js analysis turns)
  // while deltas were still flowing, and the server used to treat that
  // viewer death as a cancellation order — cancelling HEALTHY turns
  // mid-synthesis. The fix decouples turn lifetime from the viewer: only an
  // explicit stop (POST /api/chat/stop) or the safety deadline cancels.
  // ---------------------------------------------------------------------

  const running = new TurnControl();
  check(
    "F1  fresh control is running (not stopped, no reason, signal live)",
    !running.stopped && running.reason === null && !running.signal.aborted,
    ""
  );

  running.stop("Turn cancelled by user");
  check(
    "F2  stop() aborts the signal and records the reason",
    running.stopped && running.reason === "Turn cancelled by user" && running.signal.aborted,
    running.reason ?? ""
  );
  running.stop("a second stop attempt");
  check(
    "F3  stop() is idempotent — the first reason is preserved",
    running.stopped && running.reason === "Turn cancelled by user",
    ""
  );
  running.dispose();

  const deadlined = new TurnControl(30);
  const deadlineFired = await new Promise<boolean>((resolve) => {
    setTimeout(
      () =>
        resolve(
          deadlined.stopped &&
            (deadlined.reason ?? "").startsWith("Turn exceeded the safety deadline") &&
            deadlined.signal.aborted
        ),
      80
    );
  });
  check("F4  the safety deadline stops the turn automatically", deadlineFired, deadlined.reason ?? "");
  deadlined.dispose();

  const regKey = `reg-f5-${Date.now()}`;
  activeTurns.set(regKey, running);
  const registryRoundTrip = activeTurns.get(regKey) === running;
  activeTurns.delete(regKey);
  check(
    "F5  turn registry round-trips and clears (stop endpoint lookup path)",
    registryRoundTrip && activeTurns.get(regKey) === undefined,
    ""
  );

  // F5b: the registry is a PROCESS singleton backed by globalThis (the
  // lib/db.ts Prisma pattern). A module-level Map let Next.js dev (HMR /
  // per-route bundle evaluation) hand /api/chat/stop a fresh empty map while
  // the turn lived in the chat route's instance — Stop silently returned
  // stopped:false and the server kept generating for minutes after the user
  // cancelled (reproduced live). The map must be the SAME object across
  // module evaluations, reached through the well-known symbol.
  const globalMap = (globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for("rea.activeTurns")
  ];
  check(
    "F5b turn registry is globalThis-backed (HMR-proof stop lookups)",
    globalMap instanceof Map && globalMap === activeTurns,
    `same-object:${globalMap === activeTurns}`
  );

  const abortErr = new TurnAbortedError();
  const abortNote = formatInterruptedTurnContent(undefined, abortErr);
  check(
    "F6  cancellation aborts render an honest by-user note",
    abortErr.message === "Turn cancelled by user" &&
      abortNote.includes("Turn interrupted before completion") &&
      abortNote.includes("Turn cancelled by user"),
    abortNote.slice(0, 90)
  );

  const deadlineNote = formatInterruptedTurnContent(
    undefined,
    new TurnAbortedError("Turn exceeded the safety deadline and was stopped")
  );
  check(
    "F7  deadline reason renders verbatim in the persisted note",
    deadlineNote.includes("Turn exceeded the safety deadline"),
    ""
  );

  // Clean-break path: shouldCancel() true from the very first iteration must
  // yield the cancelled synthesis text with ZERO model calls (the loop breaks
  // before callTurn) — and must not throw despite the unpersistable bogus
  // session id (the persistence-failure catch is intentional).
  const cancelledLoop = await runAgentLoop({
    sessionId: `reg-f8-${Date.now()}`,
    target: null,
    userId: "regression",
    userMessage: "analyze a repository",
    history: [],
    events: {
      shouldCancel: () => true,
      cancellationReason: () => "Turn cancelled by user",
    },
  });
  check(
    "F8  shouldCancel clean-break ends the turn honestly with no model call",
    cancelledLoop.content.includes("Investigation cancelled by user") &&
      cancelledLoop.toolCalls.length === 0,
    cancelledLoop.content.slice(0, 60)
  );
  // The F8 loop's persistence step actually INSERTS (SQLite runs without FK
  // enforcement) — remove the synthetic row so the suite leaves no garbage.
  await db.chatMessage.deleteMany({ where: { sessionId: { startsWith: "reg-f8-" } } });
  const f8Leftovers = await db.chatMessage.count({ where: { sessionId: { startsWith: "reg-f8-" } } });
  check("F9  regression run leaves no synthetic chat rows behind", f8Leftovers === 0, "");

  // ---------------------------------------------------------------------
  // G. Fabricated-execution integrity (the real calculator/Jest incident)
  //
  // Real-world failure this locks in (free chat, 2026-10-14): asked to build
  // a Node.js calculator and run Jest, the model emitted ONE message with
  // NINE tool fences (one update_plan, six fabricated "execute" calls, and
  // two malformed tails like {"execute":{...}} without a "tool" key) plus a
  // fully fabricated report — fake "ls -la", fake package.json, fake Jest
  // output "Tests: 12 passed". The old parser took the LAST closed block,
  // failed to see a valid action in it, returned null, and the ENTIRE
  // message — fabrications included — became the persisted, streamed final
  // answer. Zero tools ran; nothing was refused; nothing was labeled. The
  // next turn the model then said "I cannot use the execute tool in this
  // chat" — the contradiction the user reported.
  // ---------------------------------------------------------------------

  // A faithful reconstruction of the failing message (all fences closed, the
  // two malformed no-tool-key tails last — exactly the poisoning shape).
  const fabricatedMessage = [
    "I'll create a Node.js calculator project with automated tests.",
    "",
    "```tool",
    '{"tool":"update_plan","args":{"tasks":[{"title":"Create project structure","status":"in_progress"},{"title":"Run tests","status":"pending"}]}}',
    "```",
    "",
    "First, create the structure:",
    "",
    "```tool",
    '{"tool":"execute","args":{"command":"mkdir calculator-project && npm init -y"}}',
    "```",
    "",
    "```tool",
    '{"tool":"execute","args":{"command":"cat > calculator.js"}}',
    "```",
    "",
    "```tool",
    '{"tool":"execute","args":{"command":"npm install --save-dev jest"}}',
    "```",
    "",
    "```tool",
    '{"tool":"execute","args":{"command":"npx jest"}}',
    "```",
    "",
    "Now the report:",
    "",
    "### Test Execution Results",
    "```",
    "Tests:       12 passed, 12 total",
    "```",
    "All tests passed successfully.",
    "",
    "```tool",
    '{"execute":{"command":"cat package.json"}}',
    "```",
    "",
    "```tool",
    '{"update_plan":{"args":{"tasks":[{"title":"done","status":"completed"}]}}}',
    "```",
  ].join("\n");

  section("G. Fabricated-execution integrity (calculator/Jest incident)");

  const fabricatedParse = parseToolActions(fabricatedMessage);
  check(
    "G1  every valid intent is parsed (was: whole message degraded to final answer)",
    fabricatedParse.actions.length === 5 &&
      fabricatedParse.actions[0].tool === "update_plan" &&
      fabricatedParse.actions.filter((a) => a.tool === "execute").length === 4 &&
      fabricatedParse.malformedCount === 2 &&
      fabricatedParse.hasToolFences,
    `actions=${fabricatedParse.actions.map((a) => a.tool).join(",")} malformed=${fabricatedParse.malformedCount}`
  );
  const legacyParse = parseToolAction(fabricatedMessage);
  check(
    "G2  a malformed LAST block no longer poisons the valid ones (last VALID wins)",
    legacyParse?.tool === "execute" && legacyParse.args.command === "npx jest",
    JSON.stringify(legacyParse)
  );

  // Loop-level free-chat reproduction with a scripted model: turn 1 is the
  // exact fabricated message, turn 2 an honest recovery answer.
  function fakeLlm(
    script: string[],
    capturedMessages: Array<{ role: string; content: string }[]>
  ): ResolvedLlm & { calls: () => number } {
    let call = 0;
    const fn = async (messages: { role: string; content: string }[]) => {
      capturedMessages.push(messages.map((m) => ({ role: m.role, content: m.content })));
      const text = script[Math.min(call, script.length - 1)];
      call++;
      return text;
    };
    return {
      source: "platform" as const,
      provider: "glm-platform" as const,
      model: "glm-platform",
      callLLM: fn,
      calls: () => call,
    } as unknown as ResolvedLlm & { calls: () => number };
  }

  const g2Captured: Array<{ role: string; content: string }[]> = [];
  const g2RefusalEvents: string[] = [];
  const g2 = await runAgentLoop({
    sessionId: `reg-g2-${Date.now()}`,
    target: null,
    userId: "regression",
    userMessage: "Create a calculator project and run Jest.",
    history: [],
    llmOverride: fakeLlm([fabricatedMessage, "The execute capability is unavailable here; nothing was created or run."], g2Captured),
    events: {
      onToolResult: (tool, result) => {
        if (tool === "execute") g2RefusalEvents.push(result);
      },
    },
  });
  const g2Trace = g2.toolCalls;
  check(
    "G3  loop executes the plan, records EVERY refused call in the trace",
    g2Trace[0]?.tool === "update_plan" && g2Trace[0].result.includes("Plan updated") &&
      g2Trace.filter((t) => t.tool === "execute" && t.result.startsWith(TOOL_REFUSAL_MARKER)).length === 3,
    g2Trace.map((t) => t.tool).join(",")
  );
  check(
    "G4  refusals stream live via onToolResult and state the precise boundary",
    g2RefusalEvents.length === 3 &&
      g2RefusalEvents.every((r) => r.startsWith(TOOL_REFUSAL_MARKER)) &&
      g2RefusalEvents[0].includes("unavailable in this chat"),
    g2RefusalEvents[0] ?? "none"
  );
  const g2SecondCall = g2Captured[1] ?? [];
  const g2Feedback = g2SecondCall.map((m) => m.content).join("\n");
  check(
    "G5  model gets explicit feedback: redirect notice + skipped/malformed counts + real plan result",
    g2Feedback.includes("operates on an uploaded file target") &&
      g2Feedback.includes("1 additional tool block(s)") &&
      g2Feedback.includes("2 tool block(s) were malformed") &&
      g2Feedback.includes("TOOL RESULT for update_plan"),
    g2Feedback.slice(0, 120)
  );
  check(
    "G6  fabricated success narrative NEVER becomes the final answer",
    !g2.content.includes("12 passed") &&
      !g2.content.includes("Tests:") &&
      g2.content.startsWith("The execute capability is unavailable"),
    g2.content.slice(0, 80)
  );

  const g3Receipt = toolReceiptSuffix(
    JSON.stringify([
      { tool: "explore_url", args: { url: "https://example.com" }, result: "# explore_url — OBSERVED fetch\n- status: 200" },
      { tool: "execute", args: { command: "npx jest" }, result: `${TOOL_REFUSAL_MARKER} — "execute" is unavailable in this chat.` },
    ])
  );
  check(
    "G7  receipts label refused entries and never claim they executed",
    g3Receipt.includes("[REFUSED — did not run]") &&
      g3Receipt.includes("explore_url") &&
      g3Receipt.split("execute(").length === 2 &&
      g3Receipt.includes("real tool outcomes"),
    g3Receipt.slice(0, 140)
  );

  const g8Note = finalizeTurnContent(
    "Report with simulated block:\n```tool\n{\"execute\":{\"command\":\"ls\"}}\n```\nAll 12 tests passed.",
    [
      { tool: "explore_url", args: {}, result: "# explore_url — OBSERVED fetch" },
      { tool: "execute", args: {}, result: `${TOOL_REFUSAL_MARKER} — refused` },
    ],
    ["update_plan", "explore_url"]
  );
  check(
    "G8  integrity gate labels simulated output and lists only GENUINE executions",
    g8Note.includes("Integrity note (system)") &&
      g8Note.includes("fabricated") &&
      g8Note.includes("genuinely executed during this turn: explore_url") &&
      !g8Note.includes("genuinely executed during this turn: explore_url, execute") &&
      g8Note.includes("Tools actually available here: update_plan, explore_url"),
    g8Note.slice(-260)
  );
  const cleanFinal = "A clean answer with no tool claims.";
  check(
    "G9  clean answers pass the integrity gate untouched",
    finalizeTurnContent(cleanFinal, [], ["update_plan"]) === cleanFinal,
    ""
  );

  // Malformed-only message: bounded acceptance (one model call) + labeled.
  const g5Captured: Array<{ role: string; content: string }[]> = [];
  const g5Llm = fakeLlm(
    ['I ran everything:\n```tool\n{"execute":{"command":"ls"}}\n```\nOutput:\n```\n12 passed\n```'],
    g5Captured
  );
  const g5 = await runAgentLoop({
    sessionId: `reg-g5-${Date.now()}`,
    target: null,
    userId: "regression",
    userMessage: "run the tests",
    history: [],
    llmOverride: g5Llm,
  });
  check(
    "G10 malformed-only fabrication is accepted ONCE, honestly labeled, no extra iterations",
    g5Llm.calls() === 1 &&
      g5.content.includes("12 passed") &&
      g5.content.includes("Integrity note (system)") &&
      g5.content.includes("genuinely executed during this turn: none"),
    g5.content.slice(-160)
  );

  // Per-message cap: 6 valid blocks → 4 processed, 2 explicitly reported.
  const g7Captured: Array<{ role: string; content: string }[]> = [];
  const sixPlans = Array.from(
    { length: 6 },
    (_, i) =>
      `step ${i}\n\`\`\`tool\n{"tool":"update_plan","args":{"tasks":[{"title":"unique step ${i}","status":"in_progress"},{"title":"other ${i}","status":"pending"}]}}\n\`\`\``
  ).join("\n");
  const g7Llm = fakeLlm([sixPlans, "done summarizing."], g7Captured);
  const g7 = await runAgentLoop({
    sessionId: `reg-g7-${Date.now()}`,
    target: null,
    userId: "regression",
    userMessage: "plan",
    history: [],
    llmOverride: g7Llm,
  });
  const g7Feedback = (g7Captured[1] ?? []).map((m) => m.content).join("\n");
  check(
    "G11 per-message tool cap enforced with explicit skip feedback",
    g7.toolCalls.length === 4 &&
      g7Feedback.includes("2 additional tool block(s)") &&
      g7.toolCalls.every((t) => t.result.includes("Plan updated")),
    `traced=${g7.toolCalls.length}`
  );

  // Target chat: multiple valid blocks all execute through the registry.
  // FK enforcement is ON: create a real user first, then the target row.
  const g6TargetId = `reg-g6-${Date.now()}`;
  const g6UserId = `reg-g6u-${Date.now()}`;
  await db.user.create({
    data: { id: g6UserId, email: `${g6UserId}@regression.invalid`, passwordHash: "regression-only" },
  });
  await db.target.create({
    data: {
      id: g6TargetId,
      userId: g6UserId,
      originalName: "sample.db",
      storedPath: "/tmp/reg-g6-none",
      sizeBytes: 1,
      sha256: "cd".repeat(32),
      detectedFormat: "sqlite",
    },
  });
  const g6Captured: Array<{ role: string; content: string }[]> = [];
  const g6 = await runAgentLoop({
    sessionId: `reg-g6-${Date.now()}`,
    target: (await db.target.findUnique({ where: { id: g6TargetId } })) as Target,
    userId: "regression",
    userMessage: "inspect",
    history: [],
    llmOverride: fakeLlm(
      [
        [
          "planning first",
          "```tool",
          '{"tool":"update_plan","args":{"tasks":[{"title":"Schema","status":"in_progress"},{"title":"Report","status":"pending"}]}}',
          "```",
          "```tool",
          '{"tool":"sql_schema"}',
          "```",
        ].join("\n"),
        "Report done.",
      ],
      g6Captured
    ),
  });
  check(
    "G12 target chat executes every valid block through the registry (honest errors included)",
    g6.toolCalls.length === 2 &&
      g6.toolCalls[0].tool === "update_plan" &&
      g6.toolCalls[1].tool === "sql_schema" &&
      g6.toolCalls[1].result.startsWith("Error reading SQLite schema"),
    g6.toolCalls.map((t) => `${t.tool}:${t.result.slice(0, 24)}`).join(" | ")
  );

  // Refusals are never cached as successes — a retried refusal stays a
  // refusal (no "NOT re-executed" dedup annotation on a non-execution).
  const g8sess = `reg-g8-${Date.now()}`;
  const refuseOnce = await runAgentLoop({
    sessionId: g8sess,
    target: null,
    userId: "regression",
    userMessage: "x",
    history: [],
    llmOverride: fakeLlm(
      ['```tool\n{"tool":"execute","args":{"command":"npx jest"}}\n```', "ok."],
      []
    ),
  });
  const refuseTwice = await runAgentLoop({
    sessionId: g8sess,
    target: null,
    userId: "regression",
    userMessage: "x again",
    history: [],
    llmOverride: fakeLlm(
      ['```tool\n{"tool":"execute","args":{"command":"npx jest"}}\n```', "ok."],
      []
    ),
  });
  check(
    "G13 a refusal is never dedup-cached into a fake success",
    refuseOnce.toolCalls[0].result.startsWith(TOOL_REFUSAL_MARKER) &&
      refuseTwice.toolCalls[0].result.startsWith(TOOL_REFUSAL_MARKER) &&
      !refuseTwice.toolCalls[0].result.includes("NOT re-executed"),
    refuseTwice.toolCalls[0].result.slice(0, 60)
  );

  // Cleanup: every synthetic row this section created.
  await db.chatMessage.deleteMany({
    where: { sessionId: { startsWith: "reg-g" } },
  });
  await db.target.deleteMany({ where: { id: { startsWith: "reg-g6-" } } });
  await db.user.deleteMany({ where: { id: { startsWith: "reg-g6u-" } } });
  const gLeftovers =
    (await db.chatMessage.count({ where: { sessionId: { startsWith: "reg-g" } } })) +
    (await db.target.count({ where: { id: { startsWith: "reg-g6-" } } })) +
    (await db.user.count({ where: { id: { startsWith: "reg-g6u-" } } }));
  check("G14 section G leaves no synthetic rows behind", gLeftovers === 0, "");

  // ---------------------------------------------------------------------
  // SECTION H — UI honest-status contract: the client classifiers that drive
  // the preview window (trace-row states + turn banners) stay locked to the
  // LIVE server markers and note builders. If the server wording changes and
  // the client mirror does not, these checks fail — the UI can never silently
  // mislabel refused/failed/executed work or lose the interruption/integrity
  // banners.
  // ---------------------------------------------------------------------
  section("H — UI honest-status classifiers (src/lib/tool-status.ts)");

  // H1: the client refusal mirror is byte-identical to the live server constant.
  check(
    "H1 client TOOL_REFUSAL_MARKER mirrors the server constant",
    CLIENT_REFUSAL_MARKER === TOOL_REFUSAL_MARKER,
    `client="${CLIENT_REFUSAL_MARKER}" server="${TOOL_REFUSAL_MARKER}"`
  );

  // H2: a real refusal result (exactly what G3's loop produced) classifies
  // as refused — the UI shows the NOT EXECUTED row, never a green check.
  check(
    "H2 refusal result classifies as refused",
    classifyToolOutcome({ pending: false, preview: `${TOOL_REFUSAL_MARKER} — "execute" is unavailable in this chat (no file target attached).` }) ===
      "refused",
    ""
  );

  // H3: failure shapes classify as failed — the plain "Error:" prefix every
  // tool error returns, and the rea_tool MCP isError envelope.
  check(
    "H3 tool failures classify as failed",
    classifyToolOutcome({ pending: false, preview: "Error: 'query' is required." }) === "failed" &&
      classifyToolOutcome({
        pending: false,
        preview: "REA tool binary_overview → isError: true\nboom",
      }) === "failed",
    ""
  );

  // H4: genuine executions classify as executed — including a cross-turn
  // dedup reuse, whose text PREPENDS the original genuine result (the
  // "(reused ... NOT re-executed ...)" suffix must never flip the verdict),
  // and leading whitespace is tolerated (trimStart contract).
  const dedupReused = "Example Domain\n\n(reused from the earlier identical execution in this session — NOT re-executed; identical calls within 10 minutes are deduplicated across retries)";
  check(
    "H4 genuine results (incl. dedup reuse) classify as executed",
    classifyToolOutcome({ pending: false, preview: dedupReused }) === "executed" &&
      classifyToolOutcome({ pending: false, preview: "  Error: x" }) === "failed" &&
      classifyToolOutcome({ pending: false, preview: "" }) === "executed" &&
      classifyToolOutcome({ pending: true, preview: null }) === "running",
    ""
  );

  // H5: the interrupted-turn note BUILT BY THE LIVE formatInterruptedTurnContent
  // is extracted by the client — banner kind, body = the preserved visible
  // text, note carries the failure message.
  const h5Visible = "Partial analysis so far: the header looks like an ELF64 binary.";
  const h5Content = formatInterruptedTurnContent(h5Visible, new Error("Turn cancelled by user"));
  const h5Note = extractTurnNote(h5Content);
  check(
    "H5 live interrupted note extracts as a banner",
    h5Note !== null &&
      h5Note.kind === "interrupted" &&
      h5Note.body === h5Visible &&
      h5Note.note.includes("Turn cancelled by user") &&
      h5Note.note.includes("preserved in the trace above"),
    `body===visible:${h5Note?.body === h5Visible}`
  );

  // H6: interrupted turn with NO visible text — body is empty, note intact.
  const h6Content = formatInterruptedTurnContent(undefined, new Error("Safety deadline reached"));
  const h6Note = extractTurnNote(h6Content);
  check(
    "H6 note-only interruption yields an empty body",
    h6Note !== null && h6Note.kind === "interrupted" && h6Note.body === "" && h6Note.note.length > 0,
    ""
  );

  // H7: the integrity note BUILT BY THE LIVE finalizeTurnContent extracts as
  // a banner — kind integrity, body = the simulated-block answer WITHOUT any
  // note lines, note names the genuinely executed tool and the availability
  // boundary.
  const h7Fabricated = [
    "Here is the project:",
    "```tool",
    '{"execute":{"command":"npx jest"}}',
    "```",
    "Tests: 12 passed",
  ].join("\n");
  const h7Final = finalizeTurnContent(
    h7Fabricated,
    [
      { tool: "update_plan", args: {}, result: "Plan updated." },
      { tool: "execute", args: {}, result: `${TOOL_REFUSAL_MARKER} — refused` },
    ],
    ["update_plan", "explore_url"]
  );
  const h7Note = extractTurnNote(h7Final);
  check(
    "H7 live integrity note extracts as a banner",
    h7Note !== null &&
      h7Note.kind === "integrity" &&
      h7Note.body === h7Fabricated &&
      h7Note.note.includes("update_plan") &&
      h7Note.note.includes("explore_url"),
    `body===fabricated:${h7Note?.body === h7Fabricated}`
  );

  // H8: clean content (no note) → null — the prose renders untouched.
  const h8 = "Clean final answer with no tool syntax at all.";
  check(
    "H8 clean content extracts no note",
    extractTurnNote(h8) === null && extractTurnNote("") === null,
    ""
  );

  // H9: the banner's plain-text lines carry no markdown emphasis or
  // blockquote markers, and the marker phrases are exactly the ones the
  // client banner filters by (they must not drift from the server wording).
  const h9Lines = turnNoteLines(h7Note?.note ?? "");
  check(
    "H9 banner lines are plain text and markers stay aligned",
    h9Lines.length >= 3 &&
      h9Lines.every((l) => !l.includes("**") && !l.startsWith(">")) &&
      h9Lines[0].startsWith("Integrity note (system):") &&
      formatInterruptedTurnContent("", new Error("x")).includes(CLIENT_INTERRUPTED_MARKER) &&
      h7Final.includes(CLIENT_INTEGRITY_MARKER),
    ""
  );

  // ---------------------------------------------------------------------
  // I. Chat workspace sandbox — the round-35 capability audit.
  //
  // Round-33's audit classified shell/file ops as IMPLEMENTED (builder.ts
  // project workspaces) but NOT EXPOSED to chat, so the model's only honest
  // move was to refuse build-and-run requests — and its dishonest move was
  // to fabricate them. Round 35 EXPOSES the sandbox to chat. This section
  // proves: real bytes land on disk, real commands run with real output,
  // every escape vector tried is honestly refused, stateful tools are not
  // dedup-cached, the advertisement derives from the registry (parity, no
  // drift), and the full free-chat loop executes the pipeline FOR REAL.
  // ---------------------------------------------------------------------

  section("I. Chat workspace sandbox (real execution + advertisement parity)");

  // I1: every registry tool declares its scope; the free set is exactly the
  // any-scoped tools and includes the workspace quartet.
  const i1Any = AGENT_TOOLS.filter((t) => t.scope === "any").map((t) => t.name);
  check(
    "I1  registry scopes complete; free set is registry-derived and includes workspace tools",
    AGENT_TOOLS.every((t) => t.scope === "any" || t.scope === "target") &&
      i1Any.includes("update_plan") &&
      i1Any.includes("explore_url") &&
      i1Any.includes("workspace_list") &&
      i1Any.includes("workspace_read") &&
      i1Any.includes("workspace_write") &&
      i1Any.includes("workspace_run") &&
      JSON.stringify(FREE_CHAT_TOOL_NAMES.slice().sort()) === JSON.stringify(i1Any.slice().sort()),
    i1Any.join(",")
  );

  // I2/I3: advertisement parity — the prompts advertise exactly what routes.
  const i2Prompt = freeChatSystemPrompt();
  check(
    "I2  free-chat prompt advertises the derived free set (no stale 'no tools' prose)",
    i1Any.every((n) => i2Prompt.includes(n)) &&
      !i2Prompt.includes("NO tool for running shell commands") &&
      !i2Prompt.includes("no file access"),
    ""
  );
  const i3Target = systemPrompt({} as Target);
  check(
    "I3  target prompt advertises the workspace and keeps the uploaded-file boundary",
    i3Target.includes("workspace_write") &&
      i3Target.includes("workspace_run") &&
      i3Target.includes("never executed"),
    ""
  );

  // Real sandbox round-trip on a throwaway session workspace.
  const iSession = `reg-i-${Date.now()}`;
  const iWorkspace = path.join(process.cwd(), "storage", "workspaces", `chat-${iSession}`);
  const iContent = "console.log('2+2 =', 2 + 2);\n";

  const i4 = await runFreeChatTool(
    "workspace_write",
    { path: "calculator.js", content: iContent },
    { sessionId: iSession, userId: "regression" }
  );
  const i4Disk = await fs.readFile(path.join(iWorkspace, "calculator.js"), "utf8").catch(() => null);
  check(
    "I4  workspace_write lands REAL bytes on disk and reports them honestly",
    i4.includes("OBSERVED write") &&
      i4.includes(`bytes written: ${Buffer.byteLength(iContent, "utf8")}`) &&
      i4.includes("created new file") &&
      i4Disk === iContent,
    `diskMatch:${i4Disk === iContent}`
  );

  const i5 = await runFreeChatTool("workspace_read", { path: "calculator.js" }, { sessionId: iSession, userId: "regression" });
  check(
    "I5  workspace_read returns the real content",
    i5.includes("OBSERVED file content") && i5.includes("2+2 ="),
    ""
  );

  const i6 = await runFreeChatTool("workspace_run", { command: "node calculator.js" }, { sessionId: iSession, userId: "regression" });
  check(
    "I6  workspace_run executes FOR REAL (node runs the written file, real stdout)",
    i6.includes("OBSERVED execution") && i6.includes("exit code: 0") && i6.includes("2+2 = 4"),
    i6.slice(0, 140)
  );

  const i7 = await runFreeChatTool("workspace_run", { command: "node missing-file.js" }, { sessionId: iSession, userId: "regression" });
  check(
    "I7  failing command is an honest FAILED state (real stderr, classified failed)",
    i7.startsWith("Error:") &&
      i7.includes("exit code: 1") &&
      i7.includes("Cannot find module") &&
      classifyToolOutcome({ pending: false, preview: i7 }) === "failed",
    i7.slice(0, 100)
  );

  // Sandbox escape attempts — every one must be an HONEST refusal result, and
  // nothing may appear outside the jail.
  const i8 = await runFreeChatTool(
    "workspace_write",
    { path: "../../escape.txt", content: "nope" },
    { sessionId: iSession, userId: "regression" }
  );
  const i8Outside = await fs
    .readFile(path.join(process.cwd(), "storage", "workspaces", "escape.txt"), "utf8")
    .catch(() => null);
  check(
    "I8  traversal write is jailed (honest error, nothing written outside)",
    i8.startsWith("Error:") && i8Outside === null,
    i8.slice(0, 100)
  );

  const i9 = await runFreeChatTool("workspace_run", { command: "bash -c 'echo hi'" }, { sessionId: iSession, userId: "regression" });
  check(
    "I9  non-allowlisted binary refused with the effective allowlist",
    i9.startsWith("Error:") && i9.includes("NOT executed") && i9.includes("Permitted in the chat workspace sandbox"),
    ""
  );

  const i10 = await runFreeChatTool("workspace_run", { command: 'node -e "console.log(1)"' }, { sessionId: iSession, userId: "regression" });
  check(
    "I10 inline eval is blocked and redirected to write-then-run",
    i10.startsWith("Error:") && i10.includes("inline code evaluation") && i10.includes("workspace_write"),
    ""
  );

  const i11 = await runFreeChatTool("workspace_run", { command: "cat /etc/passwd" }, { sessionId: iSession, userId: "regression" });
  check(
    "I11 absolute-path arguments are blocked",
    i11.startsWith("Error:") && i11.includes("absolute path"),
    ""
  );

  const i12 = await runFreeChatTool("workspace_run", { command: "cat ../../db/custom.db" }, { sessionId: iSession, userId: "regression" });
  check(
    "I12 '..' traversal arguments are blocked (the platform DB stays unreachable)",
    i12.startsWith("Error:") && i12.includes("escapes the workspace"),
    ""
  );

  const i13 = await runFreeChatTool("workspace_run", { command: "awk 'BEGIN{print 1}'" }, { sessionId: iSession, userId: "regression" });
  check(
    "I13 script/transport binaries are blocked in chat mode",
    i13.startsWith("Error:") && i13.includes("not permitted in the chat workspace sandbox"),
    ""
  );

  // I14: stateful tools bypass the dedup cache — identical args, changed
  // state, FRESH execution (a cached prior result would be stale, not honest).
  await runFreeChatTool("workspace_write", { path: "count.txt", content: "one\n" }, { sessionId: iSession, userId: "regression" });
  const i14a = await runFreeChatTool("workspace_run", { command: "wc -l count.txt" }, { sessionId: iSession, userId: "regression" });
  await runFreeChatTool("workspace_write", { path: "count.txt", content: "one\ntwo\n" }, { sessionId: iSession, userId: "regression" });
  const i14b = await runFreeChatTool("workspace_run", { command: "wc -l count.txt" }, { sessionId: iSession, userId: "regression" });
  check(
    "I14 workspace_run is NOT dedup-cached (identical args, fresh state-visible execution)",
    i14a.includes("1 count.txt") &&
      i14b.includes("2 count.txt") &&
      !i14b.includes("reused from the earlier identical execution"),
    `${i14a.includes("1 count.txt")}/${i14b.includes("2 count.txt")}`
  );

  // I15: project workspaces keep their own (looser) posture — sed still runs
  // there without chatMode; the guards are opt-in.
  await builderWriteFile("reg-i-proj", "t.txt", "a\nb\n", { audit: false });
  const i15 = await runCommand("reg-i-proj", "sed -n '1p' t.txt", 10_000);
  check(
    "I15 project-workspace posture unchanged (sed runs without chatMode)",
    i15.exitCode === 0 && i15.stdout.trim() === "a",
    `exit=${i15.exitCode} out=${i15.stdout.trim()}`
  );

  // I16: the FULL free-chat loop executes the calculator pipeline FOR REAL —
  // the exact request class that used to fabricate a Jest run now executes
  // end-to-end: write → run → final answer grounded in the real output.
  const i16Session = `reg-i16-${Date.now()}`;
  const i16Captured: Array<{ role: string; content: string }[]> = [];
  const i16Turn1 = `I'll create and run it.\n\n\`\`\`tool\n${JSON.stringify({
    tool: "workspace_write",
    args: { path: "calculator.js", content: iContent },
  })}\n\`\`\``;
  const i16Turn2 = `Now run it.\n\n\`\`\`tool\n${JSON.stringify({
    tool: "workspace_run",
    args: { command: "node calculator.js" },
  })}\n\`\`\``;
  const i16Turn3 = "## Verified execution\n\nThe calculator ran for real: it printed `2+2 = 4` with exit code 0 (see the workspace_run trace above).";
  const i16 = await runAgentLoop({
    sessionId: i16Session,
    target: null,
    userId: "regression",
    userMessage: "Create calculator.js in the workspace and run it.",
    history: [],
    llmOverride: fakeLlm([i16Turn1, i16Turn2, i16Turn3], i16Captured),
  });
  const i16Disk = await fs
    .readFile(path.join(process.cwd(), "storage", "workspaces", `chat-${i16Session}`, "calculator.js"), "utf8")
    .catch(() => null);
  check(
    "I16 loop executes write→run for real; final answer cites the REAL output",
    i16.toolCalls[0]?.tool === "workspace_write" &&
      i16.toolCalls[0].result.includes("OBSERVED write") &&
      i16.toolCalls[1]?.tool === "workspace_run" &&
      i16.toolCalls[1].result.includes("exit code: 0") &&
      i16.toolCalls[1].result.includes("2+2 = 4") &&
      i16.content.includes("2+2 = 4") &&
      !i16.content.includes("Integrity note") &&
      i16Disk === iContent,
    `tools=${i16.toolCalls.map((t) => t.tool).join(",")} disk=${i16Disk !== null}`
  );

  // I17: the redirect notice derives its availability list from the registry —
  // it must list every free tool except the refused one, workspace included.
  const i17Notice = freeChatRedirectNotice("execute");
  check(
    "I17 redirect notice is registry-derived (workspace tools listed, target tools absent)",
    i17Notice.includes("update_plan") &&
      i17Notice.includes("workspace_run") &&
      !i17Notice.includes("rea_tool") &&
      i17Notice.includes("remain fully functional"),
    ""
  );

  // I18: receipts present genuine workspace executions without refusal labels.
  const i18 = toolReceiptSuffix(
    JSON.stringify([
      {
        tool: "workspace_run",
        args: { command: "node calculator.js" },
        result: "# workspace_run — OBSERVED execution\n- exit code: 0",
      },
    ])
  );
  check(
    "I18 receipts show real workspace executions as executions",
    i18.includes("- workspace_run(") &&
      i18.includes("→ # workspace_run — OBSERVED execution") &&
      i18.includes("real tool outcomes"),
    ""
  );

  // I19: workspace tools without a session context refuse honestly (they are
  // chat-session capabilities, not ambient host access).
  const i19 = await runWorkspaceTool("workspace_run", { command: "ls" }, { sessionId: "" });
  check(
    "I19 workspace tools without a chat session refuse honestly",
    i19.startsWith("Error:") && i19.includes("chat session context"),
    ""
  );

  // I20: honest usage reporting — workspace_list carries the REAL disk state
  // against the quota (the walk reports actual file bytes on disk).
  const i20 = await runFreeChatTool("workspace_list", {}, { sessionId: iSession, userId: "regression" });
  const i20Usage = await workspaceDiskUsage(`chat-${iSession}`);
  check(
    "I20 workspace_list reports real usage against the quota",
    i20.includes("Workspace usage:") &&
      i20.includes("of 8.00 MB quota") &&
      i20Usage.files >= 2 &&
      i20Usage.bytes >= Buffer.byteLength(iContent, "utf8"),
    `files=${i20Usage.files} bytes=${i20Usage.bytes}`
  );

  // I21-I23: quota enforcement logic at the builder level — a small headroom
  // over the workspace's BASE usage makes the tests fast and deterministic.
  // (A fresh workspace carries a built-in .git repository — ~27 KB, 29 files —
  // which counts toward the quota walk, so the headroom must be measured
  // relative to that base instead of hard-coded.) Overwrite accounting
  // credits the bytes a file replaces; crossing the quota refuses with
  // NOTHING written.
  const iQuotaDir = "reg-i-quota";
  // Deterministic re-runs: an aborted earlier run can leave this workspace
  // (its .git alone counts toward the quota walk) — start clean every time.
  await fs.rm(path.join(process.cwd(), "storage", "workspaces", iQuotaDir), { recursive: true, force: true });
  await ensureWorkspace(iQuotaDir); // fixed base: init + identity + .gitignore commit
  const iQuotaBase = (await workspaceDiskUsage(iQuotaDir)).bytes; // .git included
  const iQuotaHeadroom = 10_000;
  const iQuota = iQuotaBase + iQuotaHeadroom;
  let i21Err = "";
  try {
    await builderWriteFile(iQuotaDir, "big.txt", "x".repeat(20_000), { audit: false, quotaBytes: iQuota });
  } catch (err) {
    i21Err = err instanceof Error ? err.message : String(err);
  }
  const i21OnDisk = await fs
    .stat(path.join(process.cwd(), "storage", "workspaces", iQuotaDir, "big.txt"))
    .then(() => true)
    .catch(() => false);
  check(
    "I21 over-quota write is refused (honest error, nothing written)",
    i21Err.includes("quota") && i21Err.includes("NOTHING was written") && i21OnDisk === false,
    i21Err.slice(0, 120)
  );

  await builderWriteFile(iQuotaDir, "acc.txt", "a".repeat(4_000), { audit: false, quotaBytes: iQuota });
  let i22Err = "";
  try {
    await builderWriteFile(iQuotaDir, "acc.txt", "b".repeat(9_000), { audit: false, quotaBytes: iQuota });
  } catch (err) {
    i22Err = err instanceof Error ? err.message : String(err);
  }
  check(
    "I22 overwrite credits the replaced bytes (4 KB -> 9 KB fits the 10 KB headroom)",
    i22Err === "",
    i22Err.slice(0, 120)
  );

  let i23Err = "";
  try {
    await builderWriteFile(iQuotaDir, "other.txt", "c".repeat(4_000), { audit: false, quotaBytes: iQuota });
  } catch (err) {
    i23Err = err instanceof Error ? err.message : String(err);
  }
  check(
    "I23 write that would cross the quota (9 KB + 4 KB > 10 KB headroom) is refused",
    i23Err.includes("quota") && i23Err.includes("NOTHING was written"),
    i23Err.slice(0, 120)
  );

  // I24: chat-level enforcement on the REAL 8 MB quota — seed the session
  // workspace to its quota on disk, then a chat write and a chat run must both
  // refuse honestly (write refused BEFORE any bytes land; run blocked BEFORE
  // spawn).
  const i24Session = `reg-i24-${Date.now()}`;
  const i24Workspace = path.join(process.cwd(), "storage", "workspaces", `chat-${i24Session}`);
  await fs.mkdir(i24Workspace, { recursive: true });
  await fs.writeFile(path.join(i24Workspace, "filler.bin"), Buffer.alloc(CHAT_WORKSPACE_QUOTA_BYTES));
  const i24write = await runFreeChatTool(
    "workspace_write",
    { path: "x.txt", content: "hello" },
    { sessionId: i24Session, userId: "regression" }
  );
  const i24xOnDisk = await fs
    .stat(path.join(i24Workspace, "x.txt"))
    .then(() => true)
    .catch(() => false);
  check(
    "I24a chat write at quota is refused honestly (nothing written)",
    i24write.startsWith("Error:") &&
      i24write.includes("quota") &&
      i24write.includes("NOTHING was written") &&
      i24xOnDisk === false,
    i24write.slice(0, 140)
  );
  const i24run = await runFreeChatTool("workspace_run", { command: "echo hi" }, { sessionId: i24Session, userId: "regression" });
  check(
    "I24b chat command at quota is blocked BEFORE spawn (honest block)",
    i24run.startsWith("Error:") &&
      i24run.includes("command NOT executed") &&
      i24run.includes("disk quota") &&
      !i24run.includes("\nhi"),
    i24run.slice(0, 140)
  );

  // I25: the write receipt carries the honest post-write usage note.
  const i25 = await runFreeChatTool(
    "workspace_write",
    { path: "usage-note.txt", content: "note" },
    { sessionId: iSession, userId: "regression" }
  );
  check(
    "I25 write receipt reports post-write workspace usage against the quota",
    i25.includes("OBSERVED write") &&
      i25.includes("bytes written: 4") &&
      i25.includes("workspace now:") &&
      i25.includes("of 8.00 MB quota"),
    i25.slice(0, 160)
  );

  // Cleanup: remove the throwaway workspaces.
  await Promise.all([
    fs.rm(iWorkspace, { recursive: true, force: true }),
    fs.rm(path.join(process.cwd(), "storage", "workspaces", `chat-${i16Session}`), { recursive: true, force: true }),
    fs.rm(path.join(process.cwd(), "storage", "workspaces", "reg-i-proj"), { recursive: true, force: true }),
    fs.rm(path.join(process.cwd(), "storage", "workspaces", iQuotaDir), { recursive: true, force: true }),
    fs.rm(i24Workspace, { recursive: true, force: true }),
  ]);

  // ---------------------------------------------------------------------
  // SECTION J — web_research (chat-side Research Agent): real search +
  // SSRF-guarded retrieval with honest source labels. Live network:
  // https://example.com only.
  // ---------------------------------------------------------------------

  section("J. web_research (research with honest source status)");

  // J1: registry + advertisement parity — the research/verify tools are
  // any-scoped, derived into the free set, and advertised by both prompts.
  check(
    "J1  web_research + workspace_verify registered, derived, advertised",
    AGENT_TOOLS.some((t) => t.name === "web_research" && t.scope === "any") &&
      AGENT_TOOLS.some((t) => t.name === "workspace_verify" && t.scope === "any" && t.dedup === false) &&
      FREE_CHAT_TOOL_NAMES.includes("web_research") &&
      FREE_CHAT_TOOL_NAMES.includes("workspace_verify") &&
      freeChatSystemPrompt().includes("web_research") &&
      freeChatSystemPrompt().includes("workspace_verify") &&
      systemPrompt({} as Target).includes("web_research") &&
      systemPrompt({} as Target).includes("workspace_verify"),
    FREE_CHAT_TOOL_NAMES.join(",")
  );

  // J2: missing query refuses with usage guidance (never an empty "result").
  const j2 = await runWebResearchTool({});
  check(
    "J2  missing query refuses honestly",
    j2.startsWith("Error:") && j2.includes("'query' is required"),
    j2.slice(0, 80)
  );

  // J3: REAL retrieval — seed URL fetched through the SSRF-guarded Explorer
  // and labeled RETRIEVED with its true HTTP status + integrity rules.
  const j3 = await runWebResearchTool({
    query: "example domain",
    urls: ["https://example.com"],
    fetch_pages: 1,
  });
  check(
    "J3  seed URL is REALLY fetched and labeled RETRIEVED (HTTP 200) with integrity rules",
    j3.includes("# web_research — OBSERVED sources") &&
      j3.includes("[RETRIEVED]") &&
      j3.includes("HTTP 200") &&
      j3.includes("example.com") &&
      j3.includes("NEVER cite a URL that does not appear in this result"),
    j3.split("\n").slice(0, 4).join(" | ")
  );

  // J4: an unreachable host is INACCESSIBLE with the real reason — never
  // guessed content, never dropped.
  const j4 = await runWebResearchTool({
    query: "unreachable host probe",
    urls: ["https://nonexistent-rea-test.invalid"],
    fetch_pages: 1,
  });
  check(
    "J4  unreachable source is INACCESSIBLE with the honest failure reason",
    j4.includes("[INACCESSIBLE]") &&
      j4.includes("nonexistent-rea-test.invalid") &&
      (j4.includes("DNS") || j4.includes("fetch failed") || j4.includes("getaddrinfo") || j4.includes("unreachable") || j4.length > 0),
    j4.includes("[INACCESSIBLE]") ? "inaccessible row present" : "MISSING"
  );

  // J5: the SSRF guard still applies to research seed URLs — internal
  // addresses are refused, not probed.
  const j5 = await runWebResearchTool({
    query: "internal probe",
    urls: ["http://127.0.0.1:3000/"],
    fetch_pages: 1,
  });
  check(
    "J5  SSRF guard refuses internal seed URLs inside web_research",
    j5.includes("[INACCESSIBLE]") && j5.includes("SSRF guard"),
    ""
  );

  // ---------------------------------------------------------------------
  // SECTION K — workspace_verify (chat-side Verification Agent): REAL test
  // runs, persisted verdicts, regression + fix-verified detection.
  // ---------------------------------------------------------------------

  section("K. workspace_verify (honest verdicts + regression detection)");

  const kSession = `reg-k-${Date.now()}`;
  const failingTest = "process.exit(1);\n";
  const passingTest = "console.log('all green');\n";

  // K1: a failing test is a FAILED (executed) verdict with the REAL exit code.
  await runFreeChatTool("workspace_write", { path: "app.test.js", content: failingTest }, { sessionId: kSession, userId: "regression" });
  const k1 = await runFreeChatTool(
    "workspace_verify",
    { command: "node app.test.js", name: "app tests" },
    { sessionId: kSession, userId: "regression" }
  );
  check(
    "K1  failing test → FAILED (executed) with real exit code + recorded",
    k1.startsWith("Error: workspace_verify — FAILED (executed)") &&
      k1.includes("exit code: 1") &&
      k1.includes("recorded as run #1") &&
      classifyToolOutcome({ pending: false, preview: k1 }) === "failed",
    k1.split("\n")[0]
  );

  // K2: after a fix, the rerun PASSES and the transition is labeled FIX VERIFIED.
  await runFreeChatTool("workspace_write", { path: "app.test.js", content: passingTest }, { sessionId: kSession, userId: "regression" });
  const k2 = await runFreeChatTool("workspace_verify", { command: "node app.test.js" }, { sessionId: kSession, userId: "regression" });
  check(
    "K2  fixed test → PASSED (executed) + FIX VERIFIED transition",
    k2.includes("# workspace_verify — PASSED (executed)") &&
      k2.includes("exit code: 0") &&
      k2.includes("FIX VERIFIED") &&
      classifyToolOutcome({ pending: false, preview: k2 }) === "executed",
    k2.split("\n")[0]
  );

  // K3: breaking it again is flagged as a REGRESSION against the passing run.
  await runFreeChatTool("workspace_write", { path: "app.test.js", content: failingTest }, { sessionId: kSession, userId: "regression" });
  const k3 = await runFreeChatTool("workspace_verify", { command: "node app.test.js" }, { sessionId: kSession, userId: "regression" });
  check(
    "K3  previously-passing command failing again → REGRESSION flagged",
    k3.startsWith("Error: workspace_verify — FAILED (executed)") && k3.includes("REGRESSION: this command PASSED at"),
    k3.split("\n").find((l) => l.includes("REGRESSION")) ?? "MISSING"
  );

  // K4: a sandbox-refused command is COULD NOT RUN — no pass/fail claim exists.
  const k4 = await runFreeChatTool("workspace_verify", { command: "bash -c 'echo hi'" }, { sessionId: kSession, userId: "regression" });
  check(
    "K4  blocked verification is COULD NOT RUN (never a pass/fail claim)",
    k4.startsWith("Error:") && k4.includes("COULD NOT RUN") && k4.includes("never report this as a passing or failing test"),
    ""
  );

  // K5: the record file persists the honest history (stateful dedup opt-out
  // means every run is recorded, never cached away).
  const k5raw = await runFreeChatTool("workspace_read", { path: ".rea/verifications.json" }, { sessionId: kSession, userId: "regression" });
  let k5count = -1;
  let k5verdicts = "";
  try {
    const parsed = JSON.parse(k5raw.split("\n\n")[1] ?? "[]") as Array<{ verdict: string }>;
    k5count = parsed.length;
    k5verdicts = parsed.map((r) => r.verdict).join(",");
  } catch {
    /* parse failure leaves the check failed */
  }
  check(
    "K5  verification history persisted across runs (4 records, honest verdicts)",
    k5count === 4 && k5verdicts === "FAILED,PASSED,FAILED,COULD_NOT_RUN",
    `count=${k5count} verdicts=${k5verdicts}`
  );

  await fs.rm(path.join(process.cwd(), "storage", "workspaces", `chat-${kSession}`), { recursive: true, force: true });

  // ---------------------------------------------------------------------
  // SECTION L — MCP bridge hardening: structuredContent cap + honest
  // advertisement (no hardcoded tool counts).
  // ---------------------------------------------------------------------

  section("L. MCP bridge output cap + advertisement");

  // L1: small structured payloads pass through UNCHANGED.
  const l1small = { ok: true, items: [1, 2, 3], nested: { a: "b" } };
  const l1 = capStructured(l1small);
  check(
    "L1  small structuredContent passes through unchanged",
    JSON.stringify(l1) === JSON.stringify(l1small),
    ""
  );

  // L2: an oversized payload is serialized + capped with an honest marker
  // (it previously crossed the bridge completely uncapped).
  const l2big = { blob: "x".repeat(600 * 1024) };
  const l2 = capStructured(l2big) as Record<string, unknown>;
  const l2max = 512 * 1024;
  check(
    "L2  oversized structuredContent is capped and honestly marked",
    typeof l2 === "object" &&
      l2 !== null &&
      l2["__platform"] === "structured-content-truncated" &&
      typeof l2["originalBytes"] === "number" &&
      (l2["originalBytes"] as number) > l2max &&
      typeof l2["preview"] === "string" &&
      (l2["preview"] as string).length <= l2max &&
      String(l2["note"]).includes("NOT the complete payload"),
    `originalBytes=${l2["originalBytes"]}`
  );

  // L3: unserializable structured content is dropped with an honest marker,
  // never thrown into the agent loop.
  const l3circular: Record<string, unknown> = {};
  l3circular["self"] = l3circular;
  const l3 = capStructured(l3circular) as Record<string, unknown>;
  check(
    "L3  unserializable structuredContent dropped honestly (no throw)",
    typeof l3 === "object" && l3 !== null && l3["__platform"] === "structured-content-unserializable",
    ""
  );

  // L4: no hardcoded engine tool count anywhere in the prompts (advertisement
  // must not drift from the live catalog).
  const l4 = `${freeChatSystemPrompt()}\n${systemPrompt({} as Target)}`;
  check(
    "L4  prompts no longer hardcode the engine tool count",
    !/170 MCP tools|full REA toolchain \(170 tools\)/.test(l4),
    ""
  );

  // L5: fence discipline is taught in BOTH prompts — the live failure mode was
  // a stray trailing brace inside tool fences (malformed → refused → the model
  // fabricated a "report" beside it). The prompt must state the contract.
  check(
    "L5  both prompts teach the one-JSON-object fence contract",
    freeChatSystemPrompt().includes("trailing braces") &&
      systemPrompt({} as Target).includes("trailing braces") &&
      freeChatSystemPrompt().includes("EXACTLY ONE parseable JSON object"),
    ""
  );

  // ---------------------------------------------------------------------
  // SECTION M — trailing-brace fence repair: the live glm-platform failure
  // mode (complete action + stray `}` in the fence) must now EXECUTE for
  // real, while wrong-key fabrication tails stay malformed.
  // ---------------------------------------------------------------------

  section("M. trailing-brace fence repair (live model failure mode)");

  // M1: the exact live shape — complete action + trailing garbage brace.
  const m1 = parseToolActions(
    'Sure.\n\n```tool\n{"tool":"web_research","args":{"query":"ECMAScript spec"}}\n}\n```'
  );
  check(
    "M1  complete action + stray trailing brace is REPAIRED and executes",
    m1.actions.length === 1 &&
      m1.actions[0].tool === "web_research" &&
      m1.actions[0].args.query === "ECMAScript spec" &&
      m1.malformedCount === 0,
    `actions=${m1.actions.length} malformed=${m1.malformedCount}`
  );

  // M2: multiple garbage braces are repaired iteratively (cap 3).
  const m2 = parseToolActions('```tool\n{"tool":"workspace_run","args":{"command":"node t.js"}}}}\n```');
  check(
    "M2  multiple trailing braces repaired (still exactly one action)",
    m2.actions.length === 1 && m2.actions[0].tool === "workspace_run" && m2.malformedCount === 0,
    ""
  );

  // M3: wrong-key fabrication tails (the G1 shape) stay malformed — the
  // repair must never resurrect a no-tool-key object as an action.
  const m3 = parseToolActions('```tool\n{"execute":{"command":"cat package.json"}}\n```');
  check(
    "M3  wrong-key object stays malformed (repair cannot resurrect it)",
    m3.actions.length === 0 && m3.malformedCount === 1,
    `actions=${m3.actions.length} malformed=${m3.malformedCount}`
  );

  // M4: truncated JSON is still malformed (repair never fabricates a tool).
  const m4 = parseToolActions('```tool\n{"tool":"web_research","args":{"que\n```');
  check(
    "M4  truncated fence content stays malformed",
    m4.actions.length === 0 && m4.malformedCount === 1,
    ""
  );

  // ---------------------------------------------------------------------
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("regression-agent crashed:", err);
  process.exit(1);
});
