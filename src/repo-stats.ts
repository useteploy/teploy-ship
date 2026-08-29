import { join } from "node:path";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { readJsonFile, updateJsonFile } from "./file-store.js";
import { stateDir } from "./run-store.js";
import { repoSlug } from "./observe.js";
import { AUTHORITIES, type Authority } from "./ladder.js";

/**
 * L8 — the four per-repo numbers the overseer state is measured by
 * (ORCHESTRATION_TARGET_STATE.md, D4): sent, merged, reverted, parked. One row
 * per (repo, kind, run), so recording is idempotent under every at-least-once
 * path that feeds it — a completion handled twice, a merge seen both from the
 * auto-merge step and from the forge's pull_request webhook, a revert seen as a
 * merged revert PR and again as the push that carried it.
 *
 * A separate store rather than counters on the project record: the worker
 * writes sent/merged/parked at completion and the web process writes
 * merged/reverted from webhooks, and two read-modify-write writers on one JSON
 * document lose updates. Reporting only — nothing enforces against it.
 */
export type RepoStatKind = "sent" | "merged" | "reverted" | "parked";

export interface RepoStatEntry {
  /** owner/name slug (repoSlug). */
  repo: string;
  kind: RepoStatKind;
  runId: string;
  /** Pull request URL, when the event is about one. */
  pr?: string;
  /** Pull request number on the forge, for matching a revert back to it. */
  number?: number;
  /** Merge commit sha, when the forge reported one. */
  sha?: string;
  at: string;
}

export interface RepoStatsStore {
  /** Record once. True iff THIS call created the row (the caller may notify on true only). */
  record(entry: RepoStatEntry): Promise<boolean>;
  /**
   * Fill fields on a row that already exists (the forge's merge sha arriving
   * after the worker recorded the merge) WITHOUT creating one. Reporting
   * only, so a missing row is a no-op rather than a half-fabricated fact.
   */
  attach(entry: RepoStatEntry): Promise<void>;
  /** Every row, optionally for one repo (URL or slug). */
  list(repo?: string): Promise<RepoStatEntry[]>;
}

export function repoStatKey(entry: Pick<RepoStatEntry, "repo" | "kind" | "runId">): string {
  return `${entry.repo}:${entry.kind}:${entry.runId}`;
}

function normalize(entry: RepoStatEntry): RepoStatEntry {
  const repo = repoSlug(entry.repo) ?? entry.repo.trim().toLowerCase();
  return {
    repo,
    kind: entry.kind,
    runId: entry.runId,
    ...(entry.pr !== undefined && entry.pr !== "" ? { pr: entry.pr } : {}),
    ...(entry.number !== undefined && Number.isFinite(entry.number) ? { number: entry.number } : {}),
    ...(entry.sha !== undefined && entry.sha !== "" ? { sha: entry.sha } : {}),
    at: entry.at,
  };
}

function matchesRepo(entry: RepoStatEntry, repo: string | undefined): boolean {
  if (repo === undefined) return true;
  const key = repoSlug(repo) ?? repo.trim().toLowerCase();
  return entry.repo === key;
}

/** File-backed: one JSON keyed by repoStatKey at stateDir()/repo-stats.json. */
export class FileRepoStatsStore implements RepoStatsStore {
  #path: string;

  constructor(dir = stateDir()) {
    this.#path = join(dir, "repo-stats.json");
  }

  async record(entry: RepoStatEntry): Promise<boolean> {
    const row = normalize(entry);
    const key = repoStatKey(row);
    let created = false;
    await updateJsonFile<Record<string, RepoStatEntry>>(this.#path, {}, (all) => {
      if (all[key] !== undefined) return all;
      created = true;
      return { ...all, [key]: row };
    });
    return created;
  }

  async attach(entry: RepoStatEntry): Promise<void> {
    const row = normalize(entry);
    const key = repoStatKey(row);
    await updateJsonFile<Record<string, RepoStatEntry>>(this.#path, {}, (all) => {
      const existing = all[key];
      if (existing === undefined) return all;
      return { ...all, [key]: { ...existing, ...row } };
    });
  }

  async list(repo?: string): Promise<RepoStatEntry[]> {
    const all = await readJsonFile<Record<string, RepoStatEntry>>(this.#path, {});
    return Object.values(all)
      .filter((e) => matchesRepo(e, repo))
      .sort((a, b) => (a.at < b.at ? -1 : 1));
  }
}

/** Nucleus-backed over ship_repo_stats. Plain TEXT columns, like every other store here. */export class NucleusRepoStatsStore implements RepoStatsStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(
        "CREATE TABLE IF NOT EXISTS ship_repo_stats (stat_key TEXT, repo TEXT, kind TEXT, run_id TEXT, pr TEXT, pr_number TEXT, sha TEXT, recorded_at TEXT)",
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#ready = null;
        throw error;
      });
    return this.#ready;
  }

  async #exists(key: string): Promise<boolean> {
    const rows = await this.#db.query("SELECT stat_key FROM ship_repo_stats WHERE stat_key = $1", [key]);
    return rows.length > 0;
  }

  async record(entry: RepoStatEntry): Promise<boolean> {
    await this.#ensure();
    const row = normalize(entry);
    const key = repoStatKey(row);
    if (await this.#exists(key)) return false;
    // The same setNX guard upsert.ts uses: a table with no primary key cannot
    // refuse a twin, so exactly one caller may create a given key.
    if (!(await this.#db.kv.setNX(`ship:repo-stats:${key}`, "1", { ttl: 30 }))) return false;
    if (await this.#exists(key)) return false;
    await this.#db.query(
      "INSERT INTO ship_repo_stats (stat_key, repo, kind, run_id, pr, pr_number, sha, recorded_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [key, row.repo, row.kind, row.runId, row.pr ?? "", row.number !== undefined ? String(row.number) : "", row.sha ?? "", row.at],
    );
    return true;
  }

  async attach(entry: RepoStatEntry): Promise<void> {
    await this.#ensure();
    const row = normalize(entry);
    const key = repoStatKey(row);
    // COALESCE keeps the first non-empty value per column, so an attach that
    // arrives with less than the row holds (no pr, no sha) subtracts nothing.
    await this.#db.query(
      "UPDATE ship_repo_stats SET pr = COALESCE(NULLIF($1, ''), pr), pr_number = COALESCE(NULLIF($2, ''), pr_number), sha = COALESCE(NULLIF($3, ''), sha) WHERE stat_key = $4",
      [row.pr ?? "", row.number !== undefined ? String(row.number) : "", row.sha ?? "", key],
    );
  }

  async list(repo?: string): Promise<RepoStatEntry[]> {
    await this.#ensure();
    const rows =
      repo === undefined
        ? await this.#db.query("SELECT repo, kind, run_id, pr, pr_number, sha, recorded_at FROM ship_repo_stats")
        : await this.#db.query("SELECT repo, kind, run_id, pr, pr_number, sha, recorded_at FROM ship_repo_stats WHERE repo = $1", [
            repoSlug(repo) ?? repo.trim().toLowerCase(),
          ]);
    return rows
      .map((r): RepoStatEntry => {
        const number = Number(r.pr_number ?? "");
        const pr = String(r.pr ?? "");
        const sha = String(r.sha ?? "");
        return {
          repo: String(r.repo),
          kind: String(r.kind) as RepoStatKind,
          runId: String(r.run_id),
          ...(pr !== "" ? { pr } : {}),
          ...(r.pr_number !== "" && Number.isFinite(number) ? { number } : {}),
          ...(sha !== "" ? { sha } : {}),
          at: String(r.recorded_at ?? ""),
        };
      })
      .sort((a, b) => (a.at < b.at ? -1 : 1));
  }
}

export interface RepoCounts {
  sent: number;
  merged: number;
  reverted: number;
  parked: number;
}

export function emptyCounts(): RepoCounts {
  return { sent: 0, merged: 0, reverted: 0, parked: 0 };
}

/** Counts per repo slug. A run counts once per kind, which is what the key guarantees. */
export function summarizeRepoStats(entries: RepoStatEntry[]): Record<string, RepoCounts> {
  const out: Record<string, RepoCounts> = {};
  for (const e of entries) {
    const counts = (out[e.repo] ??= emptyCounts());
    if (e.kind in counts) counts[e.kind] += 1;
  }
  return out;
}

/**
 * Dollars per merged pull request, from the attributed-spend ledger. Attributed
 * spend is keyed origin/owner/name (repoKeyOf) while stats are keyed owner/name
 * (repoSlug); the two agree on the slug. Null until something has merged.
 */
export function costPerMerge(
  repo: string,
  counts: RepoCounts,
  attributed: Array<{ kind: string; key: string; amountUSD: number }>,
): number | null {
  if (counts.merged === 0) return null;
  const slug = repoSlug(repo) ?? repo;
  let total = 0;
  for (const e of attributed) {
    if (e.kind === "repo" && repoSlug(e.key) === slug) total += e.amountUSD;
  }
  return total / counts.merged;
}

export interface AuthoritySuggestion {
  authority: Authority;
  /** "promote" | "demote" | "hold", relative to `current`. */
  move: "promote" | "demote" | "hold";
  why: string;
}

/** Below this many sent items the numbers say nothing. */
export const SUGGEST_MIN_SENT = 5;
/** Merge rate (merged / sent) a promotion needs. */
export const SUGGEST_PROMOTE_MERGE_RATE = 0.7;
/** Revert rate (reverted / merged) above which a demotion is suggested. */
export const SUGGEST_DEMOTE_REVERT_RATE = 0.1;
/** Revert rate a promotion tolerates. */
export const SUGGEST_PROMOTE_REVERT_RATE = 0.03;

function step(authority: Authority, by: number): Authority {
  const i = AUTHORITIES.indexOf(authority);
  const next = Math.min(AUTHORITIES.length - 1, Math.max(0, i + by));
  return AUTHORITIES[next]!;
}

/**
 * The ratchet's suggestion (D4): promotion is suggested by measured merge and
 * revert rates and decided by a person; demotion is suggested on reverts.
 * Pure, so the page and the tests agree.
 *
 * `cap` is the highest rung the repo may reach — the verification ladder's
 * cap when the ladder lane supplies one, and `send` for a never-auto repo
 * regardless. A suggestion never exceeds it.
 */
export function suggestAuthority(
  counts: RepoCounts,
  current: Authority = "propose",
  options: { neverAuto?: boolean; cap?: Authority } = {},
): AuthoritySuggestion {
  const caps: Authority[] = [];
  if (options.cap !== undefined) caps.push(options.cap);
  if (options.neverAuto === true) caps.push("send");
  const cap = caps.reduce<Authority>(
    (lowest, c) => (AUTHORITIES.indexOf(c) < AUTHORITIES.indexOf(lowest) ? c : lowest),
    "auto_normal",
  );
  const clamp = (a: Authority): Authority =>
    AUTHORITIES.indexOf(a) > AUTHORITIES.indexOf(cap) ? cap : a;

  if (AUTHORITIES.indexOf(current) > AUTHORITIES.indexOf(cap)) {
    return {
      authority: cap,
      move: "demote",
      why: options.neverAuto === true ? "never-auto repo: authority is capped at send by policy" : `capped at ${cap} by the verification ladder`,
    };
  }
  const revertRate = counts.merged === 0 ? 0 : counts.reverted / counts.merged;
  if (counts.reverted > 0 && revertRate > SUGGEST_DEMOTE_REVERT_RATE && current !== "propose") {
    return {
      authority: step(current, -1),
      move: "demote",
      why: `${counts.reverted} of ${counts.merged} merged change(s) reverted (${Math.round(revertRate * 100)}%)`,
    };
  }
  if (counts.sent < SUGGEST_MIN_SENT) {
    return { authority: current, move: "hold", why: `${counts.sent} sent; ${SUGGEST_MIN_SENT} needed before the numbers say anything` };
  }
  const mergeRate = counts.merged / counts.sent;
  if (mergeRate >= SUGGEST_PROMOTE_MERGE_RATE && revertRate <= SUGGEST_PROMOTE_REVERT_RATE) {
    const next = clamp(step(current, 1));
    if (next !== current) {
      return {
        authority: next,
        move: "promote",
        why: `${counts.merged} of ${counts.sent} sent merged (${Math.round(mergeRate * 100)}%), ${counts.reverted} reverted`,
      };
    }
    return { authority: current, move: "hold", why: current === cap && cap !== "auto_normal" ? `at the cap (${cap})` : "already at the top rung" };
  }
  return {
    authority: current,
    move: "hold",
    why: `${counts.merged} of ${counts.sent} sent merged (${Math.round(mergeRate * 100)}%); promotion needs ${Math.round(SUGGEST_PROMOTE_MERGE_RATE * 100)}%`,
  };
}
