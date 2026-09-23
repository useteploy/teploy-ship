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
 */
import { createHash, randomUUID } from "node:crypto";

import { deliveryFromEvents } from "./delivery.js";
import { assertSafeId, withFileLock } from "./file-store.js";
import { canonicalRepositoryURL } from "./repository-reference.js";
import { assertRepoAllowedForOperator, enqueueRun } from "./runtime.js";
import type { Actor } from "./actor.js";
import type { ShipRuntime } from "./runtime.js";

/** Config key holding one coordination record. */
export const coordinationKey = (id: string): string => `SHIP_COORDINATION_${id}`;
/** Config key holding the id index (the config store lists keys, not values). */
export const COORDINATION_INDEX_KEY = "SHIP_COORDINATIONS";

export type CoordinationChildState = "pending" | "running" | "merged" | "delivered" | "failed" | "held";

const CHILD_STATES: readonly CoordinationChildState[] = ["pending", "running", "merged", "delivered", "failed", "held"];

/** One half of the pair. Additive only; fields grow, never rename. */
export interface CoordinationChild {
  /** Canonical full-origin repository identity (validated at creation). */
  repo: string;
  /** The run this attempt lives in; absent until first launch. */
  runId?: string;
  state: CoordinationChildState;
  /** Launches claimed so far (successful or accepted); the run id derives from it. */
  attempts: number;
  /** The merged API commit this child runs against (client compatibility anchor). */
  anchorSha?: string;
  /** Why a held child is parked on a human. */
  holdReason?: string;
  /** How a failed child ended, in one line. */
  failReason?: string;
  /** The last enqueue error, for the surface; cleared by the next claim. */
  lastError?: string;
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
  launched: "api" | "client" | null;
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
        });
      } else if (derived.state !== "running") {
        next = await patchChild(runtime.config, next.id, which, {
          state: derived.state,
          ...(derived.state === "merged" ? { anchorSha: derived.mergedSha } : {}),
          ...(derived.state === "failed" ? { failReason: derived.reason } : {}),
        });
      }
    } else if (child.state === "merged") {
      if (await deliveryConfirmed(runtime, child.runId)) {
        next = await patchChild(runtime.config, next.id, which, { state: "delivered" });
      }
    }
  }
  return next;
}

/**
 * THE single enqueue door. Observes, then acts in a fixed order: repair a
 * claimed-but-lost launch, start the API child, hold the client on an API
 * failure, start the client once the API side merged. Safe to call as often
 * as the sweep ticks; every enqueue is fenced and idempotent.
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
  return next;
}

function stateNote(record: CoordinationRecord): string {
  return `api ${record.api.state}, client ${record.client.state}; nothing to do`;
}
