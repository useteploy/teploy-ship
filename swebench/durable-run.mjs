// Drive the DURABLE loop (src/durable.ts) from the SWE-bench harness.
//
// WHY THIS EXISTS. Every SWE-bench number Ship has published was measured on
// `runAgent` (src/agent.ts) — the live loop, which serves the CLI's one-shot
// `run`, the eval suite and this harness. The PRODUCT is `durableAgent`
// (src/durable.ts): the webhook -> intake -> worker -> PR path, driven by
// worker.ts. They are different loops. Publishing a live-loop number as the
// product's number is the misattribution P0 exists to end, so this module
// makes the durable path benchmarkable and stamps every artifact it produces
// with which loop ran.
//
// WHY IT IS A SEPARATE FILE. run-inference.mjs opens an SSH connection at
// module scope, so it cannot be imported by a test. Everything testable lives
// here, the same split executor-snapshot.mjs already uses.
//
// WHAT IS *NOT* DIFFERENT BETWEEN THE LOOPS — checked against source
// 2026-08-18, because two planning docs say otherwise:
//   `durable.ts:824` calls `executeAction(executor, action, timeout, "t<turn>")`
//   with FOUR arguments; the fifth parameter is `useKernel = true`
//   (`agent.ts:523`). Python actions on the durable path go through
//   installKernel/ensureKernel/runCell exactly as the live loop does. The
//   durable path has had the persistent kernel since it landed. The only
//   kernel-related difference is that the live loop calls `stopKernel` on the
//   way out (`agent.ts:501`) and durable does not — irrelevant here, where the
//   container is destroyed after every instance.
//
// WHAT *IS* DIFFERENT, and why there are two arms below. Three defaults
// diverge, and all three change when a run ends:
//   1. stuck detection is ON by default in runAgent (`agent.ts:220`) and OFF in
//      durable unless the run input carries `recovery`, or `settle`, which
//      implies it (`durable.ts:522`).
//   2. the clean-tree finish hold is unconditional in runAgent
//      (`agent.ts:342`) and gated on `input.requireEdit` in durable
//      (`durable.ts:686`).
//   3. maxSteps defaults to 20 live and 40 durable — moot here, the harness
//      passes it explicitly.
// A durable sweep at durable's own defaults therefore differs from the 35/50
// baseline in THREE ways at once and its delta would mean nothing. So:
//   SHIP_DURABLE=1        -> the PARITY arm. recovery + requireEdit forced on,
//                            so the LOOP is the only variable against 35/50.
//   SHIP_DURABLE=product  -> the PRODUCT arm. exactly what enqueueRun bakes
//                            into a webhook-launched run (runtime.ts:459-484).
// Both are recorded in the runlog. Never average them, never compare them to
// each other without saying which is which.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { autoApprove, defaultApprovalPolicy, defaultRecoveryConfig, durableAgent, runAgent } = await import(
  join(here, "..", "dist", "index.js")
);
const { durableRecoveryInput } = await import(join(here, "..", "dist", "durable.js"));
const { usageFromEvents } = await import(join(here, "..", "dist", "worker.js"));
const { executeRun } = await import(join(here, "..", "node_modules", "@neutron-build", "workflow", "dist", "index.js"));

export { autoApprove, defaultApprovalPolicy, durableAgent, executeRun, runAgent };

/**
 * The stale-dist guard's symbol table for the durable knobs.
 *
 * The harness's own guard CONSUMES this list rather than restating it (`when`
 * is the flag combination that makes each symbol load-bearing), so a symbol
 * added here cannot be forgotten there.
 *
 * Same job as the rest of that table: the harness imports from
 * ../dist, and an unknown option is silently dropped by JS, so a sweep launched
 * against a build that predates a feature runs for hours with that feature
 * inert and reports a number that looks real. `workspaceKey` is the one that
 * matters most — without it the critic and the code index are unreachable on
 * any run with no repo checkout (see the note on durableInput below), so a
 * P0-2 sweep would silently run with NEITHER.
 */
export const DIST_REQUIREMENTS = [
  { file: "durable.js", symbol: "durableAgent", env: "SHIP_DURABLE", when: ({ durable }) => durable },
  {
    file: "durable.js",
    symbol: "workspaceKey",
    env: "SHIP_DURABLE + SHIP_CRITIC/SHIP_CODE_INDEX",
    when: ({ durable, critic, index }) => durable && (critic || index),
  },
];

/**
 * Which loop ran, and the name its predictions carry — ONE function, so the
 * runlog and the predictions file cannot disagree.
 *
 * A durable predictions file must never be scoreable as the 35/50 live-loop
 * baseline even if the runlog is lost, so the model_name_or_path differs too.
 */
export function provenance(durable, model) {
  return durable
    ? { loop: "durable", modelName: `teploy-agent-durable+${model}` }
    : { loop: "live", modelName: `teploy-agent+${model}` };
}

/**
 * Read SHIP_DURABLE. Default off — the 35/50 baseline must stay reproducible
 * byte for byte, so an unset variable changes nothing about the live path.
 */
export function durableArmFromEnv(env = process.env) {
  const raw = (env.SHIP_DURABLE ?? "").trim().toLowerCase();
  if (raw === "" || raw === "0" || raw === "false" || raw === "no") return null;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "parity") return "parity";
  if (raw === "product") return "product";
  throw new Error(`SHIP_DURABLE must be unset, 1 (parity arm) or "product" — got ${JSON.stringify(raw)}`);
}

/**
 * The durable run input for one instance.
 *
 * `workspaceKey` is the field that makes P0-2 possible at all. In durable.ts
 * the critic, the ```search action, the prompt's search advertisement and the
 * repo-index refresh were ALL gated on there being a repo checkout — and a
 * SWE-bench container cannot be a repo run, because /testbed is pip-installed
 * editable and an agent editing a clone elsewhere would be graded against the
 * untouched original. `workspaceKey` says "no repo, but this workspace is a git
 * tree; scope its index here", which unlocks exactly those four gates and
 * nothing else. Absent from an input, every gate behaves as before, so no
 * enqueued run replays differently.
 */
export function durableInput({ task, arm, settle = false, critic = false, index = false, workspaceKey }) {
  if (arm !== "parity" && arm !== "product") throw new Error(`unknown durable arm: ${JSON.stringify(arm)}`);
  // The CLI's own --settle mapping, CALLED rather than re-derived, so the two
  // cannot drift (durable.ts documents why that line is seam-tested).
  const settleBits = durableRecoveryInput(settle === true ? { settle: true } : {});
  // Materialize the thresholds; never leave a bare `true` in a run input. That
  // is enqueueRun's contract (runtime.ts:433-449) and the reason is that the
  // thresholds decide which turn a run terminates on — a bare `true` resolves
  // them from a code constant at execution time, so editing the constant bricks
  // in-flight runs with a NondeterminismError that executeRun throws.
  const recoveryOn = arm === "parity" || settleBits.recovery === true;
  return {
    task,
    ...(recoveryOn ? { recovery: { ...defaultRecoveryConfig } } : {}),
    ...(settleBits.settle === true ? { settle: true } : {}),
    // Parity only: the live loop holds a finish over an unchanged tree
    // unconditionally, so leaving this off would make the durable arm strictly
    // more permissive than the baseline it is being compared to.
    ...(arm === "parity" ? { requireEdit: true } : {}),
    // The product arm gets exactly what enqueueRun bakes in for a
    // webhook-launched run. steer with no store configured drains empty; guard
    // is inert without a repo. Both still record their steps, which is the
    // point — this arm is meant to be the real thing, not a tidied one.
    ...(arm === "product" ? { steer: true, index: true, guard: true } : {}),
    ...(critic === true ? { critic: true } : {}),
    ...(index === true ? { index: true } : {}),
    ...(workspaceKey !== undefined ? { workspaceKey } : {}),
  };
}

/**
 * ExecutorProvider over the container run-inference already started.
 *
 * `create` returns a fixed handle because there is nothing to create — the
 * container's lifecycle belongs to the harness, exactly as container-executor
 * says of `destroy`. No `destroy`, `snapshot` or `createFrom`: dispose()
 * no-ops without destroy (durable.ts:1010) and the harness's finally block
 * removes the container. `isolated` is deliberately absent — false is the safe
 * answer, and it is never read here because the harness never marks a run's
 * task as externally sourced.
 */
export function harnessProvider(executor) {
  return {
    async create() {
      return { handle: "swebench" };
    },
    attach() {
      return executor;
    },
  };
}

const TURN_STEP = (suffix) => new RegExp(`^turn-\\d+-${suffix}$`);

/**
 * Count what the durable loop actually did, off the event log.
 *
 * The durable path has no `onEvent` hook, so these are the only way to tell a
 * run that thought and executed from a run that attached nothing and measured
 * nothing. Treat every one of them as a HYPOTHESIS about the score, never a
 * proxy for it — two changes this week improved their mechanism and moved the
 * graded number by exactly zero.
 */
export function summarizeRun(events) {
  const named = (re) => events.filter((e) => e.type === "step-completed" && re.test(e.name ?? "")).length;
  const indexStep = events.find((e) => e.type === "step-completed" && e.name === "repo-index");
  return {
    thinks: named(TURN_STEP("think")),
    execs: named(TURN_STEP("exec")),
    searches: named(TURN_STEP("search")),
    criticDiffs: named(TURN_STEP("critic-diff")),
    criticRuns: named(TURN_STEP("critic")),
    condenses: named(TURN_STEP("condense")),
    steers: named(TURN_STEP("steer")),
    fingerprints: named(TURN_STEP("fingerprint")),
    treeChecks: named(TURN_STEP("finish-tree")),
    failedSteps: events.filter((e) => e.type === "step-failed").length,
    parked: events.some((e) => e.type === "event-waiting"),
    ...(indexStep !== undefined ? { indexNote: String(indexStep.data?.result ?? "") } : {}),
  };
}

/**
 * Collapse a RunOutcome into one runlog status.
 *
 * `waiting` becomes "parked", never anything that could be read as a finish. A
 * sweep that parks is a sweep that hangs forever, so the caller aborts on it —
 * see the check in run-inference.mjs.
 */
export function statusOf(outcome) {
  switch (outcome.status) {
    case "completed": {
      const status = outcome.output?.status;
      return typeof status === "string" ? status : "completed";
    }
    case "waiting":
      return "parked";
    case "failed":
      return "error";
    default:
      return outcome.status;
  }
}

/**
 * Mirror durable's per-step progress onto stderr.
 *
 * runAgent gives the live arm an `onEvent` stream; durable has no hook at all,
 * so without this a sweep runs blind and a stuck run is indistinguishable from
 * a slow one for up to actionTimeoutMs x maxSteps — hours, on 50 instances.
 */
export function teeStore(store, log) {
  return {
    append: async (runId, event) => {
      if (event.type === "step-completed" || event.type === "step-failed" || event.type === "event-waiting") {
        log(`  [${event.type === "step-completed" ? "step" : event.type}] ${event.name ?? ""}`);
      }
      return store.append(runId, event);
    },
    load: (runId) => store.load(runId),
  };
}

/**
 * One durable run, start to finish, for one SWE-bench instance.
 *
 * ONE execution pass. A benchmark run has no operator, so a park is a dead
 * sweep rather than a pause: `autoApprove` is passed instead of the
 * `defaultApprovalPolicy` the CLI (cli.ts:637) and the worker (worker.ts:275)
 * use, and `plan` is never set. NOTE for anyone tempted to "match the product"
 * here: the CLI does NOT avoid parking, it parks and waits for
 * `teploy-ship approve`. The product has a human attached; a sweep does not.
 * autoApprove is what the live arm already effectively does — runAgent is
 * called with no approveAction at all — so this is the parity choice as well as
 * the practical one.
 */
export async function runDurable({
  model,
  executor,
  task,
  workdir,
  maxSteps,
  actionTimeoutMs,
  input,
  runId,
  store,
  codeSearch,
}) {
  const wf = durableAgent({
    model,
    executor: harnessProvider(executor),
    approveAction: autoApprove,
    workdir,
    maxSteps,
    actionTimeoutMs,
    ...(codeSearch !== undefined ? { codeSearch } : {}),
  });
  const outcome = await executeRun({ workflow: wf, runId, store, input });
  const events = await store.load(runId);
  const output = outcome.output ?? {};
  // Usage from the OUTPUT when the run completed, reconstructed from the log
  // otherwise. Without the fallback SWEBENCH_BUDGET_USD would fail open on
  // exactly the runs that crashed — the ones that already burned the tokens.
  const usage = output.usage ?? usageFromEvents(events) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  return {
    status: statusOf(outcome),
    outcomeStatus: outcome.status,
    ...(outcome.error?.detail !== undefined ? { error: String(outcome.error.detail).slice(0, 300) } : {}),
    turns: typeof output.turns === "number" ? output.turns : 0,
    summary: typeof output.summary === "string" ? output.summary : "",
    usage,
    counts: summarizeRun(events),
    events,
  };
}

/**
 * The two loop drivers, by name.
 *
 * `driveLoop` takes them as an injectable default so a test can watch the
 * dispatch without a container, and asserts SEPARATELY that these defaults are
 * the real `runAgent` and `runDurable`. Injection alone would prove only that
 * driveLoop calls whatever it was handed.
 */
export const LOOP_DRIVERS = Object.freeze({ runAgent, runDurable });

/** Where one instance's durable event log lands. */
export function eventLogPath(dir, runId) {
  return join(dir, `${runId}.events.jsonl`);
}

/**
 * Refuse to write over an existing durable event log.
 *
 * executeRun REPLAYS a log rather than re-running it, and a terminal run
 * short-circuits idempotently. A second sweep to the same predictions path
 * would therefore return every instance's RECORDED outcome without calling the
 * model — against a FRESH container, i.e. an empty tree and an empty patch,
 * reported as a completed run. A silent zero that looks like a real result is
 * precisely the failure this arm exists to prevent.
 */
export function assertNoExistingLog(dir, runId, exists = existsSync) {
  const path = eventLogPath(dir, runId);
  if (exists(path)) {
    throw new Error(
      `${path} already exists — a durable run REPLAYS its log instead of re-running, so this sweep would ` +
        `report recorded outcomes against an empty tree. Write to a new predictions path, or move that directory aside.`,
    );
  }
}

/**
 * Run ONE instance on ONE of the two loops, and normalize what the runlog needs.
 *
 * This function is the seam the harness's per-instance body used to hold in
 * plain text: which loop runs, and how the result becomes a row. It lives here,
 * not in run-inference.mjs, because that file opens an SSH connection at module
 * scope and so cannot be imported by a test — which meant the dispatch was
 * verified by nothing at all. Everything downstream of this call (the final
 * `git diff HEAD`, the lastNonEmptyDiff fallback, the prediction) is shared
 * between the arms, deliberately: a durable run that failed or parked can still
 * be holding a real fix in the tree.
 *
 * `loop` is returned unconditionally, on both arms. A result whose loop cannot
 * be established after the fact is the misattribution this whole arm exists to
 * end.
 */
export async function driveLoop({
  arm,
  model,
  executor,
  task,
  workdir,
  maxSteps,
  actionTimeoutMs,
  settle = false,
  critic = false,
  index = false,
  // Live arm: the `(q) => ...` search function, absent unless this instance
  // actually indexed. Durable arm: the index object itself, because durable.ts
  // refreshes it inside a recorded `repo-index` step.
  codeSearch,
  workspaceKey,
  runId,
  store,
  // Canary doctrine: a failure on the FIRST instance is a setup error that
  // every later instance will repeat, so it aborts the sweep rather than
  // recording 50 rows of it.
  first = false,
  onEvent,
  log = (line) => console.error(line),
  drivers = LOOP_DRIVERS,
}) {
  if (arm === null || arm === undefined) {
    const live = await drivers.runAgent({
      model,
      executor,
      task,
      workdir,
      maxSteps,
      actionTimeoutMs,
      finishWhenSettled: settle,
      critic,
      ...(codeSearch !== undefined ? { codeSearch } : {}),
      ...(onEvent !== undefined ? { onEvent } : {}),
    });
    return { loop: "live", arm: null, status: live.status, steps: live.steps.length, usage: live.usage, live };
  }

  const input = durableInput({ task, arm, settle, critic, index, workspaceKey });
  const durable = await drivers.runDurable({
    model,
    executor,
    task,
    workdir,
    maxSteps,
    actionTimeoutMs,
    input,
    runId,
    store,
    ...(codeSearch !== undefined ? { codeSearch } : {}),
  });
  // A parked run is a hung sweep: nothing will ever deliver the approval.
  // autoApprove and the absence of `plan` are what prevent it, so if one parks
  // anyway on the first instance, stop.
  if (durable.status === "parked" && first) {
    throw new Error(
      "the durable run PARKED on the first instance — a sweep has no operator to approve it. " +
        "Check that approveAction is autoApprove and that `plan` is not set (durable-run.mjs).",
    );
  }
  if (durable.status === "parked") log("  PARKED — recorded as parked, not as a finish");
  // The index arm's canary, durable edition. durable.ts catches index failures
  // INSIDE the step and records the reason as a string, so the failure is
  // invisible unless it is read back out of the log.
  const note = durable.counts.indexNote;
  if (index === true && first && (note === undefined || /^(index refresh failed|disabled)/.test(note))) {
    throw new Error(
      `code index unusable on the first instance — aborting before spending a sweep: ${note ?? "no repo-index step was recorded"}`,
    );
  }
  if (note !== undefined) log(`  [index] ${note}`);
  return {
    loop: "durable",
    arm,
    status: durable.status,
    // Model turns, both arms — the same quantity measured two ways (runAgent
    // appends one step per action; durable records one `turn-N-think` per model
    // call).
    steps: durable.counts.thinks,
    usage: durable.usage,
    input,
    durable,
  };
}
