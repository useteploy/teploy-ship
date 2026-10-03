import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyFindingContinuity,
  findingFingerprint,
  parseUnifiedDiff,
  type ContinuityResult,
  type ReviewFinding,
} from "./finding-continuity.js";

const SQL = `db.query("SELECT * FROM u WHERE id=" + user.id);`;

function sql(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    title: "SQL built by string concatenation",
    severity: "high",
    file: "src/pay.ts",
    line: 5,
    detail: "user.id is concatenated into the query",
    snippet: SQL,
    ...over,
  };
}

function nullCheck(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    title: "Missing null check on rate lookup",
    severity: "med",
    file: "src/pay.ts",
    line: 4,
    detail: "rate may be undefined",
    snippet: "const total = amt * rate;",
    ...over,
  };
}

const run = (prior: ReviewFinding[], later: ReviewFinding[], diff?: string, baseDiff?: string): ContinuityResult =>
  classifyFindingContinuity({
    prior: { revision: "r1", findings: prior },
    later: { revision: "r2", findings: later },
    ...(diff !== undefined ? { diff } : {}),
    ...(baseDiff !== undefined ? { baseDiff } : {}),
  });

/** What matching on (file, line) alone would say. The negative control. */
function naiveByLine(prior: ReviewFinding[], later: ReviewFinding[]): { resolved: number; newCount: number; stillOpen: number } {
  let stillOpen = 0;
  for (const p of prior) if (later.some((l) => l.file === p.file && l.line === p.line)) stillOpen += 1;
  return { stillOpen, resolved: prior.length - stillOpen, newCount: later.length - stillOpen };
}

// Three lines inserted above everything: every later line is +3.
const DRIFT_DIFF = `--- a/src/pay.ts
+++ b/src/pay.ts
@@ -1,3 +1,6 @@
 import x

+import y
+import z
+import w
 export function charge(user, amt) {
`;

test("line drift from an insertion above is still-open, not fixed-and-new", () => {
  const prior = [sql()];
  const later = [sql({ line: 8 })];
  const r = run(prior, later, DRIFT_DIFF);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0]!.status, "still-open");
  assert.equal(r.entries[0]!.id, findingFingerprint(prior[0]!));
  // Negative control: line-number-only matching reads the same input as one
  // fix plus one brand new finding.
  assert.deepEqual(naiveByLine(prior, later), { stillOpen: 0, resolved: 1, newCount: 1 });
});

test("drift is tolerated with no diff at all, because identity rests on the cited code", () => {
  const r = run([sql()], [sql({ line: 31 })]);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0]!.status, "still-open");
  assert.equal(r.diffAvailable, false);
});

test("a reworded title for the same code at a drifted line is still the same finding", () => {
  const r = run([sql()], [sql({ line: 8, title: "String-concatenated SQL query" })], DRIFT_DIFF);
  assert.equal(r.entries[0]!.status, "still-open");
});

test("two different findings that merely share a line are NOT the same finding", () => {
  // Negative control for the other direction: line-only matching would pair
  // these (same file, same line) and report a fix as still-open.
  const a = sql({ line: 5 });
  const b = { ...nullCheck(), line: 5 };
  const r = run([a], [b]);
  assert.deepEqual(r.entries.map((e) => e.status).sort(), ["new", "superseded"]);
  assert.equal(naiveByLine([a], [b]).stillOpen, 1);
});

test("a block cut and pasted lower in the same file is moved, not drift", () => {
  const diff = `--- a/src/pay.ts
+++ b/src/pay.ts
@@ -3,5 +3,3 @@
 export function charge(user, amt) {
   const total = amt * rate;
-  db.query("SELECT * FROM u WHERE id=" + user.id);
   return total;
 }
@@ -7,0 +6,14 @@
+// filler 1
+// filler 2
+// filler 3
+// filler 4
+// filler 5
+// filler 6
+// filler 7
+// filler 8
+// filler 9
+// filler 10
+export function lookup(user) {
+  db.query("SELECT * FROM u WHERE id=" + user.id);
+  return 1;
+}
`;
  const r = run([sql()], [sql({ line: 17 })], diff);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0]!.status, "moved");
  assert.deepEqual(r.entries[0]!.movedFrom, { file: "src/pay.ts", line: 5 });
});

test("the same code reported in another file is moved, with its origin kept", () => {
  const r = run([sql()], [sql({ file: "src/db/users.ts", line: 12 })]);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0]!.status, "moved");
  assert.equal(r.entries[0]!.movedFrom?.file, "src/pay.ts");
  assert.equal(r.entries[0]!.id, findingFingerprint(sql()));
});

test("a trivial one-line snippet is not enough to claim a cross-file move", () => {
  const p = sql({ snippet: "return null;", title: "Returns null on failure" });
  const l = sql({ snippet: "return null;", title: "Returns null on failure", file: "src/other.ts" });
  const r = run([p], [l]);
  assert.deepEqual(r.entries.map((e) => e.status).sort(), ["new", "unconfirmed-disappearance"]);
});

test("a renamed file keeps the finding open, with the old name recorded", () => {
  const diff = `diff --git a/src/pay.ts b/src/billing.ts
similarity index 100%
rename from src/pay.ts
rename to src/billing.ts
`;
  const prior = [sql()];
  const later = [sql({ file: "src/billing.ts" })];
  const r = run(prior, later, diff);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0]!.status, "still-open");
  assert.equal(r.entries[0]!.renamedFrom, "src/pay.ts");
  // Negative control: matching on path + line calls it fixed plus new.
  assert.equal(naiveByLine(prior, later).stillOpen, 0);
});

test("a finding whose cited line the diff rewrote, and which is no longer reported, is resolved", () => {
  const diff = `--- a/src/pay.ts
+++ b/src/pay.ts
@@ -4,3 +4,3 @@
   const total = amt * rate;
-  db.query("SELECT * FROM u WHERE id=" + user.id);
+  db.query("SELECT * FROM u WHERE id=$1", [user.id]);
   return total;
`;
  const r = run([sql()], [], diff);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0]!.status, "resolved");
  assert.match(r.entries[0]!.reason, /line 5/);
});

test("a deleted file resolves its findings", () => {
  const diff = `diff --git a/src/pay.ts b/src/pay.ts
deleted file mode 100644
--- a/src/pay.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-import x
-
`;
  assert.equal(run([sql()], [], diff).entries[0]!.status, "resolved");
});

const UNRELATED_DIFF = `--- a/src/pay.ts
+++ b/src/pay.ts
@@ -1,3 +1,4 @@
 import x
+import y

 export function charge(user, amt) {
`;

test("code untouched by the diff but missing from the report is NOT resolved", () => {
  const r = run([sql()], [], UNRELATED_DIFF);
  assert.equal(r.entries.length, 1, "the finding is still listed, never dropped");
  assert.equal(r.entries[0]!.status, "unconfirmed-disappearance");
  assert.match(r.entries[0]!.reason, /unchanged by the diff/);
  assert.equal(r.counts.resolved, 0);
});

test("with no diff, nothing can be shown fixed", () => {
  const r = run([sql(), nullCheck()], []);
  assert.deepEqual(r.entries.map((e) => e.status), ["unconfirmed-disappearance", "unconfirmed-disappearance"]);
  assert.equal(r.counts.resolved, 0);
});

test("an identical-revision (empty) diff is evidence of no change, not missing evidence", () => {
  const r = run([sql()], [], "");
  assert.equal(r.diffAvailable, true);
  assert.equal(r.entries[0]!.status, "unconfirmed-disappearance");
});

test("an unparseable diff is reported and does not unlock resolution", () => {
  const r = run([sql()], [], "this is not a diff");
  assert.equal(r.diffAvailable, false);
  assert.equal(r.entries[0]!.status, "unconfirmed-disappearance");
  assert.equal(r.warnings.length, 1);
});

test("a whitespace-only reformat of the cited line is not a fix", () => {
  const diff = `--- a/src/pay.ts
+++ b/src/pay.ts
@@ -5,1 +5,1 @@
-  db.query("SELECT * FROM u WHERE id=" + user.id);
+  db.query("SELECT * FROM u WHERE id="   +   user.id) ;
`;
  const r = run([sql()], [], diff);
  assert.equal(r.entries[0]!.status, "unconfirmed-disappearance");
  assert.match(r.entries[0]!.reason, /cosmetically/);
});

test("a guard inserted just above the cited line is not treated as proof of a fix", () => {
  const diff = `--- a/src/pay.ts
+++ b/src/pay.ts
@@ -4,2 +4,3 @@
   const total = amt * rate;
+  if (!user) throw new Error("no user");
   db.query("SELECT * FROM u WHERE id=" + user.id);
`;
  assert.equal(run([sql()], [], diff).entries[0]!.status, "unconfirmed-disappearance");
});

test("a finding with a line but no snippet is matched by wording and mapped line", () => {
  const p = sql({ snippet: undefined });
  const l = sql({ snippet: undefined, line: 8 });
  assert.equal(run([p], [l], DRIFT_DIFF).entries[0]!.status, "still-open");
});

test("a finding that cites neither line nor code cannot be shown fixed", () => {
  const p: ReviewFinding = { title: "Auth is weak", severity: "high", file: "src/pay.ts", detail: "d" };
  const r = run([p], [], UNRELATED_DIFF);
  assert.equal(r.entries[0]!.status, "unconfirmed-disappearance");
});

test("near-duplicate findings in one report are folded, with the loser kept", () => {
  const dup = sql({ title: "SQL built by string concatenation (injection)", severity: "med", line: 6 });
  const r = run([sql(), dup], [sql({ line: 8 })], DRIFT_DIFF);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0]!.mergedDuplicates.length, 1);
  assert.equal(r.entries[0]!.mergedDuplicates[0]!.severity, "med");
  assert.equal(r.entries[0]!.status, "still-open");
});

test("the higher-severity duplicate is the one that is kept", () => {
  const lo = sql({ severity: "low" });
  const hi = sql({ severity: "high", title: "SQL built by string concatenation, injectable" });
  const r = run([lo, hi], []);
  assert.equal(r.entries[0]!.finding.severity, "high");
  assert.equal(r.entries[0]!.mergedDuplicates[0], lo);
});

test("distinct findings with similar wording but different code stay separate", () => {
  const a = sql();
  const b = sql({ snippet: `db.exec("DELETE FROM u WHERE id=" + user.id);`, line: 9 });
  const r = run([a, b], [a, b]);
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.entries.map((e) => e.status), ["still-open", "still-open"]);
  assert.notEqual(r.entries[0]!.id, r.entries[1]!.id);
});

test("two identical-title findings at different places are paired to their own counterparts", () => {
  const a = sql({ snippet: undefined, line: 10 });
  const b = sql({ snippet: undefined, line: 90 });
  // Later report lists them in the opposite order, both drifted by +2.
  const r = run([a, b], [{ ...b, line: 92 }, { ...a, line: 12 }]);
  const byId = (line: number) => r.entries.find((e) => e.prior?.line === line)!;
  assert.equal(byId(10).current?.line, 12);
  assert.equal(byId(90).current?.line, 92);
});

test("every input finding is accounted for, whatever happens to it", () => {
  const prior = [sql(), nullCheck(), sql({ title: "SQL built by string concatenation (injection)", line: 6 }), sql({ file: "src/gone.ts", snippet: "x()", line: 2, title: "other" })];
  const later = [nullCheck({ line: 7 }), sql({ file: "src/new.ts", snippet: "y()", title: "brand new problem", line: 3 })];
  const r = run(prior, later, UNRELATED_DIFF);
  const seen = new Set<ReviewFinding>();
  for (const e of r.entries) {
    if (e.prior) seen.add(e.prior);
    if (e.current) seen.add(e.current);
    for (const d of e.mergedDuplicates) seen.add(d);
  }
  for (const f of [...prior, ...later]) assert.ok(seen.has(f), `dropped: ${f.title}`);
  assert.equal(Object.values(r.counts).reduce((a, b) => a + b, 0), r.entries.length);
});

test("a finding in the new report that nothing earlier matches is new", () => {
  const r = run([], [sql()]);
  assert.equal(r.entries[0]!.status, "new");
});

test("the same location reported under a different diagnosis supersedes the old finding", () => {
  const p = sql();
  const l = sql({ title: "Query result unchecked before use", snippet: SQL + " // changed", detail: "different issue" });
  const r = run([p], [l]);
  const old = r.entries.find((e) => e.prior)!;
  const neu = r.entries.find((e) => e.current)!;
  assert.equal(old.status, "superseded");
  assert.equal(neu.status, "new");
  assert.equal(old.supersededBy, neu.id);
  assert.equal(neu.supersedes, old.id);
});

test("a human resolution contradicted by a later automated finding is regressed, and says so", () => {
  const decided = sql({ resolution: { by: "human", actor: "tyler", note: "accepted, internal only" } });
  const r = run([decided], [sql({ line: 8 })], DRIFT_DIFF);
  const e = r.entries[0]!;
  assert.equal(e.status, "regressed");
  assert.equal(e.humanResolutionOverridden, true);
  assert.equal(e.resolution?.actor, "tyler");
  // Negative control: without the resolution the same pair is plain still-open.
  assert.equal(run([sql()], [sql({ line: 8 })], DRIFT_DIFF).entries[0]!.status, "still-open");
});

test("an automated resolution that reappears is regressed but not a human override", () => {
  const r = run([sql({ resolution: { by: "automated", actor: "verify-step" } })], [sql()]);
  assert.equal(r.entries[0]!.status, "regressed");
  assert.equal(r.entries[0]!.humanResolutionOverridden, undefined);
});

test("a human resolution stays resolved while the finding is absent, carried with its decision", () => {
  const decided = sql({ resolution: { by: "human", actor: "tyler" } });
  const r = run([decided], [], UNRELATED_DIFF);
  assert.equal(r.entries[0]!.status, "resolved");
  assert.equal(r.entries[0]!.resolution?.by, "human");
  const noDiff = run([decided], []);
  assert.equal(noDiff.entries[0]!.status, "resolved", "a person's decision does not depend on having a diff");
});

test("comments carry across revisions without duplication", () => {
  const c1 = { author: "tyler", body: "known, tracked in #12" };
  const r = run([sql({ comments: [c1] })], [sql({ comments: [c1, { author: "bot", body: "still here" }] })]);
  assert.deepEqual(r.entries[0]!.comments.map((c) => c.body), ["known, tracked in #12", "still here"]);
});

test("a stable id assigned earlier is carried onto the matched finding", () => {
  const r = run([sql({ id: "fnd_custom" })], [sql({ line: 40 })]);
  assert.equal(r.entries[0]!.id, "fnd_custom");
});

test("fingerprint ignores line, whitespace and severity but not file or code", () => {
  const base = findingFingerprint(sql());
  assert.equal(findingFingerprint(sql({ line: 99, severity: "low" })), base);
  assert.equal(findingFingerprint(sql({ snippet: `  db.query( "SELECT * FROM u WHERE id=" + user.id ) ;` })), base);
  assert.notEqual(findingFingerprint(sql({ file: "src/other.ts" })), base);
  assert.notEqual(findingFingerprint(sql({ snippet: "db.query(safe);" })), base);
});

// ── Attribution ──────────────────────────────────────────────────────────

const ADD_DIFF = `--- a/src/pay.ts
+++ b/src/pay.ts
@@ -4,3 +4,4 @@
   const total = amt * rate;
+  db.query("SELECT * FROM u WHERE id=" + user.id);
   return total;
`;

test("a new finding on lines the revision added is introduced", () => {
  const r = run([], [sql({ line: 5 })], ADD_DIFF);
  assert.equal(r.entries[0]!.attribution.kind, "introduced");
  assert.equal(r.entries[0]!.attribution.basis, "revision-diff");
});

test("a new finding on untouched lines is undeterminable from a revision diff alone, and says why", () => {
  const r = run([], [nullCheck({ line: 4 })], ADD_DIFF);
  const a = r.entries[0]!.attribution;
  assert.equal(a.kind, "undeterminable");
  assert.match(a.reason, /base diff is needed/);
});

test("with a base diff, untouched lines are existing and touched lines introduced", () => {
  const base = `--- a/src/pay.ts
+++ b/src/pay.ts
@@ -5,0 +6,1 @@
+  doNewThing();
`;
  const untouched = run([], [nullCheck({ line: 4 })], ADD_DIFF, base).entries[0]!.attribution;
  assert.equal(untouched.kind, "existing");
  assert.equal(untouched.basis, "base-diff");
  const touched = run([], [sql({ line: 6, snippet: "doNewThing();", title: "x" })], ADD_DIFF, base).entries[0]!.attribution;
  assert.equal(touched.kind, "introduced");
});

test("attribution is undeterminable with no diff and for a finding that cites nothing", () => {
  assert.equal(run([], [sql()]).entries[0]!.attribution.kind, "undeterminable");
  const bare: ReviewFinding = { title: "t", severity: "low", file: "src/pay.ts", detail: "d" };
  const a = run([], [bare], ADD_DIFF).entries[0]!.attribution;
  assert.equal(a.kind, "undeterminable");
  assert.match(a.reason, /neither a line nor code/);
});

test("a finding in a file the revision added is introduced", () => {
  const diff = `--- /dev/null
+++ b/src/fresh.ts
@@ -0,0 +1,2 @@
+a();
+b();
`;
  const f = sql({ file: "src/fresh.ts", line: 2 });
  assert.equal(run([], [f], diff).entries[0]!.attribution.kind, "introduced");
});

test("an earlier determinable attribution is kept when the finding is still open", () => {
  const r = run([sql({ attribution: "existing" })], [sql({ line: 8 })], DRIFT_DIFF);
  assert.equal(r.entries[0]!.attribution.kind, "existing");
  assert.equal(r.entries[0]!.attribution.basis, "carried");
});

// ── Diff parsing ─────────────────────────────────────────────────────────

test("parseUnifiedDiff reads renames, additions and a removed line that looks like a header", () => {
  const files = parseUnifiedDiff(`diff --git a/a.txt b/b.txt
rename from a.txt
rename to b.txt
--- a/a.txt
+++ b/b.txt
@@ -1,2 +1,2 @@
 keep
--- not a header
+added
`);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.oldPath, "a.txt");
  assert.equal(files[0]!.newPath, "b.txt");
  assert.deepEqual(files[0]!.hunks[0]!.lines.map((l) => l.t), [" ", "-", "+"]);
});
