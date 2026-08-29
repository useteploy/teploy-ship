import type { RepoStatsStore } from "./repo-stats.js";
import type { ProjectNotifier } from "./notify.js";

/**
 * Contract 4, Ship's half: notice that a merged Ship pull request was
 * reverted on the forge, record it in the per-repo numbers, and tell Akiroo
 * on the signed webhook. Akiroo's consumer half is already merged and keyed
 * on `{kind: "revert", repo, pr, revert_pr?, origin?}` — the shape below is
 * load-bearing and extends additively only.
 *
 * Detection reads the forge's own pull_request and push events, the two
 * shapes a revert is visible in:
 *
 *   - a MERGED pull request titled `Revert "<original>"` whose body carries
 *     `This reverts commit <sha>` (what the forge's Revert button produces);
 *   - a pushed commit whose message begins `Revert` and names the commit it
 *     undoes (what a human produces with git revert on the CLI).
 *
 * Attribution joins on the MERGE sha. That works because Ship's own webhook
 * (which contract 1's registration now subscribes to pull_request events)
 * records the forge's `merge_commit_sha` on the merged row before any revert
 * can reference it — a revert of PR #N necessarily lands after PR #N's merge
 * event. A revert that matches no recorded sha is not ours to report: the
 * delivery is acknowledged and dropped.
 *
 * Everything here is pure over injected stores, in the style the sweep and
 * hook tests use: the web process supplies the runtime, the tests supply
 * fakes.
 */

/** What one revert looks like before it is matched against Ship's records. */
export interface RevertSignal {
  /** Clone URL of the repository the revert landed on. */
  repo: string;
  /** The commit the revert undid, when the forge named it. */
  sha?: string;
  /** The pull request that carried the revert, when there was one. */
  revertPr?: string;
  revertPrNumber?: number;
}

/** A merged-pull-request event reduced to what merge/revert recording needs. */
export interface ForgeMerge {
  repo: string;
  pr: string;
  number: number;
  sha?: string;
  title: string;
  /** The revert signal inside this merge, when its shape says one. */
  revert?: RevertSignal;
}

function shaFromRevertText(text: string | null | undefined): string | undefined {
  if (text === undefined || text === null) return undefined;
  const match = /This reverts commit ([0-9a-f]{7,40})/i.exec(text);
  return match?.[1]?.toLowerCase();
}

/**
 * A `pull_request` event, if it is one this lane cares about: a merged PR.
 * Null for everything else — closed-unmerged, opened, synchronize, noise.
 */
export function mergeFromPullRequestEvent(payload: Record<string, unknown>): ForgeMerge | null {
  if (payload.action !== "closed") return null;
  const pr = payload.pull_request;
  if (pr === undefined || pr === null || typeof pr !== "object") return null;
  const p = pr as Record<string, unknown>;
  if (p.merged !== true) return null;
  const repository = payload.repository as Record<string, unknown> | undefined;
  const repo = typeof repository?.clone_url === "string" ? repository.clone_url : "";
  const number = typeof p.number === "number" ? p.number : undefined;
  const url = typeof p.html_url === "string" ? p.html_url : typeof p.url === "string" ? p.url : "";
  if (repo === "" || number === undefined || url === "") return null;
  const title = typeof p.title === "string" ? p.title : "";
  const sha = typeof p.merge_commit_sha === "string" && p.merge_commit_sha !== "" ? p.merge_commit_sha.toLowerCase() : undefined;
  const out: ForgeMerge = {
    repo,
    pr: url,
    number,
    ...(sha !== undefined ? { sha } : {}),
    title,
  };
  if (/^revert\b/i.test(title.trim())) {
    out.revert = {
      repo,
      // The undid commit, from the line the forge's Revert button writes.
      ...(shaFromRevertText(typeof p.body === "string" ? p.body : undefined) !== undefined
        ? { sha: shaFromRevertText(typeof p.body === "string" ? p.body : undefined)! }
        : {}),
      revertPr: url,
      revertPrNumber: number,
    };
  }
  return out;
}

/**
 * `push` events: every commit whose message begins `Revert` and names the
 * commit it undoes. A push can carry several; each is its own signal.
 */
export function revertsFromPushEvent(payload: Record<string, unknown>): RevertSignal[] {
  const repository = payload.repository as Record<string, unknown> | undefined;
  const repo = typeof repository?.clone_url === "string" ? repository.clone_url : "";
  if (repo === "" || !Array.isArray(payload.commits)) return [];
  const out: RevertSignal[] = [];
  for (const c of payload.commits) {
    if (c === undefined || c === null || typeof c !== "object") continue;
    const commit = c as Record<string, unknown>;
    const message = typeof commit.message === "string" ? commit.message : "";
    if (!/^revert\b/i.test(message.trim())) continue;
    const sha = shaFromRevertText(message);
    if (sha === undefined) continue;
    out.push({ repo, sha });
  }
  return out;
}

export interface RevertWatchDeps {
  stats: Pick<RepoStatsStore, "list" | "record" | "attach">;
  notify: Pick<ProjectNotifier, "revert">;
  log: (line: string) => void;
  now?: () => string;
}

/**
 * Record one merge off the forge: if the PR is one Ship sent (a row matches
 * its number or URL), a `merged` row is recorded — under the same key the
 * worker's own merge path writes, so however many paths report one merge it
 * counts once. This is also what ENRICHES the row with the forge's merge sha,
 * which the revert join below reads.
 */
export async function recordForgeMerge(
  deps: RevertWatchDeps,
  merge: { repo: string; pr: string; number: number; sha?: string },
): Promise<boolean> {
  const rows = await deps.stats.list(merge.repo);
  const mine = rows.find(
    (r) => (r.number !== undefined && r.number === merge.number) || (r.pr !== undefined && r.pr === merge.pr),
  );
  if (mine === undefined) return false;
  // Enrich first, record second: the worker's own merge path may have written
  // this row already (same key, no sha — the event log knows no merge sha),
  // and `record` is create-only. Attach fills the sha on that row; if nobody
  // wrote it yet, record creates it carrying the sha.
  await deps.stats.attach({
    repo: merge.repo,
    kind: "merged",
    runId: mine.runId,
    pr: merge.pr,
    number: merge.number,
    ...(merge.sha !== undefined ? { sha: merge.sha } : {}),
    at: (deps.now ?? (() => new Date().toISOString()))(),
  });
  return deps.stats.record({
    repo: merge.repo,
    kind: "merged",
    runId: mine.runId,
    pr: merge.pr,
    number: merge.number,
    ...(merge.sha !== undefined ? { sha: merge.sha } : {}),
    at: (deps.now ?? (() => new Date().toISOString()))(),
  });
}

/**
 * Apply one revert signal: match it to a merged Ship run by sha, record the
 * `reverted` row, and emit the contract-4 event. The notify fires only when
 * THIS call created the row, so a re-delivered event — or the merge and the
 * push both reporting one revert — is one event to Akiroo, not two.
 */
export async function recordRevert(deps: RevertWatchDeps, signal: RevertSignal): Promise<boolean> {
  if (signal.sha === undefined) return false;
  const rows = await deps.stats.list(signal.repo);
  const matched = rows.find((r) => r.kind === "merged" && r.sha !== undefined && r.sha.startsWith(signal.sha!));
  if (matched === undefined) return false;

  const created = await deps.stats.record({
    repo: signal.repo,
    kind: "reverted",
    runId: matched.runId,
    ...(matched.pr !== undefined ? { pr: matched.pr } : {}),
    ...(matched.number !== undefined ? { number: matched.number } : {}),
    sha: signal.sha,
    at: (deps.now ?? (() => new Date().toISOString()))(),
  });
  if (!created) return false;
  await deps.notify.revert({
    kind: "revert",
    repo: signal.repo,
    pr: matched.pr ?? "",
    ...(signal.revertPr !== undefined ? { revert_pr: signal.revertPr } : {}),
  });
  deps.log(`[revert] ${signal.repo}: run ${matched.runId} reverted${signal.revertPr !== undefined ? ` by ${signal.revertPr}` : ""}`);
  return true;
}
