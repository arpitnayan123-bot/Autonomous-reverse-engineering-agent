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
}

export const PROVIDERS: ProviderDef[] = [
  {
    id: "openai",
    label: "OpenAI",
    vendor: "openai.com",
    docsHint: "Keys start with sk-… (platform.openai.com)",
    keyPrefix: "sk-",
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
  role: "user" | "assistant";
  content: string;
}

interface CallOpts {
  signal?: AbortSignal;
  maxTokens?: number;
}

/** OpenAI-compatible chat completion (openai, deepseek, kimi, glm). */
async function openAiCompatibleChat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: LlmMessage[],
  opts: CallOpts
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
  const content =
    (json as { choices?: Array<{ message?: { content?: string } }> })
      ?.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw new Error("Provider returned an empty completion");
  return content;
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
  const content = (json as { content?: Array<{ text?: string }> })?.content
    ?.map((c) => c.text ?? "")
    .join("\n");
  if (!content?.trim()) throw new Error("Anthropic returned an empty completion");
  return content;
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
    return {
      source: "byok",
      provider,
      model,
      callLLM: (messages, opts) => providerChatComplete(provider, apiKey, model, messages, opts),
    };
  }
  // Platform fallback (z-ai SDK, GLM) — no user key required.
  return {
    source: "platform",
    provider: "glm-platform",
    model: "glm-platform",
    callLLM: async (messages) => {
      const { zaiPlatformChat } = await import("./platform-llm");
      return zaiPlatformChat(messages);
    },
  };
}

export { sealKey, maskKey, scrubSecrets };
