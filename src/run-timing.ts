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
 *  - A quantity that cannot be established is `null`, never 0. "No telemetry"
 *    and "zero time" are different facts; a run with no timestamps reports
 *    `telemetry: "missing"`, not a fast run.
 *  - An unresolved wait is reported as open (`resolved: false`, `waitedMs:
 *    null`) rather than being measured against the wall clock, so the result is
 *    deterministic for a given log.
 */
import type { WorkflowEvent } from "@neutron-build/workflow";

export interface RunWait {
  kind: "event" | "sleep";
  name: string;
  /** Elapsed from the wait starting to it being satisfied; null while open. */
  waitedMs: number | null;
  resolved: boolean;
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
  waits: RunWait[];
  /** Human-readable reasons a figure is null, so a gap is never silent. */
  unknown: string[];
}

function ms(at: string | undefined): number | null {
  if (typeof at !== "string") return null;
  const t = Date.parse(at);
  return Number.isFinite(t) ? t : null;
}

export function runTiming(events: readonly WorkflowEvent[]): RunTiming {
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
    waits,
    unknown,
  };
}
