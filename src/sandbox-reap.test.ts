import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkflowEvent } from "@neutron-build/workflow";

import {
  REAP_RUNS,
  resolveSandboxReapGraceMs,
  resolveSandboxReapMode,
  sandboxReaper,
  workspaceHandles,
  type ListedSandbox,
} from "./sandbox-reap.js";

let seq = 0;
const AT = "2026-10-18T09:00:00.000Z";
function ev(type: WorkflowEvent["type"], name?: string, data?: unknown): WorkflowEvent {
  return { v: 1, seq: ++seq, type, at: AT, ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}) };
}

/** A log naming the given handles the way a real run's does. */
function runLog(handles: { primary?: string; attempt?: string; restore?: string; mergeRestore?: string }, terminal: boolean): WorkflowEvent[] {
  const events: WorkflowEvent[] = [ev("run-started", undefined, { input: { task: "t" } })];
  if (handles.primary !== undefined) events.push(ev("step-completed", "sandbox", { result: handles.primary }));
  if (handles.attempt !== undefined) events.push(ev("step-completed", "attempt-1-sandbox", { result: handles.attempt }));
  if (handles.restore !== undefined) events.push(ev("step-completed", "turn-2-restore", { result: { handle: handles.restore } }));
  if (handles.mergeRestore !== undefined) events.push(ev("step-completed", "merge-restore", { result: { handle: handles.mergeRestore } }));
  events.push(terminal ? ev("run-cancelled", undefined, { reason: "done" }) : ev("step-completed", "merge-park", { attempt: 1 }));
  return events;
}

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-19T00:00:00.000Z");

function harness(
  runs: { runId: string; status: string; events: WorkflowEvent[] }[],
  sandboxes: ListedSandbox[],
  options: { mode?: "log" | "on" | "off"; graceMs?: number; listFails?: boolean; metaFails?: boolean; logFailsFor?: string; destroyFails?: (handle: string) => Error | undefined } = {},
): { sweep: () => Promise<number>; destroyed: string[]; lines: string[] } {
  const destroyed: string[] = [];
  const lines: string[] = [];
  const reaper = sandboxReaper(
    {
      list: async () => {
        if (options.listFails === true) throw new Error("daemon unreachable");
        return sandboxes;
      },
      listMeta: async () => {
        if (options.metaFails === true) throw new Error("store unreachable");
        return runs.map((r) => ({ runId: r.runId, status: r.status }));
      },
      loadEvents: async (runId) => {
        if (options.logFailsFor === runId) throw new Error("store unreachable");
        return runs.find((r) => r.runId === runId)!.events;
      },
      destroy: async (handle) => {
        const failure = options.destroyFails?.(handle);
        if (failure !== undefined) throw failure;
        destroyed.push(handle);
      },
    },
    { mode: options.mode ?? "on", graceMs: options.graceMs ?? HOUR, now: () => NOW, log: (line) => lines.push(line) },
  );
  return { sweep: () => reaper.sweep(), destroyed, lines };
}

test("workspaceHandles: the sandbox step's two shapes, attempts, and every park restore", () => {
  const done = (name: string, result: unknown) => ev("step-completed", name, { result });
  assert.deepEqual(workspaceHandles([done("sandbox", "0@aa"), done("turn-1-exec", { result: "no" })]), ["0@aa"]);
  assert.deepEqual(workspaceHandles([done("sandbox", { handle: "0@bb", boot: "thread-warm" })]), ["0@bb"]);
  assert.deepEqual(workspaceHandles([done("attempt-1-sandbox", "0@cc"), done("attempt-2-sandbox", "0@dd")]), ["0@cc", "0@dd"]);
  assert.deepEqual(
    workspaceHandles([done("sandbox", "0@aa"), done("turn-3-restore", { handle: "0@ee" }), done("merge-restore", { handle: "0@ff" }), done("attempt-1-turn-0-delegate-restore", { handle: "0@gg" })]),
    ["0@aa", "0@ee", "0@ff", "0@gg"],
  );
  assert.deepEqual(workspaceHandles([done("merge-snapshot", "0@teploy-sbx-snap:x"), done("turn-2-snapshot", "img")]), [], "images are the snapshot sweeper's, never handles");
});

test("an unowned sandbox past grace is destroyed; owned, leased and young ones are kept", async () => {
  const parked = "0@01PARKED";
  const leaked = "0@01LEAKED";
  const leased = "0@01LEASED";
  const young = "0@01YOUNG";
  const h = harness(
    [
      // The live shape from compute-1: a run parked at approve-merge, its
      // container deliberately alive across the park.
      { runId: "run-park", status: "waiting", events: runLog({ primary: parked }, false) },
      // A terminal run owns nothing — its container is the leak.
      { runId: "run-done", status: "cancelled", events: runLog({ primary: leaked }, true) },
    ],
    [
      { handle: parked, createdAt: "2026-10-18T04:00:00.000Z" },
      { handle: leaked, createdAt: "2026-10-18T04:00:00.000Z" },
      { handle: leased, createdAt: "2026-10-18T04:00:00.000Z", leaseHeld: true },
      { handle: young, createdAt: "2026-10-18T23:30:00.000Z" },
    ],
  );
  assert.equal(await h.sweep(), 1);
  assert.deepEqual(h.destroyed, [leaked]);
});

test("log mode names candidates and destroys nothing; off silences the sweep entirely", async () => {
  const leaked = "0@01LEAKED";
  const runs = [{ runId: "run-done", status: "failed", events: runLog({ primary: leaked }, true) }];
  const sandboxes = [{ handle: leaked, createdAt: "2026-10-18T04:00:00.000Z" }];
  const watching = harness(runs, sandboxes, { mode: "log" });
  assert.equal(await watching.sweep(), 0);
  assert.deepEqual(watching.destroyed, []);
  assert.ok(
    watching.lines.some((l) => l.includes("[sandbox-reap]") && l.includes(leaked) && l.includes("would destroy")),
    "the default mode says what it would have done",
  );
  const off = harness(runs, sandboxes, { mode: "off" });
  assert.equal(await off.sweep(), 0);
  assert.deepEqual(off.lines, []);
});

test("fail closed: an unreadable list, meta read, or non-terminal run log keeps everything", async () => {
  const leaked = "0@01LEAKED";
  const runs = [{ runId: "run-live", status: "running", events: runLog({ primary: leaked }, false) }];
  const sandboxes = [{ handle: leaked, createdAt: "2026-10-18T04:00:00.000Z" }];
  for (const options of [{ listFails: true }, { metaFails: true }, { logFailsFor: "run-live" }] as const) {
    const h = harness(runs, sandboxes, options);
    assert.equal(await h.sweep(), 0, `${JSON.stringify(options)} keeps every sandbox`);
    assert.deepEqual(h.destroyed, []);
  }
  assert.ok(harness(runs, sandboxes, { logFailsFor: "run-live" }).lines.length === 0);
});

test("a destroy failure is retried next sweep; a not-there sandbox is done, not an error", async () => {
  const leaked = "0@01LEAKED";
  const runs = [{ runId: "run-done", status: "failed", events: runLog({ primary: leaked }, true) }];
  const sandboxes = [{ handle: leaked, createdAt: "2026-10-18T04:00:00.000Z" }];
  let broken = true;
  const h = harness(runs, sandboxes, { destroyFails: () => (broken ? new Error("daemon exploded") : undefined) });
  assert.equal(await h.sweep(), 0);
  assert.ok(h.lines.some((l) => l.includes("could not be destroyed")));
  broken = false;
  assert.equal(await h.sweep(), 1);

  const gone = harness(runs, sandboxes, { destroyFails: () => new Error("Sandbox destroy failed with status 404.") });
  assert.equal(await gone.sweep(), 0, "a 404 is terminal, not a failure to narrate");
  assert.deepEqual(
    gone.lines.filter((l) => l.includes("could not be destroyed")),
    [],
  );
});

test("mode and grace resolve from the environment: SHIP_SANDBOX_REAP grammar, SHIP_SANDBOX_TTL_SEC grace", () => {
  assert.equal(resolveSandboxReapMode(undefined), "log");
  assert.equal(resolveSandboxReapMode(""), "log");
  assert.equal(resolveSandboxReapMode("LOG"), "log");
  assert.equal(resolveSandboxReapMode("off"), "off");
  assert.equal(resolveSandboxReapMode("on"), "on");
  assert.equal(resolveSandboxReapMode("yes"), "log", "an unknown value is the watch-only default, never destructive");

  assert.equal(resolveSandboxReapGraceMs({}), 7_200_000);
  assert.equal(resolveSandboxReapGraceMs({ SHIP_SANDBOX_TTL_SEC: "86400" }), 86_400_000);
  assert.equal(resolveSandboxReapGraceMs({ SHIP_SANDBOX_TTL_SEC: "60" }), 600_000, "the same 600 s floor cli.ts applies");
  assert.ok(REAP_RUNS > 0);
});

test("a sandbox with no readable createdAt is kept — age is the sweeper's evidence, not an assumption", async () => {
  const h = harness([{ runId: "run-done", status: "failed", events: runLog({ primary: "0@01X" }, true) }], [{ handle: "0@01X" }]);
  assert.equal(await h.sweep(), 0);
  assert.deepEqual(h.destroyed, []);
});
