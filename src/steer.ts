import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
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
  /** Consume the run's pending notes, oldest first. Drained notes are gone. */
  drain(runId: string): Promise<string[]>;
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

  async #cursor(runId: string): Promise<number> {
    const raw = await readFile(`${this.#file(runId)}.cursor`, "utf8").catch(() => "0");
    const n = Number(raw.trim());
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  }

  async add(runId: string, text: string): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const note: SteerNote = { runId, text, createdAt: new Date().toISOString() };
    const { appendFile } = await import("node:fs/promises");
    await appendFile(this.#file(runId), JSON.stringify(note) + "\n");
  }

  async drain(runId: string): Promise<string[]> {
    const raw = await readFile(this.#file(runId), "utf8").catch(() => "");
    const notes = this.#parse(raw, runId);
    const cursor = await this.#cursor(runId);
    const fresh = notes.slice(cursor);
    if (fresh.length > 0) {
      // Advance by exactly what we read — an add landing mid-drain stays pending.
      await writeFile(`${this.#file(runId)}.cursor`, String(notes.length));
    }
    return fresh.map((n) => n.text);
  }

  async pending(runId: string): Promise<SteerNote[]> {
    const raw = await readFile(this.#file(runId), "utf8").catch(() => "");
    return this.#parse(raw, runId).slice(await this.#cursor(runId));
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
          consumed TEXT
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

  async #unconsumed(runId: string): Promise<Array<{ id: string; text: string; createdAt: string }>> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT * FROM ship_steer WHERE run_id = $1 AND consumed = '0'", [runId]);
    return rows
      .map((row) => ({ id: String(row.note_id), text: String(row.text), createdAt: String(row.created_at) }))
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
  }

  async drain(runId: string): Promise<string[]> {
    const notes = await this.#unconsumed(runId);
    // Consume per-id, never by re-querying — an add landing mid-drain must
    // stay pending for the next turn, not get marked consumed unseen.
    for (const note of notes) {
      await this.#db.query("UPDATE ship_steer SET consumed = '1' WHERE note_id = $1", [note.id]);
    }
    return notes.map((n) => n.text);
  }

  async pending(runId: string): Promise<SteerNote[]> {
    return (await this.#unconsumed(runId)).map((n) => ({ runId, text: n.text, createdAt: n.createdAt }));
  }
}
