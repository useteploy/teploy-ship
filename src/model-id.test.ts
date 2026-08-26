import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL_ID, resolveModelId } from "./model-id.js";

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
