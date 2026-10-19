/**
 * Durable park-and-retry for provider rate limits (2026-10-19 SWE-bench
 * finding): 34 of 100 Verified runs ended `status=error`, every one with
 * `Step "turn-N-think" failed: [1302][Rate limit reached for requests][<id>]`
 * from z.ai's Anthropic-compatible coding-plan endpoint — 13 of them on turn
 * 0, before the agent had done anything at all. Provider rate limits, not
 * model quality, cost about a third of the score, and the same failure mode
 * kills production runs whenever several lanes share one coding-plan key.
 *
 * The in-call retry (provider.ts withRetry) exhausts itself in ~30s, which
 * covers a blip but not an outage window. This module is the layer above it:
 * when a THINK step's model call still fails with a rate-limit/overloaded
 * classification after those retries, the run does NOT fail — it PARKS, the
 * engine's own sleeping suspension, and wakes with bounded exponential
 * backoff until the provider lets it through or a per-run wait ceiling is
 * crossed.
 *
 * DETERMINISM — the decision to wait is a fact of the log, three times over:
 *   1. The classification is computed INSIDE the step body and returned as a
 *      marker on the step's recorded result (never thrown past the step, where
 *      only the message text would survive and a status-only 429 would
 *      classify differently on replay than it did live). A replay reads the
 *      marker back verbatim.
 *   2. The park itself is `ctx.sleep` — the engine records `sleep-started`
 *      with its `until`, and a replay consumes exactly one recorded sleep per
 *      loop iteration, so the iteration count replays identically.
 *   3. The WAIT CEILING rides on the run input (materialised at enqueue from
 *      SHIP_RATE_LIMIT_MAX_WAIT_MIN), like the recovery thresholds: a worker
 *      whose env disagrees with the recording worker's must not decide a
 *      different turn to fail on — that is a live nondeterminism bug, not a
 *      tuning difference. The schedule constants below are code: editing them
 *      under in-flight parked runs is the same deploy-fence no-no as editing
 *      defaultRecoveryConfig.
 *
 * The extra events only ever appear on a path that previously ended the run
 * outright (a think step throwing past its retries), so no in-flight log
 * replays differently and no step NAME changes — the fingerprint is untouched.
 */
import type { WorkflowContext } from "@neutron-build/workflow";

import { classifyFailure } from "./model-routing-policy.js";
import type { FailureClass } from "./model-routing-policy.js";
import { retryDelayMsFromError } from "./provider.js";

/** The park schedule: first wait 60s, double each park, cap a single wait at 10m. */
export const RATE_LIMIT_PARK_FIRST_MS = 60_000;
export const RATE_LIMIT_PARK_MAX_DELAY_MS = 600_000;

/** The default per-run ceiling on total rate-limit waiting: 60 minutes. */
export const DEFAULT_RATE_LIMIT_MAX_WAIT_MS = 60 * 60_000;

export interface RateLimitParkTuning {
  /**
   * How long this run may spend parked on provider rate limits in total,
   * across every park of every think step. Crossing it fails the run with a
   * message that names the provider error and the ceiling.
   */
  maxTotalWaitMs: number;
}

/**
 * The per-run wait budget recorded on the run input. A `false` is the
 * explicit opt-out (fail exactly as runs did before the park existed);
 * ABSENT means the default — which is what every log written before this
 * field carries, and none of those can hold a park.
 */
export type RateLimitParkInput = RateLimitParkTuning | false;

export const DEFAULT_RATE_LIMIT_PARK: RateLimitParkTuning = { maxTotalWaitMs: DEFAULT_RATE_LIMIT_MAX_WAIT_MS };

/** The wait before park `attempt` (1-based), honouring a provider Retry-After when it asks for longer. */
export function parkDelayMs(attempt: number, retryAfterMs?: number): number {
  const scheduled = Math.min(RATE_LIMIT_PARK_FIRST_MS * 2 ** Math.max(0, attempt - 1), RATE_LIMIT_PARK_MAX_DELAY_MS);
  return Math.min(Math.max(scheduled, retryAfterMs ?? 0), RATE_LIMIT_PARK_MAX_DELAY_MS);
}

/** The per-run ceiling from SHIP_RATE_LIMIT_MAX_WAIT_MIN (minutes). Unset or garbage is the default. */
export function rateLimitParkFromEnv(env: NodeJS.ProcessEnv = process.env): RateLimitParkTuning {
  const raw = Number(env.SHIP_RATE_LIMIT_MAX_WAIT_MIN);
  return {
    maxTotalWaitMs: Number.isFinite(raw) && raw > 0 ? Math.round(raw * 60_000) : DEFAULT_RATE_LIMIT_MAX_WAIT_MS,
  };
}

/**
 * The field to stamp into a run input at enqueue: the materialised ceiling,
 * or an explicit `false` under SHIP_RATE_LIMIT_PARK=0. Always stamped by
 * enqueueRun so a replay reads the ceiling from its own log.
 */
export function rateLimitParkInput(env: NodeJS.ProcessEnv = process.env): { rateLimitPark: RateLimitParkInput } {
  const off = (env.SHIP_RATE_LIMIT_PARK ?? "").trim().toLowerCase();
  return { rateLimitPark: off === "0" || off === "false" || off === "no" || off === "off" ? false : rateLimitParkFromEnv(env) };
}

/**
 * What a rate-limited think step records INSTEAD of failing: the marker the
 * park loop reads back on replay. `parked` is the discriminant — a plain
 * think result never carries it.
 */
export interface RateLimitParked {
  parked: "rate-limit";
  /** "rate-limit" or "overloaded" — the classification the live error got. */
  class: FailureClass;
  /** The provider's own message, kept for the run page, the log and the failure at the ceiling. */
  message: string;
  /** A provider Retry-After, when the error exposed one (provider.ts retryDelayMsFromError). */
  retryAfterMs?: number;
}

/** The classes worth parking on: the provider is telling us to come back later. */
const PARKABLE: ReadonlySet<FailureClass> = new Set(["rate-limit", "overloaded"]);

/**
 * Classify a LIVE model error into a park marker, or null when the failure is
 * not the provider's congestion (wrong key, oversize prompt, bug — parking
 * would only delay the real failure).
 */
export function rateLimitMarkerOf(error: unknown): RateLimitParked | null {
  const cls = classifyFailure(error);
  if (!PARKABLE.has(cls)) return null;
  const retryAfterMs = retryDelayMsFromError(error);
  return {
    parked: "rate-limit",
    class: cls,
    message: error instanceof Error ? error.message : String(error),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/** Is this recorded step result a rate-limit park marker? */
export function isRateLimitParked(value: unknown): value is RateLimitParked {
  return (
    typeof value === "object" && value !== null && (value as { parked?: unknown }).parked === "rate-limit"
  );
}

/** The failure message once the per-run wait ceiling is crossed. */
export function rateLimitCeilingMessage(stepName: string, waitedMs: number, maxTotalWaitMs: number, message: string): string {
  return (
    `model step "${stepName}" was still being rate-limited by the provider after waiting ` +
    `${Math.round(waitedMs / 60_000)}m (the run's ${Math.round(maxTotalWaitMs / 60_000)}m rate-limit wait ceiling, ` +
    `SHIP_RATE_LIMIT_MAX_WAIT_MIN): ${message}. The provider did not let the run through within the budget; ` +
    `raise the ceiling, spread the runs over more keys, or retry when the quota resets.`
  );
}

/** What `onPark` is told, once per wait. */
export interface RateLimitParkNotice {
  /** 1-based: the first park, then the second, ... */
  attempt: number;
  delayMs: number;
  /** The wait including this park — the number the ceiling is measured against. */
  waitedMs: number;
  maxTotalWaitMs: number;
  class: FailureClass;
  message: string;
}

/**
 * Wrap a think step's body so a rate-limit failure becomes its RECORDED
 * RESULT instead of a thrown error: the marker is what the park loop (and a
 * replay) reads, so the classification is a fact of the log rather than a
 * live-only property of the exception object (whose status, unlike its
 * message, the engine does not record).
 */
export async function markingRateLimits<T>(body: () => Promise<T>): Promise<T | RateLimitParked> {
  try {
    return await body();
  } catch (error) {
    const marker = rateLimitMarkerOf(error);
    if (marker !== null) return marker;
    throw error;
  }
}

/**
 * Run a think step under the rate-limit park: `run` executes the recorded
 * step (its `.step(` call site stays in durable.ts, where the fingerprint's
 * static extraction reads the literal name — this module holds no step call
 * of its own, so it is correctly invisible to WORKFLOW_STEP_MODULES), with
 * `markingRateLimits` inside it, and this loop parks and retries while the
 * marker keeps coming back.
 *
 * The classification happens inside the step body so the recorded result —
 * marker or real — is the whole of what a replay reads; the loop then sleeps
 * (the engine's own suspension, recorded as `sleep-started` with its `until`)
 * and retries the SAME step name, so the log reads
 * [step-completed(marker), sleep-started, ... , step-completed(result)] and a
 * replay walks exactly that. Cancellation is the engine's: the retried step's
 * live boundary throws Cancellation when a cancel landed while the run slept,
 * so a cancelled run never wakes into more model spend.
 */
export async function withRateLimitPark<T>(
  ctx: Pick<WorkflowContext, "sleep">,
  options: {
    stepName: string;
    park: RateLimitParkInput;
    /** The recorded step, body wrapped in `markingRateLimits`. */
    run: () => Promise<T | RateLimitParked>;
    onPark?: (notice: RateLimitParkNotice) => void;
  },
): Promise<T> {
  const { stepName } = options;
  if (options.park === false) {
    // Opted out: the historical fail-fast. markingRateLimits still converted
    // a rate limit into a marker inside the step, so convert it BACK to a
    // throw here — the run fails with the provider's own message, exactly as
    // it did before the park existed.
    const result = await options.run();
    if (isRateLimitParked(result)) throw new Error(result.message);
    return result as T;
  }
  const { maxTotalWaitMs } = options.park;
  let waitedMs = 0;
  let attempt = 0;
  for (;;) {
    const result = await options.run();
    if (!isRateLimitParked(result)) return result as T;
    attempt += 1;
    const delayMs = parkDelayMs(attempt, result.retryAfterMs);
    if (waitedMs + delayMs > maxTotalWaitMs) {
      throw new Error(rateLimitCeilingMessage(stepName, waitedMs, maxTotalWaitMs, result.message));
    }
    waitedMs += delayMs;
    options.onPark?.({ attempt, delayMs, waitedMs, maxTotalWaitMs, class: result.class, message: result.message });
    await ctx.sleep(delayMs);
  }
}
