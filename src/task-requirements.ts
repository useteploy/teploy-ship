import { join } from "node:path";

import { readJsonFile, updateJsonFile } from "./file-store.js";
import { stateDir } from "./run-store.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";

/**
 * S03 — the accepted requirements of a task, as a record of their own.
 *
 * Today a task's intent exists only as the text of each run's input
 * (task-record.ts projects it). Nothing says which statements were ACCEPTED as
 * requirements, which were later waived, or by whom. This store is that
 * record. It is a NEW table: stores create their own tables with
 * CREATE TABLE IF NOT EXISTS, so no migration runs, no existing run, parked
 * fingerprint or populated table is touched, and nothing reads it yet.
 *
 * Rules, each pinned in task-requirements.test.ts:
 *  - Adding the same requirement twice is idempotent (a lost response retried
 *    must not duplicate it); adding a DIFFERENT statement under an existing id
 *    is a refused conflict, never a silent overwrite.
 *  - A waiver needs an actor and a reason, applies only to an active
 *    requirement, and is exactly-once under concurrency. A waived requirement
 *    stays in the list: waiving records a decision, it does not delete the
 *    requirement or turn it into evidence that it was met.
 *  - Authorisation (who may accept or waive) is the CALLER's policy; this store
 *    records the actor it is given and does not decide.
 *
 * Rollout is separate and not done: wiring the store into enqueue and the run
 * page, and rehearsing it on a restored production copy (docs/UPGRADING.md).
 */

export const TASK_REQUIREMENT_STATEMENT_LIMIT = 4000;

export type RequirementSource = "request" | "follow-up" | "operator";
export type RequirementState = "active" | "waived";

export interface TaskRequirement {
  taskRootRunId: string;
  requirementId: string;
  statement: string;
  source: RequirementSource;
  /** The run whose input stated it ("" when entered directly by an operator). */
  sourceRunId: string;
  state: RequirementState;
  createdAt: string;
  createdBy: string;
  waivedAt: string;
  waivedBy: string;
  waivedReason: string;
}

export interface NewRequirement {
  taskRootRunId: string;
  requirementId: string;
  statement: string;
  source: RequirementSource;
  sourceRunId?: string;
  createdBy?: string;
  now?: Date;
}

export class RequirementConflictError extends Error {
  constructor(taskRootRunId: string, requirementId: string) {
    super(`requirement ${requirementId} on task ${taskRootRunId} already exists with different content; it was not replaced`);
    this.name = "RequirementConflictError";
  }
}

export type WaiveOutcome = { ok: true; requirement: TaskRequirement } | { ok: false; failure: "unknown" | "already-waived" };

export interface TaskRequirementStore {
  /** Idempotent for identical content; throws RequirementConflictError for different content. */
  add(input: NewRequirement): Promise<{ created: boolean; requirement: TaskRequirement }>;
  /** Every requirement of the task, waived ones included, oldest first. */
  list(taskRootRunId: string): Promise<TaskRequirement[]>;
  /** Exactly once per requirement. Requires a non-empty actor and reason. */
  waive(taskRootRunId: string, requirementId: string, by: string, reason: string, now?: Date): Promise<WaiveOutcome>;
}

function validate(input: NewRequirement): TaskRequirement {
  const statement = input.statement.trim();
  if (statement === "") throw new Error("a requirement needs a statement");
  if (statement.length > TASK_REQUIREMENT_STATEMENT_LIMIT) {
    throw new Error(`a requirement statement must be at most ${TASK_REQUIREMENT_STATEMENT_LIMIT} characters`);
  }
  if (input.taskRootRunId.trim() === "" || input.requirementId.trim() === "") throw new Error("a requirement needs a task and an id");
  return {
    taskRootRunId: input.taskRootRunId,
    requirementId: input.requirementId,
    statement,
    source: input.source,
    sourceRunId: input.sourceRunId ?? "",
    state: "active",
    createdAt: (input.now ?? new Date()).toISOString(),
    createdBy: input.createdBy ?? "",
    waivedAt: "",
    waivedBy: "",
    waivedReason: "",
  };
}

function sameContent(a: TaskRequirement, b: TaskRequirement): boolean {
  return a.statement === b.statement && a.source === b.source && a.sourceRunId === b.sourceRunId;
}

function requireWaiver(by: string, reason: string): void {
  if (by.trim() === "") throw new Error("a waiver needs the actor who made it");
  if (reason.trim() === "") throw new Error("a waiver needs a reason");
}

function ordered(rows: TaskRequirement[]): TaskRequirement[] {
  return [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.requirementId.localeCompare(b.requirementId));
}

const keyOf = (root: string, id: string) => `${root}/${id}`;

function waived(row: TaskRequirement, by: string, reason: string, now: Date): TaskRequirement {
  return { ...row, state: "waived", waivedAt: now.toISOString(), waivedBy: by, waivedReason: reason };
}

/** In-memory, for tests and callers that want no disk. */
export class MemoryTaskRequirements implements TaskRequirementStore {
  #rows = new Map<string, TaskRequirement>();

  async add(input: NewRequirement): Promise<{ created: boolean; requirement: TaskRequirement }> {
    const next = validate(input);
    const key = keyOf(next.taskRootRunId, next.requirementId);
    const existing = this.#rows.get(key);
    if (existing !== undefined) {
      if (!sameContent(existing, next)) throw new RequirementConflictError(next.taskRootRunId, next.requirementId);
      return { created: false, requirement: existing };
    }
    this.#rows.set(key, next);
    return { created: true, requirement: next };
  }

  async list(taskRootRunId: string): Promise<TaskRequirement[]> {
    return ordered([...this.#rows.values()].filter((r) => r.taskRootRunId === taskRootRunId));
  }

  async waive(root: string, id: string, by: string, reason: string, now = new Date()): Promise<WaiveOutcome> {
    requireWaiver(by, reason);
    const row = this.#rows.get(keyOf(root, id));
    if (row === undefined) return { ok: false, failure: "unknown" };
    if (row.state === "waived") return { ok: false, failure: "already-waived" };
    const next = waived(row, by, reason, now);
    this.#rows.set(keyOf(root, id), next);
    return { ok: true, requirement: next };
  }
}

/** File-backed: one JSON object keyed by task/requirement. Single-process by construction. */
export class FileTaskRequirements implements TaskRequirementStore {
  #path: string;

  constructor(dir = stateDir()) {
    this.#path = join(dir, "task-requirements.json");
  }

  async add(input: NewRequirement): Promise<{ created: boolean; requirement: TaskRequirement }> {
    const next = validate(input);
    const key = keyOf(next.taskRootRunId, next.requirementId);
    let outcome: { created: boolean; requirement: TaskRequirement } | undefined;
    let conflict = false;
    await updateJsonFile<Record<string, TaskRequirement>>(this.#path, {}, (all) => {
      const existing = all[key];
      if (existing !== undefined) {
        if (sameContent(existing, next)) outcome = { created: false, requirement: existing };
        else conflict = true;
        return all;
      }
      outcome = { created: true, requirement: next };
      return { ...all, [key]: next };
    });
    if (conflict || outcome === undefined) throw new RequirementConflictError(next.taskRootRunId, next.requirementId);
    return outcome;
  }

  async list(taskRootRunId: string): Promise<TaskRequirement[]> {
    const all = await readJsonFile<Record<string, TaskRequirement>>(this.#path, {});
    return ordered(Object.values(all).filter((r) => r.taskRootRunId === taskRootRunId));
  }

  async waive(root: string, id: string, by: string, reason: string, now = new Date()): Promise<WaiveOutcome> {
    requireWaiver(by, reason);
    let outcome: WaiveOutcome = { ok: false, failure: "unknown" };
    await updateJsonFile<Record<string, TaskRequirement>>(this.#path, {}, (all) => {
      const row = all[keyOf(root, id)];
      if (row === undefined) return all;
      if (row.state === "waived") {
        outcome = { ok: false, failure: "already-waived" };
        return all;
      }
      const next = waived(row, by, reason, now);
      outcome = { ok: true, requirement: next };
      return { ...all, [keyOf(root, id)]: next };
    });
    return outcome;
  }
}

/**
 * The columns of ship_task_requirements, in DDL order. Exported for the same
 * reason as the other stores' column lists: one definition for the DDL and for
 * any future write-shaped probe.
 */
export const TASK_REQUIREMENT_COLUMNS = [
  "req_key",
  "task_root_run_id",
  "requirement_id",
  "statement",
  "source",
  "source_run_id",
  "state",
  "created_at",
  "created_by",
  "waived_at",
  "waived_by",
  "waived_reason",
];

function fromRow(row: Record<string, unknown>): TaskRequirement {
  const s = (v: unknown) => String(v ?? "");
  return {
    taskRootRunId: s(row.task_root_run_id),
    requirementId: s(row.requirement_id),
    statement: s(row.statement),
    source: s(row.source) as RequirementSource,
    sourceRunId: s(row.source_run_id),
    state: s(row.state) === "waived" ? "waived" : "active",
    createdAt: s(row.created_at),
    createdBy: s(row.created_by),
    waivedAt: s(row.waived_at),
    waivedBy: s(row.waived_by),
    waivedReason: s(row.waived_reason),
  };
}

/** Nucleus-backed, over a table of its own (no ALTER of anything populated). */
export class NucleusTaskRequirements implements TaskRequirementStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_task_requirements (
          req_key TEXT PRIMARY KEY,
          task_root_run_id TEXT,
          requirement_id TEXT,
          statement TEXT,
          source TEXT,
          source_run_id TEXT,
          state TEXT,
          created_at TEXT,
          created_by TEXT,
          waived_at TEXT,
          waived_by TEXT,
          waived_reason TEXT
        )`,
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#ready = null;
        throw error;
      });
    return this.#ready;
  }

  async #get(key: string): Promise<TaskRequirement | undefined> {
    const rows = await this.#db.query("SELECT * FROM ship_task_requirements WHERE req_key = $1", [key]);
    return rows[0] === undefined ? undefined : fromRow(rows[0]);
  }

  async add(input: NewRequirement): Promise<{ created: boolean; requirement: TaskRequirement }> {
    await this.#ensure();
    const next = validate(input);
    const key = keyOf(next.taskRootRunId, next.requirementId);
    const settle = (existing: TaskRequirement) => {
      if (!sameContent(existing, next)) throw new RequirementConflictError(next.taskRootRunId, next.requirementId);
      return { created: false, requirement: existing };
    };
    const existing = await this.#get(key);
    if (existing !== undefined) return settle(existing);
    try {
      await this.#db.query(
        `INSERT INTO ship_task_requirements (req_key, task_root_run_id, requirement_id, statement, source, source_run_id, state, created_at, created_by, waived_at, waived_by, waived_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [key, next.taskRootRunId, next.requirementId, next.statement, next.source, next.sourceRunId, next.state, next.createdAt, next.createdBy, "", "", ""],
      );
    } catch (error) {
      // A concurrent writer won the primary key: judge against what it wrote.
      if ((error as { code?: string }).code !== "23505") throw error;
      const winner = await this.#get(key);
      if (winner === undefined) throw error;
      return settle(winner);
    }
    return { created: true, requirement: next };
  }

  async list(taskRootRunId: string): Promise<TaskRequirement[]> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT * FROM ship_task_requirements WHERE task_root_run_id = $1", [taskRootRunId]);
    return ordered(rows.map(fromRow));
  }

  async waive(root: string, id: string, by: string, reason: string, now = new Date()): Promise<WaiveOutcome> {
    requireWaiver(by, reason);
    await this.#ensure();
    const key = keyOf(root, id);
    const row = await this.#get(key);
    if (row === undefined) return { ok: false, failure: "unknown" };
    // `state = 'active'` is part of the filter: two concurrent waivers update
    // one row and refuse the other, so a waiver is recorded exactly once.
    const changed = await this.#db.exec(
      "UPDATE ship_task_requirements SET state = $1, waived_at = $2, waived_by = $3, waived_reason = $4 WHERE req_key = $5 AND state = $6",
      ["waived", now.toISOString(), by, reason, key, "active"],
    );
    if (changed === 0) return { ok: false, failure: "already-waived" };
    return { ok: true, requirement: waived(row, by, reason, now) };
  }
}
