import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { ModelAdapter } from "@neutron-build/ai";
import type { AgentExecutor } from "@neutron-build/agents";
import { MemoryEventStore, executeRun } from "@neutron-build/workflow";
import type { WorkflowEvent } from "@neutron-build/workflow";

import { durableAgent } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import { defaultApprovalPolicy } from "./approval.js";
import { FileRepoMemory } from "./repo-memory.js";
import { HARNESS_PACKAGES, HARNESS_VERSIONS, NATIVE_HARNESS_ID, harnessAttempts, harnessRef, harnessSpecs, selectAdapter } from "./harness.js";
import type { HarnessAdapter } from "./harness.js";

/**
 * The P5-1 fence. These fixtures were RECORDED by the pre-adapter durable
 * loop (2026-08-24, before `nativeAdapter` existed) and are replayed here
 * through the adapter path with a model that throws if called and an executor
 * that throws if used. If the extraction had changed a single step name,
 * added a step, or dropped one, the replay would either invoke the model /
 * executor (throw) or leave recorded steps unconsumed (NondeterminismError).
 * The recorded output must also come back byte-identical.
 *
 * Do not regenerate these fixtures from the current code: their value is that
 * they were written by the code before the boundary moved.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "fixtures");

async function loadFixture(name: string): Promise<{ runId: string; events: WorkflowEvent[] }> {
  return JSON.parse(await readFile(join(FIXTURES, `${name}.json`), "utf8")) as { runId: string; events: WorkflowEvent[] };
}

const throwingModel: ModelAdapter = {
  provider: "fence",
  modelId: "fence",
  async doGenerate() {
    throw new Error("the model must never be called on a replay");
  },
  async *doStream() {
    throw new Error("unused");
  },
};

function throwingExecutor(): AgentExecutor {
  const refuse = (): never => {
    throw new Error("the executor must never be used on a replay");
  };
  return { exec: refuse, putFile: refuse, getFile: refuse, destroy: async () => {} };
}

const throwingProvider: ExecutorProvider = {
  async create() {
    throw new Error("no new sandbox may be created on a replay");
  },
  attach() {
    return throwingExecutor();
  },
};

async function replayFixture(name: string): Promise<void> {
  const fixture = await loadFixture(name);
  const recordedSteps = fixture.events.filter((e) => e.type === "step-completed").map((e) => e.name);
  const recordedOutput = (fixture.events.find((e) => e.type === "run-completed")?.data as { output: unknown }).output;
  assert.ok(recordedSteps.length > 10, "fixture carries a real step sequence");

  // Strip the terminal event so the replay walks the workflow rather than
  // short-circuiting on "already completed".
  const store = new MemoryEventStore();
  for (const event of fixture.events) {
    if (event.type === "run-completed") continue;
    await store.append(fixture.runId, event);
  }
  const memDir = await mkdtemp(join(tmpdir(), "harness-fence-mem-"));
  const wf = durableAgent({
    model: throwingModel,
    executor: throwingProvider,
    workdir: ".",
    approveAction: defaultApprovalPolicy,
    repoMemory: new FileRepoMemory(memDir),
  });
  const input = (fixture.events.find((e) => e.type === "run-started")?.data as { input: { task: string } }).input;
  const outcome = await executeRun({ workflow: wf, runId: fixture.runId, store, input });
  assert.equal(outcome.status, "completed", `replay of ${name} must complete: ${JSON.stringify(outcome)}`);
  assert.deepEqual(outcome.output, recordedOutput, "the replayed output must equal the recorded output");
  const replayedSteps = (await store.load(fixture.runId)).filter((e) => e.type === "step-completed").map((e) => e.name);
  assert.deepEqual(replayedSteps, recordedSteps, "the step sequence must be unchanged");
}

test("P5-1 fence: a pre-adapter workspace run (steer/index/critic/requireEdit/recovery/settle) replays through the adapter path unchanged", async () => {
  await replayFixture("fx-workspace");
});

test("P5-1 fence: a pre-adapter repo run (guard/tests/push/PR/verification/memory) replays through the adapter path unchanged", async () => {
  await replayFixture("fx-repo");
});

test("harnessRef defaults to native and refuses unknown ids", () => {
  assert.deepEqual(harnessRef(undefined), { id: NATIVE_HARNESS_ID, version: HARNESS_VERSIONS[NATIVE_HARNESS_ID] });
  assert.deepEqual(harnessRef(""), { id: NATIVE_HARNESS_ID, version: HARNESS_VERSIONS[NATIVE_HARNESS_ID] });
  assert.equal(harnessRef("claude-code").id, "claude-code");
  assert.throws(() => harnessRef("devin"), /unknown harness "devin"/);
});

test("harnessAttempts needs two distinct ids to mean anything", () => {
  assert.deepEqual(harnessAttempts(undefined), []);
  assert.deepEqual(harnessAttempts("native"), []);
  assert.equal(harnessAttempts("native, claude-code").length, 2);
  assert.throws(() => harnessAttempts("native,native"), /twice/);
});

test("selectAdapter refuses a missing adapter and a version the log did not record", () => {
  const fake = (id: string, version: string): HarnessAdapter => ({
    id,
    version,
    isolated: true,
    async run() {
      throw new Error("unused");
    },
  });
  const native = fake(NATIVE_HARNESS_ID, "1");
  assert.equal(selectAdapter([native], undefined), native);
  assert.equal(selectAdapter([native, fake("opencode", "1")], { id: "opencode", version: "1" }).id, "opencode");
  assert.throws(() => selectAdapter([native], { id: "opencode", version: "1" }), /no such adapter/);
  assert.throws(() => selectAdapter([native, fake("opencode", "2")], { id: "opencode", version: "1" }), /refuses to replay/);
});

test("a run enqueued for a harness the worker lacks fails before a sandbox is allocated", async () => {
  let created = 0;
  const provider: ExecutorProvider = {
    async create() {
      created += 1;
      return { handle: "x" };
    },
    attach: () => throwingExecutor(),
  };
  const wf = durableAgent({ model: throwingModel, executor: provider });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-missing-harness",
    store,
    input: { task: "x", harness: { id: "opencode", version: "1" } },
  });
  assert.equal(outcome.status, "failed");
  assert.equal(created, 0, "no sandbox for a run that cannot execute here");
});

/**
 * B5: the sandbox images bake the harness binaries, and images/build.sh reads
 * images/versions.json to know which. HARNESS_PACKAGES is the copy the
 * TypeScript can reach at run time (harness-external.ts uses it to tell an
 * operator what to build). Two copies need a test that fails when they drift,
 * or "pinned" is a word rather than a property.
 */
test("HARNESS_PACKAGES matches images/versions.json and covers every external adapter", async () => {
  const raw = await readFile(new URL("../images/versions.json", import.meta.url), "utf8");
  const versions = JSON.parse(raw) as { harnesses: Record<string, { npm: string; version: string; binary: string }> };
  const declared = Object.fromEntries(Object.entries(versions.harnesses).filter(([k]) => !k.startsWith("$")));

  assert.deepEqual(HARNESS_PACKAGES, declared);

  for (const [id, pkg] of Object.entries(HARNESS_PACKAGES)) {
    // An id with no adapter is a binary nothing can drive.
    assert.ok(HARNESS_VERSIONS[id] !== undefined, `${id} has a package but no adapter`);
    // Exact, never a range: selectAdapter refuses to replay under a different
    // program, so "^2" in an image build is a replay bug waiting to happen.
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/, `${id} version must be exact`);
  }
  // native is the one adapter that needs nothing installed.
  assert.equal(HARNESS_PACKAGES[NATIVE_HARNESS_ID], undefined);
  assert.deepEqual(harnessSpecs(["claude-code", NATIVE_HARNESS_ID]), [
    `${HARNESS_PACKAGES["claude-code"]!.npm}@${HARNESS_PACKAGES["claude-code"]!.version}`,
  ]);

  // The dashboard is SSR'd from source and cannot import these values without
  // pulling the runtime package into a route, so it names them. Named copies
  // rot; this is the check that stops them.
  const settings = await readFile(new URL("../web/src/routes/settings.tsx", import.meta.url), "utf8");
  for (const [id, pkg] of Object.entries(HARNESS_PACKAGES)) {
    assert.ok(settings.includes(`${id} ${pkg.version}`), `Settings page does not name ${id} ${pkg.version}`);
  }
  const projects = await readFile(new URL("../web/src/routes/projects.tsx", import.meta.url), "utf8");
  const offered = /const HARNESSES = \[([^\]]*)\]/.exec(projects)?.[1] ?? "";
  for (const id of Object.keys(HARNESS_VERSIONS)) {
    assert.ok(offered.includes(`"${id}"`), `Projects page does not offer harness ${id}`);
  }
});

test("the Go sandbox Dockerfile pins Go 1.25, not 1.24", async () => {
  // 2026-08-26: three repos need 1.25, and on a 1.24 sandbox every Go pull
  // request arrived marked `tests: failed`. A future tidy-up that pins this
  // back re-creates a day of misread pull requests, so it fails here instead.
  const raw = await readFile(new URL("../images/versions.json", import.meta.url), "utf8");
  const versions = JSON.parse(raw) as { bases: Record<string, string> };
  assert.match(versions.bases.go!, /^golang:1\.25\./);
  const dockerfile = await readFile(new URL("../images/sandbox-go/Dockerfile", import.meta.url), "utf8");
  assert.ok(dockerfile.includes(`ARG GO_BASE=${versions.bases.go}`), "sandbox-go Dockerfile default drifted from versions.json");
});
