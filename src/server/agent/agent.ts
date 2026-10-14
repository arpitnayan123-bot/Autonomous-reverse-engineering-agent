import { db } from "@/lib/db";
import { MAX_CHAT_ITERATIONS } from "@/lib/security";
import { documentationPrompt, freeChatSystemPrompt, systemPrompt } from "./prompts";
import { buildTargetContext, executeAgentTool, applyPlanUpdate, runExploreUrlTool, TOOL_RESULT_MAX_CHARS, type AgentToolContext } from "./tools";
import {
  resolveLlmForUser,
  type LlmMessage,
  type ResolvedLlm,
  type TokenUsage,
} from "./providers";
import type { Evidence, Finding, Target } from "@prisma/client";

/**
 * REA investigation agent — ReAct loop.
 *
 * The LLM interface is plain text (works across OpenAI, Anthropic, Gemini,
 * DeepSeek, Kimi, GLM and the platform fallback): each model turn must either
 * produce the final markdown answer or emit exactly one ```tool {json} ```
 * action block. The block is parsed (LAST one wins), executed server-side,
 * and the truncated result is fed back as a user message until
 * MAX_CHAT_ITERATIONS is exhausted.
 */

export type { LlmMessage };

type ChatRole = "user" | "assistant";
interface LoopMessage {
  role: ChatRole;
  content: string;
}

export interface AgentEventHandlers {
  onToolCall?: (tool: string, args: Record<string, unknown>) => void;
  onToolResult?: (tool: string, result: string) => void;
  /** Called when the LLM source is resolved (for SSE surfacing). */
  onModelResolved?: (info: { source: string; provider: string; model: string }) => void;
  /** A new LLM turn began (0-based). Lets the client reset its draft buffer. */
  onTurnStart?: (turn: number) => void;
  /** Incremental assistant text for the live-typing effect. */
  onAssistantDelta?: (text: string, turn: number) => void;
  /** Cooperative cancellation: checked between iterations. */
  shouldCancel?: () => boolean;
}

export interface AgentToolTrace {
  tool: string;
  args: Record<string, unknown>;
  result: string;
}

export interface AgentLoopResult {
  content: string;
  toolCalls: AgentToolTrace[];
  /** Cumulative provider-reported token usage for the whole turn (null = unknown). */
  usage: { tokensIn: number | null; tokensOut: number | null };
  /** Wall-clock duration of the whole agent turn in ms. */
  durationMs: number;
  /**
   * Canonical model id that produced this turn ("openai/gpt-4o-mini" for
   * BYOK, "glm-platform" for the platform fallback) — persisted per row so
   * history keeps the true per-turn model even after the provider changes.
   */
  modelId: string;
}

// ---------------------------------------------------------------------------
// LLM access — resolved per user (BYOK provider or platform fallback)
// ---------------------------------------------------------------------------

export { resolveLlmForUser } from "./providers";

// ---------------------------------------------------------------------------
// Action-block parsing
// ---------------------------------------------------------------------------

/**
 * Tool-block grammar. Tolerant on FENCE SPELLING (a classic silent failure:
 * "``` tool" with a space, "```TOOL" upper-case, ~~~ fences, or a block the
 * model forgot to close were all parsed as prose, so the intended tool call
 * degraded into the visible answer and the loop ended without executing
 * anything — the model then "answered conceptually" on the next turn).
 * The backreference keeps opener/closer fence tokens consistent.
 */
const TOOL_BLOCK_RE = /(```|~~~)[ \t]*tool[ \t]*\r?\n([\s\S]*?)\1/gi;
/** Opener-only pattern for the unterminated-block fallback. */
const TOOL_OPEN_RE = /(?:```|~~~)[ \t]*tool[ \t]*\r?\n/gi;

/**
 * Detect TRANSIENT provider/infrastructure failures worth an automatic
 * retry: rate limits, upstream overload, timeouts, broken sockets.
 * Auth rejections (401/403) and malformed requests (400) are deliberately
 * NOT retried — they need a human (or the credential self-heal in
 * platform-llm.ts), not a blind loop.
 */
export function isTransientLlmError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  return /\b(429|500|502|503|504)\b|rate[ _-]?limit|too many requests|overloaded|temporarily unavailable|timeout|timed out|econnreset|econnrefused|epipe|socket hang up|network|fetch failed/.test(
    msg
  );
}

/** Bounded exponential backoff between turn retries (ms). */
const TURN_RETRY_BACKOFF_MS = [900, 2200];

export function parseToolAction(
  text: string
): { tool: string; args: Record<string, unknown> } | null {
  // 1) LAST properly closed block wins.
  const re = new RegExp(TOOL_BLOCK_RE.source, "gi"); // fresh lastIndex
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) last = m;
  let body = last?.[2];
  // 2) Fallback: an opener with NO closed block anywhere — the model forgot
  //    the closing fence. Take the tail and require it to parse as valid JSON
  //    below, so explanatory prose never executes; only a well-formed
  //    {tool,args} object does (same safety bar as a closed block).
  if (body === undefined) {
    const open = new RegExp(TOOL_OPEN_RE.source, "gi");
    let lastOpen: RegExpExecArray | null = null;
    let om: RegExpExecArray | null;
    while ((om = open.exec(text)) !== null) lastOpen = om;
    if (lastOpen) body = text.slice(lastOpen.index + lastOpen[0].length);
  }
  if (body === undefined) return null;
  try {
    const parsed = JSON.parse(body.trim()) as {
      tool?: unknown;
      args?: unknown;
    };
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.tool === "string" &&
      parsed.tool.trim()
    ) {
      const args =
        parsed.args && typeof parsed.args === "object" && !Array.isArray(parsed.args)
          ? (parsed.args as Record<string, unknown>)
          : {};
      return { tool: parsed.tool.trim(), args };
    }
    return null; // malformed block → treat whole message as final answer
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cross-turn tool receipts — prove to later turns that tools REALLY run here
// ---------------------------------------------------------------------------

const RECEIPT_MAX_TOOLS = 5;
const RECEIPT_ARG_CHARS = 120;
const RECEIPT_RESULT_CHARS = 160;

/**
 * Compact receipt appended to a PAST assistant message when it is replayed
 * as history. The loop never persists tool traffic into the visible
 * transcript, so on later turns the model otherwise sees a conversation in
 * which tools never executed — a proven trigger for "I cannot access tools"
 * refusals even right after a successful tool call. The receipt is plainly
 * labeled as system-injected context (NOT model output) and tightly bounded.
 */
export function toolReceiptSuffix(raw: string | null | undefined): string {
  if (!raw) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  if (!Array.isArray(parsed)) return "";
  const lines: string[] = [];
  for (const t of parsed.slice(0, RECEIPT_MAX_TOOLS)) {
    if (!t || typeof t !== "object") continue;
    const tool = (t as { tool?: unknown }).tool;
    if (typeof tool !== "string" || !tool) continue;
    const args = JSON.stringify((t as { args?: unknown }).args ?? {}).slice(
      0,
      RECEIPT_ARG_CHARS
    );
    const result = String((t as { result?: unknown }).result ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, RECEIPT_RESULT_CHARS);
    lines.push(
      `- ${tool}(${args}) → ${result}${result.length >= RECEIPT_RESULT_CHARS ? "…" : ""}`
    );
  }
  if (lines.length === 0) return "";
  return (
    "\n\n[SYSTEM receipt — the platform genuinely executed these tools during the turn above; tool execution works in this conversation:]\n" +
    lines.join("\n")
  );
}

/**
 * Feedback for a free-chat turn that emitted a file-bound tool block. The
 * previous wording ("Do not emit tool blocks here") read as a blanket tool
 * ban: after ONE disallowed call the model stopped invoking even the tools
 * that DO work (update_plan, explore_url) and told users it had no tool
 * access. This wording scopes the refusal to THAT tool and re-asserts what
 * remains available.
 */
export function freeChatRedirectNotice(tool: string): string {
  return (
    `SYSTEM: Tool "${tool}" operates on an uploaded file target, which this chat does not have — so THAT tool specifically is unavailable here. ` +
    `This does NOT mean tools are unavailable in general: update_plan and explore_url remain fully functional in this chat and must be used when they help ` +
    `(explore_url fetches any public URL the user asks about). ` +
    `Do not re-emit "${tool}". For the user's request, either use one of those tools or answer directly; if real file analysis is essential, tell the user to upload the file in the sidebar (Files → upload) and start a chat on it.`
  );
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export async function runAgentLoop(opts: {
  sessionId: string;
  /** null → FREE chat: no file attached, no tools, general RE copilot. */
  target: Target | null;
  userId: string;
  userMessage: string;
  history: LoopMessage[];
  events?: AgentEventHandlers;
  /** Aborted when the client disconnects — ends hung LLM calls promptly. */
  signal?: AbortSignal;
}): Promise<AgentLoopResult> {
  const { sessionId, target, userMessage, history, events } = opts;
  const ctx: AgentToolContext | null = target
    ? { target, userId: opts.userId }
    : null;

  let llm: ResolvedLlm;
  try {
    llm = await resolveLlmForUser(opts.userId);
  } catch (err) {
    throw err instanceof Error
      ? err
      : new Error("Failed to resolve an AI model for this account");
  }
  events?.onModelResolved?.({
    source: llm.source,
    provider: llm.provider,
    model: llm.model,
  });

  const messages: LlmMessage[] = target
    ? [
        { role: "assistant", content: systemPrompt(target) },
        { role: "user", content: await buildTargetContext(target) },
        ...history,
        { role: "user", content: userMessage },
      ]
    : [
        { role: "assistant", content: freeChatSystemPrompt() },
        ...history,
        { role: "user", content: userMessage },
      ];

  const toolTrace: AgentToolTrace[] = [];
  /** How many times each exact tool call (name + args) ran this turn. */
  const repeatCounts = new Map<string, number>();
  /** Non-null → the loop must stop and force a synthesis turn (with reason). */
  let haltReason: string | null = null;
  let final: string | null = null;
  /** Cumulative usage across every LLM call of this turn. */
  const usage: { tokensIn: number | null; tokensOut: number | null } = {
    tokensIn: null,
    tokensOut: null,
  };
  const accumulateUsage = (u: TokenUsage) => {
    if (typeof u.promptTokens === "number") {
      usage.tokensIn = (usage.tokensIn ?? 0) + u.promptTokens;
    }
    if (typeof u.completionTokens === "number") {
      usage.tokensOut = (usage.tokensOut ?? 0) + u.completionTokens;
    }
  };
  const callOpts: { onUsage: (u: TokenUsage) => void; signal?: AbortSignal } = {
    onUsage: accumulateUsage,
    signal: opts.signal,
  };
  const startedAt = Date.now();

  for (let i = 0; i < MAX_CHAT_ITERATIONS; i++) {
    if (events?.shouldCancel?.()) {
      final = "**Investigation cancelled by user.** No further tools were run after cancellation; any findings above are partial.";
      break;
    }
    events?.onTurnStart?.(i);
    const text = await callTurn(llm, messages, i, events, callOpts);
    const action = parseToolAction(text);
    if (!action) {
      final = text;
      break;
    }
    if (!ctx) {
      // Free chat: file-bound tools are unavailable — EXCEPT update_plan (pure
      // planning, no I/O) and explore_url (SSRF-guarded public web fetch, no
      // target context needed). Both stay fully functional so URL analysis and
      // long multi-step guidance still execute for real instead of being
      // answered conceptually.
      if (action.tool === "update_plan") {
        events?.onToolCall?.(action.tool, action.args);
        const result = await applyPlanUpdate(action.args);
        events?.onToolResult?.(action.tool, result);
        toolTrace.push({ tool: action.tool, args: action.args, result });
        messages.push({ role: "assistant", content: text });
        messages.push({
          role: "user",
          content: `TOOL RESULT for ${action.tool}:\n${result}`,
        });
        continue;
      }
      if (action.tool === "explore_url") {
        events?.onToolCall?.(action.tool, action.args);
        const result = await runExploreUrlTool(action.args ?? {});
        events?.onToolResult?.(action.tool, result);
        toolTrace.push({ tool: action.tool, args: action.args, result });
        messages.push({ role: "assistant", content: text });
        messages.push({
          role: "user",
          content: `TOOL RESULT for ${action.tool}:\n${result.slice(0, TOOL_RESULT_MAX_CHARS)}`,
        });
        continue;
      }
      // The model emitted a file-bound tool block despite the system prompt.
      // Redirect once per occurrence with SCOPED wording (never a blanket
      // "no tools" message — that taught models to deny tool access); the
      // iteration budget still bounds it.
      messages.push({ role: "assistant", content: text });
      messages.push({ role: "user", content: freeChatRedirectNotice(action.tool) });
      continue;
    }
    events?.onToolCall?.(action.tool, action.args);
    const result = await executeAgentTool(action.tool, action.args, ctx);
    events?.onToolResult?.(action.tool, result);
    toolTrace.push({ tool: action.tool, args: action.args, result });

    // ---- Loop guard: identical call fired repeatedly ---------------------
    // A classic agent failure mode: the model re-runs the exact same tool
    // with the exact same args, expecting a different answer. Nudge it back
    // on course after the 2nd repeat; hard-stop into synthesis after the 3rd
    // (the evidence will not change — burning the whole iteration budget on
    // it helps nobody).
    const sig = `${action.tool}:${JSON.stringify(action.args)}`;
    const repeats = (repeatCounts.get(sig) ?? 0) + 1;
    repeatCounts.set(sig, repeats);
    if (repeats >= 3) {
      // Stop iterating — the evidence cannot change. A REAL synthesis turn
      // still runs below, so the analyst gets a proper answer, not a canned
      // error string.
      haltReason = `The tool call ${action.tool} was repeated ${repeats} times with identical arguments.`;
      break;
    }

    messages.push({ role: "assistant", content: text });
    messages.push({
      role: "user",
      content: `TOOL RESULT for ${action.tool}:\n${result.slice(0, 6000)}${
        repeats === 2
          ? `\n\nSYSTEM: You already ran this exact call (${action.tool} with identical arguments) ${repeats} times in this turn. The result will not change on another run. Either vary the arguments, choose a DIFFERENT tool, or write your final answer from the evidence you have.`
          : ""
      }`,
    });
  }

  if (final === null) {
    // Iteration budget exhausted (or the loop guard halted repetition):
    // force a synthesis turn with no tools.
    const synthesisTurn = MAX_CHAT_ITERATIONS;
    events?.onTurnStart?.(synthesisTurn);
    messages.push({
      role: "user",
      content: haltReason
        ? `Do not emit any more tool blocks. ${haltReason} Repetition cannot produce new evidence. Synthesize all OBSERVED / DERIVED / INFERRED evidence gathered so far into your final markdown answer now, and state clearly what remains unknown and which different tool or argument you would try next.`
        : `You have used the maximum number of tool iterations (${MAX_CHAT_ITERATIONS}). Do not emit any more tool blocks. Synthesize all OBSERVED / DERIVED / INFERRED evidence gathered so far into your final markdown answer now, and state clearly what remains unknown.`,
    });
    final = await callTurn(llm, messages, synthesisTurn, events, callOpts);
  }

  const durationMs = Date.now() - startedAt;

  try {
    await db.chatMessage.create({
      data: {
        sessionId,
        role: "assistant",
        content: final,
        toolCalls: toolTrace.length ? JSON.stringify(toolTrace) : null,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        durationMs,
        modelId: llmModelId(llm),
      },
    });
  } catch {
    /* persistence failure must not break the stream */
  }

  return { content: final, toolCalls: toolTrace, usage, durationMs, modelId: llmModelId(llm) };
}

/** Canonical per-turn model id: "openai/gpt-4o-mini" (BYOK) or "glm-platform". */
function llmModelId(llm: ResolvedLlm): string {
  if (llm.source === "platform" || llm.provider === llm.model) return llm.model;
  return `${llm.provider}/${llm.model}`;
}

/**
 * One LLM turn — streamed when the resolved provider supports it (falling
 * back to a single-shot call whose text is emitted as one delta).
 *
 * Error recovery: transient provider failures (rate limits, 5xx, network
 * resets) are retried with a short exponential backoff BEFORE any delta has
 * reached the client (a retry after partial output would duplicate text).
 * Once deltas flowed, a failed stream falls back to the single-shot call as
 * before; the final content always replaces the client draft, so recovery
 * stays consistent. Cancellation is honored at every step and never retried.
 */
async function callTurn(
  llm: ResolvedLlm,
  messages: LlmMessage[],
  turn: number,
  events?: AgentEventHandlers,
  callOpts?: { onUsage?: (u: TokenUsage) => void; signal?: AbortSignal }
): Promise<string> {
  let emitted = false;
  const sink = (delta: string) => {
    emitted = true;
    events?.onAssistantDelta?.(delta, turn);
  };

  if (llm.callLLMStream) {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= TURN_RETRY_BACKOFF_MS.length; attempt++) {
      try {
        return await llm.callLLMStream(messages, sink, callOpts);
      } catch (err) {
        lastErr = err;
        const aborted =
          callOpts?.signal?.aborted ||
          (err instanceof Error && err.name === "TurnAbortedError");
        if (aborted) throw err; // a cancelled turn is never retried
        // Deltas already reached the client, the failure is not transient, or
        // the retry budget is spent → hand over to the single-shot fallback.
        if (
          emitted ||
          !isTransientLlmError(err) ||
          attempt === TURN_RETRY_BACKOFF_MS.length
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, TURN_RETRY_BACKOFF_MS[attempt]));
      }
    }
    console.error(
      "agent stream turn failed, retrying non-streamed:",
      lastErr instanceof Error ? lastErr.message : lastErr
    );
  }

  // Single-shot path (also the recovery path for a failed stream).
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= TURN_RETRY_BACKOFF_MS.length; attempt++) {
    try {
      const text = await llm.callLLM(messages, callOpts);
      sink(text);
      return text;
    } catch (err) {
      lastErr = err;
      const aborted =
        callOpts?.signal?.aborted ||
        (err instanceof Error && err.name === "TurnAbortedError");
      if (aborted) throw err;
      if (!isTransientLlmError(err) || attempt === TURN_RETRY_BACKOFF_MS.length) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, TURN_RETRY_BACKOFF_MS[attempt]));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------------------------------------------------------------------------
// Documentation generator (single completion)
// ---------------------------------------------------------------------------

const DOCS_SEPARATOR = "===DOCS===";

export async function generateDocumentation(
  targetId: string,
  userId: string
): Promise<{ docs: string; summary: string }> {
  const target = await db.target.findUnique({ where: { id: targetId } });
  if (!target || target.userId !== userId) {
    throw new Error("Target not found or not owned by you");
  }

  const [findings, evidence] = await Promise.all([
    db.finding.findMany({
      where: { run: { targetId } },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    db.evidence.findMany({
      where: { run: { targetId } },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
  ]);

  const messages: LlmMessage[] = [
    {
      role: "assistant",
      content: documentationPrompt(target, findings as Finding[], evidence as Evidence[]),
    },
    {
      role: "user",
      content: `Generate the reverse-engineering documentation for "${target.originalName}" now, following the strict response format.`,
    },
  ];

  const llm = await resolveLlmForUser(userId);
  const raw = await llm.callLLM(messages);
  const sepIdx = raw.indexOf(DOCS_SEPARATOR);
  let summary: string;
  let docs: string;
  if (sepIdx >= 0) {
    summary = raw.slice(0, sepIdx).trim().slice(0, 1000);
    docs = raw.slice(sepIdx + DOCS_SEPARATOR.length).trim();
  } else {
    // Fallback: derive a summary from the first non-empty line.
    const firstLine = raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    summary = (firstLine ?? `Documentation for ${target.originalName}`).slice(0, 1000);
    docs = raw.trim();
  }
  if (!docs) docs = raw.trim() || "Documentation generation produced no content.";

  await db.target.update({
    where: { id: targetId },
    data: { docs, summary, docsAt: new Date() },
  });

  return { docs, summary };
}
