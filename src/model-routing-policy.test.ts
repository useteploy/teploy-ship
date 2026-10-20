import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { FALLBACK_TRIGGERS } from "./model-routing.js";
import { classifyFailure, isQuotaExhaustion, loadRoutingPolicy, parsePolicy, routingMode, triggerFor } from "./model-routing-policy.js";
import type { FailureClass } from "./model-routing-policy.js";

const candidate = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  effort: "high",
  capabilities: ["tools"],
  dataDestination: { host: "gw.internal", class: "vpc" },
  retention: "none",
  maxContext: 200_000,
  ...extra,
});

const good = () => ({
  schemaVersion: 1,
  version: "2026-10-04.1",
  fallbackOn: ["outage", "rate-limit"],
  roles: { worker: [candidate("zai/glm-5.3"), candidate("anthropic/claude-sonnet-5")] },
});

function fileWith(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "routing-policy-"));
  const path = join(dir, "policy.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

test("routingMode: only shadow and on enable routing; typos and absence are off", () => {
  assert.equal(routingMode({}), "off");
  assert.equal(routingMode({ SHIP_MODEL_ROUTING: "shadow" }), "shadow");
  assert.equal(routingMode({ SHIP_MODEL_ROUTING: " ON " }), "on");
  for (const v of ["", "1", "true", "enforce", "shadw"]) assert.equal(routingMode({ SHIP_MODEL_ROUTING: v }), "off", v);
});

test("loadRoutingPolicy: unset path means no policy, not an error", () => {
  assert.equal(loadRoutingPolicy({}), undefined);
  assert.equal(loadRoutingPolicy({ SHIP_MODEL_ROUTING_POLICY: "  " }), undefined);
});

test("loadRoutingPolicy: a valid file loads with its digest", () => {
  const path = fileWith(good());
  const a = loadRoutingPolicy({ SHIP_MODEL_ROUTING_POLICY: path });
  assert.ok(a?.ok);
  assert.equal(a.policy.version, "2026-10-04.1");
  assert.equal(a.digest.length, 64);
  // Same bytes, same digest; different bytes with the SAME version label, different digest.
  const b = loadRoutingPolicy({ SHIP_MODEL_ROUTING_POLICY: fileWith(good()) });
  assert.ok(b?.ok);
  assert.equal(b.digest, a.digest);
  const changed = { ...good(), fallbackOn: ["outage"] };
  const c = loadRoutingPolicy({ SHIP_MODEL_ROUTING_POLICY: fileWith(changed) });
  assert.ok(c?.ok);
  assert.notEqual(c.digest, a.digest);
});

test("loadRoutingPolicy: unreadable, non-JSON and invalid files are errors, never throws", () => {
  const missing = loadRoutingPolicy({ SHIP_MODEL_ROUTING_POLICY: "/nonexistent/policy.json" });
  assert.equal(missing?.ok, false);
  const junk = loadRoutingPolicy({ SHIP_MODEL_ROUTING_POLICY: fileWith("{not json") });
  assert.ok(junk && !junk.ok);
  assert.match(junk.errors[0]!, /not JSON/);
});

test("parsePolicy: schemaVersion must be exactly 1 (a newer file is refused, not half-read)", () => {
  for (const v of [undefined, 0, 2, "1"]) {
    const r = parsePolicy({ ...good(), schemaVersion: v });
    assert.ok(!r.ok, String(v));
    assert.match(r.errors.join(), /schemaVersion/);
  }
});

test("parsePolicy: unknown fields, wrong types and semantic errors are all reported", () => {
  assert.ok(!parsePolicy([]).ok);
  assert.match((parsePolicy({ ...good(), extra: 1 }) as { errors: string[] }).errors.join(), /unknown policy field: extra/);
  const typo = good();
  (typo.roles.worker[0] as Record<string, unknown>).dataDestinaton = {};
  assert.match((parsePolicy(typo) as { errors: string[] }).errors.join(), /unknown field dataDestinaton/);
  const noCaps = good();
  (noCaps.roles.worker[0] as Record<string, unknown>).capabilities = "tools";
  assert.match((parsePolicy(noCaps) as { errors: string[] }).errors.join(), /capabilities must be an array/);
  const badTrigger = { ...good(), fallbackOn: ["panic"] };
  assert.match((parsePolicy(badTrigger) as { errors: string[] }).errors.join(), /unknown fallback trigger: panic/);
  const dup = { ...good(), roles: { worker: [candidate("a/m"), candidate("a/m")] } };
  assert.match((parsePolicy(dup) as { errors: string[] }).errors.join(), /duplicate candidate/);
  const noDest = { ...good(), roles: { worker: [candidate("a/m", { dataDestination: undefined })] } };
  assert.match((parsePolicy(noDest) as { errors: string[] }).errors.join(), /no data destination/);
});

test("parsePolicy: absent fallbackOn means never switch", () => {
  const { fallbackOn: _omit, ...rest } = good();
  const r = parsePolicy(rest);
  assert.ok(r.ok);
  assert.deepEqual(r.policy.fallbackOn, []);
});

const err = (message: string, status?: number) => Object.assign(new Error(message), status === undefined ? {} : { status });

test("classifyFailure: each class, by status and by message", () => {
  const cases: Array<[unknown, FailureClass]> = [
    [err("slow down", 429), "rate-limit"],
    [err("Rate limit reached for requests"), "rate-limit"],
    [err("server is at capacity", 429), "overloaded"],
    [err("Overloaded", 529), "overloaded"],
    [err("unavailable", 503), "overloaded"],
    [err("the service is overloaded right now"), "overloaded"],
    [err("prompt is too long: 250000 tokens > 200000", 400), "context-length"],
    [err("maximum context length exceeded"), "context-length"],
    [err("payload too large", 413), "context-length"],
    [err("bad key", 401), "auth"],
    [err("nope", 403), "auth"],
    [err("Incorrect API key provided"), "auth"],
    [err("blocked by content filter policy", 400), "content-filter"],
    [err("The response was blocked by safety systems"), "content-filter"],
    [err("fetch failed"), "network"],
    [err("read ECONNRESET"), "network"],
    [err("request timed out"), "network"],
    [err("bad gateway", 502), "network"],
    [err("internal error", 500), "network"],
    [err("some brand new failure"), "unknown"],
    [err("bad request", 400), "unknown"],
    [undefined, "unknown"],
    ["rate limit", "rate-limit"],
  ];
  for (const [input, want] of cases) {
    assert.equal(classifyFailure(input), want, String((input as Error)?.message ?? input));
  }
});

test("classifyFailure: a status the provider gave beats a misleading message", () => {
  // A 401 whose text mentions a timeout is still a credential problem.
  assert.equal(classifyFailure(err("token refresh timed out", 401)), "auth");
});

// The 2026-10-19 SWE-bench finding, restated as classification: z.ai's
// Anthropic-compatible endpoint reports `[1302][Rate limit reached for
// requests][<id>]`, and @neutron-build/ai's AIError carries the HTTP status
// as `problem.status` — which neither classifier used to read.
const aiError = (message: string, status: number) => {
  const error = new Error(message);
  return Object.assign(error, { problem: { status } });
};

test("classifyFailure: the z.ai 1302 message classifies as a rate limit, however it arrives", () => {
  // Bare message (no status anywhere) — the words carry it.
  assert.equal(classifyFailure(new Error("[1302][Rate limit reached for requests][req-abc123]")), "rate-limit");
  // AIError shape: the status lives on problem.status, not status.
  assert.equal(classifyFailure(aiError("[1302][Rate limit reached for requests][req-abc123]", 429)), "rate-limit");
  // The code alone, if a compat layer ever strips the words — but only in
  // the provider's own bracketed form `[1302]`, which is the only shape
  // z.ai writes it in (2026-10-19 review: a bare `1302` is just four
  // digits, and they turn up inside request ids).
  assert.equal(classifyFailure(err("request rejected: [1302]", 400)), "rate-limit");
  assert.equal(classifyFailure(new Error("provider returned [1302] with no words")), "rate-limit");
  // ...and a bare, unbracketed 1302 inside a status-less message — a
  // request id here — classifies nothing. It used to.
  assert.equal(classifyFailure(new Error("no such row for request id req-8f3a1c-1302 in shard 7")), "unknown");
  assert.equal(classifyFailure(err("request rejected: 1302", 400)), "unknown", "unbracketed behind a 4xx too — format, not presence");
  // A normalised 400 (compat layers do this) still refines to the message.
  assert.equal(classifyFailure(aiError("Too many requests, slow down", 400)), "rate-limit");
  // Overload text behind a 4xx is congestion, not "unknown".
  assert.equal(classifyFailure(aiError("The server is temporarily overloaded", 400)), "overloaded");
});

test("isQuotaExhaustion: congestion-shaped, but nothing a park can outlast (2026-10-19 review)", () => {
  // Each of these classifies rate-limit and must STILL refuse to park —
  // pinned against rateLimitMarkerOf in rate-limit-park.test.ts; here the
  // predicate itself.
  assert.equal(isQuotaExhaustion(err("You exceeded your current quota, please check your plan and billing details", 429)), true);
  assert.equal(isQuotaExhaustion(Object.assign(new Error("Insufficient_quota for this plan"), { problem: { status: 429 } })), true);
  assert.equal(isQuotaExhaustion(err("quota exceeded", 402)), true, "402 is payment-required by definition");
  assert.equal(isQuotaExhaustion(new Error("Your billing balance is negative; add funds to resume")), true, "status-less billing text");
  // Genuine congestion is never quota.
  assert.equal(isQuotaExhaustion(err("Rate limit reached for requests", 429)), false);
  assert.equal(isQuotaExhaustion(new Error("[1302][Rate limit reached for requests][req-abc123]")), false);
  assert.equal(isQuotaExhaustion(err("The server is overloaded", 529)), false);
  assert.equal(isQuotaExhaustion(undefined), false);
});

test("classifyFailure: a 4xx that names nothing transient is still unknown", () => {
  assert.equal(classifyFailure(aiError("model not found", 400)), "unknown");
  assert.equal(classifyFailure(err("bad request shape", 422)), "unknown");
});

test("triggerFor: auth, context-length and unknown can never lead to a switch", () => {
  assert.equal(triggerFor("rate-limit"), "rate-limit");
  assert.equal(triggerFor("overloaded"), "outage");
  assert.equal(triggerFor("network"), "outage");
  assert.equal(triggerFor("content-filter"), "refusal");
  for (const cls of ["auth", "context-length", "unknown"] as const) assert.equal(triggerFor(cls), undefined, cls);
  // Whatever it returns is a trigger the engine knows.
  for (const cls of ["rate-limit", "overloaded", "network", "content-filter"] as const) {
    assert.ok(FALLBACK_TRIGGERS.includes(triggerFor(cls)!));
  }
});
