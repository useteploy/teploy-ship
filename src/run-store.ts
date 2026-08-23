import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { EventStore, WorkflowEvent } from "@neutron-build/workflow";

import { appendLineSync, assertSafeId, readJsonFile, writeJsonFile } from "./file-store.js";

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
  #onConflict: (message: string) => void;

  constructor(dir = join(stateDir(), "runs"), onConflict?: (message: string) => void) {
    this.#dir = dir;
    this.#onConflict = onConflict ?? ((message) => process.stderr.write(`[ship] ${message}\n`));
  }

  #path(runId: string): string {
    return join(this.#dir, `${assertSafeId("run id", runId)}.events.jsonl`);
  }

  /** Appends are fsynced: an event that is only in the page cache does not survive the crash this log exists for. */
  async append(runId: string, event: WorkflowEvent): Promise<void> {
    await appendLineSync(this.#path(runId), JSON.stringify(event));
  }

  async load(runId: string): Promise<WorkflowEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.#path(runId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error; // a permission or I/O fault is not "this run has no events"
    }
    const lines = raw.split("\n");
    const seen = new Map<number, string>();
    const events: WorkflowEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") continue;
      let event: WorkflowEvent;
      try {
        event = JSON.parse(line) as WorkflowEvent;
      } catch (error) {
        // ONLY the final line can be a torn append. A malformed line in the
        // MIDDLE is corruption, and skipping it while still loading everything
        // after silently hands replay a history that never happened — which can
        // re-run a model call or repeat an external side effect. Refuse instead.
        const isLastContentLine = lines.slice(i + 1).every((l) => l.trim() === "");
        if (isLastContentLine) break;
        throw new Error(
          `run ${runId}: event log is corrupt at line ${i + 1} — refusing to replay a partial history ` +
            `(${error instanceof Error ? error.message : String(error)})`,
        );
      }
      const previous = seen.get(event.seq);
      const encoded = JSON.stringify(event);
      if (previous !== undefined) {
        // First writer wins, matching the Nucleus store — but a duplicate seq
        // carrying DIFFERENT content means two executors disagreed about
        // history, and the loser's step may already have had side effects. That
        // used to pass in complete silence; resolving it quietly is defensible,
        // never mentioning it is not.
        if (previous !== encoded) {
          this.#onConflict(
            `run ${runId}: two different events claim seq ${event.seq}; keeping the first. ` +
              `This means two executors wrote the same run — check lease ownership.`,
          );
        }
        continue;
      }
      seen.set(event.seq, encoded);
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
  /**
   * Intake source this run came from ("github", "slack", "manual", …). Recorded
   * at enqueue so the worker can attribute the run's cost when it finishes:
   * spend is settled per source, and without this only auto-launched runs —
   * the ones the sweep happened to be tracking in memory — were ever counted.
   */
  source?: string;
  /** Host of the worker that most recently executed this run (fleet placement). */
  ranOn?: string;
  /**
   * Stable id of whoever asked for this run (see actor.ts). Absent on runs
   * enqueued before attribution existed, and on any surface that genuinely
   * cannot name a person — `actorKind` says which.
   *
   * Flat, not a nested Actor, because the Nucleus store is a hand-written map
   * of scalar columns: an object here is stringified into the column and reads
   * back as the literal text `[object Object]`.
   */
  actor?: string;
  /** How that identity was established: user | cli | intake | unknown. */
  actorKind?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Every RunMeta field, as data. The Nucleus store persists a RunMeta through a
 * hand-written column map that THROWS on an unmapped key, so a field added to
 * the interface and nowhere else silently breaks every write that carries it
 * (`source` did, and it blocked all run creation until migration 001).
 *
 * The two lines below make that impossible to repeat: `satisfies` proves every
 * entry is a real RunMeta key, the Missing check fails the BUILD if a key is
 * absent from the list, and a unit test asserts this list is a subset of the
 * Nucleus column map. Add a field to RunMeta and all three have to be satisfied
 * before it compiles and passes.
 */
export const RUN_META_FIELDS = [
  "runId",
  "task",
  "status",
  "eventName",
  "workspace",
  "model",
  "source",
  "ranOn",
  "actor",
  "actorKind",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof RunMeta)[];

type UnmappedRunMetaField = Exclude<keyof RunMeta, (typeof RUN_META_FIELDS)[number]>;
// Compile error names the missing field if RUN_META_FIELDS falls behind RunMeta.
const _runMetaFieldsAreExhaustive: UnmappedRunMetaField extends never ? true : never = true;
void _runMetaFieldsAreExhaustive;

export class RunMetaStore {
  #dir: string;

  constructor(dir = join(stateDir(), "runs")) {
    this.#dir = dir;
  }

  #path(runId: string): string {
    return join(this.#dir, `${assertSafeId("run id", runId)}.meta.json`);
  }

  /** Atomic (temp + fsync + rename): a crash mid-write left a truncated file that read back as "unknown run". */
  async save(meta: RunMeta): Promise<void> {
    await writeJsonFile(this.#path(meta.runId), meta);
  }

  async load(runId: string): Promise<RunMeta | null> {
    return readJsonFile<RunMeta | null>(this.#path(runId), null);
  }

  async list(options?: { limit?: number }): Promise<RunMeta[]> {
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
    metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const limit = options?.limit;
    return limit !== undefined ? metas.slice(0, Math.max(1, Math.trunc(limit))) : metas;
  }
}
