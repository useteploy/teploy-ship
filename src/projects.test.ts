import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileProjectStore, ProjectEvidenceStore, normalizeProject } from "./projects.js";
import type { ProjectStore } from "./projects.js";
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

/**
 * B5-b, declare-then-bake: a project says WHICH program edits its tree. The
 * binary itself is baked into the sandbox image (images/build.sh); this record
 * is the declaration, and enqueueRun materialises it into the run input.
 */
test("project record: harness is validated at write time, and native is a real answer", () => {
  assert.equal(normalizeProject({ repo: "tyler/a", harness: "claude-code", autoMerge: false, autoDeploy: false }).harness, "claude-code");
  assert.equal(normalizeProject({ repo: "tyler/a", harness: "opencode", autoMerge: false, autoDeploy: false }).harness, "opencode");
  // "native" is KEPT, not folded away: it is the operator overriding a worker
  // whose SHIP_HARNESS names a vendor agent.
  assert.equal(normalizeProject({ repo: "tyler/a", harness: "native", autoMerge: false, autoDeploy: false }).harness, "native");
  assert.equal(normalizeProject({ repo: "tyler/a", harness: "  ", autoMerge: false, autoDeploy: false }).harness, undefined);
  assert.equal(normalizeProject({ repo: "tyler/a", autoMerge: false, autoDeploy: false }).harness, undefined);
  // Rejected HERE rather than at enqueue: harnessRef throws on an unknown id,
  // and a typo saved through the dashboard would otherwise surface as every
  // webhook run for that repo failing to queue, nowhere near where it was typed.
  assert.throws(
    () => normalizeProject({ repo: "tyler/a", harness: "cluade-code", autoMerge: false, autoDeploy: false }),
    /unknown harness "cluade-code"/,
  );
});

test("project record: harness survives a store round trip", async () => {
  const store = new FileProjectStore(await tempDir());
  await store.set({ repo: TS_URL, url: TS_URL, harness: "claude-code", autoMerge: false, autoDeploy: false });
  assert.equal((await store.forRepo(TS_URL))?.harness, "claude-code");
});

// --- D5 / L5 + P1-4 / L4: the unattended flags reach the run input ----------

/** Capture-only runtime: enqueueRun touches store.append, saveMeta and kind. */
function captureEnqueue(projects: ProjectStore): { runtime: ShipRuntime; inputs: Array<Record<string, unknown>> } {
  const inputs: Array<Record<string, unknown>> = [];
  const runtime = {
    kind: "file",
    evidence: { forRepo: async () => null },
    projects,
    governance: { get: async () => ({ authority: {}, windows: {}, reviewers: [] }) },
    store: {
      append: async (_runId: string, event: { type: string; data?: { input?: Record<string, unknown> } }) => {
        if (event.type === "run-started") inputs.push(event.data!.input!);
      },
    },
    saveMeta: async () => {},
  } as unknown as ShipRuntime;
  return { runtime, inputs };
}

const AUTO_ENV = ["SHIP_CHANGE_CLASS", "SHIP_AUTO_MERGE", "SHIP_ROLLBACK", "SHIP_PREVIEW", "SHIP_TELEMETRY", "SHIP_TESTS"] as const;
function clearAutoEnv(): void {
  for (const k of AUTO_ENV) delete process.env[k];
}

test("D5: autoMerge reaches the run input only for a repo that asked for it, with the class gate on", async () => {
  clearAutoEnv();
  const dir = await mkdtemp(join(tmpdir(), "ship-projects-automerge-"));
  const projects = new FileProjectStore(dir);
  await projects.set({ repo: "tyler/on", url: "https://git.example.com/tyler/on", autoMerge: true, autoDeploy: false });
  await projects.set({ repo: "tyler/off", url: "https://git.example.com/tyler/off", autoMerge: false, autoDeploy: false });
  const { runtime, inputs } = captureEnqueue(projects);

  // Without the change-class gate there is no `trivial` verdict to merge on,
  // so the flag would be a silent no-op — it is not recorded at all.
  await enqueueRun(runtime, { runId: "r1", task: "t", model: "m", repo: "https://git.example.com/tyler/on" });
  assert.equal(inputs[0]!.autoMerge, undefined, "no class gate, no merge authority");

  process.env.SHIP_CHANGE_CLASS = "1";
  await enqueueRun(runtime, { runId: "r2", task: "t", model: "m", repo: "https://git.example.com/tyler/on" });
  await enqueueRun(runtime, { runId: "r3", task: "t", model: "m", repo: "https://git.example.com/tyler/off" });
  await enqueueRun(runtime, { runId: "r4", task: "t", model: "m", repo: "https://git.example.com/tyler/unknown" });
  assert.equal(inputs[1]!.autoMerge, true);
  assert.equal(inputs[2]!.autoMerge, undefined, "off by default, per repo");
  assert.equal(inputs[3]!.autoMerge, undefined, "a repo with no record is off");

  // A scan changes nothing, so it can merge nothing.
  await enqueueRun(runtime, { runId: "r5", task: "t", model: "m", repo: "https://git.example.com/tyler/on", mode: "scan" });
  assert.equal(inputs[4]!.autoMerge, undefined);

  // The 3am switch: one env var turns it off everywhere without a per-repo edit.
  process.env.SHIP_AUTO_MERGE = "0";
  await enqueueRun(runtime, { runId: "r6", task: "t", model: "m", repo: "https://git.example.com/tyler/on" });
  assert.equal(inputs[5]!.autoMerge, undefined, "SHIP_AUTO_MERGE=0 is a deployment-wide kill switch");
  clearAutoEnv();
});

test("P1-4: the rollback WATCH follows preview+telemetry; the authority to ACT is per repo", async () => {
  clearAutoEnv();
  const dir = await mkdtemp(join(tmpdir(), "ship-projects-rollback-"));
  const projects = new FileProjectStore(dir);
  await projects.set({ repo: "tyler/deploys", url: "https://git.example.com/tyler/deploys", autoMerge: false, autoDeploy: true });
  await projects.set({ repo: "tyler/watches", url: "https://git.example.com/tyler/watches", autoMerge: false, autoDeploy: false });
  const { runtime, inputs } = captureEnqueue(projects);

  // Neither leg on: nothing to judge, so no watch.
  await enqueueRun(runtime, { runId: "r1", task: "t", model: "m", repo: "https://git.example.com/tyler/deploys" });
  assert.equal(inputs[0]!.rollback, undefined);
  assert.equal(inputs[0]!.autoDeploy, undefined, "the authority is never recorded without the watch");

  process.env.SHIP_PREVIEW = "1";
  process.env.SHIP_TELEMETRY = "1";
  await enqueueRun(runtime, { runId: "r2", task: "t", model: "m", repo: "https://git.example.com/tyler/watches" });
  await enqueueRun(runtime, { runId: "r3", task: "t", model: "m", repo: "https://git.example.com/tyler/deploys" });
  assert.equal(inputs[1]!.rollback, true, "watching is free and on by default where it can happen");
  assert.equal(inputs[1]!.autoDeploy, undefined, "but acting is not");
  assert.equal(inputs[2]!.rollback, true);
  assert.equal(inputs[2]!.autoDeploy, true);

  process.env.SHIP_ROLLBACK = "0";
  await enqueueRun(runtime, { runId: "r4", task: "t", model: "m", repo: "https://git.example.com/tyler/deploys" });
  assert.equal(inputs[3]!.rollback, undefined);
  assert.equal(inputs[3]!.autoDeploy, undefined, "no watch, no authority — even for a repo that granted it");
  clearAutoEnv();
});

// --- C4 / contract 1: the verification ladder and authority on the record ----

test("C4: the ladder is stored, validated, and one home with the tests command", async () => {
  const dir = await tempDir();
  const store = new FileProjectStore(dir);
  await store.set({
    repo: TS_URL,
    autoMerge: false,
    autoDeploy: false,
    verification: { build: " pnpm build ", tests: undefined, preview: { app: "site", smoke: "curl -fsS $PREVIEW_URL/" }, visual: true, observeWindowMin: 5 },
  });
  const p = (await store.forRepo("tyler/ship-ts"))!;
  assert.deepEqual(p.verification, { build: "pnpm build", preview: { app: "site", smoke: "curl -fsS $PREVIEW_URL/" }, visual: true, observeWindowMin: 5 });
  assert.equal(p.testCommand, undefined, "an undeclared tests rung leaves the legacy field alone");

  // Declaring verification.tests IS the test command: one fact, both spellings.
  await store.set({ ...p, verification: { ...p.verification!, tests: "pnpm test" } });
  const folded = (await store.forRepo("tyler/ship-ts"))!;
  assert.equal(folded.verification?.tests, "pnpm test");
  assert.equal(folded.testCommand, "pnpm test");
  // And the evidence view reads through either spelling.
  const legacy = new FileEvidenceStore(dir);
  const evidence = new ProjectEvidenceStore(store, legacy);
  assert.equal((await evidence.forRepo(TS_URL))?.testCommand, "pnpm test");

  // evidence remove strips EVERY spelling of the tests command and keeps the rest of the ladder.
  await evidence.remove(TS_URL);
  const stripped = (await store.forRepo("tyler/ship-ts"))!;
  assert.equal(stripped.testCommand, undefined);
  assert.equal(stripped.verification?.tests, undefined);
  assert.equal(stripped.verification?.preview?.app, "site", "the rest of the ladder survives an evidence edit");

  // Half a preview and a bad window refuse the save at the store door.
  assert.throws(
    () => normalizeProject({ repo: "a/b", autoMerge: false, autoDeploy: false, verification: { preview: { app: "x", smoke: "" } } }),
    /both app and smoke/,
  );
  assert.throws(
    () => normalizeProject({ repo: "a/b", autoMerge: false, autoDeploy: false, verification: { observeWindowMin: 1.5 } }),
    /whole number of minutes/,
  );
});

test("C4: authority and neverAuto are validated and stored", async () => {
  assert.throws(
    () => normalizeProject({ repo: "a/b", autoMerge: false, autoDeploy: false, authority: "auto" as never }),
    /one of propose, send, auto_trivial, auto_normal/,
  );
  const dir = await tempDir();
  const store = new FileProjectStore(dir);
  await store.set({ repo: TS_URL, autoMerge: false, autoDeploy: false, authority: "auto_trivial", neverAuto: true });
  const p = (await store.forRepo("tyler/ship-ts"))!;
  assert.equal(p.authority, "auto_trivial");
  assert.equal(p.neverAuto, true);
});

test("C4: enqueue materialises the declaration and the ladder-capped authority; a bare autoMerge keeps the legacy gate", async () => {
  const envKeys = ["SHIP_CHANGE_CLASS", "SHIP_AUTO_MERGE"] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of envKeys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    const dir = await tempDir();
    const projects = new FileProjectStore(dir);
    await projects.set({
      repo: "tyler/laddered",
      url: "https://git.example.com/tyler/laddered",
      autoMerge: true,
      autoDeploy: false,
      verification: { tests: "pnpm test", preview: { app: "site", smoke: "true" }, visual: true, observeWindowMin: 5 },
      authority: "auto_normal",
    });
    await projects.set({
      repo: "tyler/capped",
      url: "https://git.example.com/tyler/capped",
      autoMerge: true,
      autoDeploy: false,
      verification: { tests: "pnpm test" },
      authority: "auto_normal",
    });
    await projects.set({ repo: "tyler/legacy", url: "https://git.example.com/tyler/legacy", autoMerge: true, autoDeploy: false });
    const { runtime, inputs } = captureEnqueue(projects);
    process.env.SHIP_CHANGE_CLASS = "1";

    await enqueueRun(runtime, { runId: "l1", task: "t", model: "m", repo: "https://git.example.com/tyler/laddered" });
    assert.deepEqual(inputs[0]!.verification, { tests: "pnpm test", preview: { app: "site", smoke: "true" }, visual: true, observeWindowMin: 5 });
    assert.equal(inputs[0]!.authority, "auto_normal");
    assert.equal(inputs[0]!.autoMerge, true);
    assert.equal(inputs[0]!.preview, true, "a declared preview rung is the ask");

    await enqueueRun(runtime, { runId: "l2", task: "t", model: "m", repo: "https://git.example.com/tyler/capped" });
    assert.equal(inputs[1]!.authority, "send", "tests without a preview caps the authority at send");
    assert.equal(inputs[1]!.autoMerge, undefined, "and a capped repo never carries merge authority");

    await enqueueRun(runtime, { runId: "l3", task: "t", model: "m", repo: "https://git.example.com/tyler/legacy" });
    assert.equal(inputs[2]!.authority, undefined, "nothing declared: no authority is materialised");
    assert.equal(inputs[2]!.autoMerge, true, "the legacy flag keeps the legacy gate, verbatim");
  } finally {
    for (const k of envKeys) process.env[k] = saved[k];
  }
});
