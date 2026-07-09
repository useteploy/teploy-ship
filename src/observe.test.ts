import assert from "node:assert/strict";
import { test } from "node:test";

import { makeObserveEmitter } from "./observe.js";

test("observe emitter is a no-op when unconfigured", () => {
  delete process.env.OBSERVE_URL;
  delete process.env.OBSERVE_API_KEY;
  const e = makeObserveEmitter();
  assert.equal(e.enabled, false);
  // Must not throw with no transport configured.
  e.emitRun({ runId: "r1", model: "anthropic/claude-sonnet-5", status: "completed" });
});

test("observe emitter posts an LLM event with model/tokens/cost when configured", () => {
  process.env.OBSERVE_URL = "https://observe.test/";
  process.env.OBSERVE_API_KEY = "k";
  const calls: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
  const orig = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, init });
    return Promise.resolve({ ok: true });
  };
  try {
    const e = makeObserveEmitter();
    assert.equal(e.enabled, true);
    e.emitRun({
      runId: "run-1",
      model: "anthropic/claude-sonnet-5",
      status: "completed",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      repo: "https://forge/x/y.git",
      pr: 3,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/api\/v1\/llm\/ingest$/);
    assert.equal(calls[0]!.init.headers["x-api-key"], "k");
    const body = JSON.parse(calls[0]!.init.body);
    assert.equal(body.model, "anthropic/claude-sonnet-5");
    assert.equal(body.provider, "anthropic");
    assert.equal(body.operation, "ship.run");
    assert.equal(body.prompt_tokens, 100);
    assert.equal(body.completion_tokens, 50);
    assert.equal(body.status, "ok");
    assert.equal(body.metadata.repo, "https://forge/x/y.git");
    assert.equal(body.metadata.pr, 3);
    assert.ok(typeof body.cost_usd === "number" && body.cost_usd >= 0);
  } finally {
    globalThis.fetch = orig;
    delete process.env.OBSERVE_URL;
    delete process.env.OBSERVE_API_KEY;
  }
});
