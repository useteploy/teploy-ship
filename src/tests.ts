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

/**
 * The few root files that say how a repository runs its own tests. Read from
 * the forge at enqueue by test-detect.ts; kept as a plain value so the
 * detection below is pure and testable without a network.
 */
export interface RepoTree {
  /** Entry names at the repository root (files and directories, no paths). */
  names: string[];
  /** Contents of the root package.json, when there is one. */
  packageJson?: string;
  /** Contents of the root Makefile, when there is one. */
  makefile?: string;
  /** Contents of the root pyproject.toml, when there is one. */
  pyproject?: string;
}

/** npm's own placeholder script. A repo that still has it has no suite. */
const NPM_PLACEHOLDER = /no test specified/i;

/**
 * Which package manager a JS repo uses, from `packageManager` first (the field
 * corepack honours, so it is the repo's own statement) and the lockfile
 * second.
 */
function jsPackageManager(names: readonly string[], pkg: Record<string, unknown>): "pnpm" | "yarn" | "bun" | "npm" {
  const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : "";
  if (declared === "pnpm" || declared === "yarn" || declared === "bun" || declared === "npm") return declared;
  if (names.includes("pnpm-lock.yaml")) return "pnpm";
  if (names.includes("yarn.lock")) return "yarn";
  if (names.includes("bun.lockb") || names.includes("bun.lock")) return "bun";
  return "npm";
}

/**
 * The install step a JS suite needs before it can run.
 *
 * Not optional and not gold-plating: the suite runs in a container over a FRESH
 * clone, so `pnpm test` with no node_modules exits non-zero and Ship reports
 * "Tests: FAILED" for a repo whose tests were never executed — strictly worse
 * than reporting nothing. Go, Rust and pytest need no equivalent (go and cargo
 * fetch their own dependencies).
 *
 * `--frozen-lockfile` / `npm ci` only where a lockfile exists, matching what a
 * CI job for the same repo would do.
 */
function jsInstall(pm: "pnpm" | "yarn" | "bun" | "npm", names: readonly string[]): string {
  switch (pm) {
    case "pnpm":
      return names.includes("pnpm-lock.yaml") ? "pnpm install --frozen-lockfile" : "pnpm install";
    case "yarn":
      return names.includes("yarn.lock") ? "yarn install --frozen-lockfile" : "yarn install";
    case "bun":
      return "bun install";
    case "npm":
      return names.includes("package-lock.json") ? "npm ci" : "npm install";
  }
}

/**
 * Guess the repository's test command from its root.
 *
 * This is the DEFAULT for a repo with no explicit entry, not a replacement for
 * one: `resolveTestTarget` (test-detect.ts) returns the operator's
 * `testCommand` untouched whenever there is one. Before this, every repo owed
 * Ship a `teploy-ship evidence set <repo> --test-command …` before a single
 * pull request could carry a suite result, and a worker-wide
 * `SHIP_TEST_COMMAND` was wrong for every repo but one.
 *
 * Order, and why:
 *   1. `package.json` scripts.test — the repo's own declared entry point.
 *   2. a Makefile `test:` target — an operator wrote that on purpose, and it
 *      usually wraps the language command with the flags the repo needs.
 *   3. go.mod / Cargo.toml / pytest, which are conventions rather than
 *      statements.
 *
 * Returns undefined when nothing is recognisable, which leaves the worker's
 * SHIP_TEST_COMMAND in charge exactly as before. A WRONG guess is bounded by
 * C4: the baseline runs the same command before the agent edits anything, so a
 * command that cannot run in the sandbox is reported as pre-existing breakage
 * rather than blamed on the run (see preExisting below).
 */
export function testTargetFromTree(tree: RepoTree): TestTarget | undefined {
  const names = tree.names;

  if (tree.packageJson !== undefined) {
    let pkg: Record<string, unknown> = {};
    try {
      pkg = JSON.parse(tree.packageJson) as Record<string, unknown>;
    } catch {
      pkg = {};
    }
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    const script = typeof scripts.test === "string" ? scripts.test.trim() : "";
    if (script !== "" && !NPM_PLACEHOLDER.test(script)) {
      const pm = jsPackageManager(names, pkg);
      return { command: `${jsInstall(pm, names)} && ${pm} test` };
    }
  }

  // A `test:` target at the start of a line, not `pretest:` and not a mention
  // inside a recipe. Tabs and `.PHONY: test` lines are both handled by
  // requiring the name at column 0.
  if (tree.makefile !== undefined && /^test[ \t]*:/m.test(tree.makefile)) {
    return { command: "make test" };
  }

  if (names.includes("go.mod")) return { command: "go test ./..." };
  if (names.includes("Cargo.toml")) return { command: "cargo test" };

  // pytest needs a real signal, not just "there is Python here": a repo with
  // no pytest config gets nothing rather than a command that exits 4.
  const pytestConfigured =
    (tree.pyproject !== undefined && /\[tool\.pytest/.test(tree.pyproject)) ||
    names.includes("pytest.ini") ||
    names.includes("conftest.py") ||
    names.includes("tox.ini");
  if (pytestConfigured) return { command: "python3 -m pytest -q" };

  return undefined;
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

/**
 * Was the suite ALREADY failing before the agent touched anything?
 *
 * Without this, "Tests: FAILED" cannot separate a regression this run caused
 * from breakage it inherited — and on 2026-08-26 a Go 1.24/1.25 base-image
 * mismatch made every Go pull request arrive marked `tests: failed`, which cost
 * a day of reading them as the agent's fault. A baseline run before the agent
 * edits is the whole fix, and it is cheap relative to being wrong about it.
 */
export function preExisting(baseline: TestOutcome | undefined, after: TestOutcome): boolean {
  if (baseline === undefined || after.kind !== "failed") return false;
  if (baseline.kind !== "failed") return false;
  // Same command, and the failure did not get worse. Comparing exit codes
  // rather than output because output carries timings and paths that differ run
  // to run; a DIFFERENT exit code means something else broke and the run owns
  // it.
  return baseline.command === after.command && baseline.exitCode === after.exitCode;
}

/** The tests line for the pull request. */
export function testComment(outcome: TestOutcome, baseline?: TestOutcome): string {
  switch (outcome.kind) {
    case "passed":
      return (
        `Tests: **passed** — \`${outcome.command}\`, ${Math.round(outcome.durationMs / 1000)}s.\n\n` +
        "Run by Teploy Ship after the agent stopped, not reported by the agent." +
        (baseline?.kind === "failed"
          ? `\n\nThe suite was already failing on the base branch (exit ${baseline.exitCode}) and passes here, so this change FIXED it.`
          : "")
      );
    case "failed": {
      const inherited = preExisting(baseline, outcome);
      return (
        `Tests: **FAILED** — \`${outcome.command}\` exited ${outcome.exitCode} after ${Math.round(outcome.durationMs / 1000)}s.\n\n` +
        "```\n" +
        outcome.output +
        "\n```\n\n" +
        (inherited
          ? "**This suite was already failing on the base branch, the same way, before this run made any change.** " +
            "It is pre-existing breakage, not a regression from this pull request."
          : baseline?.kind === "passed"
            ? "The suite PASSED on the base branch before this run started, so this change broke it."
            : "The change is published anyway so a human can judge it; a failing suite here may or may not be caused by this change.")
      );
    }
    case "errored":
      return `Tests: **not run** — \`${outcome.command}\` could not be executed: ${outcome.reason}. This is not a test failure.`;
    case "disabled":
      return `Tests: not run (${outcome.reason}).`;
  }
}

/**
 * The one-line warning for a suite that may not have covered the change.
 *
 * Detection reads the REPOSITORY ROOT (`testTargetFromTree`) and the worker's
 * SHIP_TEST_COMMAND is a root command too. A monorepo whose crate lives in a
 * subdirectory — Neutron's `nucleus/` is 347k lines of Rust under a root with
 * a go.mod — then runs `go test ./...` at the root, which never compiles the
 * crate, and reports a green suite for a change it did not test. That false
 * green is worse than "not run", because it reads as evidence.
 *
 * This does not re-detect: at baseline time nothing has changed yet, so a
 * subtree-derived command would differ between the baseline and the after
 * run and `preExisting` would read every failure as a regression. It REPORTS:
 * when every changed file lives under one top-level directory and the command
 * does not name that directory, say so next to the tests line so the reviewer
 * — and the operator setting `--test-command` on the project — can see the
 * mismatch. Undefined when the change touches the root or several trees, or
 * when the command already points into the directory.
 */
export function testScopeNote(command: string, changedPaths: readonly string[]): string | undefined {
  const tops = new Set<string>();
  for (const raw of changedPaths) {
    const path = raw.replace(/^\.\//, "");
    const slash = path.indexOf("/");
    if (slash <= 0) return undefined; // a root-level file: the root command is the right scope
    tops.add(path.slice(0, slash));
  }
  if (tops.size !== 1) return undefined;
  const [dir] = [...tops];
  if (dir === undefined || command.includes(dir)) return undefined;
  return (
    `Every changed file lives under \`${dir}/\`, but the suite ran from the repository root ` +
    `(\`${command}\`). If \`${dir}/\` has its own suite, this run did not execute it: set ` +
    `\`--test-command\` on the project so the gate covers the tree the change is in.`
  );
}

/**
 * The nudge that sends a run back to work over a red suite.
 *
 * Ship used to report a failing suite on the pull request and end the run —
 * no iterate-until-green at all, even though the agent had turns left and the
 * failure output in hand. This is the feedback: the real command, the real
 * exit code, the real tail, and an explicit instruction that the deliverable is
 * a green suite rather than a description of why it is red.
 */
export function testsFailedNudge(outcome: Extract<TestOutcome, { kind: "failed" }>): string {
  return (
    `The project's test suite FAILED over your changes. Ship ran it, not you, so this is not something you can talk past:\n\n` +
    `$ ${outcome.command}\nexit ${outcome.exitCode}\n\n` +
    "```\n" +
    outcome.output +
    "\n```\n\n" +
    "Fix it. Read the failure, change the code that is actually wrong, re-run the suite yourself to confirm it is green, and only then finish. " +
    "If the failure is genuinely unrelated to your change and was already broken, say so explicitly in your finish message and explain why."
  );
}
