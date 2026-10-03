import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkFence,
  fileReservationLedger,
  memoryReservationLedger,
  nextEpoch,
  type ReservationLedger,
  type ScopeSnapshot,
} from "./budget-reservation.js";

const snap = async (l: ReservationLedger, id: string): Promise<ScopeSnapshot> => {
  const s = await l.snapshot(id);
  if ("ok" in s) throw new Error(`snapshot of ${id} refused: ${s.reason}`);
  return s;
};

async function tree(l: ReservationLedger, parentCap = 5, childCap = 3) {
  assert.deepEqual(await l.defineScope({ id: "p", kind: "parent", capUSD: parentCap }), { ok: true });
  assert.deepEqual(await l.defineScope({ id: "c1", kind: "child", capUSD: childCap, parentId: "p" }), { ok: true });
  assert.deepEqual(await l.defineScope({ id: "c2", kind: "child", capUSD: childCap, parentId: "p" }), { ok: true });
}

/** Run the same suite against both implementations. */
const impls: Array<[string, () => Promise<{ ledger: ReservationLedger; cleanup: () => Promise<void> }>]> = [
  ["memory", async () => ({ ledger: memoryReservationLedger(), cleanup: async () => {} })],
  [
    "file",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "ledger-"));
      return { ledger: fileReservationLedger(join(dir, "nested", "ledger.json")), cleanup: () => rm(dir, { recursive: true, force: true }) };
    },
  ],
];

for (const [name, make] of impls) {
  test(`${name}: concurrent reserves never exceed the scope cap`, async () => {
    const { ledger, cleanup } = await make();
    try {
      await ledger.defineScope({ id: "s", kind: "parent", capUSD: 1 });
      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) => ledger.reserve({ reservationId: `r${i}`, scopeId: "s", amountUSD: 0.1 })),
      );
      const granted = results.filter((r) => r.ok).length;
      assert.equal(granted, 10, "exactly cap/amount reservations granted");
      assert.ok(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "over-cap"));
      const s = await snap(ledger, "s");
      assert.ok(s.committedUSD <= s.capUSD);
      assert.equal(s.heldUSD, 1);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: racing children cannot jointly exceed the parent cap`, async () => {
    const { ledger, cleanup } = await make();
    try {
      await tree(ledger, 5, 3); // each child could hold 3; the parent only 5
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          ledger.reserve({ reservationId: `r${i}`, scopeId: i % 2 === 0 ? "c1" : "c2", amountUSD: 1 }),
        ),
      );
      assert.equal(results.filter((r) => r.ok).length, 5);
      const p = await snap(ledger, "p");
      assert.equal(p.committedUSD, 5);
      assert.ok((await snap(ledger, "c1")).committedUSD <= 3);
      assert.ok((await snap(ledger, "c2")).committedUSD <= 3);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: a child under its own cap is refused when the parent is full`, async () => {
    const { ledger, cleanup } = await make();
    try {
      await tree(ledger, 4, 3);
      assert.ok((await ledger.reserve({ reservationId: "a", scopeId: "c1", amountUSD: 3 })).ok);
      assert.ok((await ledger.reserve({ reservationId: "b", scopeId: "c2", amountUSD: 1 })).ok);
      const refused = await ledger.reserve({ reservationId: "c", scopeId: "c2", amountUSD: 1 });
      assert.equal(refused.ok, false);
      if (!refused.ok && refused.reason === "over-cap") assert.equal(refused.scopeId, "p");
      else assert.fail("expected over-cap at the parent");
      // The refusal wrote nothing.
      assert.equal((await snap(ledger, "c2")).committedUSD, 1);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: a retry scope is capped independently inside its parent`, async () => {
    const { ledger, cleanup } = await make();
    try {
      await ledger.defineScope({ id: "p", kind: "parent", capUSD: 10 });
      await ledger.defineScope({ id: "retries", kind: "retry", capUSD: 1, parentId: "p" });
      assert.ok((await ledger.reserve({ reservationId: "a", scopeId: "retries", amountUSD: 1 })).ok);
      const r = await ledger.reserve({ reservationId: "b", scopeId: "retries", amountUSD: 0.01 });
      assert.ok(!r.ok && r.reason === "over-cap" && r.scopeId === "retries");
      // The parent still has room for non-retry work.
      assert.ok((await ledger.reserve({ reservationId: "w", scopeId: "p", amountUSD: 5 })).ok);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: reserve is idempotent by id, and release frees the room`, async () => {
    const { ledger, cleanup } = await make();
    try {
      await ledger.defineScope({ id: "s", kind: "parent", capUSD: 1 });
      const a = await ledger.reserve({ reservationId: "x", scopeId: "s", amountUSD: 1 });
      const again = await ledger.reserve({ reservationId: "x", scopeId: "s", amountUSD: 1 });
      assert.ok(a.ok && again.ok && again.replay);
      assert.equal((await snap(ledger, "s")).heldUSD, 1, "a retried admission holds once");
      assert.equal((await ledger.reserve({ reservationId: "y", scopeId: "s", amountUSD: 0.5 })).ok, false);
      await ledger.release("x");
      assert.ok((await ledger.reserve({ reservationId: "y", scopeId: "s", amountUSD: 0.5 })).ok);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: cancellation then late settle is an overrun, not a drop`, async () => {
    const { ledger, cleanup } = await make();
    try {
      await ledger.defineScope({ id: "s", kind: "parent", capUSD: 1 });
      await ledger.reserve({ reservationId: "x", scopeId: "s", amountUSD: 0.6 });
      await ledger.release("x"); // cancelled
      assert.equal((await snap(ledger, "s")).committedUSD, 0);
      const late = await ledger.settle("x", { priced: true, actualUSD: 0.4 });
      assert.deepEqual(late, { ok: true, recorded: "late-overrun", overrunUSD: 0.4 });
      const s = await snap(ledger, "s");
      assert.equal(s.overrunUSD, 0.4);
      assert.equal(s.committedUSD, 0.4, "late spend counts against the cap");
      // Spending resumed by nobody's authority: the room it used is gone.
      assert.equal((await ledger.reserve({ reservationId: "y", scopeId: "s", amountUSD: 0.7 })).ok, false);
      // Late UNPRICED usage is counted and flagged, never $0-and-forgotten.
      assert.deepEqual(await ledger.settle("x", { priced: false }), { ok: true, recorded: "late-unpriced" });
      assert.equal((await snap(ledger, "s")).unpricedCount, 1);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: priced settle frees the unspent part and records overrun past the hold`, async () => {
    const { ledger, cleanup } = await make();
    try {
      await ledger.defineScope({ id: "s", kind: "parent", capUSD: 2 });
      await ledger.reserve({ reservationId: "a", scopeId: "s", amountUSD: 1 });
      assert.deepEqual(await ledger.settle("a", { priced: true, actualUSD: 0.25 }), { ok: true, recorded: "settled", overrunUSD: 0 });
      assert.equal((await snap(ledger, "s")).committedUSD, 0.25);
      await ledger.reserve({ reservationId: "b", scopeId: "s", amountUSD: 0.5 });
      assert.deepEqual(await ledger.settle("b", { priced: true, actualUSD: 0.75 }), { ok: true, recorded: "settled", overrunUSD: 0.25 });
      const s = await snap(ledger, "s");
      assert.equal(s.settledUSD, 1);
      assert.equal(s.overrunUSD, 0.25);
      assert.equal((await ledger.settle("a", { priced: true, actualUSD: 9 })).ok, false, "double settle is refused");
    } finally {
      await cleanup();
    }
  });

  test(`${name}: unpriced settlement holds its reservation, is counted apart, and cannot be released to $0`, async () => {
    const { ledger, cleanup } = await make();
    try {
      await ledger.defineScope({ id: "s", kind: "parent", capUSD: 1 });
      await ledger.reserve({ reservationId: "x", scopeId: "s", amountUSD: 0.8 });
      assert.deepEqual(await ledger.settle("x", { priced: false }), { ok: true, recorded: "unpriced-held" });
      let s = await snap(ledger, "s");
      assert.equal(s.settledUSD, 0, "not recorded as spend");
      assert.equal(s.unpricedHeldUSD, 0.8);
      assert.equal(s.unpricedCount, 1);
      assert.equal(s.committedUSD, 0.8, "still holds the cap");
      // Releasing would zero unknown spend; it is a no-op instead.
      assert.deepEqual(await ledger.release("x"), { ok: true, released: false });
      assert.equal((await ledger.reserve({ reservationId: "y", scopeId: "s", amountUSD: 0.5 })).ok, false);
      // Operator resolves it with a real number; the hold becomes spend.
      assert.equal((await ledger.resolveUnpriced("x", 0.3)).ok, true);
      s = await snap(ledger, "s");
      assert.equal(s.settledUSD, 0.3);
      assert.equal(s.unpricedHeldUSD, 0);
      assert.ok((await ledger.reserve({ reservationId: "y", scopeId: "s", amountUSD: 0.5 })).ok);
      const again = await ledger.resolveUnpriced("x", 0.3);
      assert.ok(!again.ok && again.reason === "not-unpriced-held");
    } finally {
      await cleanup();
    }
  });

  test(`${name}: a stale worker's reserve, settle and release are refused after takeover`, async () => {
    const { ledger, cleanup } = await make();
    try {
      await ledger.defineScope({ id: "s", kind: "parent", capUSD: 10 });
      const old = { resource: "run-1", epoch: await ledger.takeOver("run-1") };
      assert.ok((await ledger.reserve({ reservationId: "a", scopeId: "s", amountUSD: 1 }, old)).ok);
      // Lease expires; a second worker takes over.
      const fresh = { resource: "run-1", epoch: await ledger.takeOver("run-1") };
      assert.equal(fresh.epoch, old.epoch + 1);
      const refusals = await Promise.all([
        ledger.reserve({ reservationId: "b", scopeId: "s", amountUSD: 1 }, old),
        ledger.settle("a", { priced: true, actualUSD: 1 }, old),
        ledger.release("a", old),
      ]);
      for (const r of refusals) assert.ok(!r.ok && r.reason === "stale-epoch", JSON.stringify(r));
      assert.equal((await snap(ledger, "s")).heldUSD, 1, "the stale worker changed nothing");
      assert.equal((await ledger.settle("a", { priced: true, actualUSD: 1 }, fresh)).ok, true);
      // A token never issued, and a resource never acquired, are refused too.
      assert.equal((await ledger.reserve({ reservationId: "c", scopeId: "s", amountUSD: 1 }, { resource: "run-1", epoch: 99 })).ok, false);
      assert.equal((await ledger.reserve({ reservationId: "d", scopeId: "s", amountUSD: 1 }, { resource: "other", epoch: 1 })).ok, false);
    } finally {
      await cleanup();
    }
  });

  test(`${name}: only one of two racing takeovers' tokens is current`, async () => {
    const { ledger, cleanup } = await make();
    try {
      await ledger.defineScope({ id: "s", kind: "parent", capUSD: 10 });
      const [e1, e2] = await Promise.all([ledger.takeOver("r"), ledger.takeOver("r")]);
      assert.notEqual(e1, e2, "epochs are never reused");
      const writes = await Promise.all(
        [e1, e2].map((epoch, i) => ledger.reserve({ reservationId: `w${i}`, scopeId: "s", amountUSD: 1 }, { resource: "r", epoch })),
      );
      assert.equal(writes.filter((w) => w.ok).length, 1, "exactly one duplicate-writer candidate wins");
    } finally {
      await cleanup();
    }
  });
}

test("file ledger persists across instances (restart)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-"));
  try {
    const path = join(dir, "l.json");
    const a = fileReservationLedger(path);
    await a.defineScope({ id: "s", kind: "parent", capUSD: 1 });
    await a.reserve({ reservationId: "x", scopeId: "s", amountUSD: 0.9 });
    await a.settle("x", { priced: false });
    const epoch = await a.takeOver("r");
    const b = fileReservationLedger(path);
    const s = await snap(b, "s");
    assert.equal(s.unpricedHeldUSD, 0.9);
    assert.equal((await b.reserve({ reservationId: "y", scopeId: "s", amountUSD: 0.2 })).ok, false);
    assert.equal(await b.takeOver("r"), epoch + 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid input is refused, not coerced", async () => {
  const l = memoryReservationLedger();
  await l.defineScope({ id: "s", kind: "parent", capUSD: 1 });
  for (const amountUSD of [0, -1, NaN, Infinity]) {
    const r = await l.reserve({ reservationId: `i${amountUSD}`, scopeId: "s", amountUSD });
    assert.ok(!r.ok && r.reason === "invalid");
  }
  assert.ok(!(await l.reserve({ reservationId: "u", scopeId: "nope", amountUSD: 1 })).ok);
  assert.ok(!(await l.defineScope({ id: "k", kind: "child", capUSD: 1 })).ok, "child needs a parent");
  assert.ok(!(await l.defineScope({ id: "s", kind: "parent", capUSD: 2 })).ok, "cap cannot be silently resized");
  await l.reserve({ reservationId: "x", scopeId: "s", amountUSD: 0.5 });
  const neg = await l.settle("x", { priced: true, actualUSD: -1 });
  assert.ok(!neg.ok && neg.reason === "invalid");
});

test("checkFence: exact match only, pure", () => {
  assert.deepEqual(checkFence(3, 3), { ok: true });
  assert.equal(checkFence(3, 2).ok, false);
  assert.equal(checkFence(3, 4).ok, false);
  assert.equal(checkFence(undefined, 1).ok, false);
  assert.equal(checkFence(3, 0).ok, false);
  assert.equal(checkFence(3, 1.5).ok, false);
  assert.equal(nextEpoch(undefined), 1);
  assert.equal(nextEpoch(7), 8);
});

// ---------------------------------------------------------------------------
// Negative controls: the naive designs this module replaces, under the SAME
// race. If these ever stop failing, the tests above have stopped proving
// anything (the race window has closed), not the naive design become safe.
// ---------------------------------------------------------------------------

test("NEGATIVE CONTROL: a naive read-then-write reserve exceeds the cap under the same race", async () => {
  let committedMicro = 0;
  const capMicro = 1_000_000;
  const naiveReserve = async (amountMicro: number): Promise<boolean> => {
    const seen = committedMicro; // read
    await Promise.resolve(); // the yield every real store has between read and write
    if (seen + amountMicro > capMicro) return false; // decide on a stale read
    committedMicro = seen + amountMicro; // write
    return true;
  };
  const results = await Promise.all(Array.from({ length: 25 }, () => naiveReserve(100_000)));
  assert.ok(results.filter(Boolean).length > 10, "naive design granted more than the cap allows");
  // Every reader saw 0, so all 25 were granted: 2.5x the cap was promised.
  assert.ok(results.filter(Boolean).length * 100_000 > capMicro);
});

test("NEGATIVE CONTROL: a naive 'check epoch, then write' admits a stale worker that the transactional fence refuses", async () => {
  let epoch = 1;
  let writes = 0;
  const naiveFencedWrite = async (presented: number): Promise<boolean> => {
    if (presented !== epoch) return false; // check
    await Promise.resolve(); // takeover lands here
    writes += 1; // write
    return true;
  };
  const stale = naiveFencedWrite(1);
  epoch = 2; // second worker takes over between the check and the write
  assert.equal(await stale, true, "the naive check let the old worker write after takeover");
  assert.equal(writes, 1);

  // Same interleaving through the ledger: takeOver queued behind an in-flight
  // reserve is serialized, so the old token's write either lands BEFORE the
  // takeover or is refused — never after.
  const l = memoryReservationLedger();
  await l.defineScope({ id: "s", kind: "parent", capUSD: 10 });
  const old = { resource: "r", epoch: await l.takeOver("r") };
  const [inFlight, , late] = await Promise.all([
    l.reserve({ reservationId: "a", scopeId: "s", amountUSD: 1 }, old),
    l.takeOver("r"),
    l.reserve({ reservationId: "b", scopeId: "s", amountUSD: 1 }, old),
  ]);
  assert.ok(inFlight.ok);
  assert.ok(!late.ok && late.reason === "stale-epoch");
});

test("NEGATIVE CONTROL: recording an unpriced settlement as $0 would let the cap fail open", async () => {
  // What the wrong behaviour looks like: settle(actual=0) in place of unpriced.
  const l = memoryReservationLedger();
  await l.defineScope({ id: "s", kind: "parent", capUSD: 1 });
  await l.reserve({ reservationId: "x", scopeId: "s", amountUSD: 1 });
  await l.settle("x", { priced: true, actualUSD: 0 }); // the bug: unknown treated as free
  assert.ok((await l.reserve({ reservationId: "y", scopeId: "s", amountUSD: 1 })).ok, "cap re-opened by a fake $0");

  // The real path keeps the cap closed.
  const real = memoryReservationLedger();
  await real.defineScope({ id: "s", kind: "parent", capUSD: 1 });
  await real.reserve({ reservationId: "x", scopeId: "s", amountUSD: 1 });
  await real.settle("x", { priced: false });
  assert.equal((await real.reserve({ reservationId: "y", scopeId: "s", amountUSD: 1 })).ok, false);
});
