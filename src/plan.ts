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
