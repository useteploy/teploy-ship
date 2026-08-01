import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { readJsonFile, updateJsonFile } from "./file-store.js";
import { stateDir } from "./run-store.js";

/**
 * Mid-run steering: notes an operator sends INTO a running run. The
 * dashboard (or CLI) adds a note; the durable loop drains pending notes
 * at the top of each turn inside a recorded step, so the redirect lands
 * on the agent's next thought and replays deterministically — the store
 * is only ever read live once, everything after is the step's recorded
 * result. Deliberately NOT workflow events: an event poll's hit/miss
 * depends on wall-clock delivery order, which a replay cannot reconstruct.
 */

export interface SteerNote {
  runId: string;
  text: string;
  createdAt: string;
}

export interface SteerStore {
  add(runId: string, text: string): Promise<void>;
  /**
   * Consume the run's pending notes for a given TURN, oldest first.
   *
   * Keyed by turn rather than "whatever is unconsumed", because this runs
   * inside a recorded workflow step and the store is mutated before the step
   * result is committed. A crash in that window used to lose the notes
   * permanently: replay called drain again, the notes were already marked
   * consumed, and the operator's instruction vanished from the reconstructed
   * transcript. Stamping notes with the turn that claimed them makes the call
   * idempotent — a replay of turn N re-selects exactly the notes stamped N.
   */
  drain(runId: string, turn: number): Promise<string[]>;
  /** Still-pending (undrained) notes — the dashboard shows what hasn't landed yet. */
  pending(runId: string): Promise<SteerNote[]>;
}

/** File-backed steering: one JSONL per run + a consumed-count cursor file. */
export class FileSteerStore implements SteerStore {
  #dir: string;

  constructor(dir = join(stateDir(), "steer")) {
    this.#dir = dir;
  }

  #file(runId: string): string {
    return join(this.#dir, `${runId.replace(/[^a-zA-Z0-9._-]/g, "_")}.jsonl`);
  }

  #parse(raw: string, runId: string): SteerNote[] {
    const notes: SteerNote[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const note = JSON.parse(line) as SteerNote;
        if (note.runId === runId) notes.push(note); // sanitized names can collide
      } catch {
        // torn tail line — skip
      }
    }
    return notes;
  }

  async add(runId: string, text: string): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const note: SteerNote = { runId, text, createdAt: new Date().toISOString() };
    const { appendFile } = await import("node:fs/promises");
    await appendFile(this.#file(runId), JSON.stringify(note) + "\n");
  }

  /**
   * Turn -> [start, end) note range, so replaying a turn returns the same
   * notes rather than an empty set.
   */
  async #claims(runId: string): Promise<Record<string, [number, number]>> {
    return readJsonFile<Record<string, [number, number]>>(`${this.#file(runId)}.claims`, {});
  }

  async drain(runId: string, turn: number): Promise<string[]> {
    const raw = await readFile(this.#file(runId), "utf8").catch(() => "");
    const notes = this.#parse(raw, runId);
    const claims = await this.#claims(runId);
    const existing = claims[String(turn)];
    if (existing !== undefined) {
      // Replay of an already-claimed turn: hand back exactly what it consumed.
      return notes.slice(existing[0], existing[1]).map((n) => n.text);
    }
    const start = Math.max(0, ...Object.values(claims).map(([, end]) => end), 0);
    if (start >= notes.length) return [];
    await updateJsonFile<Record<string, [number, number]>>(`${this.#file(runId)}.claims`, {}, (all) => ({
      ...all,
      [String(turn)]: [start, notes.length],
    }));
    return notes.slice(start).map((n) => n.text);
  }

  async pending(runId: string): Promise<SteerNote[]> {
    const raw = await readFile(this.#file(runId), "utf8").catch(() => "");
    const claims = await this.#claims(runId);
    const consumed = Math.max(0, ...Object.values(claims).map(([, end]) => end), 0);
    return this.#parse(raw, runId).slice(consumed);
  }
}

/** Nucleus-backed steering over a ship_steer table (pgwire adapter). */
export class NucleusSteerStore implements SteerStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_steer (
          note_id TEXT,
          run_id TEXT,
          text TEXT,
          created_at TEXT,
          consumed TEXT,
          consumed_turn TEXT
        )`,
      )
      .then(() => undefined);
    return this.#ready;
  }

  async add(runId: string, text: string): Promise<void> {
    await this.#ensure();
    await this.#db.query(
      "INSERT INTO ship_steer (note_id, run_id, text, created_at, consumed) VALUES ($1, $2, $3, $4, '0')",
      [`steer-${randomUUID().slice(0, 8)}`, runId, text, new Date().toISOString()],
    );
  }

  #sort(rows: Record<string, unknown>[]): Array<{ id: string; text: string; createdAt: string }> {
    return rows
      .map((row) => ({ id: String(row.note_id), text: String(row.text), createdAt: String(row.created_at) }))
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
  }

  async #unconsumed(runId: string): Promise<Array<{ id: string; text: string; createdAt: string }>> {
    await this.#ensure();
    return this.#sort(await this.#db.query("SELECT * FROM ship_steer WHERE run_id = $1 AND consumed = '0'", [runId]));
  }

  /**
   * Stamp-then-read, both idempotent:
   *
   *   UPDATE … SET consumed_turn = <turn> WHERE run_id = … AND consumed = '0'
   *   SELECT  … WHERE run_id = … AND consumed_turn = <turn>
   *
   * A crash between the two replays harmlessly — the stamp matches nothing new
   * the second time, and the select returns the same notes. The old code marked
   * a boolean and then returned rows it had read BEFORE the update, so a crash
   * in the window consumed the notes without ever delivering them, and did it
   * one row at a time so a prefix could be lost on its own.
   */
  async drain(runId: string, turn: number): Promise<string[]> {
    await this.#ensure();
    const stamp = String(turn);
    await this.#db.query(
      "UPDATE ship_steer SET consumed = '1', consumed_turn = $1 WHERE run_id = $2 AND consumed = '0'",
      [stamp, runId],
    );
    const rows = await this.#db.query("SELECT * FROM ship_steer WHERE run_id = $1 AND consumed_turn = $2", [
      runId,
      stamp,
    ]);
    return this.#sort(rows).map((n) => n.text);
  }

  async pending(runId: string): Promise<SteerNote[]> {
    return (await this.#unconsumed(runId)).map((n) => ({ runId, text: n.text, createdAt: n.createdAt }));
  }
}
