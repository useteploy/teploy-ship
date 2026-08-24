import assert from "node:assert/strict";
import { test } from "node:test";

import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";

import { DEFAULT_MODEL_TIMEOUT_MS, backoffFor, defaultRetryPolicy, isRetryable, modelTimeoutFromEnv, withCallTimeout, withRetry } from "./provider.js";

function flaky(failures: number, error: unknown): { model: ModelAdapter; calls: () => number } {
  let calls = 0;
  const model: ModelAdapter = {
    provider: "test",
    modelId: "m",
    async doGenerate(): Promise<AdapterGenerateResult> {
      calls += 1;
      if (calls <= failures) throw error;
      return { content: [{ type: "text", text: "ok" }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
    },
    async *doStream() {
      throw new Error("unused");
    },
  };
  return { model, calls: () => calls };
}

const fast = { attempts: 4, baseDelayMs: 1, maxDelayMs: 2 };
const noSleep = { sleep: async (): Promise<void> => {} };

test("TS-053: a transient provider failure is retried instead of killing the run", async () => {
  const { model, calls } = flaky(2, Object.assign(new Error("rate limited"), { status: 429 }));
  const wrapped = withRetry(model, fast, noSleep);
  const result = await wrapped.doGenerate({ messages: [] } as never);
  assert.equal(result.content[0]?.type, "text");
  assert.equal(calls(), 3, "two failures, then success");
});

test("a permanent error fails immediately rather than burning the retry budget", async () => {
  const { model, calls } = flaky(99, Object.assign(new Error("invalid api key"), { status: 401 }));
  await assert.rejects(() => withRetry(model, fast, noSleep).doGenerate({ messages: [] } as never), /invalid api key/);
  assert.equal(calls(), 1, "no point retrying a credential problem");
});

test("retries are bounded and the last error surfaces", async () => {
  const { model, calls } = flaky(99, Object.assign(new Error("overloaded"), { status: 503 }));
  await assert.rejects(() => withRetry(model, fast, noSleep).doGenerate({ messages: [] } as never), /overloaded/);
  assert.equal(calls(), fast.attempts);
});

test("classification: transient vs permanent", () => {
  assert.equal(isRetryable(Object.assign(new Error("x"), { status: 429 })), true);
  assert.equal(isRetryable(Object.assign(new Error("x"), { status: 502 })), true);
  assert.equal(isRetryable(Object.assign(new Error("x"), { status: 400 })), false);
  assert.equal(isRetryable(new Error("socket hang up")), true);
  assert.equal(isRetryable(new Error("ETIMEDOUT")), true);
  // Retrying a context-length failure just fails identically; condensation is
  // the answer to that one.
  assert.equal(isRetryable(new Error("maximum context length exceeded")), false);
  assert.equal(isRetryable(new Error("unauthorized")), false);
});

test("backoff grows and is capped", () => {
  assert.ok(backoffFor(1, defaultRetryPolicy) < backoffFor(3, defaultRetryPolicy));
  assert.equal(backoffFor(50, defaultRetryPolicy), defaultRetryPolicy.maxDelayMs);
});

test("the model's identity is preserved, so pricing and replay still work", () => {
  const { model } = flaky(0, new Error("x"));
  const wrapped = withRetry(model, fast, noSleep);
  assert.equal(wrapped.modelId, "m");
  assert.equal(wrapped.provider, "test");
});

// ------------------------------------------------------------- call timeout

/**
 * A model call that never answers. The fake honours opts.abortSignal the way
 * a real fetch does — rejects with an abort error once signalled — because
 * that is the mechanism the timeout relies on: AbortSignal.any composes the
 * timeout with any caller signal, and the SDK's fetch layer turns the abort
 * into a rejection.
 */
function hangingModel(): ModelAdapter {
  return {
    provider: "test",
    modelId: "m",
    async doGenerate(opts: Parameters<ModelAdapter['doGenerate']>[0]) {
      return await new Promise((_resolve, reject) => {
        // AbortSignal.timeout uses an UNREF'd timer (it never holds a process
        // open), so the fake needs a ref'd guard to keep the test's loop alive
        // until the abort fires. If the abort never comes, the guard names it.
        const guard = setTimeout(() => reject(new Error("abort never fired within the test window")), 5_000);
        opts.abortSignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(guard);
            reject(new Error("The operation was aborted due to timeout"));
          },
          { once: true },
        );
      });
    },
    // eslint-disable-next-line require-yield
    async *doStream() {},
  } as unknown as ModelAdapter;
}

test("P3-7: a hanging model call is aborted at the timeout instead of wedging forever", async () => {
  const wrapped = withCallTimeout(hangingModel(), 25);
  await assert.rejects(
    () => wrapped.doGenerate({ messages: [] } as never),
    /aborted due to timeout/,
    "the wedge that needed a worker restart on 2026-08-24 must self-terminate",
  );
});

test("P3-7: a caller's own abort signal composes with the timeout", async () => {
  const wrapped = withCallTimeout(hangingModel(), 60_000);
  const caller = new AbortController();
  setTimeout(() => caller.abort(new Error("caller cancelled")), 20);
  await assert.rejects(() => wrapped.doGenerate({ messages: [] as never, abortSignal: caller.signal }), /aborted/);
});

test("P3-7: a call that answers in time is untouched, and identity is preserved", async () => {
  const quick: ModelAdapter = {
    provider: "test",
    modelId: "m",
    async doGenerate() {
      return { text: "ok", content: [], toolCalls: [], toolResults: [], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } as never;
    },
    async *doStream() {},
  } as unknown as ModelAdapter;
  const wrapped = withCallTimeout(quick, 5_000);
  assert.equal(wrapped.modelId, "m");
  assert.equal(wrapped.provider, "test");
  const result = (await wrapped.doGenerate({ messages: [] } as never)) as unknown as { text: string };
  assert.equal(result.text, "ok");
});

test("P3-7: the timeout default and env override", () => {
  assert.equal(modelTimeoutFromEnv({}), DEFAULT_MODEL_TIMEOUT_MS);
  assert.equal(modelTimeoutFromEnv({ SHIP_MODEL_TIMEOUT_MS: "90000" }), 90_000);
  assert.equal(modelTimeoutFromEnv({ SHIP_MODEL_TIMEOUT_MS: "junk" }), DEFAULT_MODEL_TIMEOUT_MS);
  assert.equal(modelTimeoutFromEnv({ SHIP_MODEL_TIMEOUT_MS: "0" }), DEFAULT_MODEL_TIMEOUT_MS, "zero disables nothing — a hung call is never desirable");
});
