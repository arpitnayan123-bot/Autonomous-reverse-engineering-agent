import { db } from "@/lib/db";
import { openKey, scrubSecrets, sealKey, maskKey } from "./vault";

/**
 * BYOK provider layer — user-supplied API keys for OpenAI, Anthropic,
 * Google Gemini, DeepSeek, Kimi (Moonshot) and GLM (Z.ai).
 *
 * Every provider is normalized to the same minimal interface the ReAct loop
 * needs: `callLLM(messages) → text`. Failures are honest and scrubbed.
 */

export type ProviderId =
  | "openai"
  | "anthropic"
  | "gemini"
  | "deepseek"
  | "kimi"
  | "glm";

export interface ProviderModel {
  id: string;
  label: string;
  note?: string;
}

export interface ProviderDef {
  id: ProviderId;
  label: string;
  vendor: string;
  docsHint: string;
  keyPrefix: string;
  models: ProviderModel[];
  /**
   * Per-provider native tool-calling capability (OpenAI function-calling
   * protocol / Anthropic tool_use). Only providers with a REAL native
   * implementation in this module declare true — gemini has none yet and
   * honestly stays false. When false (or when the resolved LLM exposes no
   * callLLMTools), the agent loop transparently uses the text ```tool block
   * protocol instead. Never a simulated capability.
   */
  supportsNativeTools: boolean;
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "openai",
    label: "OpenAI",
    vendor: "openai.com",
    docsHint: "Keys start with sk-… (platform.openai.com)",
    keyPrefix: "sk-",
    supportsNativeTools: true,
    models: [
      { id: "gpt-4o-mini", label: "GPT-4o mini", note: "fast + cheap" },
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4.1", label: "GPT-4.1" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini" },
      { id: "o4-mini", label: "o4-mini", note: "reasoning" },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    vendor: "anthropic.com",
    docsHint: "Keys start with sk-ant-… (console.anthropic.com)",
    keyPrefix: "sk-ant-",
    supportsNativeTools: true,
    models: [
      { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
      { id: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku", note: "fast" },
      { id: "claude-opus-4-20250514", label: "Claude Opus 4", note: "deepest" },
    ],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    vendor: "ai.google.dev",
    docsHint: "Keys start with AIza… (aistudio.google.com)",
    keyPrefix: "AIza",
    // Honest capability boundary: no native tool-calling implementation in
    // this module yet — Gemini BYOK runs the proven text ```tool protocol.
    supportsNativeTools: false,
    models: [
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "fast" },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    vendor: "platform.deepseek.com",
    docsHint: "OpenAI-compatible endpoint",
    keyPrefix: "sk-",
    supportsNativeTools: true,
    models: [
      { id: "deepseek-chat", label: "DeepSeek V3 (chat)" },
      { id: "deepseek-reasoner", label: "DeepSeek R1 (reasoner)", note: "reasoning" },
    ],
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot)",
    vendor: "platform.moonshot.cn",
    docsHint: "OpenAI-compatible endpoint",
    keyPrefix: "sk-",
    supportsNativeTools: true,
    models: [
      { id: "moonshot-v1-8k", label: "Moonshot v1 8K" },
      { id: "moonshot-v1-32k", label: "Moonshot v1 32K" },
      { id: "moonshot-v1-128k", label: "Moonshot v1 128K" },
    ],
  },
  {
    id: "glm",
    label: "GLM (Z.ai)",
    vendor: "open.bigmodel.cn / api.z.ai",
    docsHint: "OpenAI-compatible endpoint",
    keyPrefix: "",
    supportsNativeTools: true,
    models: [
      { id: "glm-4.6", label: "GLM-4.6" },
      { id: "glm-4.5", label: "GLM-4.5" },
      { id: "glm-4.5-air", label: "GLM-4.5 Air", note: "fast" },
    ],
  },
];

export function getProviderDef(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

const REQUEST_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Unified completion calls
// ---------------------------------------------------------------------------

export interface LlmMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /**
   * assistant-only (native tool path): the tool calls the model requested in
   * this message. Serialized per provider (OpenAI tool_calls / Anthropic
   * tool_use blocks). The text protocol path never sets it.
   */
  toolCalls?: LlmToolCall[];
  /** tool-only: the id of the originating tool call this result answers. */
  toolCallId?: string;
}

/** OpenAI function-calling tool schema — the wire format for native calls. */
export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** One provider-emitted tool call, normalized across providers. */
export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /**
   * Set ONLY when the provider's serialized arguments failed JSON parsing:
   * `arguments` is then {} and the call must NOT execute — the loop answers
   * it with an honest "malformed arguments, nothing executed" tool result.
   * The raw (truncated) fragment is preserved here for the record.
   */
  malformedArguments?: string;
}

/** Result of a native tool-calling LLM turn. */
export interface LlmToolsResult {
  /** Visible text the model produced alongside (or instead of) tool calls. */
  content: string;
  toolCalls: LlmToolCall[];
}

/** Token usage as reported by a provider (all fields optional — honest unknowns). */
export interface TokenUsage {
  promptTokens?: number;
  completionTokens?: number;
}

/** Call options shared by every provider invocation. */
export interface CallOpts {
  signal?: AbortSignal;
  maxTokens?: number;
  /** Called once per LLM call when the provider reports token usage. */
  onUsage?: (usage: TokenUsage) => void;
}

/** Receives incremental text as it is produced by the provider. */
export type DeltaSink = (text: string) => void;

/**
 * Minimal SSE reader for provider streams. Calls `onEvent` for every `data:`
 * frame; returns when the stream (or `[DONE]`) ends.
 */
/** Maximum silence between provider stream chunks. Same failure class as
 * the platform path: a provider that sends headers + a few tokens and then
 * stalls keeps the socket open forever — without this deadline the turn
 * hangs silently and an intermediary proxy eventually cuts the client's SSE
 * ("lost contact mid-answer"). Any chunk resets the deadline. */
const PROVIDER_IDLE_TIMEOUT_MS = 45_000;

/** Exported for the stream-reliability regression suite. */
export async function readProviderSse(
  res: Response,
  onEvent: (data: string) => void,
  opts?: { idleTimeoutMs?: number }
): Promise<void> {
  const idleTimeoutMs = opts?.idleTimeoutMs ?? PROVIDER_IDLE_TIMEOUT_MS;
  const body = res.body;
  if (!body) throw new Error("Provider stream returned no body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      // Race each read against the idle deadline. A stalled stream leaves
      // read() pending forever; cancelling the reader does NOT unblock it —
      // only racing it out ends the turn promptly with a retryable error
      // ("timed out" is classified transient by the agent loop).
      // The result shape is deliberately flattened (done + optional value)
      // so it typechecks against BOTH the DOM lib's and bun-types' stream
      // result unions (bun-types is loaded for the bun:test suites).
      const { done, value } = await new Promise<{
        done: boolean;
        value?: Uint8Array | undefined;
      }>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn();
        };
        const timer = setTimeout(
          () =>
            finish(() => {
              void reader.cancel().catch(() => undefined);
              reject(
                new Error(
                  `Provider model stream stalled (no data for ${Math.round(idleTimeoutMs / 1000)}s) — connection timed out`
                )
              );
            }),
          idleTimeoutMs
        );
        reader.read().then(
          (v) => finish(() => resolve(v)),
          (e) => finish(() => reject(e instanceof Error ? e : new Error(String(e))))
        );
      });
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n");
      while (boundary !== -1) {
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        boundary = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        onEvent(data);
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) onEvent(tail.slice(5).trim());
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/** OpenAI-compatible chat completion (openai, deepseek, kimi, glm). */
async function openAiCompatibleChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  opts: CallOpts
): Promise<string> {
  const reportUsage = (json: unknown) => {
    const u = (json as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } })
      ?.usage;
    if (u && typeof u === "object") {
      opts.onUsage?.({
        promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
        completionTokens:
          typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
      });
    }
  };
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 4096,
      stream: false,
    }),
    signal: opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      scrubSecrets(`Provider HTTP ${res.status}: ${text.slice(0, 300)}`)
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Provider returned non-JSON response");
  }
  reportUsage(json);
  const content =
    (json as { choices?: Array<{ message?: { content?: string } }> })
      ?.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw new Error("Provider returned an empty completion");
  return content;
}

/**
 * OpenAI-compatible streaming chat completion. Returns the full text.
 * `includeUsageInBody` adds `stream_options.include_usage` (OpenAI/DeepSeek
 * support it; some stricter compatible endpoints may reject unknown params,
 * so it is opt-in per provider).
 */
async function openAiCompatibleStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  opts: CallOpts,
  onDelta: DeltaSink,
  includeUsageInBody = false
): Promise<string> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: opts.maxTokens ?? 4096,
      stream: true,
      ...(includeUsageInBody ? { stream_options: { include_usage: true } } : {}),
    }),
    signal: opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      scrubSecrets(`Provider HTTP ${res.status}: ${text.slice(0, 300)}`)
    );
  }
  let full = "";
  await readProviderSse(res, (data) => {
    if (data === "[DONE]") return;
    try {
      const json = JSON.parse(data) as {
        choices?: Array<{ delta?: { content?: string } }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        full += delta;
        onDelta(delta);
      }
      // Final frame (include_usage) carries usage with an empty choices array.
      if (json?.usage && typeof json.usage === "object") {
        opts.onUsage?.({
          promptTokens:
            typeof json.usage.prompt_tokens === "number" ? json.usage.prompt_tokens : undefined,
          completionTokens:
            typeof json.usage.completion_tokens === "number"
              ? json.usage.completion_tokens
              : undefined,
        });
      }
    } catch {
      /* ignore malformed frame */
    }
  });
  if (!full.trim()) throw new Error("Provider returned an empty completion");
  return full;
}

/** Anthropic Messages API. */
async function anthropicChat(
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  opts: CallOpts
): Promise<string> {
  const system = messages.find((m) => m.role === "assistant" && isSystemLike(m))?.content;
  const rest = messages.filter((m) => !(m.role === "assistant" && isSystemLike(m)));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 4096,
      ...(system ? { system } : {}),
      messages: rest.map((m) => ({ role: m.role, content: m.content })),
    }),
    signal: opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      scrubSecrets(`Anthropic HTTP ${res.status}: ${text.slice(0, 300)}`)
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Anthropic returned non-JSON response");
  }
  const au = (json as { usage?: { input_tokens?: unknown; output_tokens?: unknown } })?.usage;
  if (au && typeof au === "object") {
    opts.onUsage?.({
      promptTokens: typeof au.input_tokens === "number" ? au.input_tokens : undefined,
      completionTokens: typeof au.output_tokens === "number" ? au.output_tokens : undefined,
    });
  }
  const content = (json as { content?: Array<{ text?: string }> })?.content
    ?.map((c) => c.text ?? "")
    .join("\n");
  if (!content?.trim()) throw new Error("Anthropic returned an empty completion");
  return content;
}

/** Anthropic streaming Messages API. Returns the full text. */
async function anthropicStream(
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  opts: CallOpts,
  onDelta: DeltaSink
): Promise<string> {
  const system = messages.find((m) => m.role === "assistant" && isSystemLike(m))?.content;
  const rest = messages.filter((m) => !(m.role === "assistant" && isSystemLike(m)));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? 4096,
      ...(system ? { system } : {}),
      messages: rest.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    }),
    signal: opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      scrubSecrets(`Anthropic HTTP ${res.status}: ${text.slice(0, 300)}`)
    );
  }
  let full = "";
  let streamUsage: TokenUsage = {};
  await readProviderSse(res, (data) => {
    try {
      const json = JSON.parse(data) as {
        type?: string;
        delta?: { type?: string; text?: string };
        message?: { usage?: { input_tokens?: unknown; output_tokens?: unknown } };
        usage?: { output_tokens?: unknown };
      };
      if (json?.type === "content_block_delta" && typeof json.delta?.text === "string" && json.delta.text) {
        full += json.delta.text;
        onDelta(json.delta.text);
      }
      // message_start carries input tokens; message_delta carries running output.
      if (json?.type === "message_start") {
        const mu = json.message?.usage;
        if (mu && typeof mu === "object") {
          if (typeof mu.input_tokens === "number") streamUsage.promptTokens = mu.input_tokens;
          if (typeof mu.output_tokens === "number") streamUsage.completionTokens = mu.output_tokens;
        }
      }
      if (json?.type === "message_delta") {
        const du = json.usage;
        if (du && typeof du === "object" && typeof du.output_tokens === "number") {
          streamUsage.completionTokens = du.output_tokens;
        }
      }
    } catch {
      /* ignore malformed frame */
    }
  });
  if (streamUsage.promptTokens !== undefined || streamUsage.completionTokens !== undefined) {
    opts.onUsage?.(streamUsage);
  }
  if (!full.trim()) throw new Error("Anthropic returned an empty completion");
  return full;
}

/**
 * The REA loop puts the system prompt as the first 'assistant' message
 * (z-ai SDK convention). We mark it so Anthropic/Gemini can route it to
 * their native system-prompt fields.
 */
const SYSTEM_MARKER = "###SYSTEM###";
export function markSystem(content: string): string {
  return `${SYSTEM_MARKER}\n${content}`;
}
function isSystemLike(m: LlmMessage): boolean {
  return m.content.startsWith(SYSTEM_MARKER);
}
export function unmarkSystem(content: string): string {
  return content.startsWith(SYSTEM_MARKER)
    ? content.slice(SYSTEM_MARKER.length).trim()
    : content;
}

/** Gemini generateContent API. */
async function geminiChat(
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  opts: CallOpts
): Promise<string> {
  const sys = messages.find((m) => isSystemLike(m));
  const rest = messages.filter((m) => !isSystemLike(m));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      ...(sys
        ? {
            systemInstruction: {
              parts: [{ text: unmarkSystem(sys.content) }],
            },
          }
        : {}),
      contents: rest.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens: opts.maxTokens ?? 8192 },
    }),
    signal: opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      scrubSecrets(`Gemini HTTP ${res.status}: ${text.slice(0, 300)}`)
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned non-JSON response");
  }
  const gu = (
    json as {
      usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
    }
  )?.usageMetadata;
  if (gu && typeof gu === "object") {
    opts.onUsage?.({
      promptTokens: typeof gu.promptTokenCount === "number" ? gu.promptTokenCount : undefined,
      completionTokens:
        typeof gu.candidatesTokenCount === "number" ? gu.candidatesTokenCount : undefined,
    });
  }
  const content = (
    json as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    }
  )?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("");
  if (!content?.trim()) throw new Error("Gemini returned an empty completion");
  return content;
}

/** Gemini streaming generateContent (SSE). Returns the full text. */
async function geminiStream(
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  opts: CallOpts,
  onDelta: DeltaSink
): Promise<string> {
  const sys = messages.find((m) => isSystemLike(m));
  const rest = messages.filter((m) => !isSystemLike(m));
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      ...(sys
        ? {
            systemInstruction: {
              parts: [{ text: unmarkSystem(sys.content) }],
            },
          }
        : {}),
      contents: rest.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens: opts.maxTokens ?? 8192 },
    }),
    signal: opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      scrubSecrets(`Gemini HTTP ${res.status}: ${text.slice(0, 300)}`)
    );
  }
  let full = "";
  let lastUsage: TokenUsage | null = null;
  await readProviderSse(res, (data) => {
    try {
      const json = JSON.parse(data) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown };
      };
      const delta =
        json?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (delta) {
        full += delta;
        onDelta(delta);
      }
      if (json?.usageMetadata && typeof json.usageMetadata === "object") {
        lastUsage = {
          promptTokens:
            typeof json.usageMetadata.promptTokenCount === "number"
              ? json.usageMetadata.promptTokenCount
              : undefined,
          completionTokens:
            typeof json.usageMetadata.candidatesTokenCount === "number"
              ? json.usageMetadata.candidatesTokenCount
              : undefined,
        };
      }
    } catch {
      /* ignore malformed frame */
    }
  });
  if (lastUsage) opts.onUsage?.(lastUsage);
  if (!full.trim()) throw new Error("Gemini returned an empty completion");
  return full;
}

// ---------------------------------------------------------------------------
// Native tool calling — OpenAI function-calling protocol + Anthropic tool_use
// ---------------------------------------------------------------------------

/**
 * Parse a provider's serialized tool-call arguments string into a normalized
 * LlmToolCall argument payload. Empty/null arguments are a VALID no-arg call
 * (most engine tools take no arguments); anything else must parse to a JSON
 * object — arrays, scalars and unparsable fragments set malformedArguments
 * (with the raw excerpt preserved for the record) so the loop can answer the
 * call honestly without executing anything.
 */
export function coerceToolCallArguments(raw: string): {
  args: Record<string, unknown>;
  malformedArguments?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null") return { args: {} };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown> };
    }
    return { args: {}, malformedArguments: trimmed.slice(0, 200) };
  } catch {
    return { args: {}, malformedArguments: trimmed.slice(0, 200) };
  }
}

/** Shared finalization of accumulated per-call fragments into LlmToolCalls. */
function finalizeToolCallSlots(
  slots: Array<{ id: string; name: string; args: string }>
): LlmToolCall[] {
  return slots.map((slot, i) => {
    const { args, malformedArguments } = coerceToolCallArguments(slot.args);
    return {
      id: slot.id || `call_${i}`,
      name: slot.name.trim(),
      arguments: args,
      ...(malformedArguments ? { malformedArguments } : {}),
    };
  });
}

/**
 * Serialize the loop transcript for an OpenAI-compatible endpoint on the
 * native path. The loop's system prompt (first assistant message) becomes a
 * real `system` role; assistant tool-call requests become `tool_calls`
 * arrays; tool results become `role:"tool"` messages tied by tool_call_id —
 * the exact shape the function-calling protocol requires.
 */
export function openAiNativeMessages(
  messages: LlmMessage[]
): Array<Record<string, unknown>> {
  return messages.map((m, i) => {
    if (i === 0 && m.role === "assistant") {
      return { role: "system", content: unmarkSystem(m.content) };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * OpenAI-compatible native tool-calling turn (openai, deepseek, kimi, glm).
 * Streams like the text path (visible content flows through `onDelta` for
 * the live-typing effect) while accumulating streamed tool_calls fragments
 * per index; argument fragments are concatenated and JSON-parsed at the end
 * (unparsable fragments are reported via malformedArguments — never guessed).
 * Exported for the native-tools regression suite (tested against a local
 * SSE fixture server — no external network).
 */
export async function openAiCompatibleTools(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  tools: ToolSchema[],
  opts: CallOpts,
  onDelta: DeltaSink
): Promise<LlmToolsResult> {
  const body: Record<string, unknown> = {
    model,
    messages: openAiNativeMessages(messages),
    max_tokens: opts.maxTokens ?? 4096,
    stream: true,
  };
  // Omit the field entirely when no schemas are offered (synthesis turn) —
  // an empty tools array is rejected by stricter compatible endpoints.
  if (tools.length) body.tools = tools;
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      scrubSecrets(`Provider HTTP ${res.status}: ${text.slice(0, 300)}`)
    );
  }
  let content = "";
  const pending = new Map<number, { id: string; name: string; args: string }>();
  await readProviderSse(res, (data) => {
    if (data === "[DONE]") return;
    try {
      const json = JSON.parse(data) as {
        choices?: Array<{
          delta?: {
            content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      const delta = json?.choices?.[0]?.delta;
      if (typeof delta?.content === "string" && delta.content) {
        content += delta.content;
        onDelta(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const idx = typeof tc.index === "number" ? tc.index : pending.size;
        const slot = pending.get(idx) ?? { id: "", name: "", args: "" };
        if (typeof tc.id === "string" && tc.id) slot.id = tc.id;
        // `name` arrives whole on the first fragment in the standard protocol;
        // assignment (not concatenation) keeps re-sent names from doubling.
        if (typeof tc.function?.name === "string" && tc.function.name) {
          slot.name = tc.function.name;
        }
        if (typeof tc.function?.arguments === "string") {
          slot.args += tc.function.arguments;
        }
        pending.set(idx, slot);
      }
      if (json?.usage && typeof json.usage === "object") {
        opts.onUsage?.({
          promptTokens:
            typeof json.usage.prompt_tokens === "number" ? json.usage.prompt_tokens : undefined,
          completionTokens:
            typeof json.usage.completion_tokens === "number"
              ? json.usage.completion_tokens
              : undefined,
        });
      }
    } catch {
      /* ignore malformed frame */
    }
  });
  const slots = [...pending.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
  const toolCalls = finalizeToolCallSlots(slots);
  if (!content.trim() && toolCalls.length === 0) {
    throw new Error("Provider returned an empty completion");
  }
  return { content, toolCalls };
}

type AnthropicBlock = Record<string, unknown>;

/**
 * Serialize the loop transcript for the Anthropic Messages API on the native
 * path: assistant tool-call requests become text+tool_use content blocks and
 * tool results become tool_result blocks inside a user message (consecutive
 * tool results merge into ONE user turn, matching the protocol and the
 * "report all results in a single turn" execution rule).
 */
export function anthropicNativeMessages(
  messages: LlmMessage[]
): Array<{ role: "user" | "assistant"; content: string | AnthropicBlock[] }> {
  const out: Array<{ role: "user" | "assistant"; content: string | AnthropicBlock[] }> = [];
  const pushToolResult = (block: AnthropicBlock) => {
    const last = out[out.length - 1];
    if (
      last &&
      last.role === "user" &&
      Array.isArray(last.content) &&
      (last.content[0] as AnthropicBlock | undefined)?.type === "tool_result"
    ) {
      last.content.push(block);
    } else {
      out.push({ role: "user", content: [block] });
    }
  };
  for (const m of messages) {
    if (m.role === "tool") {
      pushToolResult({ type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks: AnthropicBlock[] = [];
      if (m.content.trim()) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
  }
  return out;
}

/** Anthropic native tool-calling turn (Messages API, tool_use blocks). */
export async function anthropicTools(
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  tools: ToolSchema[],
  opts: CallOpts,
  onDelta: DeltaSink
): Promise<LlmToolsResult> {
  const system = messages.find((m) => m.role === "assistant" && isSystemLike(m))?.content;
  const rest = messages.filter((m) => !(m.role === "assistant" && isSystemLike(m)));
  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 4096,
    ...(system ? { system: unmarkSystem(system) } : {}),
    messages: anthropicNativeMessages(rest),
    ...(tools.length
      ? {
          tools: tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            input_schema: t.function.parameters,
          })),
        }
      : {}),
    stream: true,
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal: opts.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      scrubSecrets(`Anthropic HTTP ${res.status}: ${text.slice(0, 300)}`)
    );
  }
  let content = "";
  const blocks = new Map<number, { id: string; name: string; args: string }>();
  let streamUsage: TokenUsage = {};
  await readProviderSse(res, (data) => {
    try {
      const json = JSON.parse(data) as {
        type?: string;
        index?: number;
        content_block?: { type?: string; id?: string; name?: string; input?: unknown };
        delta?: { type?: string; text?: string; partial_json?: string };
        message?: { usage?: { input_tokens?: unknown; output_tokens?: unknown } };
        usage?: { output_tokens?: unknown };
      };
      if (json?.type === "content_block_start" && json.content_block?.type === "tool_use") {
        blocks.set(json.index ?? blocks.size, {
          id: json.content_block.id ?? "",
          name: json.content_block.name ?? "",
          args: typeof json.content_block.input === "string" ? json.content_block.input : "",
        });
      }
      if (
        json?.type === "content_block_delta" &&
        json.delta?.type === "text_delta" &&
        typeof json.delta.text === "string" &&
        json.delta.text
      ) {
        content += json.delta.text;
        onDelta(json.delta.text);
      }
      if (
        json?.type === "content_block_delta" &&
        json.delta?.type === "input_json_delta" &&
        typeof json.delta.partial_json === "string"
      ) {
        const slot = blocks.get(json.index ?? 0);
        if (slot) slot.args += json.delta.partial_json;
      }
      if (json?.type === "message_start") {
        const mu = json.message?.usage;
        if (mu && typeof mu === "object") {
          if (typeof mu.input_tokens === "number") streamUsage.promptTokens = mu.input_tokens;
          if (typeof mu.output_tokens === "number") streamUsage.completionTokens = mu.output_tokens;
        }
      }
      if (json?.type === "message_delta") {
        const du = json.usage;
        if (du && typeof du === "object" && typeof du.output_tokens === "number") {
          streamUsage.completionTokens = du.output_tokens;
        }
      }
    } catch {
      /* ignore malformed frame */
    }
  });
  if (streamUsage.promptTokens !== undefined || streamUsage.completionTokens !== undefined) {
    opts.onUsage?.(streamUsage);
  }
  const slots = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
  const toolCalls = finalizeToolCallSlots(slots);
  if (!content.trim() && toolCalls.length === 0) {
    throw new Error("Anthropic returned an empty completion");
  }
  return { content, toolCalls };
}

/**
 * Native tool-calling completion against a concrete provider + key. Providers
 * without a native implementation (gemini — and anything unknown) throw an
 * honest capability error; the agent loop consults supportsNativeTools before
 * ever reaching this, so the throw is a defensive contract check, not a path.
 */
export async function providerChatTools(
  provider: ProviderId,
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  tools: ToolSchema[],
  onDelta: DeltaSink,
  opts: CallOpts = {}
): Promise<LlmToolsResult> {
  switch (provider) {
    case "openai":
      return openAiCompatibleTools("https://api.openai.com/v1", apiKey, model, messages, tools, opts, onDelta);
    case "deepseek":
      return openAiCompatibleTools("https://api.deepseek.com", apiKey, model, messages, tools, opts, onDelta);
    case "kimi":
      return openAiCompatibleTools("https://api.moonshot.cn/v1", apiKey, model, messages, tools, opts, onDelta);
    case "glm":
      return openAiCompatibleTools("https://api.z.ai/api/paas/v4", apiKey, model, messages, tools, opts, onDelta);
    case "anthropic":
      return anthropicTools(apiKey, model, messages, tools, opts, onDelta);
    default:
      throw new Error(
        `Provider ${provider} does not support native tool calling — the text tool-block protocol is used instead`
      );
  }
}

/** Single completion against a concrete provider + key. */
export async function providerChatComplete(
  provider: ProviderId,
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  opts: CallOpts = {}
): Promise<string> {
  // Route system-marked first message to native system fields where needed.
  const normalized: LlmMessage[] = messages.map((m, i) =>
    i === 0 && m.role === "assistant" ? { role: "assistant", content: markSystem(m.content) } : m
  );
  switch (provider) {
    case "openai":
      return openAiCompatibleChat("https://api.openai.com/v1", apiKey, model, normalized, opts);
    case "deepseek":
      return openAiCompatibleChat("https://api.deepseek.com", apiKey, model, normalized, opts);
    case "kimi":
      return openAiCompatibleChat("https://api.moonshot.cn/v1", apiKey, model, normalized, opts);
    case "glm":
      return openAiCompatibleChat("https://api.z.ai/api/paas/v4", apiKey, model, normalized, opts);
    case "anthropic":
      return anthropicChat(apiKey, model, normalized, opts);
    case "gemini":
      return geminiChat(apiKey, model, normalized, opts);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/** Streaming completion against a concrete provider + key. Returns full text. */
export async function providerChatStream(
  provider: ProviderId,
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  onDelta: DeltaSink,
  opts: CallOpts = {}
): Promise<string> {
  const normalized: LlmMessage[] = messages.map((m, i) =>
    i === 0 && m.role === "assistant" ? { role: "assistant", content: markSystem(m.content) } : m
  );
  switch (provider) {
    case "openai":
      return openAiCompatibleStream("https://api.openai.com/v1", apiKey, model, normalized, opts, onDelta, true);
    case "deepseek":
      return openAiCompatibleStream("https://api.deepseek.com", apiKey, model, normalized, opts, onDelta, true);
    case "kimi":
      return openAiCompatibleStream("https://api.moonshot.cn/v1", apiKey, model, normalized, opts, onDelta);
    case "glm":
      return openAiCompatibleStream("https://api.z.ai/api/paas/v4", apiKey, model, normalized, opts, onDelta);
    case "anthropic":
      return anthropicStream(apiKey, model, normalized, opts, onDelta);
    case "gemini":
      return geminiStream(apiKey, model, normalized, opts, onDelta);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

/** Lightweight key verification (1-token ping). */
export async function verifyProviderKey(
  provider: ProviderId,
  apiKey: string,
  model: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    await providerChatComplete(
      provider,
      apiKey,
      model,
      [{ role: "user", content: "Reply with the single word: ok" }],
      { maxTokens: 16 }
    );
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: scrubSecrets(err instanceof Error ? err.message : String(err)),
    };
  }
}

// ---------------------------------------------------------------------------
// Resolution for the agent: user's BYOK key, else platform GLM fallback.
// ---------------------------------------------------------------------------

export interface ResolvedLlm {
  source: "byok" | "platform";
  provider: ProviderId | "glm-platform";
  model: string;
  callLLM: (messages: LlmMessage[], opts?: CallOpts) => Promise<string>;
  /**
   * Streaming variant — emits incremental text via `onDelta` and resolves to
   * the full text. Falls back to `callLLM` (single delta) when the provider
   * cannot stream. The agent loop uses this for the live-typing effect.
   */
  callLLMStream?: (
    messages: LlmMessage[],
    onDelta: DeltaSink,
    opts?: CallOpts
  ) => Promise<string>;
  /**
   * Native tool-calling capability flag. Present and true ONLY when this
   * resolved LLM has a REAL callLLMTools implementation below — the agent
   * loop checks the flag (and the method's presence) to choose the native
   * function-calling protocol; anything else falls back to the text
   * ```tool block protocol. The platform GLM fallback never sets it.
   */
  supportsNativeTools?: boolean;
  /**
   * Native tool-calling turn: sends the tool schemas through the provider's
   * function-calling interface and returns the model's normalized toolCalls
   * (arguments JSON-parsed; unparsable arguments flagged — never guessed).
   * Present only alongside supportsNativeTools: true.
   */
  callLLMTools?: (
    messages: LlmMessage[],
    tools: ToolSchema[],
    onDelta: DeltaSink,
    opts?: CallOpts
  ) => Promise<LlmToolsResult>;
}

export async function resolveLlmForUser(userId: string): Promise<ResolvedLlm> {
  const record = await db.providerKey.findUnique({ where: { userId } });
  if (record) {
    const def = getProviderDef(record.provider);
    let apiKey = "";
    try {
      apiKey = openKey({
        cipher: record.keyCipher,
        iv: record.keyIv,
        tag: record.keyTag,
      });
    } catch {
      throw new Error(
        "Stored API key could not be decrypted (vault secret changed?). Re-enter your provider key in Settings."
      );
    }
    const provider = record.provider as ProviderId;
    const model = record.model;
    if (!def) throw new Error(`Unknown provider ${record.provider}`);
    // Native tool calling is advertised ONLY for providers with a real
    // implementation — the flag is the single switch the agent loop reads.
    const native = def.supportsNativeTools === true;
    return {
      source: "byok",
      provider,
      model,
      callLLM: (messages, opts) => providerChatComplete(provider, apiKey, model, messages, opts),
      callLLMStream: (messages, onDelta, opts) =>
        providerChatStream(provider, apiKey, model, messages, onDelta, opts),
      ...(native
        ? {
            supportsNativeTools: true,
            callLLMTools: (messages: LlmMessage[], tools: ToolSchema[], onDelta: DeltaSink, opts?: CallOpts) =>
              providerChatTools(provider, apiKey, model, messages, tools, onDelta, opts),
          }
        : {}),
    };
  }
  // Platform fallback (z-ai SDK, GLM) — no user key required.
  return {
    source: "platform",
    provider: "glm-platform",
    model: "glm-platform",
    callLLM: async (messages, opts) => {
      const { zaiPlatformChat } = await import("./platform-llm");
      return zaiPlatformChat(messages, opts);
    },
    callLLMStream: async (messages, onDelta, opts) => {
      const { zaiPlatformChatStream } = await import("./platform-llm");
      return zaiPlatformChatStream(messages, onDelta, opts);
    },
  };
}

export { sealKey, maskKey, scrubSecrets };
