import assert from "node:assert/strict";
import { test } from "node:test";

import { PRICING, costUSD, isPricedModel, pricingFor } from "./pricing.js";

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

test("pricing: an unknown model is estimated, absent usage is zero, nothing throws", () => {
  // Deliberately NOT zero for an unknown model any more: costUSD backs the
  // spend cap, and a zero there removed the cap entirely (TS-038).
  assert.ok(costUSD("worker-default", { inputTokens: 1_000_000, outputTokens: 1_000_000 }) > 0);
  assert.ok(costUSD("some/never-seen-model", { inputTokens: 5 }) > 0);
  assert.equal(costUSD("claude-sonnet-5", undefined), 0);
  assert.equal(pricingFor("nope"), undefined);
});

test("pricing: missing cache rates contribute nothing (no NaN)", () => {
  // gpt-5 has no cacheWritePer1M; cache-write tokens must not poison the total.
  const cost = costUSD("gpt-5", { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 });
  assert.equal(cost, 0);
});

test("TS-038: an unknown model is priced at the highest known rate, never free", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 };
  const unknown = costUSD("anthropic/claude-something-new-9", usage);
  assert.ok(unknown > 0, "an unknown model must not be free — the budget cap enforces on this number");
  assert.equal(isPricedModel("anthropic/claude-something-new-9"), false);

  // It is the ceiling, so no known model can ever cost more than the guess.
  for (const id of Object.keys(PRICING)) {
    assert.ok(costUSD(id, usage) <= unknown + 1e-9, `${id} should not exceed the unknown-model estimate`);
  }
});

test("the current flagship models are priced", () => {
  for (const id of ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "claude-haiku-4-5"]) {
    assert.equal(isPricedModel(id), true, `${id} must be in the pricing table`);
  }
});

test("absent usage is still genuinely zero", () => {
  assert.equal(costUSD("anthropic/claude-opus-5", undefined), 0);
  assert.equal(costUSD("totally-unknown", undefined), 0);
});

test("local models are free, not priced at the unknown-model ceiling", () => {
  // The safety rule (unknown => most expensive) is right for a hosted model and
  // badly wrong for one running on the operator's own hardware: a self-hosted
  // Ship on Ollama would bill itself Opus rates for free inference and refuse
  // to launch anything within the hour.
  const usage = { inputTokens: 5_000_000, outputTokens: 5_000_000, totalTokens: 10_000_000 };
  for (const id of ["ollama/llama3.1", "lmstudio/qwen", "vllm/mistral", "local/whatever"]) {
    assert.equal(costUSD(id, usage), 0, `${id} runs on your own hardware`);
    assert.equal(isPricedModel(id), true, "and is not reported as an unpriced guess");
  }
  // An unrecognised HOSTED model still fails closed.
  assert.ok(costUSD("someprovider/mystery-model", usage) > 0);
});

test("an operator can declare rates for a model Ship does not know", () => {
  const env = { SHIP_MODEL_PRICING: JSON.stringify({ "mystery-model": { inputPer1M: 1, outputPer1M: 2 } }) };
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 };
  assert.equal(costUSD("someprovider/mystery-model", usage, env), 3);
  assert.equal(isPricedModel("someprovider/mystery-model"), false, "without the override it is still a guess");
  // Malformed JSON must not throw on a hot path.
  assert.ok(costUSD("x/y", usage, { SHIP_MODEL_PRICING: "{oops" }) > 0);
});
