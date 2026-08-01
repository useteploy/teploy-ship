import type { ModelAdapter } from "@neutron-build/ai";

/**
 * Ship-level retry policy around a model adapter.
 *
 * Ship delegated every call straight to the SDK and had no position of its own
 * on what happens when a provider rate-limits, returns a 5xx, or drops the
 * connection — so a transient blip failed a durable run that had already spent
 * real money on the turns before it. In a durable workflow that is expensive:
 * the run is recoverable, but only by a human noticing and resuming it.
 *
 * Deliberately NOT a fallback to a different model. A fallback would change the
 * model mid-run, which breaks two things Ship depends on: replay determinism
 * (the recorded step came from a different model than the one now configured)
 * and benchmark validity (a scorecard that silently mixes models measures
 * nothing). Retrying the SAME model is safe; substituting one is a decision for
 * the operator, not the transport.
 */
export interface RetryPolicy {
  /** Attempts in total, including the first. */
  attempts: number;
  /** First backoff step, doubled each attempt. */
  baseDelayMs: number;
  maxDelayMs: number;
}

export const defaultRetryPolicy: RetryPolicy = {
  attempts: 4,
  baseDelayMs: 1000,
  maxDelayMs: 20_000,
};

/**
 * Is this worth trying again?
 *
 * Retrying a permanent error wastes the budget and delays the real failure, so
 * the default is NO: only errors that name a transient condition come back.
 * A context-length error is explicitly not retryable — the same request will
 * fail identically, and condensation is what addresses it.
 */
export function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number; statusCode?: number } | null)?.status ??
    (error as { statusCode?: number } | null)?.statusCode;
  if (typeof status === "number") {
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (/context length|context_length|too many tokens|maximum context/.test(message)) return false;
  if (/invalid[_ ]api[_ ]key|unauthorized|forbidden|not found/.test(message)) return false;
  return /rate.?limit|429|overload|timeout|timed out|econnreset|econnrefused|etimedout|socket hang up|network|temporarily|503|502|504/.test(
    message,
  );
}

export function backoffFor(attempt: number, policy: RetryPolicy): number {
  return Math.min(policy.baseDelayMs * 2 ** Math.max(0, attempt - 1), policy.maxDelayMs);
}

/**
 * Wrap an adapter so transient provider failures are retried with backoff.
 *
 * The adapter interface is preserved exactly, so this composes with the gateway
 * wiring and with whatever the SDK does internally — this is Ship's own policy
 * layer, sitting above it.
 */
export function withRetry(
  model: ModelAdapter,
  policy: RetryPolicy = defaultRetryPolicy,
  options: { log?: (line: string) => void; sleep?: (ms: number) => Promise<void> } = {},
): ModelAdapter {
  const log = options.log ?? (() => {});
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const attempt = async <T>(what: string, call: () => Promise<T>): Promise<T> => {
    let lastError: unknown;
    for (let n = 1; n <= policy.attempts; n++) {
      try {
        return await call();
      } catch (error) {
        lastError = error;
        if (n === policy.attempts || !isRetryable(error)) break;
        const delay = backoffFor(n, policy);
        log(
          `[model] ${what} failed (attempt ${n}/${policy.attempts}), retrying in ${delay}ms: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        await sleep(delay);
      }
    }
    throw lastError;
  };

  return {
    ...model,
    provider: model.provider,
    modelId: model.modelId,
    doGenerate: (opts) => attempt("generate", () => model.doGenerate(opts)),
    doStream: model.doStream.bind(model),
  } as ModelAdapter;
}
