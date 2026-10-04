import assert from "node:assert/strict";
import { test } from "node:test";

import { compareHistory, digestRun } from "./restore-readiness.js";
import type { HistorySnapshot, RunSnapshot } from "./restore-readiness.js";

const ev = (name: string, data: unknown = {}) => ({ type: "step", name, data });

function run(id: string, extra: Partial<RunSnapshot> = {}): RunSnapshot {
  const events = [ev("a"), ev("b", { n: 1 })];
  return { runId: id, events: events.length, digest: digestRun(events), fingerprint: "s1:abc", ...extra };
}
const snap = (runs: RunSnapshot[]): HistorySnapshot => ({ takenAt: "2026-10-04T00:00:00Z", source: "t", runs });

test("identical history is restored-match", () => {
  const r = compareHistory(snap([run("r1"), run("r2", { waiting: "approval:x" })]), snap([run("r2", { waiting: "approval:x" }), run("r1")]));
  assert.equal(r.verdict, "restored-match");
  assert.equal(r.backupRuns, 2);
  assert.equal(r.eventsRestored, 4);
});

test("unknown is not pass: missing, malformed or empty-backup comparisons are unverified", () => {
  assert.equal(compareHistory(undefined, snap([run("r1")])).verdict, "unverified");
  assert.equal(compareHistory(snap([run("r1")]), undefined).verdict, "unverified");
  assert.equal(compareHistory(snap([run("r1")]), { runs: [{ runId: 1 }] }).verdict, "unverified");
  const empty = compareHistory(snap([]), snap([]));
  assert.equal(empty.verdict, "unverified");
  assert.match(empty.reason ?? "", /nothing was compared/);
});

test("a dropped run is a mismatch and is named", () => {
  const r = compareHistory(snap([run("r1"), run("r2")]), snap([run("r1")]));
  assert.equal(r.verdict, "mismatch");
  assert.deepEqual(r.missing, ["r2"]);
});

test("same counts but swapped content is caught by the digest (counts alone would pass)", () => {
  const other = [ev("a"), ev("b", { n: 2 })];
  const swapped: RunSnapshot = { runId: "r1", events: other.length, digest: digestRun(other), fingerprint: "s1:abc" };
  const r = compareHistory(snap([run("r1")]), snap([swapped]));
  assert.equal(r.backupRuns, r.restoredRuns);
  assert.equal(r.eventsBackup, r.eventsRestored);
  assert.equal(r.verdict, "mismatch");
  assert.deepEqual(r.changed, ["r1"]);
});

test("event order is part of the digest", () => {
  assert.notEqual(digestRun([ev("a"), ev("b")]), digestRun([ev("b"), ev("a")]));
});

test("a lost waiting decision, an extra run and a fingerprint change each break the match", () => {
  const b = snap([run("r1", { waiting: "approval:x" }), run("r2")]);
  assert.deepEqual(compareHistory(b, snap([run("r1"), run("r2")])).waitingLost, ["r1:approval:x"]);
  assert.deepEqual(compareHistory(b, snap([run("r1", { waiting: "approval:x" }), run("r2"), run("r3")])).extra, ["r3"]);
  const fp = compareHistory(b, snap([run("r1", { waiting: "approval:x", fingerprint: "s1:zzz" }), run("r2")]));
  assert.equal(fp.verdict, "mismatch");
  assert.deepEqual(fp.fingerprintChanged, ["r1"]);
});

test("the report carries ids, counts and digests only (no event bodies)", () => {
  const secret = "body-secret-" + "q".repeat(12);
  const events = [ev("a", { token: secret })];
  const s: RunSnapshot = { runId: "r1", events: 1, digest: digestRun(events) };
  const r = compareHistory(snap([s]), snap([s]));
  assert.ok(!JSON.stringify(r).includes(secret));
  assert.ok(!JSON.stringify(s).includes(secret));
});
