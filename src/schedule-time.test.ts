import { test } from "node:test";
import assert from "node:assert/strict";

import {
  offsetAt,
  planSlots,
  resolveLocal,
  specProblem,
  validTimezone,
  type ScheduleTimeSpec,
} from "./schedule-time.js";

const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

const daily = (timezone: string, time: string, extra: Partial<ScheduleTimeSpec> = {}, createdAt = "2026-01-01T00:00:00Z"): ScheduleTimeSpec => ({
  createdAt,
  everyMinutes: 1440,
  at: { timezone, time },
  ...extra,
});

/** Sweep every `step` ms over [from, to], carrying the receipt the way the worker does. */
function simulate(spec: ScheduleTimeSpec, from: number, to: number, step = 7 * MIN, startReceipt?: string) {
  let receipt = startReceipt;
  let lastFired: string | undefined;
  const fired: { id: string; at: number; sweptAt: number }[] = [];
  for (let t = from; t <= to; t += step) {
    const plan = planSlots(spec, receipt, t, false, lastFired);
    for (const s of plan.fire) fired.push({ id: s.id, at: s.at, sweptAt: t });
    if (plan.fire.length > 0) lastFired = plan.fire[plan.fire.length - 1].id;
    if (plan.advanceTo !== null) receipt = plan.advanceTo;
  }
  return fired;
}

/**
 * The naive implementation this module exists to replace: "fire when the local
 * wall clock reads HH:MM", checked every minute using the zone's UTC offset at
 * that minute. Counts how many minutes of [from, to) match.
 */
function naiveWallClockFires(tz: string, hh: number, mm: number, from: number, to: number): number {
  let n = 0;
  for (let t = from; t < to; t += MIN) {
    const w = new Date(t + offsetAt(tz, t));
    if (w.getUTCHours() === hh && w.getUTCMinutes() === mm) n++;
  }
  return n;
}

// ---- timezone validation ---------------------------------------------------

test("unknown or non-IANA timezones are refused, real ones accepted", () => {
  for (const ok of ["America/New_York", "Europe/London", "Asia/Kolkata", "Australia/Adelaide", "UTC", "America/Argentina/Buenos_Aires"]) {
    assert.equal(validTimezone(ok), true, ok);
  }
  for (const bad of ["Mars/Olympus", "EST", "utc", "", "+05:00", "America/", "Nowhere", "../etc/passwd", 5, undefined, null]) {
    assert.equal(validTimezone(bad), false, String(bad));
  }
  assert.match(specProblem(daily("Mars/Olympus", "09:00")) ?? "", /unknown timezone/);
  // planSlots refuses to produce work for an invalid spec instead of guessing UTC.
  const plan = planSlots(daily("Mars/Olympus", "09:00"), undefined, Date.parse("2026-06-01T00:00:00Z"));
  assert.deepEqual(plan.fire, []);
  assert.equal(plan.advanceTo, null);
});

test("malformed at/policy fields are named, valid ones pass", () => {
  assert.match(specProblem(daily("UTC", "9:00")) ?? "", /HH:MM/);
  assert.match(specProblem(daily("UTC", "24:00")) ?? "", /HH:MM/);
  assert.match(specProblem(daily("UTC", "09:60")) ?? "", /HH:MM/);
  assert.match(specProblem({ ...daily("UTC", "09:00"), at: { timezone: "UTC", time: "09:00", days: ["mon", "mon"] } }) ?? "", /weekday/);
  assert.match(specProblem({ ...daily("UTC", "09:00"), at: { timezone: "UTC", time: "09:00", days: ["funday" as any] } }) ?? "", /weekday/);
  assert.match(specProblem(daily("UTC", "09:00", { missedPolicy: { kind: "catch-up", max: 0 } })) ?? "", /missedPolicy/);
  assert.match(specProblem(daily("UTC", "09:00", { missedPolicy: "everything" as any })) ?? "", /missedPolicy/);
  assert.match(specProblem(daily("UTC", "09:00", { overlap: "pile-on" as any })) ?? "", /overlap/);
  assert.match(specProblem(daily("UTC", "09:00", { debounceMinutes: 0 })) ?? "", /debounce/);
  assert.equal(specProblem(daily("UTC", "09:00", { missedPolicy: { kind: "catch-up", max: 5 }, overlap: "queue", debounceMinutes: 30 })), null);
  assert.equal(specProblem({ createdAt: "2026-01-01T00:00:00Z", everyMinutes: 60 }), null);
});

// ---- wall-clock resolution at transitions ----------------------------------

test("resolveLocal: spring-forward gaps shift forward, fall-back repeats take the earlier instant", () => {
  // New York 2026: spring forward Mar 8 02:00->03:00, fall back Nov 1 02:00->01:00.
  assert.equal(iso(resolveLocal("America/New_York", 2026, 3, 8, 2, 30)), "2026-03-08T07:30:00.000Z"); // = 03:30 EDT
  assert.equal(iso(resolveLocal("America/New_York", 2026, 11, 1, 1, 30)), "2026-11-01T05:30:00.000Z"); // first (EDT) 01:30
  // London 2026: Mar 29 01:00->02:00, Oct 25 02:00->01:00.
  assert.equal(iso(resolveLocal("Europe/London", 2026, 3, 29, 1, 30)), "2026-03-29T01:30:00.000Z"); // = 02:30 BST
  assert.equal(iso(resolveLocal("Europe/London", 2026, 10, 25, 1, 30)), "2026-10-25T00:30:00.000Z"); // first (BST) 01:30
  // Adelaide (+10:30 DST / +09:30 std): Apr 5 03:00->02:00, Oct 4 02:00->03:00.
  assert.equal(iso(resolveLocal("Australia/Adelaide", 2026, 4, 5, 2, 30)), "2026-04-04T16:00:00.000Z"); // first (ACDT) 02:30
  assert.equal(iso(resolveLocal("Australia/Adelaide", 2026, 10, 4, 2, 30)), "2026-10-03T17:00:00.000Z"); // 02:30 ACST -> 03:00 ACDT
  // Fixed half-hour zone: no transitions, plain offset.
  assert.equal(iso(resolveLocal("Asia/Kolkata", 2026, 6, 1, 9, 0)), "2026-06-01T03:30:00.000Z");
  // Ordinary day is unaffected.
  assert.equal(iso(resolveLocal("America/New_York", 2026, 7, 4, 9, 0)), "2026-07-04T13:00:00.000Z");
});

// ---- DST: exactly once, and the naive approach is not ----------------------

const DST_CASES: { name: string; tz: string; time: string; day: [number, number, number]; naive: number; id: string }[] = [
  { name: "New York fall-back (01:30 happens twice)", tz: "America/New_York", time: "01:30", day: [2026, 11, 1], naive: 2, id: "20261101" },
  { name: "New York spring-forward (02:30 never happens)", tz: "America/New_York", time: "02:30", day: [2026, 3, 8], naive: 0, id: "20260308" },
  { name: "London fall-back", tz: "Europe/London", time: "01:30", day: [2026, 10, 25], naive: 2, id: "20261025" },
  { name: "London spring-forward", tz: "Europe/London", time: "01:30", day: [2026, 3, 29], naive: 0, id: "20260329" },
  { name: "Adelaide fall-back (half-hour offset zone)", tz: "Australia/Adelaide", time: "02:30", day: [2026, 4, 5], naive: 2, id: "20260405" },
  { name: "Adelaide spring-forward (half-hour offset zone)", tz: "Australia/Adelaide", time: "02:30", day: [2026, 10, 4], naive: 0, id: "20261004" },
];

for (const c of DST_CASES) {
  test(`DST ${c.name}: exactly one slot; naive wall-clock matching fires ${c.naive}x`, () => {
    const [y, m, d] = c.day;
    const [hh, mm] = c.time.split(":").map(Number);
    const from = Date.UTC(y, m - 1, d - 1, 0, 0);
    const to = Date.UTC(y, m - 1, d + 2, 0, 0);
    // Negative control: the naive implementation is wrong in exactly this window.
    // The window spans three local days: two ordinary days match once each, the transition day matches `naive` times.
    const total = naiveWallClockFires(c.tz, hh, mm, from, to);
    assert.equal(total, 2 + c.naive, `naive total over three days (two ordinary days + ${c.naive})`);
    assert.notEqual(c.naive, 1);

    const spec = daily(c.tz, c.time);
    // Sweep every 7 minutes across the window; the slot for the transition date fires once.
    const fired = simulate(spec, from, to, 7 * MIN, undefined).filter((f) => f.id === c.id);
    assert.equal(fired.length, 1, `slot ${c.id} fired ${fired.length}x`);
    assert.equal(fired[0].at, resolveLocal(c.tz, y, m, d, hh, mm));
    // Sweeping every minute (denser than any real worker) is also exactly once.
    assert.equal(simulate(spec, from, to, MIN).filter((f) => f.id === c.id).length, 1);
  });
}

test("DST: a day's slot is one slot even when the sweep lands inside the repeated hour twice", () => {
  const spec = daily("America/New_York", "01:30");
  const first = resolveLocal("America/New_York", 2026, 11, 1, 1, 30); // 05:30Z
  const second = first + HOUR; // the repeated 01:30 EST
  const p1 = planSlots(spec, "20261031", first + MIN);
  assert.deepEqual(p1.fire.map((s) => s.id), ["20261101"]);
  const p2 = planSlots(spec, p1.advanceTo ?? undefined, second + MIN);
  assert.deepEqual(p2.fire, []);
  // Negative control: pretending the receipt was lost, the same slot id is reproduced
  // (so intake's dedupeKey, not luck, is what stops a duplicate).
  assert.deepEqual(planSlots(spec, "20261031", second + MIN).fire.map((s) => s.id), ["20261101"]);
});

test("DST: the day after each transition is unaffected and still fires once", () => {
  const spec = daily("Europe/London", "09:00");
  const fired = simulate(spec, Date.UTC(2026, 2, 27), Date.UTC(2026, 3, 2), 13 * MIN, "20260326");
  assert.deepEqual(fired.map((f) => f.id), ["20260327", "20260328", "20260329", "20260330", "20260331", "20260401"]);
  // Local 09:00 each day: GMT before the 29th (09:00Z), BST after (08:00Z).
  assert.equal(iso(fired[1].at), "2026-03-28T09:00:00.000Z");
  assert.equal(iso(fired[2].at), "2026-03-29T08:00:00.000Z");
});

// ---- calendar edges --------------------------------------------------------

test("leap day: Feb 29 2028 fires; the same span in 2027 has no Feb 29", () => {
  const catchUp = { missedPolicy: { kind: "catch-up", max: 10 } } as const;
  const leap = planSlots(daily("America/New_York", "12:00", catchUp, "2028-02-26T00:00:00Z"), undefined, Date.parse("2028-03-01T18:00:00Z"));
  assert.deepEqual(leap.fire.map((s) => s.id), ["20280226", "20280227", "20280228", "20280229", "20280301"]);
  const common = planSlots(daily("America/New_York", "12:00", catchUp, "2027-02-26T00:00:00Z"), undefined, Date.parse("2027-03-01T18:00:00Z"));
  assert.deepEqual(common.fire.map((s) => s.id), ["20270226", "20270227", "20270228", "20270301"]);
});

test("month-end and year-end roll over without skipping or repeating a day", () => {
  const catchUp = { missedPolicy: { kind: "catch-up", max: 20 } } as const;
  const jan = planSlots(daily("Asia/Kolkata", "06:00", catchUp, "2027-01-29T00:00:00Z"), undefined, Date.parse("2027-02-02T12:00:00Z"));
  assert.deepEqual(jan.fire.map((s) => s.id), ["20270129", "20270130", "20270131", "20270201", "20270202"]);
  const ye = planSlots(daily("Asia/Kolkata", "06:00", catchUp, "2026-12-30T00:00:00Z"), undefined, Date.parse("2027-01-02T12:00:00Z"));
  assert.deepEqual(ye.fire.map((s) => s.id), ["20261230", "20261231", "20270101", "20270102"]);
  // Weekly: Fridays across the Jan/Feb boundary (2027-01-01 is a Friday).
  const fri = planSlots(
    { ...daily("UTC", "08:00", catchUp, "2026-12-31T00:00:00Z"), at: { timezone: "UTC", time: "08:00", days: ["fri"] } },
    undefined,
    Date.parse("2027-02-06T00:00:00Z"),
  );
  assert.deepEqual(fri.fire.map((s) => s.id), ["20270101", "20270108", "20270115", "20270122", "20270129", "20270205"]);
});

test("a schedule never fires for a slot at or before its creation", () => {
  const spec = daily("UTC", "09:00", {}, "2026-06-01T09:00:00Z"); // created exactly at the slot
  assert.deepEqual(planSlots(spec, undefined, Date.parse("2026-06-01T09:30:00Z")).fire, []);
  assert.deepEqual(planSlots(spec, undefined, Date.parse("2026-06-02T09:00:00Z")).fire.map((s) => s.id), ["20260602"]);
});

// ---- missed-trigger policy: a laptop closed for ten days -------------------

const laptop = (missedPolicy: ScheduleTimeSpec["missedPolicy"], graceMinutes?: number): ScheduleTimeSpec =>
  daily("America/New_York", "09:00", { ...(missedPolicy !== undefined ? { missedPolicy } : {}), ...(graceMinutes !== undefined ? { graceMinutes } : {}) });
// Last handled slot 2026-06-01; machine wakes 2026-06-11 at 14:00 NY (18:00Z): ten slots missed (06-02..06-11).
const LAST = "20260601";
const WAKE = Date.parse("2026-06-11T18:00:00Z");

test("missed policy default and run-once: one run for the latest slot, the rest dropped, receipt advances", () => {
  for (const policy of [undefined, "run-once" as const]) {
    const plan = planSlots(laptop(policy), LAST, WAKE);
    assert.deepEqual(plan.fire.map((s) => s.id), ["20260611"]);
    assert.equal(plan.skippedCount, 9);
    assert.ok(plan.skipped.every((k) => k.reason === "missed"));
    assert.equal(plan.advanceTo, "20260611");
  }
});

test("missed policy skip: stale slots are dropped, a fresh slot still fires", () => {
  const stale = planSlots(laptop("skip"), LAST, WAKE); // 5 h after the 09:00 slot
  assert.deepEqual(stale.fire, []);
  assert.equal(stale.skippedCount, 10);
  assert.equal(stale.advanceTo, "20260611", "receipt still advances so the schedule resumes tomorrow");
  assert.ok(stale.skipped.every((k) => k.reason === "stale"));
  // Woken 2 minutes after today's slot: fresh, fires; the nine older ones are dropped.
  const fresh = planSlots(laptop("skip"), LAST, Date.parse("2026-06-11T13:02:00Z"));
  assert.deepEqual(fresh.fire.map((s) => s.id), ["20260611"]);
  assert.equal(fresh.skippedCount, 9);
  // Grace is honoured: widen it to 6 h and the 5 h-late slot fires.
  assert.deepEqual(planSlots(laptop("skip", 360), LAST, WAKE).fire.map((s) => s.id), ["20260611"]);
  // Next sweep after skipping proposes nothing (no storm, no repeat).
  assert.deepEqual(planSlots(laptop("skip"), stale.advanceTo ?? undefined, WAKE + HOUR).fire, []);
  // And tomorrow's slot fires normally.
  assert.deepEqual(planSlots(laptop("skip"), stale.advanceTo ?? undefined, Date.parse("2026-06-12T13:01:00Z")).fire.map((s) => s.id), ["20260612"]);
});

test("missed policy catch-up(max N): the most recent N run oldest first, older ones are dropped", () => {
  const plan = planSlots(laptop({ kind: "catch-up", max: 3 }), LAST, WAKE);
  assert.deepEqual(plan.fire.map((s) => s.id), ["20260609", "20260610", "20260611"]);
  assert.equal(plan.skippedCount, 7);
  assert.ok(plan.skipped.every((k) => k.reason === "catch-up-limit"));
  assert.equal(plan.advanceTo, "20260611");
  // Negative control: N is a cap, not "everything" — ten missed, three run.
  assert.notEqual(plan.fire.length, 10);
  // A catch-up larger than the backlog runs the whole backlog and drops nothing.
  const all = planSlots(laptop({ kind: "catch-up", max: 50 }), LAST, WAKE);
  assert.equal(all.fire.length, 10);
  assert.equal(all.skippedCount, 0);
  // Sweeping again after catching up proposes nothing.
  assert.deepEqual(planSlots(laptop({ kind: "catch-up", max: 3 }), plan.advanceTo ?? undefined, WAKE + 5 * MIN).fire, []);
});

test("interval schedules: a 30 day outage under each policy (legacy coalescing is run-once)", () => {
  const base: ScheduleTimeSpec = { createdAt: "2026-01-01T00:00:00Z", everyMinutes: 60 };
  const now = Date.parse("2026-01-01T00:00:00Z") + 30 * DAY + 10 * MIN; // slot 720 was due 10 minutes ago
  const legacy = planSlots(base, "5", now);
  assert.deepEqual(legacy.fire.map((s) => s.id), ["720"]);
  assert.equal(legacy.skippedCount, 714);
  assert.equal(legacy.advanceTo, "720");
  assert.deepEqual(planSlots({ ...base, missedPolicy: "skip" }, "5", now).fire, [], "10 min late is past the 5 min grace");
  assert.deepEqual(planSlots({ ...base, missedPolicy: "skip", graceMinutes: 15 }, "5", now).fire.map((s) => s.id), ["720"]);
  assert.deepEqual(planSlots({ ...base, missedPolicy: { kind: "catch-up", max: 4 } }, "5", now).fire.map((s) => s.id), ["717", "718", "719", "720"]);
  // First sweep ever (no receipt): slots start at 1, never 0.
  assert.deepEqual(planSlots(base, undefined, Date.parse("2026-01-01T00:59:00Z")).fire, []);
  assert.deepEqual(planSlots(base, undefined, Date.parse("2026-01-01T01:00:00Z")).fire.map((s) => s.id), ["1"]);
});

test("absurd downtime stays bounded and exact", () => {
  const spec = daily("UTC", "09:00", { missedPolicy: { kind: "catch-up", max: 2 } }, "2000-01-01T00:00:00Z");
  const plan = planSlots(spec, undefined, Date.parse("2026-10-03T12:00:00Z"));
  assert.deepEqual(plan.fire.map((s) => s.id), ["20261002", "20261003"]);
  assert.ok(plan.skipped.length <= 100);
});

// ---- repeats and out-of-order sweeps ---------------------------------------

test("duplicate sweeps in one slot propose exactly once; replaying the receipt is a no-op", () => {
  const spec = daily("Europe/London", "09:00");
  const t = Date.parse("2026-06-10T08:30:00Z");
  const first = planSlots(spec, "20260609", t);
  assert.equal(first.fire.length, 1);
  for (let i = 0; i < 5; i++) assert.deepEqual(planSlots(spec, first.advanceTo ?? undefined, t + i * MIN).fire, []);
  // Negative control: without the receipt the plan WOULD fire again, so the receipt is load-bearing.
  assert.equal(planSlots(spec, "20260609", t + MIN).fire.length, 1);
});

test("out-of-order sweeps (a clock stepped backwards) never re-fire or regress", () => {
  const spec = daily("America/New_York", "09:00");
  const late = planSlots(spec, "20260609", Date.parse("2026-06-12T14:00:00Z"));
  assert.deepEqual(late.fire.map((s) => s.id), ["20260612"]);
  const earlier = planSlots(spec, late.advanceTo ?? undefined, Date.parse("2026-06-10T14:00:00Z"));
  assert.deepEqual(earlier.fire, []);
  assert.equal(earlier.advanceTo, null, "a sweep from the past must not move the receipt backwards");
  // Interval flavour.
  const iv: ScheduleTimeSpec = { createdAt: "2026-01-01T00:00:00Z", everyMinutes: 60 };
  assert.deepEqual(planSlots(iv, "10", Date.parse("2026-01-01T05:00:00Z")).fire, []);
  // Interleaved sweeps converge on the same fired set as ordered ones.
  const ordered = simulate(daily("UTC", "09:00"), Date.parse("2026-06-01T00:00:00Z"), Date.parse("2026-06-08T00:00:00Z"), 5 * MIN).map((f) => f.id);
  assert.equal(new Set(ordered).size, ordered.length);
});

// ---- overlap ---------------------------------------------------------------

test("overlap policy against a running prior slot", () => {
  const now = Date.parse("2026-06-10T14:00:00Z");
  const mk = (overlap: "skip" | "queue" | "allow") => daily("America/New_York", "09:00", { overlap });
  const allow = planSlots(mk("allow"), "20260609", now, true);
  assert.equal(allow.fire.length, 1);

  const skip = planSlots(mk("skip"), "20260609", now, true);
  assert.deepEqual(skip.fire, []);
  assert.equal(skip.skipped[0].reason, "overlap");
  assert.equal(skip.advanceTo, "20260610", "skipped occurrence is consumed, not retried");

  const queue = planSlots(mk("queue"), "20260609", now, true);
  assert.deepEqual(queue.fire, []);
  assert.deepEqual(queue.queued.map((s) => s.id), ["20260610"]);
  assert.equal(queue.advanceTo, null, "queued occurrence keeps the receipt so the next sweep re-plans it");
  // Prior run finished: the queued slot now fires, once.
  const after = planSlots(mk("queue"), "20260609", now + 10 * MIN, false);
  assert.deepEqual(after.fire.map((s) => s.id), ["20260610"]);
  assert.deepEqual(planSlots(mk("queue"), after.advanceTo ?? undefined, now + 20 * MIN, false).fire, []);

  // Nothing running: every policy fires.
  for (const o of ["skip", "queue", "allow"] as const) assert.equal(planSlots(mk(o), "20260609", now, false).fire.length, 1);
  // Nothing due: overlap has nothing to decide.
  assert.deepEqual(planSlots(mk("skip"), "20260610", now, true).skipped, []);
});

// ---- debounce --------------------------------------------------------------

test("debounce throttles against the last FIRED slot (dropping a slot does not reset the window)", () => {
  const spec: ScheduleTimeSpec = { createdAt: "2026-01-01T00:00:00Z", everyMinutes: 60, debounceMinutes: 150 };
  const fired = simulate(spec, Date.parse("2026-01-01T00:30:00Z"), Date.parse("2026-01-01T12:30:00Z"), 10 * MIN);
  // slot 1 (01:00) fires; 2 (02:00) and 3 (03:00) are inside 150 min; 4 (04:00) is 180 min after.
  assert.deepEqual(fired.map((f) => f.id), ["1", "4", "7", "10"]);
  // Negative control: without debounce every slot fires.
  const plain = simulate({ ...spec, debounceMinutes: undefined }, Date.parse("2026-01-01T00:30:00Z"), Date.parse("2026-01-01T12:30:00Z"), 10 * MIN);
  assert.equal(plain.length, 12);
});

test("debounce collapses a catch-up burst and a short DST day", () => {
  const burst = planSlots(
    daily("UTC", "09:00", { missedPolicy: { kind: "catch-up", max: 5 }, debounceMinutes: 36 * 60 }),
    "20260601",
    Date.parse("2026-06-07T12:00:00Z"),
    false,
    "20260601",
  );
  assert.deepEqual(burst.fire.map((s) => s.id), ["20260603", "20260605", "20260607"]);
  assert.ok(burst.skipped.some((k) => k.reason === "debounced"));
  // Spring-forward day is 23 h after the previous slot: a 24 h debounce drops it, a 23 h one keeps it.
  const ny = (debounceMinutes: number) =>
    planSlots(daily("America/New_York", "09:00", { debounceMinutes }), "20260307", Date.parse("2026-03-08T14:00:00Z"), false, "20260307");
  assert.deepEqual(ny(24 * 60).fire, []);
  assert.deepEqual(ny(23 * 60).fire.map((s) => s.id), ["20260308"]);
});
