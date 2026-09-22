/** Operator projections of accepted launches; never expose the recorded input. */
import type { LaunchDisposition, LaunchJournal } from "./launch-journal.js";
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

/**
 * Operator disposition for an accepted intent that can never publish (A.4).
 *
 * Abandoning records an auditable transition — actor, reason, time — and
 * removes the intent from the pending set WITHOUT deleting it. It enqueues no
 * replacement (a new request goes through normal intake and its plan-approval
 * floor), touches no review claim, and loses to a concurrent publish: if the
 * launch made it out between the operator loading the page and confirming,
 * the refusal says so and nothing is abandoned.
 */
export async function abandonAcceptedLaunch(
  journal: LaunchJournal,
  runId: string,
  disposition: { actor: string; reason: string },
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(runId)) throw new Error("Invalid run identity");
  const actor = disposition.actor.trim();
  const reason = disposition.reason.trim();
  if (actor === "") throw new Error("Abandoning an accepted launch needs the deciding operator");
  if (reason.length < 8) throw new Error("Abandoning an accepted launch needs a reason (8+ characters) for the audit record");
  const outcome = await journal.abandon(runId, { actor: safeForDisplay(actor, 200), reason: safeForDisplay(reason, 2000) });
  if (outcome === "missing") throw new Error("No accepted launch with this identity");
  if (outcome === "already-published") throw new Error("This launch published (possibly a retry just succeeded); it cannot be abandoned");
  // "already-abandoned" is idempotent success: the recorded disposition stays.
}

/** Bounded recent dispositions for the recovery page's audit surface. */
export async function launchDispositions(journal: LaunchJournal, limit = 20): Promise<LaunchDisposition[]> {
  return journal.dispositions(limit);
}
