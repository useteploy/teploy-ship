import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkflowEvent } from "@neutron-build/workflow";

import { recordedSteps, toTimeline } from "./timeline.js";

const T0 = "2026-08-24T12:00:00.000Z";
const T1 = "2026-08-24T12:01:00.000Z";

function done(name: string, result: unknown, seq: number, at = T0): WorkflowEvent {
  return { v: 1, seq, type: "step-completed", at, name, data: { result } };
}

test("recordedSteps: exec-shaped results summarise as the exit code, with the turn attached", () => {
  const steps = recordedSteps([
    done("turn-1-exec", { exitCode: 0, stdout: "ok", stderr: "" }, 3),
    done("turn-2-exec", { exitCode: 2, stdout: "", stderr: "boom" }, 5, T1),
  ]);
  assert.deepEqual(steps[0], { name: "turn-1-exec", at: T0, summary: "exit 0", failed: false, turn: 1 });
  assert.deepEqual(steps[1], { name: "turn-2-exec", at: T1, summary: "exit 2", failed: true, turn: 2 });
});

test("recordedSteps: evidence steps summarise as the outcome kind, not the payload", () => {
  const steps = recordedSteps([
    done("tests", { kind: "passed", command: "pnpm test", durationMs: 4500 }, 1),
    done("tests", { kind: "failed", command: "pnpm test", durationMs: 9000, exitCode: 2, output: "3 failing" }, 2),
    done("preview-deploy", { kind: "skipped", reason: "no preview target configured on this worker" }, 3),
    done("telemetry-check", { kind: "insufficient", reason: "not enough traffic", before: null, after: null }, 4),
    done("repo-push", { kind: "pushed", sha: "0123456789abcdef" }, 5),
    done("repo-push", { kind: "refused", message: "diff exceeds the publish limit" }, 6),
  ]);
  assert.deepEqual(
    steps.map((s) => [s.summary, s.failed]),
    [
      ["passed", false],
      ["failed (exit 2)", true],
      ["skipped", false],
      ["insufficient", false],
      ["pushed", false],
      ["refused", true],
    ],
  );
  // The failed suite's output is deliberately NOT in the row — the timeline
  // carries the full payload; this is the index.
  assert.ok(!steps[1]!.summary.includes("failing"));
});

test("recordedSteps: repo-pr summarises as the PR number, think steps as the first line", () => {
  const steps = recordedSteps([
    done("repo-pr", { url: "https://git.example.com/tyler/a/pulls/41", number: 41 }, 1),
    done("turn-1-think", { text: "I will fix the parser.\n```bash\ngrep parser src\n```", usage: { inputTokens: 100 } }, 2),
  ]);
  assert.equal(steps[0]!.summary, "PR #41");
  assert.equal(steps[1]!.summary, "I will fix the parser.");
});

test("recordedSteps: string results give their first line, bounded; unknown objects never dump", () => {
  const long = `index refresh failed: ${"x".repeat(300)}`;
  const steps = recordedSteps([
    done("repo-index", "412 files indexed (3109 chunks), 12 removed of 424 tracked", 1),
    done("repo-index", long, 2),
    done("sandbox", { handle: "abc", mounts: ["a", "b", "c"] }, 3),
  ]);
  assert.equal(steps[0]!.summary, "412 files indexed (3109 chunks), 12 removed of 424 tracked");
  assert.ok(steps[1]!.summary.length <= 120, "a summary that scrolls stops summarising");
  assert.ok(steps[1]!.summary.endsWith("…"));
  assert.ok(!steps[2]!.summary.includes("\n"), "unknown objects render as one bounded line of compact JSON");
});

test("recordedSteps: order follows the log, non-step events are skipped, run-level steps carry no turn", () => {
  const events: WorkflowEvent[] = [
    { v: 1, seq: 0, type: "run-started", at: T0, data: { input: { task: "t" } } },
    done("sandbox", "sb-1", 1),
    done("turn-1-think", { text: "first" }, 2),
    done("turn-1-exec", { exitCode: 0, stdout: "", stderr: "" }, 3),
    done("repo-push", { kind: "pushed", sha: "0123456789abcdef" }, 4, T1),
    done("turn-2-fingerprint", "clean", 5, T1),
    { v: 1, seq: 6, type: "run-completed", at: T1, data: { output: {} } },
  ];
  const steps = recordedSteps(events);
  assert.deepEqual(
    steps.map((s) => [s.name, s.turn]),
    [
      ["sandbox", undefined],
      ["turn-1-think", 1],
      ["turn-1-exec", 1],
      ["repo-push", undefined],
      ["turn-2-fingerprint", 2],
    ],
  );
  assert.equal(steps[0]!.at, T0, "rows keep the event's own timestamp for ordering");
});

test("a turn the sandbox blocked says so on its collapsed row, once, with the remedy beside it", () => {
  const events: WorkflowEvent[] = [
    { v: 1, seq: 0, type: "run-started", at: T0, data: { input: { task: "add a gem" } } },
    done("turn-1-think", { text: "```bash\nbundle install\n```" }, 1),
    done("turn-1-exec", { exitCode: 1, stdout: "", stderr: "Net::HTTPForbidden: egress denied by the sandbox allowlist: rubygems.org" }, 2),
    done("turn-2-think", { text: "```bash\nbundle install --retry 3\n```" }, 3),
    done("turn-2-exec", { exitCode: 1, stdout: "", stderr: "egress denied by the sandbox allowlist: rubygems.org" }, 4, T1),
  ];
  const items = toTimeline(events);
  const turns = items.filter((i) => i.kind === "turn");
  assert.equal(turns[0]!.blockedHost, "rubygems.org", "a blocked host is not just 'exit 1'");
  assert.equal(turns[1]!.blockedHost, "rubygems.org");
  const notes = items.filter((i) => i.title.startsWith("sandbox blocked"));
  assert.equal(notes.length, 1, "the remedy once, not per turn — five identical notes teach a reader to scroll");
  assert.match(notes[0]!.body, /egress allowlist/);
  assert.match(notes[0]!.body, /project set/);
  assert.equal(items.indexOf(notes[0]!), items.indexOf(turns[0]!) + 1, "it reads in the order it happened");
});

test("an ordinary failure is never called a network block", () => {
  const items = toTimeline([
    { v: 1, seq: 0, type: "run-started", at: T0, data: { input: { task: "t" } } },
    done("turn-1-exec", { exitCode: 1, stdout: "", stderr: "curl: (6) Could not resolve host: rubygems.org" }, 1),
    done("turn-2-exec", { exitCode: 0, stdout: "egress denied by the sandbox allowlist: x.com", stderr: "" }, 2),
  ] as WorkflowEvent[]);
  assert.equal(items.filter((i) => i.blockedHost !== undefined).length, 0);
  assert.equal(items.filter((i) => i.title.startsWith("sandbox blocked")).length, 0);
});

test("a run downgraded off the open network says so at the top, derived from the recorded input alone", () => {
  const external = toTimeline([
    { v: 1, seq: 0, type: "run-started", at: T0, data: { input: { task: "t", trust: "external", sandboxNetwork: "open" } } },
  ] as WorkflowEvent[]);
  assert.equal(external[1]!.title, "sandbox network downgraded to allowlist");
  assert.match(external[1]!.body, /came from outside/);

  const operator = toTimeline([
    { v: 1, seq: 0, type: "run-started", at: T0, data: { input: { task: "t", trust: "operator", sandboxNetwork: "open" } } },
  ] as WorkflowEvent[]);
  assert.equal(operator.length, 1, "the operator's own run is not downgraded and gets no note");

  // A log written before three tiers existed: `egress` is the alias, not `open`.
  const legacy = toTimeline([
    { v: 1, seq: 0, type: "run-started", at: T0, data: { input: { task: "t", trust: "external", sandboxNetwork: "egress" } } },
  ] as WorkflowEvent[]);
  assert.equal(legacy.length, 1);
});
