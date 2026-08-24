/**
 * Run the project's own test command, and record what it said.
 *
 * The third leg of "a PR with proof". The preview shows the change running and
 * the telemetry shows the service around it; neither answers the question a
 * reviewer asks first, which is whether the suite passes.
 *
 * WHY SHIP RUNS IT, NOT THE AGENT. The agent runs tests constantly and its
 * account of them is a claim in a `finish` message — the same claim the
 * verified-finish gate exists because agents get wrong. `FINISH_NUDGE_VERIFY`
 * asks whether a command was RUN, not whether the suite passed, and an agent
 * can satisfy it with `ls`. So the result that goes on a pull request is
 * produced by Ship, after the agent has stopped touching the tree, from an
 * operator-configured command. Nothing the model emits can influence it beyond
 * the code it wrote.
 *
 * Advisory, like the rest of the evidence: a suite that fails still publishes
 * its pull request, marked. A run that produced a real fix and a failing
 * unrelated test is still worth a human's attention, and hiding it would be the
 * dishonest half of the same coin.
 */
import type { AgentExecutor } from "@neutron-build/agents";

/** What the project's suite said. */
export type TestOutcome =
  | { kind: "passed"; command: string; durationMs: number }
  | { kind: "failed"; command: string; durationMs: number; exitCode: number; output: string }
  | { kind: "errored"; command: string; reason: string }
  | { kind: "disabled"; reason: string };

export interface TestTarget {
  /** The command, exactly as the operator would type it. */
  command: string;
  /** Ceiling. A suite that hangs must not hold a worker forever. */
  timeoutMs?: number;
}

/** Read the worker's test command. Absent = the feature is off. */
export function testTargetFromEnv(env: NodeJS.ProcessEnv = process.env): TestTarget | undefined {
  const command = (env.SHIP_TEST_COMMAND ?? "").trim();
  if (command === "") return undefined;
  const timeout = Number(env.SHIP_TEST_TIMEOUT_MS);
  return {
    command,
    ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
  };
}

/**
 * The per-repo test command recorded in the run input at enqueue (see
 * evidence.ts). Takes precedence over the worker's env default — one worker
 * serving many repos runs each repo's own suite — and absent on runs enqueued
 * before per-repo evidence existed, which then fall back exactly as before.
 */
export function testTargetFromInput(input: { testCommand?: string; testTimeoutMs?: number }): TestTarget | undefined {
  const command = input.testCommand?.trim();
  if (command === undefined || command === "") return undefined;
  return {
    command,
    ...(input.testTimeoutMs !== undefined && Number.isFinite(input.testTimeoutMs) && input.testTimeoutMs > 0
      ? { timeoutMs: input.testTimeoutMs }
      : {}),
  };
}

/** Keep the tail: a failing suite puts its summary at the end. */
function tail(text: string, lines = 40): string {
  const kept = text.trimEnd().split("\n").slice(-lines).join("\n");
  return kept.length > 4000 ? `…${kept.slice(-4000)}` : kept;
}

/**
 * Run the suite in the run's own workspace.
 *
 * `elapsed` is passed in rather than read from a clock so the caller can record
 * it as part of a durable step: a step that re-derives a duration on replay
 * produces a different value than the one in the log.
 */
export async function runTests(
  executor: AgentExecutor,
  target: TestTarget,
  now: () => number = Date.now,
): Promise<TestOutcome> {
  const started = now();
  try {
    const result = await executor.exec(target.command, { timeoutMs: target.timeoutMs ?? 900_000 });
    const durationMs = now() - started;
    // A suite that was KILLED did not fail — it never finished. Reporting a
    // timeout as a failure puts a red mark on a change nothing tested, the
    // same category error as reporting a missing command that way.
    if (result.timedOut) {
      return {
        kind: "errored",
        command: target.command,
        reason: `timed out after ${Math.round(durationMs / 1000)}s (SHIP_TEST_TIMEOUT_MS)`,
      };
    }
    if (result.exitCode === 0) return { kind: "passed", command: target.command, durationMs };
    return {
      kind: "failed",
      command: target.command,
      durationMs,
      exitCode: result.exitCode,
      // stdout AND stderr: test runners disagree about which one carries the
      // failure summary, and a reviewer reading "tests failed" with no reason
      // has to reproduce it themselves.
      output: tail(`${result.stdout ?? ""}${result.stderr ?? ""}`),
    };
  } catch (error) {
    // A suite that could not be RUN is not a suite that failed. Reporting a
    // missing command or a dead container as "tests failed" would put a red
    // mark on a change that nothing tested.
    return { kind: "errored", command: target.command, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** The tests line for the pull request. */
export function testComment(outcome: TestOutcome): string {
  switch (outcome.kind) {
    case "passed":
      return `Tests: **passed** — \`${outcome.command}\`, ${Math.round(outcome.durationMs / 1000)}s.\n\nRun by Teploy Ship after the agent stopped, not reported by the agent.`;
    case "failed":
      return (
        `Tests: **FAILED** — \`${outcome.command}\` exited ${outcome.exitCode} after ${Math.round(outcome.durationMs / 1000)}s.\n\n` +
        "```\n" +
        outcome.output +
        "\n```\n\nThe change is published anyway so a human can judge it; a failing suite here may or may not be caused by this change."
      );
    case "errored":
      return `Tests: **not run** — \`${outcome.command}\` could not be executed: ${outcome.reason}. This is not a test failure.`;
    case "disabled":
      return `Tests: not run (${outcome.reason}).`;
  }
}
