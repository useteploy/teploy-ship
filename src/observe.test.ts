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

// ---------------------------------------------------------------- read path

import {
  MIN_REQUESTS_FOR_A_VERDICT,
  compareAroundNow,
  compareHealth,
  telemetryAppliesTo,
  readServiceHealth,
  telemetryComment,
  telemetryTargetFromEnv,
  type ServiceHealth,
} from "./observe.js";

const RED = (over: Partial<ServiceHealth> = {}): ServiceHealth => ({
  service: "api",
  requests: 1000,
  errors: 10,
  errorRate: 0.01,
  p50: 40,
  p95: 120,
  p99: 300,
  apdex: 0.95,
  ...over,
});

function fetchStub(status: number, body: unknown, seen: { url?: string; headers?: Record<string, string> } = {}) {
  return (async (url: string, init?: { headers?: Record<string, string> }) => {
    seen.url = String(url);
    seen.headers = init?.headers ?? {};
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as unknown as typeof globalThis.fetch;
}

test("a read is authenticated by share token, scoped to one service, and asks a well-formed window", async () => {
  const seen: { url?: string; headers?: Record<string, string> } = {};
  const target = {
    url: "https://observe.example.com",
    token: "tok-123",
    service: "api",
    repo: "o/api",
    fetch: fetchStub(200, [
      { service_name: "web", request_count: 5, error_count: 5 },
      { service_name: "api", request_count: 200, error_count: 4, p50_ms: 30, p95_ms: 110, p99_ms: 250, apdex_score: 0.97 },
    ], seen),
  };
  const health = await readServiceHealth(target, new Date("2026-08-19T00:00:00Z"), new Date("2026-08-19T01:00:00Z"));

  assert.deepEqual(health, {
    kind: "ok",
    health: {
    service: "api",
    requests: 200,
    errors: 4,
    errorRate: 0.02,
    p50: 30,
    p95: 110,
    p99: 250,
    apdex: 0.97,
    },
  });
  assert.equal(seen.headers?.["X-Share-Token"], "tok-123", "the share token is the only credential a worker can hold");
  // RFC3339 exactly: Observe silently falls back to "the last 24 hours" on an
  // unparseable timestamp, so a formatting slip answers a different question.
  assert.match(seen.url ?? "", /from=2026-08-19T00%3A00%3A00\.000Z/);
  assert.match(seen.url ?? "", /to=2026-08-19T01%3A00%3A00\.000Z/);
});

test("a telemetry read never throws and never invents a number", async () => {
  const base = { url: "https://o.example.com", token: "t", service: "api", repo: "o/api" };
  // Service absent from the window is a real answer, not a zero-error service.
  assert.deepEqual(
    await readServiceHealth({ ...base, fetch: fetchStub(200, [{ service_name: "other" }]) }, new Date(), new Date()),
    { kind: "absent" },
  );
  const boom = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof globalThis.fetch;
  for (const fetch of [fetchStub(401, {}), fetchStub(403, {}), fetchStub(500, {}), fetchStub(200, { not: "an array" }), boom]) {
    const read = await readServiceHealth({ ...base, fetch }, new Date(), new Date());
    assert.equal(read.kind, "rejected", "an unusable read is never reported as an empty window");
  }
});

// Found by running this against a live Observe: a revoked share token and a
// service with no traffic produced the SAME pull-request line, "no telemetry
// for this service in either window". An operator reads that as a fact about
// the deploy when it is a fact about their credential.
// Found by running the real thing: a worker configured to watch `fylun-web`
// put that service's RED metrics on a pull request that changed one line of Go
// in an unrelated repo. The numbers were real and the attribution was nonsense
// — the reviewer saw "p95 up 2653ms" under a change that could not have caused
// it. minRequests guards against too LITTLE data; nothing guarded against data
// about the wrong thing, which is worse, because it reads as a finding.
test("telemetry only applies to the repo its service is built from", () => {
  const target = { url: "https://o.example.com", token: "t", service: "fylun-web", repo: "tyler/fylun-web" };

  assert.equal(telemetryAppliesTo(target, "tyler/fylun-web"), true);
  // Same repo, different URL shapes — all of these are the configured repo.
  assert.equal(telemetryAppliesTo(target, "https://git.example.com/tyler/fylun-web.git"), true);
  assert.equal(telemetryAppliesTo(target, "git@git.example.com:tyler/fylun-web"), true);
  assert.equal(telemetryAppliesTo(target, "HTTPS://GIT.EXAMPLE.COM/Tyler/Fylun-Web/"), true);

  // The live mistake.
  assert.equal(telemetryAppliesTo(target, "http://forge/Tyler/ship-e2e-20260821"), false);
  // A same-named repo under a different owner is a different repo.
  assert.equal(telemetryAppliesTo(target, "https://git.example.com/someoneelse/fylun-web"), false);
  // A run with no repo at all cannot be about this service.
  assert.equal(telemetryAppliesTo(target, undefined), false);
  assert.equal(telemetryAppliesTo(target, ""), false);
  // Unparseable answers false: a comparison that cannot be made is not a match.
  assert.equal(telemetryAppliesTo(target, "fylun-web"), false);
});

test("no OBSERVE_REPO means no telemetry target at all", () => {
  const base = { OBSERVE_URL: "https://o.example.com", OBSERVE_READ_TOKEN: "t", OBSERVE_SERVICE: "api" };
  assert.equal(telemetryTargetFromEnv(base as NodeJS.ProcessEnv), undefined, "without a repo the leg cannot know what it is measuring");
  const withRepo = telemetryTargetFromEnv({ ...base, OBSERVE_REPO: "o/api" } as NodeJS.ProcessEnv);
  assert.equal(withRepo?.repo, "o/api");
});

test("a refused read is reported as a wiring fault, not as an empty window", async () => {
  const base = { url: "https://o.example.com", token: "revoked", service: "api", repo: "o/api", windowMinutes: 30 };
  const verdict = await compareAroundNow({ ...base, fetch: fetchStub(401, {}) }, new Date("2026-08-21T00:00:00Z"));
  assert.equal(verdict.kind, "unavailable");
  assert.match(verdict.reason ?? "", /401/);
  assert.match(verdict.reason ?? "", /token/, "the message has to name the credential, or it is not actionable");
  assert.doesNotMatch(
    verdict.reason ?? "",
    /no telemetry for this service/,
    "this is exactly the sentence that made a broken token look like an idle service",
  );

  // And the honest empty case still says what it always said.
  const empty = await compareAroundNow({ ...base, fetch: fetchStub(200, []) }, new Date("2026-08-21T00:00:00Z"));
  assert.equal(empty.kind, "unavailable");
  assert.match(empty.reason ?? "", /no telemetry for this service/);
});

test("a verdict is refused when the traffic cannot carry one", () => {
  // The important half. A preview environment serves almost no traffic, so the
  // naive default is a confident number computed from a handful of requests.
  const thin = compareHealth(RED({ requests: 5, errors: 0, errorRate: 0 }), RED({ requests: 4, errors: 0, errorRate: 0 }));
  assert.equal(thin.kind, "insufficient");
  assert.match((thin as { reason: string }).reason, /too little traffic/);

  assert.equal(compareHealth(null, null).kind, "unavailable");
  assert.equal(compareHealth(RED(), null).kind, "insufficient");
  assert.equal(compareHealth(null, RED()).kind, "insufficient");

  // One request short of the floor on either side is still a refusal.
  const min = MIN_REQUESTS_FOR_A_VERDICT;
  assert.equal(compareHealth(RED({ requests: min }), RED({ requests: min - 1 })).kind, "insufficient");
  assert.equal(compareHealth(RED({ requests: min }), RED({ requests: min })).kind, "compared");
});

test("a real comparison reports the deltas it measured, in the direction it measured them", () => {
  const v = compareHealth(RED({ requests: 1000, errors: 50, errorRate: 0.05, p95: 200 }), RED({ requests: 900, errors: 9, errorRate: 0.01, p95: 150 }));
  assert.equal(v.kind, "compared");
  const c = v as { errorRateDelta: number; p95Delta: number };
  assert.ok(Math.abs(c.errorRateDelta - -0.04) < 1e-9, "error rate fell four points");
  assert.equal(c.p95Delta, -50);

  const text = telemetryComment(v, "run-9");
  assert.match(text, /5\.00%/);
  assert.match(text, /1\.00%/);
  assert.match(text, /down/);
  // No causal claim: other deploys and traffic mix are not controlled for.
  assert.match(text, /Correlation only/);
  assert.doesNotMatch(text, /caused|because of this change|proves/i);
});

test("an insufficient verdict says so plainly instead of implying a result", () => {
  const text = telemetryComment(compareHealth(RED({ requests: 3 }), RED({ requests: 2 })), "run-9");
  assert.match(text, /Not enough data to compare/);
  assert.match(text, /measurement, not a verdict/);
  assert.doesNotMatch(text, /\bimproved\b|\bregressed\b/i);

  assert.match(telemetryComment({ kind: "unavailable", reason: "no telemetry for this service in either window" }, "r"), /No measurement/);
});

test("a worker reads telemetry only with all four of url, token, service and repo", () => {
  const full = { OBSERVE_URL: "https://o/", OBSERVE_READ_TOKEN: "t", OBSERVE_SERVICE: "api", OBSERVE_REPO: "o/api" };
  assert.equal(telemetryTargetFromEnv({}), undefined);
  assert.equal(telemetryTargetFromEnv({ OBSERVE_URL: "https://o", OBSERVE_READ_TOKEN: "t" }), undefined, "without a service name there is nothing to look up");
  assert.equal(telemetryTargetFromEnv({ OBSERVE_URL: "https://o", OBSERVE_SERVICE: "api" }), undefined, "the ingest key must not be reused as a read credential");
  // The fourth is new, and is the one a live run proved necessary.
  assert.equal(
    telemetryTargetFromEnv({ OBSERVE_URL: "https://o", OBSERVE_READ_TOKEN: "t", OBSERVE_SERVICE: "api" }),
    undefined,
    "without a repo the leg cannot tell whether the service has anything to do with the run",
  );
  assert.deepEqual(telemetryTargetFromEnv(full), { url: "https://o", token: "t", service: "api", repo: "o/api" });
  assert.deepEqual(
    telemetryTargetFromEnv({ ...full, OBSERVE_MIN_REQUESTS: "500" }),
    { url: "https://o", token: "t", service: "api", repo: "o/api", minRequests: 500 },
  );
});

// --- P1-4 / L4: is a measured comparison bad enough to act on? --------------

import { defaultRegressionThresholds, telemetryRegression, type TelemetryVerdict } from "./observe.js";

const health = (errorRate: number, p95: number): ServiceHealth => RED({ errorRate, p95 });

const compared = (before: ServiceHealth, after: ServiceHealth): TelemetryVerdict => ({
  kind: "compared",
  before,
  after,
  errorRateDelta: after.errorRate - before.errorRate,
  p95Delta: after.p95 - before.p95,
});

test("P1-4: only a COMPARED verdict can be a regression", () => {
  // The refusal is the point, and it is the same posture as compareHealth's:
  // a rollback is destructive, and "we could not measure it" is not evidence.
  for (const verdict of [
    { kind: "disabled", reason: "no telemetry target configured on this worker" },
    { kind: "unavailable", reason: "observe unreachable" },
    { kind: "insufficient", reason: "too little traffic", before: null, after: null },
  ] as TelemetryVerdict[]) {
    const r = telemetryRegression(verdict);
    assert.equal(r.worse, false, `${verdict.kind} must never be a regression`);
    assert.match(r.reasons.join(" "), new RegExp(verdict.kind));
  }
});

test("P1-4: a point of extra errors is a regression; a tenth of one is not", () => {
  assert.equal(telemetryRegression(compared(health(0.01, 100), health(0.03, 100))).worse, true);
  assert.equal(telemetryRegression(compared(health(0.01, 100), health(0.011, 100))).worse, false);
  assert.match(
    telemetryRegression(compared(health(0.01, 100), health(0.03, 100))).reasons.join(" "),
    /error rate up 2\.00%/,
  );
});

test("P1-4: p95 needs BOTH a ratio and an absolute move — 4ms to 6ms is not a regression", () => {
  // The failure this guards against: a fast service's jitter reads as a 50%
  // latency regression on the ratio alone and would roll a healthy deploy back.
  assert.equal(telemetryRegression(compared(health(0.001, 4), health(0.001, 6))).worse, false);
  // Ratio without the absolute floor: 50ms -> 80ms is 1.6x but under 100ms.
  assert.equal(telemetryRegression(compared(health(0.001, 50), health(0.001, 80))).worse, false);
  // Absolute without the ratio: 2000ms -> 2150ms is +150ms but only 1.075x.
  assert.equal(telemetryRegression(compared(health(0.001, 2000), health(0.001, 2150))).worse, false);
  // Both: 200ms -> 600ms.
  const bad = telemetryRegression(compared(health(0.001, 200), health(0.001, 600)));
  assert.equal(bad.worse, true);
  assert.match(bad.reasons.join(" "), /p95 up 400ms .*3\.00x/);
});

test("P1-4: p95 rising from a measured zero is a regression once it clears the floor", () => {
  const r = telemetryRegression(compared(health(0.001, 0), health(0.001, 300)));
  assert.equal(r.worse, true);
  assert.match(r.reasons.join(" "), /from zero/);
  // ...but not below the floor, where it is still noise.
  assert.equal(telemetryRegression(compared(health(0.001, 0), health(0.001, 30))).worse, false);
});

test("P1-4: an improvement is never a regression, and says the numbers anyway", () => {
  const r = telemetryRegression(compared(health(0.05, 900), health(0.01, 200)));
  assert.equal(r.worse, false);
  assert.match(r.reasons.join(" "), /inside the thresholds/);
  assert.deepEqual(defaultRegressionThresholds, { errorRateDelta: 0.01, p95Ratio: 1.25, minP95DeltaMs: 100 });
});
