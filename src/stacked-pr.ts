/**
 * DS1 — stacked pull requests (SHIP_STACKED_PRS).
 *
 * A stacked run is a change run whose pull request opens ON TOP of another
 * run's open pull request: it checks out the base run's recorded branch head
 * (`ship/<baseRunId>`), opens its own PR against that branch instead of the
 * default branch, and records the base's branch and head sha so the stack can
 * be reassembled later. When the base PR squash-merges, pr-watch wakes ONE
 * revision task (the `stackRebase` half below) whose recorded step rebases the
 * branch `--onto` the default branch, retargets the PR and pushes with lease
 * (git.ts rebaseStackedOnto) — a plain rebase would replay the base's commits,
 * which are NOT ancestors of the default branch precisely because Ship
 * squash-merges. That rule, and the expected-heads check before the force
 * push, are T3 Code's cascadeRebaseStack and githubStackActions (MIT), ported
 * to Ship's executor and recorded-step shapes.
 *
 * The name is `SHIP_STACKED_PRS`, never `SHIP_STACK_*`: `SHIP_STACK_DETECT`
 * already names tech-stack detection (stack-propose.ts).
 *
 * Replay-safe by the fork.ts shape: everything the checkout and the watch
 * need is resolved ONCE, at enqueue, against the base run's then-current log
 * and materialised into `input.stack`; `input.stackRebase` (what the woken
 * revision carries) is the only field that admits a step. Runs without either
 * field enqueue byte-identically and their fingerprints do not move.
 */
import type { WorkflowEvent } from "@neutron-build/workflow";

import { verificationFactsFromEvents } from "./verification-summary.js";

/** The deployment switch. On unless explicitly turned off (`0`/`false`/`no`/`off`). */
export function stackedPrsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test((env.SHIP_STACKED_PRS ?? "").trim());
}

/**
 * What a stacked run's recorded input carries about its base. Every field is
 * a fact read off the base run's own log at enqueue:
 *  - `runId` — the base run, whose branch this stack rides;
 *  - `pr` — the pull request that run OPENED (its recorded `repo-pr` step):
 *    the PR this stack sits on, and what pr-watch watches for the merge;
 *  - `branch` — `ship/<baseRunId>`, the branch the stacked checkout stands on
 *    and the stacked PR opens against (transport only, never written);
 *  - `sha` — the base's last recorded push. The stacked branch is cut at
 *    EXACTLY this commit, which is what makes the later `rebase --onto
 *    <default> <sha>` replay only the stack's own commits.
 */
export interface StackOnRecord {
  runId: string;
  pr: number;
  branch: string;
  sha: string;
}

/**
 * What the woken revision carries (intake `stack` → `input.stackRebase`):
 * the recorded old base head commits above which are this stack's own, and
 * the branch the PR retargets onto (the default branch — the base PR's own
 * base, read from the forge by pr-watch when it detected the merge).
 */
export interface StackRebaseRequest {
  oldBaseHeadSha: string;
  defaultBranch: string;
}

/** What resolveStackBase reads — structural so tests share one shape. */
export interface StackBaseDeps {
  loadMeta(runId: string): Promise<{ status?: string } | null>;
  store: { load(runId: string): Promise<readonly WorkflowEvent[]> };
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * Resolve a stack's base at enqueue. Refusals are sentences a surface can
 * show as-is; none of them leaves a run behind. Pure over the stores it is
 * handed; the caller materialises the result, so nothing here runs on a
 * replay.
 *
 * No status gate, deliberately (unlike fork.ts): what a stack takes from its
 * base is the RECORDED head sha and the PR number, both immutable once
 * recorded. Whether the base PR is still open is a live forge fact, and the
 * fail-closed answer is pr-watch's: if the base PR closed unmerged, the first
 * sweep marks the stack abandoned and proposes nothing.
 */
export async function resolveStackBase(
  deps: StackBaseDeps,
  baseRunId: string,
  repo: string | undefined,
): Promise<{ ok: true; record: StackOnRecord } | { ok: false; reason: string }> {
  const meta = await deps.loadMeta(baseRunId);
  if (meta === null) return { ok: false, reason: `stack refused: run ${baseRunId} does not exist` };
  const events = (await deps.store.load(baseRunId)) as WorkflowEvent[];
  const input = rec(rec(events.find((e) => e.type === "run-started")?.data)?.input);
  const baseRepo = typeof input?.repo === "string" ? input.repo : "";
  if (baseRepo === "" || (repo !== undefined && baseRepo !== repo)) {
    return {
      ok: false,
      reason: `stack refused: run ${baseRunId} worked a different repository (${baseRepo === "" ? "none" : baseRepo}${repo !== undefined ? `, not ${repo}` : ""})`,
    };
  }
  if (rec(input?.stack) !== undefined) {
    return { ok: false, reason: `stack refused: run ${baseRunId} is itself stacked; stacking is one level deep` };
  }
  // The PR this stack rides: the base run must have OPENED one (a recorded
  // `repo-pr` step) — a follow-up that only revised someone else's PR is not a
  // base, and neither is a run that has not published yet.
  let pr = 0;
  for (const e of events) {
    if (e.type !== "step-completed" || e.name !== "repo-pr") continue;
    const result = rec(rec(e.data)?.result) ?? {};
    const n = Number(result.number);
    if (Number.isSafeInteger(n) && n > 0) {
      pr = n;
      break;
    }
  }
  if (pr === 0) {
    return { ok: false, reason: `stack refused: run ${baseRunId} has no open pull request of its own to stack on` };
  }
  const setup = rec(rec(events.find((e) => e.type === "step-completed" && e.name === "repo-setup")?.data)?.result) ?? {};
  const branch = typeof setup.branch === "string" && setup.branch !== "" ? setup.branch : "";
  if (branch === "") return { ok: false, reason: `stack refused: run ${baseRunId} recorded no work branch` };
  const facts = verificationFactsFromEvents(events);
  const sha = facts.push?.kind === "pushed" && facts.push.sha !== "" ? facts.push.sha : "";
  if (sha === "") return { ok: false, reason: `stack refused: run ${baseRunId} pushed nothing; there is no head to stack on` };
  return { ok: true, record: { runId: baseRunId, pr, branch, sha } };
}

/**
 * The Recorded line a stacked run's task carries, so its agent knows its work
 * rides another run's pull request. Rendered by Ship from its own log; ids
 * and shas only, nothing quoted.
 */
export function stackNote(record: StackOnRecord): string {
  return (
    `Recorded: this run stacks on ${record.runId} (pull request #${record.pr}, branch ${record.branch} at ${record.sha}). ` +
    "Its branch starts at that commit and its pull request opens against that branch, not the default branch; " +
    "reviewers see this run's own commits only."
  );
}
