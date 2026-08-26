import assert from "node:assert/strict";
import { test } from "node:test";

import { sweepIntake, makeTerminalClaim, launchDueBounded, retrying } from "./worker.js";
import type { IntakeSweepDeps } from "./worker.js";
import type { IntakeTask } from "./intake.js";
import type { RunUsage } from "./durable.js";
import type { SpendStore } from "./spend.js";
import { usageFromEvents } from "./worker.js";
import { LocalAdmission } from "./admission.js";
import type { AdmissionControl } from "./admission.js";

const DAY = "2026-07-06";
const now = (): Date => new Date(`${DAY}T12:00:00Z`);

function mkTask(taskId: string): IntakeTask {
  const at = "2026-07-06T00:00:00Z";
  return {
    taskId,
    source: "forgejo",
    kind: "issue",
    title: `fix ${taskId}`,
    dedupeKey: `forgejo:${taskId}`,
    state: "proposed",
    createdAt: at,
    updatedAt: at,
  };
}

function memIntake(tasks: IntakeTask[]): Pick<import("./intake.js").IntakeStore, "list" | "setState" | "claim"> {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  return {
    async list(state) {
      return [...byId.values()].filter((t) => state === undefined || t.state === state);
    },
    async setState(taskId, state, runId) {
      const t = byId.get(taskId);
      if (t === undefined) return;
      t.state = state;
      if (runId !== undefined) t.runId = runId;
    },
    async claim(taskId) {
      const t = byId.get(taskId);
      if (t === undefined || t.state !== "proposed") return false;
      t.state = "launched";
      return true;
    },
  };
}

function memSpend(): SpendStore {
  const m = new Map<string, number>();
  const holds = new Map<string, { source: string; day: string; amountUSD: number }>();
  const key = (source: string, day: string): string => `${day} ${source}`;
  return {
    async add(source, day, amountUSD) {
      if (!(amountUSD > 0)) return;
      m.set(key(source, day), (m.get(key(source, day)) ?? 0) + amountUSD);
    },
    async reserve(id, source, day, amountUSD) {
      if (!(amountUSD > 0)) return;
      holds.set(id, { source, day, amountUSD });
    },
    async release(id) {
      holds.delete(id);
    },
    // Like the real stores, a budget read includes money already committed to
    // runs that have not settled yet.
    async get(source, day) {
      let held = 0;
      for (const h of holds.values()) if (h.source === source && h.day === day) held += h.amountUSD;
      return (m.get(key(source, day)) ?? 0) + held;
    },
    async list() {
      return [...m.entries()].map(([k, amountUSD]) => {
        const [day, source] = k.split(" ");
        return { day: day!, source: source!, amountUSD };
      });
    },
  };
}

interface Harness {
  deps: IntakeSweepDeps;
  launched: string[];
  terminal: Map<string, { terminal: boolean; usage?: RunUsage }>;
  spend: SpendStore;
  intake: Pick<import("./intake.js").IntakeStore, "list" | "setState" | "claim">;
  admission: AdmissionControl;
}

// Run ids must be unique across harnesses: two simulated workers sharing a
// fleet are two DIFFERENT processes, and colliding ids would let them
// accidentally share a concurrency slot and a budget reservation.
let harnessSeq = 0;

function harness(overrides: Partial<IntakeSweepDeps>, tasks: IntakeTask[]): Harness {
  const worker = `w${++harnessSeq}`;
  const intake = memIntake(tasks);
  const spend = memSpend();
  const admission = overrides.admission ?? new LocalAdmission();
  const launched: string[] = [];
  const terminal = new Map<string, { terminal: boolean; usage?: RunUsage }>();
  let seq = 0;
  const deps: IntakeSweepDeps = {
    intake,
    spend,
    admission,
    policies: { forgejo: "auto" },
    dailyAutoLimit: 100,
    maxConcurrentRuns: 100,
    budgetFor: () => 0,
    estimatedRunCostUSD: 0.5,
    inFlight: new Map(),
    outcomeOf: async (runId) => terminal.get(runId) ?? { terminal: false },
    newRunId: () => `run-${worker}-${++seq}`,
    launch: async (_task, runId) => {
      launched.push(runId);
    },
    now,
    log: () => {},
    ...overrides,
  };
  return { deps, launched, terminal, spend, intake, admission };
}

test("launchDueBounded: a host without room holds launches below the ceiling, and resumes when it clears", async () => {
  const due = [
    { runId: "h1", sleeping: false },
    { runId: "h2", sleeping: false },
  ];
  const inflight = new Set<string>();
  const launching = new Set<string>();
  const launched: string[] = [];
  let room = false;
  const pass = () =>
    launchDueBounded({
      due: async () => due.filter((d) => !launched.includes(d.runId)),
      inflight,
      launching,
      maxConcurrent: 4,
      hostOk: () => room,
      launch: (runId) => {
        launched.push(runId);
        launching.add(runId);
      },
    });
  assert.equal(await pass(), 0, "held: nothing launched though the ceiling has room");
  assert.deepEqual(launched, []);
  room = true;
  assert.equal(await pass(), 2, "the hog is gone: both due runs launch, no restart needed");
  assert.deepEqual(launched, ["h1", "h2"]);
});

test("the terminal claim settles a run exactly once, per worker and across ticks", async () => {
  // File mode: a Set is the whole guarantee, and the claim is per-process.
  const fileClaim = makeTerminalClaim({ kind: "file", owner: "w1" }, "h1");
  assert.equal(await fileClaim("run-a"), true, "first observer wins");
  assert.equal(await fileClaim("run-a"), false, "a racing second tick loses");
  assert.equal(await fileClaim("run-b"), true, "a different run claims independently");

  // Nucleus mode: the KV decides, so two PROCESSES share the same answer.
  let kvCalls = 0;
  const nucleusClaimA = makeTerminalClaim(
    {
      kind: "nucleus",
      owner: "w1",
      db: { kv: { setNX: async () => { kvCalls += 1; return kvCalls === 1; } } } as never,
    },
    "h1",
  );
  const nucleusClaimB = makeTerminalClaim(
    {
      kind: "nucleus",
      owner: "w2",
      db: { kv: { setNX: async () => false } } as never,
    },
    "h2",
  );
  assert.equal(await nucleusClaimA("run-c"), true);
  assert.equal(await nucleusClaimB("run-c"), false, "the other worker in the fleet loses");

  // A KV failure must NOT answer true: an unreachable store skipping a settle
  // under-counts spend; processing twice over-counts and trips the budget cap
  // on money nobody spent.
  const brokenClaim = makeTerminalClaim(
    {
      kind: "nucleus",
      owner: "w1",
      db: {
        kv: {
          setNX: async () => {
            throw new Error("kv down");
          },
        },
      } as never,
    },
    "h1",
  );
  assert.equal(await brokenClaim("run-d"), false, "a KV failure claims nothing");
});

test("a released terminal claim can be won again — a failed settle is not recorded as done", async () => {
  // File mode.
  const fileClaim = makeTerminalClaim({ kind: "file", owner: "w1" }, "h1");
  assert.equal(await fileClaim("run-a"), true);
  await fileClaim.release("run-a");
  assert.equal(await fileClaim("run-a"), true, "released, so claimable again");

  // Nucleus mode: release is compare-and-delete on the holder's OWN value —
  // a rival's claim is never deleted.
  const kv = new Map<string, string>();
  const db = {
    kv: {
      setNX: async (key: string, value: string) => (kv.has(key) ? false : (kv.set(key, value), true)),
      cdel: async (key: string, expected: string) => (kv.get(key) === expected ? kv.delete(key) : false),
    },
  } as never;
  const a = makeTerminalClaim({ kind: "nucleus", owner: "w1", db }, "h1");
  const b = makeTerminalClaim({ kind: "nucleus", owner: "w2", db }, "h2");
  assert.equal(await a("run-c"), true);
  await b.release("run-c");
  assert.equal(kv.get("ship:done:run-c"), "w1:h1", "w2 cannot release w1's claim");
  await a.release("run-c");
  assert.equal(kv.has("ship:done:run-c"), false);
  assert.equal(await b("run-c"), true, "after the holder releases, the next observer settles");
});

test("retrying: a transient store failure is retried; a persistent one still throws", async () => {
  let calls = 0;
  const retried: number[] = [];
  const value = await retrying(
    async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("Cannot read properties of undefined (reading 'name')");
      return "settled";
    },
    { attempts: 4, delayMs: 1, onRetry: (attempt) => retried.push(attempt) },
  );
  assert.equal(value, "settled");
  assert.equal(calls, 3);
  assert.deepEqual(retried, [1, 2]);

  let always = 0;
  await assert.rejects(
    retrying(async () => { always += 1; throw new Error("down"); }, { attempts: 3, delayMs: 1 }),
    /down/,
  );
  assert.equal(always, 3, "exactly `attempts` tries, then the error surfaces");
});

test("P3-4: at the concurrency ceiling, due runs QUEUE — nothing is dropped or errored", async () => {
  const due = [
    { runId: "r1", sleeping: false },
    { runId: "r2", sleeping: false },
    { runId: "r3", sleeping: false },
  ];
  const inflight = new Set<string>();
  const launching = new Set<string>();
  const launched: string[] = [];

  // Ceiling 2, five slots of nothing running: exactly the first two launch.
  const first = await launchDueBounded({
    due: async () => due,
    inflight,
    launching,
    maxConcurrent: 2,
    launch: (runId) => {
      launched.push(runId);
      launching.add(runId);
    },
  });
  assert.equal(first, 2);
  assert.deepEqual(launched, ["r1", "r2"]);

  // r1 and r2 are mid-execution. The third pass must launch NOTHING — r3
  // waits, still due, not dropped and not errored.
  const second = await launchDueBounded({
    due: async () => due,
    inflight,
    launching,
    maxConcurrent: 2,
    launch: (runId) => {
      launched.push(runId);
      launching.add(runId);
    },
  });
  assert.equal(second, 0, "the ceiling is the ceiling");
  assert.deepEqual(launched, ["r1", "r2"], "r3 was not launched past the cap");

  // r1 finishes: its slot frees and it leaves the due list (the index records
  // the terminal status) — and r3, unmodified, still due, launches.
  // Queue-not-drop, end to end.
  launching.delete("r1");
  inflight.delete("r1");
  due.shift();
  const third = await launchDueBounded({
    due: async () => due,
    inflight,
    launching,
    maxConcurrent: 2,
    launch: (runId) => {
      launched.push(runId);
      launching.add(runId);
    },
  });
  assert.equal(third, 1);
  assert.deepEqual(launched, ["r1", "r2", "r3"]);
});

test("P3-4: a run that is both launching and in flight occupies ONE slot, not two", async () => {
  // The real worker keeps a run in `launching` until driveOne returns AND in
  // `inflight` from the moment the lease is won — so during execution it is in
  // both. Counting it twice halved the effective ceiling (found under load).
  const due = [
    { runId: "r1", sleeping: false },
    { runId: "r2", sleeping: false },
    { runId: "r3", sleeping: false },
    { runId: "r4", sleeping: false },
  ];
  const inflight = new Set<string>();
  const launching = new Set<string>();
  const launched: string[] = [];
  const launch = (runId: string): void => {
    launched.push(runId);
    launching.add(runId);
    inflight.add(runId); // lease won — exactly what the real driveOne does via onStart
  };

  const first = await launchDueBounded({ due: async () => due, inflight, launching, maxConcurrent: 4, launch });
  assert.equal(first, 4, "four slots, four launches — a run in both sets is still one run");
  assert.deepEqual(launched, ["r1", "r2", "r3", "r4"]);

  // r1 leaves inflight first (onComplete) and launching a beat later (driveOne
  // returns); between the two it must still hold exactly one slot.
  inflight.delete("r1");
  due.push({ runId: "r5", sleeping: false });
  const between = await launchDueBounded({ due: async () => due, inflight, launching, maxConcurrent: 4, launch });
  assert.equal(between, 0, "r1 is still launching: its slot is not free yet");
  launching.delete("r1");
  due.shift();
  const after = await launchDueBounded({ due: async () => due, inflight, launching, maxConcurrent: 4, launch });
  assert.equal(after, 1);
  assert.deepEqual(launched.at(-1), "r5");
});

test("worker sweep bounds simultaneously-running auto-launches to maxConcurrentRuns", async () => {
  const h = harness({ maxConcurrentRuns: 2 }, [mkTask("t1"), mkTask("t2"), mkTask("t3")]);

  await sweepIntake(h.deps);
  assert.equal(h.launched.length, 2, "only two launch under a ceiling of 2");
  assert.equal(h.deps.inFlight.size, 2);
  assert.equal((await h.intake.list("proposed")).length, 1, "the third defers, still proposed");

  // A no-op sweep while both are still running launches nothing more.
  await sweepIntake(h.deps);
  assert.equal(h.launched.length, 2, "still at the ceiling — nothing new");

  // One run finishes; the freed slot lets the deferred task launch.
  h.terminal.set(h.launched[0]!, { terminal: true, usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 } });
  await sweepIntake(h.deps);
  assert.equal(h.launched.length, 3, "the third launches once a slot frees");
  assert.equal((await h.intake.list("proposed")).length, 0);
  assert.equal(h.deps.inFlight.size, 2, "one finished, one newly launched");
  // Spend is settled by the worker's onComplete, for every run whatever
  // launched it — not here, or auto-launched runs would be counted twice.
  assert.equal(await h.spend.get("forgejo", DAY), 0, "the sweep records no spend of its own");
});

test("worker sweep claims atomically: two workers racing on one proposed task launch once", async () => {
  const task = mkTask("t1");
  const a = harness({}, [task]);

  // Worker B sees a STALE proposed list (it swept before A claimed) but
  // shares the store, so its claim must lose.
  const b = harness(
    {
      intake: {
        list: async () => [{ ...task, state: "proposed" }],
        setState: a.intake.setState.bind(a.intake),
        claim: a.intake.claim.bind(a.intake),
      },
      admission: a.admission, // same fleet, so the caps are shared
    },
    [],
  );

  await sweepIntake(a.deps);
  assert.equal(a.launched.length, 1, "worker A wins the claim and launches");

  await sweepIntake(b.deps);
  assert.equal(b.launched.length, 0, "worker B loses the claim — no duplicate run");
  assert.equal(b.deps.inFlight.size, 0);
  // A lost claim must consume no fleet resource: with a daily cap of exactly 1
  // already used by A, B failing the claim (rather than the cap) is the proof.
  assert.equal(await b.admission.takeDailyLaunch("forgejo", DAY, 2), true, "B took nothing from the daily counter");
});

test("worker sweep releases the claim when launch fails, so a later sweep retries", async () => {
  const h = harness(
    {
      launch: async () => {
        throw new Error("enqueue exploded");
      },
    },
    [mkTask("t1")],
  );

  await assert.rejects(() => sweepIntake(h.deps), /enqueue exploded/);
  assert.equal((await h.intake.list("proposed")).length, 1, "the failed launch put the task back to proposed");
  assert.equal(h.deps.inFlight.size, 0);

  // The same store retried by a healthy worker launches normally.
  const retry = harness({ intake: h.intake }, []);
  await sweepIntake(retry.deps);
  assert.equal(retry.launched.length, 1, "the released task launches on retry");
});

test("worker sweep refuses to auto-launch a source at or over its daily budget", async () => {
  const overBudget = harness({ budgetFor: () => 10 }, [mkTask("t1")]);
  await overBudget.spend.add("forgejo", DAY, 12); // already past the $10 cap

  await sweepIntake(overBudget.deps);
  assert.equal(overBudget.launched.length, 0, "an over-budget source is refused");
  assert.equal((await overBudget.intake.list("proposed")).length, 1, "the task stays proposed");

  // Under budget, the same task launches — proving the count cap is not what blocked it.
  const underBudget = harness({ budgetFor: () => 10 }, [mkTask("t1")]);
  await underBudget.spend.add("forgejo", DAY, 2);
  await sweepIntake(underBudget.deps);
  assert.equal(underBudget.launched.length, 1, "a source under budget launches normally");

  // Budget cap is independent of the count cap: high count room, still refused when broke.
  const both = harness({ budgetFor: () => 5, dailyAutoLimit: 100 }, [mkTask("t1")]);
  await both.spend.add("forgejo", DAY, 5); // at the cap; the reservation pushes it over
  await sweepIntake(both.deps);
  assert.equal(both.launched.length, 0, "spend meeting the budget refuses, count cap notwithstanding");
  assert.equal(await both.spend.get("forgejo", DAY), 5, "the refused reservation was released, not left held");
});

test("TS-004: the daily launch cap is fleet-wide, not per worker", async () => {
  // Two workers, one shared fleet: a cap of 2 must mean 2 in total, not 2 each.
  const fleet = new LocalAdmission();
  const a = harness({ admission: fleet, dailyAutoLimit: 2 }, [mkTask("t1"), mkTask("t2")]);
  const b = harness({ admission: fleet, dailyAutoLimit: 2 }, [mkTask("t3"), mkTask("t4")]);

  await sweepIntake(a.deps);
  await sweepIntake(b.deps);

  assert.equal(a.launched.length + b.launched.length, 2, "the cap binds across both workers");
  assert.equal((await b.intake.list("proposed")).length, 2, "B's tasks stay proposed once the fleet cap is used up");
});

test("TS-004: the concurrency ceiling is fleet-wide, and a refusal returns the budget hold", async () => {
  const fleet = new LocalAdmission();
  const a = harness({ admission: fleet, maxConcurrentRuns: 1, budgetFor: () => 100 }, [mkTask("t1")]);
  const b = harness({ admission: fleet, maxConcurrentRuns: 1, budgetFor: () => 100 }, [mkTask("t2")]);

  await sweepIntake(a.deps);
  assert.equal(a.launched.length, 1);
  await sweepIntake(b.deps);
  assert.equal(b.launched.length, 0, "the second worker sees the fleet ceiling, not its own empty map");
  assert.equal((await b.intake.list("proposed")).length, 1, "and the task is put back");
  assert.equal(await b.spend.get("forgejo", DAY), 0, "no stranded budget hold from the refusal");
});

test("TS-004: concurrent admitters see each other's reservation instead of the same free budget", async () => {
  // One shared spend ledger, budget $1, estimate $0.60: the first launch holds
  // $0.60, so the second must see $1.20 committed and back off. Under the old
  // read-then-launch both would have read $0 and both launched.
  const shared = memSpend();
  const fleet = new LocalAdmission();
  const a = harness({ spend: shared, admission: fleet, budgetFor: () => 1, estimatedRunCostUSD: 0.6 }, [mkTask("t1")]);
  const b = harness({ spend: shared, admission: fleet, budgetFor: () => 1, estimatedRunCostUSD: 0.6 }, [mkTask("t2")]);

  await sweepIntake(a.deps);
  await sweepIntake(b.deps);
  assert.equal(a.launched.length, 1);
  assert.equal(b.launched.length, 0, "the in-flight reservation blocks the second launch");
});

test("usageFromEvents: one unpriced leg makes the reconstructed usage unpriced, and harness cost sums when priced", () => {
  const step = (name: string, usage: Record<string, unknown>) => ({ v: 1, seq: 0, type: "step-completed" as const, at: "", name, data: { result: { usage } } });
  const priced = usageFromEvents([
    step("harness-run", { inputTokens: 1, outputTokens: 1, totalTokens: 2, priced: true, costUSD: 0.5 }),
    step("turn-0-think", { inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
  ] as never);
  assert.equal(priced?.priced, undefined);
  assert.equal(priced?.costUSD, 0.5);
  const mixed = usageFromEvents([
    step("turn-0-think", { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUSD: 0.5 }),
    step("attempt-1-harness-run", { inputTokens: 5, outputTokens: 5, totalTokens: 10, priced: false }),
  ] as never);
  assert.equal(mixed?.priced, false);
  assert.equal(mixed?.costUSD, undefined, "no dollar figure survives on an unpriced run");
  assert.equal(mixed?.totalTokens, 12);
});
