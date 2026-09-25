/**
 * Superseded previews (wave 10, L13; orchestrator ruling on L8's open item 1).
 *
 * Previews stay PER REVISION: deployPreview gives every revision its own slot
 * (`ship-<sha256(branch NUL revision)[:40]>`), because the identity is
 * immutable, the verification evidence a run recorded is about that exact
 * revision, and recovering an older run must never tear down a newer
 * revision's preview. What that left open is the other half: when revision 2
 * of a pull request deploys, revision 1's preview (and the preview of a run
 * the follow-up cancelled) kept serving until its TTL.
 *
 * This is the cleanup. When a run on an existing pull request deploys its
 * preview, it destroys the previews of OLDER runs of the same repo + pull
 * request, and nothing else:
 *
 *   - "older" is structural, never a comparison of commits: a run's own
 *     conversation ancestors (input.parentRunId, the dashboard follow-up), or a
 *     run on the same pull request that was enqueued strictly before this one
 *     (a review-comment follow-up from intake has no parent link). A run never
 *     looks at anything enqueued after it, so an older run that is recovered
 *     later cannot reach a newer revision's preview.
 *   - A candidate whose slot or revision equals this run's own is skipped: it
 *     IS this preview.
 *   - Only previews with a recorded slot are touched. A receipt without one
 *     predates immutable preview identity, and its branch name may belong to
 *     something else now.
 *   - Idempotent: `teploy preview destroy` of a missing preview exits 0, and a
 *     run that is already marked superseded is not destroyed again. The first
 *     superseder's mark wins, so the older run's page points at the revision
 *     that actually replaced it.
 *
 * The mark is the reverse link the superseded run's page reads
 * (web/src/lib/workspace.ts previewPanel): the newer run's step records what
 * it destroyed, and the mark lets the OLDER run's page say "superseded by
 * revision X" without scanning every later run on each page view.
 */
import { destroyPreview, resolvePreviewTarget, type PreviewTarget } from "./deploy.js";

/** The recorded step. Gated on DurableAgentInput.supersedePreviews. */
export const PREVIEW_SUPERSEDE_STEP = "preview-supersede";

/** Runtime-config key holding a superseded run's mark (runtime.config, like SHIP_FORGE_STATE_). */
export const previewSupersededKey = (runId: string): string => `SHIP_PREVIEW_SUPERSEDED_${runId}`;

/** What the superseded run's page reads: who replaced its preview, and with which revision. */
export interface SupersededMark {
  byRunId: string;
  revision?: string;
  /** The newer preview's URL. */
  url?: string;
  at: string;
}

/** Parse a stored mark, or undefined when absent or unreadable. */
export function parseSupersededMark(raw: string | undefined): SupersededMark | undefined {
  if (raw === undefined || raw === "") return undefined;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.byRunId !== "string" || typeof v.at !== "string") return undefined;
    return {
      byRunId: v.byRunId,
      ...(typeof v.revision === "string" ? { revision: v.revision } : {}),
      ...(typeof v.url === "string" ? { url: v.url } : {}),
      at: v.at,
    };
  } catch {
    return undefined;
  }
}

type LoggedEvent = { type: string; name?: string; at?: string; data?: unknown };

/** How a worker reads run history and writes the reverse link. */
export interface PreviewLineage {
  loadEvents(runId: string): Promise<readonly LoggedEvent[]>;
  /**
   * Recent run ids, bounded, so a same-PR run with no parent link (an intake
   * review follow-up) is found too. Absent = conversation ancestors only.
   */
  recentRunIds?(): Promise<string[]>;
  marked(runId: string): Promise<SupersededMark | undefined>;
  mark(runId: string, mark: SupersededMark): Promise<void>;
}

/** One older run's preview, as the supersede step judged it. */
export interface SupersededPreview {
  runId: string;
  slot: string;
  revision?: string;
  result: "destroyed" | "already-superseded" | "failed";
  detail?: string;
}

export type SupersedeOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "done"; superseded: SupersededPreview[] };

/** Bounds, so a long conversation or a busy store cannot make the step unbounded. */
const MAX_ANCESTORS = 20;
const MAX_RECENT = 100;

interface RunPreviewFacts {
  runId: string;
  at?: string;
  repo?: string;
  pr?: number;
  app?: string;
  parentRunId?: string;
  slot?: string;
  revision?: string;
}

/** What one run's log says about its preview and its pull request. */
export function runPreviewFacts(runId: string, events: readonly LoggedEvent[]): RunPreviewFacts {
  const started = events.find((e) => e.type === "run-started");
  const input = ((started?.data as { input?: Record<string, unknown> } | undefined)?.input ?? {}) as Record<string, unknown>;
  const result = (name: string): Record<string, unknown> | undefined => {
    const step = events.find((e) => e.type === "step-completed" && e.name === name);
    const r = (step?.data as { result?: unknown } | undefined)?.result;
    return r !== null && typeof r === "object" ? (r as Record<string, unknown>) : undefined;
  };
  const preview = result("preview-deploy");
  const opened = result("repo-pr");
  const pr = typeof input.pr === "number" ? input.pr : typeof opened?.number === "number" ? opened.number : undefined;
  const app = ((input.verification as { preview?: { app?: unknown } } | undefined)?.preview?.app);
  return {
    runId,
    ...(typeof started?.at === "string" ? { at: started.at } : {}),
    ...(typeof input.repo === "string" ? { repo: input.repo } : {}),
    ...(pr !== undefined ? { pr } : {}),
    ...(typeof app === "string" ? { app } : {}),
    ...(typeof input.parentRunId === "string" ? { parentRunId: input.parentRunId } : {}),
    ...(preview?.kind === "deployed" && typeof preview.branch === "string" ? { slot: preview.branch } : {}),
    ...(preview?.kind === "deployed" && typeof preview.revision === "string" ? { revision: preview.revision } : {}),
  };
}

/** One spelling of a repo for the same-PR comparison: case, `.git` and trailing slashes ignored. */
function repoKey(repo: string): string {
  return repo.trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
}

/**
 * The older runs whose previews this run supersedes. Pure over the loaded
 * logs, so the ordering rule is testable without a worker.
 */
export async function supersededCandidates(
  me: { runId: string; repo: string; pr: number; slot: string; revision?: string; parentRunId?: string; at?: string },
  lineage: Pick<PreviewLineage, "loadEvents" | "recentRunIds">,
): Promise<RunPreviewFacts[]> {
  const found = new Map<string, RunPreviewFacts>();
  const seen = new Set<string>([me.runId]);
  // Conversation ancestors: older by construction.
  let next = me.parentRunId;
  for (let depth = 0; next !== undefined && depth < MAX_ANCESTORS && !seen.has(next); depth++) {
    seen.add(next);
    const facts = runPreviewFacts(next, await lineage.loadEvents(next));
    found.set(next, facts);
    next = facts.parentRunId;
  }
  // Same pull request, enqueued strictly before this run. A run with no
  // recorded start time, or with none of its own, is never judged older.
  const mine = me.at !== undefined ? Date.parse(me.at) : NaN;
  if (lineage.recentRunIds !== undefined && !Number.isNaN(mine)) {
    for (const runId of (await lineage.recentRunIds()).slice(0, MAX_RECENT)) {
      if (seen.has(runId)) continue;
      seen.add(runId);
      const facts = runPreviewFacts(runId, await lineage.loadEvents(runId));
      const theirs = facts.at !== undefined ? Date.parse(facts.at) : NaN;
      if (!Number.isNaN(theirs) && theirs < mine) found.set(runId, facts);
    }
  }
  return [...found.values()].filter(
    (c) =>
      c.slot !== undefined &&
      c.slot !== me.slot &&
      (me.revision === undefined || c.revision !== me.revision) &&
      c.repo !== undefined &&
      repoKey(c.repo) === repoKey(me.repo) &&
      c.pr === me.pr,
  );
}

/**
 * Destroy the previews this run supersedes, and mark each superseded run.
 * Never throws: a preview is advisory, and so is its cleanup — the TTL is the
 * backstop for anything this could not remove.
 */
export async function supersedePreviews(opts: {
  runId: string;
  at?: string;
  input: { repo?: string; pr?: number; parentRunId?: string };
  preview: { url: string; branch?: string; revision?: string };
  target: PreviewTarget;
  lineage: PreviewLineage;
  now?: () => Date;
}): Promise<SupersedeOutcome> {
  const { input, preview, lineage } = opts;
  if (input.repo === undefined || input.pr === undefined) return { kind: "skipped", reason: "not a run on an existing pull request" };
  if (preview.branch === undefined) return { kind: "skipped", reason: "this preview recorded no slot, so older previews cannot be told apart from it" };
  try {
    const candidates = await supersededCandidates(
      {
        runId: opts.runId,
        repo: input.repo,
        pr: input.pr,
        slot: preview.branch,
        ...(preview.revision !== undefined ? { revision: preview.revision } : {}),
        ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
        ...(opts.at !== undefined ? { at: opts.at } : {}),
      },
      lineage,
    );
    const superseded: SupersededPreview[] = [];
    for (const c of candidates) {
      const base = { runId: c.runId, slot: c.slot!, ...(c.revision !== undefined ? { revision: c.revision } : {}) };
      if ((await lineage.marked(c.runId).catch(() => undefined)) !== undefined) {
        superseded.push({ ...base, result: "already-superseded" });
        continue;
      }
      const torn = await destroyPreview(resolvePreviewTarget(opts.target, c.app), c.slot!).catch((error: unknown) => ({
        kind: "failed" as const,
        reason: error instanceof Error ? error.message : String(error),
      }));
      // destroyPreview's vocabulary: `skipped` is success ("destroyed").
      if (torn.kind !== "skipped") {
        superseded.push({ ...base, result: "failed", detail: torn.kind === "failed" ? torn.reason : `unexpected destroy outcome: ${torn.kind}` });
        continue;
      }
      await lineage
        .mark(c.runId, {
          byRunId: opts.runId,
          ...(preview.revision !== undefined ? { revision: preview.revision } : {}),
          url: preview.url,
          at: (opts.now?.() ?? new Date()).toISOString(),
        })
        .catch(() => undefined);
      superseded.push({ ...base, result: "destroyed" });
    }
    return { kind: "done", superseded };
  } catch (error) {
    return { kind: "skipped", reason: `could not read earlier runs: ${error instanceof Error ? error.message : String(error)}` };
  }
}
