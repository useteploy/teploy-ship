import { join } from "node:path";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { readJsonFile, updateJsonFile } from "./file-store.js";
import { upsertByKey } from "./upsert.js";
import { stateDir } from "./run-store.js";
import { repoSlug } from "./observe.js";

/**
 * Per-repo evidence configuration: the test command and the Observe service
 * that belong to ONE repository, resolved at enqueue and materialised into the
 * run input.
 *
 * Why this exists: `SHIP_TEST_COMMAND` and `OBSERVE_SERVICE`/`OBSERVE_REPO`
 * are ONE value per WORKER. That is fine while a worker serves one repository
 * and wrong the moment it serves two — and it failed loudly before it failed
 * silently: a worker watching `fylun-web` attached its RED metrics to a pull
 * request that changed one line of Go in an unrelated repo (real numbers,
 * nonsense attribution), and after `OBSERVE_REPO` became required the same
 * worker-wiring suppressed telemetry and tests on every repo but one.
 *
 * The unit of configuration is the REPO, not the worker: the same worker must
 * run `go test ./...` for one repo and `pnpm test` for another, and read the
 * service each repo is actually built from. `teploy-ship evidence set` writes
 * here; `enqueueRun` reads here and copies the values into the run's recorded
 * input, so a replay is stable even if the store is edited later.
 */
export interface RepoEvidence {
  /** Canonical key: owner/name slug (see repoSlug). */
  repo: string;
  /** The suite command for this repo, exactly as the operator would type it. */
  testCommand?: string;
  /** Ceiling for this repo's suite, ms. */
  testTimeoutMs?: number;
  /** The Observe service this repo is built from, if it has one. */
  observeService?: string;
}

export interface EvidenceStore {
  /** Look up the evidence for a repo URL or slug. Null = nothing configured. */
  forRepo(repo: string): Promise<RepoEvidence | null>;
  /** Upsert by RepoEvidence.repo (the slug, normalised by the store). */
  set(evidence: RepoEvidence): Promise<void>;
  list(): Promise<RepoEvidence[]>;
  remove(repo: string): Promise<void>;
}

/** File-backed: one JSON mapping repo slug -> evidence. */
export class FileEvidenceStore implements EvidenceStore {
  #path: string;

  constructor(dir = stateDir()) {
    this.#path = join(dir, "evidence.json");
  }

  // Corruption throws, like the policy store: reading a damaged evidence file
  // back as "{}" would silently restore the one-command-per-worker behaviour
  // this store exists to end.
  async #read(): Promise<Record<string, Omit<RepoEvidence, "repo">>> {
    return readJsonFile<Record<string, Omit<RepoEvidence, "repo">>>(this.#path, {});
  }

  async forRepo(repo: string): Promise<RepoEvidence | null> {
    const key = repoSlug(repo);
    if (key === null) return null;
    const all = await this.#read();
    const entry = all[key];
    return entry === undefined ? null : { repo: key, ...entry };
  }

  async set(evidence: RepoEvidence): Promise<void> {
    const key = repoSlug(evidence.repo) ?? evidence.repo.trim().toLowerCase();
    const { repo: _drop, ...rest } = evidence;
    await updateJsonFile<Record<string, Omit<RepoEvidence, "repo">>>(this.#path, {}, (all) => ({
      ...all,
      [key]: rest,
    }));
  }

  async list(): Promise<RepoEvidence[]> {
    const all = await this.#read();
    return Object.entries(all).map(([repo, v]) => ({ repo, ...v }));
  }

  async remove(repo: string): Promise<void> {
    const key = repoSlug(repo) ?? repo.trim().toLowerCase();
    await updateJsonFile<Record<string, Omit<RepoEvidence, "repo">>>(this.#path, {}, (all) => {
      const next = { ...all };
      delete next[key];
      return next;
    });
  }
}

/** Nucleus-backed over a fresh ship_evidence table. */
export class NucleusEvidenceStore implements EvidenceStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_evidence (
          repo TEXT,
          test_command TEXT,
          test_timeout_ms TEXT,
          observe_service TEXT
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

  async forRepo(repo: string): Promise<RepoEvidence | null> {
    await this.#ensure();
    const key = repoSlug(repo);
    if (key === null) return null;
    const rows = await this.#db.query(
      "SELECT repo, test_command, test_timeout_ms, observe_service FROM ship_evidence WHERE repo = $1",
      [key],
    );
    return rows.length > 0 ? this.#toEvidence(rows[0]!) : null;
  }

  #toEvidence(row: Record<string, unknown>): RepoEvidence {
    const timeout = row.test_timeout_ms !== null && row.test_timeout_ms !== undefined ? Number(row.test_timeout_ms) : undefined;
    return {
      repo: String(row.repo),
      ...(row.test_command !== null && row.test_command !== undefined ? { testCommand: String(row.test_command) } : {}),
      ...(timeout !== undefined && Number.isFinite(timeout) ? { testTimeoutMs: timeout } : {}),
      ...(row.observe_service !== null && row.observe_service !== undefined ? { observeService: String(row.observe_service) } : {}),
    };
  }

  async set(evidence: RepoEvidence): Promise<void> {
    await this.#ensure();
    const key = repoSlug(evidence.repo) ?? evidence.repo.trim().toLowerCase();
    const command = evidence.testCommand?.trim() || null;
    const timeout = evidence.testTimeoutMs !== undefined && Number.isFinite(evidence.testTimeoutMs) ? String(evidence.testTimeoutMs) : null;
    const service = evidence.observeService?.trim() || null;
    await upsertByKey(this.#db, {
      table: "ship_evidence",
      keyColumn: "repo",
      key,
      update: () =>
        this.#db.query(
          "UPDATE ship_evidence SET test_command = $1, test_timeout_ms = $2, observe_service = $3 WHERE repo = $4",
          [command, timeout, service, key],
        ),
      insert: () =>
        this.#db.query("INSERT INTO ship_evidence (repo, test_command, test_timeout_ms, observe_service) VALUES ($1, $2, $3, $4)", [
          key,
          command,
          timeout,
          service,
        ]),
    });
  }

  async list(): Promise<RepoEvidence[]> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT repo, test_command, test_timeout_ms, observe_service FROM ship_evidence");
    return rows.map((r) => this.#toEvidence(r)).sort((a, b) => (a.repo < b.repo ? -1 : 1));
  }

  async remove(repo: string): Promise<void> {
    await this.#ensure();
    const key = repoSlug(repo) ?? repo.trim().toLowerCase();
    await this.#db.query("DELETE FROM ship_evidence WHERE repo = $1", [key]);
  }
}
