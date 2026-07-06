import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { stateDir } from "./run-store.js";

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
  title: string;
  detail?: string;
  /** Same key = same task; re-proposals return the existing one. */
  dedupeKey: string;
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
  title: string;
  detail?: string;
  dedupeKey: string;
}

export interface IntakeStore {
  /** Insert unless a non-dismissed task already holds the dedupeKey. */
  propose(input: ProposeInput): Promise<{ created: boolean; task: IntakeTask }>;
  list(state?: IntakeTask["state"]): Promise<IntakeTask[]>;
  get(taskId: string): Promise<IntakeTask | null>;
  setState(taskId: string, state: IntakeTask["state"], runId?: string): Promise<void>;
}

function newTask(input: ProposeInput): IntakeTask {
  const now = new Date().toISOString();
  return {
    taskId: `task-${randomUUID().slice(0, 8)}`,
    source: input.source,
    kind: input.kind,
    ...(input.repo !== undefined ? { repo: input.repo } : {}),
    title: input.title,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    dedupeKey: input.dedupeKey,
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
          title TEXT,
          detail TEXT,
          dedupe_key TEXT,
          state TEXT,
          run_id TEXT,
          created_at TEXT,
          updated_at TEXT
        )`,
      )
      .then(() => undefined);
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
    if (row.detail !== null && row.detail !== undefined) task.detail = String(row.detail);
    if (row.run_id !== null && row.run_id !== undefined) task.runId = String(row.run_id);
    return task;
  }

  async propose(input: ProposeInput): Promise<{ created: boolean; task: IntakeTask }> {
    await this.#ensure();
    const rows = await this.#db.query(
      "SELECT * FROM ship_tasks WHERE dedupe_key = $1 AND state <> 'dismissed'",
      [input.dedupeKey],
    );
    if (rows.length > 0) return { created: false, task: this.#toTask(rows[0]!) };
    const task = newTask(input);
    await this.#db.query(
      `INSERT INTO ship_tasks (task_id, source, kind, repo, title, detail, dedupe_key, state, run_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        task.taskId,
        task.source,
        task.kind,
        task.repo ?? null,
        task.title,
        task.detail ?? null,
        task.dedupeKey,
        task.state,
        null,
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
}
