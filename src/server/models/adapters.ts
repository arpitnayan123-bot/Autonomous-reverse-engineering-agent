import { zaiPlatformChat } from "@/server/agent/platform-llm";
import {
  getPlatformModelRow,
  isReTask,
  RE_TASKS,
  resolveModelForTask,
  setStatus,
} from "./registry";

/**
 * Inference adapter seam for the specialized RE tasks (Architecture C2).
 *
 * `suggestForTask(task, payload)` resolves the best AVAILABLE model from the
 * registry (status "available", lowest priority number) and routes the call
 * through the right adapter:
 *   - "openai-compatible"  → POST to the registered endpoint with an OpenAI
 *                            chat-completions body (temperature 0.2, 512 max
 *                            tokens) under a hard AbortController timeout;
 *   - "platform-llm"       → the platform fallback (`zaiPlatformChat`) with a
 *                            task-specific system prompt.
 *
 * Honesty rules enforced here:
 *   - an empty payload is refused outright — a model must never be asked to
 *     invent analysis output from nothing;
 *   - an observed endpoint failure flips the row to "unavailable" in the DB
 *     and the request falls back to the platform LLM with the reason recorded
 *     in the result;
 *   - every returned suggestion is provenance "INFERRED" — it came from a
 *     model, not from a verified tool run;
 *   - "local-transformers" rows are honestly declined in-process (no GPU in
 *     the platform process) WITHOUT flipping their status — the row may be
 *     valid on another runtime; the reason is recorded and we fall back.
 *
 * Testability seam (mirrors the `llmOverride` convention used across
 * src/server/agent tests): pass `platformChat` to replace the platform LLM
 * call with a stub instead of module-mocking the SDK.
 */

export interface SuggestOptions {
  /** Hard timeout applied to BOTH adapters (default 30s). */
  timeoutMs?: number;
  /** Injection seam for tests — replaces zaiPlatformChat. */
  platformChat?: PlatformChatFn;
}

export type PlatformChatFn = (
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  opts?: { signal?: AbortSignal }
) => Promise<string>;

export interface SuggestResult {
  task: string;
  model: { id: string; name: string; adapter: string };
  suggestion: string;
  provenance: "INFERRED";
  usedFallback: boolean;
  ms: number;
  /** Why the chain ended where it did (fallback reason / notes). */
  reason?: string;
}

export class SuggestError extends Error {
  constructor(
    message: string,
    /** 400 = bad input (empty payload, unknown task); 502 = all inference failed. */
    public readonly status: number = 400
  ) {
    super(message);
    this.name = "SuggestError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Adapter-level guard independent of the API route's 8000-char cap. */
const MAX_PAYLOAD_CHARS = 60_000;

// ---------------------------------------------------------------------------
// Task-specific system prompts
// ---------------------------------------------------------------------------

/**
 * One REAL prompt per task. These are the prompts the platform fallback uses,
 * and training/ scripts mirror them so a LoRA-tuned model is trained and
 * served against the same contract. Keep prompts and tasks in sync.
 */
export const TASK_PROMPTS: Record<string, string> = {
  "function-name-recovery": `You are a reverse-engineering assistant specializing in FUNCTION NAME RECOVERY.

You receive a decompiled function body (Ghidra/rizin/IDA style). The function and
its callees may carry placeholder names (FUN_14001ab2, sub_4010f0, fcn.004010f0,
thunk_FUN_..., nullsub_...). Suggest meaningful identifiers for the PLACEHOLDER
names.

Ground every suggestion ONLY in evidence visible in the input:
- how arguments are used (calling convention, count, types implied by arithmetic);
- string literals, constants and magic numbers it touches;
- library/API calls it invokes — these names are GIVEN, never invent new ones;
- control-flow shape and structure access patterns (offsets on a base pointer);
- comparisons against known OS error codes, protocol values, encodings.

Hard constraints:
- SUGGEST ONLY. You are one signal inside a larger recovery pipeline; never assert.
- NEVER invent API calls, imports, library names, file paths or hashes absent
  from the input.
- Mark uncertainty explicitly: every suggestion carries (confidence: high|medium|low).
- If the evidence supports no better name, output "UNDEFINED" for that placeholder
  instead of guessing — an honest gap beats a fabricated identifier.

Output format — one line per placeholder, nothing else:
PLACEHOLDER -> suggested_name (confidence: level) — one-line evidence-based reason`,

  "struct-reconstruction": `You are a reverse-engineering assistant specializing in STRUCT RECONSTRUCTION.

You receive decompiled code that touches memory through raw base pointers and
numeric offsets, e.g. *(undefined4 *)(param_1 + 0x10) or *(int *)(a1 + 0x18) = v3.

Reconstruct the C struct definition(s) implied by the OBSERVED offsets.

Rules:
- A field exists only if the input shows that offset being accessed. Derive its
  type from the decompiler's access type (undefined4 -> int/uint32_t,
  undefined8 -> pointer or uint64_t, undefined -> char[size]) and its usage.
- Preserve exact offsets: annotate every field with a comment, e.g.
  /* 0x10 */ int refcount; — declare explicit padding where a gap is observed.
- Declare the struct PARTIAL: never invent fields for offsets the code never
  touches; state the proven size only when the code proves it (allocation size,
  memset range, highest touched offset).
- Mark guessed types/meanings with /* UNCERTAIN */.
- stdint types are allowed; NEVER invent API calls or library types.

Output: C code only — one or more 'typedef struct { ... } name_t;' blocks with
offset comments, then a '// known offsets not covered: ...' note listing any
touched offsets you could not attribute.`,

  "decompile-cleanup": `You are a reverse-engineering assistant specializing in DECOMPILER OUTPUT CLEANUP.

You receive raw decompiled C that is correct but hard to read: junk casts
(undefined4, unknown_*), decompiler temporaries (uVar1, auStack_28), noise.

Rewrite it for a human reviewer WITHOUT changing behavior:
- Rename local variables by MEANING derived from their use (retry_count,
  entry_len, flags); keep the function's own name and parameter order untouched.
- Drop provably dead casts and pure temporaries; every branch, side effect,
  comparison and constant must survive EXACTLY as-is.
- Replace a magic number ONLY when the surrounding code forces its meaning
  (e.g. 0x1F used as a mask); leave every other constant untouched.
- Do NOT add function calls, includes, headers or library usages that are not
  in the input; do NOT speculate about API semantics.
- Where a construct is ambiguous, keep the original and add
  /* UNCERTAIN: <one line why> */.

Output: the cleaned C code in a single \`\`\`c fenced block, nothing else.`,

  "malware-triage": `You are a malware analyst assistant performing FIRST-PASS STATIC TRIAGE.

You receive evidence snippets from static analysis: strings, imports, section
names, hexdumps, or decompiled fragments. They may be tiny, partial or even
benign-looking.

Produce a triage note with EXACTLY these sections:
1. Summary — 2-4 sentences: likely capability class (loader, keylogger, C2
   beacon, ransomware, packer, installer, ...) and overall confidence.
2. Indicators — ONLY artifacts visible in the input: strings, mutexes, registry
   paths, URLs/IPs/domains, file names. Copy them verbatim; NEVER invent or
   normalize indicators that are not present.
3. Capability hypotheses — bullet list; each hypothesis MUST cite the exact
   input element supporting it (short quote). No citation, no claim.
4. What would confirm — 2-3 concrete next analysis steps.

Hard constraints: hedge family attributions ("Emotet-like" only with strong
evidence); never fabricate hashes, IPs, campaign names or victim details;
if the evidence is too thin for a capability class, say "insufficient
evidence" — that is an acceptable, honest answer.`,

  "binary-similarity": `You are a reverse-engineering assistant assessing BINARY FUNCTION SIMILARITY.

You receive one or two function descriptions (decompiled bodies, callee/caller
lists, constants, string references, structural features). Judge how likely
they represent the same original source function.

Score each dimension 0-10 with one line of evidence from the input:
- structural: basic-block shape, branch nesting, loop count;
- data: constants, magic numbers, string literals;
- call context: called/calling names (ignore placeholder names);
- semantics: what the code does end to end.

Output exactly:
similarity: <N>/100
verdict: same-function | related-variant | different | insufficient-evidence
reasons:
- <dimension>: <score>/10 — <evidence>

Hard constraints: the 0-100 score must be consistent with the dimension scores;
when the input is too partial to compare, answer insufficient-evidence instead
of guessing; never claim compiler, architecture or provenance facts that the
input does not show.`,
};

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter
// ---------------------------------------------------------------------------

/**
 * The registered endpoint should be the full chat-completions URL. For
 * convenience a bare ".../v1" base is completed with "/chat/completions"
 * (the vLLM/llama.cpp-server convention). Anything else is used verbatim.
 */
export function normalizeChatCompletionsUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/chat/completions")) return trimmed;
  if (/\/v1$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return trimmed;
}

async function callOpenAICompatible(
  model: { name: string; baseModel: string; endpoint: string },
  systemPrompt: string,
  payload: string,
  timeoutMs: number
): Promise<string> {
  const url = normalizeChatCompletionsUrl(model.endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model.baseModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: payload },
        ],
        temperature: 0.2,
        max_tokens: 512,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const bodyText = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      throw new Error(`HTTP ${res.status}${bodyText ? `: ${bodyText}` : ""}`);
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("endpoint returned no message content in choices[0].message.content");
    }
    return content;
  } catch (err) {
    if (controller.signal.aborted && !(err instanceof Error && err.message.startsWith("HTTP"))) {
      throw new Error(`endpoint did not respond within ${timeoutMs}ms (timeout)`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Platform fallback
// ---------------------------------------------------------------------------

async function callPlatform(
  task: string,
  payload: string,
  platformChat: PlatformChatFn,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const text = await platformChat(
      [
        { role: "system", content: TASK_PROMPTS[task] },
        { role: "user", content: payload },
      ],
      { signal: controller.signal }
    );
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("platform LLM returned empty output");
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// suggestForTask — the resolved-chain entry point
// ---------------------------------------------------------------------------

/**
 * Suggest for a specialized RE task via the best available registered model,
 * degrading honestly to the platform LLM.
 *
 * Chain: best "available" row (lowest priority) → on failure mark it
 * "unavailable" and use the platform LLM; no available row → platform LLM
 * directly. All failure reasons travel with the result.
 */
export async function suggestForTask(
  task: string,
  payload: string,
  opts?: SuggestOptions
): Promise<SuggestResult> {
  const t0 = Date.now();
  const platformChat = opts?.platformChat ?? zaiPlatformChat;
  const timeoutMs = Math.max(1_000, Math.min(opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, 300_000));

  // ---- honest input validation (before ANY model call) ----
  if (!isReTask(task)) {
    throw new SuggestError(
      `unknown task '${task}' — expected one of: ${RE_TASKS.join(", ")}`,
      400
    );
  }
  if (typeof payload !== "string" || !payload.trim()) {
    throw new SuggestError(
      "payload is empty — refusing to fabricate a suggestion from nothing (honest error)",
      400
    );
  }
  if (payload.length > MAX_PAYLOAD_CHARS) {
    throw new SuggestError(
      `payload too large (${payload.length} chars; adapter limit ${MAX_PAYLOAD_CHARS})`,
      400
    );
  }

  const notes: string[] = [];
  const systemPrompt = TASK_PROMPTS[task];

  const resolved = await resolveModelForTask(task).catch(() => null);

  if (resolved && resolved.adapter === "openai-compatible" && resolved.endpoint) {
    try {
      const suggestion = await callOpenAICompatible(
        { name: resolved.name, baseModel: resolved.baseModel, endpoint: resolved.endpoint },
        systemPrompt,
        payload,
        timeoutMs
      );
      return {
        task,
        model: { id: resolved.id, name: resolved.name, adapter: resolved.adapter },
        suggestion,
        provenance: "INFERRED",
        usedFallback: false,
        ms: Date.now() - t0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notes.push(
        `model '${resolved.name}' endpoint ${resolved.endpoint} failed (${msg}) — marked unavailable`
      );
      // Observed failure → the registry reflects reality for the next caller.
      await setStatus(resolved.id, "unavailable").catch(() => {});
    }
  } else if (resolved && resolved.adapter === "local-transformers") {
    // Honest decline WITHOUT a status flip: the row may be valid on a GPU
    // runtime; inside the platform process we simply cannot run it.
    notes.push(
      `model '${resolved.name}' uses adapter 'local-transformers' which cannot run inside the platform process — register an 'openai-compatible' endpoint (vLLM/llama.cpp) instead`
    );
  } else if (resolved) {
    // An operator explicitly marked a platform-llm row available → direct
    // platform use, NOT a fallback.
    try {
      const suggestion = await callPlatform(task, payload, platformChat, timeoutMs);
      return {
        task,
        model: { id: resolved.id, name: resolved.name, adapter: "platform-llm" },
        suggestion,
        provenance: "INFERRED",
        usedFallback: false,
        ms: Date.now() - t0,
      };
    } catch (err) {
      notes.push(
        `platform model '${resolved.name}' failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    notes.push(`no available model registered for task '${task}' — using platform fallback`);
  }

  // ---- platform-LLM fallback (explicitly flagged) ----
  try {
    const suggestion = await callPlatform(task, payload, platformChat, timeoutMs);
    const platformRow = await getPlatformModelRow(task).catch(() => null);
    return {
      task,
      model: {
        id: platformRow?.id ?? "platform",
        name: platformRow?.name ?? "platform-llm",
        adapter: "platform-llm",
      },
      suggestion,
      provenance: "INFERRED",
      usedFallback: true,
      ms: Date.now() - t0,
      reason: notes.join("; "),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SuggestError(
      `all inference paths failed for task '${task}': ${notes.join("; ")}; platform LLM: ${msg}`,
      502
    );
  }
}
