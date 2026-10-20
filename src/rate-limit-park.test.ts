import assert from "node:assert/strict";
import { test } from "node:test";

import { Suspension, isSuspension } from "@neutron-build/workflow";
import type { WorkflowContext } from "@neutron-build/workflow";

import {
  DEFAULT_RATE_LIMIT_MAX_WAIT_MS,
  RATE_LIMIT_PARK_MAX_DELAY_MS,
  isRateLimitParked,
  markingRateLimits,
  newParkLedger,
  parkDelayMs,
  rateLimitCeilingMessage,
  rateLimitMarkerOf,
  rateLimitParkFromEnv,
  rateLimitParkInput,
  withRateLimitPark,
} from "./rate-limit-park.js";
import { classifyFailure } from "./model-routing-policy.js";

/**
 * The smallest context the park loop needs, shaped like the ENGINE's sleep
 * at the LIVE FRONTIER: the wait is recorded, then the pass suspends —
 * `ctx.sleep` throws Suspension("sleeping") and executeRun ends the pass.
 * One withRateLimitPark call therefore covers exactly one live park; a
 * multi-park sequence is multiple calls (the wake passes), the way the
 * worker and runDurable actually drive it. The marker-under-the-step
 * behaviour is what the durable tests exercise against the real engine;
 * here we pin the LOOP: delays, the RUN-level ceiling, narration, opt-out.
 */
function liveCtx(): { ctx: Pick<WorkflowContext, "sleep">; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    ctx: {
      async sleep(duration: number | string): Promise<void> {
        sleeps.push(typeof duration === "number" ? duration : Number.NaN);
        throw new Suspension("sleeping", {});
      },
    },
  };
}

/**
 * The engine's sleep on REPLAY: a recorded, COMPLETED sleep is consumed by
 * ctx.sleep RETURNING (ReplayContext hands back once sleep-completions
 * outnumber consumed sleeps). A whole recorded park sequence replays inside
 * one call — which is exactly how a terminal run's full replay walks it.
 */
function replayCtx(): { ctx: Pick<WorkflowContext, "sleep">; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    ctx: {
      async sleep(duration: number | string): Promise<void> {
        sleeps.push(typeof duration === "number" ? duration : Number.NaN);
      },
    },
  };
}

/** The durable.ts call shape: ctx.step(name, () => markingRateLimits(body)), faked. */
function stepped<T>(body: () => Promise<T>): () => Promise<T | import("./rate-limit-park.js").RateLimitParked> {
  return async () => markingRateLimits(body);
}

const ZAI_1302 = () => Object.assign(new Error("[1302][Rate limit reached for requests][req-8f3a1c]"), { problem: { status: 429 } });

test("the park schedule: 60s, 2m, 4m, 8m, then capped at 10m", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map((n) => parkDelayMs(n)),
    [60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000],
  );
  // A provider Retry-After longer than the schedule lengthens the park, up to
  // the same cap.
  assert.equal(parkDelayMs(1, 5 * 60_000), 5 * 60_000);
  assert.equal(parkDelayMs(1, 60 * 60_000), RATE_LIMIT_PARK_MAX_DELAY_MS, "an hour-long Retry-After is capped at one 10m park");
  assert.equal(parkDelayMs(3, 1000), 240_000, "a shorter Retry-After never shortens the schedule");
});

test("the ceiling: SHIP_RATE_LIMIT_MAX_WAIT_MIN, default 60 minutes, junk ignored", () => {
  assert.equal(rateLimitParkFromEnv({}).maxTotalWaitMs, DEFAULT_RATE_LIMIT_MAX_WAIT_MS);
  assert.equal(rateLimitParkFromEnv({ SHIP_RATE_LIMIT_MAX_WAIT_MIN: "5" }).maxTotalWaitMs, 5 * 60_000);
  assert.equal(rateLimitParkFromEnv({ SHIP_RATE_LIMIT_MAX_WAIT_MIN: "0" }).maxTotalWaitMs, DEFAULT_RATE_LIMIT_MAX_WAIT_MS);
  assert.equal(rateLimitParkFromEnv({ SHIP_RATE_LIMIT_MAX_WAIT_MIN: "junk" }).maxTotalWaitMs, DEFAULT_RATE_LIMIT_MAX_WAIT_MS);
  // The enqueue stamp: materialised tuning, or the explicit opt-out.
  assert.deepEqual(rateLimitParkInput({}), { rateLimitPark: { maxTotalWaitMs: 60 * 60_000 } });
  for (const off of ["0", "false", "no", "off"]) {
    assert.deepEqual(rateLimitParkInput({ SHIP_RATE_LIMIT_PARK: off }), { rateLimitPark: false });
  }
  assert.deepEqual(rateLimitParkInput({ SHIP_RATE_LIMIT_PARK: "1", SHIP_RATE_LIMIT_MAX_WAIT_MIN: "2" }), { rateLimitPark: { maxTotalWaitMs: 120_000 } });
});

test("the 1302 error becomes a park marker; a credential error does not", () => {
  const marker = rateLimitMarkerOf(ZAI_1302());
  assert.ok(marker !== null);
  assert.equal(marker.class, "rate-limit");
  assert.match(marker.message, /Rate limit reached for requests/);
  assert.ok(isRateLimitParked(marker));
  assert.equal(isRateLimitParked({ text: "a normal think result" }), false);
  // Overloaded is parkable too; auth is not — parking would only delay the
  // real failure.
  assert.equal(rateLimitMarkerOf(Object.assign(new Error("Overloaded"), { status: 529 }))?.class, "overloaded");
  assert.equal(rateLimitMarkerOf(Object.assign(new Error("invalid api key"), { status: 401 })), null);
  assert.equal(rateLimitMarkerOf(new Error("maximum context length exceeded")), null);
  // A Retry-After rides the marker so the park can honour it.
  assert.equal(rateLimitMarkerOf(Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 90_000 }))?.retryAfterMs, 90_000);
});

test("quota and billing exhaustion fail fast instead of parking (2026-10-19 review)", () => {
  // OpenAI's shape: 429 + insufficient_quota. The CLASS stays rate-limit —
  // routing may still switch to a model on another key — but the marker
  // refuses it: no park inside a run outlasts a quota that resets on a
  // billing cycle, and parking it only hides the failure until the ceiling.
  const insufficientQuota = Object.assign(new Error("Insufficient_quota for this billing cycle, upgrade your plan"), { status: 429 });
  assert.equal(classifyFailure(insufficientQuota), "rate-limit", "classification is routing's business and stays rate-limit");
  assert.equal(rateLimitMarkerOf(insufficientQuota), null, "the park refuses quota exhaustion");

  // The billing sentence behind a plain 429 (the review's exact case).
  assert.equal(
    rateLimitMarkerOf(Object.assign(new Error("You exceeded your current quota, please check your plan and billing details"), { status: 429 })),
    null,
  );
  // A 402 "quota exceeded" (the 4xx-refine used to classify it rate-limit).
  assert.equal(rateLimitMarkerOf(Object.assign(new Error("quota exceeded"), { status: 402 })), null);
  // Status-less quota text.
  assert.equal(rateLimitMarkerOf(new Error("billing: your account balance is negative")), null);

  // Genuine congestion still parks: the 1302, plain rate-limit text, overload.
  assert.ok(rateLimitMarkerOf(ZAI_1302()) !== null, "the z.ai 1302 parks");
  assert.ok(rateLimitMarkerOf(Object.assign(new Error("Rate limit reached for requests"), { status: 429 })) !== null, "a plain 429 parks");
  assert.ok(rateLimitMarkerOf(Object.assign(new Error("The server is overloaded"), { status: 503 })) !== null, "overload parks");
});

test("the loop parks with backoff and completes once the provider lets it through", async () => {
  const { ctx, sleeps } = liveCtx();
  const ledger = newParkLedger();
  const parks: number[] = [];
  let calls = 0;
  const body = async (): Promise<{ text: string; usage: undefined }> => {
    calls += 1;
    if (calls <= 2) throw ZAI_1302();
    return { text: "fixed", usage: undefined };
  };
  const call = () =>
    withRateLimitPark(ctx, {
      stepName: "turn-0-think",
      park: { maxTotalWaitMs: 60 * 60_000 },
      ledger,
      onPark: (n) => parks.push(n.delayMs),
      run: stepped(body),
    });
  // Three passes, the way the worker drives a parked run: each live park
  // ends its pass with the Suspension; the wake re-enters the loop.
  await assert.rejects(() => call(), isSuspension, "the live park suspends the pass");
  await assert.rejects(() => call(), isSuspension, "the wake pass parks again, longer");
  const result = await call();
  assert.deepEqual(result, { text: "fixed", usage: undefined });
  assert.deepEqual(sleeps, [60_000, 120_000], "bounded exponential backoff, one sleep per park");
  assert.deepEqual(parks, [60_000, 120_000], "onPark fires exactly once per wait — on the pass that parks");
  assert.deepEqual(ledger, { waitedMs: 180_000, parks: 2 }, "the ledger holds the run's total");
});

test("a consumed (replayed) park narrates nothing and re-derives the same ledger", async () => {
  // The replay shape: every recorded sleep is completed, so ctx.sleep
  // RETURNS inside one pass and the whole park sequence walks in order.
  // This is the 2026-10-19 review's replay-pass re-narration finding at
  // unit level: no onPark, no phase, but identical arithmetic.
  const { ctx, sleeps } = replayCtx();
  const ledger = newParkLedger();
  const parks: number[] = [];
  let calls = 0;
  const result = await withRateLimitPark(ctx, {
    stepName: "turn-0-think",
    park: { maxTotalWaitMs: 60 * 60_000 },
    ledger,
    onPark: (n) => parks.push(n.delayMs),
    run: stepped(async () => {
      calls += 1;
      if (calls <= 2) throw ZAI_1302();
      return { text: "fixed", usage: undefined };
    }),
  });
  assert.deepEqual(result, { text: "fixed", usage: undefined });
  assert.deepEqual(sleeps, [60_000, 120_000], "the recorded waits are consumed in order");
  assert.deepEqual(parks, [], "a replayed park narrates nothing — narration belongs to the live frontier");
  assert.deepEqual(ledger, { waitedMs: 180_000, parks: 2 }, "the run's total re-derives identically, never from a clock");
});

test("crossing the ceiling fails with a message that names the provider error and the bound", async () => {
  const { ctx, sleeps } = liveCtx();
  const ledger = newParkLedger();
  const call = () =>
    withRateLimitPark(ctx, {
      stepName: "turn-3-think",
      park: { maxTotalWaitMs: 90_000 },
      ledger,
      run: stepped(async () => {
        throw ZAI_1302();
      }),
    });
  // 90s ceiling: the first 60s park fits, the pass suspends...
  await assert.rejects(() => call(), isSuspension);
  // ...the wake pass's second park (120s) does not.
  await assert.rejects(
    () => call(),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /turn-3-think/);
      assert.match(message, /waiting 1m.*2m rate-limit wait ceiling/, "the waited time and the ceiling are both named, in minutes");
      assert.match(message, /1302.*Rate limit reached for requests/s);
      return true;
    },
  );
  assert.deepEqual(sleeps, [60_000], "one park happened, the second was refused");
  // The message builder is pinned directly too — it is the operator-facing
  // contract for the failure.
  assert.match(rateLimitCeilingMessage("s", 55 * 60_000, 60 * 60_000, "boom"), /55m/);
});

test("the ceiling is the RUN's: parks on two different steps share one budget", async () => {
  // The review's blocker, at unit level: `waitedMs` used to live inside
  // each withRateLimitPark call, so every think step got a fresh ceiling
  // and a run could park multiples of the documented total. Two DIFFERENT
  // steps, one shared ledger, one 90s budget.
  const { ctx, sleeps } = liveCtx();
  const ledger = newParkLedger();

  // Step one parks once (60s of the 90s ceiling) and gets through on the wake.
  let stepOneCalls = 0;
  const stepOne = () =>
    withRateLimitPark(ctx, {
      stepName: "turn-0-think",
      park: { maxTotalWaitMs: 90_000 },
      ledger,
      run: stepped(async () => {
        stepOneCalls += 1;
        if (stepOneCalls === 1) throw ZAI_1302();
        return "turn-0 done";
      }),
    });
  await assert.rejects(() => stepOne(), isSuspension, "the first step's 60s park fits the 90s run budget");
  assert.equal(await stepOne(), "turn-0 done");
  assert.deepEqual(sleeps, [60_000]);

  // A DIFFERENT step's first park is refused by the run-level total, not a
  // fresh per-step budget: the run already spent 60s of its 90s.
  await assert.rejects(
    () =>
      withRateLimitPark(ctx, {
        stepName: "turn-1-think",
        park: { maxTotalWaitMs: 90_000 },
        ledger,
        run: stepped(async () => {
          throw ZAI_1302();
        }),
      }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /turn-1-think/, "the failure names the step that was refused");
      assert.match(message, /rate-limit wait ceiling/);
      return true;
    },
  );
  assert.deepEqual(sleeps, [60_000], "the second step never got to sleep — the RUN's ceiling, not its own, refused");
  assert.deepEqual(ledger, { waitedMs: 60_000, parks: 1 });
});

test("an explicit opt-out keeps the historical fail-fast behaviour", async () => {
  const { ctx, sleeps } = liveCtx();
  await assert.rejects(
    () =>
      withRateLimitPark(ctx, {
        stepName: "turn-0-think",
        park: false,
        ledger: newParkLedger(),
        run: stepped(async () => {
          throw ZAI_1302();
        }),
      }),
    /Rate limit reached for requests/,
  );
  assert.deepEqual(sleeps, [], "no park when the input opted out");
});

test("a non-rate-limit failure propagates untouched — no park, no marker", async () => {
  const { ctx, sleeps } = liveCtx();
  await assert.rejects(
    () =>
      withRateLimitPark(ctx, {
        stepName: "turn-1-think",
        park: { maxTotalWaitMs: 60 * 60_000 },
        ledger: newParkLedger(),
        run: stepped(async () => {
          throw Object.assign(new Error("invalid api key"), { status: 401 });
        }),
      }),
    /invalid api key/,
  );
  assert.deepEqual(sleeps, []);
});
