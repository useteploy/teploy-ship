import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileRepoStatsStore,
  SUGGEST_MIN_SENT,
  costPerMerge,
  emptyCounts,
  suggestAuthority,
  summarizeRepoStats,
} from "./repo-stats.js";

const REPO = "http://forge.test/tyler/site.git";

test("the file store records once per (repo, kind, run), across url and slug spellings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-repo-stats-"));
  const stats = new FileRepoStatsStore(dir);
  assert.equal(await stats.record({ repo: REPO, kind: "sent", runId: "run-1", at: "t1" }), true);
  assert.equal(await stats.record({ repo: REPO, kind: "sent", runId: "run-1", at: "t1-again" }), false);
  // The same run reported under the slug spelling is still the same row.
  assert.equal(await stats.record({ repo: "tyler/site", kind: "sent", runId: "run-1", at: "t2" }), false);
  const rows = await stats.list(REPO);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.repo, "tyler/site");
  assert.deepEqual(await stats.list("http://forge.test/other/x.git"), []);
});

test("attach fills the merge sha on an existing row and creates nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-repo-stats-"));
  const stats = new FileRepoStatsStore(dir);
  await stats.record({ repo: REPO, kind: "merged", runId: "run-1", number: 12, at: "t1" });
  await stats.attach({ repo: REPO, kind: "merged", runId: "run-1", sha: "deadbeef", at: "t2" });
  const row = (await stats.list(REPO)).find((r) => r.kind === "merged")!;
  assert.equal(row.sha, "deadbeef");
  assert.equal(row.number, 12);
  // A missing row stays missing.
  await stats.attach({ repo: REPO, kind: "reverted", runId: "run-9", sha: "x", at: "t3" });
  assert.equal((await stats.list(REPO)).some((r) => r.kind === "reverted"), false);
});

test("summarizeRepoStats counts per repo, one run once per kind", () => {
  const counts = summarizeRepoStats([
    { repo: "a/x", kind: "sent", runId: "r1", at: "t" },
    { repo: "a/x", kind: "sent", runId: "r2", at: "t" },
    { repo: "a/x", kind: "merged", runId: "r1", at: "t" },
    { repo: "a/x", kind: "parked", runId: "r1", at: "t" },
    { repo: "a/x", kind: "reverted", runId: "r1", at: "t" },
    { repo: "b/y", kind: "sent", runId: "r3", at: "t" },
  ]);
  assert.deepEqual(counts["a/x"], { sent: 2, merged: 1, reverted: 1, parked: 1 });
  assert.deepEqual(counts["b/y"], { ...emptyCounts(), sent: 1 });
});

test("costPerMerge divides the repo's attributed spend by its merged count", () => {
  const counts = { sent: 5, merged: 4, reverted: 0, parked: 0 };
  assert.equal(costPerMerge("tyler/site", counts, [{ kind: "repo", key: "forge.test/tyler/site", amountUSD: 2 }]), 0.5);
  // Attribution keys are origin-scoped; the slug must still line up.
  assert.equal(
    costPerMerge("tyler/site", counts, [{ kind: "actor", key: "tyler/site", amountUSD: 99 }, { kind: "repo", key: "forge.test/tyler/site", amountUSD: 1 }]),
    0.25,
  );
  assert.equal(costPerMerge("tyler/site", emptyCounts(), [{ kind: "repo", key: "forge.test/tyler/site", amountUSD: 1 }]), null);
});

test("the ratchet holds until there is enough history to say anything", () => {
  const few = { sent: SUGGEST_MIN_SENT - 1, merged: SUGGEST_MIN_SENT - 1, reverted: 0, parked: 0 };
  const held = suggestAuthority(few, "propose");
  assert.equal(held.move, "hold");
  assert.match(held.why, /needed before the numbers say anything/);
});

test("the ratchet suggests promotion on a clean record, one rung at a time", () => {
  const clean = { sent: 10, merged: 9, reverted: 0, parked: 0 };
  assert.deepEqual(suggestAuthority(clean, "propose"), {
    authority: "send",
    move: "promote",
    why: "9 of 10 sent merged (90%), 0 reverted",
  });
  // Already at the top: hold.
  const top = suggestAuthority(clean, "auto_normal");
  assert.equal(top.move, "hold");
});

test("the ratchet suggests demotion when reverts exceed the rate, never below propose", () => {
  const rough = { sent: 10, merged: 5, reverted: 2, parked: 0 };
  const demoted = suggestAuthority(rough, "auto_trivial");
  assert.equal(demoted.move, "demote");
  assert.equal(demoted.authority, "send");
  const floor = suggestAuthority(rough, "propose");
  assert.equal(floor.move, "hold"); // nothing below propose to suggest
});

test("the ladder caps what the ratchet may suggest, and never-auto caps it at send", () => {
  const clean = { sent: 10, merged: 10, reverted: 0, parked: 0 };
  const capped = suggestAuthority(clean, "send", { cap: "auto_trivial" });
  assert.equal(capped.authority, "auto_trivial");
  assert.equal(capped.move, "promote");
  const atCap = suggestAuthority(clean, "auto_trivial", { cap: "auto_trivial" });
  assert.equal(atCap.move, "hold");
  const pinned = suggestAuthority(clean, "send", { neverAuto: true });
  assert.equal(pinned.move, "hold");
  assert.match(pinned.why, /at the cap/);
  // A record ABOVE its cap is demoted down to it, whatever the metrics say.
  const over = suggestAuthority(clean, "auto_normal", { cap: "send" });
  assert.equal(over.move, "demote");
  assert.equal(over.authority, "send");
});
