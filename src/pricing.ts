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
export function pricingFor(modelId: string, env?: NodeJS.ProcessEnv): ModelPricing | undefined {
  const key = normalizeModelId(modelId);
  // Operator-declared rates win: they know what they are paying, we are guessing.
  return pricingOverrides(env)[key] ?? PRICING[key];
}

/** Is this model in the table, or are we about to estimate its cost? */
export function isPricedModel(modelId: string): boolean {
  return pricingFor(modelId) !== undefined || isLocalModel(modelId);
}

/**
 * Providers that run on hardware the operator already owns, where per-token
 * cost is zero.
 *
 * This matters because the unknown-model rule below prices anything it does not
 * recognise at the HIGHEST known rate — correct for an unrecognised hosted
 * model, badly wrong for a local one. A self-hosted Ship pointed at Ollama
 * would otherwise bill itself Opus rates for free inference and refuse to
 * launch anything within an hour, which is a product that does not work for the
 * people most likely to run it. Extend with SHIP_LOCAL_MODEL_PREFIXES.
 */
const BUILTIN_LOCAL_PREFIXES = ["ollama/", "local/", "lmstudio/", "llamacpp/", "llama-cpp/", "vllm/", "localai/", "jan/"];

export function localModelPrefixes(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.SHIP_LOCAL_MODEL_PREFIXES ?? "")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== "")
    .map((p) => (p.endsWith("/") ? p : `${p}/`));
  return [...BUILTIN_LOCAL_PREFIXES, ...extra];
}

/** Does this model run on the operator's own hardware (so tokens are free)? */
export function isLocalModel(modelId: string, env?: NodeJS.ProcessEnv): boolean {
  const id = modelId.toLowerCase();
  return localModelPrefixes(env).some((prefix) => id.startsWith(prefix));
}

/**
 * Operator-declared pricing for models Ship does not ship a rate for, as JSON:
 *
 *   SHIP_MODEL_PRICING={"my-org/some-model":{"inputPer1M":2,"outputPer1M":8}}
 *
 * A product cannot know every model its users will point it at, and the answer
 * to that should be "tell me the rate", not "guess high forever".
 */
export function pricingOverrides(env: NodeJS.ProcessEnv = process.env): Record<string, ModelPricing> {
  const raw = env.SHIP_MODEL_PRICING;
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, ModelPricing> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    if (typeof v.inputPer1M !== "number" || typeof v.outputPer1M !== "number") continue;
    out[id.toLowerCase()] = {
      inputPer1M: v.inputPer1M,
      outputPer1M: v.outputPer1M,
      ...(typeof v.cacheReadPer1M === "number" ? { cacheReadPer1M: v.cacheReadPer1M } : {}),
      ...(typeof v.cacheWritePer1M === "number" ? { cacheWritePer1M: v.cacheWritePer1M } : {}),
    };
  }
  return out;
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
export function costUSD(modelId: string, usage: UsageLike | undefined, env?: NodeJS.ProcessEnv): number {
  if (usage === undefined) return 0;
  // Local inference genuinely costs nothing per token; charging it the
  // unknown-model ceiling would exhaust a self-hosted user's budget on the
  // first run for spend that never happened.
  if (isLocalModel(modelId, env)) return 0;
  const price = pricingFor(modelId, env) ?? UNKNOWN_MODEL_PRICING;
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
