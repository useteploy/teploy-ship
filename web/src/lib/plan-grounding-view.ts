/**
 * The run page's plan-grounding block (S07, advisory). A read-time
 * projection of the `grounding` field the `plan-think` step recorded when the
 * run was made with SHIP_PLAN_GROUNDING=on. No step is added and nothing is
 * recomputed: a run made without the flag has no field and projects to
 * undefined, so its page is unchanged.
 *
 * The caveat is the point, not decoration: "grounded" means the name exists
 * in the committed tree at the stated revision — it does not mean the plan is
 * right, and a fully grounded plan can still be wrong. Advisory for the
 * reviewer, never a gate.
 */
export interface PlanGroundingLogEvent {
  type: string;
  name?: string;
  data?: unknown;
}

export interface PlanGroundingRefView {
  status: string;
  kind: string;
  name: string;
  detail: string;
}

export interface PlanGroundingView {
  /** Counts plus revision, one line. */
  headline: string;
  /** Set when the plan's expected revision did not match the tree; then nothing was checked. */
  mismatch?: string;
  /** Ungrounded first, grounded last; bounded. */
  refs: PlanGroundingRefView[];
  /** References past the listing cap (still counted in the headline). */
  omitted?: number;
  /** The honesty line from plan-grounding.ts, mirrored for the reviewer. */
  caveat: string;
}

export const PLAN_GROUNDING_CAVEAT =
  '"Grounded" only means the name exists in the committed tree at that revision — not that the plan is right. A plan can be fully grounded and wrong. This advisory never blocks the run and never edits the plan.';

const ORDER = ["ungrounded", "unchecked", "proposed", "grounded"];
const MAX_REFS = 60;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export function planGroundingView(events: readonly PlanGroundingLogEvent[]): PlanGroundingView | undefined {
  const step = events.find((e) => e.type === "step-completed" && e.name === "plan-think");
  const grounding = (step?.data as { result?: { grounding?: unknown } } | undefined)?.result?.grounding;
  if (typeof grounding !== "object" || grounding === null) return undefined;
  const g = grounding as Record<string, unknown>;
  if (typeof g.revision !== "string" || g.revision === "" || !Array.isArray(g.refs)) return undefined;
  const counts = (typeof g.counts === "object" && g.counts !== null ? g.counts : {}) as Record<string, unknown>;
  const c = { grounded: num(counts.grounded), ungrounded: num(counts.ungrounded), proposed: num(counts.proposed), unchecked: num(counts.unchecked) };
  const refs = g.refs
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .filter((r) => ["grounded", "ungrounded", "proposed", "unchecked"].includes(String(r.status)) && typeof r.name === "string" && (r.name as string) !== "")
    .map((r) => ({
      status: String(r.status),
      kind: typeof r.kind === "string" ? clip(r.kind, 20) : "",
      name: clip(String(r.name), 200),
      detail: typeof r.detail === "string" ? clip(r.detail, 300) : "",
    }));
  const ordered = ORDER.flatMap((s) => refs.filter((r) => r.status === s));
  const mm = g.revisionMismatch as { expected?: unknown; actual?: unknown } | undefined;
  return {
    headline: `${c.grounded} grounded, ${c.ungrounded} ungrounded, ${c.proposed} proposed, ${c.unchecked} unchecked at revision ${g.revision.slice(0, 12)} — advisory, name-existence only`,
    ...(typeof mm === "object" && mm !== null && typeof mm.expected === "string"
      ? { mismatch: `Revision mismatch: the plan is about ${clip(mm.expected, 64)}, the tree is at ${g.revision.slice(0, 12)}; no reference was checked.` }
      : {}),
    refs: ordered.slice(0, MAX_REFS),
    ...(ordered.length > MAX_REFS ? { omitted: ordered.length - MAX_REFS } : {}),
    caveat: PLAN_GROUNDING_CAVEAT,
  };
}
