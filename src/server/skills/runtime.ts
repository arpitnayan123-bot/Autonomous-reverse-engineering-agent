/**
 * Skill runtime — THE SANDBOX (Capability C5).
 *
 * A skill run is a CONSTRAINED agent run. Nothing here reuses the free agent
 * loop: the loop below is a simple deterministic protocol so every guarantee
 * is local and auditable:
 *
 *  (a) TOOL PERMISSIONS — a tool executes only if its name is in
 *      manifest.permissions AND exists in the agent registry (the two are
 *      intersected up front; a permission naming no real tool is dead).
 *  (b) REGISTRY EXISTENCE — execution goes through the same registry tools
 *      the chat agent uses (executeAgentTool / runFreeChatTool), never a
 *      skill-provided function — a manifest is pure JSON, there is nothing
 *      to execute but prompts.
 *  (c) CALL BUDGET — at most manifest.limits.toolCalls executed calls per
 *      run; further requests are refused (visible to the model, audited).
 *  (d) RESULT CAP — every tool result is truncated to 3000 chars before it
 *      can re-enter the model context or the returned transcript.
 *  (e) WALL CLOCK — the whole run is bounded by manifest.limits.timeoutMs
 *      (5s-120s): every LLM turn and every tool call is raced against the
 *      remaining time, and the deadline is re-checked before each call.
 *  (f) AUDIT — every tool call AND its result are written to the audit log
 *      (via @/lib/security audit()), alongside run start/complete events.
 *
 * The model-facing protocol is text, not native function calling: the system
 * prompt lists the EXACT allowed tools (manifest ∩ registry) and instructs
 * the model to emit `TOOL_CALL <toolName> <json-args-on-one-line>` lines.
 * Parsing is strict; malformed lines are refused with an honest error the
 * model can correct. A reply with no TOOL_CALL lines ends the run as the
 * final answer.
 *
 * A skill can never escalate beyond the invoking user's scope: target-
 * scoped registry tools require a target OWNED by the invoking user (loaded
 * here and passed as ctx.target); workspace tools run in a fresh per-run
 * workspace session id. The manifest's permissions cannot grant anything
 * the registry does not already expose to that user.
 */

import { db } from "@/lib/db";
import { audit } from "@/lib/security";
import {
  AGENT_TOOLS,
  executeAgentTool,
  runFreeChatTool,
  type AgentTool,
  type AgentToolContext,
} from "@/server/agent/tools";
import { zaiPlatformChat, type PlatformMessage } from "@/server/agent/platform-llm";
import { validateManifest, type SkillManifest } from "./manifest";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap for one tool result re-entering the model context (spec d). */
export const SKILL_TOOL_RESULT_MAX_CHARS = 3000;
/** Hard cap for the question text. */
const QUESTION_MAX_CHARS = 4000;
/** Safety ceiling on loop iterations (each executed call needs ≥1 turn). */
const ITERATION_HEADROOM = 6;

const TOOL_CALL_LINE_RE =
  /^\s*(?:[-*+>]\s*)?TOOL_CALL\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(\{.*\})?\s*;?\s*$/;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Carries an HTTP-ish status so the API route can map it cleanly. */
export class SkillRunError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "SkillRunError";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillToolReceipt {
  tool: string;
  args: Record<string, unknown>;
  /** Wall-clock duration of the execution in ms. */
  ms: number;
  /** Length of the (possibly truncated) result in chars. */
  chars: number;
  /** true when the tool ran and returned; false for refusals/errors. */
  ok: boolean;
  /** true when the call was refused BEFORE execution (permission/budget/time). */
  refused: boolean;
  /** Refusal or error text (always present when ok === false). */
  error?: string;
  /** The executed tool's (3000-char-truncated) result — the exact text the
   * model saw, also surfaced in the returned transcript as a receipt. */
  result?: string;
}

export interface SkillRunResult {
  slug: string;
  version: string;
  checksum: string;
  answer: string;
  toolCalls: SkillToolReceipt[];
  iterations: number;
  truncated: boolean;
  timedOut: boolean;
  /** Human-readable audit trail — mirrors what was written to the AuditLog. */
  auditTrail: string[];
}

export interface RunSkillOptions {
  userId: string;
  question: string;
  /** Optional owned target to attach (enables target-scoped registry tools). */
  targetId?: string;
  /**
   * Registry override (testing). Defaults to the live AGENT_TOOLS registry —
   * imported directly (tools.ts does not import skills/*, so there is no
   * import cycle).
   */
  tools?: AgentTool[];
}

// ---------------------------------------------------------------------------
// Permission enforcement (exported — unit-testable WITHOUT any LLM call)
// ---------------------------------------------------------------------------

/**
 * Intersect the manifest's permissions with a registry. `allowed` is the
 * executable surface of the run; `unknown` are permissions that name no real
 * tool (reported honestly to the author, never executed).
 */
export function filterAllowedTools(
  manifest: SkillManifest,
  registry: readonly AgentTool[]
): { allowed: AgentTool[]; unknown: string[] } {
  const allowed: AgentTool[] = [];
  const unknown: string[] = [];
  for (const name of manifest.permissions) {
    const tool = registry.find((t) => t.name === name);
    if (tool) allowed.push(tool);
    else unknown.push(name);
  }
  return { allowed, unknown };
}

/**
 * Enforce ONE tool call against the manifest BEFORE any execution:
 * (a) the tool must be in manifest.permissions, (b) it must exist in the
 * registry. Returns the tool or a precise refusal string.
 */
export function resolveSkillTool(
  manifest: SkillManifest,
  registry: readonly AgentTool[],
  toolName: string
): { ok: true; tool: AgentTool } | { ok: false; error: string } {
  if (!manifest.permissions.includes(toolName)) {
    return {
      ok: false,
      error: `refused: tool "${toolName}" is NOT in this skill's manifest permissions (allowed: ${
        manifest.permissions.length ? manifest.permissions.join(", ") : "(none)"
      })`,
    };
  }
  const tool = registry.find((t) => t.name === toolName);
  if (!tool) {
    return {
      ok: false,
      error: `refused: tool "${toolName}" is permitted by the manifest but does not exist in the agent registry`,
    };
  }
  return { ok: true, tool };
}

// ---------------------------------------------------------------------------
// Protocol parsing
// ---------------------------------------------------------------------------

export interface ParsedModelReply {
  /** TOOL_CALL lines that parsed (name + args object). */
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  /** Malformed TOOL_CALL lines with the reason they were refused. */
  malformed: Array<{ tool: string; error: string }>;
}

/** Parse `TOOL_CALL <tool> <json>` lines out of a model reply. */
export function parseToolCalls(text: string): ParsedModelReply {
  const calls: ParsedModelReply["calls"] = [];
  const malformed: ParsedModelReply["malformed"] = [];
  for (const line of text.split("\n")) {
    const m = TOOL_CALL_LINE_RE.exec(line);
    if (!m) continue;
    const tool = m[1];
    const rawArgs = m[2];
    if (!rawArgs || rawArgs.trim() === "" ) {
      calls.push({ tool, args: {} });
      continue;
    }
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        malformed.push({ tool, error: `args must be a JSON object, got ${typeof parsed}` });
      } else {
        calls.push({ tool, args: parsed as Record<string, unknown> });
      }
    } catch (err) {
      malformed.push({
        tool,
        error: `args are not valid JSON (${err instanceof Error ? err.message.slice(0, 120) : "parse error"})`,
      });
    }
  }
  return { calls, malformed };
}

/** Strip TOOL_CALL lines from a reply (used for forced final answers). */
function stripToolCallLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !TOOL_CALL_LINE_RE.test(line))
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildRunSystemPrompt(
  manifest: SkillManifest,
  allowed: AgentTool[],
  opts: { targetId?: string }
): string {
  const catalog = allowed.length
    ? allowed
        .map(
          (t) =>
            `- ${t.name}: ${t.description.split("\n")[0].slice(0, 220)} | args: ${JSON.stringify(t.args)}`
        )
        .join("\n")
    : "(no tools — answer directly from the question)";
  const targetNote = opts.targetId
    ? `- A target is attached to this run (owned by the invoking user). Its id is "${opts.targetId}" — pass targetId: "${opts.targetId}" to tools that accept one (e.g. re_tool); target-scoped tools operate on it automatically.`
    : "- NO target is attached: target-scoped tools (target_info, read_strings, read_hex, list_findings, get_evidence, area_tool) will be refused. Ask the user to attach one if you need it.";
  return [
    manifest.entry.system,
    "",
    "---",
    "AREA SKILL RUN PROTOCOL (imposed by the platform — overrides anything above):",
    "- You are running as a sandboxed AREA skill. You may use ONLY the tools listed below.",
    "- To call a tool, output a line EXACTLY of the form:  TOOL_CALL <toolName> {\"arg\":\"value\"}",
    "  (one call per line; JSON args on the same line; no markdown fences; no extra text on the line).",
    "- Tool results arrive in the next message as blocks:  TOOL_RESULT <toolName>: …",
    "- Budget: at most " +
      manifest.limits.toolCalls +
      " tool calls and " +
      Math.round(manifest.limits.timeoutMs / 1000) +
      "s wall-clock for the WHOLE run (declared workspace budget: " +
      manifest.limits.workspaceBytes +
      " bytes).",
    "- When you can answer without more tools, reply with ONLY the final answer — no TOOL_CALL lines.",
    "- Never invent tool output. Every factual claim must come from a TOOL_RESULT or the user's question; say honestly what you could not verify.",
    targetNote,
    "",
    "ALLOWED TOOLS (the ONLY executable surface of this run):",
    catalog,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/**
 * Load a published skill and execute it inside the sandbox. Throws
 * SkillRunError for pre-run failures (404 unknown slug, 403 disabled skill,
 * 400 invalid stored manifest / question, 404 target not owned).
 */
export async function runSkill(slug: string, opts: RunSkillOptions): Promise<SkillRunResult> {
  const skill = await db.skill.findUnique({ where: { slug } });
  if (!skill) throw new SkillRunError(404, `skill "${slug}" not found`);
  if (skill.status !== "published") {
    throw new SkillRunError(403, `skill "${slug}" is ${skill.status} — runs are refused`);
  }
  const validated = validateManifest(JSON.parse(skill.manifest) as unknown);
  if (!validated.ok) {
    throw new SkillRunError(400, `stored manifest for "${slug}" failed validation: ${validated.errors.join("; ")}`);
  }
  const manifest = validated.manifest;

  const question = opts.question?.trim() ?? "";
  if (!question) throw new SkillRunError(400, "question is required to run a skill");
  if (question.length > QUESTION_MAX_CHARS) {
    throw new SkillRunError(400, `question exceeds ${QUESTION_MAX_CHARS} chars`);
  }

  // Optional target: OWNERSHIP IS ENFORCED — a skill never sees another
  // user's target even if its manifest lists target-scoped tools.
  let target: AgentToolContext["target"] | null = null;
  if (opts.targetId) {
    const t = await db.target.findUnique({ where: { id: opts.targetId } });
    if (!t || t.userId !== opts.userId) {
      throw new SkillRunError(404, `target "${opts.targetId}" not found in your workspace (ownership is enforced)`);
    }
    target = t;
  }

  const registry = opts.tools ?? AGENT_TOOLS;
  const { allowed } = filterAllowedTools(manifest, registry);

  // Fresh, filesystem-safe session id per run: workspace tools get an
  // isolated workspace, and the retry-dedup cache never leaks across runs.
  const sessionId = `skill-${manifest.slug}-${crypto.randomUUID().slice(0, 8)}`;
  const toolCtx: AgentToolContext = target
    ? { target, userId: opts.userId, sessionId }
    : ({ target: null, userId: opts.userId, sessionId } as unknown as AgentToolContext);

  const startedAt = Date.now();
  const deadline = startedAt + manifest.limits.timeoutMs;
  const auditTrail: string[] = [];
  const receipts: SkillToolReceipt[] = [];
  let timedOut = false;
  let truncated = false;
  let iterations = 0;
  let usedCalls = 0;

  const trail = (line: string) => auditTrail.push(`[${new Date().toISOString()}] ${line}`);

  trail(`run start slug=${manifest.slug} version=${manifest.version} tools=${allowed.map((t) => t.name).join(",") || "(none)"} target=${opts.targetId ?? "-"}`);
  void audit("skill.run", {
    userId: opts.userId,
    detail: `slug=${manifest.slug} version=${manifest.version} target=${opts.targetId ?? "-"} question="${question.slice(0, 200)}"`,
  });

  const messages: PlatformMessage[] = [
    { role: "system", content: buildRunSystemPrompt(manifest, allowed, { targetId: opts.targetId }) },
    { role: "user", content: question },
  ];

  /**
   * One LLM turn, raced against the remaining wall-clock. Resolves null
   * exactly when the deadline fired (timedOut set); throws on provider
   * errors (callers decide how much of the transcript to salvage).
   */
  const llmTurn = async (): Promise<string | null> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      timedOut = true;
      return null;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutP = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), remaining);
    });
    try {
      const text = await Promise.race([zaiPlatformChat(messages), timeoutP]);
      if (text === null) timedOut = true;
      return text;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /**
   * Execute ONE parsed tool call under the full sandbox: (a)+(b) via
   * resolveSkillTool, (c) budget enforced by the caller, per-call wall-clock
   * race against the remaining run budget, try/catch mirroring
   * executeAgentTool's never-throw contract, (d) 3000-char truncation, (f)
   * audit of the call AND the result.
   */
  const execCall = async (toolName: string, args: Record<string, unknown>): Promise<SkillToolReceipt> => {
    const callStarted = Date.now();
    const argsPreview = JSON.stringify(args ?? {}) ?? "{}";
    trail(`tool_call ${toolName} args=${argsPreview.slice(0, 300)}`);
    void audit("skill.tool_call", {
      userId: opts.userId,
      detail: `slug=${manifest.slug} tool=${toolName} args=${argsPreview.slice(0, 500)}`,
    });

    const resolved = resolveSkillTool(manifest, registry, toolName);
    if (!resolved.ok) {
      trail(`tool_refused ${toolName}: ${resolved.error}`);
      void audit("skill.tool_refused", { userId: opts.userId, detail: `slug=${manifest.slug} ${resolved.error}`, severity: "warn" });
      return { tool: toolName, args, ms: 0, chars: 0, ok: false, refused: true, error: resolved.error };
    }
    const tool = resolved.tool;

    // Target-scoped tools are useless (and would crash on ctx.target.id)
    // without a target — refuse BEFORE executing, honestly.
    if (tool.scope === "target" && !target) {
      const error = `refused: tool "${toolName}" requires an attached target — re-run the skill with a targetId`;
      trail(`tool_refused ${toolName}: ${error}`);
      void audit("skill.tool_refused", { userId: opts.userId, detail: `slug=${manifest.slug} ${error}`, severity: "warn" });
      return { tool: toolName, args, ms: 0, chars: 0, ok: false, refused: true, error };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      timedOut = true;
      const error = "refused: the skill run's wall-clock budget expired before this call";
      trail(`tool_refused ${toolName}: ${error}`);
      return { tool: toolName, args, ms: 0, chars: 0, ok: false, refused: true, error };
    }

    const remainingAtStart = remaining;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutP = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            timedOut: true,
          }),
        remaining
      );
    });
    const execP = (async (): Promise<{ text: string }> => {
      try {
        // Route EXACTLY like the chat agent does: "any"-scoped tools go
        // through the free-chat dispatcher (workspace/memory/web/re_tools
        // routing with their own refusals), target-scoped ones through the
        // registry executor (dedup + truncation + honest error strings).
        const text =
          tool.scope === "any"
            ? await runFreeChatTool(toolName, args ?? {}, { sessionId, userId: opts.userId })
            : await executeAgentTool(toolName, args ?? {}, toolCtx);
        return { text };
      } catch (err) {
        // executeAgentTool never throws; belt-and-braces for direct run().
        return {
          text: `Error running tool ${toolName}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    })();
    try {
      const outcome = await Promise.race([execP, timeoutP]);
      if (timer) clearTimeout(timer);
      if ("timedOut" in outcome) {
        timedOut = true;
        const error = `refused: tool "${toolName}" exceeded the skill run's remaining time budget (${remainingAtStart}ms) and was abandoned — partial output discarded`;
        trail(`tool_timeout ${toolName} after ${Date.now() - callStarted}ms`);
        void audit("skill.tool_refused", {
          userId: opts.userId,
          detail: `slug=${manifest.slug} tool=${toolName} wall-clock budget exhausted`,
          severity: "warn",
        });
        return { tool: toolName, args, ms: Date.now() - callStarted, chars: 0, ok: false, refused: true, error };
      }
      const result = outcome.text.slice(0, SKILL_TOOL_RESULT_MAX_CHARS);
      const ms = Date.now() - callStarted;
      const ok = !/^(error|refused)/i.test(result);
      trail(`tool_result ${toolName} ok=${ok} ms=${ms} chars=${result.length}`);
      void audit("skill.tool_result", {
        userId: opts.userId,
        detail: `slug=${manifest.slug} tool=${toolName} ok=${ok} ms=${ms} chars=${result.length}${ok ? "" : ` head=${result.slice(0, 200)}`}`,
        severity: ok ? "info" : "warn",
      });
      usedCalls += 1;
      return {
        tool: toolName,
        args,
        ms,
        chars: result.length,
        ok,
        refused: false,
        result,
        ...(ok ? {} : { error: result }),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  // --- the loop ------------------------------------------------------------
  let answer = "";
  let forcedFinal = false;
  const maxIterations = manifest.limits.toolCalls + ITERATION_HEADROOM;

  try {
    while (iterations < maxIterations) {
      iterations += 1;
      const text = await llmTurn();
      if (timedOut) {
        truncated = true;
        answer = `${text ?? ""}\n\n[Run stopped: the ${Math.round(manifest.limits.timeoutMs / 1000)}s wall-clock budget expired]`.trim();
        break;
      }
      if (text === null || !text.trim()) {
        truncated = true;
        answer = answer || "[The model returned an empty reply — no answer was produced]";
        break;
      }

      const parsed = parseToolCalls(text);

      if (parsed.calls.length === 0 && parsed.malformed.length === 0) {
        answer = text.trim();
        break;
      }

      if (forcedFinal) {
        // Budget was exhausted and the model was told to answer NOW — any
        // further TOOL_CALL lines are stripped and the run ends honestly.
        const hadCalls = parsed.calls.length > 0 || parsed.malformed.length > 0;
        answer = stripToolCallLines(text) || "[The model had no final answer]";
        if (hadCalls) {
          truncated = true;
          answer += "\n\n[Tool-call budget exhausted before the model finished its plan — the answer may be incomplete]";
        }
        break;
      }

      messages.push({ role: "assistant", content: text });
      const blocks: string[] = [];

      for (const malformed of parsed.malformed) {
        blocks.push(`TOOL_RESULT ${malformed.tool}: REFUSED — ${malformed.error}. Re-emit the line as: TOOL_CALL ${malformed.tool} {"arg":"value"}`);
      }
      for (const call of parsed.calls) {
        if (Date.now() >= deadline) {
          timedOut = true;
          break;
        }
        if (usedCalls >= manifest.limits.toolCalls) {
          blocks.push(
            `TOOL_RESULT ${call.tool}: REFUSED — the tool-call budget of ${manifest.limits.toolCalls} for this run is exhausted. Reply with your FINAL ANSWER now, without TOOL_CALL lines.`
          );
          forcedFinal = true;
          continue;
        }
        const receipt = await execCall(call.tool, call.args);
        receipts.push(receipt);
        if (receipt.refused) {
          blocks.push(`TOOL_RESULT ${call.tool}: ${receipt.error}`);
        } else if (receipt.ok) {
          blocks.push(`TOOL_RESULT ${call.tool}:\n${receipt.result}`);
        } else {
          blocks.push(`TOOL_RESULT ${call.tool}: Error — ${receipt.error}`);
        }
      }

      if (timedOut) {
        truncated = true;
        answer = `[Run stopped: the ${Math.round(manifest.limits.timeoutMs / 1000)}s wall-clock budget expired mid-execution]`;
        break;
      }

      messages.push({ role: "user", content: blocks.join("\n\n") });
    }

    if (iterations >= maxIterations && !answer) {
      truncated = true;
      answer =
        "[Run stopped: the iteration safety ceiling was reached without a final answer — this indicates the model kept requesting tools beyond its budget]";
    }
  } catch (err) {
    // Provider failure mid-run: salvage the transcript instead of throwing
    // away executed tool work — the caller gets an honest partial result.
    truncated = true;
    answer =
      (answer ? `${answer}\n\n` : "") +
      `[Run failed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}]`;
  }

  const ms = Date.now() - startedAt;
  trail(`run complete ms=${ms} toolCalls=${receipts.filter((r) => !r.refused).length}/${manifest.limits.toolCalls} truncated=${truncated} timedOut=${timedOut}`);
  void audit("skill.run.complete", {
    userId: opts.userId,
    detail: `slug=${manifest.slug} ms=${ms} toolCalls=${receipts.filter((r) => !r.refused).length} truncated=${truncated} timedOut=${timedOut}`,
  });

  return {
    slug: manifest.slug,
    version: manifest.version,
    checksum: skill.checksum,
    answer: answer.trim(),
    toolCalls: receipts,
    iterations,
    truncated,
    timedOut,
    auditTrail,
  };
}
