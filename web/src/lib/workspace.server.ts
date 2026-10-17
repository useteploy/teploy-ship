import {
  requestWorkspace,
  workspaceReply,
  workspaceInspection,
  replyKey,
  refreshForgeIfStale,
} from "../../../dist/workspace-requests.js";
import type { ShipRuntime } from "teploy-ship/runtime";
import { canonicalRepositoryURL } from "../../../dist/repository-reference.js";
export { requestWorkspace, workspaceReply, workspaceInspection, refreshForgeIfStale };
export async function freshForge(
  runtime: ShipRuntime,
  runId: string,
  by: string,
) {
  const request = await requestWorkspace(runtime, runId, "forge", by);
  for (let i = 0; i < 12; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const reply = await workspaceReply(runtime, runId);
    if (reply?.id === request.id) {
      if (reply.error || !reply.forge)
        throw new Error(reply.error ?? "No forge result");
      return reply.forge;
    }
  }
  throw new Error(
    "Waiting for the worker to check this pull request. Refresh and retry, or choose the default branch.",
  );
}
const HISTORY_RUN_LIMIT = 20;
/** How far past the bound the walk keeps counting (parent links only). */
const OMITTED_COUNT_LIMIT = 100;

/**
 * `parentRunId` is conversation lineage only (task-session.ts), and
 * coordination.ts's launchChild points a client run at an API run in ANOTHER
 * repository. Following that link would pull the other project's plan,
 * steers, test output, changed files and findings into this run's follow-up
 * digest. Unknown or absent repos never cut the walk: only a KNOWN
 * difference does.
 */
function sameRepository(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || a === "" || b === undefined || b === "") return true;
  if (a === b) return true;
  const ca = canonicalRepositoryURL(a);
  const cb = canonicalRepositoryURL(b);
  return ca !== null && cb !== null && ca === cb;
}

export interface ThreadHistory {
  history: { runId: string; task: string; result: string; events: any[] }[];
  /** Ancestors past the 20-run bound — counted, not read into history, so the digest can say they were omitted. */
  olderOmitted: number;
  /** The count stopped at its own cap: more ancestors exist than olderOmitted. */
  olderOmittedCapped?: boolean;
  /** The walk stopped at this ancestor: it belongs to a different repository/project. */
  crossProjectCutAt?: string;
}

export async function threadHistory(
  runtime: ShipRuntime,
  runId: string,
): Promise<ThreadHistory> {
  const seen = new Set<string>();
  const history: ThreadHistory["history"] = [];
  let next: string | undefined = runId;
  let rootRepo: string | undefined;
  let crossProjectCutAt: string | undefined;
  let olderOmitted = 0;
  let olderOmittedCapped = false;
  while (next && !seen.has(next) && crossProjectCutAt === undefined && !olderOmittedCapped) {
    seen.add(next);
    const events = await runtime.store.load(next);
    const input = (events.find((e) => e.type === "run-started")?.data as any)
      ?.input;
    const repo = typeof input?.repo === "string" ? input.repo : undefined;
    if (history.length === 0) rootRepo = repo;
    else if (!sameRepository(rootRepo, repo)) {
      crossProjectCutAt = next;
      break;
    }
    if (history.length < HISTORY_RUN_LIMIT) {
      const output = (events.find((e) => e.type === "run-completed")?.data as any)
        ?.output;
      history.unshift({
        runId: next,
        task: String(input?.userMessage ?? input?.task ?? "").slice(0, 12000),
        result: String(
          output?.agentSummary ?? output?.summary ?? "No final result recorded",
        ).slice(0, 6000),
        events,
      });
    } else if (olderOmitted < OMITTED_COUNT_LIMIT) {
      olderOmitted += 1;
    } else {
      olderOmittedCapped = true;
    }
    next =
      typeof input?.parentRunId === "string" ? input.parentRunId : undefined;
  }
  return {
    history,
    olderOmitted,
    ...(olderOmittedCapped ? { olderOmittedCapped: true } : {}),
    ...(crossProjectCutAt !== undefined ? { crossProjectCutAt } : {}),
  };
}
