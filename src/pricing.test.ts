import assert from "node:assert/strict";
import { test } from "node:test";

import { costUSD, pricingFor } from "./pricing.js";

test("pricing: basic input+output cost for a known model", () => {
  // sonnet-5: $3/1M in, $15/1M out. 1M in + 1M out = 3 + 15 = $18.
  const cost = costUSD("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 });
  assert.equal(cost, 18);
});

test("pricing: cache-read and cache-write tokens are billed at their own rates", () => {
  // opus-4-8: in $5, out $25, cache-read $0.5, cache-write $6.25 per 1M.
  const cost = costUSD("claude-opus-4-8", {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    totalTokens: 2_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  });
  assert.equal(cost, 5 + 25 + 0.5 + 6.25);
});

test("pricing: provider/ prefix is stripped before lookup", () => {
  const withPrefix = costUSD("anthropic/claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 });
  const without = costUSD("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000 });
  assert.equal(withPrefix, without);
  assert.equal(withPrefix, 3);
  // openai and gemini and deepseek families resolve too
  assert.ok(costUSD("openai/gpt-5", { inputTokens: 1_000_000, outputTokens: 0 }) > 0);
  assert.ok(costUSD("gemini-2.5-flash", { inputTokens: 1_000_000, outputTokens: 0 }) > 0);
  assert.ok(costUSD("deepseek-chat", { inputTokens: 1_000_000, outputTokens: 0 }) > 0);
});

test("pricing: unknown model and absent usage fall back to 0, never throw", () => {
  assert.equal(costUSD("worker-default", { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 0);
  assert.equal(costUSD("some/never-seen-model", { inputTokens: 5 }), 0);
  assert.equal(costUSD("claude-sonnet-5", undefined), 0);
  assert.equal(pricingFor("nope"), undefined);
});

test("pricing: missing cache rates contribute nothing (no NaN)", () => {
  // gpt-5 has no cacheWritePer1M; cache-write tokens must not poison the total.
  const cost = costUSD("gpt-5", { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 });
  assert.equal(cost, 0);
});
