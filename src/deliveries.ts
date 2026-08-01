import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { stateDir } from "./run-store.js";

/**
 * Seen-delivery ledger — replay protection for the public webhook receivers.
 *
 * HMAC proves a body came from someone holding the secret. It does NOT prove
 * the body is fresh: a captured delivery stays valid forever and can be resent
 * as many times as the attacker likes. Slack bounds this with a five-minute
 * timestamp window, but the git forges do not, and even Slack's window allows
 * repeats inside it.
 *
 * Every forge stamps a unique delivery id, so claiming that id before acting
 * turns "authentic" into "authentic and processed once". Task dedupe already
 * collapses most repeats, but it only helps where the replay maps onto the same
 * dedupeKey — a re-delivered comment on a dismissed task would otherwise create
 * a fresh run.
 *
 * Entries expire: a ledger that grows forever is its own outage.
 */
export interface DeliveryLog {
  /** Record this delivery. True iff THIS caller claimed it (i.e. it is new). */
  claim(source: string, deliveryId: string): Promise<boolean>;
}

/** How long a delivery id is remembered. Far longer than any forge retries. */
export const DELIVERY_TTL_S = 7 * 24 * 60 * 60;

/**
 * File-backed: an append-only log per UTC day, with the current and previous
 * day consulted on read. Day bucketing is the expiry — old files simply stop
 * being read (and can be deleted by anything that cleans the state dir).
 *
 * Best-effort across processes, like the other file stores: file mode is the
 * single-process dev path, and a multi-process deployment runs on Nucleus where
 * the claim is a genuine atomic setNX.
 */
export class FileDeliveryLog implements DeliveryLog {
  #dir: string;

  constructor(dir = join(stateDir(), "deliveries")) {
    this.#dir = dir;
  }

  #path(day: string): string {
    return join(this.#dir, `${day}.log`);
  }

  async #seen(key: string, days: string[]): Promise<boolean> {
    for (const day of days) {
      const raw = await readFile(this.#path(day), "utf8").catch(() => "");
      if (raw.split("\n").includes(key)) return true;
    }
    return false;
  }

  async claim(source: string, deliveryId: string): Promise<boolean> {
    const key = `${source}:${deliveryId}`;
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
    if (await this.#seen(key, [today, yesterday])) return false;
    await mkdir(this.#dir, { recursive: true });
    await appendFile(this.#path(today), key + "\n");
    return true;
  }
}

/**
 * Nucleus-backed: one conditional KV write. KV_SETNX is atomic and takes a
 * TTL, which is exactly the shape this needs — no table, no sweep, and two
 * concurrent replays of one delivery cannot both win.
 */
export class NucleusDeliveryLog implements DeliveryLog {
  #db: NucleusPgwire;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  async claim(source: string, deliveryId: string): Promise<boolean> {
    return this.#db.kv.setNX(`ship:delivery:${source}:${deliveryId}`, "1", { ttl: DELIVERY_TTL_S });
  }
}
