import assert from "node:assert/strict";
import { test } from "node:test";

import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";

import { backoffFor, defaultRetryPolicy, isRetryable, withRetry } from "./provider.js";

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
