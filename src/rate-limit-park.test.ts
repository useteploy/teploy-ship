import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkflowContext } from "@neutron-build/workflow";

import {
  DEFAULT_RATE_LIMIT_MAX_WAIT_MS,
  RATE_LIMIT_PARK_MAX_DELAY_MS,
  isRateLimitParked,
  markingRateLimits,
  parkDelayMs,
  rateLimitCeilingMessage,
  rateLimitMarkerOf,
  rateLimitParkFromEnv,
  rateLimitParkInput,
  withRateLimitPark,
} from "./rate-limit-park.js";

/**
 * The smallest context the park loop needs: a sleep that records instead of
 * suspending (the marker-under-the-step behaviour is what the durable tests
 * exercise against the real engine; here we pin the LOOP: delays, ceiling,
 * opt-out). `run` plays the step the way durable.ts writes it.
 */
function stubCtx(): { ctx: Pick<WorkflowContext, "sleep">; sleeps: number[] } {
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
function stepped<T>(ctx: { sleep: (d: number | string) => Promise<void> }, body: () => Promise<T>): () => Promise<T | import("./rate-limit-park.js").RateLimitParked> {
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

test("the loop parks with backoff and completes once the provider lets it through", async () => {
  const { ctx, sleeps } = stubCtx();
  const parks: number[] = [];
  let calls = 0;
  const result = await withRateLimitPark(ctx, {
    stepName: "turn-0-think",
    park: { maxTotalWaitMs: 60 * 60_000 },
    onPark: (n) => parks.push(n.delayMs),
    run: stepped(ctx, async () => {
      calls += 1;
      if (calls <= 2) throw ZAI_1302();
      return { text: "fixed", usage: undefined };
    }),
  });
  assert.deepEqual(result, { text: "fixed", usage: undefined });
  assert.deepEqual(sleeps, [60_000, 120_000], "bounded exponential backoff, one sleep per park");
  assert.deepEqual(parks, [60_000, 120_000], "onPark fires exactly once per wait");
});

test("crossing the ceiling fails with a message that names the provider error and the bound", async () => {
  const { ctx, sleeps } = stubCtx();
  // 90s ceiling: the first 60s park fits, the second (120s) does not.
  await assert.rejects(
    () =>
      withRateLimitPark(ctx, {
        stepName: "turn-3-think",
        park: { maxTotalWaitMs: 90_000 },
        run: stepped(ctx, async () => {
          throw ZAI_1302();
        }),
      }),
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

test("an explicit opt-out keeps the historical fail-fast behaviour", async () => {
  const { ctx, sleeps } = stubCtx();
  await assert.rejects(
    () =>
      withRateLimitPark(ctx, {
        stepName: "turn-0-think",
        park: false,
        run: stepped(ctx, async () => {
          throw ZAI_1302();
        }),
      }),
    /Rate limit reached for requests/,
  );
  assert.deepEqual(sleeps, [], "no park when the input opted out");
});

test("a non-rate-limit failure propagates untouched — no park, no marker", async () => {
  const { ctx, sleeps } = stubCtx();
  await assert.rejects(
    () =>
      withRateLimitPark(ctx, {
        stepName: "turn-1-think",
        park: { maxTotalWaitMs: 60 * 60_000 },
        run: stepped(ctx, async () => {
          throw Object.assign(new Error("invalid api key"), { status: 401 });
        }),
      }),
    /invalid api key/,
  );
  assert.deepEqual(sleeps, []);
});
