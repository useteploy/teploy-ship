import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkflowEvent } from "@neutron-build/workflow";

import { attentionOf, buildFeed, pendingAction, stateOf, toItem } from "./inbox.js";
import type { RunMeta } from "./run-store.js";

const T0 = "2026-07-28T12:00:00.000Z";

function meta(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    runId: "run-aaaa1111",
    task: "fix the failing auth test",
    status: "waiting",
    model: "anthropic/claude-opus-5",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function thinkEvent(turn: number, text: string, seq = 1): WorkflowEvent {
  return { v: 1, seq, type: "step-completed", at: T0, name: `turn-${turn}-think`, data: { result: { text } } };
}

test("ship statuses map onto the contract's six states", () => {
  assert.equal(stateOf("completed"), "succeeded");
  assert.equal(stateOf("waiting"), "blocked");
  assert.equal(stateOf("failed"), "failed");
  assert.equal(stateOf("running"), "running");
  // Ship spells it "cancelled"; the contract "canceled". Both must land.
  assert.equal(stateOf("cancelled"), "canceled");
  assert.equal(stateOf("canceled"), "canceled");
});

test("an unrecognized upstream status degrades to pending rather than throwing", () => {
  assert.equal(stateOf("some-future-status"), "pending");
});

test("attention marks blocked as a decision and failed as a failure", () => {
  assert.equal(attentionOf("blocked"), "decision");
  assert.equal(attentionOf("failed"), "failure");
  assert.equal(attentionOf("running"), "info");
  assert.equal(attentionOf("succeeded"), "info");
});

test("pendingAction pulls the fenced action from the turn the run parked on", () => {
  const events = [thinkEvent(2, "I will clean up.\n```bash\nrm -rf node_modules\npnpm install\n```", 1)];
  assert.equal(pendingAction(events, "turn-2-approval"), "bash: rm -rf node_modules");
});

test("pendingAction reads the turn named by the event, not merely the last one", () => {
  const events = [
    thinkEvent(1, "```bash\nls\n```", 1),
    thinkEvent(2, "```bash\nrm -rf /\n```", 2),
  ];
  assert.equal(pendingAction(events, "turn-1-approval"), "bash: ls");
});

test("pendingAction returns undefined for a plan park and for an unreadable log", () => {
  assert.equal(pendingAction([], "plan-approval"), undefined);
  assert.equal(pendingAction([thinkEvent(1, "no fence here")], "turn-1-approval"), undefined);
});

test("a plan park asks about the approach, not about a command", () => {
  const item = toItem(meta({ eventName: "plan-approval" }));
  // Flattening both park kinds into one message is how a destructive
  // action gets rubber-stamped as if it were a plan review.
  assert.equal(item.needs?.prompt, "Review the agent's plan before it acts.");
});

test("a turn park names the action under review", () => {
  const item = toItem(meta({ eventName: "turn-2-approval" }), { action: "bash: rm -rf node_modules" });
  assert.equal(item.needs?.prompt, "Approve this action? bash: rm -rf node_modules");
});

test("blocked items carry approve/deny as argv with a reason placeholder", () => {
  const item = toItem(meta({ eventName: "turn-1-approval" }));
  assert.deepEqual(item.needs?.actions, [
    { label: "approve", run: ["teploy-ship", "approve", "run-aaaa1111"] },
    { label: "deny", run: ["teploy-ship", "deny", "run-aaaa1111", "{reason}"] },
  ]);
  // argv, never a shell string — this is the injection boundary.
  for (const action of item.needs?.actions ?? []) assert.ok(Array.isArray(action.run));
});

test("non-blocked items offer no actions", () => {
  assert.equal(toItem(meta({ status: "completed" })).needs, undefined);
});

test("a multi-line task collapses to a one-line title", () => {
  const item = toItem(meta({ task: "fix the test\n\nand also tidy up" }));
  assert.equal(item.title, "fix the test and also tidy up");
});

test("context carries display metadata and omits absent fields", () => {
  const item = toItem(meta({ ranOn: "worker-02", source: "github" }));
  assert.deepEqual(item.context, {
    model: "anthropic/claude-opus-5",
    ran_on: "worker-02",
    source: "github",
  });
  assert.equal("workspace" in (item.context ?? {}), false);
});

test("link is emitted only when a public URL is configured, with no double slash", () => {
  assert.equal(toItem(meta()).link, undefined);
  assert.equal(toItem(meta(), { webBase: "http://box:7460/" }).link, "http://box:7460/runs/run-aaaa1111");
});

test("feed sorts decisions first, then failures, oldest within each band", async () => {
  const feed = await buildFeed([
    meta({ runId: "run-info", status: "running", createdAt: "2026-07-28T09:00:00.000Z" }),
    meta({ runId: "run-fail", status: "failed", updatedAt: "2026-07-28T11:00:00.000Z" }),
    meta({ runId: "run-new", status: "waiting", updatedAt: "2026-07-28T11:30:00.000Z" }),
    meta({ runId: "run-old", status: "waiting", updatedAt: "2026-07-28T10:00:00.000Z" }),
  ], { now: Date.parse(T0) });

  assert.deepEqual(
    feed.items.map((i) => i.id),
    // Open items first (both decisions, oldest park leading), then the
    // terminal failure. The longest-blocked run is the costliest one.
    ["run-old", "run-new", "run-info", "run-fail"],
  );
});

test("terminal runs older than a day drop out; open runs never do", async () => {
  const stale = "2026-07-26T12:00:00.000Z";
  const feed = await buildFeed([
    meta({ runId: "run-done", status: "completed", updatedAt: stale }),
    meta({ runId: "run-parked", status: "waiting", updatedAt: stale }),
  ], { now: Date.parse(T0) });

  assert.deepEqual(feed.items.map((i) => i.id), ["run-parked"]);
});

test("a run parked with an unreadable log still appears, minus the detail", async () => {
  const feed = await buildFeed([meta({ eventName: "turn-1-approval" })], {
    now: Date.parse(T0),
    loadEvents: () => Promise.reject(new Error("log gone")),
  });

  assert.equal(feed.items.length, 1);
  assert.equal(feed.items[0]?.needs?.prompt, "This run is parked waiting for approval.");
});

test("only parked runs pay for an event-log read", async () => {
  const read: string[] = [];
  await buildFeed([meta({ runId: "run-done", status: "completed" }), meta({ runId: "run-parked", eventName: "turn-1-approval" })], {
    now: Date.parse(T0),
    loadEvents: (runId) => {
      read.push(runId);
      return Promise.resolve([thinkEvent(1, "```bash\nls\n```")]);
    },
  });

  assert.deepEqual(read, ["run-parked"]);
});

test("the envelope declares the contract version", async () => {
  const feed = await buildFeed([meta()], { now: Date.parse(T0) });
  assert.equal(feed.schema, "teploy.inbox/v1");
  assert.equal(feed.items[0]?.schema, "teploy.inbox/v1");
  assert.equal(feed.items[0]?.source, "teploy-ship");
});
