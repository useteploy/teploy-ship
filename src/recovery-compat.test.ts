import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRecoveryCompat, planIsSpecific, type RecoveryCompatInput } from "./recovery-compat.js";

const base = (o: Partial<RecoveryCompatInput> = {}): RecoveryCompatInput => ({
  retainedRevision: "v1",
  retainedKnownMigrations: ["001", "002"],
  appliedMigrations: [{ id: "001", class: "expand" }, { id: "002", class: "expand" }],
  ...o,
});

test("no newer migration: compatible, and never claims the artifact rollback itself", () => {
  const r = checkRecoveryCompat(base());
  assert.equal(r.verdict, "compatible");
  assert.equal(r.provesArtifactRollback, false);
});

test("newer additive migrations stay compatible", () => {
  const r = checkRecoveryCompat(base({ appliedMigrations: [{ id: "001", class: "expand" }, { id: "003", class: "expand" }] }));
  assert.equal(r.verdict, "compatible");
  assert.deepEqual(r.newerMigrations, ["003"]);
});

test("NEGATIVE: a newer contract or irreversible migration is incompatible, not compatible", () => {
  for (const cls of ["contract", "irreversible"] as const) {
    const r = checkRecoveryCompat(base({ appliedMigrations: [{ id: "003", class: cls }] }));
    assert.equal(r.verdict, "incompatible", cls);
    assert.deepEqual(r.blocking, ["003"]);
    assert.equal(r.recoveryPlan, "missing");
  }
});

test("a specific recovery plan is recorded but does not turn the verdict into a pass; a vague one is missing", () => {
  const ok = checkRecoveryCompat(base({ appliedMigrations: [{ id: "003", class: "irreversible" }], recoveryPlan: { strategy: "backup-restore", reference: "backup-2026-10-04" } }));
  assert.equal(ok.verdict, "incompatible");
  assert.equal(ok.recoveryPlan, "present");
  const vague = checkRecoveryCompat(base({ appliedMigrations: [{ id: "003", class: "irreversible" }], recoveryPlan: { strategy: "forward-fix", reference: "  " } }));
  assert.equal(vague.recoveryPlan, "missing");
  assert.equal(planIsSpecific(undefined), false);
});

test("NEGATIVE: unknown is hold, never compatible (each unread side, missing class, no retained revision)", () => {
  assert.equal(checkRecoveryCompat(base({ appliedMigrations: undefined })).verdict, "hold");
  assert.equal(checkRecoveryCompat(base({ retainedKnownMigrations: undefined })).verdict, "hold");
  assert.equal(checkRecoveryCompat(base({ retainedRevision: " " })).verdict, "hold");
  const unclassified = checkRecoveryCompat(base({ appliedMigrations: [{ id: "003" }] }));
  assert.equal(unclassified.verdict, "hold");
  assert.deepEqual(unclassified.unclassified, ["003"]);
  assert.equal(checkRecoveryCompat(base({ appliedMigrations: [{ id: "003", class: "unknown" }] })).verdict, "hold");
});

test("a known-destructive migration is not hidden behind an unclassified one", () => {
  const r = checkRecoveryCompat(base({ appliedMigrations: [{ id: "003" }, { id: "004", class: "contract" }] }));
  assert.equal(r.verdict, "incompatible");
  assert.deepEqual(r.unclassified, ["003"]);
});

test("repeated ids count once; an empty applied list is read-and-none, not unknown", () => {
  assert.equal(checkRecoveryCompat(base({ appliedMigrations: [] })).verdict, "compatible");
  const r = checkRecoveryCompat(base({ appliedMigrations: [{ id: "003", class: "expand" }, { id: "003", class: "expand" }] }));
  assert.deepEqual(r.newerMigrations, ["003"]);
});
