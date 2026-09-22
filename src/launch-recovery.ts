/** Operator projections of accepted launches; never expose the recorded input. */
import type { LaunchJournal } from "./launch-journal.js";
import { safeForDisplay } from "./redact.js";
export interface PendingLaunch {
  runId: string;
  summary?: string;
  reviewParent?: string;
  error?: string;
}
export async function pendingLaunches(journal: LaunchJournal, after?: string): Promise<{ rows: PendingLaunch[]; next?: string }> {
  if (after && !/^[A-Za-z0-9_-]{1,100}$/.test(after)) throw new Error("Invalid recovery cursor");
  const ids = await journal.pending(after);
  const rows: PendingLaunch[] = [];
  for (const runId of ids) {
    try {
      const intent = await journal.get(runId);
      if (!intent) throw new Error("Accepted launch record is missing");
      rows.push({ runId, summary: safeForDisplay(intent.meta.task ?? "Accepted task", 300), ...(intent.reviewParent ? { reviewParent: intent.reviewParent } : {}) });
    } catch (error) {
      rows.push({ runId, error: safeForDisplay(error instanceof Error ? error.message : String(error), 400) });
    }
  }
  return { rows, ...(ids.length === 100 ? { next: ids.at(-1) } : {}) };
}
export async function retryAcceptedLaunch(journal: LaunchJournal, runId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error("Invalid run identity");
  const intent = await journal.get(runId);
  if (!intent) throw new Error("No accepted launch with this identity");
  // Publish the original intent, preserving its policy, identity and review claim.
  await journal.publish(intent);
}
