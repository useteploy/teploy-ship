import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { writeJsonFile } from "./file-store.js";
import { stateDir } from "./run-store.js";

/**
 * What a run is doing RIGHT NOW, for a person watching it.
 *
 * The event log records every step after it completes, and the dashboard
 * follows the log — so between two steps a watcher sees nothing at all. A
 * model turn under extended thinking is minutes of that; an external harness
 * is one exec of up to thirty minutes. This is the side channel for the gap:
 * one row per run, overwritten in place, holding the phase the run is in and
 * the one-line detail a person would want (the command running, the harness's
 * last tool call).
 *
 * Deliberately NOT part of the event log. It is written from inside a
 * recorded step while the step executes live, so a replay — which returns the
 * recorded result without running the step body — never writes it, and a
 * torn or lost row changes nothing about how the run proceeds. Advisory in
 * both directions: a store failure is swallowed by the sink (`liveSink`), and
 * a stale row is only ever a stale line on a page.
 */

export type LivePhase =
  /** The model is generating the next action. */
  | "thinking"
  /** An action is executing in the workspace. */
  | "running"
  /** An external harness (claude-code, opencode) holds the workspace. */
  | "harness"
  /** Ship's own evidence legs: the suite, the build, the preview. */
  | "verifying"
  /** The agent has asked the operator something and is parked on the answer. */
  | "asking";

export interface LiveState {
  runId: string;
  phase: LivePhase;
  /** The turn the phase belongs to, when the run counts turns. */
  turn?: number;
  /** One line: the command, the harness's last tool call, the question. */
  detail?: string;
  /** Attempt prefix on a multi-attempt run (`attempt-1-`), so parallel attempts stay distinguishable. */
  attempt?: string;
  updatedAt: string;
}

export type LiveUpdate = Omit<LiveState, "runId" | "updatedAt">;

export interface LiveStore {
  set(runId: string, update: LiveUpdate): Promise<void>;
  get(runId: string): Promise<LiveState | null>;
  /** Most recently updated first, bounded. What the change poller watches. */
  recent(limit: number): Promise<LiveState[]>;
  /** Forget a run — it settled or parked, and the row would otherwise read as current forever. */
  clear(runId: string): Promise<void>;
}

/**
 * The fire-and-forget shape the loop calls. Bound to one run (and one
 * attempt) so call sites name only the phase. Never throws, never awaited:
 * a live hint must not slow a turn or fail a run.
 */
export type LiveSink = (update: LiveUpdate) => void;

export function liveSink(store: Pick<LiveStore, "set"> | undefined, runId: string, attempt = ""): LiveSink | undefined {
  if (store === undefined) return undefined;
  return (update) => {
    void store.set(runId, { ...update, ...(attempt !== "" ? { attempt } : {}) }).catch(() => {});
  };
}

/** Bounded, single-line, for the page and the log. */
export function clipDetail(text: string, max = 160): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

const PHASES: ReadonlySet<string> = new Set(["thinking", "running", "harness", "verifying", "asking"]);

function readState(runId: string, raw: Record<string, unknown>): LiveState | null {
  const phase = String(raw.phase ?? "");
  if (!PHASES.has(phase)) return null;
  const turn = raw.turn === undefined || raw.turn === null || raw.turn === "" ? undefined : Number(raw.turn);
  const detail = raw.detail === undefined || raw.detail === null || raw.detail === "" ? undefined : String(raw.detail);
  const attempt = raw.attempt === undefined || raw.attempt === null || raw.attempt === "" ? undefined : String(raw.attempt);
  return {
    runId,
    phase: phase as LivePhase,
    ...(turn !== undefined && Number.isFinite(turn) ? { turn } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    updatedAt: String(raw.updatedAt ?? raw.updated_at ?? ""),
  };
}

function newest(a: LiveState, b: LiveState): number {
  return a.updatedAt === b.updatedAt ? (a.runId < b.runId ? -1 : 1) : a.updatedAt < b.updatedAt ? 1 : -1;
}

/** File-backed: one JSON file per run under the state dir. */
export class FileLiveStore implements LiveStore {
  #dir: string;

  constructor(dir = join(stateDir(), "live")) {
    this.#dir = dir;
  }

  #file(runId: string): string {
    return join(this.#dir, `${runId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
  }

  async set(runId: string, update: LiveUpdate): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const state: LiveState = { runId, ...update, updatedAt: new Date().toISOString() };
    await writeJsonFile(this.#file(runId), state);
  }

  async get(runId: string): Promise<LiveState | null> {
    const raw = await readFile(this.#file(runId), "utf8").catch(() => null);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // Sanitised names can collide; the row names its own run.
      return parsed.runId === runId ? readState(runId, parsed) : null;
    } catch {
      return null;
    }
  }

  async recent(limit: number): Promise<LiveState[]> {
    const names = await readdir(this.#dir).catch(() => [] as string[]);
    const states: LiveState[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const raw = await readFile(join(this.#dir, name), "utf8").catch(() => null);
      if (raw === null) continue;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const state = readState(String(parsed.runId ?? ""), parsed);
        if (state !== null && state.runId !== "") states.push(state);
      } catch {
        // torn write — skip
      }
    }
    return states.sort(newest).slice(0, Math.max(0, limit));
  }

  async clear(runId: string): Promise<void> {
    await rm(this.#file(runId), { force: true });
  }
}

/** Nucleus-backed: one row per run in ship_live (pgwire adapter). */
export class NucleusLiveStore implements LiveStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_live (
          run_id TEXT,
          phase TEXT,
          turn TEXT,
          detail TEXT,
          attempt TEXT,
          updated_at TEXT
        )`,
      )
      .then(() => undefined)
      // A failed ensure must not be cached (see steer.ts for the same rule).
      .catch((error: unknown) => {
        this.#ready = null;
        throw error;
      });
    return this.#ready;
  }

  async set(runId: string, update: LiveUpdate): Promise<void> {
    await this.#ensure();
    // Delete-then-insert rather than upsert: one writer per run by
    // construction (the executing worker), and Nucleus's UPDATE reports no
    // row count to branch an insert on.
    await this.#db.query("DELETE FROM ship_live WHERE run_id = $1", [runId]);
    await this.#db.query(
      "INSERT INTO ship_live (run_id, phase, turn, detail, attempt, updated_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [
        runId,
        update.phase,
        update.turn !== undefined ? String(update.turn) : "",
        update.detail ?? "",
        update.attempt ?? "",
        new Date().toISOString(),
      ],
    );
  }

  async get(runId: string): Promise<LiveState | null> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT * FROM ship_live WHERE run_id = $1", [runId]);
    const states = rows.map((row) => readState(runId, row)).filter((s): s is LiveState => s !== null);
    return states.sort(newest)[0] ?? null;
  }

  async recent(limit: number): Promise<LiveState[]> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT * FROM ship_live", []);
    return rows
      .map((row) => readState(String(row.run_id ?? ""), row))
      .filter((s): s is LiveState => s !== null && s.runId !== "")
      .sort(newest)
      .slice(0, Math.max(0, limit));
  }

  async clear(runId: string): Promise<void> {
    await this.#ensure();
    await this.#db.query("DELETE FROM ship_live WHERE run_id = $1", [runId]);
  }
}
