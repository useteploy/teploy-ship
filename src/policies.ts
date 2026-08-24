import { join } from "node:path";

import type { IntakePolicy } from "./intake.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { readJsonFile, updateJsonFile } from "./file-store.js";
import { upsertByKey } from "./upsert.js";
import { stateDir } from "./run-store.js";

/**
 * The per-source intake rule, persisted so it's editable from the dashboard
 * instead of a static SHIP_INTAKE_POLICIES env. `policy` decides what an
 * incoming task from `source` becomes (ignore | propose | auto); an optional
 * per-source daily spend cap overrides the global default.
 */
export interface SourcePolicy {
  source: string;
  policy: IntakePolicy;
  dailyBudgetUSD?: number;
}

export interface PolicyStore {
  list(): Promise<SourcePolicy[]>;
  set(policy: SourcePolicy): Promise<void>;
  /** Insert defaults for sources not already present (env seed, first run). */
  seed(defaults: Record<string, IntakePolicy>): Promise<void>;
}

/** File-backed: one JSON mapping source -> { policy, dailyBudgetUSD }. */
export class FilePolicyStore implements PolicyStore {
  #path: string;

  constructor(dir = stateDir()) {
    this.#path = join(dir, "policies.json");
  }

  // Corruption throws: reading a damaged policy file as "{}" would drop every
  // per-source budget and auto/ignore rule, i.e. silently widen authority.
  async #read(): Promise<Record<string, { policy: IntakePolicy; dailyBudgetUSD?: number }>> {
    return readJsonFile<Record<string, { policy: IntakePolicy; dailyBudgetUSD?: number }>>(this.#path, {});
  }

  async list(): Promise<SourcePolicy[]> {
    const all = await this.#read();
    return Object.entries(all).map(([source, v]) => ({ source, policy: v.policy, ...(v.dailyBudgetUSD !== undefined ? { dailyBudgetUSD: v.dailyBudgetUSD } : {}) }));
  }

  async set(p: SourcePolicy): Promise<void> {
    await updateJsonFile<Record<string, { policy: IntakePolicy; dailyBudgetUSD?: number }>>(this.#path, {}, (all) => ({
      ...all,
      [p.source]: { policy: p.policy, ...(p.dailyBudgetUSD !== undefined ? { dailyBudgetUSD: p.dailyBudgetUSD } : {}) },
    }));
  }

  async seed(defaults: Record<string, IntakePolicy>): Promise<void> {
    await updateJsonFile<Record<string, { policy: IntakePolicy; dailyBudgetUSD?: number }>>(this.#path, {}, (all) => {
      const next = { ...all };
      for (const [source, policy] of Object.entries(defaults)) {
        if (next[source] === undefined) next[source] = { policy };
      }
      return next;
    });
  }
}

/** Nucleus-backed over the pgwire adapter's ship_policies table. */
export class NucleusPolicyStore implements PolicyStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_policies (
          source TEXT,
          policy TEXT,
          daily_budget_usd TEXT
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

  async list(): Promise<SourcePolicy[]> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT source, policy, daily_budget_usd FROM ship_policies");
    return rows.map((r) => {
      const budget = r.daily_budget_usd !== null && r.daily_budget_usd !== undefined ? Number(r.daily_budget_usd) : undefined;
      // Validate rather than cast: an unrecognised policy string used to become
      // an IntakePolicy by assertion, and an unknown value silently behaves like
      // whatever the comparisons happen to do with it. Unknown means "propose",
      // the safe middle (never auto-launch on a typo).
      const raw = String(r.policy);
      const policy: IntakePolicy = raw === "ignore" || raw === "propose" || raw === "auto" ? raw : "propose";
      return {
        source: String(r.source),
        policy,
        ...(budget !== undefined && Number.isFinite(budget) ? { dailyBudgetUSD: budget } : {}),
      };
    });
  }

  async set(p: SourcePolicy): Promise<void> {
    await this.#ensure();
    const budget = p.dailyBudgetUSD !== undefined ? String(p.dailyBudgetUSD) : null;
    await upsertByKey(this.#db, {
      table: "ship_policies",
      keyColumn: "source",
      key: p.source,
      update: () =>
        this.#db.query("UPDATE ship_policies SET policy = $1, daily_budget_usd = $2 WHERE source = $3", [p.policy, budget, p.source]),
      insert: () =>
        this.#db.query("INSERT INTO ship_policies (source, policy, daily_budget_usd) VALUES ($1, $2, $3)", [p.source, p.policy, budget]),
    });
  }

  async seed(defaults: Record<string, IntakePolicy>): Promise<void> {
    await this.#ensure();
    const present = new Set((await this.list()).map((p) => p.source));
    for (const [source, policy] of Object.entries(defaults)) {
      if (!present.has(source)) await this.set({ source, policy });
    }
  }
}
