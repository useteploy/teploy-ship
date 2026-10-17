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

/**
 * How an operator message is applied (D2, SHIP_STEER_REPLY). `steer` is the
 * original behaviour — drained at the next turn boundary. `queue` is HELD
 * until the agent's next checkpoint (the turn after it posts a ```reply, or
 * its next ```finish). `interrupt` asks the loop to stop the in-flight action
 * at its next safe point. Only `steer` lives in the original store (the
 * ship_steer table / `<run>.jsonl`); the other two live in their own
 * (`ship_steer_held` / `<run>.held.jsonl`), so a run without the flag reads
 * exactly the rows it always read. See docs/STEERING_DESIGN.md.
 */
export type SteerMode = "steer" | "queue" | "interrupt";
export type HeldKind = Exclude<SteerMode, "steer">;

/** A held (queue / interrupt) message still waiting for its checkpoint. */
export interface HeldNote extends SteerNote {
  mode: HeldKind;
}

export interface SteerStore {
  /** Mode defaults to `steer` — every pre-D2 caller keeps its behaviour. */
  add(runId: string, text: string, mode?: SteerMode): Promise<void>;
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
   *
   * The key is a string or a number: callers that run several attempts of one
   * task (durable.ts) pass an attempt-scoped key on steerReply runs, so
   * attempt 1's turn N does not answer with attempt 0's notes. Every other
   * caller passes the plain turn and the store bytes are exactly what they
   * always were.
   */
  drain(runId: string, turn: number | string): Promise<string[]>;
  /** Still-pending (undrained) notes — the dashboard shows what hasn't landed yet. */
  pending(runId: string): Promise<SteerNote[]>;
  /**
   * Claim every pending held message of one kind under `key`, oldest first.
   * Same idempotency contract as drain: called inside a recorded step, so a
   * repeated call with the same key returns exactly what the first claimed,
   * and anything newly arrived stays pending for a later key.
   */
  claimHeld(runId: string, kind: HeldKind, key: string): Promise<string[]>;
  /** Held messages not yet claimed by any checkpoint. */
  pendingHeld(runId: string): Promise<HeldNote[]>;
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

  async add(runId: string, text: string, mode: SteerMode = "steer"): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const { appendFile } = await import("node:fs/promises");
    if (mode !== "steer") {
      const held: HeldNote = { runId, text, createdAt: new Date().toISOString(), mode };
      await appendFile(this.#heldFile(runId), JSON.stringify(held) + "\n");
      return;
    }
    const note: SteerNote = { runId, text, createdAt: new Date().toISOString() };
    await appendFile(this.#file(runId), JSON.stringify(note) + "\n");
  }

  #heldFile(runId: string): string {
    return this.#file(runId).replace(/\.jsonl$/, ".held.jsonl");
  }

  async #held(runId: string): Promise<HeldNote[]> {
    const raw = await readFile(this.#heldFile(runId), "utf8").catch(() => "");
    return this.#parse(raw, runId).filter((n): n is HeldNote => {
      const mode = (n as Partial<HeldNote>).mode;
      return mode === "queue" || mode === "interrupt";
    });
  }

  /** Claim key -> the held-line indices it consumed. */
  async #heldClaims(runId: string): Promise<Record<string, number[]>> {
    return readJsonFile<Record<string, number[]>>(`${this.#heldFile(runId)}.claims`, {});
  }

  async claimHeld(runId: string, kind: HeldKind, key: string): Promise<string[]> {
    const notes = await this.#held(runId);
    let claimed: number[] = [];
    await updateJsonFile<Record<string, number[]>>(`${this.#heldFile(runId)}.claims`, {}, (all) => {
      const existing = all[key];
      if (existing !== undefined) {
        claimed = existing;
        return all;
      }
      const taken = new Set(Object.values(all).flat());
      claimed = notes.flatMap((n, i) => (n.mode === kind && !taken.has(i) ? [i] : []));
      // An empty claim is not written: the key must stay open for a later
      // call (the in-flight interrupt poller reuses one key per action).
      return claimed.length === 0 ? all : { ...all, [key]: claimed };
    });
    return claimed.map((i) => notes[i]!.text);
  }

  async pendingHeld(runId: string): Promise<HeldNote[]> {
    const notes = await this.#held(runId);
    const taken = new Set(Object.values(await this.#heldClaims(runId)).flat());
    return notes.filter((_, i) => !taken.has(i));
  }

  /**
   * Turn -> [start, end) note range, so replaying a turn returns the same
   * notes rather than an empty set.
   */
  /**
   * Key-scoped, not turn-scoped, so `String(turn)` handles both the plain
   * turn numbers every pre-D2 caller passes and the attempt-scoped keys
   * durable.ts uses on steerReply runs.
   */
  async #claims(runId: string): Promise<Record<string, [number, number]>> {
    return readJsonFile<Record<string, [number, number]>>(`${this.#file(runId)}.claims`, {});
  }

  async drain(runId: string, turn: number | string): Promise<string[]> {
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
  #heldReady: Promise<void> | null = null;

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
      .then(() => undefined)
      // A failed ensure must not be cached: one transient store error would
      // otherwise poison every later call for the life of the process.
      .catch((error: unknown) => {
        this.#ready = null;
        throw error;
      });
    return this.#ready;
  }

  #ensureHeld(): Promise<void> {
    this.#heldReady ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_steer_held (
          note_id TEXT,
          run_id TEXT,
          kind TEXT,
          text TEXT,
          created_at TEXT,
          consumed TEXT,
          consumed_key TEXT
        )`,
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#heldReady = null;
        throw error;
      });
    return this.#heldReady;
  }

  async add(runId: string, text: string, mode: SteerMode = "steer"): Promise<void> {
    if (mode !== "steer") {
      await this.#ensureHeld();
      await this.#db.query(
        "INSERT INTO ship_steer_held (note_id, run_id, kind, text, created_at, consumed) VALUES ($1, $2, $3, $4, $5, '0')",
        [`held-${randomUUID().slice(0, 8)}`, runId, mode, text, new Date().toISOString()],
      );
      return;
    }
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
  async drain(runId: string, turn: number | string): Promise<string[]> {
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

  /**
   * Read-before-stamp, so the claim is idempotent per KEY, not per call.
   *
   * A key that already claimed rows answers with those rows alone — no
   * UPDATE. The naive stamp-then-read shape (drain's) would sweep anything
   * that arrived since into the already-delivered claim: a rerun with the
   * same key returned the old rows PLUS the new one, and the new one was
   * consumed without ever being delivered. FileSteerStore already answers a
   * repeat key from its recorded claim; this is the same contract. An empty
   * claim leaves the key open (the in-flight interrupt poller reuses one key
   * per action), exactly as the file store does.
   */
  async claimHeld(runId: string, kind: HeldKind, key: string): Promise<string[]> {
    await this.#ensureHeld();
    const byKey = "SELECT * FROM ship_steer_held WHERE run_id = $1 AND consumed_key = $2 AND kind = $3";
    const prior = await this.#db.query(byKey, [runId, key, kind]);
    if (prior.length > 0) return this.#sort(prior).map((n) => n.text);
    await this.#db.query(
      "UPDATE ship_steer_held SET consumed = '1', consumed_key = $1 WHERE run_id = $2 AND kind = $3 AND consumed = '0'",
      [key, runId, kind],
    );
    const rows = await this.#db.query(byKey, [runId, key, kind]);
    return this.#sort(rows).map((n) => n.text);
  }

  async pendingHeld(runId: string): Promise<HeldNote[]> {
    await this.#ensureHeld();
    const rows = await this.#db.query("SELECT * FROM ship_steer_held WHERE run_id = $1 AND consumed = '0'", [runId]);
    const kinds = new Map(rows.map((row) => [String(row.note_id), String(row.kind)]));
    return this.#sort(rows).flatMap((n): HeldNote[] => {
      const mode = kinds.get(n.id);
      return mode === "queue" || mode === "interrupt" ? [{ runId, text: n.text, createdAt: n.createdAt, mode }] : [];
    });
  }
}
