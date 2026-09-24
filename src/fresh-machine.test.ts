import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentExecutor } from "@neutron-build/agents";
import type { WorkflowEvent } from "@neutron-build/workflow";

import { diagnoseGitFailure, explainRun, withWorkers } from "./explain.js";
import { parseRepoUrl, setupRepo } from "./git.js";
import { detectFromWorkspace } from "./test-detect.js";
import { missingRunner, runTests, testComment } from "./tests.js";

// Pins for the code-level findings of the S19 fresh-machine pass
// (_internal/FRESH_MACHINE_REPORT.md): F10, F15, F16, F17. F9 is pinned in
// deployment-asks.test.ts.

type Exec = { exitCode: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean };

/** An executor that answers each command through `answer`, recording what ran. */
function executor(answer: (command: string) => Partial<Exec>) {
  const commands: string[] = [];
  const ex = {
    async exec(command: string) {
      commands.push(command);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...answer(command) };
    },
  } as unknown as AgentExecutor;
  return { ex, commands };
}

let seq = 0;
function ev(type: string, name?: string, data?: unknown): WorkflowEvent {
  return { v: 1, seq: seq++, type, at: "2026-09-24T00:00:00Z", ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}) } as WorkflowEvent;
}
const started = () => ev("run-started", undefined, { input: { task: "fix the parser" } });

// --- F10 -------------------------------------------------------------------

test("F10: `python3 -m pytest` in an image without pytest is NOT RUN, not a failed (or pre-existing) suite", async () => {
  const { ex } = executor(() => ({ exitCode: 1, stderr: "/usr/bin/python3: No module named pytest\n" }));
  const baseline = await runTests(ex, { command: "python3 -m pytest -q" });
  const after = await runTests(ex, { command: "python3 -m pytest -q" });
  assert.equal(after.kind, "errored");
  const line = testComment(after, baseline);
  assert.match(line, /not run/);
  assert.match(line, /pytest/);
  assert.doesNotMatch(line, /FAILED|already failing|pre-existing/, "run-136c07d4 blamed the repo for the image");
});

test("F10: exit 127 (runner not on PATH) is not run; a real failure, including a test's own missing import, stays failed", async () => {
  const missing = await runTests(executor(() => ({ exitCode: 127, stderr: "sh: 1: go: not found\n" })).ex, { command: "go test ./..." });
  assert.equal(missing.kind, "errored");
  assert.match(testComment(missing), /go: not found/);

  const real = await runTests(executor(() => ({ exitCode: 1, stdout: "FAILED test_parser.py::test_split\n" })).ex, { command: "python3 -m pytest -q" });
  assert.equal(real.kind, "failed");
  assert.equal(
    missingRunner("python3 -m pytest -q", 1, "E   ModuleNotFoundError: No module named 'requests'"),
    undefined,
    "a test importing its own missing dependency is a real failure",
  );
  assert.notEqual(missingRunner("python3 -m pytest -q", 1, "No module named 'pytest'"), undefined);
});

// --- F16 -------------------------------------------------------------------

test("F16: the worker detects the suite from its own checkout when the enqueue could not read the forge", async () => {
  const files: Record<string, string> = {
    "ls -A1": ".git\npackage.json\npackage-lock.json\nsrc\n",
    "head -c 262144 package.json": JSON.stringify({ scripts: { test: "node --test" } }),
  };
  const { ex, commands } = executor((c) => (c in files ? { stdout: files[c]! } : { exitCode: 1 }));
  const target = await detectFromWorkspace(ex, {});
  assert.deepEqual(target, { command: "npm ci && npm test" });
  assert.ok(!commands.some((c) => c.includes("Makefile")), "only files that exist are read");

  const py = executor((c) => (c === "ls -A1" ? { stdout: "pytest.ini\nparser.py\n" } : { exitCode: 1 }));
  assert.deepEqual(await detectFromWorkspace(py.ex, {}), { command: "python3 -m pytest -q" });
});

test("F16: SHIP_TEST_DETECT=0 on the worker turns checkout detection off; an unreadable checkout detects nothing", async () => {
  const { ex, commands } = executor(() => ({ stdout: "go.mod\n" }));
  assert.equal(await detectFromWorkspace(ex, { SHIP_TEST_DETECT: "0" }), undefined);
  assert.equal(commands.length, 0);
  assert.equal(await detectFromWorkspace(executor(() => ({ exitCode: 2 })).ex, {}), undefined);
  const throwing = { async exec() { throw new Error("container gone"); } } as unknown as AgentExecutor;
  assert.equal(await detectFromWorkspace(throwing, {}), undefined);
});

// --- F17 -------------------------------------------------------------------

test("F17: a failed clone's words reach the error (they were in stdout via 2>&1), with the token redacted", async () => {
  const ref = parseRepoUrl("http://forge.example:3000/tyler/fixture");
  const { ex } = executor((c) =>
    c.startsWith("git clone")
      ? { exitCode: 128, stdout: "Cloning into '.'...\nfatal: Authentication failed for 'http://forge.example:3000/tyler/fixture.git/'\n" }
      : {},
  );
  const err = await setupRepo(ex, { ref, token: "tok-SECRET", runId: "run-x" }).then(
    () => assert.fail("clone should fail"),
    (e: Error) => e.message,
  );
  assert.match(err, /Authentication failed/);
  assert.doesNotMatch(err, /tok-SECRET/);
});

test("F17: explain names the cause family for egress, credential, missing repo and network failures", () => {
  const fail = (words: string) => `Step "repo-setup" failed: git step failed (exit 128): git clone --depth 50 http://***@forge.example/tyler/fixture.git . 2>&1\n${words}`;
  const cases: Array<[string, string, RegExp]> = [
    ["fatal: unable to access '…': Received HTTP code 403 from proxy after CONNECT", "egress", /egress allowlist/],
    ["fatal: Authentication failed for 'http://forge.example/tyler/fixture.git/'", "auth", /SHIP_GIT_TOKEN/],
    ["remote: Not found.\nfatal: repository 'http://forge.example/tyler/fixture.git/' not found", "not-found", /--repo URL/],
    ["fatal: unable to access '…': Failed to connect to 172.31.99.1 port 39927 after 130001 ms: Connection timed out", "network", /firewall/],
  ];
  for (const [words, kind, next] of cases) {
    assert.equal(diagnoseGitFailure(fail(words))?.kind, kind, words);
    const e = explainRun([started(), ev("step-failed", "repo-setup", { error: fail(words) }), ev("run-failed", undefined, { error: fail(words) })]);
    assert.equal(e.headline, "Could not check out the repository.");
    assert.match(e.nextStep, next);
    assert.doesNotMatch(e.nextStep, /fault in Ship/, "the old framing blamed Ship for the network");
  }
  assert.equal(diagnoseGitFailure("boom"), undefined, "not a git failure, no diagnosis");
  assert.equal(diagnoseGitFailure("git step failed (exit 128): git clone x\n")?.kind, "unknown");
});

// --- F15 -------------------------------------------------------------------

test("F15: a queued run with no live worker says so and names the boot crash-loop, instead of 'Still running'", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const events = [started()];
  const base = explainRun(events);
  assert.equal(base.headline, "Still running.", "the log alone cannot tell");

  const none = withWorkers(base, events, [], now);
  assert.match(none.headline, /no worker is alive/);
  assert.match(none.stoppedAt, /No worker has ever checked in/);
  assert.match(none.nextStep, /Restarting/);
  assert.match(none.nextStep, /a sandbox URL is set but no token/);
  assert.equal(none.needsAttention, true);

  const stale = withWorkers(base, events, [{ lastSeen: "2026-09-24T11:30:00Z" }], now);
  assert.match(stale.stoppedAt, /30 min ago/);

  const alive = withWorkers(base, events, [{ lastSeen: "2026-09-24T11:59:50Z" }], now);
  assert.match(alive.headline, /waiting for a worker to claim it/);
  assert.equal(alive.needsAttention, false);
});

test("F15: ended and parked runs are left alone — neither needs a worker", () => {
  const now = Date.now();
  const done = [started(), ev("run-completed", undefined, { output: { status: "finished", pr: "http://x/pulls/1" } })];
  assert.deepEqual(withWorkers(explainRun(done), done, [], now), explainRun(done));
  const parked = [started(), ev("step-completed", "sandbox"), ev("event-waiting", "turn-1-approval")];
  assert.deepEqual(withWorkers(explainRun(parked), parked, [], now), explainRun(parked));
});
