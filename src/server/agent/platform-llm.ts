import ZAI from "z-ai-web-dev-sdk";
import type { LlmMessage } from "./providers";

/**
 * Platform-provided fallback LLM (GLM via z-ai-web-dev-sdk).
 * Used when the user has not configured a BYOK provider key.
 */

type ZaiClient = Awaited<ReturnType<typeof ZAI.create>>;
const globalForZai = globalThis as unknown as { __reaZai?: ZaiClient };

async function getZai(): Promise<ZaiClient> {
  if (!globalForZai.__reaZai) {
    globalForZai.__reaZai = await ZAI.create();
  }
  return globalForZai.__reaZai;
}

export async function zaiPlatformChat(messages: LlmMessage[]): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const zai = await getZai();
      const completion = (await zai.chat.completions.create({
        messages,
        thinking: { type: "disabled" },
      })) as { choices?: Array<{ message?: { content?: string } }> };
      const text = completion?.choices?.[0]?.message?.content ?? "";
      if (typeof text === "string" && text.trim()) return text;
      lastErr = new Error("Model returned an empty completion");
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
