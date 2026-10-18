/**
 * S28 — where a run's wall-clock time went, derived from its event log.
 *
 * Capacity measurements used to split queue wait / execution / human wait by
 * hand (docs/capacity.md). This is that arithmetic as a pure function over
 * the events Ship already stores, so it needs no migration and can be pinned.
 *
 * Honesty rules:
 *  - `at` is the APPEND time of an event, informational in the wire format.
 *    The log has no "claimed by a worker" event, so the time to the first step
 *    is queue wait PLUS the first step's own duration. It is named for what it
 *    measures and is an upper bound on queue wait, never presented as exact.
 *    A worker's claim time (run META, outside this log — recordClaim in
 *    worker.ts) can be handed in as `claimedAt`, which splits exactly that
 *    boundary: admission becomes the measured enqueue-to-pickup gap and the
 *    first phase starts at the claim instead of at the run's start.
 *  - A quantity that cannot be established is `null`, never 0. "No telemetry"
 *    and "zero time" are different facts; a run with no timestamps reports
 *    `telemetry: "missing"`, not a fast run.
 *  - An unresolved wait is reported as open (`resolved: false`, `waitedMs:
 *    null`) rather than being measured against the wall clock, so the result is
 *    deterministic for a given log.
 *  - Phase durations are gaps between the `at` of consecutive events, because
 *    the wire format records no `step-started` (events.d.ts): a step is
 *    charged from whatever was appended before it, idle included, so every
 *    phase figure is an upper bound on its steps' own cost. Without a claim
 *    time the first phase's gap still contains the queue wait, which is why
 *    `admission` and the first phase overlap there — stated, not hidden.
 *  - TTFT is a proxy, not a measurement: native generation is not streamed
 *    into the log, so the model call is indistinguishable from the rest of the
 *    think step that contains it.
 *  - TTFE is the first RECORDED evidence of an edit — a turn fingerprint
 *    whose tree is dirty, which lands at or after the edit itself. A run with
 *    no edit (a scan, a clean tree, a run that never fingerprinted) reports
 *    `null` with `ttfeWhy` naming which, never 0.
 */
import type { WorkflowEvent } from "@neutron-build/workflow";

import { PLAN_EVENT } from "./plan.js";

export interface RunWait {
  kind: "event" | "sleep";
  name: string;
  /** Elapsed from the wait starting to it being satisfied; null while open. */
  waitedMs: number | null;
  resolved: boolean;
}

/**
 * The phases a run's time is split into, keyed by step-name family (the names
 * `ctx.step` is called with in durable.ts). A stable vocabulary: the audit JSON
 * export carries these keys, so renaming one is a breaking change for every
 * consumer of that export.
 */
export type PhaseKey =
  | "admission" // run-started -> worker claim (or first step, see header)
  | "sandbox-create" // the `sandbox` step
  | "clone" // `repo-setup`: warm reuse or cold clone
  | "environment" // `environment-prepare` / `environment-check`
  | "context" // `repo-context`
  | "index" // `repo-index`
  | "baseline" // `baseline-*`: dependency install plus the baseline suite
  | "warm-cache" // `warm-cache`
  | "plan-park" // the plan-approval wait, plus the snapshot/restore only a park needs
  | "model-think" // `plan-think` / `turn-N-think`
  | "model-exec" // `turn-N-exec`
  | "publish"; // `repo-push` / `repo-pr` / `merge-park` / `publish-on-failure`

export interface PhaseTiming {
  phase: PhaseKey;
  /**
   * Sum of the gaps attributed to this phase. Null when a boundary lacks a
   * usable timestamp (the reason sits in `unknown`) or, for `plan-park`,
   * while the approval wait is still open. An upper bound, like every gap.
   */
  durationMs: number | null;
  /**
   * The step names that fed the phase, in log order; `plan-park` names the
   * event it waited on. A phase ABSENT from `phases` did not run (a cold run
   * has no `warm-cache` entry) — a different fact from a phase that ran but
   * cannot be timed.
   */
  steps: string[];
}

export interface RunTiming {
  /** "missing": no event carried a usable timestamp; every figure is null. */
  telemetry: "complete" | "partial" | "missing";
  /** How the log ended, as recorded. "open" means no terminal event yet. */
  terminal: "completed" | "failed" | "cancelled" | "open";
  /** run-started -> first completed step. Upper bound on queue wait (see header). */
  toFirstStepMs: number | null;
  /** run-started -> terminal event; null while the run is open. */
  elapsedMs: number | null;
  /** Sum of RESOLVED approval/event waits. Open waits are not included. */
  waitingOnPeopleMs: number | null;
  /** Sum of resolved sleeps (timers). */
  waitingOnTimersMs: number | null;
  /** elapsed minus resolved waits; null when elapsed or any wait is unknown. */
  activeMs: number | null;
  /**
   * Time to first token: run-started -> the first `plan-think`/`turn-N-think`
   * step-completed. Upper bound (see header). Null with `ttftWhy` when the
   * log holds no think step or its timestamp is unusable — never 0.
   */
  ttftMs: number | null;
  /** Why `ttftMs` is null, so the gap is never silent. Null when ttftMs is set. */
  ttftWhy: string | null;
  /**
   * Time to first edit: run-started -> the first `turn-N-fingerprint` whose
   * recorded tree is dirty. Null with `ttfeWhy` when the run made no edit or
   * recorded no fingerprint — never 0.
   */
  ttfeMs: number | null;
  /** Why `ttfeMs` is null. Null when ttfeMs is set. */
  ttfeWhy: string | null;
  /** Per-phase durations, first-seen order, `admission` first. */
  phases: PhaseTiming[];
  waits: RunWait[];
  /** Human-readable reasons a figure is null, so a gap is never silent. */
  unknown: string[];
}


function ms(at: string | null | undefined): number | null {
  if (typeof at !== "string") return null;
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

/**
 * Steps may carry an attempt prefix (`attempt-1-sandbox`, P6-1): the prefix
 * says which execution produced the step, not which phase it belongs to, so
 * every matcher tolerates one and both spellings fold into the same family.
 */
const ATTEMPT = "(?:attempt-\\d+-)?";
const PHASE_OF_STEP: ReadonlyArray<readonly [PhaseKey, RegExp]> = [
  ["sandbox-create", new RegExp(`^${ATTEMPT}sandbox$`)],
  ["clone", new RegExp(`^${ATTEMPT}repo-setup$`)],
  ["environment", new RegExp(`^${ATTEMPT}environment-(?:prepare|check)$`)],
  ["context", new RegExp(`^${ATTEMPT}repo-context$`)],
  ["index", new RegExp(`^${ATTEMPT}repo-index$`)],
  ["baseline", new RegExp(`^${ATTEMPT}baseline-`)],
  ["warm-cache", new RegExp(`^${ATTEMPT}warm-cache$`)],
  ["model-think", new RegExp(`^${ATTEMPT}(?:plan-think|turn-\\d+-think)$`)],
  ["model-exec", new RegExp(`^${ATTEMPT}turn-\\d+-exec$`)],
  ["publish", new RegExp(`^${ATTEMPT}(?:repo-push|repo-pr|merge-park|publish-on-failure)$`)],
  // The park's own mechanics: charged to `plan-park` alongside the wait,
  // because a run without a park never records them.
  ["plan-park", new RegExp(`^${ATTEMPT}(?:plan-snapshot|plan-restore)$`)],
];

function phaseOfStep(name: string): PhaseKey | undefined {
  return PHASE_OF_STEP.find(([, re]) => re.test(name))?.[0];
}

const THINK_STEP = /^(?:attempt-\d+-)?(?:plan-think|turn-\d+-think)$/;
const FINGERPRINT_STEP = /^(?:attempt-\d+-)?turn-\d+-fingerprint$/;

/** A fingerprint step records `{hash, dirty} | null`; only `dirty` is read here. */
function isDirtyFingerprint(e: WorkflowEvent): boolean {
  if (typeof e.data !== "object" || e.data === null) return false;
  const result = (e.data as { result?: unknown }).result;
  return typeof result === "object" && result !== null && (result as { dirty?: unknown }).dirty === true;
}

/**
 * Derive a run's timing from its event log. `options.claimedAt` is the worker
 * claim time from run meta (worker.ts recordClaim) — meta, not a log event,
 * which is why replay is untouched by it. It is honoured only when it falls
 * inside the run's own window (after run-started, at or before the first
 * completed step): a value outside that window is metadata about a later
 * pass, and splitting on it would report queue wait that is really park time.
 */
export function runTiming(events: readonly WorkflowEvent[], options?: { claimedAt?: string | null }): RunTiming {
  const unknown: string[] = [];
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const stamped = ordered.filter((e) => ms(e.at) !== null).length;

  const empty = (): RunTiming => ({
    telemetry: "missing",
    terminal: "open",
    toFirstStepMs: null,
    elapsedMs: null,
    waitingOnPeopleMs: null,
    waitingOnTimersMs: null,
    activeMs: null,
    ttftMs: null,
    ttftWhy: "no event carries a usable timestamp",
    ttfeMs: null,
    ttfeWhy: "no event carries a usable timestamp",
    phases: [],
    waits: [],
    unknown: ["no event carries a usable timestamp"],
  });
  if (stamped === 0) return empty();

  const started = ordered.find((e) => e.type === "run-started");
  const startMs = ms(started?.at);
  if (started === undefined) unknown.push("no run-started event");
  else if (startMs === null) unknown.push("run-started has no usable timestamp");

  const terminalEvent = ordered.find(
    (e) => e.type === "run-completed" || e.type === "run-failed" || e.type === "run-cancelled",
  );
  const terminal: RunTiming["terminal"] =
    terminalEvent === undefined ? "open" : terminalEvent.type === "run-completed" ? "completed" : terminalEvent.type === "run-failed" ? "failed" : "cancelled";
  const endMs = ms(terminalEvent?.at);
  if (terminalEvent !== undefined && endMs === null) unknown.push("terminal event has no usable timestamp");

  const firstStep = ordered.find((e) => e.type === "step-completed");
  const firstStepMs = ms(firstStep?.at);
  let toFirstStepMs: number | null = null;
  if (firstStep === undefined) unknown.push("no completed step yet");
  else if (startMs !== null && firstStepMs !== null) toFirstStepMs = Math.max(0, firstStepMs - startMs);
  else unknown.push("first step has no usable timestamp");

  // Pair each wait with the event that satisfies it. Event deliveries are FIFO
  // per name and may arrive before the run reaches its wait (buffered), in
  // which case the wait costs nothing.
  const waits: RunWait[] = [];
  const openEvents = new Map<string, { at: number | null; wait: RunWait }[]>();
  const earlyEvents = new Map<string, number>();
  const openSleeps: { at: number | null; wait: RunWait }[] = [];
  for (const e of ordered) {
    const name = e.name ?? "";
    const at = ms(e.at);
    if (e.type === "event-waiting") {
      const wait: RunWait = { kind: "event", name, waitedMs: null, resolved: false };
      waits.push(wait);
      const early = earlyEvents.get(name) ?? 0;
      if (early > 0) {
        earlyEvents.set(name, early - 1);
        wait.waitedMs = 0;
        wait.resolved = true;
      } else {
        const list = openEvents.get(name) ?? [];
        list.push({ at, wait });
        openEvents.set(name, list);
      }
    } else if (e.type === "event-received") {
      const pending = openEvents.get(name)?.shift();
      if (pending === undefined) earlyEvents.set(name, (earlyEvents.get(name) ?? 0) + 1);
      else if (pending.at !== null && at !== null) {
        pending.wait.waitedMs = Math.max(0, at - pending.at);
        pending.wait.resolved = true;
      } else {
        // Satisfied, but the duration cannot be stated.
        pending.wait.resolved = true;
        unknown.push(`wait on "${name}" resolved without usable timestamps`);
      }
    } else if (e.type === "sleep-started") {
      const wait: RunWait = { kind: "sleep", name, waitedMs: null, resolved: false };
      waits.push(wait);
      openSleeps.push({ at, wait });
    } else if (e.type === "sleep-completed") {
      const pending = openSleeps.shift();
      if (pending !== undefined && pending.at !== null && at !== null) {
        pending.wait.waitedMs = Math.max(0, at - pending.at);
        pending.wait.resolved = true;
      } else if (pending !== undefined) {
        pending.wait.resolved = true;
        unknown.push(`sleep "${pending.wait.name}" resolved without usable timestamps`);
      }
    }
  }
  const openCount = waits.filter((w) => !w.resolved).length;
  if (openCount > 0) unknown.push(`${openCount} wait(s) still open; not included in totals`);

  // ---- Phases (D4-a) -----------------------------------------------------
  //
  // Gaps run between consecutive events' `at`, families come from the step
  // name (PHASE_OF_STEP). The claim time, when it is inside the run's window,
  // replaces the left boundary of the FIRST attributed gap — the one boundary
  // the log cannot draw itself, per the header's honesty rules.
  const claimMs = ms(options?.claimedAt);
  const claimInWindow =
    claimMs !== null && startMs !== null && claimMs >= startMs && firstStepMs !== null && claimMs <= firstStepMs;
  if (options?.claimedAt !== undefined && options.claimedAt !== null && !claimInWindow) {
    unknown.push("worker claim time present but outside the run's window; admission kept as an upper bound");
  }

  const firstSeen = new Map<PhaseKey, number>();
  const stepsOf = new Map<PhaseKey, string[]>();
  const gapsOf = new Map<PhaseKey, { sum: number; anyNull: boolean }>();
  const admitStep = (key: PhaseKey, name: string, gap: number | null, seq: number): void => {
    if (!firstSeen.has(key)) firstSeen.set(key, seq);
    if (!stepsOf.has(key)) stepsOf.set(key, []);
    stepsOf.get(key)!.push(name);
    const gaps = gapsOf.get(key) ?? { sum: 0, anyNull: false };
    if (gap === null) {
      gaps.anyNull = true;
      unknown.push(`phase "${key}" cannot time step "${name}": a boundary has no usable timestamp`);
    } else gaps.sum += gap;
    gapsOf.set(key, gaps);
  };

  let prevAt: number | null = null;
  let prevIsRunStart = false;
  for (const e of ordered) {
    const at = ms(e.at);
    if (e.type === "step-completed") {
      const key = phaseOfStep(e.name ?? "");
      if (key !== undefined) {
        // Only the gap that starts at the run's origin can be split by the
        // claim; anywhere else the previous event's `at` is the honest left
        // boundary (a `now` or `random` between steps is part of the record).
        const left = claimInWindow && prevIsRunStart ? claimMs : prevAt;
        admitStep(key, e.name ?? "", left === null || at === null ? null : Math.max(0, at - left), e.seq);
      }
    } else if (e.type === "event-waiting" && e.name === PLAN_EVENT) {
      // The wait names the phase; its duration comes from the pairing above,
      // not from a gap, so only the name is recorded here — in log order.
      if (!firstSeen.has("plan-park")) firstSeen.set("plan-park", e.seq);
      if (!stepsOf.has("plan-park")) stepsOf.set("plan-park", []);
      stepsOf.get("plan-park")!.push(PLAN_EVENT);
    }
    prevIsRunStart = e.type === "run-started";
    prevAt = at;
  }

  const phases: PhaseTiming[] = [];
  const admissionRight = claimInWindow ? claimMs : firstStepMs;
  const admission: PhaseTiming = { phase: "admission", durationMs: null, steps: [] };
  if (startMs !== null && admissionRight !== null) admission.durationMs = Math.max(0, admissionRight - startMs);
  // The reasons admission can be null are already stated by the existing
  // probes above (no run-started, unusable run-started, no completed step,
  // unusable first step) — the phase repeats the null, not the reason.
  phases.push(admission);

  for (const [key, seq] of [...firstSeen.entries()].sort((a, b) => a[1] - b[1])) {
    const gaps = gapsOf.get(key);
    let durationMs: number | null = null;
    if (key === "plan-park") {
      // The wait (paired above) plus the snapshot/restore mechanics only a
      // park records. An open wait, a wait resolved without usable timestamps
      // or an untimed park step leaves the phase null — never a partial sum.
      const resolved = waits.filter((w) => w.name === PLAN_EVENT && w.resolved);
      const waitMs =
        resolved.length === 0 || resolved.some((w) => w.waitedMs === null)
          ? null
          : resolved.reduce((sum, w) => sum + (w.waitedMs ?? 0), 0);
      const stepGaps = gaps === undefined ? 0 : gaps.anyNull ? null : gaps.sum;
      if (waitMs !== null && stepGaps !== null) durationMs = waitMs + stepGaps;
    } else if (gaps !== undefined && !gaps.anyNull) {
      durationMs = gaps.sum;
    }
    phases.push({ phase: key, durationMs, steps: stepsOf.get(key)! });
  }

  // ---- TTFT / TTFE (D4-a) ------------------------------------------------
  const thinkStep = ordered.find((e) => e.type === "step-completed" && THINK_STEP.test(e.name ?? ""));
  const thinkMs = ms(thinkStep?.at);
  let ttftMs: number | null = null;
  let ttftWhy: string | null = null;
  if (thinkStep === undefined) ttftWhy = "no think step (plan-think or turn-N-think) in the log";
  else if (startMs === null) ttftWhy = "run-started has no usable timestamp";
  else if (thinkMs === null) {
    ttftWhy = "first think step has no usable timestamp";
    unknown.push(ttftWhy);
  } else ttftMs = Math.max(0, thinkMs - startMs);

  const fingerprintSteps = ordered.filter((e) => e.type === "step-completed" && FINGERPRINT_STEP.test(e.name ?? ""));
  const dirty = fingerprintSteps.find((e) => isDirtyFingerprint(e));
  const dirtyMs = ms(dirty?.at);
  let ttfeMs: number | null = null;
  let ttfeWhy: string | null = null;
  if (fingerprintSteps.length === 0) ttfeWhy = "no turn fingerprint recorded; time to first edit is not derivable from this log";
  else if (dirty === undefined) ttfeWhy = "no edit: every recorded turn fingerprint reports a clean tree";
  else if (startMs === null) ttfeWhy = "run-started has no usable timestamp";
  else if (dirtyMs === null) {
    ttfeWhy = "first dirty fingerprint has no usable timestamp";
    unknown.push(ttfeWhy);
  } else ttfeMs = Math.max(0, dirtyMs - startMs);

  const total = (kind: RunWait["kind"]): number | null => {
    const relevant = waits.filter((w) => w.kind === kind && w.resolved);
    if (relevant.some((w) => w.waitedMs === null)) return null;
    return relevant.reduce((sum, w) => sum + (w.waitedMs ?? 0), 0);
  };
  const waitingOnPeopleMs = total("event");
  const waitingOnTimersMs = total("sleep");

  let elapsedMs: number | null = null;
  if (terminal !== "open" && startMs !== null && endMs !== null) elapsedMs = Math.max(0, endMs - startMs);
  else if (terminal === "open") unknown.push("run has no terminal event; elapsed time not established");

  let activeMs: number | null = null;
  if (elapsedMs !== null && openCount === 0 && waitingOnPeopleMs !== null && waitingOnTimersMs !== null) {
    activeMs = Math.max(0, elapsedMs - waitingOnPeopleMs - waitingOnTimersMs);
  } else if (elapsedMs !== null) {
    unknown.push("active time not established: a wait is open or lacks timestamps");
  }

  return {
    telemetry: unknown.length === 0 && stamped === ordered.length ? "complete" : "partial",
    terminal,
    toFirstStepMs,
    elapsedMs,
    waitingOnPeopleMs,
    waitingOnTimersMs,
    activeMs,
    ttftMs,
    ttftWhy,
    ttfeMs,
    ttfeWhy,
    phases,
    waits,
    unknown,
  };
}
