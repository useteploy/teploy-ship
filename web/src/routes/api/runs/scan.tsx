import { randomUUID } from "node:crypto";

import type { ActionArgs } from "@neutron-build/core";

import { actorFromPrincipal, enqueueRun } from "../../../lib/ship.server.js";
import { DailyBudgetExceededError, RepoNotAllowedError, assertRepoAllowedForOperator } from "../../../lib/scan.server.js";
import { currentUser } from "../../../lib/session.server.js";
import { may } from "../../../lib/authority.server.js";
import { defaultModel, shipRuntime } from "../../../lib/store.server.js";

export const config = { mode: "app" };

/**
 * Start a read-only scan run (L2 / D3).
 *
 * This is the nightly cron's front door. The MVP's cron shelled out to
 * `teploy-ship enqueue` with a long prose prompt asking the agent not to change
 * files and to write a findings file — the two things it could not be trusted
 * with and could not do. Here the mode is a field, so the same request cannot
 * be phrased in a way that publishes.
 *
 *   curl -sS -X POST "$SHIP_URL/api/runs/scan" \
 *     -H "authorization: Bearer $SHIP_WEB_TOKEN" -H "content-type: application/json" \
 *     -d '{"repo":"https://forge/tyler/teploy-cli"}'
 *
 * `source` defaults to "scan" so a night of scans is budgeted, capped and
 * reported as its own line rather than borrowing "manual"'s allowance —
 * `enqueueRun` refuses with 429 once that source has spent its day.
 */
interface ScanBody {
  repo?: string;
  /** What to look for. A sensible default, because most callers have no opinion. */
  task?: string;
  model?: string;
  /** Intake source the spend is counted against. Default "scan". */
  source?: string;
}

const DEFAULT_SCAN_TASK =
  "Audit this repository for defects, security issues, and the highest-value improvements. " +
  "Concentrate on things that are demonstrably wrong in the code as it stands — credentials in the tree, " +
  "unchecked external input, error paths that silently swallow failures, and documentation that contradicts " +
  "the source — over style preferences.";

export async function action({ request }: ActionArgs): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method not allowed — POST only" });
  const principal = await currentUser(request);
  if (principal === null) return json(401, { error: "unauthorized — send Authorization: Bearer <SHIP_WEB_TOKEN>" });
  // Same gate as the dashboard's new-run form (routes/index.tsx): starting a
  // run is spend authorisation, even when the run cannot change anything.
  if (!(await may("approve", principal))) {
    return json(403, { error: `${principal.user} (${principal.role}) may not start runs — the approve authority is not granted` });
  }

  let body: ScanBody;
  try {
    body = (await request.json()) as ScanBody;
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  const repo = (body.repo ?? "").trim();
  if (repo === "") return json(400, { error: "repo is required — a scan is about a repository" });

  const runtime = await shipRuntime();
  const runId = `run-${randomUUID().slice(0, 8)}`;
  try {
    // Refuse at the door. Without this the run is enqueued, picked up, and
    // dies at `repo-setup` with the same message buried in a step — and a cron
    // pointed at a repo Ship does not carry would burn a launch a night to
    // learn it.
    await assertRepoAllowedForOperator(runtime, repo);
    await enqueueRun(runtime, {
      runId,
      task: (body.task ?? "").trim() === "" ? DEFAULT_SCAN_TASK : body.task!.trim(),
      model: (body.model ?? "").trim() === "" ? defaultModel() : body.model!.trim(),
      mode: "scan",
      source: (body.source ?? "").trim() === "" ? "scan" : body.source!.trim(),
      actor: actorFromPrincipal(principal),
      repo,
      // An authenticated operator (or their cron, holding their token) named
      // this URL — checked against the allowlist just above, and checked again
      // next to the credential at `repo-setup` (durable.ts).
      trust: "operator",
    });
  } catch (error) {
    if (error instanceof DailyBudgetExceededError) {
      // 429, not 400: the request is well-formed and will succeed tomorrow.
      // This is the status the cron should back off on, and the reason the cron
      // could run seven unbounded scans a night before this existed.
      return json(429, { error: error.message, source: error.source, budget_usd: error.budgetUSD, committed_usd: error.committedUSD });
    }
    if (error instanceof RepoNotAllowedError) return json(403, { error: error.message });
    return json(400, { error: error instanceof Error ? error.message : String(error) });
  }
  return json(202, { run: runId, mode: "scan", repo, findings_url: `/api/runs/${runId}/findings` });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// A route with only server handlers still needs a default export or the router
// does not register it (see api/runs/[id]/decide.tsx).
export default function Never() {
  return null;
}
