/**
 * What a run on this repository typically takes, from the runs before it.
 *
 * A person watching a run wants one number more than any other: is this
 * normal? The event log has every completed run's start and end; the repo
 * stats have which runs belonged to which repository. Median, not mean —
 * one run that parked for a weekend must not make every later run look
 * fast. Two samples minimum: a single prior run is an anecdote.
 */
export interface Typical {
  /** Median wall-clock of completed runs on the repo, in ms. */
  medianMs: number;
  /** How many completed runs the median is over. */
  n: number;
}

export interface TypicalSample {
  runId: string;
  status: string;
  /** The park a waiting run is on; a run held at the merge boundary has finished its work. */
  eventName?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Done, for the purpose of "how long does a run take": completed, or parked
 * at the merge boundary — the work is finished and the wait is a person's.
 * Without the second case a repo whose runs all sit as draft PRs awaiting a
 * merge call would never have an expectation at all.
 */
function finishedWork(r: TypicalSample): boolean {
  return r.status === "completed" || (r.status === "waiting" && r.eventName === "approve-merge");
}

export function typicalDuration(runs: TypicalSample[], sameRepo: ReadonlySet<string>, exclude?: string): Typical | null {
  const durations = runs
    .filter((r) => finishedWork(r) && r.runId !== exclude && sameRepo.has(r.runId))
    .map((r) => new Date(r.updatedAt).getTime() - new Date(r.createdAt).getTime())
    .filter((ms) => Number.isFinite(ms) && ms > 0)
    .sort((a, b) => a - b);
  if (durations.length < 2) return null;
  const mid = durations.length >> 1;
  const medianMs = durations.length % 2 === 1 ? durations[mid]! : Math.round((durations[mid - 1]! + durations[mid]!) / 2);
  return { medianMs, n: durations.length };
}

/** "4 min", "1 h 20 min", "2 d 3 h" — coarse on purpose; it is an expectation, not a measurement. */
export function roughDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (h < 24) return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr === 0 ? `${d} d` : `${d} d ${hr} h`;
}
