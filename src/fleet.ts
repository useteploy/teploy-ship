import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
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
  /** Every worker ever seen; callers decide staleness from lastSeen. */
  list(): Promise<WorkerInfo[]>;
}

/** File-backed: one JSON keyed by owner. Single-box only — file mode has no worker. */
export class FileFleetStore implements FleetStore {
  #path: string;

  constructor(dir = stateDir()) {
    this.#path = join(dir, "fleet.json");
  }

  async #read(): Promise<Record<string, WorkerInfo>> {
    try {
      return JSON.parse(await readFile(this.#path, "utf8"));
    } catch {
      return {};
    }
  }

  async heartbeat(info: WorkerInfo): Promise<void> {
    await mkdir(stateDir(), { recursive: true });
    const all = await this.#read();
    all[info.owner] = info;
    await writeFile(this.#path, JSON.stringify(all, null, 2));
  }

  async list(): Promise<WorkerInfo[]> {
    return Object.values(await this.#read());
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
    const existing = await this.#db.query("SELECT owner FROM ship_fleet WHERE owner = $1", [info.owner]);
    if (existing.length > 0) {
      await this.#db.query(
        "UPDATE ship_fleet SET host = $1, sandbox = $2, max_concurrent = $3, active_runs = $4, started_at = $5, last_seen = $6 WHERE owner = $7",
        [...vals, info.owner],
      );
    } else {
      await this.#db.query(
        "INSERT INTO ship_fleet (host, sandbox, max_concurrent, active_runs, started_at, last_seen, owner) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [...vals, info.owner],
      );
    }
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
}
