/**
 * The upgrade fence's wire constants, with no Node dependencies.
 *
 * `step-fingerprint.ts` owns the fence's machinery but reads the compiled
 * modules off disk, so importing it from a dashboard route would drag
 * `node:fs` into the browser bundle — the build fails rather than shipping
 * it, which is how this module came to exist. The constant and the refusal
 * are defined HERE once and re-exported from step-fingerprint.ts, so core
 * callers keep their imports and the dashboard gets a browser-safe source.
 */

/** The event name a run held by the fence waits on. See step-fingerprint.ts. */
export const UPGRADE_HOLD_EVENT = "ship-upgrade-hold";

/**
 * What every decision surface must answer when offered an upgrade hold.
 *
 * The hold reuses the ordinary park state so it reaches the inbox — which
 * means every path that decides a park (the CLI, the dashboard form, the
 * JSON decide route) can reach it too. Deciding one is not answering a
 * question: the claim erases the very marker rollback-release reads, and
 * the delivery appends an event into the log the hold exists to keep
 * untouched. One shared refusal, so the three surfaces cannot drift.
 */
export function upgradeHoldRefusal(runId: string): string {
  return (
    `run ${runId} is held by the upgrade fence, not waiting for a decision — deciding it would write into the log the hold protects. ` +
    `Roll the deployment back (the hold releases itself once the running build agrees with the run again) and then ` +
    `teploy-ship resume ${runId}, or give the run up with teploy-ship cancel ${runId}.`
  );
}
