/**
 * Rough per-model pricing (USD per 1M tokens) for BYOK cost estimation.
 *
 * Values are approximate public list prices for estimation only — actual bills
 * vary by endpoint, caching and discounts. Everything surfaced in the UI is
 * labeled "est." and must never be presented as an exact charge.
 */

export interface PricingEntry {
  /** USD per 1M input (prompt) tokens. */
  in: number;
  /** USD per 1M output (completion) tokens. */
  out: number;
}

/** Exact/fallback pricing table, keyed by model id (case-insensitive). */
export const MODEL_PRICING: Record<string, PricingEntry> = {
  // OpenAI
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "o4-mini": { in: 1.1, out: 4.4 },
  // Anthropic
  "claude-sonnet-4-20250514": { in: 3, out: 15 },
  "claude-3-5-haiku-20241022": { in: 0.8, out: 4 },
  "claude-opus-4-20250514": { in: 15, out: 75 },
  // Gemini
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.5-pro": { in: 1.25, out: 10 },
  "gemini-2.0-flash": { in: 0.1, out: 0.4 },
  // DeepSeek
  "deepseek-chat": { in: 0.27, out: 1.1 },
  "deepseek-reasoner": { in: 0.55, out: 2.19 },
  // Kimi / Moonshot
  "moonshot-v1-8k": { in: 0.15, out: 0.6 },
  "moonshot-v1-32k": { in: 0.24, out: 0.96 },
  "moonshot-v1-128k": { in: 0.6, out: 2.4 },
  // GLM / Z.ai (also the platform default)
  "glm-4.6": { in: 0.6, out: 2.2 },
  "glm-4.5": { in: 0.6, out: 2.2 },
  "glm-4.5-air": { in: 0.2, out: 0.3 },
  "glm-platform": { in: 0.6, out: 2.2 },
};

/** Model-id prefixes tried (in order) when the exact id has no entry. */
const PREFIX_FALLBACKS = [
  "claude-sonnet",
  "claude-opus",
  "claude-3-5-haiku",
  "claude-haiku",
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1-mini",
  "gpt-4.1",
  "o4-mini",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "deepseek-chat",
  "deepseek-reasoner",
  "moonshot-v1-128k",
  "moonshot-v1-32k",
  "moonshot-v1-8k",
  "glm-4.5-air",
  "glm-4.5",
  "glm-4.6",
  "glm-platform",
];

/** Look up pricing for a model id (exact match, then prefix heuristic). */
export function lookupPricing(model: string | null | undefined): PricingEntry | null {
  if (!model) return null;
  const id = model.toLowerCase().trim();
  const exact = MODEL_PRICING[id];
  if (exact) return exact;
  // Common vendor prefixes like "anthropic/claude-…", "openai/gpt-…"
  const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  if (bare !== id && MODEL_PRICING[bare]) return MODEL_PRICING[bare];
  for (const prefix of PREFIX_FALLBACKS) {
    if (bare.startsWith(prefix)) return MODEL_PRICING[prefix];
  }
  return null;
}

/**
 * Estimated cost in USD for one turn, or null when the model is unknown.
 * Returns 0 only when both token counts are 0.
 */
export function estimateCostUsd(
  model: string | null | undefined,
  tokensIn: number | null | undefined,
  tokensOut: number | null | undefined
): number | null {
  const pricing = lookupPricing(model);
  if (!pricing) return null;
  if (tokensIn == null && tokensOut == null) return null;
  const cost =
    ((tokensIn ?? 0) / 1_000_000) * pricing.in + ((tokensOut ?? 0) / 1_000_000) * pricing.out;
  return cost;
}

/** Human format for tiny USD amounts: $0.42, $0.0042, <$0.0001. */
export function formatCostUsd(cost: number | null): string {
  if (cost == null) return "";
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.0001) {
    // Trim to 4 significant decimals, drop trailing zeros.
    return `$${cost.toFixed(4).replace(/0+$/, "")}`;
  }
  return "<$0.0001";
}
