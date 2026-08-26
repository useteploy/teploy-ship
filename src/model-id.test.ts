import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL_ID, resolveModelId, usesAnthropicWire } from "./model-id.js";

test("flag wins over env and config", () => {
  assert.equal(resolveModelId("x/flag", { SHIP_MODEL: "x/env" }, "x/config"), "x/flag");
});

test("SHIP_MODEL is honoured when no flag is given — the worker's case", () => {
  assert.equal(resolveModelId(undefined, { SHIP_MODEL: "zai/glm-5.3" }, "x/config"), "zai/glm-5.3");
  assert.equal(resolveModelId(undefined, { SHIP_MODEL: "  zai/glm-5.3 " }), "zai/glm-5.3");
});

test("an empty SHIP_MODEL falls through to config, then the default", () => {
  assert.equal(resolveModelId(undefined, { SHIP_MODEL: "" }, "x/config"), "x/config");
  assert.equal(resolveModelId(undefined, {}, undefined), DEFAULT_MODEL_ID);
  assert.equal(resolveModelId("", {}, ""), DEFAULT_MODEL_ID);
});

test("zai models ride the Anthropic wire through the gateway; openai-style ids do not", () => {
  assert.equal(usesAnthropicWire("anthropic/claude-sonnet-5", {}), true);
  assert.equal(usesAnthropicWire("zai/glm-5.3", {}), true);
  assert.equal(usesAnthropicWire("openai/gpt-5", {}), false);
  assert.equal(usesAnthropicWire("groq/llama", { SHIP_ANTHROPIC_WIRE_PREFIXES: "groq/" }), true);
  assert.equal(usesAnthropicWire("zai/glm-5.3", { SHIP_ANTHROPIC_WIRE_PREFIXES: "groq/" }), false);
});
