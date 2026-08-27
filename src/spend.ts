import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
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
/** One (day, source) bucket in the spend ledger. */
export interface SpendEntry {
  day: string;
  source: string;
  amountUSD: number;
}

export interface SpendStore {
  /** Add `amountUSD` to a source's accumulated spend for `day` (UTC "YYYY-MM-DD"). */
  add(source: string, day: string, amountUSD: number): Promise<void>;
  /**
   * Accumulated spend for `source` on `day`, INCLUDING outstanding reservations
   * — so a budget check sees money that is already committed to runs still in
   * flight, not just money that has finished being spent. 0 if nothing recorded.
   */
  get(source: string, day: string): Promise<number>;
  /** Every recorded (day, source, amount) bucket — for the spend dashboard. */
  list(): Promise<SpendEntry[]>;
  /**
   * Hold `amountUSD` against a source's budget before a run starts.
   *
   * The budget check used to be read-then-launch: several workers could all
   * observe "room left" and all launch, because nothing recorded the intent
   * between the read and the spend. A reservation IS that record — written
   * first, then the total re-read, so concurrent admitters see each other and
   * back off. Over-reserving briefly is the safe direction; over-spending is not.
   */
  reserve(reservationId: string, source: string, day: string, amountUSD: number): Promise<void>;
  /** Drop a reservation — on refusal, or when the real cost is recorded. */
  release(reservationId: string): Promise<void>;
  /**
   * Is a reservation already outstanding under this id?
   *
   * Exists so the budget check at ENQUEUE (assertDailyBudget in runtime.ts) can
   * tell "nobody has admitted this run yet" from "the intake sweep already
   * reserved for it and is now calling enqueueRun" (worker.ts:286 reserves
   * under the same runId it then passes to `launch`). Without that distinction
   * an enqueue-side check either double-counts the sweep's launches against the
   * budget or re-decides an admission the sweep already made — and the sweep
   * cannot pass a flag, because it calls `enqueueRun` through an injected
   * `launch` callback it constructs itself.
   *
   * OPTIONAL on the interface, not required: several test doubles implement
   * SpendStore, and a required method would break files this change does not
   * own. A store without it is treated as "not held", which falls back to the
   * idempotent-reserve safety below rather than to overspending.
   */
  held?(reservationId: string): Promise<boolean>;
}

/** Today's date as the UTC "YYYY-MM-DD" bucket key. */
export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Per-source daily cap when nothing overrides it. Mirrors worker.ts:774. */
export const DEFAULT_DAILY_BUDGET_USD = 10;
/** What one in-flight run is assumed to cost. Mirrors worker.ts:773. */
export const DEFAULT_ESTIMATED_RUN_COST_USD = 0.5;

function envNumber(name: string, env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * The default per-source daily cap, from the environment.
 *
 * Read HERE as well as in the worker because there are now two places that
 * admit a run against a budget — the intake sweep and `enqueueRun` — and the
 * second of them (the CLI, the dashboard, the scan API) runs in processes that
 * never construct a worker. Same env var, same default, so an operator who sets
 * SHIP_DAILY_BUDGET_USD gets one number across both.
 */
export function defaultDailyBudgetUSD(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber("SHIP_DAILY_BUDGET_USD", env) ?? DEFAULT_DAILY_BUDGET_USD;
}

/** The in-flight estimate held against a budget until settlement replaces it. */
export function estimatedRunCostUSD(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber("SHIP_ESTIMATED_RUN_COST_USD", env) ?? DEFAULT_ESTIMATED_RUN_COST_USD;
}

/**
 * File-backed ledger: one append-only JSONL per day of {source, amountUSD}
 * deltas. Append-only on purpose — a read-modify-write total loses increments
 * when two runs finish at once (the fleet is multi-worker), which would let the
 * budget cap read low and overspend. Reads sum the deltas.
 */
export class FileSpendStore implements SpendStore {
  #dir: string;
  /** Outstanding holds: id -> {source, day, amount}. */
  #reservations = new Map<string, { source: string; day: string; amountUSD: number }>();

  constructor(dir = join(stateDir(), "spend")) {
    this.#dir = dir;
  }

  #path(day: string): string {
    return join(this.#dir, `${day}.jsonl`);
  }

  #reserved(source: string, day: string): number {
    let total = 0;
    for (const r of this.#reservations.values()) {
      if (r.source === source && r.day === day) total += r.amountUSD;
    }
    return total;
  }

  // Map.set is already idempotent by id — reserving twice under one runId
  // holds the amount once, which is the property NucleusSpendStore had to be
  // taught explicitly. See the note on its reserve().
  async reserve(reservationId: string, source: string, day: string, amountUSD: number): Promise<void> {
    if (!(amountUSD > 0)) return;
    this.#reservations.set(reservationId, { source, day, amountUSD });
  }

  async release(reservationId: string): Promise<void> {
    this.#reservations.delete(reservationId);
  }

  async held(reservationId: string): Promise<boolean> {
    return this.#reservations.has(reservationId);
  }

  /** Sum a day's deltas into source -> total. */
  async #sumDay(day: string): Promise<Map<string, number>> {
    const raw = await readFile(this.#path(day), "utf8").catch(() => "");
    const totals = new Map<string, number>();
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const { source, amountUSD } = JSON.parse(line) as { source: string; amountUSD: number };
        if (typeof source === "string" && typeof amountUSD === "number" && amountUSD > 0) {
          totals.set(source, (totals.get(source) ?? 0) + amountUSD);
        }
      } catch {
        // torn tail line — skip
      }
    }
    return totals;
  }

  async add(source: string, day: string, amountUSD: number): Promise<void> {
    if (!(amountUSD > 0)) return; // ignore zero/negative/NaN
    await mkdir(this.#dir, { recursive: true });
    await appendFile(this.#path(day), JSON.stringify({ source, amountUSD }) + "\n");
  }

  async get(source: string, day: string): Promise<number> {
    return ((await this.#sumDay(day)).get(source) ?? 0) + this.#reserved(source, day);
  }

  async list(): Promise<SpendEntry[]> {
    let files: string[];
    try {
      files = await readdir(this.#dir);
    } catch {
      return [];
    }
    const entries: SpendEntry[] = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const day = file.slice(0, -6);
      for (const [source, amountUSD] of await this.#sumDay(day)) {
        entries.push({ day, source, amountUSD });
      }
    }
    return entries;
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
    this.#ready ??= (async () => {
      await this.#db.query(
        `CREATE TABLE IF NOT EXISTS ship_spend (
          day TEXT,
          source TEXT,
          amount_usd TEXT
        )`,
      );
      // Separate table rather than a column on ship_spend: Nucleus cannot ALTER
      // a populated table, and a reservation has a lifecycle (it is deleted)
      // that an append-only ledger deliberately does not.
      await this.#db.query(
        `CREATE TABLE IF NOT EXISTS ship_spend_holds (
          hold_id TEXT,
          day TEXT,
          source TEXT,
          amount_usd TEXT,
          created_at TEXT
        )`,
      );
    })();
    return this.#ready;
  }

  /**
   * IDEMPOTENT BY id. A bare INSERT was not: two reservations under one runId
   * held the estimate twice and the budget read high, which now matters because
   * two admission points can reserve for the same run — the intake sweep
   * (worker.ts:286) and the enqueue check (assertDailyBudget in runtime.ts).
   * A hold is a statement about one run, so the second write must replace the
   * first rather than add to it.
   */
  async reserve(reservationId: string, source: string, day: string, amountUSD: number): Promise<void> {
    if (!(amountUSD > 0)) return;
    await this.#ensure();
    await this.#db.query("DELETE FROM ship_spend_holds WHERE hold_id = $1", [reservationId]);
    await this.#db.query(
      "INSERT INTO ship_spend_holds (hold_id, day, source, amount_usd, created_at) VALUES ($1, $2, $3, $4, $5)",
      [reservationId, day, source, String(amountUSD), new Date().toISOString()],
    );
  }

  async release(reservationId: string): Promise<void> {
    await this.#ensure();
    await this.#db.query("DELETE FROM ship_spend_holds WHERE hold_id = $1", [reservationId]);
  }

  async held(reservationId: string): Promise<boolean> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT hold_id FROM ship_spend_holds WHERE hold_id = $1", [reservationId]);
    return rows.length > 0;
  }

  /** Sum of holds still outstanding for a bucket. Stale holds are ignored by age. */
  async #heldFor(source: string, day: string): Promise<number> {
    const rows = await this.#db.query(
      "SELECT amount_usd, created_at FROM ship_spend_holds WHERE day = $1 AND source = $2",
      [day, source],
    );
    // A worker that died between reserving and settling would otherwise hold
    // budget forever. Anything older than a day is treated as lapsed — by then
    // its run has either settled (and the hold was released) or is gone.
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    return rows.reduce((sum, r) => {
      if (typeof r.created_at === "string" && r.created_at < cutoff) return sum;
      const v = Number(r.amount_usd);
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);
  }

  async add(source: string, day: string, amountUSD: number): Promise<void> {
    if (!(amountUSD > 0)) return;
    await this.#ensure();
    // Append-only: one delta row per add, no read-modify-write — so concurrent
    // adds from multiple workers can't lose an increment or race an upsert.
    // (Old accumulated-total rows from the previous scheme still sum in fine.)
    await this.#db.query("INSERT INTO ship_spend (day, source, amount_usd) VALUES ($1, $2, $3)", [
      day,
      source,
      String(amountUSD),
    ]);
  }

  async get(source: string, day: string): Promise<number> {
    await this.#ensure();
    const rows = await this.#db.query(
      "SELECT amount_usd FROM ship_spend WHERE day = $1 AND source = $2",
      [day, source],
    );
    const settled = rows.reduce((sum, r) => {
      const v = Number(r.amount_usd);
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);
    return settled + (await this.#heldFor(source, day));
  }

  async list(): Promise<SpendEntry[]> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT day, source, amount_usd FROM ship_spend");
    // Sum deltas per (day, source) client-side.
    const map = new Map<string, SpendEntry>();
    for (const r of rows) {
      const day = String(r.day);
      const source = String(r.source);
      const v = Number(r.amount_usd);
      const amountUSD = Number.isFinite(v) ? v : 0;
      const key = `${day} ${source}`;
      const e = map.get(key);
      if (e !== undefined) e.amountUSD += amountUSD;
      else map.set(key, { day, source, amountUSD });
    }
    return [...map.values()];
  }
}

/**
 * Unpriced runs (P5-3): work that consumed a quota Ship cannot price — a
 * subscription-fed harness, or one that reports tokens with no cost. Such a
 * run is never added to the dollar ledger above and is never reported as $0;
 * it is COUNTED here, per source and UTC day, and the Spend page shows the
 * count as its own line. The daily auto-launch count cap is what bounds a
 * source whose runs are unpriced; the dollar cap cannot see them.
 */
export interface UnpricedRunEntry {
  day: string;
  source: string;
  runs: number;
}

export interface UnpricedRunStore {
  /** Count one run. `runId` is recorded so a double settle is visible, not silently doubled. */
  add(source: string, day: string, runId: string): Promise<void>;
  /** Runs counted for `source` on `day`. */
  count(source: string, day: string): Promise<number>;
  /** Every (day, source) bucket — for the spend dashboard. */
  list(): Promise<UnpricedRunEntry[]>;
}

/** File-backed: one append-only JSONL per day of {source, runId} lines. */
export class FileUnpricedRunStore implements UnpricedRunStore {
  #dir: string;

  constructor(dir = join(stateDir(), "unpriced-runs")) {
    this.#dir = dir;
  }

  #path(day: string): string {
    return join(this.#dir, `${day}.jsonl`);
  }

  async #day(day: string): Promise<Map<string, Set<string>>> {
    const raw = await readFile(this.#path(day), "utf8").catch(() => "");
    const bySource = new Map<string, Set<string>>();
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const { source, runId } = JSON.parse(line) as { source: string; runId: string };
        if (typeof source !== "string" || typeof runId !== "string") continue;
        const set = bySource.get(source) ?? new Set<string>();
        set.add(runId);
        bySource.set(source, set);
      } catch {
        // torn tail line — skip
      }
    }
    return bySource;
  }

  async add(source: string, day: string, runId: string): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    await appendFile(this.#path(day), JSON.stringify({ source, runId }) + "\n");
  }

  async count(source: string, day: string): Promise<number> {
    return (await this.#day(day)).get(source)?.size ?? 0;
  }

  async list(): Promise<UnpricedRunEntry[]> {
    let files: string[];
    try {
      files = await readdir(this.#dir);
    } catch {
      return [];
    }
    const entries: UnpricedRunEntry[] = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const day = file.slice(0, -6);
      for (const [source, ids] of await this.#day(day)) entries.push({ day, source, runs: ids.size });
    }
    return entries;
  }
}

/** Nucleus-backed: one row per counted run in ship_unpriced_runs. */
export class NucleusUnpricedRunStore implements UnpricedRunStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= (async () => {
      await this.#db.query(
        `CREATE TABLE IF NOT EXISTS ship_unpriced_runs (
          day TEXT,
          source TEXT,
          run_id TEXT,
          at TEXT
        )`,
      );
    })().catch((error) => {
      // A failed ensure is retried on the next call, never cached for the
      // life of the process (the 2026-08-24 dashboard lesson).
      this.#ready = null;
      throw error;
    });
    return this.#ready;
  }

  async add(source: string, day: string, runId: string): Promise<void> {
    await this.#ensure();
    await this.#db.query("INSERT INTO ship_unpriced_runs (day, source, run_id, at) VALUES ($1, $2, $3, $4)", [
      day,
      source,
      runId,
      new Date().toISOString(),
    ]);
  }

  async count(source: string, day: string): Promise<number> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT run_id FROM ship_unpriced_runs WHERE day = $1 AND source = $2", [day, source]);
    return new Set(rows.map((r) => String(r.run_id))).size;
  }

  async list(): Promise<UnpricedRunEntry[]> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT day, source, run_id FROM ship_unpriced_runs");
    const map = new Map<string, Set<string>>();
    for (const r of rows) {
      const key = `${String(r.day)} ${String(r.source)}`;
      const set = map.get(key) ?? new Set<string>();
      set.add(String(r.run_id));
      map.set(key, set);
    }
    return [...map.entries()].map(([key, ids]) => {
      const space = key.indexOf(" ");
      return { day: key.slice(0, space), source: key.slice(space + 1), runs: ids.size };
    });
  }
}
