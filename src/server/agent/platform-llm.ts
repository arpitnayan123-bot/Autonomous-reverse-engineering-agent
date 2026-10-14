import ZAI from "z-ai-web-dev-sdk";
import type { CallOpts, DeltaSink, LlmMessage, TokenUsage } from "./providers";

/**
 * Platform-provided fallback LLM (GLM via z-ai-web-dev-sdk).
 * Used when the user has not configured a BYOK provider key.
 */

type ZaiClient = Awaited<ReturnType<typeof ZAI.create>>;
const globalForZai = globalThis as unknown as { __reaZai?: ZaiClient };

/** Hard ceiling for one platform LLM call — a hung SDK call must not stall
 * the SSE turn (and the billable stream) forever. */
const PLATFORM_CALL_TIMEOUT_MS = 120_000;

/** Maximum silence between stream chunks. A provider stream that sends
 * headers + a few tokens and then stalls keeps the socket open forever;
 * without this watchdog the turn hangs silently and an intermediary proxy
 * eventually cuts the client's SSE connection ("lost contact mid-answer").
 * A TOTAL timeout would kill legitimately long answers — this is an IDLE
 * timeout: any chunk resets it. */
export const STREAM_IDLE_TIMEOUT_MS = 45_000;

/**
 * The SDK bakes the Bearer key from /etc/.z-ai-config into the client at
 * ZAI.create(). The platform ROTATES that key file — a client cached forever
 * keeps sending a stale token and the model rejects every call with
 * "status 401/403" until a server restart. So: short TTL re-read + hard
 * drop on auth-shaped errors (the retry loop then recreates the client).
 */
const ZAI_CLIENT_TTL_MS = 60_000;
let zaiClientAt = 0;

async function getZai(): Promise<ZaiClient> {
  const cached = globalForZai.__reaZai;
  if (cached && Date.now() - zaiClientAt < ZAI_CLIENT_TTL_MS) return cached;
  globalForZai.__reaZai = await ZAI.create();
  zaiClientAt = Date.now();
  return globalForZai.__reaZai;
}

function dropZaiClient(): void {
  globalForZai.__reaZai = undefined;
  zaiClientAt = 0;
}

/** Detect credential/permission rejections from the model API (the SDK
 * throws `API request failed with status <code>: <body>`). */
function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /\b(401|403)\b|unauthorized|forbidden|invalid[ _-]?(api[ _-]?key|token|credential)|authentication/i.test(
    msg
  );
}

/**
 * Thrown when the turn is cancelled — after the viewer-decoupling fix the
 * only sources are an explicit user stop or the turn safety deadline, so the
 * message states that honestly instead of blaming the connection.
 */
export class TurnAbortedError extends Error {
  constructor(message = "Turn cancelled by user") {
    super(message);
    this.name = "TurnAbortedError";
  }
}

/**
 * Consume a raw model stream (async-iterable of SSE strings / bytes / parsed
 * chunks) into deltas — with the protections the bare `for await` lacked:
 * an IDLE-stall watchdog (no chunk for idleTimeoutMs → close the iterator and
 * throw a retryable stall error) and prompt abort handling even while the
 * stream is silent (a bare per-chunk aborted check never fires during a
 * stall). Aborting is never retried; a stall is (callTurn treats it as
 * transient and the platform fallback regenerates the full answer).
 */
export async function consumeModelStream(
  result: unknown,
  onDelta: DeltaSink,
  opts?: { signal?: AbortSignal; idleTimeoutMs?: number; onUsage?: (u: TokenUsage) => void }
): Promise<string> {
  const idleTimeoutMs = opts?.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  const usageRef: { value: TokenUsage | null } = { value: null };
  if (
    !result ||
    typeof (result as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function"
  ) {
    throw new Error("Model stream is not an async iterable");
  }
  const iterator = (result as AsyncIterable<unknown>)[Symbol.asyncIterator]();
  const parser = new SseDeltaParser(onDelta, (u) => {
    usageRef.value = u;
  });
  const decoder = new TextDecoder();

  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const clearWatchdog = () => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  };

  /**
   * Race `iterator.next()` against the idle deadline and the abort signal.
   * This is the core fix: a stalled upstream stream leaves `next()` pending
   * forever, and closing the iterator does NOT unblock it — only racing it
   * out guarantees the turn ends promptly with a retryable error instead of
   * hanging silently until some proxy cuts the client's connection.
   */
  const nextWithWatchdog = (): Promise<IteratorResult<unknown>> =>
    new Promise<IteratorResult<unknown>>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearWatchdog();
        opts?.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = () => finish(() => reject(new TurnAbortedError()));
      opts?.signal?.addEventListener("abort", onAbort, { once: true });
      watchdog = setTimeout(
        () =>
          finish(() =>
            reject(
              new Error(
                `Platform model stream stalled (no data for ${Math.round(idleTimeoutMs / 1000)}s) — connection timed out`
              )
            )
          ),
        idleTimeoutMs
      );
      iterator.next().then(
        (v) => finish(() => resolve(v)),
        (e) => finish(() => reject(e instanceof Error ? e : new Error(String(e))))
      );
    });

  try {
    for (;;) {
      if (opts?.signal?.aborted) throw new TurnAbortedError();
      const next = await nextWithWatchdog();
      if (next.done) break;
      const chunk = next.value;
      if (typeof chunk === "string") parser.push(chunk);
      else if (chunk instanceof Uint8Array) parser.push(decoder.decode(chunk, { stream: true }));
      else parser.pushChunkObject(chunk);
    }
    parser.flush();
  } finally {
    clearWatchdog();
    try {
      // Tell the upstream SDK to release the underlying connection.
      void iterator.return?.(undefined);
    } catch {
      /* already closed */
    }
  }
  if (usageRef.value && opts?.onUsage) opts.onUsage(usageRef.value);
  return parser.full;
}

/**
 * Race a promise against (a) the request abort signal and (b) a timeout.
 * The underlying SDK call cannot be cancelled, but the turn ends promptly
 * instead of hanging; the orphaned result is simply discarded.
 */
function withTimeoutAndAbort<T>(
  p: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TurnAbortedError());
      return;
    }
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      done(() =>
        reject(
          new Error(
            `Platform model did not respond within ${Math.round(timeoutMs / 1000)}s`
          )
        )
      );
    }, timeoutMs);
    const onAbort = () => done(() => reject(new TurnAbortedError()));
    signal?.addEventListener("abort", onAbort);
    p.then(
      (v) => done(() => resolve(v)),
      (e) => done(() => reject(e instanceof Error ? e : new Error(String(e))))
    );
  });
}

/** Platform messages may carry native system prompts (GLM supports them). */
export type PlatformMessage =
  | LlmMessage
  | { role: "system"; content: string };

/** The z-ai SDK chat API accepts these roles only. */
type PlatformChatMessage = { role: "user" | "assistant" | "system"; content: string };

/**
 * Normalize loop messages for the platform SDK. The platform fallback NEVER
 * runs the native tool path (resolveLlmForUser sets no supportsNativeTools),
 * so role:"tool" and assistant toolCalls must not occur here; if a future
 * caller sends one anyway it degrades into an explicitly labeled user
 * message instead of an opaque SDK type rejection — nothing is dropped.
 */
function toPlatformMessages(messages: PlatformMessage[]): PlatformChatMessage[] {
  return messages.map((m) => {
    if (m.role === "user" || m.role === "assistant" || m.role === "system") {
      return { role: m.role, content: m.content };
    }
    const callId = "toolCallId" in m && m.toolCallId ? ` (call ${m.toolCallId})` : "";
    return { role: "user", content: `TOOL RESULT${callId}:\n${m.content}` };
  });
}

export async function zaiPlatformChat(
  messages: PlatformMessage[],
  opts?: CallOpts
): Promise<string> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (opts?.signal?.aborted) throw new TurnAbortedError();
    try {
      const zai = await getZai();
      const completion = await withTimeoutAndAbort(
        zai.chat.completions.create({
          messages: toPlatformMessages(messages),
          thinking: { type: "disabled" },
        }) as Promise<
          { choices?: Array<{ message?: { content?: string } }> } & {
            usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
          }
        >,
        opts?.signal,
        PLATFORM_CALL_TIMEOUT_MS
      );
      if (completion?.usage && typeof completion.usage === "object" && opts?.onUsage) {
        opts.onUsage({
          promptTokens:
            typeof completion.usage.prompt_tokens === "number"
              ? completion.usage.prompt_tokens
              : undefined,
          completionTokens:
            typeof completion.usage.completion_tokens === "number"
              ? completion.usage.completion_tokens
              : undefined,
        });
      }
      const text = completion?.choices?.[0]?.message?.content ?? "";
      if (typeof text === "string" && text.trim()) return text;
      lastErr = new Error("Model returned an empty completion");
    } catch (err) {
      lastErr = err;
      // Stale platform credentials → drop the cached client so attempt 2
      // re-reads /etc/.z-ai-config and comes back with a fresh key.
      if (isAuthError(err)) dropZaiClient();
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
  onDelta: DeltaSink,
  opts?: CallOpts
): Promise<string> {
  const usageRef: { value: TokenUsage | null } = { value: null };
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (opts?.signal?.aborted) throw new TurnAbortedError();
    try {
      const zai = await getZai();
      const result = await withTimeoutAndAbort(
        zai.chat.completions.create({
          messages: toPlatformMessages(messages),
          thinking: { type: "disabled" },
          stream: true,
        }) as Promise<unknown>,
        opts?.signal,
        PLATFORM_CALL_TIMEOUT_MS
      );

      // Async-iterable stream path (raw SSE bytes, strings, or parsed chunks)
      // consumed through the stall/abort-watched helper.
      const iterable =
        !!result &&
        typeof (result as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
          "function";
      if (iterable) {
        const full = await consumeModelStream(result, onDelta, {
          signal: opts?.signal,
          onUsage: (u) => {
            usageRef.value = u;
          },
        });
        if (full.trim()) {
          if (usageRef.value) opts?.onUsage?.(usageRef.value);
          return full;
        }
        lastErr = new Error("Model stream produced no content");
        continue;
      }

      // Non-iterable → maybe a full completion object; else plain string.
      const asObject = result as { choices?: Array<{ message?: { content?: string } }> } & {
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      const fullText =
        (asObject?.choices?.[0]?.message?.content ?? "") ||
        (typeof result === "string" ? result : "");
      if (fullText.trim()) {
        if (asObject?.usage && typeof asObject.usage === "object" && opts?.onUsage) {
          opts.onUsage({
            promptTokens:
              typeof asObject.usage.prompt_tokens === "number"
                ? asObject.usage.prompt_tokens
                : undefined,
            completionTokens:
              typeof asObject.usage.completion_tokens === "number"
                ? asObject.usage.completion_tokens
                : undefined,
          });
        }
        onDelta(fullText);
        return fullText;
      }
      lastErr = new Error("Model returned an empty completion");
    } catch (err) {
      // A cancelled turn is never retried.
      if (err instanceof TurnAbortedError) throw err;
      lastErr = err;
      // Stale platform credentials → drop the cached client before any retry.
      if (isAuthError(err)) dropZaiClient();
      // Streaming may be unsupported server-side — retry once without streaming.
      try {
        const text = await zaiPlatformChat(messages, opts);
        onDelta(text);
        return text;
      } catch (fallbackErr) {
        if (fallbackErr instanceof TurnAbortedError) throw fallbackErr;
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
  constructor(
    private readonly onDelta: DeltaSink,
    private readonly onUsage?: (usage: TokenUsage) => void
  ) {}

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
    this.extractUsage(chunk);
  }

  private pushJson(data: string): void {
    try {
      const json = JSON.parse(data) as unknown;
      const delta = extractDelta(json);
      if (delta) {
        this.fullText += delta;
        this.onDelta(delta);
      }
      this.extractUsage(json);
    } catch {
      /* ignore malformed frame */
    }
  }

  /** OpenAI-shaped usage frame (final stream chunk / completion object). */
  private extractUsage(chunk: unknown): void {
    if (!chunk || typeof chunk !== "object" || !this.onUsage) return;
    const u = (chunk as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } })
      .usage;
    if (!u || typeof u !== "object") return;
    const usage: TokenUsage = {
      promptTokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : undefined,
      completionTokens:
        typeof u.completion_tokens === "number" ? u.completion_tokens : undefined,
    };
    if (usage.promptTokens !== undefined || usage.completionTokens !== undefined) {
      this.onUsage(usage);
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
