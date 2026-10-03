/**
 * What each harness actually does with a run's recorded input.
 *
 * Dependency-free on purpose (like plan.ts / ask.ts): the web dashboard imports
 * it to decide what to OFFER, and the server routes import it to decide what to
 * ACCEPT, from the same table.
 *
 * Why it exists: every new run records `steer: true`, and the run page offered
 * a steer box on that flag alone. But only the native loop drains steering
 * notes — external adapters read nothing but `prompt` (harness.ts HarnessTask).
 * A note sent to an external-harness run was stored, acknowledged ("sent"), and
 * never read. An instruction nobody will read must be refused, not accepted.
 *
 * This is deliberately a small table, not the full S13 capability contract
 * (investigation, tools, browser, interruption, accounting): add a column when
 * a surface needs to refuse on it. Unknown harness ids support nothing.
 */

export type HarnessCapability = "steer";

const NATIVE_ONLY: Record<string, readonly HarnessCapability[]> = {
  native: ["steer"],
  "claude-code": [],
  opencode: [],
};

interface RecordedHarness {
  harness?: { id?: unknown } | undefined;
  harnessAttempts?: readonly { id?: unknown }[] | undefined;
}

/** Harness ids a recorded run input commits to (single harness and/or attempts). */
export function recordedHarnessIds(input: RecordedHarness | undefined): string[] {
  const ids: string[] = [];
  // Runs recorded before harnesses were pluggable carry no `harness`: native.
  if (input?.harness === undefined) ids.push("native");
  else ids.push(typeof input.harness.id === "string" ? input.harness.id : "");
  for (const attempt of input?.harnessAttempts ?? []) ids.push(typeof attempt.id === "string" ? attempt.id : "");
  return ids;
}

/** True only when EVERY harness the run may execute under supports the capability. */
export function harnessSupports(input: RecordedHarness | undefined, capability: HarnessCapability): boolean {
  return recordedHarnessIds(input).every((id) => NATIVE_ONLY[id]?.includes(capability) === true);
}

/** Message shown when a steer is refused on a run that cannot consume it. */
export const STEER_UNSUPPORTED_MESSAGE =
  "This run uses an external harness, which reads only its starting prompt and cannot take mid-run messages. Cancel it and start a follow-up instead.";
