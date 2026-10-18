import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowEvent } from "@neutron-build/workflow";

import { parkSnapshotImages, parkSnapshotSweeper, SNAPSHOT_GC_RUNS } from "./snapshot-gc.js";

let seq = 0;
const AT = "2026-10-18T09:00:00.000Z";
function ev(type: WorkflowEvent["type"], name?: string, data?: unknown): WorkflowEvent {
  return { v: 1, seq: ++seq, type, at: AT, ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}) };
}

/** A run's log with park images on it. `ask` adds the ask park's snapshot,
 * which is NOT this sweeper's scope, as a negative shape check. */
function runLog(images: { merge?: string; delegate?: string; ask?: string; attemptDelegate?: string }, terminal: boolean): WorkflowEvent[] {
  const events: WorkflowEvent[] = [ev("run-started", undefined, { input: { task: "t", repo: "https://git.example.com/a/b" } })];
  if (images.delegate !== undefined) events.push(ev("step-completed", "turn-1-delegate-snapshot", { result: images.delegate }));
  if (images.attemptDelegate !== undefined) events.push(ev("step-completed", "attempt-2-turn-0-delegate-snapshot", { result: images.attemptDelegate }));
  if (images.merge !== undefined) events.push(ev("step-completed", "merge-snapshot", { result: images.merge }));
  if (images.ask !== undefined) events.push(ev("step-completed", "turn-3-snapshot", { result: images.ask }));
  events.push(terminal ? ev("run-completed", undefined, { output: { status: "finished" } }) : ev("step-completed", "merge-park", { attempt: 1 }));
  return events;
}

function harness(
  runs: { runId: string; status: string; events: WorkflowEvent[] }[],
  options: { warm?: string[]; fail?: (image: string, call: number) => Error | undefined; warmReadFails?: boolean; logReadFails?: string } = {},
): { sweep: () => Promise<number>; deleted: string[]; lines: string[]; deleteCalls: () => number } {
  const deleted: string[] = [];
  const lines: string[] = [];
  let calls = 0;
  const sweeper = parkSnapshotSweeper(
    {
      listMeta: async () => runs.map((r) => ({ runId: r.runId, status: r.status })),
      loadEvents: async (runId) => {
        if (options.logReadFails === runId) throw new Error("store unreachable");
        return runs.find((r) => r.runId === runId)!.events;
      },
      warmImages: async () => {
        if (options.warmReadFails === true) throw new Error("config store down");
        return options.warm ?? [];
      },
      deleteSnapshot: async (image) => {
        calls += 1;
        const failure = options.fail?.(image, calls);
        if (failure !== undefined) throw failure;
        deleted.push(image);
      },
    },
    { log: (line) => lines.push(line) },
  );
  return { sweep: () => sweeper.sweep(), deleted, lines, deleteCalls: () => calls };
}

test("a terminal run's unreferenced park images are deleted — merge and delegate, both spellings, never the ask park's", async () => {
  const merge = "0@teploy-sbx-snap:merge";
  const delegate = "0@teploy-sbx-snap:del";
  const attemptDelegate = "0@teploy-sbx-snap:attempt";
  const ask = "0@teploy-sbx-snap:ask";
  const h = harness([{ runId: "run-done", status: "completed", events: runLog({ merge, delegate, attemptDelegate, ask }, true) }]);
  assert.equal(await h.sweep(), 3);
  assert.deepEqual(h.deleted.slice().sort(), [attemptDelegate, delegate, merge].sort());
  // A second pass re-derives the same candidates from the same immutable log
  // and must not delete anything twice.
  assert.equal(await h.sweep(), 0);
  assert.equal(h.deleteCalls(), 3);
});

test("an image a live thread-warm record references is kept (D4-c2: merge-park images are thread warmth)", async () => {
  const image = "0@teploy-sbx-snap:warm";
  const h = harness([{ runId: "run-warm", status: "completed", events: runLog({ merge: image }, true) }], { warm: [image] });
  assert.equal(await h.sweep(), 0);
  assert.deepEqual(h.deleted, []);
  // Unreadable warmth keeps everything too: an over-keep costs disk for a
  // minute, the reverse would cost warmth a follow-up is about to boot from.
  const blind = harness([{ runId: "run-warm", status: "completed", events: runLog({ merge: image }, true) }], { warmReadFails: true });
  assert.equal(await blind.sweep(), 0);
  assert.ok(blind.lines.some((l) => l.includes("thread-warm records unreadable")));
});

test("a parked run's snapshot is kept: waiting meta, and a terminal meta over a non-terminal log", async () => {
  const image = "0@teploy-sbx-snap:park";
  // The real parked shape: meta `waiting`, log holding the park, no terminal event.
  const parked = harness([{ runId: "run-park", status: "waiting", events: runLog({ merge: image }, false) }]);
  assert.equal(await parked.sweep(), 0);
  assert.deepEqual(parked.deleted, [], "the park restores from this image when its decision lands");
  // Meta drifted ahead of the log (the fence's rule: the log decides) — kept.
  const lagging = harness([{ runId: "run-lag", status: "completed", events: runLog({ merge: image }, false) }]);
  assert.equal(await lagging.sweep(), 0);
  assert.deepEqual(lagging.deleted, []);
  // Live statuses never even load the log.
  const live = harness([{ runId: "run-live", status: "running", events: runLog({ merge: image }, true) }]);
  assert.equal(await live.sweep(), 0);
});

test("a deletion failure is logged and retried the next sweep, and never throws into the worker loop", async () => {
  const image = "0@teploy-sbx-snap:flaky";
  const h = harness([{ runId: "run-flaky", status: "failed", events: runLog({ merge: image }, true) }], {
    fail: (_image, call) => (call === 1 ? new Error("daemon exploded") : undefined),
  });
  const first = await h.sweep(); // resolves — the worker's interval never sees a throw
  assert.equal(first, 0);
  assert.ok(h.lines.some((l) => l.includes("[snapshot-gc]") && l.includes(image) && l.includes("daemon exploded")), "the failure is logged with the image and the reason");
  assert.equal(await h.sweep(), 1, "the next sweep retries the same image");
  assert.deepEqual(h.deleted, [image]);
  assert.equal(await h.sweep(), 0, "and the tombstone stops it there");
  assert.equal(h.deleteCalls(), 2);
});

test("an image that is already gone is treated as deleted, not retried forever", async () => {
  const image = "0@teploy-sbx-snap:gone";
  const h = harness([{ runId: "run-gone", status: "completed", events: runLog({ merge: image }, true) }], {
    fail: () => new Error("Sandbox snapshot delete failed with status 404."),
  });
  assert.equal(await h.sweep(), 0);
  assert.ok(h.lines.some((l) => l.includes("already gone")));
  assert.equal(await h.sweep(), 0);
  assert.equal(h.deleteCalls(), 1, "a 404 is terminal — one call, no retry loop");
});

test("an unreadable run log skips that run and never throws; parkSnapshotImages reads only the two park steps' string results", async () => {
  const h = harness([{ runId: "run-dark", status: "completed", events: runLog({ merge: "0@teploy-sbx-snap:x" }, true) }], { logReadFails: "run-dark" });
  assert.equal(await h.sweep(), 0);
  assert.ok(h.lines.some((l) => l.includes("run-dark") && l.includes("log unreadable")));
  // The derivation itself: a non-string result or an unrelated step is not an image.
  assert.deepEqual(parkSnapshotImages([ev("step-completed", "merge-snapshot", { result: { image: "not-a-string" } }), ev("step-completed", "turn-2-snapshot", "ask-image")]), []);
  assert.deepEqual(parkSnapshotImages(runLog({ merge: "0@teploy-sbx-snap:m" }, true)), ["0@teploy-sbx-snap:m"]);
  assert.ok(SNAPSHOT_GC_RUNS > 0);
});

test("an image still used by a container is deferred quietly: logged once, retried, deleted when free (live 2026-10-18)", async () => {
  let free = false;
  const h = harness([{ runId: "run-inuse", status: "completed", events: runLog({ merge: "0@teploy-sbx-snap:busy" }, true) }], {
    fail: () => (free ? undefined : new Error("docker rmi: Error response from daemon: conflict: unable to remove repository reference (must force) - container abc is using its referenced image")),
  });
  await h.sweep();
  await h.sweep();
  await h.sweep();
  assert.deepEqual(h.deleted, [], "not deleted while a container uses it");
  assert.equal(h.lines.filter((l) => l.includes("still in use")).length, 1, "logged once, not every pass");
  assert.equal(h.lines.filter((l) => l.includes("could not be deleted")).length, 0);
  free = true;
  await h.sweep();
  assert.deepEqual(h.deleted, ["0@teploy-sbx-snap:busy"], "deleted on a later pass once free");
});
