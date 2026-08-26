import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileProjectStore, ProjectEvidenceStore, normalizeProject } from "./projects.js";
import { FileEvidenceStore } from "./evidence.js";
import { assertRepoAllowed, effectiveAllowlist, RepoNotAllowedError } from "./repo-policy.js";
import { enqueueRun, proposeExternal } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";
import { sandboxOverridesOf, sandboxProvider, withProjects } from "./durable.js";
import { sweepIntake } from "./worker.js";
import type { IntakeSweepDeps } from "./worker.js";
import type { IntakeTask } from "./intake.js";
import { LocalAdmission } from "./admission.js";

const GO_URL = "http://100.108.123.49:49152/Tyler/ship-go.git";
const TS_URL = "http://100.108.123.49:49152/Tyler/ship-ts";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "ship-projects-"));
}

test("project store: keyed by slug, url kept, enums validated, empty fields dropped", async () => {
  const dir = await tempDir();
  const store = new FileProjectStore(dir);
  await store.set({ repo: GO_URL, url: GO_URL, sandboxImage: " golang:1.24 ", label: "", autoMerge: false, autoDeploy: false });
  const p = await store.forRepo("tyler/ship-go");
  assert.deepEqual(p, { repo: "tyler/ship-go", url: GO_URL, sandboxImage: "golang:1.24", autoMerge: false, autoDeploy: false });
  assert.deepEqual(await store.forRepo("git@100.108.123.49:Tyler/ship-go"), p, "any URL form finds the record");

  assert.throws(() => normalizeProject({ repo: "a/b", sandboxNetwork: "bridge" as never, autoMerge: false, autoDeploy: false }), /none or egress/);
  assert.throws(() => normalizeProject({ repo: "a/b", sourcePolicy: "yes" as never, autoMerge: false, autoDeploy: false }), /ignore, propose or auto/);
  assert.throws(() => normalizeProject({ repo: "a/b", url: "not-a-repo", autoMerge: false, autoDeploy: false }), /not a repository URL/);

  await store.remove(GO_URL);
  assert.equal(await store.forRepo("tyler/ship-go"), null);
});

test("evidence is a view of projects: reads through to legacy rows, writes move a repo onto its project", async () => {
  const dir = await tempDir();
  const projects = new FileProjectStore(dir);
  const legacy = new FileEvidenceStore(dir);
  const view = new ProjectEvidenceStore(projects, legacy);

  // A deployment with existing evidence rows keeps working with no migration.
  await legacy.set({ repo: "tyler/old", testCommand: "go test ./..." });
  assert.deepEqual(await view.forRepo("tyler/old"), { repo: "tyler/old", testCommand: "go test ./..." });

  // A project with evidence fields wins over a legacy row for the same repo.
  await projects.set({ repo: "tyler/old", url: GO_URL, testCommand: "make test", autoMerge: false, autoDeploy: false });
  assert.deepEqual(await view.forRepo("tyler/old"), { repo: "tyler/old", testCommand: "make test" });

  // `evidence set` writes to the project (creating one) and retires the legacy row.
  await legacy.set({ repo: "tyler/new", testCommand: "pnpm test" });
  await view.set({ repo: "tyler/new", testCommand: "pnpm test", observeService: "new-svc" });
  assert.equal(await legacy.forRepo("tyler/new"), null, "legacy row retired");
  const created = await projects.forRepo("tyler/new");
  assert.equal(created?.testCommand, "pnpm test");
  assert.equal(created?.observeService, "new-svc");
  assert.equal(created?.url, undefined, "no clone URL was known — the project joins no allowlist");

  // Setting evidence on an existing project keeps its other fields.
  await view.set({ repo: "tyler/old", testCommand: "go test -race ./..." });
  const kept = await projects.forRepo("tyler/old");
  assert.equal(kept?.url, GO_URL);
  assert.equal(kept?.testCommand, "go test -race ./...");

  const listed = (await view.list()).map((e) => `${e.repo}=${e.testCommand}`);
  assert.deepEqual(listed, ["tyler/new=pnpm test", "tyler/old=go test -race ./..."]);

  await view.remove("tyler/old");
  assert.equal(await view.forRepo("tyler/old"), null);
  assert.equal((await projects.forRepo("tyler/old"))?.url, GO_URL, "removing evidence keeps the project");
});

test("allowlist = env floor + project repos, by exact repo only", async () => {
  const dir = await tempDir();
  const projects = new FileProjectStore(dir);
  await projects.set({ repo: GO_URL, url: GO_URL, autoMerge: false, autoDeploy: false });
  await projects.set({ repo: "tyler/no-url", testCommand: "x", autoMerge: false, autoDeploy: false });

  const env = { allowlist: "https://github.com/useteploy" };
  const policy = await withProjects(env, projects);
  const entries = effectiveAllowlist(policy);
  assert.deepEqual(entries, [
    { origin: "https://github.com", owner: "useteploy" },
    { origin: "http://100.108.123.49:49152", owner: "tyler", repo: "ship-go" },
  ]);

  // The project repo is allowed for an external URL; a sibling on the same origin is not.
  assert.equal(assertRepoAllowed(GO_URL, { trust: "external", config: policy }).repo, "ship-go");
  assert.throws(() => assertRepoAllowed(TS_URL, { trust: "external", config: policy }), RepoNotAllowedError);
  // No env allowlist at all: a project alone lifts the fail-closed refusal for its repo.
  const projectsOnly = await withProjects({}, projects);
  assert.equal(assertRepoAllowed(GO_URL, { trust: "external", config: projectsOnly }).repo, "ship-go");
  assert.throws(() => assertRepoAllowed(TS_URL, { trust: "external", config: projectsOnly }), RepoNotAllowedError);
});

test("proposeExternal accepts a webhook repo that only a project allows", async () => {
  const dir = await tempDir();
  const projects = new FileProjectStore(dir);
  await projects.set({ repo: TS_URL, url: TS_URL, autoMerge: false, autoDeploy: false });
  const proposed: string[] = [];
  const runtime = {
    projects,
    intake: { propose: async (input: { repo?: string }) => { proposed.push(input.repo ?? ""); return { created: true, task: { taskId: "t1" } }; } },
  } as unknown as ShipRuntime;
  const saved = process.env.SHIP_REPO_ALLOWLIST;
  delete process.env.SHIP_REPO_ALLOWLIST;
  try {
    await proposeExternal(runtime, { source: "forgejo", kind: "issue", title: "t", dedupeKey: "k", repo: TS_URL });
    assert.deepEqual(proposed, [TS_URL]);
    await assert.rejects(
      proposeExternal(runtime, { source: "forgejo", kind: "issue", title: "t", dedupeKey: "k2", repo: GO_URL }),
      RepoNotAllowedError,
    );
  } finally {
    if (saved !== undefined) process.env.SHIP_REPO_ALLOWLIST = saved;
  }
});

test("enqueueRun materialises the project's sandbox image, network and limits; the provider honours them", async () => {
  const dir = await tempDir();
  const projects = new FileProjectStore(dir);
  await projects.set({
    repo: TS_URL,
    url: TS_URL,
    sandboxImage: "node:22",
    sandboxNetwork: "egress",
    sandboxLimits: { memoryMb: 2048, cpus: 2 },
    testCommand: "pnpm test",
    autoMerge: false,
    autoDeploy: false,
  });
  const inputs: Array<Record<string, unknown>> = [];
  const runtime = {
    kind: "file",
    projects,
    evidence: new ProjectEvidenceStore(projects, new FileEvidenceStore(dir)),
    governance: { get: async () => ({ authority: {}, windows: {}, reviewers: [] }) },
    store: {
      append: async (_runId: string, event: { type: string; data?: { input?: Record<string, unknown> } }) => {
        if (event.type === "run-started") inputs.push(event.data!.input!);
      },
    },
    saveMeta: async () => {},
  } as unknown as ShipRuntime;
  await enqueueRun(runtime, { runId: "r1", task: "t", model: "m", repo: TS_URL });
  await enqueueRun(runtime, { runId: "r2", task: "t", model: "m", repo: GO_URL });
  assert.equal(inputs[0]!.sandboxImage, "node:22");
  assert.equal(inputs[0]!.sandboxNetwork, "egress");
  assert.deepEqual(inputs[0]!.sandboxLimits, { memoryMb: 2048, cpus: 2 });
  assert.equal(inputs[0]!.testCommand, "pnpm test", "evidence came from the project record");
  assert.equal(inputs[0]!.tests, true);
  assert.equal(inputs[1]!.sandboxImage, undefined, "a repo without a project carries no override");

  // The provider merges the recorded overrides over the worker defaults.
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ runId: "sbx-1", id: "sbx-1" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const provider = sandboxProvider({ baseURL: "http://sbx", token: "t", image: "golang:1.24", network: "none", fetch: fetchImpl });
  await provider.create(sandboxOverridesOf(inputs[0] as never));
  await provider.create(sandboxOverridesOf(inputs[1] as never));
  assert.equal(bodies[0]!.image, "node:22");
  assert.equal(bodies[0]!.network, "egress");
  assert.deepEqual(bodies[0]!.limits, { memoryMb: 2048, cpus: 2 });
  assert.equal(bodies[1]!.image, "golang:1.24", "worker default when the run recorded nothing");
  assert.equal(bodies[1]!.network, "none");
});

function task(taskId: string, repo?: string): IntakeTask {
  const at = "2026-08-25T00:00:00Z";
  return { taskId, source: "forgejo", kind: "issue", title: taskId, dedupeKey: taskId, state: "proposed", createdAt: at, updatedAt: at, ...(repo !== undefined ? { repo } : {}) };
}

test("sweep: a project's sourcePolicy overrides its source's for that repo's tasks", async () => {
  const dir = await tempDir();
  const projects = new FileProjectStore(dir);
  await projects.set({ repo: GO_URL, url: GO_URL, sourcePolicy: "auto", autoMerge: false, autoDeploy: false });
  await projects.set({ repo: TS_URL, url: TS_URL, sourcePolicy: "propose", autoMerge: false, autoDeploy: false });
  const tasks = [task("go", GO_URL), task("ts", TS_URL), task("plain")];
  const states = new Map(tasks.map((t) => [t.taskId, t]));
  const launched: string[] = [];
  const deps: IntakeSweepDeps = {
    intake: {
      list: async (state) => tasks.filter((t) => state === undefined || t.state === state),
      setState: async (id, state) => { states.get(id)!.state = state; },
      claim: async (id) => { const t = states.get(id)!; if (t.state !== "proposed") return false; t.state = "launched"; return true; },
    },
    spend: { reserve: async () => {}, release: async () => {}, get: async () => 0 } as never,
    admission: new LocalAdmission(),
    // forgejo itself is NOT auto: only the Go project's own policy launches.
    policies: { forgejo: "propose" },
    dailyAutoLimit: 100,
    maxConcurrentRuns: 100,
    budgetFor: () => 0,
    projects,
    estimatedRunCostUSD: 0.5,
    inFlight: new Map(),
    outcomeOf: async () => ({ terminal: false }),
    newRunId: () => `run-${launched.length + 1}`,
    launch: async (t) => { launched.push(t.taskId); },
    now: () => new Date("2026-08-25T12:00:00Z"),
    log: () => {},
  };
  await sweepIntake(deps);
  assert.deepEqual(launched, ["go"], "the auto project launched; the propose project and the repo-less task waited");
});
