import { db } from "@/lib/db";
import { MAX_CHAT_ITERATIONS } from "@/lib/security";
import { documentationPrompt, freeChatSystemPrompt, systemPrompt } from "./prompts";
import { buildTargetContext, executeAgentTool, runFreeChatTool, runToolWithDedup, TOOL_RESULT_MAX_CHARS, TOOL_REFUSAL_MARKER, AGENT_TOOLS, FREE_CHAT_TOOL_NAMES, type AgentToolContext } from "./tools";
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
  /**
   * Human-readable reason when shouldCancel() turned true (user stop,
   * safety deadline). Surfaced in the persisted interrupted-turn note so the
   * transcript records WHY instead of a generic cancellation.
   */
  cancellationReason?: () => string | null;
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

/**
 * Max tool blocks executed per model message. The response protocol says ONE
 * block per message; models occasionally emit several. Every block up to the
 * cap gets an honest outcome (executed / refused / traced), the remainder is
 * reported back as skipped — a message full of tool intents is never silently
 * reduced to one (or zero) actions, and per-iteration tool runtime stays
 * bounded (each tool caps at CHAT_TOOL_TIMEOUT_MS).
 */
const MAX_TOOL_BLOCKS_PER_MESSAGE = 4;

/**
 * Tools the model may route in a FREE chat — DERIVED from the registry
 * scope flags (imported from tools.ts): update_plan, explore_url and the
 * four sandboxed workspace tools. Advertisement (prompts), routing (this
 * loop) and refusals all read the same list — drift is impossible.
 */
const FREE_CHAT_TOOL_SET = new Set(FREE_CHAT_TOOL_NAMES);

function availableToolNames(ctx: AgentToolContext | null): string[] {
  return ctx ? AGENT_TOOLS.map((t) => t.name) : FREE_CHAT_TOOL_NAMES;
}

export interface ParsedToolBlock {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolBlockParse {
  /** Valid actions in message order (closed blocks; the unterminated tail
   * only when no closed block yields a valid action — same priority as the
   * single-action parser always had). */
  actions: ParsedToolBlock[];
  /** Tool fences that exist but are NOT routable actions (invalid JSON, or a
   * JSON object without a non-empty "tool" key). */
  malformedCount: number;
  /** True when the text contains at least one tool-fence opener (valid,
   * malformed, or unterminated). */
  hasToolFences: boolean;
}

function tryParseAction(body: string): ParsedToolBlock | null {
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
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse EVERY tool block in a model message.
 *
 * Failure this replaces: the single-action parser took the LAST closed block
 * and returned null when THAT block was not a valid {tool,args} action — so a
 * message containing many valid tool intents plus one malformed tail block
 * (or a fabricated "execute" call) was silently reclassified as a FINAL
 * ANSWER. Nothing executed, nothing was refused, no trace was written, and
 * the fabricated success narrative around the blocks streamed to the user as
 * the turn's answer (the real calculator/Jest fabrication incident). The
 * plural parser surfaces every intent so the loop can give each one an
 * honest outcome.
 */
export function parseToolActions(text: string): ToolBlockParse {
  const actions: ParsedToolBlock[] = [];
  let malformedCount = 0;
  const closed = new RegExp(TOOL_BLOCK_RE.source, "gi"); // fresh lastIndex
  let m: RegExpExecArray | null;
  while ((m = closed.exec(text)) !== null) {
    const parsed = tryParseAction(m[2]);
    if (parsed) actions.push(parsed);
    else malformedCount++;
  }
  if (actions.length === 0) {
    // Unterminated-block fallback — same priority as before: only when no
    // closed block produced a valid action. The tail must parse as a valid
    // action object, so explanatory prose never executes.
    const open = new RegExp(TOOL_OPEN_RE.source, "gi");
    let lastOpen: RegExpExecArray | null = null;
    let om: RegExpExecArray | null;
    while ((om = open.exec(text)) !== null) lastOpen = om;
    if (lastOpen) {
      const parsed = tryParseAction(text.slice(lastOpen.index + lastOpen[0].length));
      if (parsed) actions.push(parsed);
      else malformedCount++;
    }
  }
  return {
    actions,
    malformedCount,
    hasToolFences: actions.length > 0 || malformedCount > 0,
  };
}

export function parseToolAction(text: string): ParsedToolBlock | null {
  const parsed = parseToolActions(text);
  return parsed.actions.length ? parsed.actions[parsed.actions.length - 1] : null;
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
    const rawResult = String((t as { result?: unknown }).result ?? "");
    // Refused calls are IN the trace (honest availability record) but must
    // never read as executions in a later turn's context — label them.
    const refused = rawResult.startsWith(TOOL_REFUSAL_MARKER);
    const result = rawResult
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, RECEIPT_RESULT_CHARS);
    lines.push(
      `- ${tool}(${args}) → ${refused ? "[REFUSED — did not run] " : ""}${result}${
        result.length >= RECEIPT_RESULT_CHARS ? "…" : ""
      }`
    );
  }
  if (lines.length === 0) return "";
  return (
    "\n\n[SYSTEM receipt — real tool outcomes from the turn above; entries marked [REFUSED — did not run] never executed; every other entry is a genuine platform execution, tool execution works in this conversation:]\n" +
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
  // Registry-derived availability: the notice can never advertise a tool
  // that is not routable, nor omit one that is.
  const available = FREE_CHAT_TOOL_NAMES.filter((n) => n !== tool);
  const list =
    available.length <= 1
      ? available.join("")
      : `${available.slice(0, -1).join(", ")} and ${available[available.length - 1]}`;
  return (
    `SYSTEM: Tool "${tool}" operates on an uploaded file target, which this chat does not have — so THAT tool specifically is unavailable here. ` +
    `This does NOT mean tools are unavailable in general: ${list} remain fully functional in this chat and must be used when they help ` +
    `(explore_url fetches any public URL the user asks about; the workspace tools create files and run commands for real in this chat's sandbox). ` +
    `Do not re-emit "${tool}". For the user's request, either use one of those tools or answer directly; if analysis of an UPLOADED binary is essential, tell the user to upload the file in the sidebar (Files → upload) and start a chat on it.`
  );
}

/**
 * Final-answer integrity gate — the last line of defense against fabricated
 * execution claims. The strict protocol says a final answer contains NO tool
 * block; if tool fences still reach the final text (malformed-only blocks,
 * or a synthesis turn after the iteration budget), everything around them
 * was simulated: no tool ran, so any terminal output shown beside the blocks
 * (command results, file listings, test summaries) is fabricated. Accept the
 * prose, but append an explicit system note that separates SIMULATED output
 * from the turn's genuinely executed tools instead of letting it pass as
 * real. Clean answers (no fences) pass through untouched.
 */
export function finalizeTurnContent(
  final: string,
  toolTrace: AgentToolTrace[],
  available: string[]
): string {
  const open = new RegExp(TOOL_OPEN_RE.source, "gi");
  if (!open.test(final)) return final;
  const executed = toolTrace
    .filter((t) => !t.result.startsWith(TOOL_REFUSAL_MARKER))
    .map((t) => t.tool);
  const lines = [
    "> ⚠️ **Integrity note (system):** The tool-call block(s) above were **simulated by the model — they did NOT execute on the platform**, and any command output, file listing, or test result shown next to them is **fabricated**, not real.",
    `- Tools that genuinely executed during this turn: ${executed.length ? executed.join(", ") : "none"}.`,
    `- Tools actually available here: ${available.join(", ")}.`,
    "> A success claim with no corresponding TOOL RESULT is unverified; treat the fabricated sections accordingly.",
  ];
  return `${final}\n\n${lines.join("\n")}`;
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
  /**
   * Regression seam: use THIS resolved LLM instead of resolving per user
   * (deterministic loop-level tests script the model's turns; production
   * callers never set it).
   */
  llmOverride?: ResolvedLlm;
}): Promise<AgentLoopResult> {
  const { sessionId, target, userMessage, history, events } = opts;
  const ctx: AgentToolContext | null = target
    ? { target, userId: opts.userId, sessionId }
    : null;

  let llm: ResolvedLlm;
  if (opts.llmOverride) {
    llm = opts.llmOverride;
  } else {
    try {
      llm = await resolveLlmForUser(opts.userId);
    } catch (err) {
      throw err instanceof Error
        ? err
        : new Error("Failed to resolve an AI model for this account");
    }
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
  /** Most recent LLM turn text — used to preserve visible work if we throw. */
  let lastText: string | undefined;

  try {
    for (let i = 0; i < MAX_CHAT_ITERATIONS; i++) {
    if (events?.shouldCancel?.()) {
      final = "**Investigation cancelled by user.** No further tools were run after cancellation; any findings above are partial.";
      break;
    }
    events?.onTurnStart?.(i);
    const text = await callTurn(llm, messages, i, events, callOpts);
    lastText = text;
    const parsed = parseToolActions(text);
    if (parsed.actions.length === 0) {
      // No routable tool intent: plain prose, or tool fences that are all
      // malformed/unroutable. Either way the message cannot execute anything
      // — it becomes the final answer, and the post-loop integrity gate
      // (finalizeTurnContent) labels any simulated blocks it contains.
      final = text;
      break;
    }

    // Give EVERY valid tool intent an honest outcome — executed, refused, or
    // (beyond the per-message cap) explicitly skipped. Never a silent drop:
    // the calculator/Jest fabrication happened because nine intents degraded
    // into zero outcomes and the surrounding fantasy prose became the answer.
    const executedResults: Array<{ tool: string; result: string; nudge?: string }> = [];
    const refusedTools: string[] = [];
    let halted = false;

    for (const action of parsed.actions.slice(0, MAX_TOOL_BLOCKS_PER_MESSAGE)) {
      if (ctx) {
        // Target chat: registry tools execute; unknown names come back as the
        // honest "unknown tool" error string from executeAgentTool (allow-
        // listed engine names are auto-routed through rea_tool there).
        events?.onToolCall?.(action.tool, action.args);
        const result = await executeAgentTool(action.tool, action.args, ctx);
        events?.onToolResult?.(action.tool, result);
        toolTrace.push({ tool: action.tool, args: action.args, result });

        // ---- Loop guard: identical call fired repeatedly -----------------
        const sig = `${action.tool}:${JSON.stringify(action.args)}`;
        const repeats = (repeatCounts.get(sig) ?? 0) + 1;
        repeatCounts.set(sig, repeats);
        if (repeats >= 3) {
          haltReason = `The tool call ${action.tool} was repeated ${repeats} times with identical arguments.`;
          halted = true;
          break;
        }
        executedResults.push({
          tool: action.tool,
          result,
          nudge:
            repeats === 2
              ? `SYSTEM: You already ran this exact call (${action.tool} with identical arguments) ${repeats} times in this turn. The result will not change on another run. Either vary the arguments, choose a DIFFERENT tool, or write your final answer from the evidence you have.`
              : undefined,
        });
      } else if (FREE_CHAT_TOOL_SET.has(action.tool)) {
        // Free chat: every any-scoped tool (planning, SSRF-guarded web fetch,
        // the sandboxed workspace) stays fully functional, with the same
        // dedup policy as the registry path — including per-tool opt-out for
        // stateful tools (workspace_write/workspace_run re-execute by design).
        const freeTool = AGENT_TOOLS.find((t) => t.name === action.tool);
        events?.onToolCall?.(action.tool, action.args);
        const result = await runToolWithDedup(
          freeTool?.dedup === false ? undefined : sessionId,
          action.tool,
          action.args ?? {},
          () => runFreeChatTool(action.tool, action.args ?? {}, { sessionId })
        );
        events?.onToolResult?.(action.tool, result);
        toolTrace.push({ tool: action.tool, args: action.args, result });
        executedResults.push({ tool: action.tool, result });
      } else {
        // Free chat: the tool cannot be routed here (file-bound, unknown, or
        // a fabricated name like "execute"). Record the refusal IN THE TRACE
        // and surface it live, so the transcript distinguishes unavailable
        // tools from failed calls, simulated output, and verified execution.
        events?.onToolCall?.(action.tool, action.args);
        const refusal =
          `${TOOL_REFUSAL_MARKER} — "${action.tool}" is unavailable in this chat (no file target attached). ` +
          `The platform did not run it; no output exists for it. Available here: ${FREE_CHAT_TOOL_NAMES.join(", ")}.`;
        events?.onToolResult?.(action.tool, refusal);
        toolTrace.push({ tool: action.tool, args: action.args, result: refusal });
        if (!refusedTools.includes(action.tool)) refusedTools.push(action.tool);
      }
    }

    if (halted) break; // evidence cannot change — synthesis turn follows

    // Feed every outcome back: the assistant message once, one TOOL RESULT
    // per executed block, one scoped redirect per refused tool, and explicit
    // feedback for skipped/malformed blocks. Nothing is dropped silently.
    messages.push({ role: "assistant", content: text });
    for (const { tool, result, nudge } of executedResults) {
      messages.push({
        role: "user",
        content: `TOOL RESULT for ${tool}:\n${result.slice(0, TOOL_RESULT_MAX_CHARS)}${
          nudge ? `\n\n${nudge}` : ""
        }`,
      });
    }
    for (const name of refusedTools) {
      messages.push({ role: "user", content: freeChatRedirectNotice(name) });
    }
    const skippedValid = parsed.actions.length - MAX_TOOL_BLOCKS_PER_MESSAGE;
    if (skippedValid > 0 || parsed.malformedCount > 0) {
      const parts: string[] = [];
      if (skippedValid > 0) {
        parts.push(
          `${skippedValid} additional tool block(s) in your message were not processed this turn (per-message limit of ${MAX_TOOL_BLOCKS_PER_MESSAGE}); re-emit them one per message if still needed.`
        );
      }
      if (parsed.malformedCount > 0) {
        parts.push(
          `${parsed.malformedCount} tool block(s) were malformed (invalid JSON or a missing "tool" key) and were NOT executed — never present output for blocks that did not run.`
        );
      }
      messages.push({ role: "user", content: `SYSTEM: ${parts.join(" ")}` });
    }
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
  } catch (err) {
    // Preserve completed work: persist the partial turn (visible text + the
    // tool trace executed so far) so a reload keeps it and the retry-dedup
    // cache has an audit trail. Never mask the original error.
    // A cancellation (explicit stop / safety deadline) carries a precise
    // reason via events.cancellationReason — prefer it over the generic
    // abort message so the persisted note says WHY.
    const isAbort = err instanceof Error && err.name === "TurnAbortedError";
    const cancellationReason = isAbort ? (events?.cancellationReason?.() ?? null) : null;
    const noteErr =
      cancellationReason !== null && err instanceof Error && err.message !== cancellationReason
        ? new Error(cancellationReason)
        : err;
    try {
      await db.chatMessage.create({
        data: {
          sessionId,
          role: "assistant",
          content: formatInterruptedTurnContent(lastText, noteErr),
          toolCalls: toolTrace.length ? JSON.stringify(toolTrace) : null,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          durationMs: Date.now() - startedAt,
          modelId: llmModelId(llm),
        },
      });
    } catch {
      /* persistence failure must not mask the interrupting error */
    }
    throw err;
  }

  // Final-answer integrity gate: label any simulated tool blocks that
  // survived into the final text (malformed-only messages, synthesis turns)
  // instead of letting fabricated output pass as real. Clean answers pass
  // through untouched.
  final = finalizeTurnContent(final, toolTrace, availableToolNames(ctx));

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
 * Content for the assistant row persisted when a turn throws mid-flight:
 * keeps whatever visible text the model already produced (skipping raw tool
 * blocks), appends an honest interruption note, and points at the preserved
 * trace. Exported for the stream-reliability regression suite.
 */
export function formatInterruptedTurnContent(
  lastText: string | undefined,
  err: unknown
): string {
  const msg = (err instanceof Error ? err.message : String(err ?? "unknown error")).slice(0, 300);
  // Only fence-free text counts as visible work: a mid-flight message that
  // contains tool fences was still negotiating tool execution — its blocks
  // never ran, so neither the blocks nor any output narrated beside them
  // (potentially fabricated) may be surfaced as completed work.
  const visible =
    lastText && !parseToolActions(lastText).hasToolFences ? lastText.trim() : "";
  const note = `> ⚠️ **Turn interrupted before completion:** ${msg}\n> Tools already executed this turn are preserved in the trace above; a retry reuses their results instead of running them again.`;
  return visible ? `${visible}\n\n${note}` : note;
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
/** Exported for the tool-execution/stream-reliability regression suite. */
export async function callTurn(
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
