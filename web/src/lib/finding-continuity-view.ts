/**
 * The run page's finding-continuity block (S09, advisory). A read-time
 * projection of the `continuity` field the `scan-findings` step recorded when
 * the run was made with SHIP_FINDING_CONTINUITY=on. No step is added and
 * nothing is recomputed: a run made without the flag has no field and projects
 * to undefined, so its page is unchanged.
 *
 * Shape-checked field by field, because this is JSON out of an event log and
 * a log written by another build is a normal thing to be reading. Advisory
 * text only; nothing here feeds approval or merge.
 */
export interface ContinuityLogEvent {
  type: string;
  name?: string;
  data?: unknown;
}

export function findingContinuityLines(events: readonly ContinuityLogEvent[]): string[] | undefined {
  const step = events.find((e) => e.type === "step-completed" && e.name === "scan-findings");
  const advisory = (step?.data as { result?: { continuity?: { advisory?: unknown } } } | undefined)?.result?.continuity?.advisory;
  if (!Array.isArray(advisory)) return undefined;
  const lines = advisory.filter((l): l is string => typeof l === "string" && l !== "").map((l) => l.slice(0, 500)).slice(0, 60);
  return lines.length > 0 ? lines : undefined;
}
