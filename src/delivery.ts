/**
 * Delivery records (Package B, S14): what an approved production delivery
 * IS, additively, from the moment a run's change merges.
 *
 * The design contract is `_internal/SHIP_DELIVERY_CONTRACT.md` (private) —
 * the public summary: an approved delivery is a TUPLE (canonical repo,
 * merged SHA, tested tree, artifact digest, trusted config identity,
 * destination, retained recovery version, actor, policy), never a branch or
 * tag alone. Records are created `proposed` at merge completion; an
 * operator with the approve authority moves one to `approved`; the worker
 * sweep executes approved deliveries against the TRUSTED working copy
 * (SHIP_DELIVERY_DIR — the preview-dir pattern: absent means the whole
 * execution path is off and every record says so honestly).
 *
 * Nothing here deploys anything. The execution step lives in worker.ts and
 * refuses to act without the trusted directory; this module only keeps the
 * record honest through its state machine, with conditional-UPDATE fencing
 * on every transition so an approval can never race a publication.
 */
import { join } from "node:path";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { readJsonFile, updateJsonFile } from "./file-store.js";
import { stateDir } from "./run-store.js";

/** What a delivery record holds. Additive only; fields grow, never rename. */
export interface DeliveryRecord {
  /** `${runId}` scoped identity — one record per run's merged change. */
  id: string;
  runId: string;
  /** Canonical full-origin repository identity (projects-v2). */
  repo: string;
  /** The head the merge decision was recorded against, when known. */
  reviewedHead?: string;
  /** The forge's own merged SHA (or read-back). Absent until proven. */
  mergedSha?: string;
  /** The suite outcome recorded against the merged tree. */
  testedTree?: { sha: string; outcome: string };
  /** Operator-selected destination recorded in the approval. */
  destination?: string;
  /** The version the destination ran BEFORE promotion (rollback target). */
  recoveryVersion?: string;
  /** Image digest from the trusted copy's build; recorded at execution. */
  artifactDigest?: string;
  /** Identity of the trusted working copy's configuration at execution. */
  configIdentity?: string;
  actor?: string;
  policy?: string;
  reason?: string;
  state: DeliveryState;
  updatedAt: string;
}

export type DeliveryState = "proposed" | "approved" | "executing" | "confirmed" | "unknown" | "failed" | "held";

/** Legal transitions; everything else is a store-level refusal. */
const ALLOWED: Record<DeliveryState, DeliveryState[]> = {
  proposed: ["approved", "held"],
  approved: ["executing", "held"],
  executing: ["confirmed", "unknown", "failed"],
  unknown: ["confirmed", "failed", "held"],
  failed: ["held", "approved"],
  held: ["approved"],
  confirmed: [],
};

export function transitionAllowed(from: DeliveryState, to: DeliveryState): boolean {
  return ALLOWED[from]?.includes(to) === true;
}

/** The fields each state requires before the transition may be recorded. */
export function requiredForTransition(to: DeliveryState): (keyof DeliveryRecord)[] {
  switch (to) {
    case "approved":
      return ["destination", "recoveryVersion", "actor"];
    case "confirmed":
      return ["artifactDigest"];
    default:
      return [];
  }
}

export interface DeliveryStore {
  /** Create a proposed record for a merged run; idempotent on id. */
  propose(record: Omit<DeliveryRecord, "state" | "updatedAt">): Promise<DeliveryRecord>;
  get(id: string): Promise<DeliveryRecord | null>;
  /** All records, newest first, bounded (the operator surfaces). */
  list(limit?: number): Promise<DeliveryRecord[]>;
  /**
   * One fenced transition: only applies when the record is currently in
   * `from`, merges the patch, and validates required fields. Returns the
   * record that won — the caller compares state to learn whether its
   * transition happened or lost.
   */
  transition(
    id: string,
    from: DeliveryState,
    to: DeliveryState,
    patch: Partial<Pick<DeliveryRecord, "actor" | "policy" | "reason" | "destination" | "recoveryVersion" | "artifactDigest" | "configIdentity">>,
  ): Promise<DeliveryRecord>;
  /** Records in a given state for the worker sweep, bounded. */
  due(state: DeliveryState, limit?: number): Promise<DeliveryRecord[]>;
}

const validate = (record: Partial<DeliveryRecord>): void => {
  if (typeof record.id !== "string" || record.id === "") throw new Error("Delivery record needs an id");
  if (typeof record.runId !== "string" || record.runId !== record.id) throw new Error("Delivery identity is the run");
  if (typeof record.repo !== "string" || record.repo === "") throw new Error("Delivery needs the canonical repository");
};

/**
 * Read a merged change's delivery facts off the run's own recorded log —
 * never off a status column or the model's account. Absent when the run did
 * not merge (no record is created for unmerged or unknown outcomes; those
 * stay what their verification paragraph says they are).
 */
export function deliveryFromEvents(
  runId: string,
  repo: string,
  events: Array<{ type: string; name?: string; data?: unknown }>,
): Omit<DeliveryRecord, "state" | "updatedAt"> | null {
  const result = (e: { type: string; name?: string; data?: unknown }): Record<string, unknown> | undefined =>
    (e.data as { result?: Record<string, unknown> } | undefined)?.result;
  let merged: Record<string, unknown> | undefined;
  for (const e of events) {
    if (e.type !== "step-completed") continue;
    const r = result(e);
    if (r === undefined) continue;
    // The boundary decision supersedes the auto gate on the same PR; the
    // LAST merged answer wins (same precedence as the verification facts).
    if ((e.name === "merge-decision" || e.name === "auto-merge") && r.kind === "merged") merged = r;
  }
  if (merged === undefined) return null;
  const record: Omit<DeliveryRecord, "state" | "updatedAt"> = {
    id: runId,
    runId,
    repo,
    ...(typeof merged.sha === "string" && merged.sha !== "" ? { mergedSha: merged.sha } : {}),
    ...(e2s(events, "repo-push") !== undefined ? { reviewedHead: e2s(events, "repo-push") } : {}),
  };
  return record;
}

/** The sha a named step recorded, if any. */
function e2s(events: Array<{ type: string; name?: string; data?: unknown }>, name: string): string | undefined {
  const found = [...events].reverse().find((e) => e.type === "step-completed" && e.name === name);
  const sha = (found?.data as { result?: { sha?: unknown } } | undefined)?.result?.sha;
  return typeof sha === "string" && sha !== "" ? sha : undefined;
}

/** File-backed store (single-box/tests). */
export class FileDeliveryStore implements DeliveryStore {
  #path: string;

  constructor(dir = stateDir()) {
    this.#path = join(dir, "deliveries.json");
  }

  async propose(record: Omit<DeliveryRecord, "state" | "updatedAt">): Promise<DeliveryRecord> {
    validate(record);
    let created: DeliveryRecord | null = null;
    await updateJsonFile<Record<string, DeliveryRecord>>(this.#path, {}, (all) => {
      if (all[record.id] !== undefined) return all;
      created = { ...record, state: "proposed", updatedAt: new Date().toISOString() } as DeliveryRecord;
      return { ...all, [record.id]: created };
    });
    if (created === null) {
      const existing = await this.get(record.id);
      if (existing === null) throw new Error("Delivery proposal could not be read back");
      return existing;
    }
    return created;
  }

  async get(id: string): Promise<DeliveryRecord | null> {
    return (await readJsonFile<Record<string, DeliveryRecord>>(this.#path, {}))[id] ?? null;
  }

  async list(limit = 50): Promise<DeliveryRecord[]> {
    const all = Object.values(await readJsonFile<Record<string, DeliveryRecord>>(this.#path, {}));
    return all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

  async transition(
    id: string,
    from: DeliveryState,
    to: DeliveryState,
    patch: Partial<Pick<DeliveryRecord, "actor" | "policy" | "reason" | "destination" | "recoveryVersion" | "artifactDigest" | "configIdentity">>,
  ): Promise<DeliveryRecord> {
    if (!transitionAllowed(from, to)) throw new Error(`Delivery ${id} cannot move ${from} → ${to}`);
    let winner: DeliveryRecord | null = null;
    await updateJsonFile<Record<string, DeliveryRecord>>(this.#path, {}, (all) => {
      const current = all[id];
      if (current === undefined) throw new Error("No delivery record with this identity");
      if (current.state === from) {
        const next = { ...current, ...patch, state: to, updatedAt: new Date().toISOString() } as DeliveryRecord;
        for (const field of requiredForTransition(to)) {
          if (next[field] === undefined || next[field] === "") throw new Error(`A ${to} delivery needs ${String(field)}`);
        }
        winner = next;
        return { ...all, [id]: next };
      }
      winner = current;
      return all;
    });
    if (winner === null) throw new Error("Delivery transition could not be read back");
    return winner;
  }

  async due(state: DeliveryState, limit = 10): Promise<DeliveryRecord[]> {
    return (await this.list(500)).filter((r) => r.state === state).slice(0, limit);
  }
}

/**
 * Execute one approved delivery against the TRUSTED working copy. This is
 * the S14 execution boundary; it runs on the worker host via argv arrays
 * (the deploy.ts discipline — never a shell), and it ACTS only when every
 * identity it was approved under still holds.
 *
 * `run` is injectable for tests; in production it is deploy.ts's
 * hostRunner(). A trusted directory that is not configured holds the record
 * visibly instead of leaving an approval that can never run.
 */
export async function executeDelivery(
  record: DeliveryRecord,
  options: {
    dir?: string;
    run: (argv: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
    now?: () => string;
  },
): Promise<DeliveryRecord> {
  const now = options.now?.() ?? new Date().toISOString();
  const patch = (fields: Partial<DeliveryRecord>): Partial<DeliveryRecord> & { state: DeliveryState; updatedAt: string } => ({
    ...fields,
    state: "held",
    updatedAt: now,
  });
  if (options.dir === undefined || options.dir === "") {
    return { ...record, ...patch({ reason: "no trusted delivery directory configured (SHIP_DELIVERY_DIR); provision one before approving deliveries" }) };
  }
  if (record.mergedSha === undefined) {
    return { ...record, ...patch({ reason: "the merged SHA was never proven (read-back did not confirm the merge); re-verify before delivery" }) };
  }
  const cwd = options.dir;
  const exec = async (argv: string[], timeoutMs = 120_000) => options.run(argv, { cwd, timeoutMs });

  // The trusted copy builds EXACTLY the approved bytes: fetch the merged SHA
  // into a detached worktree (never moving an operator's open checkout),
  // build there, and record the digest the forge-independent build produced.
  const tree = `${cwd.replace(/\/+$/, "")}/.teploy-ship-delivery-${record.mergedSha.slice(0, 12)}`;
  const fetched = await exec(["git", "fetch", "--no-write-fetch-head", "origin", record.mergedSha], 300_000);
  if (fetched.code !== 0) {
    return { ...record, ...patch({ reason: `could not fetch the merged SHA into the trusted copy: ${(fetched.stderr || fetched.stdout).slice(0, 300)}` }) };
  }
  const checked = await exec(["git", "worktree", "add", "--detach", tree, record.mergedSha]);
  if (checked.code !== 0) {
    return { ...record, ...patch({ reason: `could not check out the merged SHA in the trusted copy: ${(checked.stderr || checked.stdout).slice(0, 300)}` }) };
  }
  const build = await options.run(["teploy", "build", "--version", record.mergedSha, "--json"], { cwd: tree, timeoutMs: 900_000 });
  if (build.code !== 0) {
    await exec(["git", "worktree", "remove", "--force", tree]).catch(() => undefined);
    return { ...record, ...patch({ reason: `trusted build failed (exit ${build.code}): ${(build.stderr || build.stdout).slice(0, 300)}` }) };
  }
  let image = "";
  try {
    const parsed = JSON.parse(build.stdout.trim()) as { image?: unknown };
    if (typeof parsed.image === "string") image = parsed.image;
  } catch {
    // fall through to the honest refusal below
  }
  if (image === "") {
    await exec(["git", "worktree", "remove", "--force", tree]).catch(() => undefined);
    return { ...record, ...patch({ reason: `the trusted build printed no image identity: ${build.stdout.slice(0, 300)}` }) };
  }
  const deployed = await options.run(
    ["teploy", "deploy", "--image", image, "--version", record.mergedSha.slice(0, 7), "--skip-dns-check"],
    { cwd: tree, timeoutMs: 900_000 },
  );
  await exec(["git", "worktree", "remove", "--force", tree]).catch(() => undefined);
  if (deployed.code !== 0) {
    return {
      ...record,
      ...patch({ reason: `deployment refused (exit ${deployed.code}): ${(deployed.stderr || deployed.stdout).slice(0, 300)}`, artifactDigest: image }),
    };
  }
  // A returned command is not a verified outcome: the deploy may succeed and
  // lose its response. `unknown` is the honest state until the target is
  // READ BACK — the same discipline as merge reconciliation. The sweep
  // reconciles unknown records through readBackDelivery below.
  return {
    ...record,
    artifactDigest: image,
    state: "unknown",
    updatedAt: now,
    reason: "deployment command completed; target state not yet read back",
  };
}

/** What reading the target back proved. */
export type ReadBackOutcome =
  | { outcome: "confirmed"; detail: string }
  /** The target is readable and is NOT running the approved delivery. */
  | { outcome: "mismatch"; detail: string }
  /** The target could not be read; the record stays unknown and retries. */
  | { outcome: "unreadable"; detail: string };

/**
 * Reconcile an `unknown` delivery by READING the target back — never by
 * trusting the deploy command's exit code. Confirmed requires BOTH of the
 * identity pair the delivery was approved under: the deployed version in the
 * app's state AND a running container whose image is the recorded artifact.
 * A readable target running something else is a `mismatch` (the deployment
 * did not take effect); an unreadable one stays `unknown` and is retried by
 * the next sweep — unknown never records as failed on a lost read.
 */
export async function readBackDelivery(
  record: DeliveryRecord,
  options: {
    dir?: string;
    run: (argv: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
  },
): Promise<ReadBackOutcome> {
  if (options.dir === undefined || options.dir === "") {
    return { outcome: "unreadable", detail: "no trusted delivery directory configured (SHIP_DELIVERY_DIR); cannot read the target back" };
  }
  if (record.mergedSha === undefined || record.artifactDigest === undefined) {
    return { outcome: "unreadable", detail: "the record carries no deployed identity (merged SHA / artifact digest); cannot reconcile" };
  }
  const expected = record.mergedSha.slice(0, 7);
  const read = await options.run(["teploy", "status", "--json"], { cwd: options.dir, timeoutMs: 120_000 });
  if (read.code !== 0) {
    return { outcome: "unreadable", detail: `target status could not be read (exit ${read.code}): ${(read.stderr || read.stdout).slice(0, 300)}` };
  }
  let parsed: { state?: { current_hash?: unknown }; containers?: Array<{ image?: unknown; state?: unknown }> };
  try {
    parsed = JSON.parse(read.stdout.trim()) as typeof parsed;
  } catch {
    return { outcome: "unreadable", detail: `target status was not JSON: ${read.stdout.slice(0, 300)}` };
  }
  const running = (parsed.containers ?? []).filter((c) => c.state === "running");
  const current = typeof parsed.state?.current_hash === "string" ? parsed.state.current_hash : "";
  if (current !== expected) {
    return {
      outcome: "mismatch",
      detail: `the target runs version ${current === "" ? "(none)" : current}, not the approved ${expected} — the deployment did not take effect`,
    };
  }
  const onArtifact = running.some((c) => c.image === record.artifactDigest);
  if (!onArtifact) {
    const images = running.map((c) => String(c.image)).join(", ");
    return {
      outcome: "mismatch",
      detail: `state names ${expected} but the running ${running.length === 0 ? "containers are none" : `container image(s) [${images}]`} — not the approved artifact ${record.artifactDigest}`,
    };
  }
  return { outcome: "confirmed", detail: `target read back: version ${expected} serving on the approved artifact` };
}
/** Nucleus-backed store over a fresh sibling table (the fleet-store pattern). */
export class NucleusDeliveryStore implements DeliveryStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query("CREATE TABLE IF NOT EXISTS ship_delivery (id TEXT PRIMARY KEY, record TEXT)")
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#ready = null;
        throw error;
      });
    return this.#ready;
  }

  async propose(record: Omit<DeliveryRecord, "state" | "updatedAt">): Promise<DeliveryRecord> {
    validate(record);
    await this.#ensure();
    const existing = await this.get(record.id);
    if (existing !== null) return existing;
    const full: DeliveryRecord = { ...record, state: "proposed", updatedAt: new Date().toISOString() } as DeliveryRecord;
    try {
      await this.#db.query("INSERT INTO ship_delivery (id, record) VALUES ($1, $2)", [record.id, JSON.stringify(full)]);
    } catch (error) {
      // A concurrent proposal for the same run loses and reads the winner.
      if ((error as { code?: string }).code !== "23505") throw error;
      const raced = await this.get(record.id);
      if (raced === null) throw error;
      return raced;
    }
    return full;
  }

  async get(id: string): Promise<DeliveryRecord | null> {
    await this.#ensure();
    const [row] = await this.#db.query("SELECT record FROM ship_delivery WHERE id = $1", [id]);
    if (row === undefined) return null;
    const record = JSON.parse(String(row.record)) as DeliveryRecord;
    if (record.id !== id) throw new Error("Delivery record identity mismatch");
    return record;
  }

  async list(limit = 50): Promise<DeliveryRecord[]> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT record FROM ship_delivery");
    return rows
      .map((r) => JSON.parse(String(r.record)) as DeliveryRecord)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  async transition(
    id: string,
    from: DeliveryState,
    to: DeliveryState,
    patch: Partial<Pick<DeliveryRecord, "actor" | "policy" | "reason" | "destination" | "recoveryVersion" | "artifactDigest" | "configIdentity">>,
  ): Promise<DeliveryRecord> {
    if (!transitionAllowed(from, to)) throw new Error(`Delivery ${id} cannot move ${from} → ${to}`);
    await this.#ensure();
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.get(id);
      if (current === null) throw new Error("No delivery record with this identity");
      if (current.state !== from) return current; // someone else moved it; their result stands
      const next: DeliveryRecord = { ...current, ...patch, state: to, updatedAt: new Date().toISOString() };
      for (const field of requiredForTransition(to)) {
        if (next[field] === undefined || next[field] === "") throw new Error(`A ${to} delivery needs ${String(field)}`);
      }
      // The conditional UPDATE is the fence: exactly one mover wins.
      const changed = await this.#db.exec("UPDATE ship_delivery SET record = $1 WHERE id = $2 AND record = $3", [
        JSON.stringify(next),
        id,
        JSON.stringify(current),
      ]);
      if (changed === 1) return next;
    }
    throw new Error("Delivery transition lost every race; re-read the record");
  }

  async due(state: DeliveryState, limit = 10): Promise<DeliveryRecord[]> {
    return (await this.list(500)).filter((r) => r.state === state).slice(0, limit);
  }
}
