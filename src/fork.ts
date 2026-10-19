/**
 * DF1 — fork a run (SHIP_FORK).
 *
 * A fork is a NEW run that carries the source run's recorded history as text
 * (the D3 prior-run context, materialised into its task at enqueue exactly as
 * a follow-up's is) and starts a NEW work branch from the source's recorded
 * pushed commit, opening a pull request of its own. The source run's pull
 * request and branch are never written to. That is the whole difference from
 * a follow-up, which edits the same PR (docs/WORKSPACE.md).
 *
 * Lineage travels as `input.forkOf`, NOT as `parentRunId`: a fork is a new
 * task root by design (it does not consume the source's delegation cap and
 * the source's conversation anchor is not its own), and task-session.ts
 * enforces that a root run records no parent. The thread view links the two
 * through this field instead.
 *
 * Imitates T3 Code's ThreadForkService (apps/server, MIT): settled-only
 * sources, lineage recorded on the fork, the parent's commit as the base.
 * Ship's ports of those rules are the two functions below.
 *
 * Replay-safe by construction: the resolution runs ONCE, at enqueue, against
 * the source's then-current log; what it read is materialised into the fork's
 * input and a replay re-reads that, never the source (which has moved on).
 * `forkOf` admits no workflow step — the checkout reads it to decide WHERE to
 * stand, not which steps exist — so a run without it fingerprints exactly as
 * before this field existed.
 */
import type { WorkflowEvent } from "@neutron-build/workflow";

import { MERGE_EVENT } from "./plan.js";
import { verificationFactsFromEvents } from "./verification-summary.js";

/** The deployment switch. On unless explicitly turned off (`0`/`false`/`no`/`off`). */
export function forkEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test((env.SHIP_FORK ?? "").trim());
}

/**
 * Which runs may be forked.
 *
 * T3's isForkableSourceRunStatus admits the settled statuses plus `waiting`
 * (its provider-finished-with-checkpoint-pending state). Ship's `waiting`
 * covers several parks that are NOT finished work — a plan review, an ask, the
 * upgrade hold — so only the one park whose work is already published and
 * merely awaiting a merge decision is forkable, the same state the follow-up
 * route treats as `reviewing`. Everything else in flight (`queued`, `running`,
 * `cancelling`, the other parks) refuses by name below.
 */
export function isForkableSourceStatus(status: string, eventName?: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    (status === "waiting" && eventName === MERGE_EVENT)
  );
}

/** The refusal code, named like delegate.ts's DELEGATE_CHILD_REFUSED. */
export const FORK_SOURCE_NOT_SETTLED = "FORK_SOURCE_NOT_SETTLED";

/** The sentence a refused fork reads: names the run, its state and the rule. */
export function forkSourceNotSettled(runId: string, status: string, eventName?: string): string {
  const state = status === "waiting" ? `waiting on ${eventName ?? "an unknown decision"}` : status;
  return (
    `fork refused (${FORK_SOURCE_NOT_SETTLED}): run ${runId} is ${state}; only a settled run ` +
    "(completed, failed, cancelled) or one parked at its merge review can be forked. Wait for it to finish or cancel it first."
  );
}

/**
 * What a fork's recorded input carries about its source. Every field is a
 * fact read off the source's own log at enqueue:
 *  - `runId` — lineage, shown on the run page and in the thread view;
 *  - `sha` — the commit the fork's branch starts from (the source's last
 *    recorded push). Absent when the source pushed nothing: the fork then
 *    starts from the default branch and its task says so;
 *  - `branch` / `headRepo` — transport only (how the commit's objects reach
 *    the fork's clone; the head repository for a fork-PR source). Never
 *    written to.
 */
export interface ForkSourceRecord {
  runId: string;
  sha?: string;
  branch?: string;
  headRepo?: string;
}

/** What resolveForkSource reads — structural so tests share one shape. */
export interface ForkSourceDeps {
  loadMeta(runId: string): Promise<{ status?: string; eventName?: string } | null>;
  store: { load(runId: string): Promise<readonly WorkflowEvent[]> };
}

const rec = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * Resolve a fork's source at enqueue: refuse an unforkable run by name, then
 * read the checkout facts off its log. Pure over the stores it is handed; the
 * caller materialises the result, so nothing here runs on a replay.
 */
export async function resolveForkSource(
  deps: ForkSourceDeps,
  runId: string,
): Promise<{ ok: true; record: ForkSourceRecord } | { ok: false; reason: string }> {
  const meta = await deps.loadMeta(runId);
  if (meta === null) return { ok: false, reason: `fork refused: run ${runId} does not exist` };
  const status = typeof meta.status === "string" && meta.status !== "" ? meta.status : "unknown";
  const eventName = typeof meta.eventName === "string" && meta.eventName !== "" ? meta.eventName : undefined;
  if (!isForkableSourceStatus(status, eventName)) {
    return { ok: false, reason: forkSourceNotSettled(runId, status, eventName) };
  }
  const events = (await deps.store.load(runId)) as WorkflowEvent[];
  const facts = verificationFactsFromEvents(events);
  const sha = facts.push?.kind === "pushed" && facts.push.sha !== "" ? facts.push.sha : undefined;
  // The source's own repo-setup output: which branch its push rode, and which
  // repository that branch lives in when it is not the base repo (a fork PR).
  const setup = rec(rec(events.find((e) => e.type === "step-completed" && e.name === "repo-setup")?.data)?.result) ?? {};
  const branch = typeof setup.branch === "string" && setup.branch !== "" ? setup.branch : undefined;
  const headRepo = typeof setup.headRepo === "string" && setup.headRepo !== "" ? setup.headRepo : undefined;
  return {
    ok: true,
    record: {
      runId,
      ...(sha !== undefined ? { sha } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(headRepo !== undefined ? { headRepo } : {}),
    },
  };
}

/**
 * The Recorded line a fork's task carries, so the next agent knows what it
 * inherited and from where — including the no-push case, which would
 * otherwise look like a mistake (the branch not matching the history).
 * Rendered by Ship from its own log; ids and shas only, nothing quoted.
 */
export function forkNote(record: ForkSourceRecord): string {
  return record.sha !== undefined
    ? `Recorded: this run forks ${record.runId}, whose last recorded push is ${record.sha}. ` +
        "This fork starts a new branch at that commit and opens its own pull request; the forked run's pull request and branch are not touched."
    : `Recorded: this run forks ${record.runId}, which recorded no pushed commit. ` +
        "This fork starts from the repository's default branch and opens its own pull request.";
}
