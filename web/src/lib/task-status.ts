import { isAskEvent } from "teploy-ship/ask";
import { PLAN_EVENT, MERGE_EVENT } from "teploy-ship/plan";
import { UPGRADE_HOLD_EVENT } from "teploy-ship/fence";
/** Execution completion and external delivery are separate facts. */
export function taskStatus(status: string, event?: string, hasPr = false, journey?: string): { label: string; next: string } {
  if (event === UPGRADE_HOLD_EVENT) return { label: "Needs operator attention", next: "This task is held because its worker version is incompatible. An operator must resolve the hold." };
  if (status === "waiting") {
    if (event && isAskEvent(event)) return { label: "Needs an answer", next: "Answer the question below so work can continue." };
    if (event === PLAN_EVENT) return { label: "Plan ready for review", next: "Read the proposed plan and decide whether work should begin." };
    if (event === MERGE_EVENT) return { label: "Ready for your review", next: "Check the changes and recorded verification before deciding whether to merge." };
    return { label: "Waiting", next: event ? "Review the requested decision below." : "Waiting for the next scheduled execution step." };
  }
  if (status === "completed") return { label: journey === "plan" ? "Plan available" : journey === "investigate" ? "Answer available" : journey === "review" ? "Review available" : "Work finished", next: hasPr ? "Review the pull request and its latest checks. Finished execution does not by itself mean merged or deployed." : "Read the result and its evidence. You can ask a follow-up or request changes." };
  if (status === "failed") return { label: "Needs attention", next: "Read the failure details and recorded checks before retrying or starting a follow-up." };
  if (status === "cancelled") return { label: "Stopped", next: "This attempt stopped. Its history is retained and you can start a follow-up." };
  if (status === "cancelling") return { label: "Stopping", next: "The cancellation request is being processed." };
  if (["queued", "pending", "wake"].includes(status)) return { label: "Queued", next: "Waiting for a worker and available capacity. You can leave this page and return later." };
  return { label: "Working", next: "Ship is working on this task. Progress and any questions appear here." };
}
export function taskTitle(task: string): string {
  const first = task.trim().split(/\n/)[0] || "Task";
  return first.length > 110 ? first.slice(0, 107) + "…" : first;
}
