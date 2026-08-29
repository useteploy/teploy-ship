import { join } from "node:path";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { readJsonFile, updateJsonFile } from "./file-store.js";
import { upsertByKey } from "./upsert.js";
import { stateDir } from "./run-store.js";
import { repoSlug } from "./observe.js";
import { HARNESS_VERSIONS } from "./harness.js";
import { AUTHORITIES, isAuthority, normalizeVerification, type Authority, type ProjectVerification } from "./ladder.js";
import type { EvidenceStore, RepoEvidence } from "./evidence.js";
import type { IntakePolicy } from "./intake.js";

/**
 * One record per repository: everything Ship needs to know about a repo, in
 * one place, keyed the way evidence and telemetry already key it (owner/name
 * slug, see repoSlug).
 *
 * Before this, per-repo configuration was spread across SHIP_REPO_ALLOWLIST
 * (env), `evidence set` (ship_evidence), per-source policies (ship_policies),
 * reviewers (ship_governance) and one sandbox image per WORKER. Adding a repo
 * meant an env edit, a redeploy and a CLI call, and a Go repo and a pnpm repo
 * could not share a worker because the image was worker-wide.
 *
 * A project record is the operator's statement that Ship may work this repo:
 * its clone URL joins the allowlist (union with the env floor), its sandbox
 * image and limits override the worker default for that repo's runs, and its
 * evidence fields are what `enqueueRun` materialises into the run input.
 * Fields that later lanes read (sensitivePaths, classThresholds, scan,
 * autoMerge, autoDeploy, deployApp, workerLabels) live here so they have one
 * home; nothing in this file interprets them.
 */
export interface Project {
  /** Canonical key: owner/name slug (see repoSlug). */
  repo: string;
  /** Clone URL (origin/owner/name). Optional: a project created through `evidence set` has none and joins no allowlist. */
  url?: string;
  label?: string;
  sandboxImage?: string;
  sandboxNetwork?: "none" | "egress";
  sandboxLimits?: { memoryMb?: number; cpus?: number; pids?: number };
  /**
   * Which program edits this repo's tree: `native` (Ship's own loop) or an
   * external adapter id from HARNESS_VERSIONS (harness.ts). Absent = the
   * worker's SHIP_HARNESS, and that = native.
   *
   * This is the DECLARE half of declare-then-bake (B5). Declaring a harness
   * here is a statement about the repo, not an installation: the binary must
   * already be in the sandbox image the run boots, which is what
   * `images/build.sh --harness <id>` produces. Nothing installs it at run time,
   * because that would need sandbox egress AND would let the binary drift under
   * a running worker — and `selectAdapter` refuses to replay a run under a
   * version other than the one its log recorded.
   *
   * `enqueueRun` materialises it into the run input (as an id+version ref), so
   * a run replays under the harness it was enqueued for even if this record is
   * edited afterwards.
   */
  harness?: string;
  /** Overrides the source's intake policy for tasks from this repo. Absent = inherit the source's. */
  sourcePolicy?: IntakePolicy;
  dailyBudgetUSD?: number;
  testCommand?: string;
  testTimeoutMs?: number;
  observeService?: string;
  sensitivePaths?: string[];
  classThresholds?: { seriousLines?: number; seriousFiles?: number };
  scan?: { every: string; lastRunAt?: string };
  autoMerge: boolean;
  autoDeploy: boolean;
  deployApp?: string;
  workerLabels?: string[];
  /**
   * The verification ladder (C4 / contract 1): which rungs this project
   * declares — build command, tests command, preview app + smoke, visual
   * diff, observe window. `verification` lives HERE, not in a second store,
   * and the rungs it declares CAP the authority below (ladder.ts); nothing in
   * this file interprets it beyond shape validation at save time.
   *
   * ONE HOME FOR THE TESTS COMMAND. `verification.tests` and `testCommand`
   * above are the same fact in two spellings (contract 1's and the evidence
   * store's); normalizeProject folds them so they can never disagree at rest:
   * whichever is set wins (testCommand first, so the existing edit surfaces
   * keep working), and both fields come out of a save holding it.
   */
  verification?: ProjectVerification;
  /**
   * Contract 1's authority: how far this repo's changes may proceed without a
   * person. Absent keeps the legacy reading of the two booleans (`autoMerge`
   * = `auto_trivial`, otherwise `send`); a declared value is still CAPPED by
   * the ladder (ladder.ts authorityCap) and floored by `neverAuto`, both at
   * enqueue (runtime.ts), never re-read at execution.
   */
  authority?: Authority;
  /** Policy floor (D4): this repo never merges unattended, whatever the metrics say. */
  neverAuto?: boolean;
}

export interface ProjectStore {
  /** Look up by repo URL or slug. Null = no project. */
  forRepo(repo: string): Promise<Project | null>;
  /** Full upsert by Project.repo (normalised to the slug). */
  set(project: Project): Promise<void>;
  list(): Promise<Project[]>;
  remove(repo: string): Promise<void>;
}

const SANDBOX_NETWORKS: ReadonlySet<string> = new Set(["none", "egress"]);
const POLICIES: ReadonlySet<string> = new Set(["ignore", "propose", "auto"]);

/** Normalise a record before storage: key by slug, drop empty strings, validate enums. */
export function normalizeProject(input: Project): Project {
  const repo = repoSlug(input.repo) ?? input.repo.trim().toLowerCase();
  const str = (v: string | undefined): string | undefined => {
    const t = v?.trim();
    return t === undefined || t === "" ? undefined : t;
  };
  const num = (v: number | undefined): number | undefined => (v !== undefined && Number.isFinite(v) && v > 0 ? v : undefined);
  const url = str(input.url);
  if (url !== undefined && repoSlug(url) === null) throw new Error(`not a repository URL: ${url}`);
  if (input.sandboxNetwork !== undefined && !SANDBOX_NETWORKS.has(input.sandboxNetwork)) {
    throw new Error(`sandboxNetwork must be none or egress, got: ${String(input.sandboxNetwork)}`);
  }
  if (input.sourcePolicy !== undefined && !POLICIES.has(input.sourcePolicy)) {
    throw new Error(`sourcePolicy must be ignore, propose or auto, got: ${String(input.sourcePolicy)}`);
  }
  // Refuse an unknown harness HERE rather than at enqueue. `harnessRef` throws
  // on an unknown id (harness.ts), and a project record is read on the enqueue
  // path of every surface — a typo saved through the dashboard would otherwise
  // turn into a repo whose every webhook run fails to queue, with the error
  // arriving nowhere near where it was typed.
  const harness = str(input.harness);
  if (harness !== undefined && HARNESS_VERSIONS[harness] === undefined) {
    throw new Error(`unknown harness "${harness}"; known: ${Object.keys(HARNESS_VERSIONS).join(", ")}`);
  }
  const limits = input.sandboxLimits;
  const sandboxLimits =
    limits === undefined
      ? undefined
      : {
          ...(num(limits.memoryMb) !== undefined ? { memoryMb: num(limits.memoryMb) } : {}),
          ...(num(limits.cpus) !== undefined ? { cpus: num(limits.cpus) } : {}),
          ...(num(limits.pids) !== undefined ? { pids: num(limits.pids) } : {}),
        };
  // The ladder declaration, validated at save (a half-declared preview or a
  // negative window is a typo, and a typo on an editable record must refuse
  // the save rather than surface as a skipped rung on the next run).
  // normalizeVerification throws on those. The tests fold is the single-home
  // rule from the interface doc, applied ONLY where a ladder is already
  // declared: a bare testCommand stays what it always was (evidence config),
  // and the run input's verification is assembled at enqueue (runtime.ts) —
  // inventing a ladder here would silently move every suite-bearing repo onto
  // the new gate.
  const verification = (() => {
    const declared = normalizeVerification(input.verification);
    if (declared === undefined) return undefined;
    const testsCmd = str(input.testCommand) ?? declared.tests;
    return { ...declared, ...(testsCmd !== undefined ? { tests: testsCmd } : {}) };
  })();
  if (input.authority !== undefined && !isAuthority(input.authority)) {
    throw new Error(`authority must be one of ${AUTHORITIES.join(", ")}, got: ${String(input.authority)}`);
  }
  const list = (v: string[] | undefined): string[] | undefined => {
    const out = (v ?? []).map((s) => s.trim()).filter((s) => s !== "");
    return out.length > 0 ? out : undefined;
  };
  return {
    repo,
    ...(url !== undefined ? { url } : {}),
    ...(str(input.label) !== undefined ? { label: str(input.label) } : {}),
    ...(str(input.sandboxImage) !== undefined ? { sandboxImage: str(input.sandboxImage) } : {}),
    ...(input.sandboxNetwork !== undefined ? { sandboxNetwork: input.sandboxNetwork } : {}),
    // "native" is KEPT rather than folded into absent: it is the operator
    // saying this repo runs Ship's own loop even on a worker whose
    // SHIP_HARNESS names a vendor agent. Absent means "inherit".
    ...(harness !== undefined ? { harness } : {}),
    ...(sandboxLimits !== undefined && Object.keys(sandboxLimits).length > 0 ? { sandboxLimits } : {}),
    ...(input.sourcePolicy !== undefined ? { sourcePolicy: input.sourcePolicy } : {}),
    ...(num(input.dailyBudgetUSD) !== undefined ? { dailyBudgetUSD: num(input.dailyBudgetUSD) } : {}),
    ...(num(input.testTimeoutMs) !== undefined ? { testTimeoutMs: num(input.testTimeoutMs) } : {}),
    ...(str(input.observeService) !== undefined ? { observeService: str(input.observeService) } : {}),
    ...(list(input.sensitivePaths) !== undefined ? { sensitivePaths: list(input.sensitivePaths) } : {}),
    ...(input.classThresholds !== undefined ? { classThresholds: input.classThresholds } : {}),
    ...(input.scan !== undefined ? { scan: input.scan } : {}),
    autoMerge: input.autoMerge === true,
    autoDeploy: input.autoDeploy === true,
    ...(str(input.deployApp) !== undefined ? { deployApp: str(input.deployApp) } : {}),
    ...(list(input.workerLabels) !== undefined ? { workerLabels: list(input.workerLabels) } : {}),
    ...(verification !== undefined ? { verification } : {}),
    // The fold, both directions: a ladder with a tests command answers the
    // evidence question too, so the existing evidence surfaces read one value.
    ...(verification?.tests !== undefined ? { testCommand: verification.tests } : str(input.testCommand) !== undefined ? { testCommand: str(input.testCommand) } : {}),
    ...(isAuthority(input.authority) ? { authority: input.authority } : {}),
    ...(input.neverAuto === true ? { neverAuto: true } : {}),
  };
}

type Stored = Omit<Project, "repo">;

/** File-backed: one JSON mapping repo slug -> project. */
export class FileProjectStore implements ProjectStore {
  #path: string;

  constructor(dir = stateDir()) {
    this.#path = join(dir, "projects.json");
  }

  // Corruption throws (like evidence.json): a damaged file read back as "{}"
  // would silently shrink the allowlist and drop every per-repo image.
  async #read(): Promise<Record<string, Stored>> {
    return readJsonFile<Record<string, Stored>>(this.#path, {});
  }

  async forRepo(repo: string): Promise<Project | null> {
    const key = repoSlug(repo);
    if (key === null) return null;
    const entry = (await this.#read())[key];
    return entry === undefined ? null : { repo: key, ...entry };
  }

  async set(project: Project): Promise<void> {
    const { repo, ...rest } = normalizeProject(project);
    await updateJsonFile<Record<string, Stored>>(this.#path, {}, (all) => ({ ...all, [repo]: rest }));
  }

  async list(): Promise<Project[]> {
    const all = await this.#read();
    return Object.entries(all)
      .map(([repo, v]) => ({ repo, ...v }))
      .sort((a, b) => (a.repo < b.repo ? -1 : 1));
  }

  async remove(repo: string): Promise<void> {
    const key = repoSlug(repo) ?? repo.trim().toLowerCase();
    await updateJsonFile<Record<string, Stored>>(this.#path, {}, (all) => {
      const next = { ...all };
      delete next[key];
      return next;
    });
  }
}

/**
 * Nucleus-backed over a fresh ship_projects table. The record is one JSON
 * document per row rather than a column per field: Nucleus cannot safely
 * ALTER a populated table, and later lanes add fields to this record.
 */
export class NucleusProjectStore implements ProjectStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query("CREATE TABLE IF NOT EXISTS ship_projects (repo TEXT, doc TEXT)")
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#ready = null;
        throw error;
      });
    return this.#ready;
  }

  #parse(row: Record<string, unknown>): Project {
    const doc = JSON.parse(String(row.doc ?? "{}")) as Stored;
    return { repo: String(row.repo), ...doc };
  }

  async forRepo(repo: string): Promise<Project | null> {
    await this.#ensure();
    const key = repoSlug(repo);
    if (key === null) return null;
    const rows = await this.#db.query("SELECT repo, doc FROM ship_projects WHERE repo = $1", [key]);
    return rows.length > 0 ? this.#parse(rows[0]!) : null;
  }

  async set(project: Project): Promise<void> {
    await this.#ensure();
    const { repo, ...rest } = normalizeProject(project);
    const doc = JSON.stringify(rest);
    await upsertByKey(this.#db, {
      table: "ship_projects",
      keyColumn: "repo",
      key: repo,
      update: () => this.#db.query("UPDATE ship_projects SET doc = $1 WHERE repo = $2", [doc, repo]),
      insert: () => this.#db.query("INSERT INTO ship_projects (repo, doc) VALUES ($1, $2)", [repo, doc]),
    });
  }

  async list(): Promise<Project[]> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT repo, doc FROM ship_projects");
    return rows.map((r) => this.#parse(r)).sort((a, b) => (a.repo < b.repo ? -1 : 1));
  }

  async remove(repo: string): Promise<void> {
    await this.#ensure();
    const key = repoSlug(repo) ?? repo.trim().toLowerCase();
    await this.#db.query("DELETE FROM ship_projects WHERE repo = $1", [key]);
  }
}

/** The three evidence fields of a project, or null when none is set. */
function evidenceOf(p: Project): RepoEvidence | null {
  // verification.tests is the same fact as testCommand (the fold); read
  // through so a ladder declared through contract 1 answers the evidence
  // question without anyone remembering to fill the legacy field too.
  const testCommand = p.testCommand ?? p.verification?.tests;
  if (testCommand === undefined && p.testTimeoutMs === undefined && p.observeService === undefined) return null;
  return {
    repo: p.repo,
    ...(testCommand !== undefined ? { testCommand } : {}),
    ...(p.testTimeoutMs !== undefined ? { testTimeoutMs: p.testTimeoutMs } : {}),
    ...(p.observeService !== undefined ? { observeService: p.observeService } : {}),
  };
}

/**
 * Evidence as a view of projects. `forRepo` reads the project record first and
 * falls back to the legacy evidence store, so a deployment with existing
 * `ship_evidence` rows keeps working with no migration; `set` writes to the
 * project (creating one if needed, folding in any legacy entry) and retires the
 * legacy row, so every write moves a repo forward. `enqueueRun` and the
 * `evidence` CLI are unchanged.
 */
export class ProjectEvidenceStore implements EvidenceStore {
  #projects: ProjectStore;
  #legacy: EvidenceStore;

  constructor(projects: ProjectStore, legacy: EvidenceStore) {
    this.#projects = projects;
    this.#legacy = legacy;
  }

  async forRepo(repo: string): Promise<RepoEvidence | null> {
    const project = await this.#projects.forRepo(repo);
    if (project !== null) {
      const view = evidenceOf(project);
      if (view !== null) return view;
    }
    return this.#legacy.forRepo(repo);
  }

  async set(evidence: RepoEvidence): Promise<void> {
    const existing = (await this.#projects.forRepo(evidence.repo)) ?? { repo: evidence.repo, autoMerge: false, autoDeploy: false };
    const stripped = stripEvidence(existing);
    await this.#projects.set({
      ...stripped,
      ...(evidence.testCommand !== undefined ? { testCommand: evidence.testCommand } : {}),
      ...(evidence.testTimeoutMs !== undefined ? { testTimeoutMs: evidence.testTimeoutMs } : {}),
      ...(evidence.observeService !== undefined ? { observeService: evidence.observeService } : {}),
    });
    await this.#legacy.remove(evidence.repo);
  }

  async list(): Promise<RepoEvidence[]> {
    const [projects, legacy] = await Promise.all([this.#projects.list(), this.#legacy.list()]);
    const out = new Map<string, RepoEvidence>();
    for (const e of legacy) out.set(e.repo, e);
    for (const p of projects) {
      const view = evidenceOf(p);
      if (view !== null) out.set(p.repo, view);
    }
    return [...out.values()].sort((a, b) => (a.repo < b.repo ? -1 : 1));
  }

  async remove(repo: string): Promise<void> {
    const project = await this.#projects.forRepo(repo);
    if (project !== null) {
      await this.#projects.set(stripEvidence(project));
    }
    await this.#legacy.remove(repo);
  }
}

/** A project minus every spelling of its evidence fields: the evidence `remove`. */
function stripEvidence(p: Project): Project {
  const { testCommand: _c, testTimeoutMs: _t, observeService: _s, verification, ...rest } = p;
  if (verification?.tests === undefined) return rest;
  const { tests: _v, ...rungs } = verification;
  return { ...rest, verification: rungs };
}
