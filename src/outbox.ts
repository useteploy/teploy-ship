import { join } from "node:path";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { readJsonFile, updateJsonFile } from "./file-store.js";
import { stateDir } from "./run-store.js";
import type { RunNotification } from "./notify.js";

/**
 * Durable outbox for run notifications.
 *
 * Delivery used to be a detached promise fired from the worker's completion
 * callback: nothing recorded that a notification was owed, nothing recorded
 * that it arrived, and a crash, restart, or provider timeout in that window
 * simply lost it. The notification most likely to be lost is the one that
 * matters most — "this run is parked waiting for you" — because a parked run
 * produces no further events to notice it by.
 *
 * The shape is the usual one: write the intent first, attempt delivery, mark
 * delivered. Anything still pending after its backoff is retried by a later
 * sweep, and delivery carries a stable id so a receiver can discard repeats
 * (at-least-once, deduplicable — the honest guarantee for webhooks).
 */
export interface OutboxEntry {
  id: string;
  event: RunNotification;
  attempts: number;
  /** Epoch ms; not eligible for delivery before this. */
  nextAttemptAt: number;
  createdAt: string;
}

export interface Outbox {
  /** Record a notification that is owed. Idempotent on `id`. */
  enqueue(entry: Omit<OutboxEntry, "attempts" | "nextAttemptAt" | "createdAt">): Promise<void>;
  /** Entries due for delivery at `now`. */
  due(now: number, limit?: number): Promise<OutboxEntry[]>;
  /** Delivered — stop trying. */
  settle(id: string): Promise<void>;
  /** Delivery failed; schedule the next attempt (or drop after too many). */
  fail(id: string, now: number): Promise<void>;
}

/** Attempts before an entry is abandoned. ~1 + 2 + 4 + 8 + 16 minutes of retrying. */
export const MAX_ATTEMPTS = 6;

export function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
}

/** A stable id for a run/status pair, so retries and restarts do not duplicate. */
export function notificationId(event: RunNotification): string {
  return `${event.runId}:${event.status}:${event.eventName ?? ""}`;
}

export class FileOutbox implements Outbox {
  #path: string;

  constructor(dir = stateDir()) {
    this.#path = join(dir, "outbox.json");
  }

  async enqueue(entry: Omit<OutboxEntry, "attempts" | "nextAttemptAt" | "createdAt">): Promise<void> {
    await updateJsonFile<Record<string, OutboxEntry>>(this.#path, {}, (all) =>
      all[entry.id] !== undefined
        ? all
        : { ...all, [entry.id]: { ...entry, attempts: 0, nextAttemptAt: 0, createdAt: new Date().toISOString() } },
    );
  }

  async due(now: number, limit = 50): Promise<OutboxEntry[]> {
    const all = await readJsonFile<Record<string, OutboxEntry>>(this.#path, {});
    return Object.values(all)
      .filter((e) => e.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  async settle(id: string): Promise<void> {
    await updateJsonFile<Record<string, OutboxEntry>>(this.#path, {}, (all) => {
      const { [id]: _gone, ...rest } = all;
      return rest;
    });
  }

  async fail(id: string, now: number): Promise<void> {
    await updateJsonFile<Record<string, OutboxEntry>>(this.#path, {}, (all) => {
      const entry = all[id];
      if (entry === undefined) return all;
      const attempts = entry.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        const { [id]: _dropped, ...rest } = all;
        return rest;
      }
      return { ...all, [id]: { ...entry, attempts, nextAttemptAt: now + backoffMs(attempts) } };
    });
  }
}

export class NucleusOutbox implements Outbox {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_outbox (
          id TEXT,
          payload TEXT,
          attempts TEXT,
          next_attempt_at TEXT,
          created_at TEXT
        )`,
      )
      .then(() => undefined);
    return this.#ready;
  }

  async enqueue(entry: Omit<OutboxEntry, "attempts" | "nextAttemptAt" | "createdAt">): Promise<void> {
    await this.#ensure();
    // setNX is the identity this table cannot express: two workers completing
    // the same run (a handoff) must owe ONE notification, not two.
    if (!(await this.#db.kv.setNX(`ship:outbox:${entry.id}`, "1", { ttl: 24 * 60 * 60 }))) return;
    await this.#db.query(
      "INSERT INTO ship_outbox (id, payload, attempts, next_attempt_at, created_at) VALUES ($1, $2, '0', '0', $3)",
      [entry.id, JSON.stringify(entry.event), new Date().toISOString()],
    );
  }

  async due(now: number, limit = 50): Promise<OutboxEntry[]> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT * FROM ship_outbox");
    return rows
      .map((r) => ({
        id: String(r.id),
        event: JSON.parse(String(r.payload)) as RunNotification,
        attempts: Number(r.attempts) || 0,
        nextAttemptAt: Number(r.next_attempt_at) || 0,
        createdAt: String(r.created_at),
      }))
      .filter((e) => e.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  async settle(id: string): Promise<void> {
    await this.#ensure();
    await this.#db.query("DELETE FROM ship_outbox WHERE id = $1", [id]);
  }

  async fail(id: string, now: number): Promise<void> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT attempts FROM ship_outbox WHERE id = $1", [id]);
    if (rows.length === 0) return;
    const attempts = (Number(rows[0]!.attempts) || 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await this.settle(id);
      return;
    }
    await this.#db.query("UPDATE ship_outbox SET attempts = $1, next_attempt_at = $2 WHERE id = $3", [
      String(attempts),
      String(now + backoffMs(attempts)),
      id,
    ]);
  }
}

/**
 * Deliver everything due. Returns how many were delivered; failures stay in the
 * outbox with a later `nextAttemptAt`. The notifier is a plain function here so
 * the sweep is testable without a network.
 */
export async function flushOutbox(
  outbox: Outbox,
  deliver: (event: RunNotification, id: string) => Promise<boolean>,
  now = Date.now(),
): Promise<number> {
  let delivered = 0;
  for (const entry of await outbox.due(now)) {
    let ok = false;
    try {
      ok = await deliver(entry.event, entry.id);
    } catch {
      ok = false;
    }
    if (ok) {
      await outbox.settle(entry.id);
      delivered += 1;
    } else {
      await outbox.fail(entry.id, now);
    }
  }
  return delivered;
}
