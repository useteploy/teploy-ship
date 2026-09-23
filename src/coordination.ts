/**
 * Coordinated multi-repository work — the S18 starter: ONE parent intent, TWO
 * dependent children (an API repository first, a client repository second),
 * ordered by the API child's MERGE. Not a graph editor; the shape is fixed on
 * purpose so every state below can be explained in one sentence on one page.
 *
 * THE ORDERING RULE. The API child launches first. The client child is not
 * even enqueued until the API child's change MERGES, because "merged" is the
 * first moment a client change has something stable to build against. The
 * merge signal is `deliveryFromEvents` (delivery.ts) over the API run's own
 * recorded log — the same pure read the worker uses to propose a delivery
 * record (worker.ts) — never a status column and never the model's account.
 * Why that signal and not the delivery RECORD: the record is written by the
 * worker's terminal side effects, so reading it couples the ordering gate to
 * a sweep having run; the events are the authority the record itself is
 * derived from, they exist the moment the merge step records, and the same
 * read yields the merged SHA — the compatibility anchor the client task must
 * embed. The delivery record IS consulted, later, for the one thing only it
 * knows: whether a merged child has been promoted and read back CONFIRMED
 * ("delivered").
 *
 * THE HOLD. A FAILED API child holds the client forever-until-human: the
 * client moves to `held` with the reason, and nothing retries it by itself —
 * a dependent change launched past a failed producer is exactly the unsafe
 * delivery S18 exists to prevent. The human action is "retry API child",
 * which re-enqueues the API side (a NEW attempt, new run id) and releases the
 * hold. If the API child already merged and the CLIENT then fails, the API's
 * good work is preserved untouched — it is merged on the forge; nothing here
 * rolls anything back — and the client shows `failed` with its own retry.
 *
 * IDEMPOTENCE. Every enqueue goes through `launchNext`, one exported door the
 * sweep can call. The duplicate-launch guard is layered exactly like the
 * intake surfaces: (1) the child's pending→running claim is a fenced
 * conditional update on the coordination record — the loser of two racing
 * calls reads `running` and enqueues nothing; (2) the run id is DERIVED from
 * (coordination id, child, attempt), so a retried attempt of the same launch
 * computes the same run id, and the launch journal's assertSameLaunch makes
 * the re-call a republish rather than a second run.
 *
 * Storage follows the takeover config-key pattern: one JSON record per
 * coordination under SHIP_COORDINATION_<id>, plus an id index key for the
 * list surface (the runtime config store lists keys, never values). File-mode
 * honesty: the fences here are within-process (the config store has no
 * compare-and-swap); cross-process, the deterministic run id plus the launch
 * journal remains the idempotency boundary for the enqueue itself.
 *
 * S18 COMPLETION — three additions, all additive; a record written by the
 * starter replays through the same child states it always had.
 *
 * THE COMPATIBILITY CHECK. When the CLIENT's run merges, the pair is not done
 * yet: a scan-mode check run on the CLIENT repository verifies the client's
 * usage of the API (endpoints/imports/schema, as applicable) against the API
 * surface AT THE ANCHOR — the anchor is what the client was built against, so
 * the check proves the client did not drift from it. The check lives as a
 * sub-state field on the client child (`clientCheck`), never as a third
 * child, so the page stays two cards plus one verdict line. Read-only by the
 * same construction incidents.ts documents and cites: enqueueRun forces every
 * change-shaped flag off a scan at enqueue (runtime.ts, the `scan`
 * derivation), the loop refuses ```edit / ```create on a scan before they
 * reach an executor (durable.ts, the scanRun action guard), and
 * publishIfRepoRun returns before any step on a scan — "A SCAN PUBLISHES
 * NOTHING" (durable.ts) — so no branch is pushed and no pull request can be
 * opened. The clone is credential-free (git.ts setupRepo). The verdict is
 * graded with incidents' own confidence rules (gradeDiagnosis, reused for the
 * mismatch branch): claims need line-level citations, and anything the
 * findings cannot carry comes back `uncertain` — the human-decides verdict —
 * rather than being repeated back as fact. `incompatible` and `uncertain`
 * both HOLD the pair on a human with the check's evidence and three actions:
 * accept-risk (recorded, who and when), re-run the check (a new attempt), or
 * open a fix task (an intake proposal carrying the evidence). Only
 * `compatible` — or a recorded accept-risk over an imperfect verdict —
 * reaches the coordination's complete shape.
 *
 * INTEGRATION TESTING — the honest refusal. If both projects declare a test
 * command (evidence.ts stores the per-repo suite), the pair-level question
 * "does the client's suite pass against the API at anchorSha" arises — and a
 * scan CANNOT answer it by construction: enqueueRun forces `tests` off a scan
 * (runtime.ts: `const tests = scan ? undefined : ...`), so no suite step
 * exists on the run; the scan's sandbox holds only the client checkout, and
 * the clone is credential-free, so the API tree at the anchor is not present
 * and cannot be fetched for a private forge; and a suite run through ```
 * bash would be the model's own account with no recorded step — the opposite
 * of the graded-evidence discipline. So the check verifies STATIC
 * compatibility only (imports/urls/schema against the anchor's tree, which
 * the scan may attempt to obtain credential-free inside its sandbox), and the
 * child records `integrationTest: "not-executed (scan is read-only)"`. Real
 * pair integration testing rides a future non-scan check kind that has
 * execution authority over a two-repo workspace; that is a new journey, not a
 * field here.
 *
 * AGGREGATE COST. The coordination's spend is rolled up per child from the
 * runs' own recorded steps — the same read the worker's settle path uses
 * (usageFromEvents + costUSD, worker.ts/pricing.ts; attributed-spend.ts was
 * checked and holds only repo/actor/day buckets plus `attributionsFrom`, no
 * per-run read, so the per-run derivation is mirrored here rather than
 * invented twice). A run whose usage is `priced: false` consumed a quota, not
 * dollars: it makes the rollup `unknown`, never $0 — the P5-3 honesty rule
 * (spend.ts: unpriced runs are "never added to the dollar ledger and never
 * reported as $0; counted"). The rollup is DERIVED ON READ (the loader and
 * any list surface call rollupCoordinationCost); it is never stored, because
 * a stored total is stale the moment another attempt launches.
 */
import { createHash, randomUUID } from "node:crypto";

import { deliveryFromEvents } from "./delivery.js";
import { assertSafeId, withFileLock } from "./file-store.js";
import { canonicalRepositoryURL } from "./repository-reference.js";
import { assertRepoAllowedForOperator, enqueueRun } from "./runtime.js";
import { gradeDiagnosis } from "./incidents.js";
import { costUSD } from "./pricing.js";
import type { ParsedFindings, ScanFinding } from "./findings.js";
import type { Actor } from "./actor.js";
import type { ShipRuntime } from "./runtime.js";

/** Config key holding one coordination record. */
export const coordinationKey = (id: string): string => `SHIP_COORDINATION_${id}`;
/** Config key holding the id index (the config store lists keys, not values). */
export const COORDINATION_INDEX_KEY = "SHIP_COORDINATIONS";

export type CoordinationChildState = "pending" | "running" | "merged" | "delivered" | "failed" | "held";

const CHILD_STATES: readonly CoordinationChildState[] = ["pending", "running", "merged", "delivered", "failed", "held"];

/**
 * The client child's compatibility-check sub-state. `pending` and `running`
 * are the launch lifecycle; the three verdicts are terminal until a human
 * acts. `uncertain` is its own verdict, not a weaker `incompatible`: the
 * check could not carry its claim (no findings array, uncited mismatch,
 * stated low confidence), and incidents' rule applies — a human decides.
 * Absent entirely means the check is not due (the client has not merged).
 */
export type CoordinationCheckState = "pending" | "running" | "compatible" | "incompatible" | "uncertain";

/** The graded evidence a settled check run leaves on the client child. */
export interface CheckVerdict {
  verdict: "compatible" | "incompatible" | "uncertain";
  /** Incidents' confidence scale, applied by the same rules (gradeDiagnosis). */
  confidence: "high" | "medium" | "low";
  /** Why the verdict is what it is, in one sentence. */
  rationale: string;
  /** The check's own write-up, clamped. The run page keeps the full text. */
  summary: string;
  /** The mismatches the check cited (empty for a clean or empty-handed check). */
  findings: ScanFinding[];
  decidedAt: string;
  /** The check run the verdict came from; absent on an assembly failure. */
  runId?: string;
}

/** One half of the pair. Additive only; fields grow, never rename. */
export interface CoordinationChild {
  /** Canonical full-origin repository identity (validated at creation). */
  repo: string;
  /** The run this attempt lives in; absent until first launch. */
  runId?: string;
  state: CoordinationChildState;
  /** Launches claimed so far (successful or accepted); the run id derives from it. */
  attempts: number;
  /**
   * The merged commit this side runs against. For the API child that is its
   * OWN merge (the anchor the client builds on); for the client child the
   * starter overloaded this field with the API anchor at launch and the
   * client's OWN merged sha after its merge — see `mergedSha`.
   */
  anchorSha?: string;
  /**
   * The child's OWN merged commit, recorded at the merge alongside the
   * historical anchorSha write. The check task needs the client's merged sha
   * AND the API anchor at once, which the overloaded anchorSha field cannot
   * hold; for records the starter already drove to a client merge, the
   * clobbered anchorSha holds the client's own sha and is the fallback.
   */
  mergedSha?: string;
  /** Why a held child is parked on a human. */
  holdReason?: string;
  /** How a failed child ended, in one line. */
  failReason?: string;
  /** The last enqueue error, for the surface; cleared by the next claim. */
  lastError?: string;
  /**
   * Compatibility-check sub-state (see the module header). Absent = not due;
   * set the moment the client merges and the pair owes a check.
   */
  clientCheck?: CoordinationCheckState;
  /** The check run this attempt lives in; absent until the check launches. */
  checkRunId?: string;
  /** Check launches claimed so far; the check run id derives from it. */
  checkAttempts?: number;
  /** Present once a check run settled and was graded. */
  checkVerdict?: CheckVerdict;
  /** The accept-risk decision over an incompatible/uncertain verdict. */
  checkAccepted?: { by: string; at: string };
  /**
   * The pair-level integration-test honesty field, recorded when the check
   * launches: "not-executed (scan is read-only)" when both projects declare
   * a suite, "not-applicable (both projects must declare a test command)"
   * otherwise. See the module header for why scan mode cannot execute suites.
   */
  integrationTest?: string;
}

export interface CoordinationRecord {
  id: string;
  parentIntent: string;
  /** Model the children run on, fixed at creation so retries replay the same ask. */
  model: string;
  /** Who created the coordination; recorded on every child run it launches. */
  actor?: Actor;
  api: CoordinationChild;
  client: CoordinationChild;
  createdAt: string;
  updatedAt: string;
}

/** What one call to launchNext did, for the sweep's log and the surfaces. */
export interface LaunchOutcome {
  record: CoordinationRecord;
  /** The check launch widened this additively; worker.ts ignores the field. */
  launched: "api" | "client" | "check" | null;
  runId?: string;
  note: string;
}

/**
 * Create a coordination: validate the pair, record it, launch NOTHING. The
 * caller (the route after an approval-grade submit, or the sweep) starts work
 * through launchNext, which is the only door that enqueues.
 */
export async function createCoordination(
  runtime: ShipRuntime,
  options: { parentIntent: string; apiRepo: string; clientRepo: string; model: string; actor?: Actor },
): Promise<CoordinationRecord> {
  const intent = options.parentIntent.trim();
  if (intent === "" || intent.length > 20000) throw new Error("Describe the parent intent in 20,000 characters or fewer.");
  const model = options.model.trim();
  if (model === "") throw new Error("A coordination needs the model its children run on.");
  const apiRepo = canonicalRepoOrRefuse(options.apiRepo, "API");
  const clientRepo = canonicalRepoOrRefuse(options.clientRepo, "client");
  if (apiRepo === clientRepo) {
    throw new Error("An API/client pair needs two different repositories — one repository is a single change, not a coordination.");
  }
  // The repos were typed by an authenticated human (operator trust), and the
  // allowlist still binds — refuse at the door rather than enqueuing runs that
  // die at repo-setup twenty seconds later.
  await assertRepoAllowedForOperator(runtime, apiRepo);
  await assertRepoAllowedForOperator(runtime, clientRepo);

  const now = new Date().toISOString();
  const record: CoordinationRecord = {
    id: `coord-${randomUUID()}`,
    parentIntent: intent,
    model,
    ...(options.actor !== undefined ? { actor: options.actor } : {}),
    api: { repo: apiRepo, state: "pending", attempts: 0 },
    client: { repo: clientRepo, state: "pending", attempts: 0 },
    createdAt: now,
    updatedAt: now,
  };
  const config = runtime.config;
  await withFileLock(coordinationKey(record.id), async () => {
    await config.set(coordinationKey(record.id), JSON.stringify(record), "coordination");
    const ids = readIndex(await config.get(COORDINATION_INDEX_KEY));
    await config.set(COORDINATION_INDEX_KEY, JSON.stringify([...ids, record.id]), "coordination");
  });
  return record;
}

/** The record, or null when none exists. Unreadable JSON is null, as in takeover. */
export async function loadCoordination(runtime: ShipRuntime, id: string): Promise<CoordinationRecord | null> {
  assertSafeId("coordination id", id);
  const raw = await runtime.config.get(coordinationKey(id));
  if (raw === undefined || raw === "") return null;
  let parsed: CoordinationRecord;
  try {
    parsed = JSON.parse(raw) as CoordinationRecord;
  } catch {
    return null;
  }
  if (
    typeof parsed.id !== "string" || parsed.id !== id ||
    typeof parsed.parentIntent !== "string" || typeof parsed.model !== "string" ||
    validChild(parsed.api) === null || validChild(parsed.client) === null
  ) {
    return null;
  }
  return parsed;
}

/** All coordinations, newest first (the page surface). */
export async function listCoordinations(runtime: ShipRuntime): Promise<CoordinationRecord[]> {
  const ids = readIndex(await runtime.config.get(COORDINATION_INDEX_KEY));
  const records: CoordinationRecord[] = [];
  for (const id of ids) {
    const record = await loadCoordination(runtime, id);
    if (record !== null) records.push(record);
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Refresh both children's states from their runs' own recorded logs. Launches
 * nothing — the page loader calls this so what it renders is what happened,
 * and launchNext calls it before deciding. States only move FORWARD here:
 * running→merged/delivered/failed (the run's outcome), merged→delivered (the
 * delivery record's confirmation). `held` and `failed` never move — they are
 * the human's to act on, and pending is the claim's to take.
 */
export async function observeCoordination(runtime: ShipRuntime, record: CoordinationRecord): Promise<CoordinationRecord> {
  let next = record;
  for (const which of ["api", "client"] as const) {
    const child = next[which];
    if (child.runId === undefined) continue;
    if (child.state === "running") {
      const derived = await deriveRunOutcome(runtime, child);
      if (derived.state === "merged" && (await deliveryConfirmed(runtime, child.runId))) {
        // Merged and already promoted-and-read-back in one pass.
        next = await patchChild(runtime.config, next.id, which, {
          state: "delivered",
          anchorSha: derived.mergedSha,
          ...(derived.mergedSha !== undefined ? { mergedSha: derived.mergedSha } : {}),
        });
      } else if (derived.state !== "running") {
        next = await patchChild(runtime.config, next.id, which, {
          state: derived.state,
          // The anchorSha write is the starter's own (including its sha-less
          // merge clearing the field); mergedSha is added alongside, never
          // instead, so an existing record's replay is unchanged.
          ...(derived.state === "merged" ? { anchorSha: derived.mergedSha } : {}),
          ...(derived.state === "merged" && derived.mergedSha !== undefined ? { mergedSha: derived.mergedSha } : {}),
          ...(derived.state === "failed" ? { failReason: derived.reason } : {}),
        });
      }
    } else if (child.state === "merged") {
      if (await deliveryConfirmed(runtime, child.runId)) {
        next = await patchChild(runtime.config, next.id, which, { state: "delivered" });
      }
    }
  }
  return observeCheck(runtime, next);
}

/**
 * THE single enqueue door. Observes, then acts in a fixed order: repair a
 * claimed-but-lost launch, start the API child, hold the client on an API
 * failure, start the client once the API side merged, start the compatibility
 * check once the client merged. Safe to call as often as the sweep ticks;
 * every enqueue is fenced and idempotent.
 */
export async function launchNext(runtime: ShipRuntime, coordinationId: string): Promise<LaunchOutcome> {
  let record = await loadCoordination(runtime, assertSafeId("coordination id", coordinationId));
  if (record === null) throw new Error(`No coordination ${coordinationId}`);
  record = await observeCoordination(runtime, record);
  record = await repairLostLaunches(runtime, record);

  if (record.api.state === "pending") {
    return launchChild(runtime, record, "api");
  }
  if (record.api.state === "failed") {
    if (record.client.state === "pending") {
      const held = await patchChild(runtime.config, record.id, "client", {
        state: "held",
        holdReason: `The API change failed before merging (${record.api.failReason ?? "run failed"}). The client task will not start until a person retries the API side or abandons this coordination.`,
      });
      return { record: held, launched: null, note: "api child failed before merging; client held for a human" };
    }
    return { record, launched: null, note: "api child failed; client already held or acted on" };
  }
  if (record.api.state === "merged" || record.api.state === "delivered") {
    if (record.client.state === "pending") {
      // The compatibility anchor is the API merge's own sha. A merge recorded
      // without one cannot anchor anything: hold the client visibly rather
      // than launching a "compatible" change against a commit nobody can name.
      const anchor = record.api.anchorSha;
      if (anchor === undefined) {
        const held = await patchChild(runtime.config, record.id, "client", {
          state: "held",
          holdReason: "The API merge was recorded without a commit sha, so there is no compatibility anchor to build against. Confirm the merged commit, then retry the client side.",
        });
        return { record: held, launched: null, note: "api merged without a proven sha; client held" };
      }
      return launchChild(runtime, record, "client", anchor);
    }
    // The client merged: the pair owes its compatibility check before it can
    // be called done (module header, "THE COMPATIBILITY CHECK"). Absent means
    // not due yet OR due-for-the-first-time; "pending" also covers a human
    // re-run. Every other check state is terminal on a human or already good.
    if (record.client.state === "merged" || record.client.state === "delivered") {
      const check = record.client.clientCheck;
      if (check === undefined || check === "pending") {
        return launchCheck(runtime, record);
      }
    }
  }
  return { record, launched: null, note: stateNote(record) };
}

/**
 * The human retry (approval-grade in the UI: it launches work). A failed API
 * child goes back to pending AND a held client is released with it — the
 * retry IS the human decision the hold was waiting for. A failed or held
 * client goes back to pending against the API side as it stands. The enqueue
 * itself happens through launchNext, like every other.
 */
export async function retryCoordinationChild(
  runtime: ShipRuntime,
  coordinationId: string,
  which: "api" | "client",
): Promise<LaunchOutcome> {
  const record = await loadCoordination(runtime, assertSafeId("coordination id", coordinationId));
  if (record === null) throw new Error(`No coordination ${coordinationId}`);
  await withFileLock(coordinationKey(record.id), async () => {
    const current = await loadCoordination(runtime, coordinationId);
    if (current === null) throw new Error(`No coordination ${coordinationId}`);
    if (current[which].state !== "failed" && current[which].state !== "held") {
      throw new Error(`The ${which} side is ${current[which].state} — only a failed or held child can be retried.`);
    }
    const next: CoordinationRecord = { ...current, updatedAt: new Date().toISOString() };
    next[which] = { ...next[which], state: "pending", failReason: undefined, holdReason: undefined, lastError: undefined };
    if (which === "api" && next.client.state === "held") {
      next.client = { ...next.client, state: "pending", holdReason: undefined };
    }
    await runtime.config.set(coordinationKey(coordinationId), JSON.stringify(next), "coordination");
  });
  return launchNext(runtime, coordinationId);
}

/**
 * The human re-run of a check that reported drift or uncertainty: back to
 * pending (a NEW attempt id) with the old verdict and any accept-risk cleared
 * — an acceptance bought with one verdict must not silently cover the next.
 * The enqueue happens through launchNext, like every other.
 */
export async function retryCoordinationCheck(
  runtime: ShipRuntime,
  coordinationId: string,
): Promise<LaunchOutcome> {
  const record = await loadCoordination(runtime, assertSafeId("coordination id", coordinationId));
  if (record === null) throw new Error(`No coordination ${coordinationId}`);
  await withFileLock(coordinationKey(coordinationId), async () => {
    const current = await loadCoordination(runtime, coordinationId);
    if (current === null) throw new Error(`No coordination ${coordinationId}`);
    const check = current.client.clientCheck;
    if (check !== "incompatible" && check !== "uncertain") {
      throw new Error(`The compatibility check is ${check ?? "not due"} — only an incompatible or uncertain verdict can be re-run.`);
    }
    const next: CoordinationRecord = { ...current, updatedAt: new Date().toISOString() };
    next.client = { ...next.client, clientCheck: "pending", checkVerdict: undefined, checkAccepted: undefined };
    await runtime.config.set(coordinationKey(coordinationId), JSON.stringify(next), "coordination");
  });
  return launchNext(runtime, coordinationId);
}

/**
 * Accept the risk of an incompatible or uncertain verdict: the recorded human
 * decision that lets the pair finish anyway. Approval-grade at the route (it
 * is the one action that can wave drift through); fenced to exactly the two
 * verdicts a human may accept, exactly once.
 */
export async function acceptCheckRisk(
  runtime: ShipRuntime,
  coordinationId: string,
  actor: Actor,
): Promise<CoordinationRecord> {
  let saved: CoordinationRecord | null = null;
  await withFileLock(coordinationKey(assertSafeId("coordination id", coordinationId)), async () => {
    const current = await loadCoordination(runtime, coordinationId);
    if (current === null) throw new Error(`No coordination ${coordinationId}`);
    const check = current.client.clientCheck;
    if (check !== "incompatible" && check !== "uncertain") {
      throw new Error(`The compatibility check is ${check ?? "not due"} — there is no verdict risk to accept.`);
    }
    if (current.client.checkAccepted !== undefined) {
      throw new Error("This verdict's risk was already accepted — re-run the check if the decision changed.");
    }
    const next: CoordinationRecord = { ...current, updatedAt: new Date().toISOString() };
    next.client = { ...next.client, checkAccepted: { by: actor.id, at: new Date().toISOString() } };
    await runtime.config.set(coordinationKey(coordinationId), JSON.stringify(next), "coordination");
    saved = next;
  });
  return saved!;
}

/**
 * Open the fix task a held check offers: an ordinary intake proposal on the
 * client repo carrying the verdict's evidence, deduped per check attempt so
 * a repeat click is idempotent. Turning the diagnosis into a change stays a
 * separate, explicitly launched journey — the incidents module's rule, kept
 * here.
 */
export async function proposeCheckFixTask(
  runtime: ShipRuntime,
  coordinationId: string,
  actor?: Actor,
): Promise<{ taskId: string; created: boolean }> {
  const record = await loadCoordination(runtime, assertSafeId("coordination id", coordinationId));
  if (record === null) throw new Error(`No coordination ${coordinationId}`);
  const check = record.client.clientCheck;
  const verdict = record.client.checkVerdict;
  if ((check !== "incompatible" && check !== "uncertain") || verdict === undefined) {
    throw new Error(`A fix task is offered only when the compatibility check reported drift or uncertainty (check: ${check ?? "not due"}).`);
  }
  const evidence =
    verdict.findings.length > 0
      ? verdict.findings
          .map((f) => `- ${f.title} (${f.file}${f.line !== undefined ? `:${f.line}` : ""}) — ${f.detail}${f.fix !== undefined ? ` Fix: ${f.fix}` : ""}`)
          .join("\n")
      : "- (the check cited no specific finding — read its write-up on the run page)";
  const detail = [
    record.parentIntent,
    "",
    `The coordination's compatibility check reported ${check}: ${verdict.rationale}.`,
    `Client merged commit: ${record.client.mergedSha ?? record.client.anchorSha ?? "(unproven)"}; API compatibility anchor: ${record.api.anchorSha ?? "(unproven)"}.`,
    `Check run: ${verdict.runId ?? "(none)"}.`,
    "",
    "Cited evidence:",
    evidence,
    "",
    "Fix the client's drift from the API surface at the anchor (or correct the check's finding if it was wrong).",
  ].join("\n");
  const { task, created } = await runtime.intake.propose({
    source: "coordination",
    kind: "task",
    repo: record.client.repo,
    title: `Fix client/API compatibility drift (${coordinationId})`,
    detail,
    dedupeKey: `coordination:${coordinationId}:check-fix:${record.client.checkAttempts ?? 0}`,
    ...(actor !== undefined ? { requestedBy: actor.id } : {}),
  });
  return { taskId: task.taskId, created };
}

/**
 * The coordination's complete shape: both sides merged or delivered AND the
 * check compatible — or an imperfect verdict explicitly accepted by a human.
 * Everything else is still in flight or parked on someone.
 */
export function coordinationComplete(record: CoordinationRecord): boolean {
  const landed = (child: CoordinationChild) => child.state === "merged" || child.state === "delivered";
  if (!landed(record.api) || !landed(record.client)) return false;
  const check = record.client.clientCheck;
  if (check === "compatible") return true;
  if ((check === "incompatible" || check === "uncertain") && record.client.checkAccepted !== undefined) return true;
  return false;
}

/**
 * The sweep leg: advance every coordination once (children, holds, checks),
 * collecting per-record errors instead of throwing — the same rule the other
 * sweep legs run under. The worker's existing per-coordination launchNext
 * loop (worker.ts) already drives everything this does; this is the one-call
 * shape for an orchestrator that prefers it.
 */
export async function sweepCoordinations(
  runtime: ShipRuntime,
): Promise<{ advanced: number; errors: Array<{ id: string; error: string }> }> {
  let advanced = 0;
  const errors: Array<{ id: string; error: string }> = [];
  for (const record of await listCoordinations(runtime)) {
    try {
      const outcome = await launchNext(runtime, record.id);
      if (outcome.launched !== null) advanced += 1;
    } catch (error) {
      errors.push({ id: record.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { advanced, errors };
}

// --------------------------------------------------------------- aggregate cost

/** One side's rolled-up spend. `unknown` is a recorded answer, never $0. */
export interface CostRollup {
  costUsd: number;
  /** True when any run consumed a quota Ship cannot price (P5-3). */
  unknown: boolean;
  /** Runs that exist and were read (attempts that never launched are skipped). */
  runs: number;
}

/** The coordination's whole spend picture, derived on read, never stored. */
export interface CoordinationCost {
  api: CostRollup;
  client: CostRollup;
  check: CostRollup;
  total: { costUsd: number; unknown: boolean };
}

/**
 * Sum every model call recorded in a run's step log — the worker's own
 * usageFromEvents (worker.ts), mirrored here rather than imported because
 * worker.ts imports this module and a cycle is a fragile way to borrow twenty
 * lines. One unpriced leg makes the whole usage unpriced, exactly as there.
 */
interface RecordedUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  priced?: boolean;
  costUSD?: number;
}

function usageFromSteps(events: Array<{ type: string; data?: unknown }>): RecordedUsage | undefined {
  const total: RecordedUsage & { inputTokens: number; outputTokens: number; totalTokens: number } = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  let found = false;
  for (const event of events) {
    if (event.type !== "step-completed") continue;
    const usage = (event.data as { result?: { usage?: RecordedUsage } } | undefined)?.result?.usage;
    if (usage === undefined || typeof usage !== "object") continue;
    found = true;
    total.inputTokens += usage.inputTokens ?? 0;
    total.outputTokens += usage.outputTokens ?? 0;
    total.totalTokens += usage.totalTokens ?? 0;
    if (usage.cacheReadTokens !== undefined) total.cacheReadTokens = (total.cacheReadTokens ?? 0) + usage.cacheReadTokens;
    if (usage.cacheWriteTokens !== undefined) total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
    if (usage.priced === false) total.priced = false;
    if (typeof usage.costUSD === "number" && total.priced !== false) total.costUSD = (total.costUSD ?? 0) + usage.costUSD;
  }
  if (found && total.priced === false) delete total.costUSD;
  return found ? total : undefined;
}

/**
 * Roll one child's spend up across its attempts (and the check's attempts for
 * the check roll): each attempt's run id is derived, its events are read, and
 * the cost is the same read the worker settles with — costUSD over the usage
 * recovered from the recorded steps. An attempt whose run never landed has no
 * events and contributes nothing (no spend, not unknown). A run whose usage is
 * `priced: false` makes the roll UNKNOWN, never $0 — the P5-3 rule (spend.ts:
 * unpriced runs are counted, "never reported as $0"). In-flight runs show
 * their spend so far, because the steps are the authority either way.
 */
async function costOfRuns(runtime: ShipRuntime, model: string, runIds: string[]): Promise<CostRollup> {
  let costUsd = 0;
  let unknown = false;
  let runs = 0;
  for (const runId of runIds) {
    const events = (await runtime.store.load(runId)) as Array<{ type: string; data?: unknown }>;
    if (events === undefined || events.length === 0) continue;
    runs += 1;
    const usage = usageFromSteps(events);
    if (usage === undefined) continue;
    if (usage.priced === false) {
      unknown = true;
      continue;
    }
    costUsd += costUSD(model, usage);
  }
  return { costUsd, unknown, runs };
}

/** The coordination's aggregate cost: per child, the check, and the total. */
export async function rollupCoordinationCost(runtime: ShipRuntime, record: CoordinationRecord): Promise<CoordinationCost> {
  const attemptIds = (child: CoordinationChild): string[] =>
    Array.from({ length: child.attempts }, (_v, i) => childRunId(record.id, child === record.api ? "api" : "client", i + 1));
  const checkIds = Array.from(
    { length: record.client.checkAttempts ?? 0 },
    (_v, i) => checkRunId(record.id, i + 1),
  );
  const [api, client, check] = await Promise.all([
    costOfRuns(runtime, record.model, attemptIds(record.api)),
    costOfRuns(runtime, record.model, attemptIds(record.client)),
    costOfRuns(runtime, record.model, checkIds),
  ]);
  return {
    api,
    client,
    check,
    total: { costUsd: api.costUsd + client.costUsd + check.costUsd, unknown: api.unknown || client.unknown || check.unknown },
  };
}

// ---------------------------------------------------------------------------
// internals

function canonicalRepoOrRefuse(value: string, side: string): string {
  const trimmed = value.trim();
  const canonical = canonicalRepositoryURL(trimmed);
  if (canonical === null) {
    throw new Error(`Enter the ${side} repository as a full clone URL (for example https://forge.example/team/repo.git) with no credentials.`);
  }
  return canonical;
}

function validChild(child: unknown): CoordinationChild | null {
  if (child === null || typeof child !== "object") return null;
  const c = child as Partial<CoordinationChild>;
  if (typeof c.repo !== "string" || c.repo === "") return null;
  if (typeof c.state !== "string" || !CHILD_STATES.includes(c.state as CoordinationChildState)) return null;
  if (typeof c.attempts !== "number" || !Number.isSafeInteger(c.attempts) || c.attempts < 0) return null;
  return c as CoordinationChild;
}

function readIndex(raw: string | undefined): string[] {
  if (raw === undefined || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9-]+$/.test(id));
  } catch {
    return [];
  }
}

/** One unconditional child patch, locked per record (used by observe's forward moves). */
async function patchChild(
  config: ShipRuntime["config"],
  id: string,
  which: "api" | "client",
  patch: Partial<CoordinationChild>,
): Promise<CoordinationRecord> {
  return withFileLock(coordinationKey(id), async () => {
    const record = await readForUpdate(config, id);
    const next: CoordinationRecord = { ...record, updatedAt: new Date().toISOString() };
    next[which] = { ...next[which], ...patch };
    await config.set(coordinationKey(id), JSON.stringify(next), "coordination");
    return next;
  });
}

/**
 * The fenced claim: apply `patch` only while the child is in `expect`. The
 * loser of two racing claims reads a different state and gets null — that is
 * the duplicate-launch guard's first layer. `patch` sees the current child so
 * it can derive the run id from the attempt it is claiming.
 */
async function claimChild(
  config: ShipRuntime["config"],
  id: string,
  which: "api" | "client",
  expect: CoordinationChildState,
  patch: (child: CoordinationChild) => Partial<CoordinationChild>,
): Promise<CoordinationRecord | null> {
  return withFileLock(coordinationKey(id), async () => {
    const record = await readForUpdate(config, id);
    if (record[which].state !== expect) return null;
    const next: CoordinationRecord = { ...record, updatedAt: new Date().toISOString() };
    next[which] = { ...next[which], ...patch(record[which]) };
    await config.set(coordinationKey(id), JSON.stringify(next), "coordination");
    return next;
  });
}

async function readForUpdate(config: ShipRuntime["config"], id: string): Promise<CoordinationRecord> {
  const raw = await config.get(coordinationKey(id));
  if (raw === undefined) throw new Error(`No coordination ${id}`);
  const record = JSON.parse(raw) as CoordinationRecord;
  if (record.id !== id) throw new Error("Coordination record identity mismatch");
  return record;
}

/** The run id for one launch attempt: stable per (coordination, child, attempt). */
function childRunId(coordinationId: string, which: "api" | "client", attempt: number): string {
  const digest = createHash("sha256").update(`${coordinationId}:${which}:${attempt}`).digest("hex").slice(0, 24);
  return `run-coord-${digest}`;
}

/** The run id for one CHECK attempt: stable per (coordination, attempt), same derivation shape. */
function checkRunId(coordinationId: string, attempt: number): string {
  const digest = createHash("sha256").update(`${coordinationId}:check:${attempt}`).digest("hex").slice(0, 24);
  return `run-coord-check-${digest}`;
}

/**
 * The one fact only the delivery record knows: the merged change was promoted
 * and read back CONFIRMED (S14's own surface drives that pipeline; see
 * src/delivery.ts for its state machine).
 */
async function deliveryConfirmed(runtime: ShipRuntime, runId: string): Promise<boolean> {
  const delivery = await runtime.deliveryRecords?.get(runId);
  return delivery?.state === "confirmed";
}

/** The merge/failure facts a child's own log admits; `running` when neither yet. */
async function deriveRunOutcome(
  runtime: ShipRuntime,
  child: CoordinationChild,
): Promise<{ state: "running" } | { state: "merged"; mergedSha?: string } | { state: "failed"; reason: string }> {
  const runId = child.runId!;
  const [meta, events] = await Promise.all([runtime.loadMeta(runId), runtime.store.load(runId)]);
  // MERGED is read off the recorded steps — the same derivation the worker
  // uses to propose the delivery record — so the gate and the record can
  // never disagree about what merged.
  const facts = deliveryFromEvents(runId, child.repo, events);
  if (facts !== null) return { state: "merged", mergedSha: facts.mergedSha };
  const status = meta?.status;
  if (status === "failed") return { state: "failed", reason: "the run failed" };
  if (status === "cancelled") return { state: "failed", reason: "the run was cancelled" };
  // A change run that finishes without a merged change did not satisfy the
  // dependency — for the API side that means the client must hold, and for
  // the client it means the pair did not land. Say so; never guess merged.
  if (status === "completed") return { state: "failed", reason: "the run finished without a merged change" };
  return { state: "running" };
}

function apiTask(record: CoordinationRecord): string {
  return [
    record.parentIntent,
    "",
    `[Coordination ${record.id} — API side] This is the producer half of a coordinated change across two repositories. Make the API-side change here. The dependent client-side change is not launched until this change merges; it will build against your merged commit.`,
  ].join("\n");
}

// ------------------------------------------------------- the compatibility check

/**
 * Grade a settled check run's findings + write-up into a verdict, using
 * incidents' own confidence rules wherever a mismatch is claimed.
 *
 * - no findings array located at all → `uncertain`: the check delivered
 *   nothing structured, and prose alone cannot gate a pair (findings.ts's
 *   forcing function, applied to checks);
 * - mismatch findings present → incidents' gradeDiagnosis decides whether the
 *   claim can carry them: a low-confidence grade (no stated confidence, or no
 *   line-level citations) downgrades an asserted mismatch to `uncertain` — a
 *   human decides — while a carried claim is `incompatible`;
 * - an explicit empty array is the clean answer, and the SAME discipline
 *   applies to it: a compatibility claim must state its confidence
 *   ("Confidence: high/medium/low"); absent or low → `uncertain`.
 */
export function gradeCheck(
  parsed: ParsedFindings,
  summary: string,
): { verdict: "compatible" | "incompatible" | "uncertain"; confidence: "high" | "medium" | "low"; rationale: string } {
  if (!parsed.found) {
    return {
      verdict: "uncertain",
      confidence: "low",
      rationale: "the check finished without a findings array — its prose write-up is on the run page, but nothing structured backs a verdict",
    };
  }
  if (parsed.findings.length > 0) {
    const graded = gradeDiagnosis(parsed, summary);
    if (graded.confidence === "low") {
      return {
        verdict: "uncertain",
        confidence: "low",
        rationale: `mismatch findings were reported, but ${graded.uncertainty.rationale} — a human decides whether the drift is real`,
      };
    }
    return { verdict: "incompatible", confidence: graded.confidence, rationale: graded.uncertainty.rationale };
  }
  // The incidents regex, applied to the clean claim: gradeDiagnosis itself
  // grades zero-findings write-ups low by construction (for incidents, no
  // findings means nothing located the cause), so the clean branch reads the
  // same line itself rather than reusing the call that cannot say it.
  const claim = /\bconfidence\s*:\s*(high|medium|low)\b/i.exec(summary);
  if (claim === null) {
    return {
      verdict: "uncertain",
      confidence: "low",
      rationale: "claims compatible without stating a confidence level — an unreported uncertainty is not accepted as a clean verdict",
    };
  }
  const claimed = claim[1]!.toLowerCase() as "high" | "medium" | "low";
  if (claimed === "low") {
    return { verdict: "uncertain", confidence: "low", rationale: "stated low confidence in its own compatibility verdict" };
  }
  return { verdict: "compatible", confidence: claimed, rationale: `stated ${claimed} with an explicit no-mismatch findings array` };
}

/**
 * The task the check run carries. The client's merged sha, the API repo and
 * the anchor are embedded as FACTS the verdict must be grounded in; the
 * read-only instruction is belt to scan mode's own enforcement (module
 * header). The workspace caveat is stated so the check cannot quietly verify
 * against the wrong tree: it may ATTEMPT a credential-free read of the API at
 * the anchor (bash is not refused on a scan; the publish gate is what bounds
 * it), and where it cannot obtain the tree it must say so and grade itself
 * down rather than guess the surface.
 */
function checkTask(
  record: CoordinationRecord,
  input: { clientMergedSha: string; apiRepo: string; apiAnchor: string; integrationTest: string },
): string {
  return [
    record.parentIntent,
    "",
    `[Coordination ${record.id} — compatibility check, read-only] The client repository (this workspace) merged commit ${input.clientMergedSha}, built against the API repository ${input.apiRepo} at commit ${input.apiAnchor} — the compatibility anchor. Verify this client's usage of the API matches the API's surface AT THE ANCHOR: the endpoints it calls, the modules and types it imports, the request/response schemas it relies on, as applicable to how this client consumes the API. The check proves the client did not drift from the anchor it was built against.`,
    "",
    "This workspace holds only the client repository; the API repository is not checked out here. You may attempt a credential-free read of the API's tree at the anchor from inside this sandbox (nothing you do here publishes), and if you cannot obtain it, say so plainly and reflect that in your confidence — do not guess the API's surface.",
    "",
    "Deliver all of the following:",
    "1. A FINDINGS_JSON array (it may be empty): one entry per incompatibility — a client usage that does not match the API at the anchor — each citing its file and line IN THIS repository, with a detail naming both sides of the mismatch and a fix sketch. An explicit empty array is the answer when the usage matches.",
    "2. An uncertainty report at the end of the write-up, on its own lines, exactly this shape:",
    "Confidence: high",
    "Would raise: what evidence would move this up one level",
    "Use high, medium or low. A verdict you cannot cite is worthless: claims need file and line.",
    "",
    `Pair-level integration testing: ${input.integrationTest}. This check is static — do not present suite output as check evidence.`,
  ].join("\n");
}

/**
 * Observe the client's in-flight check run and record its graded verdict.
 * Forward-only, like the child observation beside it: `running` is the only
 * state that can move here, and only to a verdict. The READ-ONLY GUARD is
 * incidents' digestIncident rule: the run's RECORDED input must say
 * `mode: "scan"` before anything is graded, so a coordination can never
 * swallow a fix run's output as a verdict.
 */
async function observeCheck(runtime: ShipRuntime, record: CoordinationRecord): Promise<CoordinationRecord> {
  const client = record.client;
  if (client.clientCheck !== "running" || client.checkRunId === undefined) return record;
  if (client.state !== "merged" && client.state !== "delivered") return record;
  const derived = await deriveCheckOutcome(runtime, record);
  if (derived.state === "running") return record;
  return patchChild(runtime.config, record.id, "client", {
    clientCheck: derived.verdict.verdict,
    checkVerdict: derived.verdict,
  });
}

/** The verdict facts a check run's own log admits; `running` when neither yet. */
async function deriveCheckOutcome(
  runtime: ShipRuntime,
  record: CoordinationRecord,
): Promise<{ state: "running" } | { state: "done"; verdict: CheckVerdict }> {
  const runId = record.client.checkRunId!;
  const [meta, events] = await Promise.all([runtime.loadMeta(runId), runtime.store.load(runId)]);
  // No run anywhere: nothing to grade and nothing to hold — the lost-launch
  // repair owns giving the claim back, and it runs after this.
  if (meta === null && events.length === 0) return { state: "running" };
  const started = events.find((e) => e.type === "run-started");
  const input = (started?.data as { input?: { mode?: string } } | undefined)?.input;
  if (input?.mode !== "scan") {
    return {
      state: "done",
      verdict: {
        verdict: "uncertain",
        confidence: "low",
        rationale: `the linked check run ${runId} is not a read-only scan (recorded mode: ${input?.mode ?? "unset"}) — refusing to grade it`,
        summary: "",
        findings: [],
        decidedAt: new Date().toISOString(),
        runId,
      },
    };
  }
  const terminal = events.find((e) => e.type === "run-completed" || e.type === "run-failed" || e.type === "run-cancelled");
  const status =
    terminal !== undefined
      ? terminal.type === "run-completed"
        ? "completed"
        : terminal.type === "run-failed"
          ? "failed"
          : "cancelled"
      : meta?.status;
  if (status !== "completed" && status !== "failed" && status !== "cancelled") return { state: "running" };
  const now = new Date().toISOString();
  if (status !== "completed") {
    return {
      state: "done",
      verdict: {
        verdict: "uncertain",
        confidence: "low",
        rationale: `the check run ${status} before delivering a verdict — its partial write-up, if any, is on the run page`,
        summary: "",
        findings: [],
        decidedAt: now,
        runId,
      },
    };
  }
  const step = events.find((e) => e.type === "step-completed" && e.name === "scan-findings");
  const parsed = (step?.data as { result?: ParsedFindings } | undefined)?.result;
  const summary = String(
    (terminal?.data as { output?: { summary?: unknown } } | undefined)?.output?.summary ?? "",
  ).slice(0, 4000);
  if (parsed === undefined || parsed.found !== true) {
    return {
      state: "done",
      verdict: {
        verdict: "uncertain",
        confidence: "low",
        rationale: "the check finished without a findings array — nothing structured to grade",
        summary,
        findings: [],
        decidedAt: now,
        runId,
      },
    };
  }
  const graded = gradeCheck(parsed, summary);
  return {
    state: "done",
    verdict: { ...graded, summary, findings: parsed.findings, decidedAt: now, runId },
  };
}

/**
 * The check's fenced claim: applies `patch` only while clientCheck is absent
 * (due for the first time) or `pending` (a human re-run / a reverted claim).
 * Same shape as claimChild, one field over.
 */
async function claimCheck(
  config: ShipRuntime["config"],
  id: string,
  patch: (child: CoordinationChild) => Partial<CoordinationChild>,
): Promise<CoordinationRecord | null> {
  return withFileLock(coordinationKey(id), async () => {
    const record = await readForUpdate(config, id);
    const current = record.client.clientCheck;
    if (current !== undefined && current !== "pending") return null;
    const next: CoordinationRecord = { ...record, updatedAt: new Date().toISOString() };
    next.client = { ...next.client, ...patch(record.client) };
    await config.set(coordinationKey(id), JSON.stringify(next), "coordination");
    return next;
  });
}

/**
 * Claim the check, then enqueue its scan run. Fenced and idempotent exactly
 * like launchChild: the run id derives from the check attempt, so a retried
 * launch recomputes the same id and republishes through the launch journal;
 * an enqueueRun refusal gives the claim back so the SAME id is retried.
 */
async function launchCheck(runtime: ShipRuntime, record: CoordinationRecord): Promise<LaunchOutcome> {
  const client = record.client;
  // The client's own merged sha: mergedSha when the new code recorded it, the
  // starter's clobbered anchorSha when it did not (see the field's comment).
  const clientMerged = client.mergedSha ?? client.anchorSha;
  const apiAnchor = record.api.anchorSha;
  if (clientMerged === undefined || apiAnchor === undefined) {
    const parked = await patchChild(runtime.config, record.id, "client", {
      clientCheck: "uncertain",
      checkVerdict: {
        verdict: "uncertain",
        confidence: "low",
        rationale: `the check could not be assembled: ${clientMerged === undefined ? "the client's own merged commit is unproven (no sha was recorded)" : "the API compatibility anchor is unproven"} — confirm the merged commits, then re-run the check`,
        summary: "",
        findings: [],
        decidedAt: new Date().toISOString(),
      },
    });
    return { record: parked, launched: null, note: "check could not be assembled; the pair is parked on a human" };
  }
  // The pair-level integration-test question exists only where both projects
  // declare a suite (evidence.ts's per-repo testCommand); scan mode cannot
  // answer it (module header, "INTEGRATION TESTING"), and the field records
  // that honestly rather than leaving the question unasked.
  const [apiEvidence, clientEvidence] = await Promise.all([
    runtime.evidence.forRepo(record.api.repo),
    runtime.evidence.forRepo(client.repo),
  ]);
  const bothSuites = apiEvidence?.testCommand !== undefined && clientEvidence?.testCommand !== undefined;
  const integrationTest = bothSuites
    ? "not-executed (scan is read-only)"
    : "not-applicable (both projects must declare a test command)";
  const claimed = await claimCheck(runtime.config, record.id, (child) => {
    const attempt = (child.checkAttempts ?? 0) + 1;
    return {
      clientCheck: "running" as const,
      checkAttempts: attempt,
      checkRunId: checkRunId(record.id, attempt),
      integrationTest,
      lastError: undefined,
    };
  });
  if (claimed === null) {
    return { record, launched: null, note: "check already claimed; nothing enqueued" };
  }
  const checkRun = claimed.client.checkRunId!;
  try {
    await enqueueRun(runtime, {
      runId: checkRun,
      task: checkTask(claimed, { clientMergedSha: clientMerged, apiRepo: record.api.repo, apiAnchor, integrationTest }),
      model: claimed.model,
      repo: client.repo,
      // Literal scan mode — the read-only guarantee is enforced downstream of
      // this flag, never in this file (the incidents module's citation).
      mode: "scan",
      source: "manual",
      trust: "operator",
      ...(claimed.actor !== undefined ? { actor: claimed.actor } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const back = (claimed.client.checkAttempts ?? 1) - 1;
    await patchChild(runtime.config, record.id, "client", {
      clientCheck: "pending",
      checkAttempts: back,
      checkRunId: back > 0 ? checkRunId(record.id, back) : undefined,
      lastError: message,
    }).catch(() => {});
    return { record, launched: null, note: `check enqueue refused: ${message}` };
  }
  return { record: claimed, launched: "check", runId: checkRun, note: `compatibility check enqueued as ${checkRun}` };
}

function clientTask(record: CoordinationRecord, anchorSha: string): string {
  return [
    record.parentIntent,
    "",
    `[Coordination ${record.id} — client side] This is the consumer half of a coordinated change across two repositories. The API side merged as commit ${anchorSha} — that is your compatibility anchor: build this client change against exactly that commit of the API repository.`,
  ].join("\n");
}

/**
 * Claim pending→running, then enqueue. The claim is the fence: a second
 * launchNext (same tick, racing sweep) reads `running` and stops. The run id
 * is derived from the attempt, so even a call that lost its response and was
 * retried recomputes the same id and republishes through the launch journal.
 * If enqueueRun itself refuses (budget, allowlist changed), the claim is
 * reverted with the attempt given back so the SAME id is retried later.
 */
async function launchChild(
  runtime: ShipRuntime,
  record: CoordinationRecord,
  which: "api" | "client",
  anchorSha?: string,
): Promise<LaunchOutcome> {
  const claimed = await claimChild(runtime.config, record.id, which, "pending", (child) => ({
    state: "running" as const,
    attempts: child.attempts + 1,
    runId: childRunId(record.id, which, child.attempts + 1),
    ...(which === "client" && anchorSha !== undefined ? { anchorSha } : {}),
    lastError: undefined,
  }));
  if (claimed === null) {
    return { record, launched: null, note: `${which} child already claimed; nothing enqueued` };
  }
  const child = claimed[which];
  try {
    await enqueueRun(runtime, {
      runId: child.runId!,
      task: which === "api" ? apiTask(record) : clientTask(record, anchorSha!),
      model: claimed.model,
      repo: child.repo,
      journey: "change",
      source: "manual",
      // The repos were typed by an authenticated human on the coordination
      // form; the allowlist was checked at creation and binds here too.
      trust: "operator",
      ...(claimed.actor !== undefined ? { actor: claimed.actor } : {}),
      // Conversation lineage only (task-session.ts): the client run threads
      // under the API run that anchored it; gates no workflow step.
      ...(which === "client" && claimed.api.runId !== undefined ? { parentRunId: claimed.api.runId } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patchChild(runtime.config, record.id, which, {
      state: "pending",
      attempts: child.attempts - 1,
      runId: child.attempts - 1 > 0 ? childRunId(record.id, which, child.attempts - 1) : undefined,
      lastError: message,
    }).catch(() => {});
    return { record, launched: null, note: `${which} child enqueue refused: ${message}` };
  }
  return { record: claimed, launched: which, runId: child.runId, note: `${which} child enqueued as ${child.runId}` };
}

/**
 * A child claimed `running` whose run never materialised (the process died
 * between claim and enqueue, or the publish was lost): republish the accepted
 * journal intent if there is one, otherwise give the claim back so the same
 * run id is retried. Without this, one lost write would wedge the pair in
 * `running` forever with nothing running.
 */
async function repairLostLaunches(runtime: ShipRuntime, record: CoordinationRecord): Promise<CoordinationRecord> {
  let next = record;
  for (const which of ["api", "client"] as const) {
    const child = next[which];
    if (child.state !== "running" || child.runId === undefined) continue;
    const [meta, events] = await Promise.all([runtime.loadMeta(child.runId), runtime.store.load(child.runId)]);
    if (meta !== null || events.length > 0) continue;
    const accepted = await runtime.launches?.get(child.runId);
    if (accepted !== undefined && accepted !== null) {
      await runtime.launches!.publish(accepted).catch(() => {});
      continue;
    }
    next = await patchChild(runtime.config, next.id, which, {
      state: "pending",
      attempts: child.attempts - 1,
      runId: child.attempts - 1 > 0 ? childRunId(next.id, which, child.attempts - 1) : undefined,
      lastError: "the launch was claimed but never landed; it will be retried under the same run id",
    });
  }
  // Same repair for a claimed-but-lost CHECK launch: without it, one lost
  // write between the check claim and its enqueue would leave clientCheck
  // `running` forever with nothing running, and the pair could never finish.
  if (next.client.clientCheck === "running" && next.client.checkRunId !== undefined) {
    const checkRun = next.client.checkRunId;
    const [meta, events] = await Promise.all([runtime.loadMeta(checkRun), runtime.store.load(checkRun)]);
    if (meta === null && events.length === 0) {
      const accepted = await runtime.launches?.get(checkRun);
      if (accepted === undefined || accepted === null) {
        const back = (next.client.checkAttempts ?? 1) - 1;
        next = await patchChild(runtime.config, next.id, "client", {
          clientCheck: "pending",
          checkAttempts: back,
          checkRunId: back > 0 ? checkRunId(next.id, back) : undefined,
          lastError: "the check launch was claimed but never landed; it will be retried under the same run id",
        });
      } else {
        await runtime.launches!.publish(accepted).catch(() => {});
      }
    }
  }
  return next;
}

function stateNote(record: CoordinationRecord): string {
  const check = record.client.clientCheck;
  return `api ${record.api.state}, client ${record.client.state}${check !== undefined ? `, check ${check}` : ""}; nothing to do`;
}
