import { join } from "node:path";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { readJsonFile, updateJsonFile } from "./file-store.js";
import { repoKeyOf } from "./durable.js";
import { stateDir } from "./run-store.js";

/**
 * Attributed spend: the SAME settled cost the per-source ledger records
 * (src/spend.ts), cut a second way — by repository and by actor.
 *
 * A second ledger rather than a column on ship_spend: the source ledger is
 * what the budget cap ENFORCES against, so its shape is dictated by that job
 * (append-only deltas, reservation holds). Attribution is a REPORTING
 * question — "which repo is expensive", "who asked for the work that cost
 * this" — and bolting it onto the enforcement-shaped store would change a
 * table the cap reads mid-flight. A fresh file/table leaves the enforcement
 * path untouched and lets attribution lag or fail without ever touching a
 * budget decision.
 */
export type SpendDimension = "repo" | "actor";

/** One accumulated (kind, key, day) bucket. */
export interface AttributedSpendEntry {
  kind: string;
  /**
   * For kind "repo": the origin-scoped repo key (repoKeyOf) — the same key
   * the code index and repo memory scope by, NOT the bare owner/name slug.
   * For kind "actor": the stable actor id (see src/actor.ts).
   */
  key: string;
  /** UTC "YYYY-MM-DD", same bucketing as the source ledger. */
  day: string;
  amountUSD: number;
}

export interface AttributedSpendStore {
  /** Add `amountUSD` to a (kind, key, day) bucket. Zero/negative/NaN ignored, like the source ledger. */
  add(kind: SpendDimension, key: string, day: string, amountUSD: number): Promise<void>;
  /** Every accumulated bucket — for the spend dashboard. */
  list(): Promise<AttributedSpendEntry[]>;
}

/** File-backed: one JSON of accumulated buckets at stateDir()/attributed-spend.json. */
export class FileAttributedSpendStore implements AttributedSpendStore {
  #path: string;

  constructor(dir = stateDir()) {
    this.#path = join(dir, "attributed-spend.json");
  }

  async add(kind: SpendDimension, key: string, day: string, amountUSD: number): Promise<void> {
    if (!(amountUSD > 0)) return; // ignore zero/negative/NaN, same gate as spend.ts
    // updateJsonFile holds the in-process lock for the read-add-write: file
    // mode is single-process by construction, so this is the honest ceiling —
    // multi-worker deployments run the Nucleus store below.
    await updateJsonFile<AttributedSpendEntry[]>(this.#path, [], (entries) => {
      const existing = entries.find((e) => e.kind === kind && e.key === key && e.day === day);
      if (existing !== undefined) {
        existing.amountUSD += amountUSD;
        return entries;
      }
      return [...entries, { kind, key, day, amountUSD }];
    });
  }

  async list(): Promise<AttributedSpendEntry[]> {
    // Corruption throws, like the evidence store: reading a damaged file back
    // as [] would zero the dashboard's attribution history, which reads as
    // "nobody spent anything" — a wrong answer, not a missing one.
    return readJsonFile<AttributedSpendEntry[]>(this.#path, []);
  }
}

/**
 * Nucleus-backed over a fresh ship_attributed_spend table.
 *
 * Accumulates a running total per (kind, key, day) — read current, add,
 * write — which is deliberately NOT the shape NucleusSpendStore.add chose
 * for the source ledger (append-only deltas there, because that table feeds
 * the budget cap and a lost increment is an overspend). The trade is
 * accepted HERE because this table is reporting, not enforcement. The known
 * cost, mirroring spend.ts's race caveat: two workers settling runs for the
 * same repo on the same day can read the same current total and one delta
 * can be lost — the dashboard then reads slightly low. The budget cap never
 * reads this table, so the failure stays cosmetic.
 */
export class NucleusAttributedSpendStore implements AttributedSpendStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    // Fresh CREATE TABLE IF NOT EXISTS, never an ALTER on a populated table —
    // the pattern every store here follows for Nucleus schema (see
    // src/evidence.ts).
    this.#ready ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_attributed_spend (
          kind TEXT,
          key TEXT,
          day TEXT,
          amount_usd TEXT
        )`,
      )
      .then(() => undefined);
    return this.#ready;
  }

  async #read(kind: string, key: string, day: string): Promise<number | null> {
    const rows = await this.#db.query(
      "SELECT amount_usd FROM ship_attributed_spend WHERE kind = $1 AND key = $2 AND day = $3",
      [kind, key, day],
    );
    if (rows.length === 0) return null;
    const v = Number(rows[0]!.amount_usd);
    return Number.isFinite(v) ? v : 0;
  }

  async #write(kind: string, key: string, day: string, amountUSD: number): Promise<void> {
    await this.#db.query(
      "UPDATE ship_attributed_spend SET amount_usd = $4 WHERE kind = $1 AND key = $2 AND day = $3",
      [kind, key, day, String(amountUSD)],
    );
  }

  async add(kind: SpendDimension, key: string, day: string, amountUSD: number): Promise<void> {
    if (!(amountUSD > 0)) return;
    await this.#ensure();
    const current = await this.#read(kind, key, day);
    if (current !== null) {
      await this.#write(kind, key, day, current + amountUSD);
      return;
    }
    // No row yet. Two workers can reach here simultaneously for the same
    // bucket; this is upsertByKey's claim-then-insert pattern (src/upsert.ts)
    // inlined, because the identity spans THREE columns (kind, key, day)
    // where upsertByKey's contract is one: the KV setNX decides which caller
    // may INSERT, and the loser UPDATEs the winner's row rather than creating
    // a twin that list() would then sum as double the spend.
    const guard = `ship:upsert:ship_attributed_spend:${kind}:${key}:${day}`;
    if (await this.#db.kv.setNX(guard, "1", { ttl: 30 })) {
      // We hold the right to create this row. Re-check first: another caller
      // may have inserted and released between our read and our claim.
      const again = await this.#read(kind, key, day);
      if (again === null) {
        await this.#db.query(
          "INSERT INTO ship_attributed_spend (kind, key, day, amount_usd) VALUES ($1, $2, $3, $4)",
          [kind, key, day, String(amountUSD)],
        );
        return;
      }
      await this.#write(kind, key, day, again + amountUSD);
      return;
    }
    // Lost the claim: the winner is creating the row. If their insert has
    // landed by now this update lands on it; if it has not, the delta is
    // dropped rather than double-created — losing one report increment beats
    // inventing a duplicate bucket that reads as double the spend.
    const theirs = await this.#read(kind, key, day);
    if (theirs !== null) await this.#write(kind, key, day, theirs + amountUSD);
  }

  async list(): Promise<AttributedSpendEntry[]> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT kind, key, day, amount_usd FROM ship_attributed_spend");
    // Sum per bucket client-side, like NucleusSpendStore.list — defensive if
    // a duplicate row ever slipped past the claim, and one row per bucket is
    // what the dashboard wants anyway.
    const map = new Map<string, AttributedSpendEntry>();
    for (const r of rows) {
      const kind = String(r.kind);
      const key = String(r.key);
      const day = String(r.day);
      const v = Number(r.amount_usd);
      const amountUSD = Number.isFinite(v) ? v : 0;
      const bucket = `${kind}\u0000${key}\u0000${day}`;
      const e = map.get(bucket);
      if (e !== undefined) e.amountUSD += amountUSD;
      else map.set(bucket, { kind, key, day, amountUSD });
    }
    return [...map.values()];
  }
}

/**
 * Derive a run's spend attributions from what the run already recorded:
 * repo from the run-started event's input.repo, actor from the run's meta.
 *
 * The SEAM: the worker's settle path hands (meta, events) here and gets back
 * the dimensions worth a ledger row. Pure on purpose — no store, no clock —
 * so the mapping from "a run finished" to "what it should be charged to" is
 * testable without Nucleus or a worker.
 *
 * repo goes through repoKeyOf verbatim — the SAME origin-scoped key the code
 * index and repo memory scope by. Keying on the bare owner/name slug would
 * merge a private mirror's spend into the public repo's, the same namespace
 * collision repoKeyOf exists to prevent. A repo spelling repoKeyOf cannot
 * parse (it takes http/https/file URLs only; the scp-style ssh form throws)
 * omits the dimension rather than throwing: on the settle path a run with
 * cost > 0 has already executed turns, which requires repo-setup to have
 * parsed the URL, so this is belt-and-braces totality — an unattributable
 * run simply gets no repo row, never a rejected settle. actor is meta.actor,
 * the stable id (src/actor.ts): absent on runs enqueued before attribution
 * existed, and then the field is OMITTED rather than recorded as "unknown" —
 * an "unknown" bucket on the spend page would read as a person who doesn't
 * exist, which is the wrong kind of wrong.
 */
export function attributionsFrom(
  meta: { actor?: string } | null,
  events: Array<{ type: string; data?: unknown }>,
): { repo?: string; actor?: string } {
  const out: { repo?: string; actor?: string } = {};
  const started = events.find((e) => e.type === "run-started");
  const repo = (started?.data as { input?: { repo?: string } } | undefined)?.input?.repo;
  if (typeof repo === "string" && repo !== "") {
    try {
      out.repo = repoKeyOf(repo);
    } catch {
      // repoKeyOf refuses what it cannot scope; refusing to attribute is the
      // honest downgrade, throwing through the settle path is not.
    }
  }
  if (meta !== null && typeof meta.actor === "string" && meta.actor !== "") out.actor = meta.actor;
  return out;
}
