import assert from "node:assert/strict";
import { test } from "node:test";

import type { WorkflowEvent } from "@neutron-build/workflow";

import {
  SUMMARY_LIMIT,
  runVerificationSummary,
  verificationFactsFromEvents,
  verificationSummary,
  type VerificationFacts,
} from "./verification-summary.js";

function ev(type: WorkflowEvent["type"], name: string | undefined, data: unknown, seq: number): WorkflowEvent {
  return { v: 1, seq, type, at: "2026-08-28T00:00:00.000Z", ...(name !== undefined ? { name } : {}), data } as WorkflowEvent;
}

function step(name: string, result: unknown, seq: number): WorkflowEvent {
  return ev("step-completed", name, { result }, seq);
}

test("the paragraph cannot claim a verification no step recorded", () => {
  // The exact failure the file exists for: an agent that says "all tests
  // pass" over a run whose suite step says `failed`.
  const text = verificationSummary({
    agent: "All tests pass and the feature is complete.",
    tests: { kind: "failed", command: "pnpm test", durationMs: 5_000, exitCode: 1, output: "boom" },
  });
  assert.match(text, /suite FAILED/);
  assert.doesNotMatch(text, /suite passed/);
  assert.match(text, /^What I did: All tests pass and the feature is complete/);
});

test("an exhausted bound says so, with the numbers a reader audits", () => {
  const text = verificationSummary({
    agent: "Gave it two shots.",
    baseline: { kind: "passed", command: "pnpm test", durationMs: 1_000 },
    tests: { kind: "failed", command: "pnpm test", durationMs: 5_000, exitCode: 1, output: "boom" },
    fixAttempts: 2,
    fixRetries: 2,
    fixExhausted: { attempts: 2, exitCode: 1 },
  });
  assert.match(text, /still red \(exit 1\) after 2 of 2 fix attempts/);
  assert.match(text, /needs a human/);
  assert.match(text, /suite passed on the base branch before any edit/);
});

test("a green finish after a red one counts the attempt it cost", () => {
  const text = verificationSummary({
    agent: "Fixed it.",
    tests: { kind: "passed", command: "pnpm test", durationMs: 5_000 },
    fixAttempts: 1,
  });
  assert.match(text, /suite passed over the published tree.*after 1 fix attempt on a red suite/);
});

test("merge outcomes read differently by who authorised them", () => {
  const base = { agent: "Done.", tests: { kind: "passed" as const, command: "t", durationMs: 1 } };
  assert.match(verificationSummary({ ...base, merge: { kind: "merged", via: "auto" } }), /merged it under the repo's auto-merge authority/);
  assert.match(verificationSummary({ ...base, merge: { kind: "merged", via: "approved" } }), /merged it on the approved merge decision/);
  assert.match(verificationSummary({ ...base, merge: { kind: "held", reasons: ["the change classified serious"] } }), /auto-merge held: the change classified serious/);
  assert.match(verificationSummary({ ...base, merge: { kind: "closed", reason: "too risky" } }), /merge was denied and the pull request closed \(too risky\)/);
  assert.match(verificationSummary({ ...base, merge: { kind: "blocked", reasons: ["suite did not pass after the rebase"] } }), /approved but blocked/);
});

test("the critic is reported as advisory, and never as a gate", () => {
  const withSuite = verificationSummary({
    agent: "Done.",
    tests: { kind: "passed", command: "t", durationMs: 1 },
    critic: { approved: false, notes: "risk: no test covers the new branch" },
  });
  assert.match(withSuite, /critic reviewed the diff after the suite and left risk notes \(advisory/);
  // Without a suite the sentence must not imply one ran.
  const noSuite = verificationSummary({ agent: "Done.", critic: { approved: false, notes: "risk" } });
  assert.match(noSuite, /critic reviewed the diff and left risk notes/);
  assert.doesNotMatch(noSuite, /after the suite/);
});

test("the paragraph is clipped to the wire budget", () => {
  // The renderer copies commands and reasons verbatim — those are the fields
  // that can inflate a paragraph past the budget, not the failure output.
  const long = "x".repeat(900);
  const text = verificationSummary({
    agent: "done",
    baseline: { kind: "passed", command: `sh ${long}`, durationMs: 1 },
    tests: { kind: "failed", command: `sh ${long}`, durationMs: 2, exitCode: 1, output: "nope" },
    telemetry: { kind: "unavailable", reason: long },
  });
  assert.equal(text.length, SUMMARY_LIMIT);
  assert.ok(text.endsWith("…"));
});

test("a run that ended before its finish gate says the suite never ran over the change", () => {
  const text = verificationSummary({
    status: "failed",
    baseline: { kind: "passed", command: "t", durationMs: 1 },
  });
  assert.match(text, /run ended as failed/);
  assert.match(text, /the suite never ran over the change/);
});

test("the extractor reads the same facts the workflow held, and renders the same bytes", () => {
  // A serious repo run that iterated twice, stayed red, was reviewed by the
  // critic, pushed, opened a draft PR and parked at the merge boundary — every
  // producer of facts in one log.
  const events: WorkflowEvent[] = [
    ev("run-started", undefined, { workflow: "coding-agent", input: { task: "t", fixRetries: 2 } }, 0),
    step("baseline-tests", { kind: "passed", command: "pnpm test", durationMs: 1_000 }, 1),
    step("turn-4-finish-tests", { kind: "failed", command: "pnpm test", durationMs: 2_000, exitCode: 1, output: "wrong" }, 2),
    step("turn-6-finish-tests", { kind: "failed", command: "pnpm test", durationMs: 2_000, exitCode: 1, output: "wrong" }, 3),
    step("turn-6-fix-exhausted", { kind: "failed", attempts: 2, bound: 2, command: "pnpm test", exitCode: 1, output: "wrong", diff: "diff --git a/a b/a" }, 4),
    step("turn-6-critic-diff", "diff --git a/a b/a", 5),
    step("turn-6-critic", { reviewed: true, text: "Needs more work." }, 6),
    step("change-class", { class: "serious", reasons: ["touches auth"], files: [{ path: "a" }] }, 7),
    step("repo-push", { kind: "pushed", sha: "3a2bebe28e9c9d1f0a4b5c6d7e8f9a0b1c2d3e4f" }, 8),
    step("repo-pr", { url: "http://example/pulls/5", number: 5 }, 9),
    step("auto-merge", { kind: "held", reasons: ["the change classified serious, and only trivial merges unattended"] }, 10),
    step("merge-park", { attempt: 1, class: "serious", reasons: [], pr: "http://example/pulls/5" }, 11),
    step("merge-decision", { kind: "merged", rebase: "up-to-date", sha: "abc" }, 12),
    ev("run-completed", undefined, { output: { status: "finished", agentSummary: "Two shots, still red." } }, 13),
  ];

  const facts = verificationFactsFromEvents(events);
  assert.equal(facts.fixRetries, 2);
  assert.equal(facts.fixExhausted?.attempts, 2);
  assert.equal(facts.fixAttempts, 2, "the exhausted finish's own suite run is the attached failure, not an attempt sent back to work");
  assert.equal(facts.tests?.kind, "failed");
  assert.equal(facts.baseline?.kind, "passed");
  assert.deepEqual(facts.critic, { approved: false, notes: "Needs more work." });
  assert.deepEqual(facts.changeClass, { class: "serious", files: 1 });
  assert.equal(facts.push?.kind, "pushed");
  assert.deepEqual(facts.pr, { url: "http://example/pulls/5", number: 5 });
  assert.equal(facts.merge?.kind, "merged");
  assert.equal((facts.merge as { via?: string }).via, "approved", "the boundary decision supersedes the held auto-merge");
  assert.equal(facts.agent, "Two shots, still red.");

  const fromLog = runVerificationSummary(events);
  const direct: VerificationFacts = {
    agent: "Two shots, still red.",
    status: "finished",
    baseline: { kind: "passed", command: "pnpm test", durationMs: 1_000 },
    tests: { kind: "failed", command: "pnpm test", durationMs: 2_000, exitCode: 1, output: "wrong" },
    fixAttempts: 2,
    fixRetries: 2,
    fixExhausted: { attempts: 2, exitCode: 1 },
    critic: { approved: false, notes: "Needs more work." },
    changeClass: { class: "serious", files: 1 },
    push: { kind: "pushed", sha: "3a2bebe28e9c9d1f0a4b5c6d7e8f9a0b1c2d3e4f" },
    pr: { url: "http://example/pulls/5", number: 5 },
    merge: { kind: "merged", via: "approved" },
  };
  assert.equal(fromLog, verificationSummary(direct));
  assert.match(fromLog, /still red \(exit 1\) after 2 of 2 fix attempts/);
  assert.match(fromLog, /merged it on the approved merge decision/);
});

test("the browser flow is reported from its recorded outcome, never from the agent's account", () => {
  const passed = verificationSummary({
    agent: "Added the settings link and the flow proves it.",
    flow: { kind: "passed", script: ".ship/flow.mjs", durationMs: 3000, shots: [{ name: "01.png", sha256: "a", bytes: 1, asset: "http://f/1.png" }, { name: "02.png", sha256: "b", bytes: 1 }] },
  });
  assert.match(passed, /What I verified: the browser flow passed \(`\.ship\/flow\.mjs`, 2 screenshots on the pull request\)/);
  const failed = verificationSummary({ flow: { kind: "failed", script: ".ship/flow.mjs", exitCode: 1, output: "boom", shots: [] } });
  assert.match(failed, /could not verify: .*the browser flow FAILED \(`\.ship\/flow\.mjs`, exit 1\)/);
  const none = verificationSummary({ flow: { kind: "skipped", reason: "no .ship/flow.mjs in the tree: the agent wrote no browser flow for this change" } });
  assert.match(none, /no browser flow \(no \.ship\/flow\.mjs/);

  // The extractor reads the recorded `flow` step, shots and attachments included.
  const events: WorkflowEvent[] = [
    ev("run-started", undefined, { workflow: "coding-agent", input: { task: "t" } }, 0),
    step("flow", { kind: "passed", script: ".ship/flow.mjs", durationMs: 3000, shots: [{ name: "01.png", sha256: "a", bytes: 1, asset: "http://f/1.png" }] }, 1),
    step("visual-diff", { kind: "captured", preview: { url: "p", sha256: "a", bytes: 1, asset: "http://f/p.png" }, main: { url: "m", sha256: "b", bytes: 1 }, differs: true, pixels: { differing: 3, total: 9 } }, 2),
    ev("run-completed", undefined, { output: { status: "finished" } }, 3),
  ];
  const facts = verificationFactsFromEvents(events);
  assert.deepEqual(facts.flow, { kind: "passed", script: ".ship/flow.mjs", durationMs: 3000, shots: [{ name: "01.png", sha256: "a", bytes: 1, asset: "http://f/1.png" }] });
  assert.equal(facts.visual?.kind, "captured");
  if (facts.visual?.kind === "captured") {
    assert.deepEqual(facts.visual.pixels, { differing: 3, total: 9 });
    assert.equal(facts.visual.preview.asset, "http://f/p.png");
    assert.equal(facts.visual.main.asset, undefined);
  }
  assert.match(runVerificationSummary(events), /attached to the pull request/);
});
