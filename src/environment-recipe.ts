import { createHash } from "node:crypto";
import { readinessInputsDigest, type ReadinessDigest, type ReadinessInputs } from "./stack-detect.js";

/**
 * Versioned environment recipes (S06): a pure description of how to prepare,
 * refresh, start and tear down a project's environment, plus the planner and
 * lifecycle validator that make the rules below executable. Nothing here
 * touches a sandbox, a clock or the network; commands run through an injected
 * `RecipeRunner`.
 *
 * Built on, not instead of:
 *  - `stack-detect.ts`: `ReadinessInputs` / `readinessInputsDigest` record the
 *    manifests, lockfiles, image and config a preparation depended on. A recipe
 *    digest is that digest with the canonical recipe as its `recipe` entry.
 *    `DetectedService` / proposals are the intended source of a recipe's
 *    services and commands.
 *  - `environment.ts`: the `EnvironmentPreparation` bounds (8000 chars,
 *    <= 900 s) are mirrored by `validateRecipe`.
 *  - `warm.ts` / `project-readiness.ts`: their lockfile-hash and config-key
 *    ideas; the cache key here adds the project id and recipe version so a
 *    reusable cache can never cross a project boundary.
 *
 * Rules enforced:
 *  - initialise / refresh / startup / teardown are separate phases. A cached
 *    run does refresh instead of initialise; `clean` does a full initialise
 *    and ignores every cache.
 *  - A cache is used only when project id, recipe version and the lockfile
 *    digests all match, it carries no secret, and its recorded integrity
 *    hash matches what was observed. Anything else is discarded WITH a reason.
 *  - Untrusted-repo phases get no secret and no privileged step. Privileged
 *    steps exist only for image preparation (initialise) and teardown.
 *  - Teardown stops services and background processes and reports anything
 *    still alive as a failure.
 */

export type PhaseName = "initialise" | "refresh" | "startup" | "teardown";
export type TrustLevel = "privileged" | "untrusted-repo";
export type FailureClass = "environment" | "repository";

export interface RecipePhase {
  command: string;
  timeoutMs: number;
  trust: TrustLevel;
}
export interface HealthCheck {
  kind: "tcp" | "http" | "command";
  /** tcp: ignored; http: request path; command: the command to run. */
  target: string;
  /** Per attempt. */
  timeoutMs: number;
  /** Retries after the first attempt. */
  retries: number;
}
export type PortDiscovery = { kind: "fixed"; port: number } | { kind: "discover" };
export interface RecipeService {
  name: string;
  image: string;
  healthCheck: HealthCheck;
  port: PortDiscovery;
}
export interface EnvironmentRecipe {
  version: string;
  phases: Record<PhaseName, RecipePhase>;
  /** Optional verification command, always untrusted-repo, run after startup. */
  test?: { command: string; timeoutMs: number };
  services: RecipeService[];
  cachePolicy: {
    /** Lockfile paths whose digests key the cache. */
    keys: string[];
    scope: "project-only";
  };
  /** Names only; values never appear in a recipe. `scope` maps name -> phases. */
  secrets: { names: string[]; scope: Record<string, PhaseName[]> };
}

const PHASES: readonly PhaseName[] = ["initialise", "refresh", "startup", "teardown"];
const MAX_COMMAND = 8000;
const MAX_TIMEOUT_MS = 900_000;
const MAX_HEALTH_RETRIES = 30;
const MAX_HEALTH_BUDGET_MS = 120_000;
const SECRET_NAME = /^[A-Z_][A-Z0-9_]*$/;

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const stable = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(stable)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]))
  : v;
/** Canonical, key-order-independent JSON of the recipe. */
export function canonicalRecipe(recipe: EnvironmentRecipe): string {
  return JSON.stringify(stable(recipe));
}

/** Recipe + recorded build inputs (manifests, lockfiles, image, config) in one reproducible digest. */
export function recipeDigest(recipe: EnvironmentRecipe, inputs: ReadinessInputs): ReadinessDigest {
  return readinessInputsDigest({ ...inputs, recipe: canonicalRecipe(recipe) });
}

/** Everything wrong with a recipe; empty means usable. Never throws. */
export function validateRecipe(recipe: EnvironmentRecipe): string[] {
  const issues: string[] = [];
  if (!recipe.version?.trim()) issues.push("recipe.version is required");
  const bound = (what: string, ms: unknown) => {
    if (!Number.isInteger(ms) || (ms as number) < 1 || (ms as number) > MAX_TIMEOUT_MS) issues.push(`${what}: timeoutMs must be an integer in 1..${MAX_TIMEOUT_MS}`);
  };
  const secretNames = new Set(recipe.secrets?.names ?? []);
  for (const n of secretNames) if (!SECRET_NAME.test(n)) issues.push(`secret name "${n}" must look like an environment variable name`);
  for (const p of PHASES) {
    const ph = recipe.phases?.[p];
    if (!ph) { issues.push(`phase ${p} is missing`); continue; }
    if (!ph.command?.trim()) issues.push(`phase ${p}: command is required`);
    else if (ph.command.length > MAX_COMMAND) issues.push(`phase ${p}: command exceeds ${MAX_COMMAND} characters`);
    bound(`phase ${p}`, ph.timeoutMs);
    if (ph.trust !== "privileged" && ph.trust !== "untrusted-repo") issues.push(`phase ${p}: trust must be privileged or untrusted-repo`);
    if (ph.trust === "privileged" && p !== "initialise" && p !== "teardown")
      issues.push(`phase ${p}: privileged is reserved for image preparation (initialise) and teardown; ${p} runs repository code`);
    if (ph.trust === "untrusted-repo") {
      for (const [name, phases] of Object.entries(recipe.secrets?.scope ?? {}))
        if (phases.includes(p)) issues.push(`secret ${name} is scoped to untrusted-repo phase ${p}`);
      for (const n of secretNames)
        if (new RegExp(`(^|[^A-Za-z0-9_])${n}([^A-Za-z0-9_]|$)`).test(ph.command ?? "")) issues.push(`phase ${p}: untrusted command references secret ${n}`);
    }
  }
  if (recipe.test) {
    if (!recipe.test.command?.trim()) issues.push("test: command is required");
    bound("test", recipe.test.timeoutMs);
    for (const n of secretNames)
      if (new RegExp(`(^|[^A-Za-z0-9_])${n}([^A-Za-z0-9_]|$)`).test(recipe.test.command ?? "")) issues.push(`test command references secret ${n}`);
  }
  for (const n of Object.keys(recipe.secrets?.scope ?? {})) if (!secretNames.has(n)) issues.push(`secret ${n} is scoped but not declared in secrets.names`);
  if (recipe.cachePolicy?.scope !== "project-only") issues.push('cachePolicy.scope must be "project-only"');
  const seen = new Set<string>();
  for (const s of recipe.services ?? []) {
    if (!s.name || seen.has(s.name)) issues.push(`service name "${s.name}" is empty or duplicated`);
    seen.add(s.name);
    if (!s.image?.trim()) issues.push(`service ${s.name}: image is required`);
    const h = s.healthCheck;
    if (!h) { issues.push(`service ${s.name}: healthCheck is required`); continue; }
    bound(`service ${s.name} healthCheck`, h.timeoutMs);
    if (!Number.isInteger(h.retries) || h.retries < 0 || h.retries > MAX_HEALTH_RETRIES) issues.push(`service ${s.name}: retries must be 0..${MAX_HEALTH_RETRIES}`);
    else if (h.timeoutMs * (h.retries + 1) > MAX_HEALTH_BUDGET_MS) issues.push(`service ${s.name}: health check budget exceeds ${MAX_HEALTH_BUDGET_MS} ms`);
    if (h.kind === "command" && !h.target?.trim()) issues.push(`service ${s.name}: command health check needs a target`);
    if (s.port?.kind === "fixed" && !(Number.isInteger(s.port.port) && s.port.port > 0 && s.port.port < 65536)) issues.push(`service ${s.name}: fixed port out of range`);
  }
  return issues;
}

// ------------------------------------------------------------------ cache

/** What a snapshot/cache records about itself. Supplied by whoever owns the store. */
export interface CacheEntry {
  projectId: string;
  recipeVersion: string;
  /** `cacheKey(...)` at the time it was written. */
  key: string;
  /** Integrity hash recorded at write time and the one observed now. */
  recordedIntegrity: string;
  observedIntegrity: string;
  /** Secret names found in the snapshot; non-empty means it must not be reused. */
  carriesSecrets?: string[];
}
export interface RunState {
  projectId: string;
  inputs: ReadinessInputs;
  cache?: CacheEntry | null;
}

/** project id + recipe version + the digest of each declared lockfile (+ image). */
export function cacheKey(recipe: EnvironmentRecipe, projectId: string, inputs: ReadinessInputs): string {
  const locks = [...recipe.cachePolicy.keys].sort().map((k) => `${k}=${inputs.lockfiles?.[k] === undefined ? "absent" : sha(inputs.lockfiles[k])}`);
  return sha(JSON.stringify([projectId, recipe.version, locks, inputs.image ?? null]));
}

export type CacheReason =
  | "clean" | "absent" | "match" | "other-project" | "recipe-version" | "inputs-changed" | "corrupt" | "carries-secrets";
export interface CacheDecision {
  use: boolean;
  reason: CacheReason;
  detail: string;
}
export function checkCache(recipe: EnvironmentRecipe, state: RunState, clean: boolean): CacheDecision {
  const c = state.cache;
  if (clean) return { use: false, reason: "clean", detail: c ? "clean mode ignores the cache" : "clean mode" };
  if (!c) return { use: false, reason: "absent", detail: "no cache" };
  const no = (reason: CacheReason, detail: string): CacheDecision => ({ use: false, reason, detail });
  if (c.projectId !== state.projectId) return no("other-project", `cache belongs to project ${c.projectId}, not ${state.projectId}`);
  if (c.carriesSecrets?.length) return no("carries-secrets", `cache carries secrets: ${c.carriesSecrets.join(", ")}`);
  if (c.recipeVersion !== recipe.version) return no("recipe-version", `cache built by recipe ${c.recipeVersion}, current ${recipe.version}`);
  if (c.key !== cacheKey(recipe, state.projectId, state.inputs)) return no("inputs-changed", "lockfile or image digests differ from the cache key");
  if (c.recordedIntegrity !== c.observedIntegrity) return no("corrupt", "cache integrity hash does not match what was recorded");
  return { use: true, reason: "match", detail: "key and integrity match" };
}

// ------------------------------------------------------------------- plan

export interface PlanStep {
  phase: PhaseName | "test";
  kind: "command" | "service-start" | "service-health";
  name: string;
  command?: string;
  service?: RecipeService;
  timeoutMs: number;
  trust: TrustLevel;
  /** Secret NAMES this step may receive. Always empty for untrusted-repo. */
  secrets: string[];
}
export interface RunPlan {
  ok: boolean;
  mode: "clean" | "fresh" | "cached";
  cache: CacheDecision;
  /** Rules that stopped planning; non-empty means `steps` is empty. */
  refusals: string[];
  steps: PlanStep[];
  /** Write a new cache after initialise succeeds. */
  writeCache: boolean;
}

export function planRun(recipe: EnvironmentRecipe, state: RunState, opts: { clean?: boolean } = {}): RunPlan {
  const clean = !!opts.clean;
  const cache = checkCache(recipe, state, clean);
  const refusals = validateRecipe(recipe);
  if (refusals.length) return { ok: false, mode: clean ? "clean" : "fresh", cache, refusals, steps: [], writeCache: false };
  const cmd = (p: PhaseName): PlanStep => {
    const ph = recipe.phases[p];
    const secrets = ph.trust === "privileged" ? recipe.secrets.names.filter((n) => recipe.secrets.scope[n]?.includes(p)) : [];
    return { phase: p, kind: "command", name: p, command: ph.command, timeoutMs: ph.timeoutMs, trust: ph.trust, secrets };
  };
  const steps: PlanStep[] = [cmd(cache.use ? "refresh" : "initialise")];
  for (const s of recipe.services) {
    steps.push({ phase: "startup", kind: "service-start", name: s.name, service: s, timeoutMs: recipe.phases.startup.timeoutMs, trust: "untrusted-repo", secrets: [] });
    steps.push({ phase: "startup", kind: "service-health", name: s.name, service: s, timeoutMs: s.healthCheck.timeoutMs * (s.healthCheck.retries + 1), trust: "untrusted-repo", secrets: [] });
  }
  steps.push(cmd("startup"));
  if (recipe.test) steps.push({ phase: "test", kind: "command", name: "test", command: recipe.test.command, timeoutMs: recipe.test.timeoutMs, trust: "untrusted-repo", secrets: [] });
  // Teardown is not in `steps`: it must run whatever happened above, via teardownPlan.
  return { ok: true, mode: clean ? "clean" : cache.use ? "cached" : "fresh", cache, refusals: [], steps, writeCache: !cache.use };
}

// --------------------------------------------------------------- teardown

export interface TeardownPlan {
  /** Services stopped in reverse start order, then processes, then the recipe's own command, then a leftover check. */
  stopServices: string[];
  killProcesses: string[];
  command: PlanStep;
}
export function teardownPlan(recipe: EnvironmentRecipe, live: { services: string[]; processes: string[] }): TeardownPlan {
  const ph = recipe.phases.teardown;
  return {
    stopServices: [...live.services].reverse(),
    killProcesses: [...live.processes],
    command: {
      phase: "teardown", kind: "command", name: "teardown", command: ph.command, timeoutMs: ph.timeoutMs, trust: ph.trust,
      secrets: ph.trust === "privileged" ? recipe.secrets.names.filter((n) => recipe.secrets.scope[n]?.includes("teardown")) : [],
    },
  };
}
export interface TeardownReport {
  ok: boolean;
  failures: string[];
}
/** Anything still alive after teardown is a failure, not a warning. */
export function assessTeardown(commandPassed: boolean, leftovers: readonly string[]): TeardownReport {
  const failures = [...(commandPassed ? [] : ["teardown command failed"]), ...leftovers.map((l) => `leftover after teardown: ${l}`)];
  return { ok: failures.length === 0, failures };
}

// -------------------------------------------------------------- lifecycle

export interface CommandResult {
  exitCode: number;
  timedOut?: boolean;
  /** Runner knows the fault is infrastructure (disk full, daemon down), not the repo. */
  environmentFault?: boolean;
  output?: string;
}
export interface RecipeRunner {
  run(step: { phase: string; command: string; timeoutMs: number; trust: TrustLevel; secrets: string[] }): Promise<CommandResult>;
  /** Start a service; `port` is the discovered port. Throws if the image or daemon is missing. */
  startService(service: RecipeService): Promise<{ handle: string; port?: number }>;
  probe(service: RecipeService, port: number | undefined, attempt: number): Promise<boolean>;
  stopService(handle: string): Promise<void>;
  killProcess(id: string): Promise<void>;
  /** Services and background processes still alive. */
  leftovers(): Promise<string[]>;
  listProcesses(): Promise<string[]>;
}
export interface PhaseOutcome {
  phase: PhaseName | "test";
  step: string;
  status: "pass" | "fail" | "skipped";
  failureClass?: FailureClass;
  detail: string;
}
export interface LifecycleReport {
  ok: boolean;
  plan: RunPlan;
  outcomes: PhaseOutcome[];
  teardown: TeardownReport;
}

const TIMED_OUT = Symbol("timed-out");
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<typeof TIMED_OUT>((r) => { t = setTimeout(() => r(TIMED_OUT), ms); })]);
  } finally {
    if (t) clearTimeout(t);
  }
}

/**
 * Drives any runner through plan -> steps -> teardown and says, per phase,
 * pass/fail and whether the environment or the repository is to blame:
 *  - privileged commands, services (missing image, no port, failed health) and
 *    teardown leftovers are environment faults;
 *  - an untrusted-repo command that exits non-zero or hangs is a repository
 *    fault, unless the runner flags `environmentFault`.
 * After the first failure later steps are `skipped`; teardown always runs.
 * The deadline here means a runner that never answers cannot hang validation.
 */
export async function validateRecipeLifecycle(
  runner: RecipeRunner, recipe: EnvironmentRecipe, state: RunState, opts: { clean?: boolean } = {},
): Promise<LifecycleReport> {
  const plan = planRun(recipe, state, opts);
  const outcomes: PhaseOutcome[] = [];
  const started: string[] = [];
  const ports = new Map<string, number | undefined>();
  if (!plan.ok) {
    outcomes.push({ phase: "initialise", step: "validate-recipe", status: "fail", failureClass: "environment", detail: plan.refusals.join("; ") });
    return { ok: false, plan, outcomes, teardown: { ok: true, failures: [] } };
  }
  let failed = false;
  const record = (s: PlanStep, status: PhaseOutcome["status"], detail: string, failureClass?: FailureClass) => {
    outcomes.push({ phase: s.phase, step: s.name, status, detail, ...(failureClass ? { failureClass } : {}) });
    if (status === "fail") failed = true;
  };
  for (const s of plan.steps) {
    if (failed) { record(s, "skipped", "an earlier step failed"); continue; }
    try {
      if (s.kind === "command") {
        const r = await withDeadline(runner.run({ phase: s.phase, command: s.command!, timeoutMs: s.timeoutMs, trust: s.trust, secrets: s.secrets }), s.timeoutMs + 50);
        const cls: FailureClass = s.trust === "privileged" ? "environment" : "repository";
        if (r === TIMED_OUT) record(s, "fail", `timed out after ${s.timeoutMs} ms`, cls);
        else if (r.timedOut) record(s, "fail", `timed out after ${s.timeoutMs} ms`, r.environmentFault ? "environment" : cls);
        else if (r.exitCode !== 0) record(s, "fail", `exit ${r.exitCode}`, r.environmentFault ? "environment" : cls);
        else record(s, "pass", "exit 0");
      } else if (s.kind === "service-start") {
        const r = await withDeadline(runner.startService(s.service!), s.timeoutMs);
        if (r === TIMED_OUT) record(s, "fail", "service start timed out", "environment");
        else {
          started.push(r.handle);
          const port = s.service!.port.kind === "fixed" ? s.service!.port.port : r.port;
          ports.set(s.name, port);
          if (port === undefined) record(s, "fail", "port discovery returned no port", "environment");
          else record(s, "pass", `started on port ${port}`);
        }
      } else {
        const h = s.service!.healthCheck;
        let ok = false;
        for (let a = 0; a <= h.retries && !ok; a++) {
          const r = await withDeadline(runner.probe(s.service!, ports.get(s.name), a), h.timeoutMs);
          ok = r === true;
        }
        record(s, ok ? "pass" : "fail", ok ? "healthy" : `unhealthy after ${h.retries + 1} attempts`, ok ? undefined : "environment");
      }
    } catch (e) {
      record(s, "fail", e instanceof Error ? e.message : String(e), s.kind === "command" && s.trust === "untrusted-repo" ? "repository" : "environment");
    }
  }
  const teardown = await runTeardown(runner, recipe, started);
  outcomes.push({
    phase: "teardown", step: "teardown", status: teardown.ok ? "pass" : "fail",
    ...(teardown.ok ? {} : { failureClass: "environment" as const }),
    detail: teardown.ok ? "clean" : teardown.failures.join("; "),
  });
  return { ok: !failed && teardown.ok, plan, outcomes, teardown };
}

async function runTeardown(runner: RecipeRunner, recipe: EnvironmentRecipe, handles: string[]): Promise<TeardownReport> {
  let processes: string[] = [];
  try { processes = await runner.listProcesses(); } catch { /* leftovers() below still reports */ }
  const plan = teardownPlan(recipe, { services: handles, processes });
  const failures: string[] = [];
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  for (const h of plan.stopServices) try { await withDeadline(runner.stopService(h), 5000); } catch (e) { failures.push(`stop ${h} failed: ${msg(e)}`); }
  for (const p of plan.killProcesses) try { await withDeadline(runner.killProcess(p), 5000); } catch (e) { failures.push(`kill ${p} failed: ${msg(e)}`); }
  let passed = true;
  try {
    const t = plan.command;
    const r = await withDeadline(runner.run({ phase: "teardown", command: t.command!, timeoutMs: t.timeoutMs, trust: t.trust, secrets: t.secrets }), t.timeoutMs + 50);
    passed = r !== TIMED_OUT && r.exitCode === 0 && !r.timedOut;
  } catch { passed = false; }
  let left: string[] = [];
  try { left = await runner.leftovers(); } catch (e) { failures.push(`leftover check failed: ${msg(e)}`); }
  const rep = assessTeardown(passed, left);
  return { ok: rep.ok && failures.length === 0, failures: [...failures, ...rep.failures] };
}
