import test from "node:test";
import assert from "node:assert/strict";
import { preExisting, runTests, testComment, testScopeNote, testTargetFromEnv, testTargetFromTree, testsFailedNudge } from "./tests.js";
import type { TestOutcome } from "./tests.js";
import type { AgentExecutor } from "@neutron-build/agents";

/** An executor that returns one scripted exec result and records the command. */
function scriptedExecutor(result: Partial<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> | Error) {
  const commands: string[] = [];
  const executor = {
    async exec(command: string) {
      commands.push(command);
      if (result instanceof Error) throw result;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...result };
    },
  } as unknown as AgentExecutor;
  return { executor, commands };
}

const clock = (): (() => number) => {
  let t = 1000;
  return () => (t += 4000);
};

test("a passing suite is reported with the command that produced it", async () => {
  const { executor, commands } = scriptedExecutor({ exitCode: 0, stdout: "42 passing\n" });
  const outcome = await runTests(executor, { command: "pnpm test" }, clock());

  assert.equal(outcome.kind, "passed");
  assert.deepEqual(commands, ["pnpm test"]);
  const text = testComment(outcome);
  assert.match(text, /passed/);
  assert.match(text, /pnpm test/);
  // The provenance line is the point: a reviewer must know this was measured,
  // not claimed by the model.
  assert.match(text, /not reported by the agent/);
});

test("a failing suite carries its own output, and does not block the PR", async () => {
  const { executor } = scriptedExecutor({
    exitCode: 1,
    stdout: "FAIL src/login.test.ts\n",
    stderr: "AssertionError: expected 401 to equal 200\n",
  });
  const outcome = await runTests(executor, { command: "npm test" }, clock());

  assert.equal(outcome.kind, "failed");
  assert.equal((outcome as { exitCode: number }).exitCode, 1);
  const text = testComment(outcome);
  assert.match(text, /FAILED/);
  // Both streams: runners disagree about which carries the summary.
  assert.match(text, /FAIL src\/login\.test\.ts/);
  assert.match(text, /AssertionError/);
  // A failing unrelated suite must not read as "this change is broken".
  assert.match(text, /may or may not be caused by this change/);
});

test("a suite that could not RUN is not a suite that failed", async () => {
  // The distinction that matters: a missing command, a dead container or a
  // timeout would otherwise put a red mark on a change nothing tested.
  const missing = await runTests(scriptedExecutor(new Error("sh: pnpm: not found")).executor, { command: "pnpm test" }, clock());
  assert.equal(missing.kind, "errored");
  assert.match(testComment(missing), /not run/);
  assert.match(testComment(missing), /not a test failure/);

  const hung = await runTests(scriptedExecutor({ exitCode: 143, timedOut: true }).executor, { command: "pnpm test" }, clock());
  assert.equal(hung.kind, "errored", "a killed suite never finished — it did not fail");
  assert.match((hung as { reason: string }).reason, /timed out/);
});

test("the timeout is passed to the executor, so a hung suite cannot pin a worker", async () => {
  let seen: unknown;
  const executor = {
    async exec(_command: string, options?: { timeoutMs?: number }) {
      seen = options?.timeoutMs;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
    },
  } as unknown as AgentExecutor;

  await runTests(executor, { command: "pnpm test" });
  assert.equal(seen, 900_000, "a default ceiling must exist");
  await runTests(executor, { command: "pnpm test", timeoutMs: 60_000 });
  assert.equal(seen, 60_000);
});

test("a worker runs tests only when given a command", () => {
  assert.equal(testTargetFromEnv({}), undefined);
  assert.equal(testTargetFromEnv({ SHIP_TEST_COMMAND: "   " }), undefined);
  assert.deepEqual(testTargetFromEnv({ SHIP_TEST_COMMAND: "pnpm test" }), { command: "pnpm test" });
  assert.deepEqual(testTargetFromEnv({ SHIP_TEST_COMMAND: "pnpm test", SHIP_TEST_TIMEOUT_MS: "60000" }), {
    command: "pnpm test",
    timeoutMs: 60000,
  });
  // Junk falls back to the default rather than becoming NaN, which would mean
  // no timeout at all.
  assert.deepEqual(testTargetFromEnv({ SHIP_TEST_COMMAND: "pnpm test", SHIP_TEST_TIMEOUT_MS: "soon" }), { command: "pnpm test" });
});

// --- C4: evidence has to reach the agent, and a reviewer has to be able to
// tell a regression from inherited breakage ---------------------------------

const failedAt = (exitCode: number, command = "pnpm test"): Extract<TestOutcome, { kind: "failed" }> => ({
  kind: "failed",
  command,
  durationMs: 1000,
  exitCode,
  output: "1 failing",
});
const passed = (command = "pnpm test"): TestOutcome => ({ kind: "passed", command, durationMs: 900 });

test("preExisting: the same command failing the same way is inherited, not caused", () => {
  assert.equal(preExisting(failedAt(1), failedAt(1)), true);
  assert.equal(preExisting(passed(), failedAt(1)), false, "green before, red after — this run broke it");
  assert.equal(preExisting(undefined, failedAt(1)), false, "no baseline means we cannot claim it was inherited");
  assert.equal(preExisting(failedAt(1), passed()), false, "nothing to inherit when it passes");
  assert.equal(preExisting(failedAt(1), failedAt(2)), false, "a different exit code is something else breaking");
  assert.equal(preExisting(failedAt(1, "go test ./..."), failedAt(1, "pnpm test")), false, "different command, different question");
});

test("a pre-existing red suite is not blamed on the pull request that ran into it", () => {
  // 2026-08-26: a Go 1.24/1.25 base-image mismatch made every Go pull request
  // arrive marked `tests: failed`, and a day went into reading them as the
  // agent's fault. There was no baseline, so there was no way to tell.
  const text = testComment(failedAt(1), failedAt(1));
  assert.match(text, /already failing on the base branch/);
  assert.match(text, /pre-existing breakage, not a regression/);
  assert.doesNotMatch(text, /may or may not be caused/, "the hedge is for when we genuinely do not know");
});

test("a suite this run broke says so plainly", () => {
  const text = testComment(failedAt(1), passed());
  assert.match(text, /PASSED on the base branch before this run started, so this change broke it/);
});

test("with no baseline the wording stays honest about not knowing", () => {
  const text = testComment(failedAt(1));
  assert.match(text, /may or may not be caused by this change/);
});

test("a run that FIXES an already-red suite gets credit for it", () => {
  const text = testComment(passed(), failedAt(1));
  assert.match(text, /already failing on the base branch/);
  assert.match(text, /this change FIXED it/);
});

test("the red-suite nudge carries the real command, exit code and output", () => {
  const nudge = testsFailedNudge(failedAt(2, "go test ./..."));
  assert.match(nudge, /go test \.\/\.\.\./);
  assert.match(nudge, /exit 2/);
  assert.match(nudge, /1 failing/);
  assert.match(nudge, /Ship ran it, not you/, "so the agent cannot dispute it as its own claim");
  assert.match(nudge, /re-run the suite yourself to confirm it is green/);
});

/**
 * B5-d: the test command a repo gets when nobody typed one. These are pure
 * tree -> command cases; the forge read and the precedence rules live in
 * test-detect.test.ts.
 */
test("testTargetFromTree: package.json scripts.test wins, and carries the install the fresh clone needs", () => {
  const pkg = JSON.stringify({ scripts: { test: "vitest run" } });
  // A container over a fresh clone has no node_modules, so `pnpm test` alone
  // would report FAILED for a suite that never executed.
  assert.deepEqual(testTargetFromTree({ names: ["package.json", "pnpm-lock.yaml"], packageJson: pkg }), {
    command: "pnpm install --frozen-lockfile && pnpm test",
  });
  assert.deepEqual(testTargetFromTree({ names: ["package.json", "package-lock.json"], packageJson: pkg }), {
    command: "npm ci && npm test",
  });
  assert.deepEqual(testTargetFromTree({ names: ["package.json", "yarn.lock"], packageJson: pkg }), {
    command: "yarn install --frozen-lockfile && yarn test",
  });
  // No lockfile: install, not ci.
  assert.deepEqual(testTargetFromTree({ names: ["package.json"], packageJson: pkg }), {
    command: "npm install && npm test",
  });
  // packageManager is the repo's own statement and beats the lockfile.
  assert.deepEqual(
    testTargetFromTree({
      names: ["package.json", "package-lock.json"],
      packageJson: JSON.stringify({ packageManager: "pnpm@10.26.1", scripts: { test: "vitest" } }),
    }),
    { command: "pnpm install && pnpm test" },
  );
});

test("testTargetFromTree: npm's placeholder script is not a suite", () => {
  const pkg = JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } });
  // Falling through to go.mod is the point: `npm test` here exits 1 forever.
  assert.deepEqual(testTargetFromTree({ names: ["package.json", "go.mod"], packageJson: pkg }), { command: "go test ./..." });
  assert.equal(testTargetFromTree({ names: ["package.json"], packageJson: pkg }), undefined);
});

test("testTargetFromTree: a Makefile test target beats the language convention", () => {
  // Someone wrote `make test` on purpose; it usually carries the flags the
  // repo needs. It does NOT beat package.json, which is more specific still.
  assert.deepEqual(testTargetFromTree({ names: ["Makefile", "go.mod"], makefile: "test:\n\tgo test -race ./...\n" }), {
    command: "make test",
  });
  assert.deepEqual(testTargetFromTree({ names: ["Makefile", "go.mod"], makefile: ".PHONY: build\nbuild:\n\tgo build ./...\n" }), {
    command: "go test ./...",
  });
  // `pretest:` is not `test:`, and a mention inside a recipe is not a target.
  assert.deepEqual(testTargetFromTree({ names: ["Makefile", "go.mod"], makefile: "pretest:\n\t@echo run test:\n" }), {
    command: "go test ./...",
  });
});

test("testTargetFromTree: go, cargo, and pytest only on a real signal", () => {
  assert.deepEqual(testTargetFromTree({ names: ["go.mod", "main.go"] }), { command: "go test ./..." });
  assert.deepEqual(testTargetFromTree({ names: ["Cargo.toml", "src"] }), { command: "cargo test" });
  assert.deepEqual(testTargetFromTree({ names: ["pyproject.toml"], pyproject: "[tool.pytest.ini_options]\n" }), {
    command: "python3 -m pytest -q",
  });
  assert.deepEqual(testTargetFromTree({ names: ["conftest.py", "setup.py"] }), { command: "python3 -m pytest -q" });
  // Python with no pytest configuration gets NOTHING rather than a command
  // that exits 4 and reads as a failing suite.
  assert.equal(testTargetFromTree({ names: ["pyproject.toml", "app.py"], pyproject: "[project]\nname='x'\n" }), undefined);
  assert.equal(testTargetFromTree({ names: ["README.md", "LICENSE"] }), undefined);
});

test("testTargetFromTree: malformed package.json falls through instead of throwing", () => {
  assert.deepEqual(testTargetFromTree({ names: ["package.json", "go.mod"], packageJson: "{not json" }), { command: "go test ./..." });
});

test("testScopeNote: a root command over a change confined to one subtree is called out", () => {
  const note = testScopeNote("go test ./...", ["nucleus/src/executor/ddl.rs", "nucleus/tests/alter.rs"]);
  assert.ok(note !== undefined && note.includes("`nucleus/`") && note.includes("go test ./..."), note);
  assert.ok(note.includes("--test-command"), "tells the operator where the fix lives");
});

test("testScopeNote: silent when the root is touched, several trees are, or the command already points there", () => {
  assert.equal(testScopeNote("go test ./...", ["nucleus/src/a.rs", "go.mod"]), undefined, "a root file: the root command is right");
  assert.equal(testScopeNote("go test ./...", ["nucleus/src/a.rs", "go/pkg/b.go"]), undefined, "two trees: no single scope to name");
  assert.equal(testScopeNote("cd nucleus && cargo test --lib -q", ["nucleus/src/a.rs"]), undefined, "the command names the tree");
  assert.equal(testScopeNote("go test ./...", []), undefined, "no changes, nothing to say");
});
