/**
 * Plan-preview contract, dependency-free on purpose: the web dashboard
 * imports these through teploy-ship/runtime, and pulling durable.ts (the
 * whole agent machinery) into a browser bundle graph is neither needed
 * nor buildable.
 */

/** The event a plan-preview run parks on. Deliver a PlanDecisionPayload. */
export const PLAN_EVENT = "plan-approval";

export interface PlanDecisionPayload {
  approved: boolean;
  /** Operator-edited plan; when present (and non-empty) it replaces the agent's. */
  plan?: string;
  reason?: string;
}

/**
 * The event a run parks on when its change is classified `serious` (L3 / D2).
 *
 * Kept HERE next to PLAN_EVENT, and for the same reason: the web bundle
 * dispatches on the event name and cannot import durable.ts. Deliver a
 * ChangeDecisionPayload.
 *
 * Distinct from PLAN_EVENT deliberately. A plan approval is "is this the right
 * thing to do"; this is "the work is done, here is what it touched, may it be
 * pushed" — a different question, asked with the diff in hand, and a run can
 * legitimately be asked both.
 */
export const CHANGE_EVENT = "change-approval";

export interface ChangeDecisionPayload {
  approved: boolean;
  reason?: string;
}

/**
 * The boundary park (C1): a `serious` change no longer waits before the work.
 * The run finishes, verifies, opens a DRAFT pull request, and parks HERE with
 * the evidence attached. Deliver a MergeDecisionPayload: approve marks the
 * pull request ready (and merges it where the repo's policy allows), deny
 * closes it with the reason.
 *
 * The name is the wire contract Akiroo's decision queue answers
 * (`event_name: "approve-merge"`); it is not free to change.
 */
export const MERGE_EVENT = "approve-merge";

export interface MergeDecisionPayload {
  approved: boolean;
  reason?: string;
}
