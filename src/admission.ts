import type { NucleusPgwire } from "./nucleus-pgwire.js";

/**
 * Fleet-wide admission control for auto-launched runs.
 *
 * The caps Ship advertises — a concurrency ceiling, a per-source daily launch
 * count, a per-source daily budget — were all enforced from process-local maps
 * inside one worker. Run three workers and you get three times every limit,
 * which is the opposite of what a safety ceiling is for: the intake claim stops
 * two workers launching the SAME proposal, but nothing stopped them launching
 * three different ones past a ceiling of one.
 *
 * The primitives available against Nucleus are KV_SETNX (atomic
 * insert-if-absent, with TTL) and KV_CDEL (delete-if-value-matches). There is
 * no read, and no arithmetic UPDATE we can rely on, so counters are modelled as
 * a fixed set of NAMED SLOTS that callers race to claim:
 *
 *   concurrency  ship:slot:<i>              for i < limit, released on finish
 *   daily count  ship:launch:<day>:<src>:<i> for i < limit, never released
 *   repo lock    ship:repo:<repo>            one active run per repo (C7),
 *                                            released at the end of each
 *                                            execution pass, parks included
 *
 * Taking slot i is one atomic operation, so N workers cannot exceed N slots no
 * matter how they interleave. A worker that dies holding a concurrency slot
 * does not wedge the fleet: the slot carries a TTL and is renewed by the
 * worker's existing heartbeat, so it frees itself shortly after the process
 * stops. Daily-count slots expire on their own after two days. The repo lock
 * carries the same TTL and the same renewal — a dead worker's repo frees
 * itself, and a live one's park does too.
 */
export interface AdmissionControl {
  /**
   * Take one of `limit` fleet-wide concurrency slots for this run.
   * False means the fleet is at its ceiling.
   */
  acquireSlot(runId: string, limit: number): Promise<boolean>;
  /** Give back this run's slot. Safe to call for a run that holds none. */
  releaseSlot(runId: string): Promise<void>;
  /** Keep held slots alive. Called from the worker heartbeat. */
  renewSlots(): Promise<void>;
  /**
   * Consume one of `limit` launches for (source, day) fleet-wide.
   * False means the source has hit its daily cap.
   */
  takeDailyLaunch(source: string, day: string, limit: number): Promise<boolean>;
  /**
   * Take the per-repo execution lock for this run (C7): at most one active
   * run per repository, others wait their turn in the due list. False means
   * another run is executing against this repo right now.
   *
   * Idempotent per run, like acquireSlot: a retried attempt must not see its
   * own lock as contention. Released when the run's execution pass ends — a
   * park releases it too, because a run parked on a human for days is not
   * "active" and must not wedge its repo's queue behind it.
   */
  acquireRepo(runId: string, repo: string): Promise<boolean>;
  /** Give back this run's repo lock, if it holds one. */
  releaseRepo(runId: string): Promise<void>;
  /** Keep held repo locks alive. Called from the worker heartbeat. */
  renewRepos(): Promise<void>;
}

/** Concurrency slots expire this long after their last renewal. */
export const SLOT_TTL_S = 300;
/** Per-repo locks expire this long after their last renewal (same shape as slots). */
export const REPO_TTL_S = 300;
/** Daily-launch markers outlive their day and then vanish. */
const LAUNCH_TTL_S = 48 * 60 * 60;

export class NucleusAdmission implements AdmissionControl {
  #db: NucleusPgwire;
  /**
   * Slot index per run, held in memory by the worker that took it. There is no
   * KV read to recover this from, and it does not need to survive a restart:
   * a dead worker's slots lapse via TTL, and cdel is value-conditional so a
   * stale release can never free another worker's slot.
   */
  #held = new Map<string, number>();
  /** Same shape for the per-repo lock: runId -> the repo key it holds. */
  #repo = new Map<string, string>();
  /** Where to resume scanning for a free daily-launch marker. */
  #launchCursor = new Map<string, number>();

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  async acquireSlot(runId: string, limit: number): Promise<boolean> {
    if (limit <= 0) return true; // no ceiling configured
    if (this.#held.has(runId)) return true; // idempotent for a retried sweep
    for (let i = 0; i < limit; i++) {
      if (await this.#db.kv.setNX(`ship:slot:${i}`, runId, { ttl: SLOT_TTL_S })) {
        this.#held.set(runId, i);
        return true;
      }
    }
    return false;
  }

  async releaseSlot(runId: string): Promise<void> {
    const index = this.#held.get(runId);
    if (index === undefined) return;
    this.#held.delete(runId);
    // Conditional on the value: if the TTL already lapsed and another worker
    // took slot `index`, this deletes nothing rather than evicting them.
    await this.#db.kv.cdel(`ship:slot:${index}`, runId).catch(() => {});
  }

  async renewSlots(): Promise<void> {
    for (const [runId, index] of this.#held) {
      await this.#db.kv.cexpire(`ship:slot:${index}`, runId, SLOT_TTL_S).catch(() => {});
    }
  }

  async acquireRepo(runId: string, repo: string): Promise<boolean> {
    const key = `ship:repo:${repo}`;
    if (this.#repo.has(runId)) return true; // idempotent for a retried pass
    if (await this.#db.kv.setNX(key, runId, { ttl: REPO_TTL_S })) {
      this.#repo.set(runId, repo);
      return true;
    }
    return false;
  }

  async releaseRepo(runId: string): Promise<void> {
    const repo = this.#repo.get(runId);
    if (repo === undefined) return;
    this.#repo.delete(runId);
    await this.#db.kv.cdel(`ship:repo:${repo}`, runId).catch(() => {});
  }

  async renewRepos(): Promise<void> {
    for (const [runId, repo] of this.#repo) {
      await this.#db.kv.cexpire(`ship:repo:${repo}`, runId, REPO_TTL_S).catch(() => {});
    }
  }

  async takeDailyLaunch(source: string, day: string, limit: number): Promise<boolean> {
    if (limit <= 0) return true;
    const cursorKey = `${day}:${source}`;
    const start = this.#launchCursor.get(cursorKey) ?? 0;
    for (let n = start; n < limit; n++) {
      if (await this.#db.kv.setNX(`ship:launch:${day}:${source}:${n}`, "1", { ttl: LAUNCH_TTL_S })) {
        this.#launchCursor.set(cursorKey, n + 1);
        return true;
      }
    }
    // Someone else may have freed nothing, but our cursor could be ahead of a
    // gap another worker left; a full rescan is cheap and only happens at the cap.
    for (let n = 0; n < start; n++) {
      if (await this.#db.kv.setNX(`ship:launch:${day}:${source}:${n}`, "1", { ttl: LAUNCH_TTL_S })) {
        return true;
      }
    }
    this.#launchCursor.set(cursorKey, limit);
    return false;
  }
}

/**
 * Single-process admission for the file runtime. File mode has no worker and no
 * second process by construction, so in-memory counters ARE the global state
 * here — this is not a weaker version of the above, it is the same guarantee
 * over a smaller world.
 */
export class LocalAdmission implements AdmissionControl {
  #slots = new Set<string>();
  #launches = new Map<string, number>();
  #repos = new Map<string, string>();

  async acquireSlot(runId: string, limit: number): Promise<boolean> {
    if (limit <= 0 || this.#slots.has(runId)) return true;
    if (this.#slots.size >= limit) return false;
    this.#slots.add(runId);
    return true;
  }

  async releaseSlot(runId: string): Promise<void> {
    this.#slots.delete(runId);
  }

  async renewSlots(): Promise<void> {}

  async takeDailyLaunch(source: string, day: string, limit: number): Promise<boolean> {
    if (limit <= 0) return true;
    const key = `${day}:${source}`;
    const used = this.#launches.get(key) ?? 0;
    if (used >= limit) return false;
    this.#launches.set(key, used + 1);
    return true;
  }

  async acquireRepo(runId: string, repo: string): Promise<boolean> {
    if (this.#repos.has(runId)) return true;
    for (const holder of this.#repos.values()) {
      if (holder === repo) return false;
    }
    this.#repos.set(runId, repo);
    return true;
  }

  async releaseRepo(runId: string): Promise<void> {
    this.#repos.delete(runId);
  }

  async renewRepos(): Promise<void> {}
}
