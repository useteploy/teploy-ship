import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileEvidenceStore, lookupRepoForObserveService, repoForObserveService } from "./evidence.js";
import type { EvidenceStore } from "./evidence.js";
import { repoSlug, effectiveTelemetryTarget } from "./observe.js";
import { testTargetFromInput, testTargetFromEnv } from "./tests.js";
import { enqueueRun } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";

const STORE_URL = "https://git.example.com/tyler/teploy-ship.git";

async function tempStore(): Promise<{ store: FileEvidenceStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ship-evidence-"));
  return { store: new FileEvidenceStore(dir), dir };
}

/** Capture-only runtime: enqueueRun touches store.append, saveMeta and kind. */
function captureRuntime(evidence: EvidenceStore): { runtime: ShipRuntime; inputs: Array<Record<string, unknown>> } {
  const inputs: Array<Record<string, unknown>> = [];
  const runtime = {
    kind: "file",
    evidence,
    projects: { forRepo: async () => null },
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

test("repoSlug: https, ssh, bare slug and .git variants all agree", () => {
  assert.equal(repoSlug(STORE_URL), "tyler/teploy-ship");
  assert.equal(repoSlug("git@git.example.com:tyler/teploy-ship"), "tyler/teploy-ship");
  assert.equal(repoSlug("tyler/teploy-ship"), "tyler/teploy-ship");
  assert.equal(repoSlug("https://git.example.com/Tyler/Teploy-Ship.git/"), "tyler/teploy-ship");
  assert.equal(repoSlug("teploy-ship"), null, "no owner/name shape is not a repo key");
});

test("evidence store: set is keyed by slug, so any URL form finds the entry", async () => {
  const { store } = await tempStore();
  await store.set({ repo: STORE_URL, testCommand: "pnpm test" });

  const byUrl = await store.forRepo("https://git.example.com/tyler/teploy-ship");
  const bySlug = await store.forRepo("tyler/teploy-ship");
  const bySsh = await store.forRepo("git@git.example.com:tyler/teploy-ship");
  assert.deepEqual(byUrl, { repo: "tyler/teploy-ship", testCommand: "pnpm test" });
  assert.deepEqual(bySlug, byUrl);
  assert.deepEqual(bySsh, byUrl);

  assert.equal(await store.forRepo("tyler/someone-else"), null, "an unconfigured repo finds nothing");
});

test("evidence store: set is a full upsert — an omitted flag clears its field", async () => {
  const { store } = await tempStore();
  await store.set({ repo: "tyler/a", testCommand: "go test ./...", observeService: "a-svc" });
  await store.set({ repo: "tyler/a", testCommand: "go test ./..." });

  const entry = await store.forRepo("tyler/a");
  assert.deepEqual(entry, { repo: "tyler/a", testCommand: "go test ./..." }, "observeService was cleared, not merged");
});

test("evidence store: remove deletes only the named entry", async () => {
  const { store } = await tempStore();
  await store.set({ repo: "tyler/a", testCommand: "pnpm test" });
  await store.set({ repo: "tyler/b", testCommand: "go test ./..." });
  await store.remove("https://git.example.com/tyler/a.git");

  assert.equal(await store.forRepo("tyler/a"), null);
  assert.notEqual(await store.forRepo("tyler/b"), null);
});

test("evidence store: a damaged file throws rather than reading back empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-evidence-"));
  await writeFile(join(dir, "evidence.json"), "{not json", "utf8");
  const store = new FileEvidenceStore(dir);
  await assert.rejects(() => store.forRepo("tyler/a"), "silently empty config would restore one-command-per-worker");
});

test("enqueueRun materialises per-repo evidence into the recorded input, and the config is the ask", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-evidence-"));
  const evidence = new FileEvidenceStore(dir);
  // Two repos, two different suites and services — one worker's worth of config.
  await evidence.set({ repo: "https://git.example.com/tyler/go-repo", testCommand: "go test ./...", observeService: "go-svc" });
  await evidence.set({ repo: "https://git.example.com/tyler/ts-repo", testCommand: "pnpm test", testTimeoutMs: 120000 });
  const { runtime, inputs } = captureRuntime(evidence);

  // SHIP_TESTS/SHIP_TELEMETRY deliberately UNSET: the per-repo config alone
  // must turn both legs on. That is the "works on your repos" property.
  delete process.env.SHIP_TESTS;
  delete process.env.SHIP_TELEMETRY;
  await enqueueRun(runtime, { runId: "run-e1", task: "t", model: "m", repo: "https://git.example.com/tyler/go-repo" });
  await enqueueRun(runtime, { runId: "run-e2", task: "t", model: "m", repo: "https://git.example.com/tyler/ts-repo" });
  await enqueueRun(runtime, { runId: "run-e3", task: "t", model: "m", repo: "https://git.example.com/tyler/unconfigured" });

  const go = inputs[0]!;
  assert.equal(go.tests, true, "a configured testCommand asks for the suite");
  assert.equal(go.testCommand, "go test ./...");
  assert.equal(go.telemetry, true, "a configured observeService asks for telemetry");
  assert.equal(go.observeService, "go-svc");
  assert.equal(go.observeRepo, "tyler/go-repo", "the evidence key names the repo the service is built from");

  const ts = inputs[1]!;
  assert.equal(ts.testCommand, "pnpm test", "the second repo carries ITS command, not the worker's");
  assert.equal(ts.testTimeoutMs, 120000);
  assert.equal(ts.observeService, undefined, "no service configured for this repo");
  assert.equal(ts.telemetry, undefined, "so no telemetry ask");

  const unconfigured = inputs[2]!;
  assert.equal(unconfigured.tests, undefined);
  assert.equal(unconfigured.testCommand, undefined);
  assert.equal(unconfigured.telemetry, undefined);
});

test("enqueueRun: an explicit opt-out beats the evidence config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-evidence-"));
  const evidence = new FileEvidenceStore(dir);
  await evidence.set({ repo: "tyler/a", testCommand: "pnpm test" });
  const { runtime, inputs } = captureRuntime(evidence);

  await enqueueRun(runtime, { runId: "run-e4", task: "t", model: "m", repo: "tyler/a", tests: false });
  assert.equal(inputs[0]!.tests, undefined, "an explicit opt-out wins");
  // The command is still recorded: the run replayed under a changed decision
  // would describe WHICH suite it declined, not just that it declined.
  assert.equal(inputs[0]!.testCommand, "pnpm test");
});

test("enqueueRun materialises the iterate-until-green bound and the advisory critic (L8 S-B)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-evidence-"));
  const evidence = new FileEvidenceStore(dir);
  await evidence.set({ repo: "tyler/a", testCommand: "pnpm test" });
  const { runtime, inputs } = captureRuntime(evidence);

  // The bound rides the finish gate: default 2 where testsFeedback is on,
  // absent where it is not, and an explicit value or SHIP_FIX_RETRIES wins.
  delete process.env.SHIP_FIX_RETRIES;
  delete process.env.SHIP_CRITIC_ADVISORY;
  await enqueueRun(runtime, { runId: "run-k1", task: "t", model: "m", repo: "tyler/a" });
  await enqueueRun(runtime, { runId: "run-k2", task: "t", model: "m", repo: "tyler/a", testsFeedback: false });
  await enqueueRun(runtime, { runId: "run-k3", task: "t", model: "m", repo: "tyler/a", fixRetries: 0 });
  process.env.SHIP_FIX_RETRIES = "5";
  await enqueueRun(runtime, { runId: "run-k4", task: "t", model: "m", repo: "tyler/a" });
  process.env.SHIP_FIX_RETRIES = "garbage";
  await enqueueRun(runtime, { runId: "run-k5", task: "t", model: "m", repo: "tyler/a" });
  delete process.env.SHIP_FIX_RETRIES;

  assert.equal(inputs[0]!.fixRetries, 2, "the default bound is the historical two, now explicit in the log");
  assert.equal(inputs[1]!.fixRetries, undefined, "no bound without the finish gate it bounds");
  assert.equal(inputs[2]!.fixRetries, 0, "an explicit zero is a real answer: record, never retry");
  assert.equal(inputs[3]!.fixRetries, 5, "the env knob reaches the log, so a replay keeps the bound it ran under");
  assert.equal(inputs[4]!.fixRetries, 2, "a misread env never silently becomes zero");

  // The critic advises wherever a suite is recorded; without one the old
  // bounded retry stands, and SHIP_CRITIC_ADVISORY=0 restores the veto.
  await enqueueRun(runtime, { runId: "run-c1", task: "t", model: "m", repo: "tyler/a", critic: true });
  await enqueueRun(runtime, { runId: "run-c2", task: "t", model: "m", critic: true });
  process.env.SHIP_CRITIC_ADVISORY = "0";
  await enqueueRun(runtime, { runId: "run-c3", task: "t", model: "m", repo: "tyler/a", critic: true });
  delete process.env.SHIP_CRITIC_ADVISORY;

  assert.equal(inputs[5]!.criticAdvisory, true, "critic + suite: the review advises, the suite is the boundary");
  assert.equal(inputs[6]!.criticAdvisory, undefined, "critic without a suite keeps the retry as its only check");
  assert.equal(inputs[7]!.criticAdvisory, undefined, "the off-switch restores the veto");
});

test("testTargetFromInput outranks the worker env default, and absent input falls back cleanly", () => {
  assert.deepEqual(testTargetFromInput({ testCommand: "pnpm test", testTimeoutMs: 5000 }), { command: "pnpm test", timeoutMs: 5000 });
  assert.equal(testTargetFromInput({}), undefined);
  assert.equal(testTargetFromInput({ testCommand: "  " }), undefined, "blank is absent");
  const env = testTargetFromEnv({ SHIP_TEST_COMMAND: "go test ./..." });
  assert.deepEqual(env, { command: "go test ./..." });
});

test("effectiveTelemetryTarget: per-repo service/repo replace the worker's; the credential never comes from the input", () => {
  const config = { url: "https://observe", token: "share-tok", service: "fylun-web", repo: "tyler/fylun" };
  const perRepo = effectiveTelemetryTarget(config, { observeService: "go-svc", observeRepo: "tyler/go-repo" });
  assert.deepEqual(perRepo, { url: "https://observe", token: "share-tok", service: "go-svc", repo: "tyler/go-repo" });
  // No per-repo service: the worker default stands.
  assert.deepEqual(effectiveTelemetryTarget(config, {}), config);
  // Unwired worker: nothing the input can do about it — the share token is
  // host wiring, and a run input must never carry a credential.
  assert.equal(effectiveTelemetryTarget(undefined, { observeService: "go-svc", observeRepo: "tyler/go-repo" }), undefined);
});

test("evidence.json roundtrips through the file the CLI edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-evidence-"));
  const store = new FileEvidenceStore(dir);
  await store.set({ repo: "tyler/a", testCommand: "pnpm test", testTimeoutMs: 90000, observeService: "a" });
  const raw = JSON.parse(await readFile(join(dir, "evidence.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(raw["tyler/a"], { testCommand: "pnpm test", testTimeoutMs: 90000, observeService: "a" });
});

// --- P1-5: the observeService reverse lookup ---------------------------------

const ENTRIES = [
  { repo: "tyler/api", observeService: "fylun-api" },
  { repo: "tyler/web", observeService: "Fylun-Web" },
  { repo: "tyler/docs", testCommand: "pnpm test" },
];

test("repoForObserveService maps a service back to its repo, case- and space-insensitively", () => {
  assert.equal(repoForObserveService(ENTRIES, "fylun-api"), "tyler/api");
  assert.equal(repoForObserveService(ENTRIES, "  FYLUN-WEB "), "tyler/web");
  assert.equal(repoForObserveService(ENTRIES, "nothing"), null);
  assert.equal(repoForObserveService(ENTRIES, ""), null, "an alert with no service binds no repo");
  assert.equal(repoForObserveService([], "fylun-api"), null);
});

test("an ambiguous observeService binds NO repo rather than guessing one", () => {
  // Two repos claiming one service is a configuration mistake. Picking either
  // opens an incident against a repository that is not the one that broke —
  // strictly worse than an unbound proposal a human binds in the inbox.
  const dupes = [
    { repo: "tyler/api", observeService: "shared" },
    { repo: "tyler/worker", observeService: "shared" },
  ];
  assert.equal(repoForObserveService(dupes, "shared"), null);
});

test("lookupRepoForObserveService reads the reverse lookup off a live store", async () => {
  const { store } = await tempStore();
  await store.set({ repo: STORE_URL, testCommand: "pnpm test", observeService: "ship-web" });
  await store.set({ repo: "https://git.example.com/tyler/other.git", testCommand: "go test ./..." });
  assert.equal(await lookupRepoForObserveService(store, "ship-web"), "tyler/teploy-ship");
  assert.equal(await lookupRepoForObserveService(store, "ship-worker"), null);
  assert.equal(await lookupRepoForObserveService(store, ""), null);
});
