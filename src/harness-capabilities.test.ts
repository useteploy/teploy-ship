import assert from "node:assert/strict";
import test from "node:test";
import { harnessSupports, recordedHarnessIds } from "./harness-capabilities.js";

test("S13: only the native harness takes steering notes", () => {
  assert.equal(harnessSupports({ harness: { id: "native" } }, "steer"), true);
  assert.equal(harnessSupports({ harness: { id: "claude-code" } }, "steer"), false);
  assert.equal(harnessSupports({ harness: { id: "opencode" } }, "steer"), false);
});

test("S13: a run recorded before pluggable harnesses is native", () => {
  assert.equal(harnessSupports({}, "steer"), true);
  assert.equal(harnessSupports(undefined, "steer"), true);
  assert.deepEqual(recordedHarnessIds({}), ["native"]);
});

test("S13: unknown or malformed harness ids support nothing", () => {
  assert.equal(harnessSupports({ harness: { id: "mystery" } }, "steer"), false);
  assert.equal(harnessSupports({ harness: { id: 7 } }, "steer"), false);
  assert.equal(harnessSupports({ harness: {} }, "steer"), false);
});

test("S13: a multi-harness run supports a capability only if every attempt does", () => {
  assert.equal(harnessSupports({ harness: { id: "native" }, harnessAttempts: [{ id: "native" }, { id: "native" }] }, "steer"), true);
  assert.equal(harnessSupports({ harness: { id: "native" }, harnessAttempts: [{ id: "native" }, { id: "opencode" }] }, "steer"), false);
});
