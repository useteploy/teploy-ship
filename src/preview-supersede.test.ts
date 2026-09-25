import assert from "node:assert/strict";
import { test } from "node:test";

import type { CommandRunner } from "./deploy.js";
import {
  parseSupersededMark,
  previewSupersededKey,
  supersedePreviews,
  type PreviewLineage,
  type SupersededMark,
} from "./preview-supersede.js";

const REPO = "http://forge.example/owner/app.git";
const rev = (c: string) => c.repeat(40);

type Ev = { type: string; name?: string; at?: string; data?: unknown };

/** One run's log: when it started, what it asked, what its preview recorded. */
function runLog(o: {
  at: string;
  input: Record<string, unknown>;
  slot?: string;
  revision?: string;
  prNumber?: number;
  cancelled?: boolean;
}): Ev[] {
  const events: Ev[] = [{ type: "run-started", at: o.at, data: { input: { task: "t", repo: REPO, ...o.input } } }];
  if (o.prNumber !== undefined) events.push({ type: "step-completed", name: "repo-pr", data: { result: { url: "u", number: o.prNumber } } });
  if (o.slot !== undefined) {
    events.push({
      type: "step-completed",
      name: "preview-deploy",
      data: { result: { kind: "deployed", url: `http://preview-${o.slot}.100.101.102.103.sslip.io`, image: "img", branch: o.slot, ...(o.revision ? { revision: o.revision } : {}) } },
    });
  }
  if (o.cancelled === true) events.push({ type: "run-cancelled", data: { reason: "Changes requested in follow-up" } });
  return events;
}

function world(logs: Record<string, Ev[]>, recent?: string[]) {
  const marks = new Map<string, SupersededMark>();
  const calls: string[][] = [];
  const run: CommandRunner = async (argv) => {
    calls.push(argv);
    return { code: 0, stdout: "", stderr: "" };
  };
  const lineage: PreviewLineage = {
    loadEvents: async (runId) => logs[runId] ?? [],
    ...(recent !== undefined ? { recentRunIds: async () => recent } : {}),
    marked: async (runId) => marks.get(runId),
    mark: async (runId, mark) => void marks.set(runId, mark),
  };
  const destroyed = () => calls.filter((c) => c[1] === "preview" && c[2] === "destroy").map((c) => c[3]);
  return { marks, calls, run, lineage, destroyed };
}

/** Run `runId`'s supersede step against the world, as the durable step does. */
async function supersedeAs(w: ReturnType<typeof world>, logs: Record<string, Ev[]>, runId: string) {
  const events = logs[runId]!;
  const input = (events[0]!.data as { input: { repo?: string; pr?: number; parentRunId?: string } }).input;
  const deployed = events.find((e) => e.name === "preview-deploy")!;
  const preview = (deployed.data as { result: { url: string; branch?: string; revision?: string } }).result;
  return await supersedePreviews({
    runId,
    at: events[0]!.at!,
    input,
    preview,
    target: { dir: "/srv/preview", run: w.run },
    lineage: w.lineage,
    now: () => new Date("2026-09-24T20:00:00Z"),
  });
}

test("a newer revision's preview supersedes the older revision's, and leaves the reverse link", async () => {
  const logs = {
    "run-1": runLog({ at: "2026-09-24T19:00:00Z", input: {}, prNumber: 1, slot: "ship-aaa", revision: rev("a") }),
    "run-2": runLog({ at: "2026-09-24T19:30:00Z", input: { pr: 1, parentRunId: "run-1" }, slot: "ship-bbb", revision: rev("b") }),
  };
  const w = world(logs);
  const out = await supersedeAs(w, logs, "run-2");
  assert.equal(out.kind, "done");
  assert.deepEqual(w.destroyed(), ["ship-aaa"], "exactly the older revision's slot is destroyed");
  assert.deepEqual(out.kind === "done" ? out.superseded : [], [{ runId: "run-1", slot: "ship-aaa", revision: rev("a"), result: "destroyed" }]);
  assert.deepEqual(w.marks.get("run-1"), {
    byRunId: "run-2",
    revision: rev("b"),
    url: "http://preview-ship-bbb.100.101.102.103.sslip.io",
    at: "2026-09-24T20:00:00.000Z",
  });
});

test("recovering an older run never touches a newer revision's preview", async () => {
  // run-2 is replayed/recovered after run-3 (a newer revision on the same PR)
  // already deployed. run-3 is visible to run-2 both through the recent-runs
  // scan and as a same-PR run, and must still never be a candidate.
  const logs = {
    "run-1": runLog({ at: "2026-09-24T19:00:00Z", input: {}, prNumber: 1, slot: "ship-aaa", revision: rev("a") }),
    "run-2": runLog({ at: "2026-09-24T19:30:00Z", input: { pr: 1, parentRunId: "run-1" }, slot: "ship-bbb", revision: rev("b") }),
    "run-3": runLog({ at: "2026-09-24T19:45:00Z", input: { pr: 1, parentRunId: "run-2" }, slot: "ship-ccc", revision: rev("c") }),
  };
  const w = world(logs, ["run-3", "run-2", "run-1"]);
  await supersedeAs(w, logs, "run-2");
  assert.ok(!w.destroyed().includes("ship-ccc"), `the newer revision's preview was destroyed: ${JSON.stringify(w.destroyed())}`);
  assert.deepEqual(w.destroyed(), ["ship-aaa"]);
  assert.equal(w.marks.get("run-3"), undefined, "the newer run is never marked superseded by an older one");
});

test("a cancelled older run's preview is cleaned up, and a same-PR intake follow-up with no parent link finds it", async () => {
  // run-1 opened PR #7 and was cancelled by a follow-up; run-9 is a review
  // follow-up from intake (no parentRunId). Another PR's run and another
  // repo's run on the same PR number are never touched.
  const logs = {
    "run-1": runLog({ at: "2026-09-24T19:00:00Z", input: {}, prNumber: 7, slot: "ship-aaa", revision: rev("a"), cancelled: true }),
    "run-other-pr": runLog({ at: "2026-09-24T19:05:00Z", input: { pr: 8 }, slot: "ship-ddd", revision: rev("d") }),
    "run-other-repo": runLog({ at: "2026-09-24T19:06:00Z", input: { pr: 7, repo: "http://forge.example/owner/else.git" }, slot: "ship-eee", revision: rev("e") }),
    "run-9": runLog({ at: "2026-09-24T19:30:00Z", input: { pr: 7 }, slot: "ship-bbb", revision: rev("b") }),
  };
  const w = world(logs, ["run-9", "run-other-repo", "run-other-pr", "run-1"]);
  const out = await supersedeAs(w, logs, "run-9");
  assert.deepEqual(w.destroyed(), ["ship-aaa"]);
  assert.equal(out.kind === "done" ? out.superseded.length : -1, 1);
  assert.equal(w.marks.get("run-1")?.byRunId, "run-9");
});

test("the destroy is idempotent: a replayed step and a later revision do not destroy or re-mark again", async () => {
  const logs = {
    "run-1": runLog({ at: "2026-09-24T19:00:00Z", input: {}, prNumber: 1, slot: "ship-aaa", revision: rev("a") }),
    "run-2": runLog({ at: "2026-09-24T19:30:00Z", input: { pr: 1, parentRunId: "run-1" }, slot: "ship-bbb", revision: rev("b") }),
    "run-3": runLog({ at: "2026-09-24T19:45:00Z", input: { pr: 1, parentRunId: "run-2" }, slot: "ship-ccc", revision: rev("c") }),
  };
  const w = world(logs);
  await supersedeAs(w, logs, "run-2");
  // The same step executing again (a crash before it was recorded).
  const again = await supersedeAs(w, logs, "run-2");
  assert.deepEqual(again.kind === "done" ? again.superseded.map((s) => s.result) : [], ["already-superseded"]);
  assert.deepEqual(w.destroyed(), ["ship-aaa"], "a marked preview is not destroyed twice");
  // The next revision removes run-2's preview and leaves run-1's first mark alone.
  await supersedeAs(w, logs, "run-3");
  assert.deepEqual(w.destroyed(), ["ship-aaa", "ship-bbb"]);
  assert.equal(w.marks.get("run-1")?.byRunId, "run-2", "the first superseder's mark wins");
  assert.equal(w.marks.get("run-2")?.byRunId, "run-3");
});

test("a failed destroy is recorded, not marked, and never throws; the same slot and old receipts are left alone", async () => {
  const logs = {
    "run-0": runLog({ at: "2026-09-24T18:00:00Z", input: {}, prNumber: 1 }),
    "run-1": runLog({ at: "2026-09-24T19:00:00Z", input: { pr: 1, parentRunId: "run-0" }, slot: "ship-bbb", revision: rev("b") }),
    "run-2": runLog({ at: "2026-09-24T19:30:00Z", input: { pr: 1, parentRunId: "run-1" }, slot: "ship-bbb", revision: rev("b") }),
  };
  // run-0 has no preview slot recorded at all; run-1 is the same slot as run-2.
  const w = world(logs);
  const out = await supersedeAs(w, logs, "run-2");
  assert.deepEqual(out, { kind: "done", superseded: [] });
  assert.deepEqual(w.destroyed(), []);

  const logs2 = {
    "run-1": runLog({ at: "2026-09-24T19:00:00Z", input: {}, prNumber: 1, slot: "ship-aaa", revision: rev("a") }),
    "run-2": runLog({ at: "2026-09-24T19:30:00Z", input: { pr: 1, parentRunId: "run-1" }, slot: "ship-bbb", revision: rev("b") }),
  };
  const w2 = world(logs2);
  const failing: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "ssh: connect refused" });
  const out2 = await supersedePreviews({
    runId: "run-2",
    input: { repo: REPO, pr: 1, parentRunId: "run-1" },
    preview: { url: "u", branch: "ship-bbb", revision: rev("b") },
    target: { dir: "/srv/preview", run: failing },
    lineage: w2.lineage,
  });
  assert.equal(out2.kind === "done" ? out2.superseded[0]?.result : undefined, "failed");
  assert.match(out2.kind === "done" ? out2.superseded[0]?.detail ?? "" : "", /connect refused/);
  assert.equal(w2.marks.get("run-1"), undefined, "an undestroyed preview is not marked superseded");
});

test("not a pull-request run, or a preview with no slot: skipped with the reason", async () => {
  const w = world({});
  const target = { dir: "/srv/preview", run: w.run };
  assert.equal((await supersedePreviews({ runId: "r", input: { repo: REPO }, preview: { url: "u", branch: "b" }, target, lineage: w.lineage })).kind, "skipped");
  assert.equal((await supersedePreviews({ runId: "r", input: { repo: REPO, pr: 1 }, preview: { url: "u" }, target, lineage: w.lineage })).kind, "skipped");
  const broken: PreviewLineage = { ...w.lineage, loadEvents: async () => { throw new Error("store down"); } };
  const out = await supersedePreviews({ runId: "r", input: { repo: REPO, pr: 1, parentRunId: "p" }, preview: { url: "u", branch: "b" }, target, lineage: broken });
  assert.deepEqual(out, { kind: "skipped", reason: "could not read earlier runs: store down" });
});

test("the mark round-trips through its runtime-config key, and junk reads as unmarked", () => {
  assert.equal(previewSupersededKey("run-1"), "SHIP_PREVIEW_SUPERSEDED_run-1");
  const mark = { byRunId: "run-2", revision: rev("b"), url: "http://x", at: "2026-09-24T20:00:00Z" };
  assert.deepEqual(parseSupersededMark(JSON.stringify(mark)), mark);
  assert.equal(parseSupersededMark(undefined), undefined);
  assert.equal(parseSupersededMark("{not json"), undefined);
  assert.equal(parseSupersededMark(JSON.stringify({ revision: "x" })), undefined);
});
