import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { stateDir } from "./run-store.js";
import { readJsonFile, writeJsonFile, withFileLock } from "./file-store.js";

/**
 * Per-source intake policy. Auto is OFF unless a source is explicitly
 * configured "auto" — autonomy is earned per source, never default —
 * and even then the worker bounds the blast radius of a storm with a
 * daily launch count cap, a concurrency ceiling, and a daily spend cap.
 */
export type IntakePolicy = "ignore" | "propose" | "auto";

/**
 * The intake contract: ONE task shape every source emits — the web form,
 * the CLI, the Forgejo webhook, observe, whatever comes later. A task is
 * a proposal until a policy (or a human in the web queue) launches it as
 * a durable run. Dedupe is part of the contract, not the emitter's job:
 * an alert storm or a re-delivered webhook must collapse into one task.
 */
export interface IntakeTask {
  taskId: string;
  /** Emitter identity: manual | forgejo | github | observe | … */
  source: string;
  /** What the payload is: issue | task | error | … */
  kind: string;
  /** Clone URL for repo work; absent for plain workspace tasks. */
  repo?: string;
  /** Review follow-up: the PR this task addresses. */
  pr?: number;
  title: string;
  detail?: string;
  /** Same key = same task; re-proposals return the existing one. */
  dedupeKey: string;
  /**
   * The handle the payload asserted for whoever opened the issue or sent the
   * message. Carried into the launched run's actor, so an intake run can be
   * attributed at all. Unverified by Ship — see intakeActor() in actor.ts.
   */
  requestedBy?: string;
  state: "proposed" | "launched" | "dismissed";
  /** The durable run a launch created. */
  runId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProposeInput {
  source: string;
  kind: string;
  repo?: string;
  pr?: number;
  title: string;
  detail?: string;
  dedupeKey: string;
  /** Handle the payload asserted for the requester, when it carries one. */
  requestedBy?: string;
}

export interface IntakeStore {
  /** Insert unless a task holds the dedupeKey. Team requests retain their key after dismissal. */
  propose(input: ProposeInput): Promise<{ created: boolean; task: IntakeTask }>;
  list(state?: IntakeTask["state"]): Promise<IntakeTask[]>;
  get(taskId: string): Promise<IntakeTask | null>;
  setState(taskId: string, state: IntakeTask["state"], runId?: string): Promise<void>;
  /**
   * Atomically transition proposed → launched, recording the run id the caller
   * is about to create; true iff THIS caller won.
   *
   * Every launcher (worker sweep, web queue) must claim before enqueueing a
   * run, so two workers racing on the same proposed task collapse to one run
   * instead of duplicate PRs. Writing the run id AS PART OF the claim is what
   * makes the launch crash-consistent: a process that dies between claiming and
   * enqueueing leaves a task that names a run which does not exist, which
   * an authorized same-ID retry can recover. Previously the id
   * was written afterwards, so the same crash left a "launched" task pointing
   * at nothing and no way to tell it from a healthy one.
   *
   * Only a known pre-launch refusal may return to "proposed". Once launch
   * begins, an error may hide accepted work: retain the claim and run ID.
   */
  claim(taskId: string, runId?: string): Promise<boolean>;
  /**
   * Offline repair only, with all launch writers stopped. Never use missing
   * events to release a claim while enqueue may still be running.
   * Release tasks that were claimed for a run that never came into existence.
   * `exists` answers whether a run id has any recorded events. Returns the
   * task ids released.
   */
  reconcile(exists: (runId: string) => Promise<boolean>): Promise<string[]>;
}

/**
 * Forge-shaped keys carry `<owner>/<repo>` between the source and the `#`, and
 * the two paths that build them do not agree on its case: the webhook copies
 * the forge's canonical `full_name` (`Tyler/teploy-cli`), the Akiroo path
 * parses a clone URL a person typed (`tyler/teploy-cli`). Forgejo and GitHub
 * both treat owner and repo names case-insensitively, so one issue produced
 * two keys, two tasks, two runs and two pull requests. Lowercase that segment
 * here, at the one point every proposal passes through. Keys without the
 * `source:owner/repo#…` shape (slack, linear, observe, akiroo scans) are left
 * untouched, since their ids are not known to be case-insensitive.
 */
export function normalizeDedupeKey(key: string): string {
  return key.replace(/^([^:#]+):([^:#]+\/[^:#]+)(#.*)$/, (_m, source: string, fullName: string, rest: string) =>
    `${source}:${fullName.toLowerCase()}${rest}`,
  );
}

function newTask(input: ProposeInput): IntakeTask {
  const now = new Date().toISOString();
  return {
    taskId: `task-${randomUUID().slice(0, 8)}`,
    source: input.source,
    kind: input.kind,
    ...(input.repo !== undefined ? { repo: input.repo } : {}),
    ...(input.pr !== undefined ? { pr: input.pr } : {}),
    title: input.title,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    dedupeKey: normalizeDedupeKey(input.dedupeKey),
    ...(input.requestedBy !== undefined ? { requestedBy: input.requestedBy } : {}),
    state: "proposed",
    createdAt: now,
    updatedAt: now,
  };
}

/** File-backed intake: one JSON per task under the state dir. */
export class FileIntakeStore implements IntakeStore {
  #dir: string;

  constructor(dir = join(stateDir(), "tasks")) {
    this.#dir = dir;
  }

  async #all(): Promise<IntakeTask[]> {
    await mkdir(this.#dir, { recursive: true });
    const names = (await readdir(this.#dir)).filter((n) => n.endsWith(".json"));
    const tasks: IntakeTask[] = [];
    for (const name of names) {
      const task = await readJsonFile<IntakeTask | null>(join(this.#dir, name), null);
      if (task) tasks.push(task);
    }
    return tasks.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async #write(task: IntakeTask): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    await writeJsonFile(join(this.#dir, `${task.taskId}.json`), task);
  }

  async propose(input: ProposeInput): Promise<{ created: boolean; task: IntakeTask }> {
    return withFileLock(this.#dir, async () => {
      const key = normalizeDedupeKey(input.dedupeKey);
      const existing = (await this.#all()).find(
        (t) => normalizeDedupeKey(t.dedupeKey) === key && (t.state !== "dismissed" || t.source === "team-request"),
      );
      if (existing !== undefined) return { created: false, task: existing };
      const task = newTask(input);
      await this.#write(task);
      return { created: true, task };
    });
  }

  async list(state?: IntakeTask["state"]): Promise<IntakeTask[]> {
    const tasks = await this.#all();
    return state === undefined ? tasks : tasks.filter((t) => t.state === state);
  }

  async get(taskId: string): Promise<IntakeTask | null> {
    return (await this.#all()).find((t) => t.taskId === taskId) ?? null;
  }

  async setState(taskId: string, state: IntakeTask["state"], runId?: string): Promise<void> {
    await withFileLock(this.#dir, async () => {
      const task = await this.get(taskId);
      if (task === null) return;
      task.state = state;
      if (runId !== undefined) task.runId = runId;
      task.updatedAt = new Date().toISOString();
      await this.#write(task);
    });
  }

  /**
   * Serialize concurrent handlers in file mode. Multi-process deployments
   * still require Nucleus, where the claim is a conditional UPDATE.
   */
  async claim(taskId: string, runId?: string): Promise<boolean> {
    return withFileLock(this.#dir, async () => {
      const task = await this.get(taskId);
      if (task === null || task.state !== "proposed") return false;
      task.state = "launched";
      if (runId !== undefined) task.runId = runId;
      task.updatedAt = new Date().toISOString();
      await this.#write(task);
      return true;
    });
  }

  async reconcile(exists: (runId: string) => Promise<boolean>): Promise<string[]> {
    const released: string[] = [];
    for (const task of await this.list("launched")) {
      if (task.runId === undefined) continue;
      if (await exists(task.runId)) continue;
      await this.setState(task.taskId, "proposed");
      released.push(task.taskId);
    }
    return released;
  }
}

/** Nucleus-backed intake over the pgwire adapter's ship_tasks table. */
export class NucleusIntakeStore implements IntakeStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= (async () => {
      const columns = `source TEXT, kind TEXT, repo TEXT, pr TEXT, title TEXT,
        detail TEXT, dedupe_key TEXT, state TEXT, run_id TEXT, requested_by TEXT,
        created_at TEXT, updated_at TEXT`;
      // Additive storage: never ALTER/rewrite the populated legacy table.
      await this.#db.query(`CREATE TABLE IF NOT EXISTS ship_tasks (task_id TEXT, ${columns})`);
      await this.#db.query(`CREATE TABLE IF NOT EXISTS ship_tasks_v2 (task_id TEXT PRIMARY KEY, generation TEXT, ${columns})`);
    })().catch((error: unknown) => { this.#ready = null; throw error; });
    return this.#ready;
  }

  #table(taskId: string): string {
    return taskId.startsWith("task-v2-") ? "ship_tasks_v2" : "ship_tasks";
  }

  async #rows(where = "", params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const rows = await Promise.all(["ship_tasks", "ship_tasks_v2"].map(table => this.#db.query(`SELECT * FROM ${table}${where}`, params)));
    return rows.flat();
  }

  #toTask(row: Record<string, unknown>): IntakeTask {
    const task: IntakeTask = {
      taskId: String(row.task_id),
      source: String(row.source),
      kind: String(row.kind),
      title: String(row.title),
      dedupeKey: String(row.dedupe_key),
      state: String(row.state) as IntakeTask["state"],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
    if (row.repo !== null && row.repo !== undefined) task.repo = String(row.repo);
    if (row.pr !== null && row.pr !== undefined) task.pr = Number(row.pr);
    if (row.detail !== null && row.detail !== undefined) task.detail = String(row.detail);
    if (row.run_id !== null && row.run_id !== undefined) task.runId = String(row.run_id);
    if (row.requested_by !== null && row.requested_by !== undefined) task.requestedBy = String(row.requested_by);
    return task;
  }

  async propose(input: ProposeInput): Promise<{ created: boolean; task: IntakeTask }> {
    await this.#ensure();
    const key = normalizeDedupeKey(input.dedupeKey);
    const rows = await this.#rows(" WHERE dedupe_key = $1", [key]);
    const existing = rows.find(r => r.state !== "dismissed" || r.source === "team-request");
    if (existing) return { created: false, task: this.#toTask(existing) };
    // Every contender for this generation computes the same primary key.
    // A paused writer cannot mint another identity after a lease expires:
    // there is no expiring lock, and the unique constraint arbitrates INSERT.
    const generations = rows.map(r => Number(r.generation ?? 0));
    if (generations.some(g => !Number.isSafeInteger(g) || g < 0 || g === Number.MAX_SAFE_INTEGER)) {
      throw new Error("Invalid intake generation; refusing to replace stored request identity");
    }
    const generation = 1 + Math.max(0, ...generations);
    const taskId = `task-v2-${createHash("sha256").update(key).digest("hex")}-${generation}`;
    const task = { ...newTask(input), taskId };
    try {
      await this.#db.query(
        `INSERT INTO ship_tasks_v2 (task_id, source, kind, repo, pr, title, detail, dedupe_key, state, run_id, requested_by, created_at, updated_at, generation)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          task.taskId,
          task.source,
          task.kind,
          task.repo ?? null,
          task.pr !== undefined ? String(task.pr) : null,
          task.title,
          task.detail ?? null,
          task.dedupeKey,
          task.state,
          null,
          task.requestedBy ?? null,
          task.createdAt,
          task.updatedAt,
          String(generation),
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
      const winner = await this.get(taskId);
      if (!winner) throw new Error("Intake identity exists without its task record");
      return { created: false, task: winner };
    }
    return { created: true, task };
  }

  async list(state?: IntakeTask["state"]): Promise<IntakeTask[]> {
    await this.#ensure();
    const rows =
      state === undefined
        ? await this.#rows()
        : await this.#rows(" WHERE state = $1", [state]);
    return rows.map((r) => this.#toTask(r)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async get(taskId: string): Promise<IntakeTask | null> {
    await this.#ensure();
    const rows = await this.#db.query(`SELECT * FROM ${this.#table(taskId)} WHERE task_id = $1`, [taskId]);
    return rows.length > 0 ? this.#toTask(rows[0]!) : null;
  }

  async setState(taskId: string, state: IntakeTask["state"], runId?: string): Promise<void> {
    await this.#ensure();
    if (runId !== undefined) {
      await this.#db.query(`UPDATE ${this.#table(taskId)} SET state = $1, run_id = $2, updated_at = $3 WHERE task_id = $4`, [
        state,
        runId,
        new Date().toISOString(),
        taskId,
      ]);
    } else {
      await this.#db.query(`UPDATE ${this.#table(taskId)} SET state = $1, updated_at = $2 WHERE task_id = $3`, [
        state,
        new Date().toISOString(),
        taskId,
      ]);
    }
  }

  /** Conditional UPDATE: the row count says whether this caller won the race. */
  async claim(taskId: string, runId?: string): Promise<boolean> {
    await this.#ensure();
    // The run id lands in the SAME statement as the state change, so there is
    // no window where a task is launched but nobody knows which run it became.
    const claimed =
      runId !== undefined
        ? await this.#db.exec(
            `UPDATE ${this.#table(taskId)} SET state = 'launched', run_id = $1, updated_at = $2 WHERE task_id = $3 AND state = 'proposed'`,
            [runId, new Date().toISOString(), taskId],
          )
        : await this.#db.exec(
            `UPDATE ${this.#table(taskId)} SET state = 'launched', updated_at = $1 WHERE task_id = $2 AND state = 'proposed'`,
            [new Date().toISOString(), taskId],
          );
    return claimed === 1;
  }

  async reconcile(exists: (runId: string) => Promise<boolean>): Promise<string[]> {
    await this.#ensure();
    const released: string[] = [];
    for (const task of await this.list("launched")) {
      if (task.runId === undefined) continue;
      if (await exists(task.runId)) continue;
      // Conditional on still being launched for THIS run, so a task that got
      // relaunched between the read and now is left alone.
      const freed = await this.#db.exec(
        `UPDATE ${this.#table(task.taskId)} SET state = 'proposed', updated_at = $1 WHERE task_id = $2 AND state = 'launched' AND run_id = $3`,
        [new Date().toISOString(), task.taskId, task.runId],
      );
      if (freed === 1) released.push(task.taskId);
    }
    return released;
  }
}
