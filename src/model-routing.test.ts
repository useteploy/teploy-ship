import assert from "node:assert/strict";
import { test } from "node:test";

import {
  nextFallback,
  selectModel,
  validatePolicy,
  type Candidate,
  type RouteTask,
  type RoutingPolicy,
} from "./model-routing.js";

const CAPS = ["tools", "structured-output", "streaming", "cancellation"];

const glm: Candidate = {
  model: "zai/glm-5.3",
  effort: "high",
  capabilities: CAPS,
  dataDestination: { host: "api.z.ai", class: "hosted" },
  retention: "none",
  maxContext: 200_000,
};
const sonnet: Candidate = {
  model: "anthropic/claude-sonnet-5",
  effort: "high",
  capabilities: CAPS,
  dataDestination: { host: "api.anthropic.com", class: "hosted" },
  retention: "none",
  maxContext: 200_000,
};
const local: Candidate = {
  model: "ollama/qwen3",
  effort: "medium",
  capabilities: ["streaming"],
  dataDestination: { host: "localhost", class: "local" },
  retention: "none",
  maxContext: 32_000,
};

const policy = (
  candidates: Candidate[],
  fallbackOn: RoutingPolicy["fallbackOn"] = ["outage", "rate-limit"],
): RoutingPolicy => ({
  version: "2026-10-03.1",
  roles: { implement: candidates },
  fallbackOn,
});

const task = (over: Partial<RouteTask> = {}): RouteTask => ({
  needs: ["tools"],
  contextTokens: 10_000,
  maxOutputTokens: 4_000,
  dataClass: "internal",
  allowedDestinations: ["api.z.ai", "api.anthropic.com"],
  reservedBudget: 5,
  uncertainSideEffects: false,
  ...over,
});

test("select: primary candidate wins and the segment records policy, model, reservation", () => {
  const r = selectModel(policy([glm, sonnet]), "implement", task());
  assert.ok(r.ok);
  assert.equal(r.segment.model, "zai/glm-5.3");
  assert.equal(r.segment.policyVersion, "2026-10-03.1");
  assert.equal(r.segment.reason, "primary");
  assert.equal(r.segment.pricing, "table");
  assert.equal(r.segment.reservedUSD, (10_000 * 1 + 4_000 * 3.2) / 1e6);
  assert.deepEqual(r.segment.skipped, []);
});

test("select: invalid policy, unknown role and duplicate candidates are refused", () => {
  assert.equal(selectModel({ ...policy([glm]), version: "" }, "implement", task()).ok, false);
  assert.equal(selectModel(policy([glm]), "review", task()).ok, false);
  assert.equal(selectModel(policy([glm, glm]), "implement", task()).ok, false);
  assert.ok(validatePolicy(policy([glm], ["nonsense" as never])).length > 0);
  assert.deepEqual(validatePolicy(policy([glm, sonnet])), []);
});

test("private data never falls back to a disallowed provider, even when it is the only one up", () => {
  const t = task({ dataClass: "private", allowedDestinations: ["api.z.ai"] });
  const r = nextFallback(policy([glm, sonnet]), "implement", t, { model: glm.model, failure: "outage" });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join("\n"), /api\.anthropic\.com.*not a permitted destination for private/);
  // negative control: the same fallback is fine once the destination is permitted
  const ok = nextFallback(
    policy([glm, sonnet]),
    "implement",
    task({ dataClass: "private", allowedDestinations: ["api.z.ai", "api.anthropic.com"] }),
    { model: glm.model, failure: "outage" },
  );
  assert.ok(ok.ok);
  assert.equal(ok.segment.model, sonnet.model);
});

test("destination: private/internal with no allow-list gets nothing; public may; class entries match", () => {
  assert.equal(selectModel(policy([glm]), "implement", task({ allowedDestinations: undefined })).ok, false);
  assert.equal(
    selectModel(policy([glm]), "implement", task({ allowedDestinations: [], dataClass: "public" })).ok,
    false,
  );
  assert.ok(selectModel(policy([glm]), "implement", task({ allowedDestinations: undefined, dataClass: "public" })).ok);
  const r = selectModel(policy([glm, local]), "implement", task({ needs: [], allowedDestinations: ["class:local"] }));
  assert.ok(r.ok);
  assert.equal(r.segment.model, "ollama/qwen3");
  assert.equal(r.segment.pricing, "free");
  assert.equal(r.segment.skipped[0]?.code, "destination-not-allowed");
});

test("retention: a provider that keeps data is skipped for private work", () => {
  const keeps = { ...sonnet, retention: "long" as const };
  const r = selectModel(policy([keeps, glm]), "implement", task({ dataClass: "private" }));
  assert.ok(r.ok);
  assert.equal(r.segment.model, glm.model);
  assert.equal(r.segment.skipped[0]?.code, "retention-exceeds");
  const unknown = { ...sonnet, retention: "unknown" as const };
  assert.equal(selectModel(policy([unknown]), "implement", task({ dataClass: "internal" })).ok, false);
});

test("unsupported-tool candidate is skipped and the reason is recorded", () => {
  const r = selectModel(policy([local, glm]), "implement", task({ allowedDestinations: ["class:local", "api.z.ai"] }));
  assert.ok(r.ok);
  assert.equal(r.segment.model, glm.model);
  assert.equal(r.segment.skipped[0]?.code, "missing-capability");
  assert.match(r.segment.skipped[0]!.why, /tools/);
  // undeclared is not assumed: no candidate declares multimodal
  assert.equal(selectModel(policy([glm, sonnet]), "implement", task({ needs: ["multimodal"] })).ok, false);
});

test("context: a candidate whose window cannot hold input plus output is skipped", () => {
  const r = selectModel(policy([{ ...glm, maxContext: 8_000 }, sonnet]), "implement", task());
  assert.ok(r.ok);
  assert.equal(r.segment.model, sonnet.model);
  assert.equal(r.segment.skipped[0]?.code, "context-too-small");
});

test("budget: exhausted reservation refuses; a cheaper later candidate is taken", () => {
  const exhausted = selectModel(policy([glm, sonnet]), "implement", task({ reservedBudget: 0 }));
  assert.equal(exhausted.ok, false);
  assert.ok(exhausted.skipped.every((s) => s.code === "budget-insufficient"));
  const cheap = { ...glm, model: "openai/gpt-5-nano", dataDestination: { host: "api.openai.com", class: "hosted" } };
  const r = nextFallback(
    policy([sonnet, cheap], ["budget"]),
    "implement",
    task({ reservedBudget: 0.01, allowedDestinations: ["api.openai.com", "api.anthropic.com"] }),
    { model: sonnet.model, failure: "budget" },
  );
  assert.ok(r.ok);
  assert.equal(r.segment.model, "openai/gpt-5-nano");
  assert.equal(r.segment.reason, "fallback:budget");
});

test("budget: unknown pricing is reserved at the highest known rate, not zero", () => {
  const mystery = { ...glm, model: "acme/never-heard-of-it" };
  const t = task({ reservedBudget: 0.1 }); // 10k in + 4k out at the 10/50 per 1M ceiling = $0.30
  assert.equal(selectModel(policy([mystery]), "implement", t).ok, false);
  const generous = selectModel(policy([mystery]), "implement", task({ reservedBudget: 1 }));
  assert.ok(generous.ok);
  assert.equal(generous.segment.pricing, "unknown-highest-rate");
  assert.ok(generous.segment.reservedUSD > 0.29);
  // negative control: a table model with the same budget is accepted
  assert.ok(selectModel(policy([glm]), "implement", t).ok);
});

test("budget: an operator rate declared via env is honoured, and is an explicit input", () => {
  const mystery = { ...glm, model: "acme/never-heard-of-it" };
  const env = { SHIP_MODEL_PRICING: JSON.stringify({ "acme/never-heard-of-it": { inputPer1M: 1, outputPer1M: 1 } }) };
  assert.ok(selectModel(policy([mystery]), "implement", task({ reservedBudget: 0.1 }), { env }).ok);
  assert.equal(selectModel(policy([mystery]), "implement", task({ reservedBudget: 0.1 })).ok, false);
});

test("authority: a candidate requesting tools or connections beyond the grant is never chosen", () => {
  const wide = { ...sonnet, requestedAuthority: { tools: ["web-search"], connections: ["github-write"] } };
  const t = task({ authority: { tools: ["read-file"], connections: [] } });
  const r = nextFallback(policy([glm, wide]), "implement", t, { model: glm.model, failure: "outage" });
  assert.equal(r.ok, false);
  assert.equal(r.skipped.find((s) => s.candidate === wide.model)?.code, "authority-expansion");
  // negative control: granting it makes the same candidate eligible
  const granted = task({ authority: { tools: ["web-search"], connections: ["github-write"] } });
  assert.ok(nextFallback(policy([glm, wide]), "implement", granted, { model: glm.model, failure: "outage" }).ok);
});

test("refusal fallback is allowed only if the policy lists it", () => {
  const cur = { model: glm.model, failure: "refusal" as const };
  const without = nextFallback(policy([glm, sonnet], ["outage"]), "implement", task(), cur);
  assert.equal(without.ok, false);
  assert.match(without.reasons[0]!, /does not permit fallback on refusal/);
  assert.ok(nextFallback(policy([glm, sonnet], ["refusal"]), "implement", task(), cur).ok);
  const never = nextFallback(policy([glm, sonnet], []), "implement", task(), { model: glm.model, failure: "outage" });
  assert.equal(never.ok, false);
});

test("uncertain side effect blocks replay on both the task flag and the in-flight call", () => {
  const p = policy([glm, sonnet]);
  const inFlight = { tool: "git-push", sideEffect: "uncertain" as const };
  const a = nextFallback(p, "implement", task(), { model: glm.model, failure: "outage", inFlight });
  assert.equal(a.ok, false);
  assert.match(a.reasons[0]!, /git-push.*uncertain/);
  const flagged = nextFallback(p, "implement", task({ uncertainSideEffects: true }), {
    model: glm.model,
    failure: "outage",
  });
  assert.equal(flagged.ok, false);
  assert.equal(selectModel(p, "implement", task({ uncertainSideEffects: true })).ok, false);
  // negative control: a known-idempotent or effect-free call may move
  for (const sideEffect of ["none", "idempotent"] as const) {
    const ok = nextFallback(p, "implement", task(), {
      model: glm.model,
      failure: "outage",
      inFlight: { tool: "read-file", sideEffect },
    });
    assert.ok(ok.ok);
  }
});

test("fallback only moves forward: earlier candidates and the failed one are not re-chosen", () => {
  const p = policy([glm, sonnet]);
  const r = nextFallback(p, "implement", task(), { model: sonnet.model, failure: "outage" });
  assert.equal(r.ok, false);
  assert.ok(r.skipped.every((s) => s.code === "already-tried"));
  assert.equal(nextFallback(p, "implement", task(), { model: "x/unlisted", failure: "outage" }).ok, false);
});

test("segments are deeply frozen and cannot be edited after the fact", () => {
  const r = selectModel(policy([local, glm]), "implement", task({ allowedDestinations: ["class:local", "api.z.ai"] }));
  assert.ok(r.ok);
  assert.ok(Object.isFrozen(r.segment));
  assert.ok(Object.isFrozen(r.segment.skipped));
  assert.ok(Object.isFrozen(r.segment.skipped[0]));
  assert.ok(Object.isFrozen(r.segment.destination));
  assert.throws(() => {
    (r.segment as { model: string }).model = "evil/model";
  }, TypeError);
  assert.throws(() => {
    (r.segment.skipped as unknown as unknown[]).push({});
  }, TypeError);
  // the segment does not alias the policy: mutating the candidate afterwards cannot change it
  const c = { ...glm, dataDestination: { ...glm.dataDestination } };
  const r2 = selectModel(policy([c]), "implement", task());
  assert.ok(r2.ok);
  c.dataDestination.host = "evil.example";
  assert.equal(r2.segment.destination.host, "api.z.ai");
  // refusals are frozen too
  const refusal = selectModel(policy([glm]), "implement", task({ reservedBudget: 0 }));
  assert.ok(!refusal.ok && Object.isFrozen(refusal.reasons) && Object.isFrozen(refusal.skipped));
});

test("deterministic: the same inputs give deep-equal results and the policy is not mutated", () => {
  const p = policy([glm, sonnet]);
  const before = JSON.stringify(p);
  const t = task({ allowedDestinations: ["api.anthropic.com"] });
  assert.deepEqual(selectModel(p, "implement", t), selectModel(p, "implement", t));
  const f1 = nextFallback(p, "implement", task(), { model: glm.model, failure: "rate-limit" });
  const f2 = nextFallback(p, "implement", task(), { model: glm.model, failure: "rate-limit" });
  assert.deepEqual(f1, f2);
  assert.equal(JSON.stringify(p), before);
});
