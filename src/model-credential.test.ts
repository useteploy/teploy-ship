import assert from "node:assert/strict";
import { test } from "node:test";

import type { AdapterCallOptions, ModelAdapter } from "@neutron-build/ai";

import { missingDirectCredential, withDirectCredentialCheck } from "./model-credential.js";

/**
 * SHIP-10: with no key, a live run on the default model (zai/glm-5.3) said
 * "Missing API key: set OPENAI_API_KEY" — the OpenAI-shaped SDK fallback's
 * message, naming a variable that would not fix a z.ai model.
 */

const options = { messages: [] } as unknown as AdapterCallOptions;

function innerAdapter(calls: string[]): ModelAdapter {
  return {
    provider: "openai",
    modelId: "glm-5.3",
    doGenerate: async () => {
      calls.push("generate");
      return { content: [], finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, raw: {} };
    },
    doStream: async function* () {
      calls.push("stream");
      yield { type: "finish", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } as const;
    },
  };
}

test("the default model with no key names the gateway variables, not OPENAI_API_KEY", () => {
  const message = missingDirectCredential("zai/glm-5.3", {});
  assert.ok(message !== undefined);
  assert.match(message, /AI_GATEWAY_URL \+ AI_GATEWAY_KEY/);
  assert.match(message, /no direct "zai" provider/);
  assert.match(message, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(message, /OPENAI_API_KEY/);
});

test("an openai/ model is told OPENAI_API_KEY, which is the right variable for it", () => {
  assert.match(missingDirectCredential("openai/gpt-5", {})!, /set OPENAI_API_KEY/);
});

test("with the direct key present nothing is refused", () => {
  assert.equal(missingDirectCredential("openai/gpt-5", { OPENAI_API_KEY: "k" }), undefined);
  assert.equal(missingDirectCredential("gpt-5", { OPENAI_API_KEY: "k" }), undefined);
});

test("the wrapped adapter refuses at call time with the named variable, and never calls out", async () => {
  const calls: string[] = [];
  const env: NodeJS.ProcessEnv = {};
  const model = withDirectCredentialCheck(innerAdapter(calls), "zai/glm-5.3", env);
  await assert.rejects(model.doGenerate(options), (error: Error) => {
    assert.match(error.message, /AI_GATEWAY_KEY/);
    assert.doesNotMatch(error.message, /OPENAI_API_KEY/);
    return true;
  });
  await assert.rejects(async () => {
    for await (const _part of model.doStream(options)) void _part;
  }, /AI_GATEWAY_KEY/);
  assert.deepEqual(calls, []);

  // A credential that arrives later is honoured without rebuilding the adapter.
  env.OPENAI_API_KEY = "k";
  await model.doGenerate(options);
  for await (const _part of model.doStream(options)) void _part;
  assert.deepEqual(calls, ["generate", "stream"]);
});
