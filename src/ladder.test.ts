import test from "node:test";
import assert from "node:assert/strict";
import type { WorkflowEvent } from "@neutron-build/workflow";

import {
  AUTHORITIES,
  authorityCap,
  effectiveAuthority,
  isAuthority,
  ladderGate,
  ladderRungs,
  ladderRungsFromEvents,
  minAuthority,
  normalizeVerification,
  rungsForWire,
  type LadderFacts,
  type ProjectVerification,
  type Rung,
} from "./ladder.js";

const ALL_RUNGS: ProjectVerification = {
  build: "pnpm build",
  tests: "pnpm test",
  preview: { app: "site", smoke: "curl -fsS $PREVIEW_URL/" },
  visual: true,
  observeWindowMin: 5,
};

test("C4: the declared rungs cap the authority a project can hold", () => {
  assert.equal(authorityCap(undefined), "send", "no ladder at all means nothing unattended");
  assert.equal(authorityCap({}), "send");
  assert.equal(authorityCap({ build: "make" }), "send", "build alone proves nothing about correctness");
  assert.equal(authorityCap({ tests: "pnpm test" }), "send", "tests without a preview never passes send");
  assert.equal(authorityCap({ tests: "pnpm test", preview: { app: "site", smoke: "true" } }), "send", "preview without visual stays at send");
  assert.equal(authorityCap({ tests: "pnpm test", preview: { app: "site", smoke: "true" }, visual: true }), "auto_trivial");
  assert.equal(authorityCap(ALL_RUNGS), "auto_normal", "every rung reaches auto_normal");
  assert.equal(
    authorityCap({ tests: "pnpm test", preview: { app: "site", smoke: "true" }, visual: true, observeWindowMin: 5 }),
    "auto_normal",
  );
});

test("C4: effectiveAuthority is the setting, capped by the ladder, floored by neverAuto", () => {
  // The cap beats the asking.
  assert.equal(effectiveAuthority({ authority: "auto_normal", verification: { tests: "pnpm test" } }), "send");
  assert.equal(
    effectiveAuthority({ authority: "auto_normal", verification: { tests: "pnpm test", preview: { app: "s", smoke: "t" }, visual: true } }),
    "auto_trivial",
  );
  assert.equal(effectiveAuthority({ authority: "auto_normal", verification: ALL_RUNGS }), "auto_normal");
  // The legacy flag is NOT read here: a record with nothing authority-shaped
  // declared stays on the legacy merge gate (runtime.ts materialises no
  // authority for it), and folding the flag into the capped world would
  // silently freeze repos whose flag still says on.
  assert.equal(effectiveAuthority({ autoMerge: true } as never), "send");
  assert.equal(effectiveAuthority({ autoMerge: true, verification: { tests: "pnpm test" } } as never), "send");
  // neverAuto floors everything at send, whatever else is set.
  assert.equal(effectiveAuthority({ authority: "auto_normal", verification: ALL_RUNGS, neverAuto: true }), "send");
  assert.equal(effectiveAuthority({ authority: "auto_normal", neverAuto: true }), "send");
  // Absent everything, the honest default is send: a PR, and a human merges.
  assert.equal(effectiveAuthority({}), "send");
  // minAuthority orders the four values.
  for (const a of AUTHORITIES) {
    for (const b of AUTHORITIES) {
      assert.equal(minAuthority(a, b), AUTHORITIES.indexOf(a) <= AUTHORITIES.indexOf(b) ? a : b);
    }
  }
});

test("normalizeValidation: trims, drops empties, refuses a half-declared preview and a bad window", () => {
  assert.equal(normalizeVerification(undefined), undefined);
  assert.equal(normalizeVerification({}), undefined);
  assert.deepEqual(normalizeVerification({ build: "  pnpm build  ", tests: "" }), { build: "pnpm build" });
  assert.throws(() => normalizeVerification({ preview: { app: "site", smoke: "" } as never }), /both app and smoke/);
  assert.throws(() => normalizeVerification({ observeWindowMin: 2.5 } as never), /whole number of minutes/);
  assert.throws(() => normalizeVerification({ observeWindowMin: -1 } as never), /whole number of minutes/);
  assert.equal(normalizeVerification({ observeWindowMin: 0 } as never), undefined, "a zero window is no window");
  assert.deepEqual(normalizeVerification(ALL_RUNGS), ALL_RUNGS);
  assert.equal(isAuthority("auto_trivial"), true);
  assert.equal(isAuthority("auto"), false);
});

/** All rungs green, over the full declaration. */
function greenFacts(verification: ProjectVerification = ALL_RUNGS): LadderFacts {
  return {
    verification,
    testsDeclared: true,
    baseline: { kind: "passed", command: "pnpm test", durationMs: 1000 },
    build: { kind: "passed", command: "pnpm build", durationMs: 2000 },
    tests: { kind: "passed", command: "pnpm test", durationMs: 1500 },
    preview: { kind: "deployed", url: "https://preview-ship-abc.site.example.com" },
    smoke: { kind: "passed", command: "curl -fsS $PREVIEW_URL/", durationMs: 300 },
    visual: { kind: "captured", preview: { url: "https://p", sha256: "a", bytes: 1 }, main: { url: "https://m", sha256: "b", bytes: 1 }, differs: true },
    observe: { kind: "healthy", windowMin: 5, reasons: ["error rate +0.00%, p95 +0ms — inside the thresholds"] },
  };
}

test("ladderRungs: six rungs, in ladder order, every one accounted for", () => {
  const rungs = ladderRungs(greenFacts());
  assert.deepEqual(
    rungs.map((r) => r.name),
    ["baseline", "build", "tests", "preview", "visual", "observe"],
  );
  assert.deepEqual(
    rungs.map((r) => r.status),
    ["passed", "passed", "passed", "passed", "passed", "passed"],
  );
  // A rung that ran reports WHAT it saw, not just that it ran.
  assert.match(rungs[3]!.detail!, /smoke passed/);
  assert.match(rungs[4]!.detail!, /they differ/);
});

test("ladderRungs: a red baseline is recorded evidence, not a failed rung; a red suite is a failed one", () => {
  const rungs = ladderRungs({ ...greenFacts(), baseline: { kind: "failed", command: "pnpm test", durationMs: 900, exitCode: 1, output: "boom" } });
  const baseline = rungs.find((r) => r.name === "baseline")!;
  assert.equal(baseline.status, "passed", "the rung is satisfied by a RECORDED baseline; inherited breakage is the detail's to say");
  assert.match(baseline.detail!, /failed before the agent edited/);

  const red = ladderRungs({ ...greenFacts(), tests: { kind: "failed", command: "pnpm test", durationMs: 900, exitCode: 2, output: "1 failing" } });
  assert.equal(red.find((r) => r.name === "tests")!.status, "failed");
});

test("ladderRungs: a declared rung that did not run is skipped WITH a reason, never omitted", () => {
  const rungs = ladderRungs({
    verification: ALL_RUNGS,
    testsDeclared: true,
    baseline: undefined,
    build: undefined,
    tests: undefined,
    preview: undefined,
    smoke: undefined,
    visual: undefined,
    observe: undefined,
  });
  assert.deepEqual(
    rungs.map((r) => r.status),
    ["skipped", "skipped", "skipped", "skipped", "skipped", "skipped"],
  );
  assert.match(rungs[2]!.detail!, /the suite did not run/);
  // The preview rung fuses deploy and smoke: a deployed preview whose smoke
  // never ran is still not a passed preview.
  const noSmoke = ladderRungs({ ...greenFacts(), smoke: undefined });
  assert.equal(noSmoke.find((r) => r.name === "preview")!.status, "skipped");
  const badSmoke = ladderRungs({ ...greenFacts(), smoke: { kind: "failed", command: "curl", exitCode: 7, output: "connection refused" } });
  assert.equal(badSmoke.find((r) => r.name === "preview")!.status, "failed");
});

test("ladderGate: reads only the rungs, the authority and the class — and says why it held", () => {
  const green = ladderRungs(greenFacts());
  assert.deepEqual(ladderGate({ rungs: green, authority: "auto_normal", changeClass: "trivial", draft: false }), { allowed: true, reasons: [] });
  assert.deepEqual(ladderGate({ rungs: green, authority: "auto_normal", changeClass: "normal", draft: false }), { allowed: true, reasons: [] }, "auto_normal merges normal changes too");

  const held = (r: { rungs: Rung[]; authority: string; changeClass?: "trivial" | "normal" | "serious"; draft?: boolean }): string[] =>
    ladderGate({ rungs: r.rungs, authority: r.authority as never, ...(r.changeClass !== undefined ? { changeClass: r.changeClass } : {}), draft: r.draft ?? false }).reasons;
  assert.match(held({ rungs: green, authority: "auto_trivial", changeClass: "normal" }).join(), /normal, and auto_trivial merges only trivial/);
  assert.match(held({ rungs: green, authority: "auto_normal", changeClass: "serious" }).join(), /serious/);
  assert.match(held({ rungs: green, authority: "send" }).join(), /never merges unattended/);
  assert.match(held({ rungs: green, authority: "auto_normal" }).join(), /never classified/);
  assert.match(held({ rungs: green, authority: "auto_normal", changeClass: "trivial", draft: true }).join(), /draft/);

  // A rung that failed holds whatever the class said.
  const red = ladderRungs({ ...greenFacts(), tests: { kind: "failed", command: "pnpm test", durationMs: 1, exitCode: 1, output: "x" } });
  assert.match(held({ rungs: red, authority: "auto_normal", changeClass: "trivial" }).join(), /tests failed/);

  // A rung an authority REQUIRES that did not run holds — a declared rung
  // skipped on the day is not evidence.
  const noVisual = ladderRungs({ ...greenFacts(), visual: { kind: "skipped", reason: "the sandbox image has no headless browser" } });
  assert.match(held({ rungs: noVisual, authority: "auto_trivial", changeClass: "trivial" }).join(), /visual did not run/);
  const noObserve = ladderRungs({ ...greenFacts(), observe: { kind: "insufficient", windowMin: 5, reason: "too little traffic" } });
  assert.match(held({ rungs: noObserve, authority: "auto_normal", changeClass: "trivial" }).join(), /observe did not run/);

  // Nothing recorded at all.
  assert.match(held({ rungs: [], authority: "auto_normal", changeClass: "trivial" }).join(), /no rungs were recorded/);

  // A declared build that failed holds even at send-adjacent authorities,
  // because "when declared it must pass" is a fact about the ladder, not the rung list.
  const redBuild = ladderRungs({ ...greenFacts(), build: { kind: "failed", command: "pnpm build", durationMs: 1, exitCode: 1, output: "" } });
  assert.match(held({ rungs: redBuild, authority: "auto_normal", changeClass: "trivial" }).join(), /build failed/);
});

test("rungsForWire clips long details and keeps the wire shape", () => {
  const wired = rungsForWire([{ name: "tests", status: "failed", detail: "x".repeat(2000) }]);
  assert.ok((wired[0]!.detail?.length ?? 0) <= 600);
  assert.deepEqual(Object.keys(wired[0]!).sort(), ["detail", "name", "status"]);
  assert.deepEqual(rungsForWire([{ name: "baseline", status: "passed" }]), [{ name: "baseline", status: "passed" }]);
});

// --- the second producer: rungs off an event log -----------------------------

/** A minimal event log in the shapes the extractor reads. */
function events(parts: {
  input?: Record<string, unknown>;
  steps?: Array<{ name: string; result: unknown }>;
  output?: Record<string, unknown>;
}): WorkflowEvent[] {
  const out: WorkflowEvent[] = [{ type: "run-started", at: "2026-08-28T00:00:00Z", data: { workflow: "coding-agent", input: parts.input ?? {} } } as unknown as WorkflowEvent];
  for (const s of parts.steps ?? []) {
    out.push({ type: "step-completed", at: "2026-08-28T00:00:01Z", name: s.name, data: { result: s.result } } as unknown as WorkflowEvent);
  }
  if (parts.output !== undefined) {
    out.push({ type: "run-completed", at: "2026-08-28T00:00:02Z", data: { output: parts.output } } as unknown as WorkflowEvent);
  }
  return out;
}

test("ladderRungsFromEvents agrees with the recorded ladder step over the same run", () => {
  const facts = greenFacts();
  const verification = facts.verification!;
  const log = events({
    input: { verification, testCommand: verification.tests },
    steps: [
      { name: "baseline-tests", result: facts.baseline },
      { name: "build", result: facts.build },
      { name: "tests", result: facts.tests },
      { name: "preview-deploy", result: { kind: "deployed", url: "https://preview-ship-abc.site.example.com", image: "img" } },
      { name: "preview-smoke", result: facts.smoke },
      { name: "visual-diff", result: facts.visual },
      { name: "observe-window", result: facts.observe },
      { name: "ladder", result: ladderRungs(facts) },
    ],
  });
  assert.deepEqual(ladderRungsFromEvents(log), (log.find((e) => e.type === "step-completed" && e.name === "ladder")!.data as { result: Rung[] }).result);
});

test("ladderRungsFromEvents: a pre-ladder run still reports the verification it recorded", () => {
  const log = events({
    input: { testCommand: "pnpm test" },
    steps: [
      { name: "tests", result: { kind: "passed", command: "pnpm test", durationMs: 900 } },
      { name: "change-class", result: { class: "trivial", files: [], reasons: [] } },
      { name: "telemetry-check", result: { kind: "compared", before: { service: "s", requests: 100, errors: 0, errorRate: 0, p50: 1, p95: 10, p99: 20, apdex: 1 }, after: { service: "s", requests: 100, errors: 0, errorRate: 0, p50: 1, p95: 10, p99: 20, apdex: 1 }, errorRateDelta: 0, p95Delta: 0 } },
    ],
  });
  const rungs = ladderRungsFromEvents(log);
  assert.deepEqual(
    rungs.map((r) => `${r.name}:${r.status}`),
    ["baseline:skipped", "build:skipped", "tests:passed", "preview:skipped", "visual:skipped", "observe:skipped"],
  );
  // The observe rung is honest about the DECLARATION: a run with no window
  // declared has no observe rung, whatever its one-off telemetry read said —
  // that comparison lives in the paragraph, not on the ladder.
  assert.match(rungs[5]!.detail!, /no observe window declared/);
});

test("ladderRungsFromEvents: a declared window whose step did not run falls back to the recorded telemetry", () => {
  const log = events({
    input: { verification: { tests: "pnpm test", observeWindowMin: 5 }, testCommand: "pnpm test" },
    steps: [
      { name: "tests", result: { kind: "passed", command: "pnpm test", durationMs: 900 } },
      { name: "telemetry-check", result: { kind: "compared", before: { service: "s", requests: 100, errors: 0, errorRate: 0, p50: 1, p95: 10, p99: 20, apdex: 1 }, after: { service: "s", requests: 100, errors: 5, errorRate: 0.05, p50: 1, p95: 10, p99: 20, apdex: 1 }, errorRateDelta: 0.05, p95Delta: 0 } },
    ],
  });
  const observe = ladderRungsFromEvents(log).find((r) => r.name === "observe")!;
  assert.equal(observe.status, "failed");
  assert.match(observe.detail!, /telemetry got worse/);
});
