import {
  mergeFromPullRequestEvent,
  projectNotifier,
  recordForgeMerge,
  recordRevert,
  revertsFromPushEvent,
} from "teploy-ship/runtime";

import { shipRuntime } from "./store.server.js";

/**
 * Contract 4's web half. The worker cannot see forge events — only this
 * process receives webhooks — so the pull_request/push routing in the hook
 * receivers lands here: runtime stores on one side, the signed return leg on
 * the other. Pure detection lives in revert-watch.ts and is unit-tested
 * there; this module is wiring only.
 *
 * Failure posture: log and answer 200. A revert that cannot be recorded must
 * not 500 the delivery — the forge would retry a webhook whose side effects
 * half-ran, and the delivery log (claimDelivery) has already marked it seen.
 */

export async function applyPullRequestEvent(payload: Record<string, unknown>): Promise<{ ok: true }> {
  const merge = mergeFromPullRequestEvent(payload);
  if (merge === null) return { ok: true };
  const runtime = await shipRuntime();
  const deps = { stats: runtime.repoStats, notify: projectNotifier(), log: (line: string) => console.log(line) };
  await recordForgeMerge(deps, merge).catch((error: unknown) =>
    console.log(`[revert] merge recording failed: ${error instanceof Error ? error.message : String(error)}`),
  );
  if (merge.revert !== undefined) {
    await recordRevert(deps, merge.revert).catch((error: unknown) =>
      console.log(`[revert] revert recording failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
  return { ok: true };
}

export async function applyPushEvent(payload: Record<string, unknown>): Promise<{ ok: true; reverts: number }> {
  const signals = revertsFromPushEvent(payload);
  if (signals.length === 0) return { ok: true, reverts: 0 };
  const runtime = await shipRuntime();
  const deps = { stats: runtime.repoStats, notify: projectNotifier(), log: (line: string) => console.log(line) };
  for (const signal of signals) {
    await recordRevert(deps, signal).catch((error: unknown) =>
      console.log(`[revert] revert recording failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
  return { ok: true, reverts: signals.length };
}
