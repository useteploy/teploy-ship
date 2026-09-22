import { canonicalRepositoryURL as repositoryIdentity, projectReference, resolveProject, ProjectIdentityError } from "./project-identity.js";
export { projectReference, resolveProject, ProjectIdentityError } from "./project-identity.js";
import { normalizePreparation, type EnvironmentPreparation } from "./environment.js";
import { join } from "node:path";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { readJsonFile, updateJsonFile, writeJsonFile, withFileLock } from "./file-store.js";
import { stateDir } from "./run-store.js";
import { repoSlug } from "./observe.js";
import { HARNESS_VERSIONS } from "./harness.js";
import { AUTHORITIES, isAuthority, normalizeVerification, type Authority, type ProjectVerification } from "./ladder.js";
import type { EvidenceStore, RepoEvidence } from "./evidence.js";
import type { IntakePolicy } from "./intake.js";
import { NETWORK_TIER_HELP, normalizeEgressAllow, parseNetworkTier } from "./egress.js";
import type { NetworkTier } from "./egress.js";

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
  preparation?: EnvironmentPreparation;
  /**
   * Which network tier this repo's runs get (egress.ts): `none`, `allowlist`
   * or `open`. Absent = the worker's SHIP_SANDBOX_NETWORK, which itself
   * defaults to `allowlist`.
   *
   * Records written before three tiers existed hold the old `egress` spelling;
   * every read path runs the stored value through `parseNetworkTier`, so one
   * arrives here as `allowlist` and the next `set` rewrites it. Nothing
   * migrates.
   */
  sandboxNetwork?: NetworkTier;
  /**
   * EXTRA allowlist entries for this repo's runs — `host`, `.suffix` or
   * `host:port`, unioned with the daemon's built-in registries, never
   * replacing them. This is the answer to a Ruby, Java, PHP, .NET or Elixir
   * project failing its first dependency install: the remedy used to be
   * hand-editing a systemd unit on the sandbox host, which widened the
   * allowlist for every project sharing that host.
   *
   * Only meaningful on the `allowlist` tier: `none` has no proxy to consult
   * and `open` needs no permission.
   */
  sandboxEgressAllow?: string[];
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
  /** Require the existing native plan-approval checkpoint on every new change run.
   * This is a policy floor: per-run false cannot disable it. Old runs retain
   * their recorded inputs. It grants no merge or deployment authority. */
  requirePlanReview?: boolean;
  /** Contract 1: Akiroo owns the weekly spend cap for a managed project. */
  weeklyBudgetUSD?: number;
  /** Present when Akiroo manages this record (L8, contract 1). See managedDrift. */
  managedBy?: ManagedBy;
}

/** The fields Akiroo owns on a managed project, as it last applied them. */
export interface ManagedFields {
  url?: string;
  label?: string;
  sandboxImage?: string;
  authority?: Authority;
  neverAuto?: boolean;
  weeklyBudgetUSD?: number;
  verification?: ProjectVerification;
}

/**
 * Who manages this record and what they last sent.
 *
 * `hash` is Akiroo's `settings_hash`, echoed back on the ack and shown on the
 * Projects page so both sides can tell whether they agree. `fields` is Ship's
 * own snapshot of what that hash covered as APPLIED here: Ship cannot recompute
 * Akiroo's canonical JSON, so drift is detected by comparing the live record
 * against this snapshot rather than by re-hashing.
 */
export interface ManagedBy {
  source: "akiroo";
  ref: string;
  hash: string;
  appliedAt: string;
  fields: ManagedFields;
}

/** The managed fields of a record as they stand now. */
export function managedFieldsOf(p: Project): ManagedFields {
  return {
    ...(p.url !== undefined ? { url: p.url } : {}),
    ...(p.label !== undefined ? { label: p.label } : {}),
    ...(p.sandboxImage !== undefined ? { sandboxImage: p.sandboxImage } : {}),
    ...(p.authority !== undefined ? { authority: p.authority } : {}),
    ...(p.neverAuto !== undefined ? { neverAuto: p.neverAuto } : {}),
    ...(p.weeklyBudgetUSD !== undefined ? { weeklyBudgetUSD: p.weeklyBudgetUSD } : {}),
    ...(p.verification !== undefined ? { verification: p.verification } : {}),
  };
}

export interface ManagedDrift {
  field: keyof ManagedFields;
  /** What the record holds now (an operator override). */
  local: string;
  /** What Akiroo last applied. */
  managed: string;
}

/**
 * Which managed fields an operator has changed since Akiroo last applied them.
 * Empty for an unmanaged project and for a managed one nobody touched. Drift is
 * displayed, never silently reconciled: the next `project` row from Akiroo
 * overwrites these fields again, and the page says so.
 */
export function managedDrift(p: Project): ManagedDrift[] {
  if (p.managedBy === undefined) return [];
  const show = (v: unknown): string => (v === undefined ? "unset" : typeof v === "string" ? v : JSON.stringify(v));
  const now = managedFieldsOf(p);
  const was = p.managedBy.fields;
  const keys: Array<keyof ManagedFields> = ["url", "label", "sandboxImage", "authority", "neverAuto", "weeklyBudgetUSD", "verification"];
  const out: ManagedDrift[] = [];
  for (const field of keys) {
    if (JSON.stringify(now[field] ?? null) !== JSON.stringify(was[field] ?? null)) {
      out.push({ field, local: show(now[field]), managed: show(was[field]) });
    }
  }
  return out;
}

export interface ProjectStore {
  /** Look up by repo URL or slug. Null = no project. */
  forRepo(repo: string): Promise<Project | null>;
  /** Full upsert by clone URL; URL-less legacy records retain their slug. */
  set(project: Project): Promise<void>;
  list(): Promise<Project[]>;
  remove(repo: string): Promise<void>;
}

const POLICIES: ReadonlySet<string> = new Set(["ignore", "propose", "auto"]);

/** Normalise display name and clone binding, drop empty strings, validate enums. */
export function normalizeProject(input: Project): Project {
  if (input.requirePlanReview !== undefined && typeof input.requirePlanReview !== "boolean") throw new Error("requirePlanReview must be a boolean");
  const repo = repoSlug(input.repo) ?? input.repo.trim().toLowerCase();
  if (!repo.includes("/") || repo.startsWith("@")) throw new Error("A repository must include its owner and name");
  const str = (v: string | undefined): string | undefined => {
    const t = v?.trim();
    return t === undefined || t === "" ? undefined : t;
  };
  const num = (v: number | undefined): number | undefined => (v !== undefined && Number.isFinite(v) && v > 0 ? v : undefined);
  const url = str(input.url) ?? (repositoryIdentity(input.repo) !== null ? str(input.repo) : undefined);
  if (url !== undefined && repositoryIdentity(url) === null) throw new Error("not a repository URL: use HTTP(S) or file without embedded credentials, query parameters or fragments");
  if (url !== undefined && repoSlug(url) === null) throw new Error("not a repository URL: include the repository path");
  if (url !== undefined && repoSlug(url) !== repo) throw new Error("Project repository name must match its clone URL; configure a separate project for another repository");
  if (url && repositoryIdentity(input.repo) && repositoryIdentity(input.repo)!==repositoryIdentity(url)) throw new ProjectIdentityError(repo);
  const sandboxNetwork = parseNetworkTier(input.sandboxNetwork);
  if (sandboxNetwork === null) {
    throw new Error(`sandboxNetwork must be ${NETWORK_TIER_HELP}, got: ${String(input.sandboxNetwork)}`);
  }
  // Throws on an entry the daemon could not act on. Refusing the SAVE is the
  // point: the alternative is a typo that surfaces days later as a blocked
  // host on a run that has already been paid for.
  const sandboxEgressAllow = normalizeEgressAllow(input.sandboxEgressAllow);
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
    ...(sandboxNetwork !== undefined ? { sandboxNetwork } : {}),
    ...(sandboxEgressAllow !== undefined ? { sandboxEgressAllow } : {}),
    // "native" is KEPT rather than folded into absent: it is the operator
    // saying this repo runs Ship's own loop even on a worker whose
    // SHIP_HARNESS names a vendor agent. Absent means "inherit".
    ...(harness !== undefined ? { harness } : {}),
    ...(sandboxLimits !== undefined && Object.keys(sandboxLimits).length > 0 ? { sandboxLimits } : {}),
    ...(normalizePreparation(input.preparation) ? { preparation: normalizePreparation(input.preparation) } : {}),
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
    ...(input.requirePlanReview === true ? { requirePlanReview: true } : {}),
    ...(num(input.weeklyBudgetUSD) !== undefined ? { weeklyBudgetUSD: num(input.weeklyBudgetUSD) } : {}),
    ...(input.managedBy !== undefined ? { managedBy: input.managedBy } : {}),
  };
}

/** Bare legacy slugs remain valid explicit references. URLs must match exactly. */
export function projectForReference(project: Project, reference: string): Project {
  const found=resolveProject([project],reference);
  if(!found)throw new ProjectIdentityError(project.repo);
  return found;
}

function assertSameProject(existing: Project | null, next: Project): void {
  if (!existing?.url) return;
  const identity = repositoryIdentity(existing.url);
  // Unsupported legacy clone spellings can be edited without letting two
  // unparsable values (both null) silently rebind the project.
  if (!next.url || (identity === null ? existing.url !== next.url : identity !== repositoryIdentity(next.url))) throw new ProjectIdentityError(existing.repo);
}

type Stored = Omit<Project, "repo">;

/**
 * A stored row as a Project.
 *
 * The one thing it changes is the network tier: a record written before three
 * tiers existed holds `"egress"`, which is the alias for `allowlist`, and every
 * consumer of a Project would otherwise have to know that. Upgraded HERE, on
 * the read, rather than by a migration — there is nothing to migrate, the two
 * spellings mean the same thing, and the next `set` writes the new one.
 *
 * Anything else stored under an unreadable value is left exactly as it is:
 * `normalizeProject` refuses those at the save, so a value that got past it
 * came from somewhere this function cannot fix.
 */
function fromStored(repo: string, stored: Stored): Project {
  const tier = parseNetworkTier(stored.sandboxNetwork);
  return { repo: repoSlug(repo) ?? repo, ...stored, ...(tier !== undefined && tier !== null ? { sandboxNetwork: tier } : {}) };
}

/** Legacy files/tables remain intact. The v2 map is authoritative after its
 * first successful snapshot; removals never resurrect a legacy record. */
function migrateProjectRows(rows:Project[]):Record<string,Stored> {
  const out:Record<string,Stored>={};
  for(const row of rows){
    // Preserve old unbound records, including malformed names, for operator
    // inspection/removal. New writes still pass full validation.
    if(row.repo.startsWith("@"))throw new ProjectIdentityError(row.repo);
    const normalized=row.url ? normalizeProject(row) : row;
    const key=projectReference(normalized);
    const {repo:_repo,...doc}={...row,...normalized};
    if(out[key]&&JSON.stringify(out[key])!==JSON.stringify(doc))throw new ProjectIdentityError(normalized.repo);
    out[key]=doc;
  }
  return out;
}
export class FileProjectStore implements ProjectStore {
  #path:string;
  #legacy:string;
  constructor(dir=stateDir()) {this.#path=join(dir,"projects-v2.json");this.#legacy=join(dir,"projects.json");}
  async #read():Promise<Record<string,Stored>> {
    const current=await readJsonFile<Record<string,Stored>|null>(this.#path,null);
    if(current!==null)return current;
    return withFileLock(this.#path,async()=>{
      const raced=await readJsonFile<Record<string,Stored>|null>(this.#path,null);
      if(raced!==null)return raced;
      const legacy=await readJsonFile<Record<string,Stored>>(this.#legacy,{});
      const migrated=migrateProjectRows(Object.entries(legacy).map(([key,doc])=>fromStored(key,doc)));
      await writeJsonFile(this.#path,migrated);
      return migrated;
    });
  }
  async forRepo(repo:string):Promise<Project|null> {return resolveProject(await this.list(),repo);}
  async set(project:Project):Promise<void> {
    const normalized=normalizeProject(project), key=projectReference(normalized);
    const {repo,...rest}=normalized;
    await this.#read();
    await updateJsonFile<Record<string,Stored>>(this.#path,{},all=>{
      if(!normalized.url&&Object.entries(all).some(([k,p])=>p.url&&fromStored(k,p).repo===repo))throw new ProjectIdentityError(repo);
      assertSameProject(all[key]?fromStored(key,all[key]!):null,normalized);
      const next={...all,[key]:rest};
      // Explicitly connecting a URL-less record moves its complete supplied
      // configuration to that origin. The original legacy file stays intact.
      if(key!==repo&&all[repo]&&!all[repo]!.url)delete next[repo];
      return next;
    });
  }
  async list():Promise<Project[]> {
    return Object.entries(await this.#read()).map(([key,doc])=>fromStored(key,doc)).sort((a,b)=>projectReference(a).localeCompare(projectReference(b)));
  }
  async remove(repo:string):Promise<void> {
    await this.#read();
    await updateJsonFile<Record<string,Stored>>(this.#path,{},all=>{
      const project=resolveProject(Object.entries(all).map(([key,doc])=>fromStored(key,doc)),repo);
      if(!project)return all;
      const next={...all};delete next[projectReference(project)];return next;
    });
  }
}

/** Origin-qualified primary-key storage; legacy import commits once, together
 * with its marker. Concurrent initializers cannot overwrite edited v2 records. */
export class NucleusProjectStore implements ProjectStore {
  #ready:Promise<void>|null=null;
  constructor(private db:NucleusPgwire){}
  #ensure():Promise<void> {
    return this.#ready??=(async()=>{
      await this.db.query("CREATE TABLE IF NOT EXISTS ship_projects (repo TEXT, doc TEXT)");
      await this.db.query("CREATE TABLE IF NOT EXISTS ship_projects_v2 (repo TEXT PRIMARY KEY, doc TEXT)");
      if((await this.db.query("SELECT repo FROM ship_projects_v2 WHERE repo = $1",['@migration'])).length)return;
      try {
        await this.db.transaction(async tx=>{
          await tx.query("INSERT INTO ship_projects_v2 (repo,doc) VALUES ($1,$2)",['@migration','legacy-v1']);
          const old=await tx.query("SELECT repo, doc FROM ship_projects");
          const migrated=migrateProjectRows(old.map(row=>this.#parse(row)));
          for(const [key,doc] of Object.entries(migrated))await tx.query("INSERT INTO ship_projects_v2 (repo,doc) VALUES ($1,$2)",[key,JSON.stringify(doc)]);
        });
      }catch(error){
        if((error as {code?:string}).code!=='23505'||!(await this.db.query("SELECT repo FROM ship_projects_v2 WHERE repo = $1",['@migration'])).length)throw error;
      }
    })().catch(error=>{this.#ready=null;throw error});
  }
  #parse(row:Record<string,unknown>):Project {return fromStored(String(row.repo),JSON.parse(String(row.doc)) as Stored);}
  async list():Promise<Project[]> {
    await this.#ensure();
    return (await this.db.query("SELECT repo, doc FROM ship_projects_v2")).filter(row=>row.repo!=='@migration').map(row=>this.#parse(row)).sort((a,b)=>projectReference(a).localeCompare(projectReference(b)));
  }
  async forRepo(repo:string):Promise<Project|null> {return resolveProject(await this.list(),repo);}
  async set(project:Project):Promise<void> {
    await this.#ensure();
    const normalized=normalizeProject(project),key=projectReference(normalized);
    const {repo,...rest}=normalized,doc=JSON.stringify(rest);
    if(!normalized.url&&(await this.list()).some(p=>p.url&&p.repo===repo))throw new ProjectIdentityError(repo);
    try { await this.db.transaction(async tx=>{
      const [prior]=await tx.query("SELECT repo, doc FROM ship_projects_v2 WHERE repo = $1",[key]);
      if(prior){
        assertSameProject(this.#parse(prior),normalized);
        if(await tx.exec("UPDATE ship_projects_v2 SET doc = $1 WHERE repo = $2 AND doc = $3",[doc,key,prior.doc])!==1)throw new Error("Project changed during update; retry");
      }else await tx.query("INSERT INTO ship_projects_v2 (repo,doc) VALUES ($1,$2)",[key,doc]);
      if(key!==repo){
        const [legacy]=await tx.query("SELECT repo, doc FROM ship_projects_v2 WHERE repo = $1",[repo]);
        if(legacy&&!this.#parse(legacy).url)await tx.exec("DELETE FROM ship_projects_v2 WHERE repo = $1 AND doc = $2",[repo,legacy.doc]);
      }
    }); } catch(error) {
      if((error as {code?:string}).code!=="23505")throw error;
      const [saved]=await this.db.query("SELECT doc FROM ship_projects_v2 WHERE repo = $1",[key]);
      if(saved?.doc!==doc)throw new Error("Project changed during registration; retry");
    }
  }
  async remove(repo:string):Promise<void> {
    const project=await this.forRepo(repo);if(!project)return;
    const key=projectReference(project);
    const [prior]=await this.db.query("SELECT repo, doc FROM ship_projects_v2 WHERE repo = $1",[key]);
    if(!prior)return;
    if(await this.db.exec("DELETE FROM ship_projects_v2 WHERE repo = $1 AND doc = $2",[key,prior.doc])!==1)throw new Error("Project changed during removal; retry");
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
    const legacy=await this.#legacy.forRepo(repo);
    if(legacy&&repositoryIdentity(repo)&&(project===null||(await this.#projects.list()).filter(p=>p.repo===legacy.repo).length!==1))throw new ProjectIdentityError(legacy.repo);
    return legacy;
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
    if((await this.#projects.list()).filter(p=>p.repo===repoSlug(evidence.repo)).length<=1)await this.#legacy.remove(evidence.repo);
  }

  async list(): Promise<RepoEvidence[]> {
    const [projects, legacy] = await Promise.all([this.#projects.list(), this.#legacy.list()]);
    const out = new Map<string, RepoEvidence>();
    for (const e of legacy) out.set(e.repo, e);
    for (const p of projects) {
      const view = evidenceOf(p);
      if (view !== null) {out.delete(p.repo);out.set(projectReference(p),{...view,repo:projectReference(p)});}
    }
    return [...out.values()].sort((a, b) => (a.repo < b.repo ? -1 : 1));
  }

  async remove(repo: string): Promise<void> {
    const project = await this.#projects.forRepo(repo);
    if (project !== null) {
      await this.#projects.set(stripEvidence(project));
    }
    if((await this.#projects.list()).filter(p=>p.repo===repoSlug(repo)).length<=1)await this.#legacy.remove(repo);
  }
}

/** A project minus every spelling of its evidence fields: the evidence `remove`. */
function stripEvidence(p: Project): Project {
  const { testCommand: _c, testTimeoutMs: _t, observeService: _s, verification, ...rest } = p;
  if (verification?.tests === undefined) return rest;
  const { tests: _v, ...rungs } = verification;
  return { ...rest, verification: rungs };
}
