import assert from "node:assert/strict";
import { test } from "node:test";
import { harnessIdentityView } from "./harness-identity-view.js";

const started = (data: Record<string, unknown>) => ({ type: "run-started", data: { workflow: "w", input: {}, ...data } });
const preflight = (result: unknown, name = "harness-preflight") => ({ type: "step-completed", name, data: { result } });
const identity = {
  v: 1,
  harness: { id: "claude-code", adapterVersion: "1" },
  model: { ship: "ship-model", harness: "sonnet" },
  expectedRevision: { npm: "@anthropic-ai/claude-code", version: "2.1.246" },
  configuration: { timeoutMs: 1_800_000, claudeBare: false, forwardedEnvNames: ["ANTHROPIC_API_KEY"], digest: "abcd1234abcd1234" },
};

test("a run recorded without identity projects to undefined (page unchanged)", () => {
  assert.equal(harnessIdentityView([started({})]), undefined);
  assert.equal(harnessIdentityView([]), undefined);
  assert.equal(harnessIdentityView([started({ harnessIdentity: "nope" }), preflight({ found: true, version: "2.1.246" })]), undefined);
  assert.equal(harnessIdentityView([started({ harnessIdentity: {} })]), undefined);
});

test("recorded identity is shown with the revision the sandbox actually reported", () => {
  const view = harnessIdentityView([started({ harnessIdentity: identity }), preflight({ found: true, version: "2.1.246 (Claude Code)" })])!;
  const byLabel = Object.fromEntries(view.rows.map((r) => [r.label, r.value]));
  assert.equal(byLabel["Harness"], "claude-code (adapter v1)");
  assert.equal(byLabel["Model"], "sonnet");
  assert.equal(byLabel["Expected revision"], "@anthropic-ai/claude-code@2.1.246");
  assert.equal(byLabel["Observed revision"], "2.1.246 (Claude Code)");
  assert.match(byLabel["Configuration"]!, /config abcd1234abcd1234 · timeout 30 min · forwards ANTHROPIC_API_KEY/);
  assert.equal(view.revisionMismatch, false);
});

test("a binary that is not the expected revision, or is missing, is surfaced rather than smoothed over", () => {
  const drift = harnessIdentityView([started({ harnessIdentity: identity }), preflight({ found: true, version: "2.0.0" })])!;
  assert.equal(drift.revisionMismatch, true);
  assert.ok(drift.rows.some((r) => r.label === "Observed revision" && /differs from expected/.test(r.value)));
  const missing = harnessIdentityView([started({ harnessIdentity: identity }), preflight({ found: false, version: "" })])!;
  assert.ok(missing.rows.some((r) => r.value === "binary not found in the sandbox"));
  // No preflight at all is "not observed", never an implied match.
  const none = harnessIdentityView([started({ harnessIdentity: identity })])!;
  assert.ok(none.rows.some((r) => r.label === "Observed revision" && /not observed/.test(r.value)));
  assert.equal(none.revisionMismatch, false);
});

test("native shows Ship's model and no vendor revision; attempt-prefixed preflights are read", () => {
  const native = harnessIdentityView([started({ harnessIdentity: { ...identity, harness: { id: "native", adapterVersion: "1" }, expectedRevision: null } })])!;
  assert.equal(native.rows.find((r) => r.label === "Model")!.value, "ship-model");
  assert.ok(!native.rows.some((r) => /revision/i.test(r.label)));
  const attempt = harnessIdentityView([started({ harnessIdentity: identity }), preflight({ found: true, version: "2.1.246" }, "attempt-2-harness-preflight")])!;
  assert.ok(attempt.rows.some((r) => r.label === "Observed revision" && r.value === "2.1.246"));
});
