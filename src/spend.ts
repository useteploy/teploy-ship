import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { stateDir } from "./run-store.js";

/**
 * Per-source spend ledger, bucketed by UTC day. The worker adds a run's
 * computed dollar cost as it completes and reads the running total when
 * deciding whether a source may auto-launch — the spend cap that rides
 * alongside the count cap. "Reset" is implicit: a new UTC day is a new
 * key, so yesterday's total never blocks today.
 */
export interface SpendStore {
  /** Add `amountUSD` to a source's accumulated spend for `day` (UTC "YYYY-MM-DD"). */
  add(source: string, day: string, amountUSD: number): Promise<void>;
  /** Accumulated spend for `source` on `day`; 0 if nothing recorded. */
  get(source: string, day: string): Promise<number>;
}

/** Today's date as the UTC "YYYY-MM-DD" bucket key. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** File-backed ledger: one JSON per day mapping source -> accumulated USD. */
export class FileSpendStore implements SpendStore {
  #dir: string;

  constructor(dir = join(stateDir(), "spend")) {
    this.#dir = dir;
  }

  #path(day: string): string {
    return join(this.#dir, `${day}.json`);
  }

  async #read(day: string): Promise<Record<string, number>> {
    try {
      return JSON.parse(await readFile(this.#path(day), "utf8")) as Record<string, number>;
    } catch {
      return {};
    }
  }

  async add(source: string, day: string, amountUSD: number): Promise<void> {
    if (!(amountUSD > 0)) return; // ignore zero/negative/NaN
    await mkdir(this.#dir, { recursive: true });
    const totals = await this.#read(day);
    totals[source] = (totals[source] ?? 0) + amountUSD;
    await writeFile(this.#path(day), JSON.stringify(totals, null, 2));
  }

  async get(source: string, day: string): Promise<number> {
    return (await this.#read(day))[source] ?? 0;
  }
}

/** Nucleus-backed ledger over the pgwire adapter's ship_spend table. */
export class NucleusSpendStore implements SpendStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_spend (
          day TEXT,
          source TEXT,
          amount_usd TEXT
        )`,
      )
      .then(() => undefined);
    return this.#ready;
  }

  async add(source: string, day: string, amountUSD: number): Promise<void> {
    if (!(amountUSD > 0)) return;
    await this.#ensure();
    // Read-modify-write: total client-side (arithmetic over Nucleus TEXT
    // columns isn't a path we lean on) then upsert by (day, source).
    const rows = await this.#db.query(
      "SELECT amount_usd FROM ship_spend WHERE day = $1 AND source = $2",
      [day, source],
    );
    if (rows.length > 0) {
      const current = Number(rows[0]!.amount_usd);
      const next = (Number.isFinite(current) ? current : 0) + amountUSD;
      await this.#db.query(
        "UPDATE ship_spend SET amount_usd = $1 WHERE day = $2 AND source = $3",
        [String(next), day, source],
      );
    } else {
      await this.#db.query(
        "INSERT INTO ship_spend (day, source, amount_usd) VALUES ($1, $2, $3)",
        [day, source, String(amountUSD)],
      );
    }
  }

  async get(source: string, day: string): Promise<number> {
    await this.#ensure();
    const rows = await this.#db.query(
      "SELECT amount_usd FROM ship_spend WHERE day = $1 AND source = $2",
      [day, source],
    );
    if (rows.length === 0) return 0;
    const value = Number(rows[0]!.amount_usd);
    return Number.isFinite(value) ? value : 0;
  }
}
