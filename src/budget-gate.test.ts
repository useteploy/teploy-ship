import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { memoryReservationLedger, type ReservationLedger } from "./budget-reservation.js";
import { budgetReservationMode, createBudgetGate, resolveBudgetGate } from "./budget-gate.js";
import { DailyBudgetExceededError, assertDailyBudget } from "./runtime.js";
import type { SpendStore } from "./spend.js";
import { sweepIntake } from "./worker.js";
import type { IntakeSweepDeps } from "./worker.js";
import type { IntakeTask } from "./intake.js";
import { LocalAdmission } from "./admission.js";

const DAY = "2026-07-06";
const now = (): Date => new Date(`${DAY}T12:00:00Z`);

function memSpend(): SpendStore {
  const settled = new Map<string, number>();
  const holds = new Map<string, { source: string; day: string; amountUSD: number }>();
  return {
    async add(source, day, amountUSD) {
      settled.set(`${day} ${source}`, (settled.get(`${day} ${source}`) ?? 0) + amountUSD);
    },
    async reserve(id, source, day, amountUSD) {
      holds.set(id, { source, day, amountUSD });
    },
    async release(id) {
      holds.delete(id);
    },
    async held(id) {
      return holds.has(id);
    },
    async get(source, day) {
      let h = 0;
      for (const x of holds.values()) if (x.source === source && x.day === day) h += x.amountUSD;
      return (settled.get(`${day} ${source}`) ?? 0) + h;
    },
    async list() {
      return [];
    },
  };
}

function tasks(n: number, prefix = "t"): IntakeTask[] {
  return Array.from({ length: n }, (_, i) => ({
    taskId: `${prefix}${i}`, source: "forgejo", kind: "issue", title: `${prefix}${i}`, dedupeKey: `${prefix}d${i}`, state: "proposed" as const,
    createdAt: "2026-07-06T00:00:00Z", updatedAt: "2026-07-06T00:00:00Z",
  }));
}

function sweepHarness(gate: ReturnType<typeof createBudgetGate> | undefined, budget: number, n: number, spend = memSpend(), prefix = "t") {
  const list = tasks(n, prefix);
  const launched: string[] = [];
  let seq = 0;
  const deps: IntakeSweepDeps = {
    intake: {
      async list(state) { return list.filter((t) => state === undefined || t.state === state); },
      async setState(id, state) { const t = list.find((x) => x.taskId === id); if (t) t.state = state; },
      async claim(id) { const t = list.find((x) => x.taskId === id); if (!t || t.state !== "proposed") return false; t.state = "launched"; return true; },
    },
    spend,
    ...(gate ? { budgetGate: gate } : {}),
    admission: new LocalAdmission(),
    policies: { forgejo: "auto" },
    dailyAutoLimit: 100,
    maxConcurrentRuns: 100,
    budgetFor: () => budget,
    estimatedRunCostUSD: 0.5,
    inFlight: new Map(),
    outcomeOf: async () => ({ terminal: false }),
    newRunId: () => `run-${prefix}${++seq}`,
    launch: async (_t, runId) => { launched.push(runId); },
    now,
    log: () => {},
  };
  return { deps, launched, spend, list };
}

const snapOf = async (l: ReservationLedger, id = `budget:forgejo:${DAY}`) => {
  const s = await l.snapshot(id);
  if ("ok" in s) throw new Error(s.reason);
  return s;
};

test("flag parsing: default off, unreadable value is off and flagged, never on", () => {
  assert.deepEqual(budgetReservationMode({}), { mode: "off" });
  assert.deepEqual(budgetReservationMode({ SHIP_BUDGET_RESERVATION: "SHADOW" }), { mode: "shadow" });
  assert.deepEqual(budgetReservationMode({ SHIP_BUDGET_RESERVATION: "on" }), { mode: "on" });
  assert.deepEqual(budgetReservationMode({ SHIP_BUDGET_RESERVATION: "yes" }), { mode: "off", invalid: "yes" });
});

test("resolveBudgetGate: off creates nothing; `on` is refused (downgraded to shadow, loudly) off the single-host file runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bgate-"));
  const saved = process.env.TEPLOY_SHIP_STATE;
  process.env.TEPLOY_SHIP_STATE = dir;
  try {
    const logs: string[] = [];
    assert.equal(resolveBudgetGate({ kind: "file" }, {}, (l) => logs.push(l)), undefined);
    assert.equal(resolveBudgetGate({ kind: "file" }, { SHIP_BUDGET_RESERVATION: "nope" }, (l) => logs.push(l)), undefined);
    assert.ok(logs.some((l) => /not off\|shadow\|on/.test(l)));
    assert.equal(resolveBudgetGate({ kind: "nucleus" }, { SHIP_BUDGET_RESERVATION: "on" }, (l) => logs.push(l))?.mode, "shadow");
    assert.ok(logs.some((l) => /REFUSING to enable/.test(l)));
    assert.equal(resolveBudgetGate(undefined, { SHIP_BUDGET_RESERVATION: "on" }, () => {})?.mode, "shadow", "unknown runtime kind is not trusted");
    assert.equal(resolveBudgetGate({ kind: "file" }, { SHIP_BUDGET_RESERVATION: "on" }, () => {})?.mode, "on");
    assert.equal(resolveBudgetGate({ kind: "file" }, { SHIP_BUDGET_RESERVATION: "shadow" }, () => {})?.mode, "shadow");
    assert.deepEqual(await readdir(dir), [], "no ledger file until something is reserved");
  } finally {
    if (saved === undefined) delete process.env.TEPLOY_SHIP_STATE;
    else process.env.TEPLOY_SHIP_STATE = saved;
  }
});

test("flag off: sweep without a gate behaves as before (budget 1.0, est 0.5 admits two, refuses the third)", async () => {
  const h = sweepHarness(undefined, 1, 3);
  await sweepIntake(h.deps);
  assert.equal(h.launched.length, 2);
});

/** Drive A (unpriced), then B and C: only the ledger knows A's money is unknown rather than zero. */
async function unpricedThenTwoMore(mode: "shadow" | "on", unpricedAs: "unpriced" | "zero") {
  const ledger = memoryReservationLedger();
  const logs: string[] = [];
  const gate = createBudgetGate({ mode, ledger, log: (l) => logs.push(l) });
  const spend = memSpend();
  // Run A is admitted, finishes, and settles the way onComplete does.
  const a = sweepHarness(gate, 1, 1, spend, "a");
  await sweepIntake(a.deps);
  const aId = a.launched[0]!;
  await spend.release(aId);
  await gate.settle(aId, unpricedAs === "unpriced" ? { kind: "unpriced" } : { kind: "priced", costUSD: 0 });
  const rest = sweepHarness(gate, 1, 2, spend, "b");
  await sweepIntake(rest.deps);
  return { gate, ledger, logs, launched: rest.launched, list: rest.list };
}

test("shadow: unpriced spend is unknown, so the ledger is stricter; the disagreement is logged and the outcome is UNCHANGED", async () => {
  const r = await unpricedThenTwoMore("shadow", "unpriced");
  assert.equal(r.launched.length, 2, "existing logic still admits both");
  assert.equal(r.gate.stats().ledgerStricter, 1);
  assert.ok(r.logs.some((l) => /DISAGREEMENT .*existing allows.*ledger refuses.*outcome unchanged/.test(l)), r.logs.join("\n"));
  const s = await snapOf(r.ledger);
  assert.equal(s.unpricedCount, 1);
  assert.equal(s.unpricedHeldUSD, 0.5, "the unpriced run keeps its hold; it is not $0");
});

test("NEGATIVE CONTROL: settling the same run as priced $0 frees the money and the ledger stops disagreeing", async () => {
  const r = await unpricedThenTwoMore("shadow", "zero");
  assert.equal(r.gate.stats().ledgerStricter, 0);
  assert.equal((await snapOf(r.ledger)).unpricedCount, 0);
});

test("on: the ledger refusal denies; the task stays proposed and the refused run leaves no hold behind", async () => {
  const r = await unpricedThenTwoMore("on", "unpriced");
  assert.equal(r.launched.length, 1);
  assert.equal(r.list.filter((t) => t.state === "proposed").length, 1);
  const s = await snapOf(r.ledger);
  assert.equal(s.heldUSD, 0.5, "only the admitted run holds");
});

test("assertDailyBudget: shadow records ledger-stricter without throwing; on throws and releases both holds", async () => {
  for (const mode of ["shadow", "on"] as const) {
    const spend = memSpend();
    const ledger = memoryReservationLedger();
    const gate = createBudgetGate({ mode, ledger, log: () => {} });
    const rt = {
      spend,
      projects: { forRepo: async () => undefined },
      policies: { list: async () => [{ source: "scan", dailyBudgetUSD: 1 }] },
    } as never;
    const opts = (id: string) => ({ runId: id, source: "scan", now: new Date(`${DAY}T01:00:00Z`), budgetGate: gate });
    await assertDailyBudget(rt, opts("r1"));
    await spend.release("r1");
    await gate.settle("r1", { kind: "unpriced" });
    await assertDailyBudget(rt, opts("r2"));
    if (mode === "shadow") {
      await assertDailyBudget(rt, opts("r3"));
      assert.equal(gate.stats().ledgerStricter, 1);
    } else {
      await assert.rejects(assertDailyBudget(rt, opts("r3")), DailyBudgetExceededError);
      assert.equal(await spend.held?.("r3"), false);
      assert.equal((await snapOf(ledger, `budget:scan:${DAY}`)).heldUSD, 0.5);
    }
  }
});

test("existing spend is seeded as a baseline, so a store already over the cap and the ledger agree", async () => {
  const spend = memSpend();
  await spend.add("forgejo", DAY, 0.9);
  const gate = createBudgetGate({ mode: "on", ledger: memoryReservationLedger(), log: () => {} });
  const h = sweepHarness(gate, 1, 1, spend);
  await sweepIntake(h.deps);
  assert.equal(h.launched.length, 0);
  assert.equal(gate.stats().agreements, 1);
  assert.equal(gate.stats().ledgerStricter + gate.stats().ledgerLooser, 0);
});

test("release (cancel/lease loss) frees the hold; later billed usage is still counted as overrun, not dropped", async () => {
  const ledger = memoryReservationLedger();
  const gate = createBudgetGate({ mode: "shadow", ledger, log: () => {} });
  const h = sweepHarness(gate, 5, 1);
  await sweepIntake(h.deps);
  const id = h.launched[0]!;
  assert.equal((await snapOf(ledger)).heldUSD, 0.5);
  await gate.release(id);
  assert.equal((await snapOf(ledger)).committedUSD, 0);
  await gate.settle(id, { kind: "priced", costUSD: 0.2 });
  assert.equal((await snapOf(ledger)).overrunUSD, 0.2);
});

test("settle for a run the ledger never held is counted as unreserved, not hidden", async () => {
  const gate = createBudgetGate({ mode: "shadow", ledger: memoryReservationLedger(), log: () => {} });
  await gate.settle("never-held", { kind: "priced", costUSD: 1 });
  assert.equal(gate.stats().unreserved, 1);
});

test("a ledger that throws gives no verdict and never changes the outcome, even in `on`", async () => {
  const broken = { defineScope: async () => { throw new Error("disk gone"); } } as unknown as ReservationLedger;
  const gate = createBudgetGate({ mode: "on", ledger: broken, log: () => {} });
  const h = sweepHarness(gate, 1, 1);
  await sweepIntake(h.deps);
  assert.equal(h.launched.length, 1);
  assert.equal(gate.stats().skipped, 1);
});
