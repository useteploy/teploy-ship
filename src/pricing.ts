/**
 * Static per-model list prices, USD per 1,000,000 tokens. Used to turn a
 * run's recorded token usage into a dollar cost so the worker can enforce
 * spend-based daily caps alongside the count-based one.
 *
 * These are list prices captured statically (not fetched) — good enough
 * for a safety cap, never billed off. Keys are the bare model id with the
 * `provider/` prefix stripped (see {@link costUSD}); add or override an
 * entry when a new model shows up in testing.
 *
 * Cache accounting note: the additive formula below charges input +
 * output + cache-read + cache-write independently. That matches
 * Anthropic's line-item accounting (cached tokens are billed separately
 * and are NOT part of inputTokens). For OpenAI-style providers, where the
 * cached portion is a discounted subset already counted in inputTokens,
 * this slightly over-counts the cached tokens — a conservative bias for a
 * spend cap (we'd refuse a hair early, never late).
 */
export interface ModelPricing {
  /** USD per 1M input (uncached) tokens. */
  inputPer1M: number;
  /** USD per 1M output tokens. */
  outputPer1M: number;
  /** USD per 1M cache-read tokens (where the provider prices them). */
  cacheReadPer1M?: number;
  /** USD per 1M cache-write tokens (Anthropic prompt-cache writes). */
  cacheWritePer1M?: number;
}

/** The subset of a usage record cost cares about; all fields optional. */
export interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// Anthropic cache rates follow the published multipliers: cache-read is
// 0.1x input, cache-write (5-minute TTL) is 1.25x input. OpenAI/Gemini/
// DeepSeek list a discounted cached-input rate and no separate write.
export const PRICING: Record<string, ModelPricing> = {
  // Anthropic — Claude
  "claude-opus-5": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4-8": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4-7": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4-6": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-opus-4-5": { inputPer1M: 5, outputPer1M: 25, cacheReadPer1M: 0.5, cacheWritePer1M: 6.25 },
  "claude-sonnet-5": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  "claude-sonnet-4-6": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  "claude-sonnet-4-5": { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 },
  "claude-haiku-4-5": { inputPer1M: 1, outputPer1M: 5, cacheReadPer1M: 0.1, cacheWritePer1M: 1.25 },
  "claude-fable-5": { inputPer1M: 10, outputPer1M: 50, cacheReadPer1M: 1, cacheWritePer1M: 12.5 },

  // OpenAI — GPT / o-series (cacheRead = discounted cached input, no write charge)
  "gpt-5": { inputPer1M: 1.25, outputPer1M: 10, cacheReadPer1M: 0.125 },
  "gpt-5-mini": { inputPer1M: 0.25, outputPer1M: 2, cacheReadPer1M: 0.025 },
  "gpt-5-nano": { inputPer1M: 0.05, outputPer1M: 0.4, cacheReadPer1M: 0.005 },
  "gpt-4.1": { inputPer1M: 2, outputPer1M: 8, cacheReadPer1M: 0.5 },
  "gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6, cacheReadPer1M: 0.1 },
  "gpt-4.1-nano": { inputPer1M: 0.1, outputPer1M: 0.4, cacheReadPer1M: 0.025 },
  "gpt-4o": { inputPer1M: 2.5, outputPer1M: 10, cacheReadPer1M: 1.25 },
  "gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6, cacheReadPer1M: 0.075 },
  "o3": { inputPer1M: 2, outputPer1M: 8, cacheReadPer1M: 0.5 },
  "o4-mini": { inputPer1M: 1.1, outputPer1M: 4.4, cacheReadPer1M: 0.275 },

  // Google — Gemini
  "gemini-2.5-pro": { inputPer1M: 1.25, outputPer1M: 10, cacheReadPer1M: 0.31 },
  "gemini-2.5-flash": { inputPer1M: 0.3, outputPer1M: 2.5, cacheReadPer1M: 0.075 },
  "gemini-2.5-flash-lite": { inputPer1M: 0.1, outputPer1M: 0.4, cacheReadPer1M: 0.025 },
  "gemini-2.0-flash": { inputPer1M: 0.1, outputPer1M: 0.4, cacheReadPer1M: 0.025 },

  // DeepSeek (cacheRead = cache-hit input rate)
  "deepseek-chat": { inputPer1M: 0.27, outputPer1M: 1.1, cacheReadPer1M: 0.07 },
  "deepseek-reasoner": { inputPer1M: 0.55, outputPer1M: 2.19, cacheReadPer1M: 0.14 },
};

/** Normalize a model id to a pricing-table key: drop any `provider/` prefix, lowercase. */
function normalizeModelId(modelId: string): string {
  const slash = modelId.lastIndexOf("/");
  return (slash >= 0 ? modelId.slice(slash + 1) : modelId).toLowerCase();
}

/** Look up a model's pricing, tolerating a `provider/` prefix. Undefined for unknown models. */
export function pricingFor(modelId: string): ModelPricing | undefined {
  return PRICING[normalizeModelId(modelId)];
}

/** Is this model in the table, or are we about to estimate its cost? */
export function isPricedModel(modelId: string): boolean {
  return pricingFor(modelId) !== undefined;
}

/**
 * The rate used for a model the table does not know: the most expensive entry
 * on every axis.
 *
 * This exists because the spend cap is a SAFETY control, and the old behaviour
 * — unknown model costs $0 — made it fail OPEN. A newly released model, a
 * gateway alias, a revision suffix, or a typo in SHIP_MODEL would burn real
 * provider spend while Ship recorded nothing and kept auto-launching. Guessing
 * high can only refuse work early, which is the recoverable direction; guessing
 * zero removes the cap entirely.
 */
export const UNKNOWN_MODEL_PRICING: ModelPricing = (() => {
  const entries = Object.values(PRICING);
  return {
    inputPer1M: Math.max(...entries.map((p) => p.inputPer1M)),
    outputPer1M: Math.max(...entries.map((p) => p.outputPer1M)),
    cacheReadPer1M: Math.max(...entries.map((p) => p.cacheReadPer1M ?? 0)),
    cacheWritePer1M: Math.max(...entries.map((p) => p.cacheWritePer1M ?? 0)),
  };
})();

/**
 * Dollar cost of a run/step from its usage. An unknown model is priced at
 * {@link UNKNOWN_MODEL_PRICING} rather than free — see the note there. Absent
 * usage is genuinely 0. Never throws; it is called on the enforcement path.
 *
 * Callers that want to SHOW the number should also check {@link isPricedModel}
 * and mark it as an estimate.
 */
export function costUSD(modelId: string, usage: UsageLike | undefined): number {
  if (usage === undefined) return 0;
  const price = pricingFor(modelId) ?? UNKNOWN_MODEL_PRICING;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const perToken =
    input * price.inputPer1M +
    output * price.outputPer1M +
    cacheRead * (price.cacheReadPer1M ?? 0) +
    cacheWrite * (price.cacheWritePer1M ?? 0);
  return perToken / 1_000_000;
}
