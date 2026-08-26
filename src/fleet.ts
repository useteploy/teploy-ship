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
  /** Host headroom at the last beat (C2). Absent on heartbeats from older workers. */
  freeMemMB?: number;
  load1?: number;
  cpus?: number;
  /** Why this worker is refusing launches right now, if it is. */
  held?: "memory" | "load";
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
      .then(() => undefined)
      // A failed ensure must not be cached: one transient store error would
      // otherwise poison every later call for the life of the process.
      .catch((error: unknown) => {
        this.#ready = null;
        throw error;
      });
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
  #readyLoad: Promise<void> | null = null;

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
      .then(() => undefined)
      // A failed ensure must not be cached: one transient store error would
      // otherwise poison every later call for the life of the process.
      .catch((error: unknown) => {
        this.#ready = null;
        throw error;
      });
    return this.#ready;
  }

  // Host load rides a sibling table: ship_fleet already exists on deployed
  // boxes with its columns fixed, and Nucleus cannot ALTER-ADD to a populated
  // table. Same owner key; joined in list().
  #ensureLoad(): Promise<void> {
    this.#readyLoad ??= this.#db
      .query("CREATE TABLE IF NOT EXISTS ship_fleet_load (owner TEXT, free_mem_mb TEXT, load1 TEXT, cpus TEXT, held TEXT)")
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#readyLoad = null;
        throw error;
      });
    return this.#readyLoad;
  }

  async #heartbeatLoad(info: WorkerInfo): Promise<void> {
    if (info.freeMemMB === undefined && info.load1 === undefined && info.cpus === undefined) return;
    await this.#ensureLoad();
    const vals = [
      info.freeMemMB !== undefined ? String(info.freeMemMB) : null,
      info.load1 !== undefined ? String(info.load1) : null,
      info.cpus !== undefined ? String(info.cpus) : null,
      info.held ?? null,
    ];
    await upsertByKey(this.#db, {
      table: "ship_fleet_load",
      keyColumn: "owner",
      key: info.owner,
      update: () => this.#db.query("UPDATE ship_fleet_load SET free_mem_mb = $1, load1 = $2, cpus = $3, held = $4 WHERE owner = $5", [...vals, info.owner]),
      insert: () => this.#db.query("INSERT INTO ship_fleet_load (free_mem_mb, load1, cpus, held, owner) VALUES ($1, $2, $3, $4, $5)", [...vals, info.owner]),
    });
  }

  async heartbeat(info: WorkerInfo): Promise<void> {
    await this.#ensure();
    await this.#heartbeatBase(info);
    // After the base row, so a failure on the load table (found live: a
    // Nucleus catalog write failing on CREATE TABLE) still leaves the worker's
    // liveness fresh; the error propagates to the worker's log.
    await this.#heartbeatLoad(info);
  }

  async #heartbeatBase(info: WorkerInfo): Promise<void> {
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
    const rows = await this.#db.query("SELECT owner, host, sandbox, max_concurrent, active_runs, started_at, last_seen FROM ship_fleet");
    // The load table is additive: if it cannot be ensured or read, the page
    // still lists the workers, just without the host numbers.
    let loads: Array<Record<string, unknown>> = [];
    try {
      await this.#ensureLoad();
      loads = await this.#db.query("SELECT owner, free_mem_mb, load1, cpus, held FROM ship_fleet_load");
    } catch {
      loads = [];
    }
    const loadOf = new Map(loads.map((l) => [String(l.owner), l]));
    const num = (v: unknown): number | undefined => {
      if (v === null || v === undefined || v === "") return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    return rows.map((r) => {
      const l = loadOf.get(String(r.owner));
      const held = l?.held === "memory" || l?.held === "load" ? l.held : undefined;
      return {
        owner: String(r.owner),
        host: String(r.host),
        sandbox: String(r.sandbox),
        maxConcurrent: Number(r.max_concurrent) || 0,
        activeRuns: Number(r.active_runs) || 0,
        startedAt: String(r.started_at),
        lastSeen: String(r.last_seen),
        ...(num(l?.free_mem_mb) !== undefined ? { freeMemMB: num(l?.free_mem_mb) } : {}),
        ...(num(l?.load1) !== undefined ? { load1: num(l?.load1) } : {}),
        ...(num(l?.cpus) !== undefined ? { cpus: num(l?.cpus) } : {}),
        ...(held !== undefined ? { held } : {}),
      };
    });
  }

  async prune(before: Date): Promise<number> {
    await this.#ensure();
    // last_seen is a TEXT ISO-8601 UTC timestamp, so lexical ordering is
    // chronological ordering and a plain string comparison is correct.
    const cutoff = before.toISOString();
    const doomed = await this.#db.query("SELECT owner FROM ship_fleet WHERE last_seen < $1", [cutoff]);
    if (doomed.length === 0) return 0;
    await this.#db.query("DELETE FROM ship_fleet WHERE last_seen < $1", [cutoff]);
    try {
      await this.#ensureLoad();
      for (const d of doomed) await this.#db.query("DELETE FROM ship_fleet_load WHERE owner = $1", [String(d.owner)]);
    } catch {
      // Best-effort: a stale load row for a pruned worker is never listed (list joins on ship_fleet).
    }
    return doomed.length;
  }
}
