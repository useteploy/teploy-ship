/**
 * EV6 (SHIP_INCIDENT_FIX): the reproducing-test gate on an authorised
 * incident remediation — "the test fails on the base revision, passes on
 * head" (docs/SHIP_RELEASE_PROGRAMME_2026-09-21.md E7.2 W2, and the
 * remediation path in src/incidents.ts's header).
 *
 * WHY SHIP RUNS IT. A remediation that fixes the symptom without a test that
 * first demonstrates it has no evidence the incident it "fixed" is the one
 * that fired: the fix and the diagnosis can both be about a different bug,
 * and nothing in the pull request would say so. The gate asks the run's own
 * diff the one question a reviewer asks first — show me the test that failed
 * before your change — and answers it by RUNNING the project's test command
 * twice in the run's own sandbox, not by trusting the agent's account (the
 * same standing rule as src/tests.ts: a finish message is a claim).
 *
 * THE TWO LEGS. "Base" is the revision the run started from plus ONLY the
 * test-file changes (the non-test changes are stashed and restored around
 * the leg); it must FAIL. "Head" is the full change; it must PASS. The pair,
 * not either leg alone, is `reproduced` — a test that fails on base and
 * still fails on head reproduced the bug but did not fix it, and a test that
 * passes on base never reproduced anything.
 *
 * HOLDS, NEVER BLOCKS THE RUN. Like a red suite, an unreproduced remediation
 * still publishes its draft pull request — hiding it would be the dishonest
 * half of the advisory coin — but the outcome holds it at the merge boundary
 * (durable.ts mergeBoundaryGate / autoMergeIfAllowed read reproHoldReason),
 * and an approval cannot silently clear the hold: the blocked reasons name
 * the outcome. A person who disagrees marks the pull request ready on the
 * forge, where their own audit trail carries the override.
 *
 * Pure mechanics only; the ctx.step wrapper lives in durable.ts so the
 * upgrade fence (step-fingerprint.ts) sees the recorded `repro-test` step
 * exactly where the workflow declares it.
 */
import type { AgentExecutor } from "@neutron-build/agents";

import { parseNumstat } from "./change-class.js";
import { detectFromWorkspace } from "./test-detect.js";
import { isTestFile } from "./test-integrity.js";
import { runTests, testTargetFromInput, type TestOutcome, type TestTarget } from "./tests.js";
import type { DurableAgentConfig, DurableAgentInput } from "./durable.js";

/**
 * The gate's answer. The four outcomes the programme row names, plus two
 * honest ones for shapes the row did not: a test that still fails with the
 * fix applied (`fails-on-head` — it reproduced but did not fix), and a leg
 * that could not be executed at all (`errored` — the runner is missing, the
 * stash failed). Both hold exactly like the named ones; only `reproduced`
 * clears the gate.
 */
export type ReproTestVerdict =
  | "reproduced"
  | "does-not-reproduce"
  | "fails-on-head"
  | "no-test-change"
  | "unavailable"
  | "errored";

/** What the `repro-test` step records, and what the incident digest links. */
export interface ReproTestStep {
  verdict: ReproTestVerdict;
  /** The test files the run added or changed (bounded for the record). */
  testFiles: string[];
  /** The command both legs ran, when one was found. */
  command?: string;
  /** The base leg's exit code, when the command actually ran. */
  baseExit?: number;
  /** The head leg's exit code, when the command actually ran. */
  headExit?: number;
  /** Why the gate did not run its legs (no command, nothing to run, a git failure). */
  reason?: string;
  /** The base leg's failing tail — the reproduction itself, bounded. */
  baseOutput?: string;
}

/** How many changed test paths the record names; the stash still sees them all. */
const REPRO_TEST_FILES_MAX = 10;
/** The recorded base-leg tail. The full output stays in the sandbox. */
const REPRO_OUTPUT_MAX = 2_000;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Shell-quote one path for the stash pathspec (paths come from git itself). */
const shQuote = (path: string): string => `'${path.replace(/'/g, `'\\''`)}'`;

/**
 * What this run changed, as the gate needs it: the same staged view the
 * publish gate's classifier sees (`git add -A` first, so the list is exactly
 * what would be committed). Mirrors durable.ts's changedFiles minus the
 * classifier fields — this module keeps its own copy so the two cannot
 * couple over a private helper.
 */
async function changedPathsForRepro(executor: AgentExecutor): Promise<Array<{ path: string; isDelete: boolean }>> {
  await executor.exec("git add -A", { timeoutMs: 60_000 });
  const numstat = await executor.exec("git diff --cached --numstat", { timeoutMs: 60_000 });
  if (numstat.exitCode !== 0) return [];
  const deleted = await executor.exec("git diff --cached --name-only --diff-filter=D", { timeoutMs: 60_000 });
  const deletedSet = new Set(
    deleted.exitCode === 0 ? deleted.stdout.split("\n").map((p) => p.trim()).filter((p) => p !== "") : [],
  );
  return parseNumstat(numstat.stdout).map((file) => ({ path: file.path, isDelete: deletedSet.has(file.path) }));
}

/** The verdict from the two legs. Pure, so the record is a function of the exits. */
function verdictOf(base: TestOutcome, head: TestOutcome): { verdict: ReproTestVerdict; reason?: string } {
  if (base.kind === "errored" || head.kind === "errored") {
    const which = base.kind === "errored" ? "the base leg" : "the head leg";
    const errored = base.kind === "errored" ? base : head;
    const why = errored.kind === "errored" ? errored.reason : "unknown";
    return { verdict: "errored", reason: `${which} could not run (${why}) — the reproduction is untested, not absent` };
  }
  if (base.kind === "passed") {
    return {
      verdict: "does-not-reproduce",
      reason: "the changed tests PASS on the base revision, so nothing in this change demonstrates the incident",
    };
  }
  return head.kind === "passed" ? { verdict: "reproduced" } : { verdict: "fails-on-head" };
}

/**
 * Run the gate: the changed test files, then the base leg (the starting
 * revision plus only the test changes — must fail) and the head leg (the
 * full change — must pass), with the project's own test command resolved
 * the same way runSuite resolves it.
 */
export async function runReproTestGate(
  executor: AgentExecutor,
  config: Pick<DurableAgentConfig, "tests">,
  input: Pick<DurableAgentInput, "testCommand" | "testTimeoutMs" | "repo">,
): Promise<ReproTestStep> {
  const changed = await changedPathsForRepro(executor);
  // Added or MODIFIED test files. A deleted test file is not a reproduction,
  // and a change that only deletes one lands on no-test-change — held, which
  // is the honest answer for a remediation that removed its own coverage.
  const testSet = new Set(changed.filter((f) => !f.isDelete && isTestFile(f.path)).map((f) => f.path));
  const testFiles = [...testSet].slice(0, REPRO_TEST_FILES_MAX);
  const command = (target: TestTarget): Pick<ReproTestStep, "command"> => ({ command: target.command });

  // The same resolution ladder the publish gate's suite uses (runSuite):
  // the per-repo command materialised at enqueue, then the repo's own tree,
  // then the worker's default. No command at all is `unavailable` — held,
  // never silently passed.
  const target =
    testTargetFromInput(input) ??
    (input.repo !== undefined ? await detectFromWorkspace(executor) : undefined) ??
    config.tests;
  if (target === undefined) {
    return {
      verdict: "unavailable",
      testFiles,
      reason: "no test command is configured for this repo or worker, and none was detected in its checkout",
    };
  }
  if (testSet.size === 0) {
    return {
      verdict: "no-test-change",
      testFiles,
      ...command(target),
      reason: "the change adds or modifies no test file, so nothing reproduces the incident",
    };
  }

  // BASE LEG. Stash every changed path that is not a test file (new source
  // files included via -u), run the suite, restore. The stash is the whole
  // trick: the worktree becomes the base revision plus the test changes,
  // which is exactly the tree "the test fails before the fix" describes.
  const others = changed.filter((f) => !testSet.has(f.path)).map((f) => f.path);
  const stashed = others.length > 0;
  if (stashed) {
    const push = await executor.exec(`git stash push -u -m teploy-repro-base -- ${others.map(shQuote).join(" ")}`, {
      timeoutMs: 120_000,
    });
    if (push.exitCode !== 0) {
      return {
        verdict: "errored",
        testFiles,
        ...command(target),
        reason: `could not set the tree to the base revision for the base leg (git stash push exited ${push.exitCode})`,
      };
    }
  }
  const base = await runTests(executor, target);
  if (stashed) {
    const pop = await executor.exec("git stash pop", { timeoutMs: 120_000 });
    if (pop.exitCode !== 0) {
      // The workspace still holds the base tree. Say so rather than letting
      // the publish gate commit half a change: the run's push screens would
      // catch it, but this reason is the one a person can act on.
      return {
        verdict: "errored",
        testFiles,
        ...command(target),
        reason: "could not restore the full change after the base leg (git stash pop failed) — the workspace may still hold the base tree",
      };
    }
  }
  // Nothing stashed means every change is a test change: base and head are
  // the same tree, the legs below prove it, and the verdict lands on
  // does-not-reproduce or fails-on-head honestly rather than by special case.
  const head = await runTests(executor, target);
  const { verdict, reason } = verdictOf(base, head);
  return {
    verdict,
    testFiles,
    ...command(target),
    ...(base.kind === "failed" ? { baseExit: base.exitCode, baseOutput: clip(base.output, REPRO_OUTPUT_MAX) } : {}),
    ...(base.kind === "passed" ? { baseExit: 0 } : {}),
    ...(head.kind === "failed" ? { headExit: head.exitCode } : {}),
    ...(head.kind === "passed" ? { headExit: 0 } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };
}

/**
 * The hold a park carries, naming the outcome. Undefined only for
 * `reproduced` — the one answer that clears the gate.
 */
export function reproHoldReason(repro: Pick<ReproTestStep, "verdict" | "reason" | "headExit">): string | undefined {
  switch (repro.verdict) {
    case "reproduced":
      return undefined;
    case "does-not-reproduce":
      return `reproducing-test gate (${repro.verdict}): ${repro.reason ?? "the tests pass on the base revision"}`;
    case "no-test-change":
      return `reproducing-test gate (${repro.verdict}): ${repro.reason ?? "the change touches no test file"}`;
    case "unavailable":
    case "errored":
      return `reproducing-test gate (${repro.verdict}): ${repro.reason ?? "the check could not run"}`;
    case "fails-on-head":
      return `reproducing-test gate (${repro.verdict}): the tests reproduce the incident on the base revision but still fail with the change applied${repro.headExit !== undefined ? ` (exit ${repro.headExit})` : ""}`;
  }
}

/** The one-line outcome for the merge park's summary and the PR's lead. */
export function reproParkNote(repro: Pick<ReproTestStep, "verdict" | "testFiles">): string {
  const files = repro.testFiles.length === 1 ? repro.testFiles[0]! : `${repro.testFiles.length} test files`;
  if (repro.verdict === "reproduced") {
    return `**Reproducing-test gate: reproduced** — ${files} fails on the base revision and passes with this change.`;
  }
  return `**Reproducing-test gate: ${repro.verdict}** — the remediation is held: the gate wants a test that fails on the base revision and passes with this change, and this change does not have one.`;
}
