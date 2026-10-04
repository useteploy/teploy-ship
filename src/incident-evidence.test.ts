import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIncidentEvidence, type IncidentEvidenceInput } from "./incident-evidence.js";

const SVC = "api";
const unhealthy = (o: object = {}) => ({ service: SVC, at: "2026-10-04T10:05:00Z", status: "unhealthy" as const, release: "r2", samples: 40, ...o });
const deploy = (o: object = {}) => ({ service: SVC, at: "2026-10-04T10:00:00Z", revision: "r2", outcome: "succeeded" as const, ...o });
const errLog = (o: object = {}) => ({ service: SVC, at: "2026-10-04T10:06:00Z", release: "r2", excerpt: "ok\nERROR handler failed\nok", ...o });
const run = (o: Partial<IncidentEvidenceInput> = {}) => buildIncidentEvidence({ service: SVC, ...o });
const NONE = { service: SVC, state: "none" as const };

test("deploy before onset with matching release and error logs: medium hypothesis, correlation caveat, still escalates", () => {
  const e = run({ health: [unhealthy()], deploys: [deploy()], logs: [errLog()], migration: NONE });
  assert.equal(e.assessment, "unhealthy-observed");
  const h = e.hypotheses[0]!;
  assert.equal(h.confidence, "medium");
  assert.match(h.caveat, /not a cause/);
  assert.equal(e.proposal.status, "candidate-only");
  assert.equal(e.escalation.required, true);
  assert.ok(h.basis.every((id) => e.facts.some((f) => f.id === id)), "every basis id is a recorded fact");
});

test("deploy correlation without release attribution or log corroboration stays low and says what would confirm", () => {
  const e = run({ health: [unhealthy({ release: undefined })], deploys: [deploy()], logs: [], migration: NONE });
  assert.equal(e.hypotheses[0]!.confidence, "low");
  assert.ok(e.hypotheses[0]!.wouldConfirm.length >= 2);
  assert.ok(e.unknowns.some((u) => u.about === "log evidence"));
  assert.ok(e.escalation.actions.length > 0);
});

test("NEGATIVE: no hypothesis is ever high confidence, however much evidence agrees", () => {
  const e = run({
    health: [unhealthy(), unhealthy({ at: "2026-10-04T10:10:00Z" })],
    deploys: [deploy()],
    logs: [errLog({ excerpt: "ERROR column foo does not exist" })],
    migration: { service: SVC, state: "applied", at: "2026-10-04T09:59:00Z", ids: ["003"] },
  });
  assert.ok(e.hypotheses.length >= 2);
  for (const h of e.hypotheses) assert.notEqual(h.confidence as string, "high");
  assert.equal(e.proposal.status, "candidate-only");
});

test("NEGATIVE: another service's unhealthy metrics, logs, deploys and migrations are set aside, not evidence", () => {
  const e = run({
    health: [unhealthy({ service: "billing" })],
    deploys: [deploy({ service: "billing" })],
    logs: [errLog({ service: "billing" })],
    migration: { service: "billing", state: "applied", at: "2026-10-04T09:00:00Z", ids: ["9"] },
  });
  assert.equal(e.assessment, "unknown");
  assert.equal(e.setAside.length, 4);
  assert.equal(e.hypotheses.length, 0);
  assert.ok(!e.facts.some((f) => /billing/.test(f.statement)));
});

test("NEGATIVE: unavailable telemetry, no readings, and thin traffic are unknown, never healthy", () => {
  const cases = [
    [{ service: SVC, at: "2026-10-04T10:00:00Z", status: "unavailable" as const, detail: "token rejected" }],
    [],
    [{ service: SVC, at: "2026-10-04T10:00:00Z", status: "healthy" as const, samples: 0 }],
    [{ service: SVC, at: "2026-10-04T10:00:00Z", status: "healthy" as const, samples: 2 }],
  ];
  for (const health of cases) {
    const e = run({ health });
    assert.equal(e.assessment, "unknown", JSON.stringify(health));
    assert.equal(e.escalation.required, true);
    assert.ok(e.unknowns.some((u) => u.about === "current health"));
  }
});

test("healthy with enough samples is observed healthy and needs no escalation, with the window caveat in the reason", () => {
  const e = run({ health: [{ service: SVC, at: "2026-10-04T10:00:00Z", status: "healthy", samples: 50 }], deploys: [], migration: NONE, logs: [] });
  assert.equal(e.assessment, "healthy-observed");
  assert.equal(e.escalation.required, false);
  assert.match(e.escalation.reason, /window only/);
});

test("unhealthy with no correlating change: no hypothesis, an unknown cause, no proposal, escalation", () => {
  const e = run({ health: [unhealthy()], deploys: [deploy({ at: "2026-09-01T00:00:00Z" })], migration: NONE, logs: [] });
  assert.equal(e.hypotheses.length, 0);
  assert.ok(e.unknowns.some((u) => u.about === "cause"));
  assert.match(e.proposal.note, /no proposal/);
  assert.equal(e.escalation.required, true);
});

test("NEGATIVE: a deploy AFTER onset, or a failed deploy, is not offered as the cause", () => {
  const after = run({ health: [unhealthy()], deploys: [deploy({ at: "2026-10-04T10:30:00Z" })], migration: NONE });
  assert.equal(after.hypotheses.length, 0);
  const failed = run({ health: [unhealthy()], deploys: [deploy({ outcome: "failed" })], migration: NONE });
  assert.equal(failed.hypotheses.length, 0);
});

test("unread migration state and unread deploy history are unknowns, not 'none'", () => {
  const e = run({ health: [unhealthy()] });
  assert.ok(e.unknowns.some((u) => u.about === "migration state"));
  assert.ok(e.unknowns.some((u) => u.about === "recent deploys"));
  assert.ok(!e.facts.some((f) => f.kind === "migration"));
});

test("schema-looking log lines raise a migration hypothesis to medium only with the log", () => {
  const mig = { service: SVC, state: "applied" as const, at: "2026-10-04T09:59:00Z", ids: ["003"] };
  const without = run({ health: [unhealthy()], migration: mig, deploys: [] });
  assert.equal(without.hypotheses.find((h) => /schema/.test(h.statement))!.confidence, "low");
  const withLog = run({ health: [unhealthy()], migration: mig, deploys: [], logs: [errLog({ excerpt: "relation users_v2 does not exist" })] });
  assert.equal(withLog.hypotheses.find((h) => /schema/.test(h.statement))!.confidence, "medium");
});

test("timeline: ordered by time, unparseable timestamps kept last and flagged, nothing dropped", () => {
  const e = run({
    health: [unhealthy({ at: "not-a-time" }), unhealthy({ at: "2026-10-04T10:20:00Z" })],
    deploys: [deploy({ at: "2026-10-04T10:00:00Z" })],
    logs: [errLog({ at: "2026-10-04T10:06:00Z" })],
    migration: NONE,
  });
  const dated = e.timeline.map((t) => t.at).filter((a): a is string => a !== null);
  assert.deepEqual(dated, [...dated].sort());
  const bad = e.timeline.find((t) => t.orderUnknown)!;
  assert.equal(bad.at, null);
  assert.ok(e.timeline.indexOf(bad) >= dated.length, "unordered entry sorts after ordered ones");
  assert.equal(e.timeline.length, e.facts.length);
});

test("log excerpts are clamped in facts", () => {
  const e = run({ logs: [errLog({ excerpt: "ERROR " + "x".repeat(5000) })] });
  assert.ok(e.facts.find((f) => f.kind === "log")!.statement.length < 900);
});
