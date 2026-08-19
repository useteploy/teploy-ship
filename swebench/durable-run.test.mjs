// Seam tests for the durable SWE-bench arm.
//
// Three of these bite, verified both ways on 2026-08-18:
//   1. swap runDurable's `approveAction: autoApprove` for the
//      `defaultApprovalPolicy` the CLI and worker use — "match the product",
//      the tempting change — and the first test FAILS. (Note what does NOT
//      break it: deleting the option entirely. durable.ts reads
//      `config.approveAction ? ... : "auto"`, so an absent policy auto-runs.
//      The hazard is a policy that parks, not a missing one.)
//   2. make provenance() report the same model name for both loops and the
//      second fails.
//   3. drop a field the product's own enqueueRun puts in a run input and the
//      third fails naming the key.
// The rest are the cheap invariants.
//
// No container and no network — everything here runs against MemoryEventStore
// and a scripted model, the same way durable.test.ts does.
//
// Run: node --test swebench/

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DIST_REQUIREMENTS,
  LOOP_DRIVERS,
  assertNoExistingLog,
  autoApprove,
  defaultApprovalPolicy,
  durableAgent,
  driveLoop,
  durableArmFromEnv,
  durableInput,
  executeRun,
  harnessProvider,
  runAgent,
  runDurable,
  provenance,
  statusOf,
  summarizeRun,
  teeStore,
} from "./durable-run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { LocalExecutor } = await import(join(here, "..", "node_modules", "@neutron-build", "agents", "dist", "index.js"));
const { MemoryEventStore } = await import(join(here, "..", "node_modules", "@neutron-build", "workflow", "dist", "index.js"));
const { enqueueRun } = await import(join(here, "..", "dist", "runtime.js"));

/** A model that plays a fixed script of assistant turns. */
function scriptedModel(turns) {
  let i = 0;
  return {
    provider: "scripted",
    modelId: "s1",
    async doGenerate() {
      const text = turns[i++] ?? "```finish\nout of script\n```";
      return { content: [{ type: "text", text }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
    },
    async *doStream() {
      throw new Error("unused");
    },
  };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "swebench-durable-"));
  return new LocalExecutor({ root });
}

// ---------------------------------------------------------------- seam 1

test("SEAM: a sweep never parks on approval — and the test can tell", async () => {
  // `rm -rf` is flagged "required" by defaultApprovalPolicy (approval.ts:15),
  // which is what the CLI (cli.ts:637) and the worker (worker.ts:275) both
  // pass. A benchmark has no operator to answer the park, so the harness passes
  // autoApprove instead. NOTE: the CLI does NOT avoid parking — it parks and
  // waits for `teploy-ship approve`. Do not "match the product" here.
  const script = [
    "```bash\nrm -rf /tmp/nothing-here\n```",
    "```finish\ndone\n```",
    "```bash\necho proof\n```",
    "```finish\ndone\n```",
  ];

  // Through runDurable — the function the harness actually calls — so deleting
  // `approveAction: autoApprove` from it fails HERE.
  const okStore = new MemoryEventStore();
  const ok = await runDurable({
    model: scriptedModel(script),
    executor: await workspace(),
    task: "t",
    workdir: ".",
    maxSteps: 8,
    actionTimeoutMs: 30000,
    input: durableInput({ task: "t", arm: "parity" }),
    runId: "auto",
    store: okStore,
  });
  assert.equal(ok.status, "finished", "autoApprove must carry the run to completion, not park it");
  assert.equal(ok.counts.parked, false);
  assert.ok(ok.counts.execs > 0, "the run must have executed something — a zero-exec run measured nothing");
  assert.ok(ok.usage.totalTokens > 0, "usage must be recorded, or a sweep's spend cap fails open");

  // The other half — without it this test passes with autoApprove deleted.
  const gated = durableAgent({
    model: scriptedModel(script),
    executor: harnessProvider(await workspace()),
    approveAction: defaultApprovalPolicy,
    workdir: ".",
    maxSteps: 8,
  });
  const parkedStore = new MemoryEventStore();
  const parked = await executeRun({ workflow: gated, runId: "gated", store: parkedStore, input: { task: "t" } });
  assert.equal(parked.status, "waiting", "the product's policy DOES park on this action — that is what autoApprove avoids");
  assert.equal(statusOf(parked), "parked");
  assert.equal(summarizeRun(await parkedStore.load("gated")).parked, true);
});

// ---------------------------------------------------------------- seam 2

test("SEAM: provenance cannot report one loop to the runlog and another to the scorer", () => {
  const live = provenance(false, "glm-5.3");
  const durable = provenance(true, "glm-5.3");

  assert.equal(live.loop, "live");
  assert.equal(durable.loop, "durable");
  assert.equal(live.modelName, "teploy-agent+glm-5.3");
  assert.ok(durable.modelName.includes("durable"), "a durable predictions file must say so in model_name_or_path");
  assert.notEqual(
    live.modelName,
    durable.modelName,
    "identical model names would let a durable predictions file be scored as the 35/50 live baseline",
  );
  // The harness must derive BOTH artifacts from this one call. If a future
  // edit computes the predictions name separately, this pairing is the thing
  // that stops the two drifting.
  for (const durableFlag of [false, true]) {
    const p = provenance(durableFlag, "m");
    assert.equal(p.modelName.includes("durable"), p.loop === "durable");
  }
});

// ---------------------------------------------------------------- seam 3

test("SEAM: the benchmark input does not drift from what the product enqueues", async () => {
  // Modelled on teploy-cli's deployconfig_wiring_test.go: compare the harness's
  // run input against the one the PRODUCT writes, with an exception list
  // carrying a reason per entry, and fail loudly rather than silently if the
  // shape can no longer be found.
  const dir = await mkdtemp(join(tmpdir(), "swebench-enqueue-"));
  const previous = process.env.TEPLOY_SHIP_STATE;
  process.env.TEPLOY_SHIP_STATE = dir;
  try {
    const { fileRuntime } = await import(join(here, "..", "dist", "runtime.js"));
    const runtime = fileRuntime();
    await enqueueRun(runtime, { runId: "enqueued-1", task: "t", model: "m", critic: true, settle: true });
    const started = (await runtime.store.load("enqueued-1")).find((e) => e.type === "run-started");
    assert.ok(started !== undefined, "no run-started event was written — enqueueRun's shape changed, this test is blind");
    const productKeys = Object.keys(started.data.input);
    assert.ok(productKeys.length > 0, "the product's run input is empty — this test is blind");

    const harnessKeys = new Set(
      Object.keys(durableInput({ task: "t", arm: "product", settle: true, critic: true, index: true, workspaceKey: "k" })),
    );
    // Keys the benchmark deliberately does not carry, each with its reason.
    const exceptions = new Map([
      ["repo", "a SWE-bench container cannot be a repo run — /testbed is pip-installed editable, so an agent editing a clone elsewhere is graded against the untouched original"],
      ["trust", "only meaningful with `repo`"],
      ["pr", "only meaningful with `repo`"],
      ["plan", "the plan preview PARKS the run, and a sweep has no operator"],
    ]);
    const missing = productKeys.filter((k) => !harnessKeys.has(k) && !exceptions.has(k));
    assert.deepEqual(missing, [], `the product enqueues these and the benchmark does not: ${missing.join(", ")}`);
  } finally {
    if (previous === undefined) delete process.env.TEPLOY_SHIP_STATE;
    else process.env.TEPLOY_SHIP_STATE = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- arms

test("the parity arm materializes recovery thresholds and holds a clean-tree finish", () => {
  const input = durableInput({ task: "t", arm: "parity" });
  // A bare `true` would break enqueueRun's contract (runtime.ts:433-449): the
  // thresholds decide which turn a run terminates on, so they must be IN the
  // log, not resolved from a code constant at execution time.
  assert.equal(typeof input.recovery, "object");
  assert.ok(Object.keys(input.recovery).length > 0, "the thresholds must be materialized, never a bare true");
  // Both of these are ON by default in runAgent (agent.ts:220 and :342), so
  // without them the durable arm would differ from the 35/50 baseline in more
  // ways than the loop and its delta would mean nothing.
  assert.equal(input.requireEdit, true);
  assert.equal(input.settle, undefined, "settle is its own knob, not part of the arm");
});

test("the product arm carries the product's enqueue defaults and neither parity forcing", () => {
  const input = durableInput({ task: "t", arm: "product" });
  assert.equal(input.recovery, undefined, "the product does not enable stuck detection by default");
  assert.equal(input.requireEdit, undefined, "the product does not hold a clean-tree finish by default");
  assert.deepEqual(
    { steer: input.steer, index: input.index, guard: input.guard },
    { steer: true, index: true, guard: true },
    "these three are unconditional in enqueueRun",
  );
});

test("SHIP_FINISH_WHEN_SETTLED reaches the input through the CLI's own mapping", () => {
  const off = durableInput({ task: "t", arm: "product" });
  assert.equal(off.settle, undefined);
  assert.equal(off.recovery, undefined);

  const on = durableInput({ task: "t", arm: "product", settle: true });
  assert.equal(on.settle, true);
  // settle is a branch of the stuck detector, so it must turn the tracker on —
  // durableRecoveryInput exists precisely because deleting that coupling left
  // `--settle` a silent no-op with the whole suite green.
  assert.equal(typeof on.recovery, "object", "settle must turn stuck detection on, with materialized thresholds");
});

test("critic, index and workspaceKey only appear when asked for", () => {
  const bare = durableInput({ task: "t", arm: "parity" });
  assert.equal(bare.critic, undefined);
  assert.equal(bare.index, undefined);
  assert.equal(bare.workspaceKey, undefined);

  const full = durableInput({ task: "t", arm: "parity", critic: true, index: true, workspaceKey: "inst-1" });
  assert.equal(full.critic, true);
  assert.equal(full.index, true);
  // The field that makes P0-2 possible: without it the critic and the code
  // index are both unreachable on a run with no repo checkout.
  assert.equal(full.workspaceKey, "inst-1");
});

test("SHIP_DURABLE is off by default and rejects a value it does not understand", () => {
  assert.equal(durableArmFromEnv({}), null, "the 35/50 baseline must stay reproducible with the variable unset");
  assert.equal(durableArmFromEnv({ SHIP_DURABLE: "" }), null);
  assert.equal(durableArmFromEnv({ SHIP_DURABLE: "0" }), null);
  assert.equal(durableArmFromEnv({ SHIP_DURABLE: "1" }), "parity");
  assert.equal(durableArmFromEnv({ SHIP_DURABLE: "parity" }), "parity");
  assert.equal(durableArmFromEnv({ SHIP_DURABLE: "product" }), "product");
  // A typo must not silently run the live loop and be published as the
  // product's number.
  assert.throws(() => durableArmFromEnv({ SHIP_DURABLE: "durable" }), /SHIP_DURABLE/);
});

// ---------------------------------------------------------------- counting

test("summarizeRun counts the loop's real work and reports a park", () => {
  const step = (name) => ({ type: "step-completed", name, data: { result: null } });
  const counts = summarizeRun([
    { type: "run-started" },
    step("sandbox"),
    step("repo-index"),
    step("turn-0-think"),
    step("turn-0-exec"),
    step("turn-1-think"),
    step("turn-1-search"),
    step("turn-2-think"),
    step("turn-2-critic-diff"),
    step("turn-2-critic"),
    step("turn-2-condense"),
    step("turn-3-fingerprint"),
    step("turn-3-finish-tree"),
    { type: "step-failed", name: "turn-4-exec" },
    { type: "event-waiting", name: "turn-4-approval" },
  ]);
  assert.equal(counts.thinks, 3);
  assert.equal(counts.execs, 1);
  assert.equal(counts.searches, 1);
  assert.equal(counts.criticDiffs, 1);
  // -critic-diff must not be counted as a -critic review; they are different
  // steps and only one of them is a model call.
  assert.equal(counts.criticRuns, 1);
  assert.equal(counts.condenses, 1);
  assert.equal(counts.fingerprints, 1);
  assert.equal(counts.treeChecks, 1);
  assert.equal(counts.failedSteps, 1);
  assert.equal(counts.parked, true);
});

test("summarizeRun surfaces the repo-index step's own account of itself", () => {
  // durable.ts catches index failures INSIDE the step and records the reason as
  // a string, so an index arm that indexed nothing looks identical to a healthy
  // one unless this is read back out of the log.
  const events = [{ type: "step-completed", name: "repo-index", data: { result: "index refresh failed: connection refused" } }];
  assert.match(summarizeRun(events).indexNote, /^index refresh failed/);
  assert.equal(summarizeRun([]).indexNote, undefined);
});

test("statusOf never lets a park or a failure read as a finish", () => {
  assert.equal(statusOf({ status: "completed", output: { status: "finished" } }), "finished");
  assert.equal(statusOf({ status: "completed", output: { status: "max-steps" } }), "max-steps");
  assert.equal(statusOf({ status: "completed", output: { status: "settled" } }), "settled");
  assert.equal(statusOf({ status: "completed", output: { status: "stuck" } }), "stuck");
  assert.equal(statusOf({ status: "waiting", eventName: "turn-3-approval" }), "parked");
  assert.equal(statusOf({ status: "failed", error: { detail: "boom" } }), "error");
  assert.equal(statusOf({ status: "cancelled" }), "cancelled");
});

// ---------------------------------------------------------------- provider

test("harnessProvider hands back the same container executor on every pass and owns no lifecycle", async () => {
  const executor = await workspace();
  const provider = harnessProvider(executor);
  const { handle } = await provider.create();
  assert.equal(provider.attach(handle), executor);
  assert.equal(provider.attach(handle), provider.attach(handle), "replay and resume must reattach, never re-create");
  // The container belongs to run-inference (container-executor.mjs says so of
  // destroy); dispose() no-ops without it, which is what we want here.
  assert.equal(provider.destroy, undefined);
  assert.equal(provider.snapshot, undefined);
  assert.equal(provider.createFrom, undefined);
});

test("teeStore mirrors steps to stderr without swallowing the append", async () => {
  // The durable path has no onEvent hook, so without this a sweep runs blind
  // and a stuck run looks exactly like a slow one for hours.
  const lines = [];
  const inner = new MemoryEventStore();
  const store = teeStore(inner, (l) => lines.push(l));
  await store.append("r", { v: 1, seq: 0, type: "run-started", at: "now" });
  await store.append("r", { v: 1, seq: 1, type: "step-completed", name: "turn-0-think", at: "now", data: { result: 1 } });
  assert.equal((await store.load("r")).length, 2, "every event must still reach the real store");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /turn-0-think/);
});

test("the durable knobs are covered by a stale-dist guard", () => {
  // Same job as MUTATING_METHODS in executor-snapshot.mjs: name the contract so
  // a symbol added to one side is not forgotten on the other.
  const symbols = DIST_REQUIREMENTS.map((r) => r.symbol);
  assert.ok(symbols.includes("durableAgent"), "SHIP_DURABLE against a build with no durableAgent must refuse to start");
  assert.ok(
    symbols.includes("workspaceKey"),
    "without workspaceKey the critic and the code index are unreachable on a repo-less run — a P0-2 sweep would silently run with neither",
  );
});

// ---------------------------------------------------------------- seam 5

// The harness's per-instance body used to choose the loop inline, in a file
// that opens an SSH connection at module scope and therefore cannot be
// imported. That made the two things this whole arm exists to guarantee — that
// the durable arm really drives durableAgent, and that every artifact says
// which loop ran — hold up by nothing but the current text of the file. Proved
// on 2026-08-18: renaming the call and deleting the provenance field left all
// 348 tests green. driveLoop is that dispatch, moved somewhere a test reaches.

/** A driver pair that records its calls instead of running a loop. */
function spyDrivers({ live, durable }) {
  const calls = [];
  return {
    calls,
    drivers: {
      async runAgent(args) {
        calls.push(["runAgent", args]);
        return live;
      },
      async runDurable(args) {
        calls.push(["runDurable", args]);
        return durable;
      },
    },
  };
}

const LIVE_RESULT = { status: "finished", steps: [{ action: { kind: "bash" } }, { action: { kind: "search" } }], usage: { totalTokens: 7 } };
const DURABLE_RESULT = {
  status: "finished",
  outcomeStatus: "completed",
  turns: 3,
  usage: { totalTokens: 9 },
  counts: { thinks: 3, execs: 2, parked: false, indexNote: "indexed 10 files" },
  events: [],
};

test("SEAM: the arm decides which loop runs, and no arm can produce an unlabelled row", async () => {
  const liveSpy = spyDrivers({ live: LIVE_RESULT, durable: DURABLE_RESULT });
  const liveRow = await driveLoop({
    arm: null,
    task: "t",
    settle: true,
    critic: true,
    codeSearch: () => [],
    drivers: liveSpy.drivers,
    log: () => {},
  });
  assert.deepEqual(liveSpy.calls.map(([name]) => name), ["runAgent"], "no arm must drive the LIVE loop");
  assert.equal(liveRow.loop, "live");
  assert.equal(liveRow.arm, null);
  assert.equal(liveRow.steps, 2, "live steps come from the step list");
  assert.equal(liveRow.usage.totalTokens, 7);
  assert.equal(liveRow.durable, undefined, "a live row must carry no durable fields");
  // The knobs must reach the loop, or an arm measures the baseline under
  // another name — the failure mode workspaceKey already caused once.
  const [, liveArgs] = liveSpy.calls[0];
  assert.equal(liveArgs.finishWhenSettled, true, "SHIP_FINISH_WHEN_SETTLED must reach runAgent");
  assert.equal(liveArgs.critic, true, "SHIP_CRITIC must reach runAgent");
  assert.ok(typeof liveArgs.codeSearch === "function");

  for (const arm of ["parity", "product"]) {
    const spy = spyDrivers({ live: LIVE_RESULT, durable: DURABLE_RESULT });
    const row = await driveLoop({
      arm,
      task: "t",
      critic: true,
      index: true,
      workspaceKey: "astropy__astropy-12907",
      runId: "astropy__astropy-12907",
      store: new MemoryEventStore(),
      drivers: spy.drivers,
      log: () => {},
    });
    assert.deepEqual(spy.calls.map(([name]) => name), ["runDurable"], `the ${arm} arm must drive the DURABLE loop`);
    assert.equal(row.loop, "durable");
    assert.equal(row.arm, arm);
    assert.equal(row.steps, 3, "durable steps come from the think count, not the step list");
    assert.equal(row.usage.totalTokens, 9);
    assert.equal(row.live, undefined, "a durable row must not carry a live result");
    const [, args] = spy.calls[0];
    assert.equal(args.runId, "astropy__astropy-12907");
    assert.deepEqual(args.input, durableInput({ task: "t", arm, critic: true, index: true, workspaceKey: "astropy__astropy-12907" }));
    assert.equal(args.input.workspaceKey, "astropy__astropy-12907", "without workspaceKey the critic and index are unreachable here");
    assert.equal(row.input, args.input, "the row records the VERBATIM input, so a sweep row can be reproduced");
  }
});

test("SEAM: driveLoop's defaults are the real loops, not whatever a caller injects", () => {
  // Every dispatch test above injects spies. Without this, driveLoop could
  // dispatch perfectly to two functions that are not the product.
  assert.equal(LOOP_DRIVERS.runAgent, runAgent, "the live arm must default to the real runAgent");
  assert.equal(LOOP_DRIVERS.runDurable, runDurable, "the durable arm must default to the real runDurable");
  assert.ok(Object.isFrozen(LOOP_DRIVERS));
});

test("a canary failure on the FIRST instance aborts the sweep rather than recording 50 rows of it", async () => {
  const parked = { ...DURABLE_RESULT, status: "parked", counts: { ...DURABLE_RESULT.counts, parked: true } };
  const call = (extra) =>
    driveLoop({
      arm: "parity",
      task: "t",
      runId: "i",
      store: new MemoryEventStore(),
      log: () => {},
      drivers: spyDrivers({ live: LIVE_RESULT, durable: parked }).drivers,
      ...extra,
    });
  await assert.rejects(() => call({ first: true }), /PARKED on the first instance/);
  // Later instances are RECORDED as parked, not thrown — a sweep that loses one
  // instance to a park still has 49 rows worth publishing.
  const later = await call({ first: false });
  assert.equal(later.status, "parked");

  // The index canary reads the note back out of the event log, because
  // durable.ts swallows an index failure inside the step.
  const noIndex = { ...DURABLE_RESULT, counts: { thinks: 1, execs: 1, parked: false } };
  const failed = { ...DURABLE_RESULT, counts: { ...DURABLE_RESULT.counts, indexNote: "index refresh failed: connect ECONNREFUSED" } };
  for (const durable of [noIndex, failed]) {
    await assert.rejects(
      () =>
        driveLoop({
          arm: "parity",
          task: "t",
          index: true,
          first: true,
          runId: "i",
          store: new MemoryEventStore(),
          log: () => {},
          drivers: spyDrivers({ live: LIVE_RESULT, durable }).drivers,
        }),
      /code index unusable on the first instance/,
    );
  }
  // An index arm that IS working must not abort.
  const fine = await driveLoop({
    arm: "parity",
    task: "t",
    index: true,
    first: true,
    runId: "i",
    store: new MemoryEventStore(),
    log: () => {},
    drivers: spyDrivers({ live: LIVE_RESULT, durable: DURABLE_RESULT }).drivers,
  });
  assert.equal(fine.status, "finished");
});

test("a second sweep to the same path is refused instead of replaying recorded outcomes as a fresh result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "swebench-events-"));
  try {
    assertNoExistingLog(dir, "astropy__astropy-12907");
    await writeFile(join(dir, "astropy__astropy-12907.events.jsonl"), "{}\n");
    assert.throws(
      () => assertNoExistingLog(dir, "astropy__astropy-12907"),
      /REPLAYS its log/,
      "executeRun replays a terminal log against a FRESH container — an empty patch reported as a completed run",
    );
    // Scoped to the instance, not the directory: a resumed sweep of the
    // remaining instances is legitimate.
    assertNoExistingLog(dir, "django__django-11099");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the harness consumes DIST_REQUIREMENTS rather than restating it", async () => {
  // The pairing this file previously CLAIMED in a comment and did not have.
  // Source text, not behaviour, because run-inference.mjs opens an SSH
  // connection at module scope; it is the honest cheap guard for the wiring
  // that has to stay inline, and it is deliberately narrow.
  const src = await readFile(join(here, "run-inference.mjs"), "utf8");
  assert.ok(src.includes("DIST_REQUIREMENTS.map("), "the guard must derive its durable rows from DIST_REQUIREMENTS");
  for (const r of DIST_REQUIREMENTS) {
    assert.equal(typeof r.when, "function", `${r.symbol} needs a "when" predicate — the flags that make it load-bearing`);
  }
  const flags = (durable, critic, index) => ({ durable, critic, index });
  const need = (f) => DIST_REQUIREMENTS.filter((r) => r.when(f)).map((r) => r.symbol);
  assert.deepEqual(need(flags(false, true, true)), [], "the live arm must not be blocked by a durable symbol");
  assert.deepEqual(need(flags(true, false, false)), ["durableAgent"]);
  assert.deepEqual(need(flags(true, true, false)), ["durableAgent", "workspaceKey"]);
  assert.deepEqual(need(flags(true, false, true)), ["durableAgent", "workspaceKey"]);
});

test("the harness's inline wiring still routes through the tested seams", async () => {
  // Narrow source-text assertions, and only for the lines that cannot move into
  // a testable module: the ones inside the SSH-owning file. Each mirrors a
  // mutation that left the suite green on 2026-08-18.
  const src = await readFile(join(here, "run-inference.mjs"), "utf8");
  assert.ok(/const drive = await driveLoop\(/.test(src), "the loop choice must go through driveLoop");
  assert.ok(!/await runAgent\(/.test(src), "runAgent must not be called here — that bypasses the dispatch entirely");
  assert.ok(/model_name_or_path: PROVENANCE\.modelName/.test(src), "predictions must be named by provenance(), not a literal");
  assert.ok(/loop: PROVENANCE\.loop/.test(src), "every runlog row must record which loop ran");
  assert.ok(/assertNoExistingLog\(DURABLE_EVENTS_DIR/.test(src), "the replay guard must run before a durable instance");
});
