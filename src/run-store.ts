import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { EventStore, WorkflowEvent } from "@neutron-build/workflow";

/**
 * File-backed durable-run storage for the CLI: an event log per run
 * (JSON-lines, append-only) plus a small metadata record the commands
 * read (status, task, which approval event a parked run waits on).
 * Single-machine by design — swap in NucleusEventStore for a shared
 * store across machines; the CLI's semantics don't change.
 */
export function stateDir(): string {
  return process.env.TEPLOY_SHIP_STATE ?? join(homedir(), ".local", "state", "teploy-ship");
}

export class FileEventStore implements EventStore {
  #dir: string;

  constructor(dir = join(stateDir(), "runs")) {
    this.#dir = dir;
  }

  #path(runId: string): string {
    return join(this.#dir, `${runId}.events.jsonl`);
  }

  async append(runId: string, event: WorkflowEvent): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(this.#path(runId), JSON.stringify(event) + "\n");
  }

  async load(runId: string): Promise<WorkflowEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.#path(runId), "utf8");
    } catch {
      return [];
    }
    const seen = new Set<number>();
    const events: WorkflowEvent[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      const event = JSON.parse(line) as WorkflowEvent;
      if (seen.has(event.seq)) continue; // first writer wins, like the Nucleus store
      seen.add(event.seq);
      events.push(event);
    }
    return events.sort((a, b) => a.seq - b.seq);
  }
}

export interface RunMeta {
  runId: string;
  task: string;
  status: string;
  /** Approval event a parked run waits on (undefined unless waiting). */
  eventName?: string;
  workspace?: string;
  model: string;
  /** Host of the worker that most recently executed this run (fleet placement). */
  ranOn?: string;
  createdAt: string;
  updatedAt: string;
}

export class RunMetaStore {
  #dir: string;

  constructor(dir = join(stateDir(), "runs")) {
    this.#dir = dir;
  }

  #path(runId: string): string {
    return join(this.#dir, `${runId}.meta.json`);
  }

  async save(meta: RunMeta): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    await writeFile(this.#path(meta.runId), JSON.stringify(meta, null, 2));
  }

  async load(runId: string): Promise<RunMeta | null> {
    try {
      return JSON.parse(await readFile(this.#path(runId), "utf8")) as RunMeta;
    } catch {
      return null;
    }
  }

  async list(): Promise<RunMeta[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#dir);
    } catch {
      return [];
    }
    const metas: RunMeta[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".meta.json")) continue;
      try {
        metas.push(JSON.parse(await readFile(join(this.#dir, entry), "utf8")) as RunMeta);
      } catch {
        // skip unreadable meta
      }
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
