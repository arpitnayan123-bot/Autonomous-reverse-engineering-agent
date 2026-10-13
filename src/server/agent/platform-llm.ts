import ZAI from "z-ai-web-dev-sdk";
import type { DeltaSink, LlmMessage } from "./providers";

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

/**
 * Streaming platform chat. The SDK returns `Promise<any>`; with
 * `stream: true` it resolves to an async-iterable of RAW SSE byte chunks
 * (`data: {"choices":[{"delta":{"content":"…"}}]}\n\n` frames, standard
 * OpenAI delta shape). Some SDK builds may instead hand back parsed chunk
 * objects or a whole completion — every shape is handled here.
 */
export async function zaiPlatformChatStream(
  messages: LlmMessage[],
  onDelta: DeltaSink
): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const zai = await getZai();
      const result = (await zai.chat.completions.create({
        messages,
        thinking: { type: "disabled" },
        stream: true,
      })) as unknown;

      // Async-iterable stream path (raw SSE bytes, strings, or parsed chunks).
      if (
        result &&
        typeof (result as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
          "function"
      ) {
        const parser = new SseDeltaParser(onDelta);
        const decoder = new TextDecoder();
        for await (const chunk of result as AsyncIterable<unknown>) {
          if (typeof chunk === "string") {
            parser.push(chunk);
          } else if (chunk instanceof Uint8Array) {
            parser.push(decoder.decode(chunk, { stream: true }));
          } else {
            parser.pushChunkObject(chunk);
          }
        }
        parser.flush();
        const full = parser.full;
        if (full.trim()) return full;
        lastErr = new Error("Model stream produced no content");
        continue;
      }

      // Non-iterable → maybe a full completion object; else plain string.
      const asObject = result as { choices?: Array<{ message?: { content?: string } }> };
      const fullText =
        (asObject?.choices?.[0]?.message?.content ?? "") ||
        (typeof result === "string" ? result : "");
      if (fullText.trim()) {
        onDelta(fullText);
        return fullText;
      }
      lastErr = new Error("Model returned an empty completion");
    } catch (err) {
      lastErr = err;
      // Streaming may be unsupported server-side — retry once without streaming.
      try {
        const text = await zaiPlatformChat(messages);
        onDelta(text);
        return text;
      } catch (fallbackErr) {
        lastErr = fallbackErr;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Parses raw SSE text (and parsed chunk objects defensively) into delta
 * texts. Keeps a buffer across chunk boundaries so frames split across
 * Uint8Array chunks are handled correctly.
 */
class SseDeltaParser {
  private buffer = "";
  private fullText = "";
  constructor(private readonly onDelta: DeltaSink) {}

  get full(): string {
    return this.fullText;
  }

  push(text: string): void {
    this.buffer += text;
    // SSE frames are separated by a blank line; process every complete line.
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      this.pushJson(data);
    }
  }

  /** For SDK builds that already parse each chunk into an object. */
  pushChunkObject(chunk: unknown): void {
    const delta = extractDelta(chunk);
    if (delta) {
      this.fullText += delta;
      this.onDelta(delta);
    }
  }

  private pushJson(data: string): void {
    try {
      const json = JSON.parse(data) as unknown;
      const delta = extractDelta(json);
      if (delta) {
        this.fullText += delta;
        this.onDelta(delta);
      }
    } catch {
      /* ignore malformed frame */
    }
  }

  flush(): void {
    // Handle a trailing frame without a final newline.
    const line = this.buffer.trim();
    this.buffer = "";
    if (line.startsWith("data:")) {
      const data = line.slice(5).trim();
      if (data && data !== "[DONE]") this.pushJson(data);
    }
  }
}

/** OpenAI-style chunk → delta text (defensive across SDK shapes). */
function extractDelta(chunk: unknown): string {
  if (chunk === null || chunk === undefined) return "";
  if (typeof chunk === "string") return chunk;
  if (typeof chunk !== "object") return "";
  const c = chunk as {
    choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
  };
  const delta = c.choices?.[0]?.delta?.content ?? c.choices?.[0]?.message?.content ?? "";
  return typeof delta === "string" ? delta : "";
}
