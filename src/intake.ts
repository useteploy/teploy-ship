import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** How long a dedupe guard is held. Long enough to cover an insert, short enough to self-heal. */
const DEDUPE_TTL_S = 60;

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { stateDir } from "./run-store.js";

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
  /** Insert unless a non-dismissed task already holds the dedupeKey. */
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
   * {@link IntakeStore.reconcile} can recognise and release. Previously the id
   * was written afterwards, so the same crash left a "launched" task pointing
   * at nothing and no way to tell it from a healthy one.
   *
   * A claimer whose launch then fails must setState back to "proposed".
   */
  claim(taskId: string, runId?: string): Promise<boolean>;
  /**
   * Release tasks that were claimed for a run that never came into existence.
   * `exists` answers whether a run id has any recorded events. Returns the
   * task ids released.
   */
  reconcile(exists: (runId: string) => Promise<boolean>): Promise<string[]>;
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
    dedupeKey: input.dedupeKey,
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
      try {
        tasks.push(JSON.parse(await readFile(join(this.#dir, name), "utf8")) as IntakeTask);
      } catch {
        // a torn write is skipped, never fatal
      }
    }
    return tasks.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async #write(task: IntakeTask): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    await writeFile(join(this.#dir, `${task.taskId}.json`), JSON.stringify(task, null, 2));
  }

  async propose(input: ProposeInput): Promise<{ created: boolean; task: IntakeTask }> {
    const existing = (await this.#all()).find(
      (t) => t.dedupeKey === input.dedupeKey && t.state !== "dismissed",
    );
    if (existing !== undefined) return { created: false, task: existing };
    const task = newTask(input);
    await this.#write(task);
    return { created: true, task };
  }

  async list(state?: IntakeTask["state"]): Promise<IntakeTask[]> {
    const tasks = await this.#all();
    return state === undefined ? tasks : tasks.filter((t) => t.state === state);
  }

  async get(taskId: string): Promise<IntakeTask | null> {
    return (await this.#all()).find((t) => t.taskId === taskId) ?? null;
  }

  async setState(taskId: string, state: IntakeTask["state"], runId?: string): Promise<void> {
    const task = await this.get(taskId);
    if (task === null) return;
    task.state = state;
    if (runId !== undefined) task.runId = runId;
    task.updatedAt = new Date().toISOString();
    await this.#write(task);
  }

  /**
   * Best-effort in file mode: read-check-write is not atomic across
   * processes, but file mode is the single-process dev path — multi-worker
   * deployments run on the Nucleus store, where claim is a conditional
   * UPDATE.
   */
  async claim(taskId: string, runId?: string): Promise<boolean> {
    const task = await this.get(taskId);
    if (task === null || task.state !== "proposed") return false;
    task.state = "launched";
    if (runId !== undefined) task.runId = runId;
    task.updatedAt = new Date().toISOString();
    await this.#write(task);
    return true;
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
    this.#ready ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_tasks (
          task_id TEXT,
          source TEXT,
          kind TEXT,
          repo TEXT,
          pr TEXT,
          title TEXT,
          detail TEXT,
          dedupe_key TEXT,
          state TEXT,
          run_id TEXT,
          requested_by TEXT,
          created_at TEXT,
          updated_at TEXT
        )`,
      )
      .then(() => undefined)
      // A failed ensure must not be cached: one transient store error would
      // otherwise poison every later call for the life of the process.
      .catch((error: unknown) => {
        this.#ready = null;
        throw error;
      });
    return this.#ready;
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
    const rows = await this.#db.query(
      "SELECT * FROM ship_tasks WHERE dedupe_key = $1 AND state <> 'dismissed'",
      [input.dedupeKey],
    );
    if (rows.length > 0) return { created: false, task: this.#toTask(rows[0]!) };

    // SELECT-then-INSERT is not dedupe: two concurrent deliveries of one
    // webhook both see nothing, both insert, and the two rows get different
    // task ids — so the later conditional claim cannot collapse them and the
    // same issue becomes two runs and two PRs. The table has no unique index
    // to lean on (Nucleus), so the KV's atomic setNX decides the winner.
    const guard = `ship:dedupe:${input.dedupeKey}`;
    const holder = `${process.pid}:${randomUUID()}`;
    if (!(await this.#db.kv.setNX(guard, holder, { ttl: DEDUPE_TTL_S }))) {
      // Someone else is inserting this key right now. Re-read: their row is
      // either already visible or about to be, and returning "not created" with
      // their task is exactly what a duplicate delivery should get.
      const again = await this.#db.query(
        "SELECT * FROM ship_tasks WHERE dedupe_key = $1 AND state <> 'dismissed'",
        [input.dedupeKey],
      );
      if (again.length > 0) return { created: false, task: this.#toTask(again[0]!) };
    }
    const task = newTask(input);
    await this.#db.query(
      `INSERT INTO ship_tasks (task_id, source, kind, repo, pr, title, detail, dedupe_key, state, run_id, requested_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
      ],
    );
    return { created: true, task };
  }

  async list(state?: IntakeTask["state"]): Promise<IntakeTask[]> {
    await this.#ensure();
    const rows =
      state === undefined
        ? await this.#db.query("SELECT * FROM ship_tasks")
        : await this.#db.query("SELECT * FROM ship_tasks WHERE state = $1", [state]);
    return rows.map((r) => this.#toTask(r)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async get(taskId: string): Promise<IntakeTask | null> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT * FROM ship_tasks WHERE task_id = $1", [taskId]);
    return rows.length > 0 ? this.#toTask(rows[0]!) : null;
  }

  async setState(taskId: string, state: IntakeTask["state"], runId?: string): Promise<void> {
    await this.#ensure();
    if (runId !== undefined) {
      await this.#db.query("UPDATE ship_tasks SET state = $1, run_id = $2, updated_at = $3 WHERE task_id = $4", [
        state,
        runId,
        new Date().toISOString(),
        taskId,
      ]);
    } else {
      await this.#db.query("UPDATE ship_tasks SET state = $1, updated_at = $2 WHERE task_id = $3", [
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
            "UPDATE ship_tasks SET state = 'launched', run_id = $1, updated_at = $2 WHERE task_id = $3 AND state = 'proposed'",
            [runId, new Date().toISOString(), taskId],
          )
        : await this.#db.exec(
            "UPDATE ship_tasks SET state = 'launched', updated_at = $1 WHERE task_id = $2 AND state = 'proposed'",
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
        "UPDATE ship_tasks SET state = 'proposed', updated_at = $1 WHERE task_id = $2 AND state = 'launched' AND run_id = $3",
        [new Date().toISOString(), task.taskId, task.runId],
      );
      if (freed === 1) released.push(task.taskId);
    }
    return released;
  }
}
