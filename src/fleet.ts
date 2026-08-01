import { join } from "node:path";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { readJsonFile, updateJsonFile } from "./file-store.js";
import { upsertByKey } from "./upsert.js";
import { stateDir } from "./run-store.js";

/**
 * One worker in the fleet. Workers claim runs from a shared Nucleus queue via
 * leases, so many can run at once across servers; this registry gives the
 * dashboard visibility into who's out there — which host, which sandbox, how
 * much of its capacity is in use, and whether it's still alive (a stale
 * lastSeen means the process is gone).
 */
export interface WorkerInfo {
  owner: string;
  host: string;
  /** Sandbox URL the worker runs code in, or "host" when it runs on the box. */
  sandbox: string;
  maxConcurrent: number;
  activeRuns: number;
  startedAt: string;
  lastSeen: string;
}

export interface FleetStore {
  /** Upsert this worker's liveness/load. Called on an interval by the worker. */
  heartbeat(info: WorkerInfo): Promise<void>;
  /** Every worker still retained; callers decide staleness from lastSeen. */
  list(): Promise<WorkerInfo[]>;
  /**
   * Forget workers whose last heartbeat predates `before`, returning how many
   * went. Without this the registry keeps every worker that ever ran: the
   * Fleet page fills with hosts last seen weeks ago and the table grows without
   * bound. Retention is long enough that a box down for a while still shows as
   * stale rather than silently vanishing.
   */
  prune(before: Date): Promise<number>;
}

/**
 * Which worker host executed a run. Kept in its own table (not a ship_docs
 * column) on purpose: Nucleus can't safely ALTER a populated table to add a
 * column, but a fresh table whose column exists from CREATE is fine — the
 * same pattern the fleet/spend/policy stores use.
 */
export interface PlacementStore {
  set(runId: string, host: string): Promise<void>;
  get(runId: string): Promise<string | null>;
  all(): Promise<Record<string, string>>;
}

/** File-backed placement: one JSON mapping runId -> host. */
export class FilePlacementStore implements PlacementStore {
  #path: string;

  constructor(dir = stateDir()) {
    this.#path = join(dir, "placement.json");
  }

  // A corrupt file throws rather than reading back as "no placements": these
  // answers drive what the dashboard shows and what the sweep believes.
  async #read(): Promise<Record<string, string>> {
    return readJsonFile<Record<string, string>>(this.#path, {});
  }

  async set(runId: string, host: string): Promise<void> {
    // Locked read-modify-write into the file's OWN directory (it used to mkdir
    // stateDir(), so a store built on a custom nested dir failed on first write)
    // and atomically renamed, so two overlapping sets cannot lose one.
    await updateJsonFile<Record<string, string>>(this.#path, {}, (all) => ({ ...all, [runId]: host }));
  }

  async get(runId: string): Promise<string | null> {
    return (await this.#read())[runId] ?? null;
  }

  async all(): Promise<Record<string, string>> {
    return this.#read();
  }
}

/** Nucleus-backed placement over a fresh ship_placement table. */
export class NucleusPlacementStore implements PlacementStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(`CREATE TABLE IF NOT EXISTS ship_placement (run_id TEXT, host TEXT)`)
      .then(() => undefined);
    return this.#ready;
  }

  async set(runId: string, host: string): Promise<void> {
    await this.#ensure();
    await upsertByKey(this.#db, {
      table: "ship_placement",
      keyColumn: "run_id",
      key: runId,
      update: () => this.#db.query("UPDATE ship_placement SET host = $1 WHERE run_id = $2", [host, runId]),
      insert: () => this.#db.query("INSERT INTO ship_placement (run_id, host) VALUES ($1, $2)", [runId, host]),
    });
  }

  async get(runId: string): Promise<string | null> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT host FROM ship_placement WHERE run_id = $1", [runId]);
    return rows.length > 0 ? String(rows[0]!.host) : null;
  }

  async all(): Promise<Record<string, string>> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT run_id, host FROM ship_placement");
    const map: Record<string, string> = {};
    for (const r of rows) map[String(r.run_id)] = String(r.host);
    return map;
  }
}

/** File-backed: one JSON keyed by owner. Single-box only — file mode has no worker. */
export class FileFleetStore implements FleetStore {
  #path: string;

  constructor(dir = stateDir()) {
    this.#path = join(dir, "fleet.json");
  }

  async #read(): Promise<Record<string, WorkerInfo>> {
    return readJsonFile<Record<string, WorkerInfo>>(this.#path, {});
  }

  async heartbeat(info: WorkerInfo): Promise<void> {
    await updateJsonFile<Record<string, WorkerInfo>>(this.#path, {}, (all) => ({ ...all, [info.owner]: info }));
  }

  async list(): Promise<WorkerInfo[]> {
    return Object.values(await this.#read());
  }

  async prune(before: Date): Promise<number> {
    const cutoff = before.getTime();
    let dropped = 0;
    await updateJsonFile<Record<string, WorkerInfo>>(this.#path, {}, (all) => {
      const kept: Record<string, WorkerInfo> = {};
      dropped = 0;
      for (const [owner, info] of Object.entries(all)) {
        const seen = new Date(info.lastSeen).getTime();
        if (Number.isFinite(seen) && seen < cutoff) dropped++;
        else kept[owner] = info;
      }
      return kept;
    });
    return dropped;
  }
}

/** Nucleus-backed over the pgwire adapter's ship_fleet table. */
export class NucleusFleetStore implements FleetStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_fleet (
          owner TEXT,
          host TEXT,
          sandbox TEXT,
          max_concurrent TEXT,
          active_runs TEXT,
          started_at TEXT,
          last_seen TEXT
        )`,
      )
      .then(() => undefined);
    return this.#ready;
  }

  async heartbeat(info: WorkerInfo): Promise<void> {
    await this.#ensure();
    const vals = [
      info.host,
      info.sandbox,
      String(info.maxConcurrent),
      String(info.activeRuns),
      info.startedAt,
      info.lastSeen,
    ];
    await upsertByKey(this.#db, {
      table: "ship_fleet",
      keyColumn: "owner",
      key: info.owner,
      update: () =>
        this.#db.query(
          "UPDATE ship_fleet SET host = $1, sandbox = $2, max_concurrent = $3, active_runs = $4, started_at = $5, last_seen = $6 WHERE owner = $7",
          [...vals, info.owner],
        ),
      insert: () =>
        this.#db.query(
          "INSERT INTO ship_fleet (host, sandbox, max_concurrent, active_runs, started_at, last_seen, owner) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [...vals, info.owner],
        ),
    });
  }

  async list(): Promise<WorkerInfo[]> {
    await this.#ensure();
    const rows = await this.#db.query(
      "SELECT owner, host, sandbox, max_concurrent, active_runs, started_at, last_seen FROM ship_fleet",
    );
    return rows.map((r) => ({
      owner: String(r.owner),
      host: String(r.host),
      sandbox: String(r.sandbox),
      maxConcurrent: Number(r.max_concurrent) || 0,
      activeRuns: Number(r.active_runs) || 0,
      startedAt: String(r.started_at),
      lastSeen: String(r.last_seen),
    }));
  }

  async prune(before: Date): Promise<number> {
    await this.#ensure();
    // last_seen is a TEXT ISO-8601 UTC timestamp, so lexical ordering is
    // chronological ordering and a plain string comparison is correct.
    const cutoff = before.toISOString();
    const doomed = await this.#db.query("SELECT owner FROM ship_fleet WHERE last_seen < $1", [cutoff]);
    if (doomed.length === 0) return 0;
    await this.#db.query("DELETE FROM ship_fleet WHERE last_seen < $1", [cutoff]);
    return doomed.length;
  }
}
