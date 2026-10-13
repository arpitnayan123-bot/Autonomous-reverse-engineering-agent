import { db } from "@/lib/db";
import { MAX_CHAT_ITERATIONS } from "@/lib/security";
import { documentationPrompt, freeChatSystemPrompt, systemPrompt } from "./prompts";
import { buildTargetContext, executeAgentTool, type AgentToolContext } from "./tools";
import { resolveLlmForUser, type LlmMessage, type ResolvedLlm } from "./providers";
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
}

// ---------------------------------------------------------------------------
// LLM access — resolved per user (BYOK provider or platform fallback)
// ---------------------------------------------------------------------------

export { resolveLlmForUser } from "./providers";

// ---------------------------------------------------------------------------
// Action-block parsing
// ---------------------------------------------------------------------------

const TOOL_BLOCK_RE = /```tool\s*\r?\n([\s\S]*?)```/g;

export function parseToolAction(
  text: string
): { tool: string; args: Record<string, unknown> } | null {
  const re = new RegExp(TOOL_BLOCK_RE.source, "g"); // fresh lastIndex
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) last = m;
  if (!last) return null;
  try {
    const parsed = JSON.parse(last[1].trim()) as {
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
  let final: string | null = null;

  for (let i = 0; i < MAX_CHAT_ITERATIONS; i++) {
    if (events?.shouldCancel?.()) {
      final = "**Investigation cancelled by user.** No further tools were run after cancellation; any findings above are partial.";
      break;
    }
    events?.onTurnStart?.(i);
    const text = await callTurn(llm, messages, i, events);
    const action = parseToolAction(text);
    if (!action) {
      final = text;
      break;
    }
    if (!ctx) {
      // Free chat: the model emitted a tool block despite the system prompt.
      // Redirect once per occurrence; the iteration budget still bounds it.
      messages.push({ role: "assistant", content: text });
      messages.push({
        role: "user",
        content: `SYSTEM: Tool "${action.tool}" is unavailable in this chat because no file is attached. Do not emit tool blocks here. Answer the user directly from your own knowledge, and mention that file analysis requires uploading a file first.`,
      });
      continue;
    }
    events?.onToolCall?.(action.tool, action.args);
    const result = await executeAgentTool(action.tool, action.args, ctx);
    events?.onToolResult?.(action.tool, result);
    toolTrace.push({ tool: action.tool, args: action.args, result });
    messages.push({ role: "assistant", content: text });
    messages.push({
      role: "user",
      content: `TOOL RESULT for ${action.tool}:\n${result.slice(0, 6000)}`,
    });
  }

  if (final === null) {
    // Iteration budget exhausted: force a synthesis turn with no tools.
    const synthesisTurn = MAX_CHAT_ITERATIONS;
    events?.onTurnStart?.(synthesisTurn);
    messages.push({
      role: "user",
      content: `You have used the maximum number of tool iterations (${MAX_CHAT_ITERATIONS}). Do not emit any more tool blocks. Synthesize all OBSERVED / DERIVED / INFERRED evidence gathered so far into your final markdown answer now, and state clearly what remains unknown.`,
    });
    final = await callTurn(llm, messages, synthesisTurn, events);
  }

  try {
    await db.chatMessage.create({
      data: {
        sessionId,
        role: "assistant",
        content: final,
        toolCalls: toolTrace.length ? JSON.stringify(toolTrace) : null,
      },
    });
  } catch {
    /* persistence failure must not break the stream */
  }

  return { content: final, toolCalls: toolTrace };
}

/**
 * One LLM turn — streamed when the resolved provider supports it (falling
 * back to a single-shot call whose text is emitted as one delta).
 */
async function callTurn(
  llm: ResolvedLlm,
  messages: LlmMessage[],
  turn: number,
  events?: AgentEventHandlers
): Promise<string> {
  const sink = (delta: string) => events?.onAssistantDelta?.(delta, turn);
  if (llm.callLLMStream) {
    try {
      return await llm.callLLMStream(messages, sink);
    } catch (err) {
      // A failed stream must not kill the loop — retry once non-streamed.
      console.error("agent stream turn failed, retrying non-streamed:", err);
    }
  }
  const text = await llm.callLLM(messages);
  sink(text);
  return text;
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
