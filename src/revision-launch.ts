import { cancelRun } from "@neutron-build/workflow";
import type { ShipRuntime } from "./runtime.js";
import type { LaunchIntent } from "./launch-journal.js";
import { MERGE_EVENT } from "./plan.js";

/** Accepted intent is the recovery record. Claim ownership is a durable token,
 * so another revision or merge cannot steal a held decision after a restart.
 * Complete cancellation before publishing the child's scheduling record.
 */
export async function finishReviewReplacement(runtime: Pick<ShipRuntime,"store"|"loadMeta"|"saveMeta"|"claimDecision"|"markWake">, intent: LaunchIntent): Promise<void> {
  const parent = intent.reviewParent;
  if (!parent) return;
  const reason = `Changes requested in follow-up ${intent.runId}`;
  const events = await runtime.store.load(parent);
  const cancelled = events.some(e => e.type === "run-cancelled" && (e.data as {reason?:string})?.reason === reason);
  if (!cancelled) {
    if (!(await runtime.claimDecision(parent, MERGE_EVENT, intent.runId))) {
      throw new Error("The previous merge decision was already taken. This revision has not started.");
    }
    await cancelRun(runtime.store, parent, reason);
  }
  // A retry may arrive after the worker has settled cancellation. Never reset
  // terminal metadata or undo a completed parent's state.
  const current = await runtime.loadMeta(parent);
  if (current && !["completed", "failed", "cancelled", "cancelling"].includes(current.status)) {
    await runtime.saveMeta({...current, status:"cancelling", eventName:`revision:${intent.runId}`, updatedAt:new Date().toISOString()});
  }
  await runtime.markWake?.(parent);
}
