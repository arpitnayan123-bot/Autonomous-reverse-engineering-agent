import { db } from "@/lib/db";
import { MAX_CHAT_ITERATIONS } from "@/lib/security";
import { documentationPrompt, freeChatSystemPrompt, systemPrompt } from "./prompts";
import {
  buildMemoryInjection,
  recall as recallMemories,
} from "./memory";
import {
  buildTargetContext,
  executeAgentTool,
  runFreeChatTool,
  runToolWithDedup,
  TOOL_RESULT_MAX_CHARS,
  TOOL_REFUSAL_MARKER,
  AGENT_TOOLS,
  FREE_CHAT_TOOL_NAMES,
  nativeToolSchemas,
  parseSubagentArgs,
  type AgentToolContext,
} from "./tools";
import {
  SUBAGENT_DEPTH_LIMIT,
  SUBAGENT_MAX_CONCURRENT,
  subagentManagerFor,
  type SubagentEndInfo,
  type SubagentManager,
  type SubagentStartInfo,
} from "./subagents";
import {
  estimateTokens,
  getContextWindowSize,
  resolveLlmForUser,
  type LlmMessage,
  type LlmToolCall,
  type LlmToolsResult,
  type ResolvedLlm,
  type ToolSchema,
  type TokenUsage,
} from "./providers";
import type { Evidence, Finding, Target } from "@prisma/client";

/**
 * REA investigation agent — ReAct loop with dual tool protocol.
 *
 * Two model→tool handoff paths share ONE execution core (per-call outcomes,
 * trace receipts, retry dedup, repeat guard, refusal handling — identical
 * guarantees by construction, not by copy):
 *
 * 1. NATIVE (providers with supportsNativeTools + callLLMTools): tool
 *    schemas travel through the provider's function-calling interface; the
 *    model's tool_calls are executed sequentially (tools are not thread-safe)
 *    and ALL results are reported back in a single protocol-valid turn as
 *    role:"tool" messages (merged tool_result blocks for Anthropic).
 *
 * 2. TEXT (platform fallback, Gemini, any provider without the flag — the
 *    original protocol, unchanged): each model turn must either produce the
 *    final markdown answer or emit ```tool {json} ``` action blocks, parsed,
 *    executed server-side and fed back as user messages.
 *
 * Both paths run until MAX_CHAT_ITERATIONS is exhausted; the fabrication
 * gate (finalizeTurnContent) labels simulated blocks in the final answer on
 * either path.
 */

export type { LlmMessage };

type ChatRole = "user" | "assistant";
interface LoopMessage {
  role: ChatRole;
  content: string;
}

/**
 * Internal marker set ONLY by runSpawnSubagentTool when this loop IS a
 * subagent (depth 2). Changes vs a primary loop:
 *  - persistence: subagent turns are NOT persisted as chat messages — the
 *    result travels back as the parent's spawn_subagent tool result;
 *  - tool surface: spawn_subagent is refused (recursion depth limit —
 *    subagents cannot spawn sub-subagents) and routing is restricted to
 *    allowedTools;
 *  - dedup namespace: the retry-dedup cache key is prefixed with the
 *    subagent id, so the parent's cached results are never reused (the
 *    workspace itself stays shared — same sessionId, same sandbox dir).
 */
interface SubagentRunContext {
  id: string;
  depth: number;
  allowedTools: string[];
  maxIterations: number;
  manager: SubagentManager;
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
  /**
   * A subagent run began (spawn_subagent executed in this loop). The UI
   * opens an indented progress block keyed by the subagent id.
   */
  onSubagentStart?: (info: SubagentStartInfo) => void;
  /** Incremental assistant text produced INSIDE a subagent run. */
  onSubagentDelta?: (id: string, text: string) => void;
  /** A subagent run finished (completed / failed / cancelled). */
  onSubagentEnd?: (info: SubagentEndInfo) => void;
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
  /**
   * How many times context compaction ran during this turn (0 = the
   * transcript stayed under the compaction threshold). Persisted per row and
   * surfaced in the transcript meta ("context compacted N times").
   */
  compactionCount: number;
  /**
   * LLM turns this loop used (main iterations + the forced synthesis turn
   * when it fires). For subagent runs this is the subagent's own budget
   * accounting — surfaced in the subagent end event.
   */
  iterations: number;
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
  const direct = tryParseActionStrict(body);
  if (direct) return direct;
  // Trailing-garbage repair (unambiguous cases only): some models emit a
  // COMPLETE tool action and then close the fence with stray braces
  // (`{"tool":...}}`). Removing ONE trailing brace at a time (max 3) and
  // re-parsing turns a refused-then-fabricated-around outcome into a REAL
  // execution — the integrity goal is that operations genuinely run, and the
  // repair only accepts content that parses to a well-formed {tool,args}
  // object. Wrong-key objects ({"execute":{...}}) stay malformed: stripping
  // their last brace leaves invalid JSON, so they can never sneak through.
  let candidate = body.trim();
  for (let i = 0; i < 3 && candidate.endsWith("}"); i++) {
    candidate = candidate.slice(0, -1).trimEnd();
    const repaired = tryParseActionStrict(candidate);
    if (repaired) return repaired;
  }
  return null;
}

function tryParseActionStrict(body: string): ParsedToolBlock | null {
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
  let lastClosedEnd = -1;
  while ((m = closed.exec(text)) !== null) {
    const parsed = tryParseAction(m[2]);
    if (parsed) actions.push(parsed);
    else malformedCount++;
    lastClosedEnd = m.index + m[0].length;
  }
  if (actions.length === 0 && lastOpenPast(text, lastClosedEnd)) {
    // Unterminated-block fallback — only when the message ends inside an
    // OPEN fence (opener with no closer after it). A closed malformed block
    // was already counted exactly once above; without this guard the tail
    // pass re-parsed the same closed body and double-counted it.
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

/** True when an unclosed tool-fence opener exists after the last closed block. */
function lastOpenPast(text: string, lastClosedEnd: number): boolean {
  const open = new RegExp(TOOL_OPEN_RE.source, "gi");
  let lastOpen: RegExpExecArray | null = null;
  let om: RegExpExecArray | null;
  while ((om = open.exec(text)) !== null) lastOpen = om;
  return Boolean(lastOpen && lastOpen.index >= lastClosedEnd);
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
// Context window management — compaction between iterations
// ---------------------------------------------------------------------------

/** Compaction fires when estimated tokens exceed this share of the window. */
export const COMPACTION_THRESHOLD_RATIO = 0.8;
/** Messages kept verbatim at the tail across a compaction. */
export const COMPACTION_KEEP_LAST = 6;
/** Verbatim instruction the summarizer call receives. */
export const COMPACTION_PROMPT =
  "Summarize this investigation transcript into a structured state document: target info, tools used, key findings (with evidence grades), dead ends, current hypothesis, and next steps. Be terse.";
/** The injected state message is labeled with this exact marker. */
export const COMPACTION_LABEL = "[COMPACTED INVESTIGATION STATE]";
/** Per-message char cap when flattening the transcript for the summarizer. */
const COMPACTION_MSG_CAP = 2_000;
/** Overall char budget for the summarizer input — keeps the compaction call
 * itself inside the window it is trying to save. */
const COMPACTION_SUMMARY_CHAR_BUDGET = 60_000;
/** Cross-turn receipt blocks (toolReceiptSuffix) are recognized by this prefix. */
const RECEIPT_MARKER_PREFIX = "[SYSTEM receipt — real tool outcomes";
/** Prior state documents are recognized by their label + tool-summary header,
 * so repeated compactions carry the receipt section forward. */
const TOOL_SUMMARY_HEADER = "### Tool execution summary";

/** Collapse whitespace and cap a string for summary/transcript use. */
function capLine(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/**
 * Protocol-safe compaction boundary. The middle [from, to) is replaced by the
 * state document; [to, end) stays verbatim. `from` is always 1 (everything
 * between the system prompt and the tail compacts); `to` = length - keepLast
 * UNLESS the kept tail would START on a role:"tool" message — an answer
 * orphaned from its assistant tool_calls message would make the next native
 * request protocol-invalid (OpenAI requires a tool_calls assistant before
 * every tool answer; Anthropic tool_result blocks reference their tool_use).
 * In that case the tail extends LEFT over the whole answer group (assistant
 * tool_calls + every role:"tool" answer), keeping more than keepLast messages
 * to preserve protocol validity — "keep the last 6" is a minimum, not a max.
 * Returns null when there is nothing between the system prompt and the tail.
 * Exported for the compaction regression suite.
 */
export function computeCompactionBoundary(
  messages: LlmMessage[],
  keepLast: number
): { from: number; to: number } | null {
  let to = messages.length - keepLast;
  if (to <= 1) return null; // only the system prompt would sit before the tail
  // Walk the tail start left over any tool-answer group it would orphan.
  while (to > 1 && messages[to]?.role === "tool") to--;
  if (to <= 1) return null;
  return { from: 1, to };
}

/**
 * One flat transcript line for the summarizer: roles are labeled, native
 * tool_calls become readable "requests tool X" notes, and every message is
 * tightly capped (the middle is large by definition — that is WHY it is being
 * compacted).
 */
function summarizeMessageLine(m: LlmMessage): string {
  if (m.role === "tool") {
    return `[TOOL RESULT${m.toolCallId ? ` for call ${m.toolCallId}` : ""}] ${capLine(
      m.content ?? "",
      400
    )}`;
  }
  let text = m.content ?? "";
  if (m.toolCalls?.length) {
    const calls = m.toolCalls
      .map(
        (tc) =>
          `[requests tool ${tc.name} with ${capLine(JSON.stringify(tc.arguments ?? {}), 200)}]`
      )
      .join(" ");
    text = `${text}\n${calls}`;
  }
  return `[${m.role === "assistant" ? "ASSISTANT" : "USER"}] ${capLine(text, COMPACTION_MSG_CAP)}`;
}

/** Flatten the middle messages into the summarizer's transcript input. */
function flattenForSummarizer(middle: LlmMessage[]): string {
  const lines = middle.map(summarizeMessageLine);
  const joined = lines.join("\n\n");
  if (joined.length <= COMPACTION_SUMMARY_CHAR_BUDGET) return joined;
  // Over budget: keep the MOST RECENT middle content and mark the omission
  // honestly — the summarizer cannot summarize what it never sees.
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const len = lines[i].length + 2;
    if (used + len > COMPACTION_SUMMARY_CHAR_BUDGET) break;
    kept.unshift(lines[i]);
    used += len;
  }
  return `[...${lines.length - kept.length} older message(s) omitted from the summarizer input...]\n\n${kept.join(
    "\n\n"
  )}`;
}

/**
 * Tool executions recorded in the compacted segment, rebuilt into one
 * summary section that ships inside the state document — after compaction
 * the model must still see PROOF that tools genuinely ran (three sources:
 * native role:"tool" results, text-path "TOOL RESULT for" rows, and the
 * cross-turn receipt blocks appended by toolReceiptSuffix). Exported for
 * the compaction regression suite.
 */
export function extractToolExecutionSummary(middle: LlmMessage[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const push = (line: string) => {
    const key = line.slice(0, 160);
    if (seen.has(key) || lines.length >= 10) return;
    seen.add(key);
    lines.push(line);
  };
  for (const m of middle) {
    if (m.role === "tool") {
      push(
        `- tool result${m.toolCallId ? ` (call ${m.toolCallId})` : ""}: ${capLine(
          m.content ?? "",
          160
        )}`
      );
      continue;
    }
    const content = m.content ?? "";
    const markerAt = content.indexOf(RECEIPT_MARKER_PREFIX);
    if (markerAt >= 0) {
      // toolReceiptSuffix block — already bounded (≤5 tools, 160 chars each);
      // carry its bullet lines through verbatim.
      for (const rawLine of content.slice(markerAt).split("\n")) {
        const line = rawLine.trim();
        if (line.startsWith("- ")) push(line);
      }
      continue;
    }
    const stateLabelAt = content.indexOf(COMPACTION_LABEL);
    if (stateLabelAt >= 0) {
      // A PREVIOUS state document being compacted again: carry its
      // tool-execution bullets forward so repeated compactions can never
      // silently drop the proof that tools ran.
      const headerAt = content.indexOf(TOOL_SUMMARY_HEADER, stateLabelAt);
      if (headerAt >= 0) {
        for (const rawLine of content.slice(headerAt).split("\n")) {
          const line = rawLine.trim();
          if (line.startsWith("- ")) push(line);
        }
        continue;
      }
    }
    if (m.role === "user" && content.startsWith("TOOL RESULT for")) {
      push(`- ${capLine(content, 200)}`);
    }
  }
  const header =
    `${TOOL_SUMMARY_HEADER} (system-preserved receipts)\n` +
    "The transcript above is a summary; these tool executions GENUINELY ran on the platform earlier in this conversation:";
  return lines.length
    ? `${header}\n${lines.join("\n")}`
    : `${header}\n- (no tool executions recorded in the compacted segment)`;
}

/** Build the labeled state-document message that replaces the middle. */
export function buildCompactedStateMessage(
  summary: string,
  middle: LlmMessage[]
): LlmMessage {
  const body = summary.trim() || "(the summarizer returned no content)";
  return {
    role: "user",
    content: `${COMPACTION_LABEL}\n\n${body}\n\n${extractToolExecutionSummary(middle)}`,
  };
}

// ---------------------------------------------------------------------------
// Subagent runs — fresh-loop delegation (spawn_subagent)
// ---------------------------------------------------------------------------

/** Discriminator for the subagent system addendum (also a test seam). */
export const SUBAGENT_ADDENDUM_MARKER = "## Subagent protocol (run ";

/**
 * Appended to the system prompt ONLY on subagent loops: the loop-scope
 * rules a nested run needs — focused role, the ALLOWED tool list (routing
 * refuses anything outside it), the depth rule (no sub-subagents) and the
 * self-contained-report contract.
 */
function subagentSystemAddendum(id: string, tools: string[]): string {
  return (
    `\n\n${SUBAGENT_ADDENDUM_MARKER}${id})\n` +
    `- You are SUBAGENT ${id}, spawned by the primary agent for ONE focused task. The conversation below contains ONLY that task — work it end-to-end now.\n` +
    `- Your final text is delivered to the primary agent verbatim as the tool result. Make it a self-contained report: what you did, the OBSERVED evidence (with tool names), and your conclusion. Do not address the human user — the primary agent is your audience.\n` +
    `- Routable tools for this run: ${tools.join(", ")}. EVERY other tool is unavailable — including spawn_subagent: subagents cannot spawn sub-subagents (recursion depth limit ${SUBAGENT_DEPTH_LIMIT}).\n` +
    `- All integrity rules apply verbatim: only claim an operation succeeded if a genuine tool result for it arrived; never fabricate output.`
  );
}

/**
 * Execute one spawn_subagent call coming from the PRIMARY loop (depth 1).
 *
 * Depth guard first (subagents are intercepted earlier in executeAction, so
 * this normally fires only at depth 1), then argument validation, then the
 * per-session concurrency cap — every refusal is an honest tool-result
 * string, never a throw. The subagent itself runs as a nested runAgentLoop
 * with:
 *  - the SAME sessionId (shared workspace, shared target context),
 *  - a FRESH history: only the system prompt and the task text,
 *  - the parent's resolved LLM (llmOverride — no re-resolution),
 *  - a composed abort signal: parent signal OR the manager's controller,
 *  - restricted tool surface + dedup namespace via the internal `subagent`
 *    run context.
 *
 * Its progress streams to the parent's UI as [subagent]-prefixed tool
 * events plus the dedicated onSubagentStart / onSubagentDelta / onSubagentEnd
 * events. Subagent failure NEVER crashes the parent loop: it comes back as
 * this tool's error result.
 */
export async function runSpawnSubagentTool(
  args: Record<string, unknown>,
  env: {
    sessionId: string;
    target: Target | null;
    userId: string;
    llm: ResolvedLlm;
    parentEvents?: AgentEventHandlers;
    parentSignal?: AbortSignal;
    parentDepth: number;
  }
): Promise<string> {
  const { sessionId, target, userId, llm, parentEvents, parentSignal, parentDepth } = env;
  if (parentDepth + 1 > SUBAGENT_DEPTH_LIMIT) {
    return (
      `${TOOL_REFUSAL_MARKER} — subagents cannot spawn sub-subagents: the recursion depth limit is ` +
      `${SUBAGENT_DEPTH_LIMIT} and this call already runs at depth ${parentDepth}. Do the work yourself with your own tools.`
    );
  }
  const parsed = parseSubagentArgs(args ?? {});
  if (!parsed.ok) return `Error: ${parsed.error}`;

  const manager = subagentManagerFor(sessionId);
  if (!manager.canSpawn()) {
    return (
      `Error: the concurrent subagent limit for this session is ${SUBAGENT_MAX_CONCURRENT} ` +
      `(${manager.activeCount()} currently active). Finish or wait for one to complete, or do the work directly with your own tools.`
    );
  }
  const record = manager.begin(parsed.value, parentDepth + 1);
  if (!record) {
    return `Error: the concurrent subagent limit for this session is ${SUBAGENT_MAX_CONCURRENT} — no new subagent could be started.`;
  }
  const controller = manager.controllerFor(record.id);

  // Composed cancellation: the parent turn's signal OR a manager-level
  // cancelAll aborts the nested loop at its next check.
  const composite = new AbortController();
  const abortFromParent = () =>
    composite.abort(parentSignal?.reason ?? new Error("parent turn cancelled"));
  const abortFromManager = () => composite.abort(new Error("subagent cancelled"));
  if (parentSignal) {
    if (parentSignal.aborted) composite.abort();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  controller.signal.addEventListener("abort", abortFromManager, { once: true });
  const detachListeners = () => {
    parentSignal?.removeEventListener("abort", abortFromParent);
    controller.signal.removeEventListener("abort", abortFromManager);
  };

  parentEvents?.onSubagentStart?.({
    id: record.id,
    task: record.task,
    tools: record.tools,
    maxIterations: record.maxIterations,
  });

  const subEvents: AgentEventHandlers = {
    // Model text streams through the dedicated subagent channel (indented
    // in the UI); tool activity streams as [subagent]-prefixed TOOL events
    // so the existing trace rows render the nested executions.
    onAssistantDelta: (text) => parentEvents?.onSubagentDelta?.(record.id, text),
    onToolCall: (tool, targs) => {
      record.toolTrace.push({ tool, args: targs, result: "(running)" });
      parentEvents?.onToolCall?.(`[subagent] ${tool}`, targs);
    },
    onToolResult: (tool, result) => {
      for (let i = record.toolTrace.length - 1; i >= 0; i--) {
        if (record.toolTrace[i].tool === tool && record.toolTrace[i].result === "(running)") {
          record.toolTrace[i] = { ...record.toolTrace[i], result };
          break;
        }
      }
      parentEvents?.onToolResult?.(`[subagent] ${tool}`, result);
    },
    // Parent-scoped channels stay parent-scoped: a nested loop must not
    // reset the main draft buffer, re-send the model banner, or double-
    // fire subagent events for its own (nonexistent) spawns.
    onModelResolved: undefined,
    onTurnStart: undefined,
    onSubagentStart: undefined,
    onSubagentDelta: undefined,
    onSubagentEnd: undefined,
    // Cancellation bridge: parent stop OR manager cancelAll stops the
    // nested loop at its next iteration boundary.
    shouldCancel: () => Boolean(parentEvents?.shouldCancel?.() || composite.signal.aborted),
    cancellationReason: () =>
      parentEvents?.cancellationReason?.() ??
      (composite.signal.aborted ? "subagent run cancelled" : null),
  };

  const startedAt = Date.now();
  try {
    const result = await runAgentLoop({
      sessionId, // SAME session → the sandboxed workspace is shared
      target,
      userId,
      // Fresh message history: only the system prompt (plus the loop's
      // standard same-target preamble) and the task — no parent traffic.
      userMessage: record.task,
      history: [],
      llmOverride: llm,
      signal: composite.signal,
      events: subEvents,
      subagent: {
        id: record.id,
        depth: record.depth,
        allowedTools: record.tools,
        maxIterations: record.maxIterations,
        manager,
      },
    });
    const cancelled = composite.signal.aborted;
    manager.finish(record.id, {
      status: cancelled ? "cancelled" : "completed",
      durationMs: result.durationMs,
      usage: result.usage,
      // Authoritative trace from the nested loop (the live bridge entries
      // were a best-effort preview).
      toolTrace: result.toolCalls.map((t) => ({ ...t })),
      iterations: result.iterations,
      result: result.content,
    });
    parentEvents?.onSubagentEnd?.({
      id: record.id,
      status: cancelled ? "cancelled" : "completed",
      durationMs: result.durationMs,
      iterations: result.iterations,
      toolsUsed: result.toolCalls.length,
      summary: result.content.slice(0, 400),
    });
    if (cancelled) {
      return `SUBAGENT CANCELLED: subagent ${record.id} stopped by a cancellation propagated from the parent turn; no further subagent work ran. Partial report:\n${result.content.slice(0, TOOL_RESULT_MAX_CHARS)}`;
    }
    return `SUBAGENT RESULT:\n${result.content.slice(0, TOOL_RESULT_MAX_CHARS)}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    manager.finish(record.id, {
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: msg.slice(0, 500),
    });
    parentEvents?.onSubagentEnd?.({
      id: record.id,
      status: "failed",
      durationMs: Date.now() - startedAt,
      iterations: 0,
      toolsUsed: record.toolTrace.length,
      summary: msg.slice(0, 400),
    });
    // A subagent failure is THIS tool's result — never a parent-loop crash.
    return `Error: subagent ${record.id} failed: ${msg.slice(0, 800)}`;
  } finally {
    detachListeners();
  }
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * Appended to the system prompt ONLY on the native path: the shared prompt
 * teaches the text fence grammar, which would make a native-capable model
 * write ```tool blocks into visible text (where they never execute). The
 * addendum switches the protocol and keeps the honesty rule explicit.
 */
const NATIVE_TOOL_PROTOCOL_ADDENDUM =
  "\n\n## Tool protocol override (native function calling)\n" +
  "- This session has NATIVE tool calling enabled: invoke tools through the provider's function-calling interface. Do NOT emit ```tool blocks — text in your visible answer is NEVER executed, and any block found there is labeled as simulated.\n" +
  "- You may emit MULTIPLE tool calls in one turn when they are independent; they run one after another and every result comes back to you together.\n" +
  "- Every honesty rule still applies verbatim: only claim an operation succeeded if a tool result for it actually arrived.";

/**
 * Outcome of one tool intent (text-block action OR native tool_call) through
 * the shared execution core. `halted` means the repeat guard fired: the call
 * was traced/streamed but nothing more runs this turn.
 */
type ActionOutcome =
  | {
      kind: "executed";
      tool: string;
      args: Record<string, unknown>;
      result: string;
      nudge?: string;
    }
  | { kind: "refused"; tool: string; args: Record<string, unknown>; result: string }
  | { kind: "halted"; tool: string; args: Record<string, unknown>; reason: string };

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
  /**
   * Internal: set ONLY by runSpawnSubagentTool — marks this loop as a
   * subagent run (depth 2). Never set by production callers.
   */
  subagent?: SubagentRunContext;
}): Promise<AgentLoopResult> {
  const { sessionId, target, userMessage, history, events } = opts;
  const asSubagent = opts.subagent ?? null;
  const ctx: AgentToolContext | null = target
    ? {
        target,
        userId: opts.userId,
        sessionId,
        // Subagent runs namespace their retry-dedup keys with the subagent
        // id (never reuse the parent's cached results) while keeping the
        // raw sessionId — the sandboxed workspace stays SHARED.
        ...(asSubagent ? { dedupNamespace: asSubagent.id } : {}),
      }
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

  if (asSubagent) {
    // Subagent run: the fresh transcript (system prompt + task only) gets
    // the subagent protocol addendum — focused role, the ALLOWED tool list
    // (routing refuses anything outside it) and the no-sub-subagent rule.
    // NOTE: memory recall is intentionally SKIPPED for subagents — the
    // parent loop already carries the relevant memories in ITS system
    // prompt, and a subagent must see only its assigned task.
    const routableNames = (
      ctx ? AGENT_TOOLS.map((t) => t.name) : FREE_CHAT_TOOL_NAMES
    ).filter((n) => asSubagent.allowedTools.includes(n));
    messages[0] = {
      role: "assistant",
      content: `${messages[0].content}${subagentSystemAddendum(asSubagent.id, routableNames)}`,
    };
  } else {
    // Cross-session memory injection (primary loops only, BEFORE the first
    // LLM call): recall ranked matches for the user's message — scoped to
    // (user + target) first, then (user + global); in a FREE chat (target
    // null) only global memories are searched — and append the capped
    // [RELEVANT MEMORIES FROM PAST SESSIONS] block to the system prompt.
    // Memory is an enhancement, never a correctness requirement: a recall
    // failure must not kill the turn.
    try {
      const memoryMatches = await recallMemories(
        opts.userId,
        target?.id ?? null,
        userMessage
      );
      const memoryBlock = buildMemoryInjection(memoryMatches);
      if (memoryBlock) {
        messages[0] = {
          role: "assistant",
          content: `${messages[0].content}\n\n${memoryBlock}`,
        };
      }
    } catch (err) {
      console.warn(
        "memory recall failed; continuing without injected memories:",
        err instanceof Error ? err.message : err
      );
    }
  }

  /**
   * Native tool calling is used ONLY when the resolved LLM declares the
   * capability AND implements it — the platform fallback and any provider
   * without the flag transparently run the original text protocol. The
   * schemas advertise exactly the tools this chat can route (all registry
   * tools for a target chat, any-scoped only for a FREE chat) — the model
   * never sees a tool it cannot reach.
   */
  const nativeEnabled = Boolean(
    llm.supportsNativeTools && typeof llm.callLLMTools === "function"
  );
  const nativeSchemas: ToolSchema[] = nativeEnabled
    ? nativeToolSchemas(ctx ? "target" : "free").filter((s) => {
        if (!asSubagent) return true;
        // Depth limit: a subagent never even SEES spawn_subagent in its
        // schema list (the loop refuses a call emitted anyway).
        if (s.function.name === "spawn_subagent") return false;
        return asSubagent.allowedTools.includes(s.function.name);
      })
    : [];
  if (nativeEnabled) {
    // Protocol override: the shared system prompt teaches the text fence
    // grammar; a native-capable model must use the function-calling interface
    // instead. Fences that leak into visible text anyway are NOT executed —
    // the finalizeTurnContent gate labels them as simulated.
    messages[0] = {
      role: "assistant",
      content: `${messages[0].content}${NATIVE_TOOL_PROTOCOL_ADDENDUM}`,
    };
  }

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
  /**
   * Iteration budget: primary loops get MAX_CHAT_ITERATIONS; subagent runs
   * get their spawn-time budget (max_iterations, 1..15).
   */
  const iterationCap = asSubagent ? asSubagent.maxIterations : MAX_CHAT_ITERATIONS;
  /** LLM turns used: main iterations + the forced synthesis turn. */
  let iterationsUsed = 0;
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

  // --- Context window management (compaction between iterations) ----------
  let compactionCount = 0;
  /** Set when a compaction attempt fails — no retry storm; the loop proceeds
   * un-compacted and a real over-window error surfaces honestly from the
   * provider on a later call. */
  let compactionDisabled = false;

  /**
   * Compaction checkpoint — called ONLY between iterations, after the
   * iteration's tool traffic is fully appended to `messages`, never while a
   * tool result is being processed. When the estimated token footprint
   * crosses 80% of the model's context window, the transcript middle (the
   * system prompt and the last COMPACTION_KEEP_LAST messages stay verbatim)
   * is summarized into one labeled state document. Tool receipts survive:
   * the state document always carries a tool execution summary rebuilt from
   * the compacted segment. The summarizer call is internal — it NEVER
   * streams deltas to the client — but its provider-reported usage counts
   * toward the turn like any other LLM call.
   */
  const maybeCompact = async (): Promise<void> => {
    if (compactionDisabled || callOpts.signal?.aborted) return;
    const windowSize = getContextWindowSize(llm.provider, llm.model);
    const budget = Math.floor(windowSize * COMPACTION_THRESHOLD_RATIO);
    if (estimateTokens(messages) <= budget) return;
    const boundary = computeCompactionBoundary(messages, COMPACTION_KEEP_LAST);
    if (!boundary) return; // nothing between the system prompt and the kept tail
    const middle = messages.slice(boundary.from, boundary.to);
    if (middle.length === 0) return;
    try {
      const summary = await llm.callLLM(
        [
          {
            role: "user",
            content: `${COMPACTION_PROMPT}\n\n=== INVESTIGATION TRANSCRIPT ===\n${flattenForSummarizer(middle)}`,
          },
        ],
        callOpts
      );
      messages.splice(
        boundary.from,
        boundary.to - boundary.from,
        buildCompactedStateMessage(summary, middle)
      );
      compactionCount++;
    } catch (err) {
      // Honest degradation: compaction is an optimization, not a correctness
      // requirement — failing it must not kill an investigation that would
      // otherwise continue. Stop attempting this turn; if the context really
      // is over the window, the provider's own error surfaces on the next
      // call and the turn fails with THAT, un-masked.
      compactionDisabled = true;
      console.warn(
        "context compaction failed; continuing without compaction:",
        err instanceof Error ? err.message : err
      );
    }
  };

  /**
   * Shared per-call execution core — the ONLY place a tool intent (a parsed
   * text-block action OR a native tool_call) becomes an outcome. Both
   * protocol paths call THIS function, so the integrity guarantees (live
   * events, trace receipts, retry dedup, refusal wording, repeat guard)
   * cannot drift between them.
   */
  const executeAction = async (action: {
    tool: string;
    args: Record<string, unknown>;
  }): Promise<ActionOutcome> => {
    if (action.tool === "spawn_subagent") {
      // Subagent delegation — intercepted BEFORE both protocol branches:
      // it exists in the registry (advertisement parity) but its execution
      // needs THIS loop's LLM handle, event stream and depth state. Depth,
      // validation, concurrency and cancellation are owned by
      // runSpawnSubagentTool; the bookkeeping below matches every other
      // tool (live events, trace, repeat guard).
      events?.onToolCall?.(action.tool, action.args);
      const result = await runSpawnSubagentTool(action.args ?? {}, {
        sessionId,
        target,
        userId: opts.userId,
        llm,
        parentEvents: events,
        parentSignal: opts.signal,
        parentDepth: asSubagent ? asSubagent.depth : 1,
      });
      events?.onToolResult?.(action.tool, result);
      toolTrace.push({ tool: action.tool, args: action.args, result });
      const sig = `${action.tool}:${JSON.stringify(action.args)}`;
      const repeats = (repeatCounts.get(sig) ?? 0) + 1;
      repeatCounts.set(sig, repeats);
      if (repeats >= 3) {
        return {
          kind: "halted",
          tool: action.tool,
          args: action.args,
          reason: `The tool call ${action.tool} was repeated ${repeats} times with identical arguments.`,
        };
      }
      return {
        kind: "executed",
        tool: action.tool,
        args: action.args,
        result,
        nudge:
          repeats === 2
            ? `SYSTEM: You already spawned an identical subagent (same task) ${repeats} times this turn. The result will not change on another spawn. Either vary the task, do the work yourself with your own tools, or write your final answer from the evidence you have.`
            : undefined,
      };
    }
    if (asSubagent && !asSubagent.allowedTools.includes(action.tool)) {
      // Subagent tool allowlist gate — the spawn-time `tools` argument is a
      // real routing boundary, not prose: anything outside it is refused
      // with the honest NOT EXECUTED marker (and never executed).
      events?.onToolCall?.(action.tool, action.args);
      const refusal =
        `${TOOL_REFUSAL_MARKER} — "${action.tool}" is not in this subagent's tool allowlist ` +
        `(${asSubagent.allowedTools.join(", ")}). The platform did not run it; use one of the listed tools or write your report from the evidence you have.`;
      events?.onToolResult?.(action.tool, refusal);
      toolTrace.push({ tool: action.tool, args: action.args, result: refusal });
      return { kind: "refused", tool: action.tool, args: action.args, result: refusal };
    }
    if (ctx) {
      // Target chat: registry tools execute; unknown names come back as the
      // honest "unknown tool" error string from executeAgentTool (allow-
      // listed engine names are auto-routed through rea_tool there).
      events?.onToolCall?.(action.tool, action.args);
      const result = await executeAgentTool(action.tool, action.args, ctx);
      events?.onToolResult?.(action.tool, result);
      toolTrace.push({ tool: action.tool, args: action.args, result });

      // ---- Loop guard: identical call fired repeatedly -------------------
      const sig = `${action.tool}:${JSON.stringify(action.args)}`;
      const repeats = (repeatCounts.get(sig) ?? 0) + 1;
      repeatCounts.set(sig, repeats);
      if (repeats >= 3) {
        return {
          kind: "halted",
          tool: action.tool,
          args: action.args,
          reason: `The tool call ${action.tool} was repeated ${repeats} times with identical arguments.`,
        };
      }
      return {
        kind: "executed",
        tool: action.tool,
        args: action.args,
        result,
        nudge:
          repeats === 2
            ? `SYSTEM: You already ran this exact call (${action.tool} with identical arguments) ${repeats} times in this turn. The result will not change on another run. Either vary the arguments, choose a DIFFERENT tool, or write your final answer from the evidence you have.`
            : undefined,
      };
    }
    if (FREE_CHAT_TOOL_SET.has(action.tool)) {
      // Free chat: every any-scoped tool (planning, SSRF-guarded web fetch,
      // the sandboxed workspace) stays fully functional, with the same
      // dedup policy as the registry path — including per-tool opt-out for
      // stateful tools (workspace_write/workspace_run re-execute by design).
      // Subagent runs pass their id as the dedup namespace: identical calls
      // never reuse the parent loop's cached results.
      const freeTool = AGENT_TOOLS.find((t) => t.name === action.tool);
      events?.onToolCall?.(action.tool, action.args);
      const result = await runToolWithDedup(
        freeTool?.dedup === false ? undefined : sessionId,
        action.tool,
        action.args ?? {},
        () => runFreeChatTool(action.tool, action.args ?? {}, { sessionId, userId: opts.userId }),
        asSubagent?.id
      );
      events?.onToolResult?.(action.tool, result);
      toolTrace.push({ tool: action.tool, args: action.args, result });
      return { kind: "executed", tool: action.tool, args: action.args, result };
    }
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
    return { kind: "refused", tool: action.tool, args: action.args, result: refusal };
  };

  try {
    for (let i = 0; i < iterationCap; i++) {
    if (events?.shouldCancel?.()) {
      final = "**Investigation cancelled by user.** No further tools were run after cancellation; any findings above are partial.";
      break;
    }
    events?.onTurnStart?.(i);
    iterationsUsed++;

    if (nativeEnabled) {
      // ---- NATIVE path: schemas went out with the request; the model's
      // tool_calls come back normalized. Calls execute SEQUENTIALLY (tools
      // are not thread-safe) and ALL results are reported back together in
      // one protocol-valid turn (assistant tool_calls + role:"tool" answers).
      const res = await callTurnTools(llm, messages, nativeSchemas, i, events, callOpts);
      lastText = res.content;
      if (res.toolCalls.length === 0) {
        // Plain prose (or stray text fences — the finalizeTurnContent gate
        // labels those): the turn's final answer on the native path.
        final = res.content;
        break;
      }

      // Give EVERY provider tool_call an honest outcome — executed, refused,
      // malformed-args error, or (beyond the per-message cap / after a loop
      // halt) an explicit NOT EXECUTED answer. Protocol validity requires a
      // tool response for every tool_call_id; honesty requires that response
      // to say exactly what really happened.
      const responses: LlmMessage[] = [];
      const executedResults: Array<{ tool: string; result: string; nudge?: string }> = [];
      const refusedTools: string[] = [];
      let halted = false;
      const answerCall = (id: string, content: string) =>
        responses.push({ role: "tool", content, toolCallId: id });

      for (let c = 0; c < res.toolCalls.length; c++) {
        const tc = res.toolCalls[c];
        if (c >= MAX_TOOL_BLOCKS_PER_MESSAGE) {
          // Beyond the per-message cap: answered honestly, never executed
          // (per-iteration tool runtime stays bounded, same as the text path).
          answerCall(
            tc.id,
            `NOT EXECUTED — per-message tool-call limit (${MAX_TOOL_BLOCKS_PER_MESSAGE}) reached; this call was not run. Re-emit it in your next turn if still needed.`
          );
          continue;
        }
        if (halted) {
          // Repeat guard already fired: nothing further executes this turn.
          const notRun = `${TOOL_REFUSAL_MARKER} — loop halted (an identical call was repeated); this call was not run.`;
          events?.onToolCall?.(tc.name || "(unnamed)", tc.arguments);
          events?.onToolResult?.(tc.name || "(unnamed)", notRun);
          toolTrace.push({ tool: tc.name || "(unnamed)", args: tc.arguments, result: notRun });
          answerCall(tc.id, notRun);
          continue;
        }
        if (!tc.name || !tc.name.trim()) {
          const err =
            "Error: the provider returned a tool call without a usable function name — nothing was executed.";
          events?.onToolCall?.("(unnamed)", tc.arguments);
          events?.onToolResult?.("(unnamed)", err);
          toolTrace.push({ tool: "(unnamed)", args: tc.arguments, result: err });
          answerCall(tc.id, err);
          continue;
        }
        if (tc.malformedArguments) {
          // The provider's arguments never parsed: executing with {} would be
          // a guess, so the call is answered with a precise, honest failure.
          const err = `Error: the provider returned malformed JSON arguments for "${tc.name}" (${tc.malformedArguments}) — nothing was executed. Re-emit the call with a valid JSON arguments object matching the tool's schema.`;
          events?.onToolCall?.(tc.name, {});
          events?.onToolResult?.(tc.name, err);
          toolTrace.push({ tool: tc.name, args: {}, result: err });
          answerCall(tc.id, err);
          continue;
        }
        const outcome = await executeAction({ tool: tc.name, args: tc.arguments });
        if (outcome.kind === "halted") {
          haltReason = outcome.reason;
          halted = true;
          answerCall(
            tc.id,
            `${TOOL_REFUSAL_MARKER} — ${outcome.reason} No further calls run this turn; synthesize from the evidence already gathered.`
          );
          continue;
        }
        if (outcome.kind === "refused") {
          if (!refusedTools.includes(outcome.tool)) refusedTools.push(outcome.tool);
          answerCall(tc.id, outcome.result.slice(0, TOOL_RESULT_MAX_CHARS));
          continue;
        }
        executedResults.push({ tool: outcome.tool, result: outcome.result, nudge: outcome.nudge });
        answerCall(
          tc.id,
          `${outcome.result.slice(0, TOOL_RESULT_MAX_CHARS)}${outcome.nudge ? `\n\n${outcome.nudge}` : ""}`
        );
      }

      // Protocol validity FIRST: the assistant tool_calls message and every
      // tool answer go in together, so the next request is always well-formed
      // (OpenAI requires a role:"tool" per tool_call_id; Anthropic merges the
      // tool_result blocks into one user turn).
      messages.push({
        role: "assistant",
        content: res.content,
        ...(res.toolCalls.length ? { toolCalls: res.toolCalls } : {}),
      });
      for (const r of responses) messages.push(r);
      if (!halted) {
        for (const name of refusedTools) {
          messages.push({ role: "user", content: freeChatRedirectNotice(name) });
        }
      }
      if (halted) break; // evidence cannot change — synthesis turn follows
      // Between-iterations compaction checkpoint (all tool traffic for this
      // iteration is already in `messages`).
      await maybeCompact();
      continue;
    }

    // ---- TEXT path (original protocol, unchanged) -------------------------
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
      const outcome = await executeAction(action);
      if (outcome.kind === "halted") {
        haltReason = outcome.reason;
        halted = true;
        break;
      }
      if (outcome.kind === "refused") {
        if (!refusedTools.includes(outcome.tool)) refusedTools.push(outcome.tool);
        continue;
      }
      executedResults.push({ tool: outcome.tool, result: outcome.result, nudge: outcome.nudge });
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

    // Between-iterations compaction checkpoint (all tool traffic for this
    // iteration is already in `messages`).
    await maybeCompact();
  }

  if (final === null) {
    // Iteration budget exhausted (or the loop guard halted repetition):
    // force a synthesis turn with no tools.
    const synthesisTurn = iterationCap;
    events?.onTurnStart?.(synthesisTurn);
    iterationsUsed++;
    const toolNoun = nativeEnabled ? "tool calls" : "tool blocks";
    messages.push({
      role: "user",
      content: haltReason
        ? `Do not emit any more ${toolNoun}. ${haltReason} Repetition cannot produce new evidence. Synthesize all OBSERVED / DERIVED / INFERRED evidence gathered so far into your final markdown answer now, and state clearly what remains unknown and which different tool or argument you would try next.`
        : `You have used the maximum number of tool iterations (${iterationCap}). Do not emit any more ${toolNoun}. Synthesize all OBSERVED / DERIVED / INFERRED evidence gathered so far into your final markdown answer now, and state clearly what remains unknown.`,
    });
    let synthesized: string;
    if (nativeEnabled) {
      // No schemas offered: the model cannot call tools it cannot see, so the
      // answer is prose by construction. A tool_calls response anyway means a
      // protocol-violating provider — surfaced honestly, never silently run.
      const res = await callTurnTools(llm, messages, [], synthesisTurn, events, callOpts);
      if (res.toolCalls.length > 0) {
        throw new Error(
          "Provider returned tool calls despite no tool schemas being offered — nothing was executed"
        );
      }
      synthesized = res.content;
    } else {
      synthesized = await callTurn(llm, messages, synthesisTurn, events, callOpts);
    }
    final = synthesized;
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
    // Subagent turns are NEVER persisted as chat messages — their result
    // travels back as the parent's spawn_subagent tool result.
    if (!asSubagent) {
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
            compactions: compactionCount,
          },
        });
      } catch {
        /* persistence failure must not mask the interrupting error */
      }
    }
    if (!asSubagent) {
      // Primary turn is over — never leave orphaned subagents running.
      subagentManagerFor(sessionId).cancelAll("parent turn ended (error)");
    }
    throw err;
  }

  // Final-answer integrity gate: label any simulated tool blocks that
  // survived into the final text (malformed-only messages, synthesis turns)
  // instead of letting fabricated output pass as real. Clean answers pass
  // through untouched. Subagent runs advertise only their allowlisted,
  // routable tools in the note.
  final = finalizeTurnContent(
    final,
    toolTrace,
    asSubagent
      ? availableToolNames(ctx).filter((n) => asSubagent.allowedTools.includes(n))
      : availableToolNames(ctx)
  );

  const durationMs = Date.now() - startedAt;

  // Subagent turns are NEVER persisted as chat messages — their result
  // travels back as the parent's spawn_subagent tool result.
  if (!asSubagent) {
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
          compactions: compactionCount,
        },
      });
    } catch {
      /* persistence failure must not break the stream */
    }
    // Defensive propagation: a primary turn must never leave orphaned
    // subagents running after it ends (normally there are none — every
    // spawn blocks until its subagent finishes or fails).
    subagentManagerFor(sessionId).cancelAll("parent turn ended");
  }

  return {
    content: final,
    toolCalls: toolTrace,
    usage,
    durationMs,
    modelId: llmModelId(llm),
    compactionCount,
    iterations: iterationsUsed,
  };
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

/**
 * One NATIVE tool-calling turn — same transient-failure retry discipline as
 * callTurn: a retry only happens BEFORE any content delta reached the client
 * (a retry after partial output would duplicate visible text), cancellation
 * is honored at every step and never retried. Tool-call argument fragments
 * never pass through onDelta, so accumulating them cannot corrupt the live
 * draft. No non-native fallback here: the loop only calls this when the
 * resolved LLM declared the capability.
 */
/** Exported for the native-tools regression suite. */
export async function callTurnTools(
  llm: ResolvedLlm,
  messages: LlmMessage[],
  tools: ToolSchema[],
  turn: number,
  events?: AgentEventHandlers,
  callOpts?: { onUsage?: (u: TokenUsage) => void; signal?: AbortSignal }
): Promise<LlmToolsResult> {
  if (!llm.callLLMTools) {
    throw new Error("Resolved LLM does not implement native tool calling");
  }
  let emitted = false;
  const sink = (delta: string) => {
    emitted = true;
    events?.onAssistantDelta?.(delta, turn);
  };

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= TURN_RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await llm.callLLMTools(messages, tools, sink, callOpts);
    } catch (err) {
      lastErr = err;
      const aborted =
        callOpts?.signal?.aborted ||
        (err instanceof Error && err.name === "TurnAbortedError");
      if (aborted) throw err; // a cancelled turn is never retried
      if (
        emitted ||
        !isTransientLlmError(err) ||
        attempt === TURN_RETRY_BACKOFF_MS.length
      ) {
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
