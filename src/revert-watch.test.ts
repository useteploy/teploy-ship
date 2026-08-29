import test from "node:test";
import assert from "node:assert/strict";

import { mergeFromPullRequestEvent, revertsFromPushEvent, recordForgeMerge, recordRevert } from "./revert-watch.js";
import type { RevertWatchDeps } from "./revert-watch.js";
import type { RevertPayload, ProjectNotifier } from "./notify.js";
import type { RepoStatEntry, RepoStatsStore } from "./repo-stats.js";

const REPO = "http://forge.test/tyler/site.git";
const SHA = "a".repeat(40);

/** In-memory stats store with the same create-once semantics as the real ones. */
function memoryStats(): RepoStatsStore & { rows: Map<string, RepoStatEntry> } {
  const rows = new Map<string, RepoStatEntry>();
  return {
    rows,
    record: async (entry) => {
      const key = `${entry.repo}:${entry.kind}:${entry.runId}`;
      if (rows.has(key)) return false;
      rows.set(key, entry);
      return true;
    },
    attach: async (entry) => {
      const key = `${entry.repo}:${entry.kind}:${entry.runId}`;
      const existing = rows.get(key);
      if (existing === undefined) return;
      rows.set(key, { ...existing, ...entry });
    },
    list: async (repo) =>
      [...rows.values()].filter((r) => repo === undefined || r.repo === repo || r.repo === repo.replace(/\/+$/, "")),
  };
}

function deps(stats: RepoStatsStore): { d: RevertWatchDeps; reverts: RevertPayload[] } {
  const reverts: RevertPayload[] = [];
  const notifier: ProjectNotifier = {
    enabled: true,
    project: async () => true,
    revert: async (event) => {
      reverts.push(event);
      return true;
    },
  };
  return {
    reverts,
    d: {
      stats,
      notify: notifier,
      log: () => {},
      now: () => "2026-08-28T12:00:00Z",
    },
  };
}

function mergedPrEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "closed",
    pull_request: {
      number: 12,
      merged: true,
      title: "Fix the send path",
      body: "done",
      html_url: "http://forge.test/tyler/site/pulls/12",
      merge_commit_sha: SHA,
    },
    repository: { clone_url: REPO, full_name: "tyler/site" },
    ...overrides,
  };
}

test("a merged pull request is a merge; anything else is not", () => {
  const merge = mergeFromPullRequestEvent(mergedPrEvent())!;
  assert.equal(merge.number, 12);
  assert.equal(merge.sha, SHA);
  assert.equal(merge.revert, undefined);
  assert.equal(mergeFromPullRequestEvent(mergedPrEvent({ action: "opened" })), null);
  assert.equal(
    mergeFromPullRequestEvent(mergedPrEvent({ pull_request: { number: 12, merged: false, title: "x" } })),
    null,
  );
});

test("a merged revert pull request carries the sha it undid", () => {
  const event = mergedPrEvent({
    pull_request: {
      number: 13,
      merged: true,
      title: `Revert "Fix the send path"`,
      body: `This reverts commit ${SHA}.`,
      html_url: "http://forge.test/tyler/site/pulls/13",
      merge_commit_sha: "b".repeat(40),
    },
  });
  const merge = mergeFromPullRequestEvent(event)!;
  assert.notEqual(merge.revert, undefined);
  assert.equal(merge.revert!.sha, SHA);
  assert.equal(merge.revert!.revertPr, "http://forge.test/tyler/site/pulls/13");
});

test("push commits that name their undo are revert signals; plain commits are not", () => {
  const payload = {
    repository: { clone_url: REPO },
    commits: [
      { message: `Revert "Fix the send path"\n\nThis reverts commit ${SHA}.` },
      { message: "an ordinary commit" },
      { message: "Revert something with no sha named" },
    ],
  };
  const signals = revertsFromPushEvent(payload);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.sha, SHA);
});

test("recordForgeMerge counts a Ship PR once and enriches the worker's sha-less row", async () => {
  const stats = memoryStats();
  await stats.record({ repo: REPO, kind: "sent", runId: "run-1", pr: "http://forge.test/tyler/site/pulls/12", at: "t1" });
  await stats.record({ repo: REPO, kind: "merged", runId: "run-1", pr: "http://forge.test/tyler/site/pulls/12", at: "t2" });
  const { d } = deps(stats);
  const merge = mergeFromPullRequestEvent(mergedPrEvent())!;
  assert.equal(await recordForgeMerge(d, merge), false); // already counted by the worker's key
  // ...but the sha was attached, which is what the revert join reads.
  const row = (await stats.list(REPO)).find((r) => r.kind === "merged")!;
  assert.equal(row.sha, SHA);
});

test("recordForgeMerge counts a human merge of a Ship PR", async () => {
  const stats = memoryStats();
  await stats.record({ repo: REPO, kind: "sent", runId: "run-1", number: 12, at: "t1" });
  const { d } = deps(stats);
  const merge = mergeFromPullRequestEvent(mergedPrEvent())!;
  assert.equal(await recordForgeMerge(d, merge), true);
  const rows = await stats.list(REPO);
  assert.equal(rows.filter((r) => r.kind === "merged").length, 1);
});

test("recordForgeMerge ignores a merge of a PR Ship never sent", async () => {
  const stats = memoryStats();
  const { d } = deps(stats);
  assert.equal(await recordForgeMerge(d, mergeFromPullRequestEvent(mergedPrEvent())!), false);
});

test("a revert that matches a merged sha is recorded and emitted exactly once", async () => {
  const stats = memoryStats();
  await stats.record({ repo: REPO, kind: "sent", runId: "run-1", at: "t1" });
  await stats.record({ repo: REPO, kind: "merged", runId: "run-1", number: 12, pr: "http://forge.test/tyler/site/pulls/12", sha: SHA, at: "t2" });
  const { d, reverts } = deps(stats);
  const first = await recordRevert(d, { repo: REPO, sha: SHA, revertPr: "http://forge.test/tyler/site/pulls/13" });
  assert.equal(first, true);
  assert.deepEqual(reverts, [
    {
      kind: "revert",
      repo: REPO,
      pr: "http://forge.test/tyler/site/pulls/12",
      revert_pr: "http://forge.test/tyler/site/pulls/13",
    },
  ]);
  // The same signal again — re-delivery, or the push and the PR both telling
  // one story — notifies nobody a second time.
  assert.equal(await recordRevert(d, { repo: REPO, sha: SHA }), false);
  assert.equal(reverts.length, 1);
});

test("a revert of something Ship never recorded is dropped, not guessed", async () => {
  const stats = memoryStats();
  const { d, reverts } = deps(stats);
  assert.equal(await recordRevert(d, { repo: REPO, sha: SHA }), false);
  assert.equal(reverts.length, 0);
});
