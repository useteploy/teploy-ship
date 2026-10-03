/**
 * S16: pure schedule arithmetic. Given a schedule spec, the last slot a sweep
 * recorded and `now`, say which slots are due, which are deliberately
 * dropped, and what the receipt should advance to. No I/O, no clock reads,
 * no dependency beyond Intl — so every DST/downtime rule below is a fact a
 * test can pin, and the sweep in workflow-schedules.ts stays a thin caller.
 *
 * Two spec shapes, one slot-id contract (a decimal string that is monotonic
 * per schedule, so receipts compare as integers and the digest's
 * `workflow:<id>:<digits>` dedupe-key shape keeps parsing):
 *  - interval: slot n is createdAt + n*everyMinutes, id "n" (unchanged from
 *    the original scheduleSlot; n >= 1).
 *  - at: one slot per LOCAL calendar day (optionally filtered to weekdays) at
 *    HH:MM in an IANA zone, id = the local date as YYYYMMDD. Keying by local
 *    date rather than by instant is what makes DST "exactly once": the
 *    repeated 01:30 of a fall-back night is the same date, so it is one slot;
 *    the nonexistent 02:30 of a spring-forward day is still that date's slot.
 *
 * Wall-clock resolution follows the "compatible" rule used by Temporal and
 * most cron implementations: an ambiguous local time (fall back) resolves to
 * its EARLIER instant; a nonexistent one (spring forward) resolves by
 * applying the pre-transition offset, i.e. it fires at the same elapsed
 * moment the wall clock would have reached (02:30 -> 03:30 in New York).
 */

export type Weekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";
export const WEEKDAYS: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export interface AtSpec {
  /** IANA zone, e.g. "America/New_York". Validated, never defaulted. */
  timezone: string;
  /** Local wall-clock time, 24h "HH:MM". */
  time: string;
  /** Local weekdays the slot applies to; omitted means every day. */
  days?: Weekday[];
}

/** What to do with slots that came due while nothing was sweeping. */
export type MissedPolicy =
  /** Drop slots older than the grace window; fire only a slot that is fresh. */
  | "skip"
  /** Coalesce every missed slot into one run for the most recent (legacy behaviour). */
  | "run-once"
  /** Run the most recent `max` missed slots, oldest first; older ones are dropped. */
  | { kind: "catch-up"; max: number };

/** What to do when a prior occurrence of the same schedule is still running. */
export type OverlapPolicy = "skip" | "queue" | "allow";

export interface ScheduleTimeSpec {
  createdAt: string;
  everyMinutes?: number;
  at?: AtSpec;
  missedPolicy?: MissedPolicy;
  overlap?: OverlapPolicy;
  /**
   * Throttle: drop a slot that follows the last slot that actually FIRED by
   * less than this. Collapses repeats (catch-up bursts, a short DST day) and
   * can thin a fast interval (every 60 min, debounce 150 -> every 3rd slot).
   */
  debounceMinutes?: number;
  /** Freshness window for missedPolicy "skip". Default 5. */
  graceMinutes?: number;
}

export const DEFAULT_GRACE_MINUTES = 5;
/** Local days scanned back from `now` at most; bounds work after absurd downtime. */
export const MAX_SCAN_DAYS = 3660;
/** Interval slots listed individually in `skipped`; `skippedCount` is exact. */
const SKIPPED_LIST_CAP = 100;

export interface Slot {
  id: string;
  /** Epoch ms the slot is due. */
  at: number;
}

export type SkipReason = "missed" | "stale" | "catch-up-limit" | "debounced" | "overlap";

export interface SchedulePlan {
  /** Slots to propose now, oldest first. */
  fire: Slot[];
  /** Slots held for the next sweep because overlap is "queue" and one is running. */
  queued: Slot[];
  skipped: { slot: Slot; reason: SkipReason }[];
  /** Exact number dropped (skipped may be capped for interval schedules). */
  skippedCount: number;
  /** Receipt to write after proposing, or null to leave it as it is. */
  advanceTo: string | null;
}

const empty = (): SchedulePlan => ({ fire: [], queued: [], skipped: [], skippedCount: 0, advanceTo: null });

// ---- timezone arithmetic (Intl only) ---------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

/** A zone name Intl accepts that also looks like an IANA id (Area/Location or UTC). */
export function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  if (tz !== "UTC" && !/^[A-Za-z]+(\/[A-Za-z0-9_+-]+)+$/.test(tz)) return false;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

/** Zone offset from UTC at an instant, in ms (local wall time minus UTC). */
export function offsetAt(tz: string, instant: number): number {
  const p: Record<string, number> = {};
  for (const part of formatterFor(tz).formatToParts(new Date(instant))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

const DAY = 86400000;

/** The instant a local wall time (y, m 1-12, d, h, min) occurs in `tz`; see header for DST rules. */
export function resolveLocal(tz: string, y: number, m: number, d: number, h: number, min: number): number {
  const wall = Date.UTC(y, m - 1, d, h, min);
  const before = offsetAt(tz, wall - DAY);
  const after = offsetAt(tz, wall + DAY);
  const valid = [...new Set([before, after])]
    .map((o) => wall - o)
    .filter((c) => offsetAt(tz, c) === wall - c)
    .sort((a, b) => a - b);
  if (valid.length > 0) return valid[0]; // two = fall back: earlier occurrence
  return wall - before; // none = spring forward: pre-transition offset
}

const parseTime = (t: string): [number, number] | null => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

/** Local calendar date of an instant in `tz`. */
function localDate(tz: string, instant: number): { y: number; m: number; d: number } {
  const w = new Date(instant + offsetAt(tz, instant));
  return { y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate() };
}

const dateId = (y: number, m: number, d: number) => y * 10000 + m * 100 + d;
const idToDate = (id: number) => ({ y: Math.floor(id / 10000), m: Math.floor(id / 100) % 100, d: id % 100 });

/** Why a spec is unusable, or null. The sweep's validator delegates here. */
export function specProblem(s: ScheduleTimeSpec): string | null {
  if (!Number.isFinite(Date.parse(s.createdAt))) return "createdAt is not a date";
  if (s.at !== undefined) {
    const at = s.at as Partial<AtSpec> | null;
    if (at === null || typeof at !== "object") return "at must be an object";
    if (!validTimezone(at.timezone)) return `unknown timezone ${JSON.stringify(at.timezone)}`;
    if (typeof at.time !== "string" || parseTime(at.time) === null) return "at.time must be HH:MM (24h)";
    if (at.days !== undefined) {
      if (!Array.isArray(at.days) || at.days.length === 0 || at.days.length > 7) return "at.days must be 1-7 weekdays";
      if (!at.days.every((d) => WEEKDAYS.includes(d)) || new Set(at.days).size !== at.days.length) {
        return "at.days has an unknown or repeated weekday";
      }
    }
  } else if (s.everyMinutes === undefined || !Number.isInteger(s.everyMinutes) || s.everyMinutes < 1) {
    return "an interval schedule needs everyMinutes";
  }
  const mp = s.missedPolicy;
  if (mp !== undefined && mp !== "skip" && mp !== "run-once") {
    if (!mp || typeof mp !== "object" || mp.kind !== "catch-up" || !Number.isInteger(mp.max) || mp.max < 1 || mp.max > 100) {
      return "missedPolicy must be skip, run-once or {kind:catch-up,max:1-100}";
    }
  }
  if (s.overlap !== undefined && !["skip", "queue", "allow"].includes(s.overlap)) return "overlap must be skip, queue or allow";
  if (s.debounceMinutes !== undefined) {
    const d = s.debounceMinutes;
    if (!Number.isInteger(d) || d < 1 || d > 44640) return "debounceMinutes must be an integer 1-44640";
  }
  if (s.graceMinutes !== undefined && (!Number.isInteger(s.graceMinutes) || s.graceMinutes < 0 || s.graceMinutes > 1440)) {
    return "graceMinutes must be an integer 0-1440";
  }
  return null;
}

// ---- slots -------------------------------------------------------------------

/** The instant a slot id is due under `spec`, or null if the id is not one of its slots. */
export function slotInstant(spec: ScheduleTimeSpec, id: string): number | null {
  if (!/^\d{1,9}$/.test(id)) return null;
  const n = Number(id);
  if (spec.at) {
    const { y, m, d } = idToDate(n);
    const t = parseTime(spec.at.time);
    if (!t || m < 1 || m > 12 || d < 1 || d > 31) return null;
    return resolveLocal(spec.at.timezone, y, m, d, t[0], t[1]);
  }
  return Date.parse(spec.createdAt) + n * (spec.everyMinutes as number) * 60000;
}

/** Slots due in (receipt, now], oldest first, for an `at` spec. */
function atSlots(spec: ScheduleTimeSpec & { at: AtSpec }, afterId: number | null, now: number): Slot[] {
  const { timezone: tz, days } = spec.at;
  const [h, min] = parseTime(spec.at.time) as [number, number];
  const created = Date.parse(spec.createdAt);
  const today = localDate(tz, now);
  const todayId = dateId(today.y, today.m, today.d);
  const startFrom = afterId !== null ? idToDate(afterId) : localDate(tz, created);
  const out: Slot[] = [];
  let cursor = Date.UTC(startFrom.y, startFrom.m - 1, startFrom.d);
  const limit = Date.UTC(today.y, today.m - 1, today.d) - MAX_SCAN_DAYS * DAY;
  if (cursor < limit) cursor = limit;
  for (; ; cursor += DAY) {
    const c = new Date(cursor);
    const y = c.getUTCFullYear();
    const m = c.getUTCMonth() + 1;
    const d = c.getUTCDate();
    const id = dateId(y, m, d);
    if (id > todayId) break;
    if (afterId !== null && id <= afterId) continue;
    if (days && !days.includes(WEEKDAYS[c.getUTCDay()])) continue;
    const at = resolveLocal(tz, y, m, d, h, min);
    if (at > now) break;
    if (at <= created) continue;
    out.push({ id: String(id), at });
  }
  return out;
}

/** Interval slots due in (afterN, now]; only the last `keep` are materialised. */
function intervalSlots(spec: ScheduleTimeSpec, afterN: number, now: number, keep: number): { slots: Slot[]; total: number } {
  const period = (spec.everyMinutes as number) * 60000;
  const created = Date.parse(spec.createdAt);
  const current = Math.floor((now - created) / period);
  const first = Math.max(afterN + 1, 1);
  if (current < first) return { slots: [], total: 0 };
  const total = current - first + 1;
  const slots: Slot[] = [];
  for (let n = Math.max(first, current - keep + 1); n <= current; n++) slots.push({ id: String(n), at: created + n * period });
  return { slots, total };
}

/**
 * Decide what a sweep at `now` does. `lastSlot` is the receipt (slot id of the
 * last slot already handled, fired OR deliberately dropped), `lastFired` the
 * last slot that actually fired (debounce needs it; they differ once a slot
 * has been dropped), `running` says whether a prior occurrence is still
 * executing. Pure and idempotent: a
 * second call with the receipt this plan advanced to returns an empty plan.
 * An invalid spec yields an empty plan, never a throw — the sweep must not
 * die on one bad stored schedule.
 */
export function planSlots(
  spec: ScheduleTimeSpec,
  lastSlot: string | undefined,
  now: number,
  running = false,
  lastFired?: string,
): SchedulePlan {
  if (specProblem(spec) !== null) return empty();
  const after = lastSlot !== undefined && /^\d{1,9}$/.test(lastSlot) ? Number(lastSlot) : null;
  const policy = spec.missedPolicy ?? "run-once";
  const keep = typeof policy === "string" ? 1 + SKIPPED_LIST_CAP : policy.max + SKIPPED_LIST_CAP;

  let due: Slot[];
  let total: number;
  if (spec.at) {
    due = atSlots(spec as ScheduleTimeSpec & { at: AtSpec }, after, now);
    total = due.length;
  } else {
    ({ slots: due, total } = intervalSlots(spec, after ?? 0, now, keep));
  }
  if (total === 0) return empty();
  const advanceTo = due[due.length - 1].id;
  const plan = empty();
  const drop = (slot: Slot, reason: SkipReason) => {
    if (plan.skipped.length < SKIPPED_LIST_CAP) plan.skipped.push({ slot, reason });
  };

  // 1. Missed-slot policy: choose candidates among the due slots.
  let candidates: Slot[];
  const latest = due[due.length - 1];
  if (policy === "run-once") {
    candidates = [latest];
  } else if (policy === "skip") {
    const grace = (spec.graceMinutes ?? DEFAULT_GRACE_MINUTES) * 60000;
    candidates = now - latest.at <= grace ? [latest] : [];
  } else {
    candidates = due.slice(-policy.max);
  }
  for (const s of due) {
    if (candidates.includes(s)) continue;
    drop(s, policy === "skip" ? "stale" : policy === "run-once" ? "missed" : "catch-up-limit");
  }

  // 2. Debounce against the last fired slot and between candidates.
  if (spec.debounceMinutes !== undefined) {
    const window = spec.debounceMinutes * 60000;
    let prev = lastFired !== undefined ? slotInstant(spec, lastFired) : null;
    const kept: Slot[] = [];
    for (const s of candidates) {
      if (prev !== null && s.at - prev < window) {
        drop(s, "debounced");
        continue;
      }
      kept.push(s);
      prev = s.at;
    }
    candidates = kept;
  }
  plan.skippedCount = total - candidates.length;

  // 3. Overlap against a still-running prior occurrence.
  const overlap = spec.overlap ?? "allow";
  if (running && candidates.length > 0 && overlap !== "allow") {
    if (overlap === "queue") {
      // Hold everything: the receipt stays put so the next sweep re-plans these.
      plan.queued = candidates;
      plan.skippedCount = 0;
      plan.skipped = [];
      return plan;
    }
    for (const s of candidates) drop(s, "overlap");
    plan.skippedCount += candidates.length;
    candidates = [];
  }
  plan.fire = candidates;
  plan.advanceTo = advanceTo;
  return plan;
}
