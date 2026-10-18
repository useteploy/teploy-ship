import { test } from "node:test";
import assert from "node:assert/strict";

import { MemoryRuntimeConfig } from "./runtime-config.js";
import { FileIntakeStore } from "./intake.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validEventRuleShape, type EventRule, type ShipEvent } from "./event-rules.js";
import {
  BUILTIN_SHADOW_COUNTER_KEY,
  builtinDiffFields,
  builtinEventRules,
  builtinEventRulesValid,
  builtinShadowComparable,
  builtinShadowEvent,
  detailHashOf,
  evaluateBuiltinRules,
  parseBuiltinShadowCounters,
  readBuiltinShadowCounters,
  shadowBuiltinIntake,
  type BuiltinShadowDeps,
  type BuiltinSourceId,
} from "./event-builtin.js";
import {
  ciFixTaskFromWorkflowRun,
  incidentTaskFromObserveAlert,
  linearTaskFromIssue,
  reviewTaskFromReviewEvent,
  slackTaskFromMention,
} from "./intake-sources.js";
import { sweepWorkflowSchedules } from "./workflow-schedules.js";
import { checkEventRulesShadow } from "./install-doctor.js";

/**
 * E7 EV3 — the built-in sources as default rules over the EV2 engine, in
 * shadow. The controls the slice row names:
 *
 *   - for each built-in source, a real payload produces the IDENTICAL
 *     ProposeInput through both paths (zero diff, counter says matched);
 *   - NEGATIVE: an injected divergence (a changed dedupe-key template) is
 *     logged as a diff and the built-in result still wins;
 *   - shadow writes nothing but its counter;
 *   - off runs nothing at all.
 */

const NOW_ISO = "2026-10-18T09:00:00.000Z";
const NOW = Date.parse(NOW_ISO);
const SHADOW_ENV = { SHIP_EVENT_RULES: "shadow" };

/** Records every get/set so tests can prove exactly what the shadow touched. */
class RecordingConfig extends MemoryRuntimeConfig {
  reads: string[] = [];
  writes: string[] = [];
  override async get(key: string): Promise<string | undefined> {
    this.reads.push(key);
    return super.get(key);
  }
  override async set(key: string, value: string, updatedBy?: string): Promise<void> {
    this.writes.push(key);
    return super.set(key, value, updatedBy);
  }
}

interface Harness {
  deps: BuiltinShadowDeps;
  config: RecordingConfig;
  lines: string[];
}

function harness(env: NodeJS.ProcessEnv = SHADOW_ENV, rules?: readonly EventRule[]): Harness {
  const config = new RecordingConfig();
  const lines: string[] = [];
  return {
    config,
    lines,
    deps: {
      config,
      env,
      now: () => NOW,
      log: (line) => lines.push(line),
      ...(rules !== undefined ? { rules } : {}),
    },
  };
}

/** The real built-in path for one fixture: builder → propose (a real store). */
async function proposeForReal(source: BuiltinSourceId, payload: unknown, repo?: string): Promise<{ input: ReturnType<typeof slackTaskFromMention> }> {
  const input = builtinInputOf(source, payload, repo);
  return { input };
}

/** The built-in "builder" per source — the exact function each real path calls. */
function builtinInputOf(source: BuiltinSourceId, payload: unknown, repo?: string) {
  switch (source) {
    case "slack": return slackTaskFromMention(payload as Parameters<typeof slackTaskFromMention>[0]);
    case "linear": return linearTaskFromIssue(payload as Parameters<typeof linearTaskFromIssue>[0]);
    case "ci": return ciFixTaskFromWorkflowRun(payload as Parameters<typeof ciFixTaskFromWorkflowRun>[0]);
    case "github": return reviewTaskFromReviewEvent(payload as Parameters<typeof reviewTaskFromReviewEvent>[0], "github");
    case "forgejo": return reviewTaskFromReviewEvent(payload as Parameters<typeof reviewTaskFromReviewEvent>[0], "forgejo");
    case "observe": return incidentTaskFromObserveAlert(payload as Parameters<typeof incidentTaskFromObserveAlert>[0], repo !== undefined ? { repo } : {});
    case "schedule": throw new Error("schedule fixtures go through the sweep");
  }
}

/**
 * One fixture through BOTH paths and the shadow compare: the rule input must
 * deep-equal the built-in input, the diff list must be empty, and the counter
 * must have recorded a match.
 */
async function assertZeroDiff(source: BuiltinSourceId, payload: unknown, repo?: string): Promise<{ builtin: ShipEvent | null; ruleInput: unknown }> {
  const h = harness();
  const { input } = await proposeForReal(source, payload, repo);
  await shadowBuiltinIntake(h.deps, { source, payload, builtin: input, ...(repo !== undefined ? { repo } : {}) });

  const event = builtinShadowEvent(source, payload, { nowIso: NOW_ISO, ...(repo !== undefined ? { repo } : {}) });
  const decided = event === null ? null : evaluateBuiltinRules(builtinEventRules(), event, NOW_ISO);
  assert.deepEqual(decided?.input ?? null, input, `${source}: the rule path must reproduce the built-in ProposeInput exactly`);
  assert.deepEqual(builtinDiffFields(builtinShadowComparable(input, "propose"), builtinShadowComparable(decided?.input ?? null, "propose")), [], `${source}: no diff fields`);
  assert.equal(h.lines.length, 0, `${source}: no diff line on a match`);
  const counters = await readBuiltinShadowCounters(h.config);
  assert.equal(counters?.deliveries, 1);
  assert.equal(counters?.matched, 1);
  assert.equal(counters?.diffed, 0);
  assert.equal(counters?.sources[source]?.matched, 1);
  return { builtin: event, ruleInput: decided?.input ?? null };
}

// ---------------------------------------------------------------- fixtures

const SLACK_MENTION = {
  text: "<@U0SHIP> fix the flaky auth test repo:https://github.com/o/r.git please",
  channel: "C123",
  ts: "1720500000.000100",
  user: "U0ADA",
};

const LINEAR_ISSUE = {
  action: "update",
  type: "Issue",
  url: "https://linear.app/t/issue/ABC-12",
  data: {
    id: "uuid-1",
    identifier: "ABC-12",
    title: "Retry logic drops the backoff cap",
    description: "Clamp at 30s.\n\nrepo:http://forge/o/r.git",
    labels: [{ name: "Ship" }, { name: "bug" }],
  },
  actor: { name: "Dana", email: "dana@example.com" },
};

const CI_FAILURE = {
  action: "completed",
  workflow_run: {
    name: "CI",
    conclusion: "failure",
    head_branch: "ship/run-9a8b7c6d",
    head_sha: "abcdef1234567890",
    html_url: "http://forge/o/r/actions/runs/7",
    pull_requests: [{ number: 5 }],
  },
  repository: { full_name: "o/r", clone_url: "http://forge/o/r.git" },
};

function shipPull(overrides: Record<string, unknown> = {}) {
  return {
    number: 12,
    title: "Fix the flaky auth test",
    labels: [] as Array<{ name?: string }>,
    head: { ref: "ship/run-9a8b", sha: "abcdef1234567890abcdef1234567890abcdef12", repo: { full_name: "o/r" } },
    base: { repo: { full_name: "o/r" } },
    ...overrides,
  };
}

const REPO = { full_name: "o/r", clone_url: "http://forge/o/r.git" };

const GITHUB_REVIEW = {
  action: "submitted",
  review: { id: 55, state: "changes_requested", body: "", user: { login: "reviewer" } },
  pull_request: shipPull(),
  repository: REPO,
};

const FORGEJO_REVIEW = {
  action: "reviewed",
  number: 12,
  review: { type: "pull_request_review_rejected", content: "wrong cache key", user: { username: "gitea-reviewer" } },
  pull_request: shipPull(),
  repository: REPO,
};

const OBSERVE_ALERT = {
  alert_id: "al_7c1f",
  rule_id: "rule_42",
  rule_name: "error rate over 5%",
  metric: "error_rate",
  value: 12.5,
  threshold: "5",
  site_id: "site_fylun",
  timestamp: "2026-08-26T21:04:00Z",
};

const OBSERVE_OUTBOX = {
  kind: "incident_opened",
  incident_id: "oinc-7",
  rule_id: "rule-413",
  rule_name: "413s on checkout",
  metric: "error_rate",
  value: 12.5,
  threshold: "1",
  site_id: "fylun-web",
  evaluated_at: "2026-10-17T10:00:00Z",
};

const OBSERVE_REPO = "https://git.example.com/tyler/api.git";

// ------------------------------------------------------------- rule set

test("the default rule set passes the EV2 shape validation", () => {
  assert.equal(builtinEventRulesValid(), null);
  for (const rule of builtinEventRules()) {
    assert.equal(validEventRuleShape(rule).ok, true, rule.id);
  }
});

test("the dedupe-key templates render today's exact key strings", () => {
  const cases: Array<[BuiltinSourceId, unknown, string | undefined, string]> = [
    ["slack", SLACK_MENTION, undefined, "slack:C123:1720500000.000100"],
    ["linear", LINEAR_ISSUE, undefined, "linear:uuid-1"],
    ["ci", CI_FAILURE, undefined, "ci:o/r#5:abcdef1234567890"],
    ["github", GITHUB_REVIEW, undefined, "github:o/r#review-55"],
    ["forgejo", FORGEJO_REVIEW, undefined, "forgejo:o/r#review-sha-abcdef1234567890abcdef1234567890abcdef12"],
    ["observe", OBSERVE_ALERT, OBSERVE_REPO, "observe:al_7c1f"],
    ["observe", OBSERVE_OUTBOX, undefined, "observe:rule:rule-413:oinc-7"],
  ];
  for (const [source, payload, repo, key] of cases) {
    const event = builtinShadowEvent(source, payload, { nowIso: NOW_ISO, ...(repo !== undefined ? { repo } : {}) });
    assert.ok(event !== null, `${source}: adapter produced an event`);
    const decided = evaluateBuiltinRules(builtinEventRules(), event, NOW_ISO);
    assert.ok(decided !== null, `${source}: a default rule matched`);
    assert.equal(decided.input.dedupeKey, key, `${source}: the rule renders today's key`);
  }
});

// ---------------------------------------------- zero diff per built-in source

test("slack: a real app_mention produces the identical ProposeInput via both paths", async () => {
  const { builtin } = await assertZeroDiff("slack", SLACK_MENTION);
  assert.equal(builtin?.type, "chat.mention");
  // The 140-char clamp is the builder's own (title may run to 141 with the
  // ellipsis) — the rule path must not re-clamp it.
  const long = { ...SLACK_MENTION, text: `<@U0SHIP> ${"x".repeat(200)} repo:https://github.com/o/r.git`, ts: "1720500001.000200" };
  await assertZeroDiff("slack", long);
  // Both paths skip an empty mention.
  await assertZeroDiff("slack", { text: "<@U0SHIP>", channel: "C1", ts: "1720500002.000300" });
});

test("linear: a real ship-labeled issue produces the identical ProposeInput via both paths", async () => {
  await assertZeroDiff("linear", LINEAR_ISSUE);
  // No description/url → no detail on either side; no ship label → both null.
  await assertZeroDiff("linear", { ...LINEAR_ISSUE, data: { ...LINEAR_ISSUE.data, description: "" }, url: undefined });
  await assertZeroDiff("linear", { ...LINEAR_ISSUE, data: { ...LINEAR_ISSUE.data, labels: [{ name: "bug" }] } });
});

test("ci: a real failed workflow_run on a ship PR produces the identical ProposeInput via both paths", async () => {
  await assertZeroDiff("ci", CI_FAILURE);
  await assertZeroDiff("ci", { ...CI_FAILURE, workflow_run: { ...CI_FAILURE.workflow_run, conclusion: "success" } });
  await assertZeroDiff("ci", { ...CI_FAILURE, workflow_run: { ...CI_FAILURE.workflow_run, head_branch: "main" } });
});

test("review: real GitHub and Forgejo review rounds produce the identical ProposeInput via both paths", async () => {
  await assertZeroDiff("github", GITHUB_REVIEW);
  await assertZeroDiff("forgejo", FORGEJO_REVIEW);
  // An approval is not a work request on either path.
  await assertZeroDiff("github", { ...GITHUB_REVIEW, review: { ...GITHUB_REVIEW.review, state: "approved", body: "lgtm" } });
  // An inline comment delivery coalesces onto the review round key.
  await assertZeroDiff("github", {
    action: "created",
    comment: { id: 901, body: "this leaks", path: "src/auth.ts", line: 42, side: "RIGHT", pull_request_review_id: 55, user: { login: "reviewer" } },
    pull_request: shipPull(),
    repository: REPO,
  });
});

test("observe: real legacy and outbox alert bodies produce the identical ProposeInput via both paths", async () => {
  await assertZeroDiff("observe", OBSERVE_ALERT, OBSERVE_REPO);
  await assertZeroDiff("observe", OBSERVE_ALERT);
  await assertZeroDiff("observe", OBSERVE_OUTBOX);
  // A recovery notice proposes nothing on either path.
  await assertZeroDiff("observe", { kind: "incident_recovered", rule_id: "rule-413", incident_id: "oinc-7" });
  // No alert_id and no rule+incident → no key → both paths skip.
  await assertZeroDiff("observe", { kind: "incident_opened", rule_id: "rule-413" });
});

test("schedules: every slot flavour produces the identical ProposeInput via both paths", async () => {
  const flavours: Array<Record<string, unknown>> = [
    { id: "sched-j", journey: "review", mode: "fix", plan: true },
    { id: "sched-change", journey: "change", mode: "scan", plan: false },
    { id: "sched-scan", mode: "scan", plan: false },
    { id: "sched-plan", mode: "fix", plan: true },
    { id: "sched-fix", mode: "fix", plan: false },
    // mode wins over plan when no journey is set, exactly as the sweep's
    // ternary does — the ordered rule set must reproduce that too.
    { id: "sched-scan-plan", mode: "scan", plan: true },
  ];
  for (const extra of flavours) {
    const schedule = {
      id: "test",
      name: "Review",
      repo: "team/repo",
      task: "Inspect only",
      mode: "fix",
      plan: false,
      everyMinutes: 60,
      enabled: true,
      createdAt: new Date(NOW - 7_200_000).toISOString(),
      by: "tester",
      ...extra,
    };
    const dir = await mkdtemp(join(tmpdir(), "ship-ev3-schedule-"));
    const config = new MemoryRuntimeConfig();
    await config.set(`SHIP_SCHEDULE_DEF_${String(extra.id)}`, JSON.stringify(schedule));
    const intake = new FileIntakeStore(join(dir, "tasks"));
    const runtime = { config, intake, projects: { forRepo: async () => ({ url: "https://github.com/team/repo" }) } } as any;
    const lines: string[] = [];
    // The sweep reads the mode from the process env at call time.
    const savedEnv = process.env.SHIP_EVENT_RULES;
    process.env.SHIP_EVENT_RULES = "shadow";
    try {
      await sweepWorkflowSchedules(runtime, NOW, { log: (line: string) => lines.push(line) });
    } finally {
      if (savedEnv === undefined) delete process.env.SHIP_EVENT_RULES;
      else process.env.SHIP_EVENT_RULES = savedEnv;
    }
    const tasks = await intake.list();
    assert.equal(tasks.length, 1, `${JSON.stringify(extra)}: one task proposed`);
    assert.equal(tasks[0]!.source, "workflow");
    assert.equal(tasks[0]!.title, "Review");
    assert.equal(tasks[0]!.detail, "Inspect only");
    assert.equal(tasks[0]!.requestedBy, "tester");
    const expectedKind =
      extra.journey !== undefined ? `request-${String(extra.journey)}`
        : extra.mode === "scan" ? "workflow-scan"
          : extra.plan === true ? "workflow-plan"
            : "workflow-fix";
    assert.equal(tasks[0]!.kind, expectedKind, `${JSON.stringify(extra)}: the sweep's kind is unchanged`);
    // The shadow ran beside it with zero diffs and counted the match.
    const counters = await readBuiltinShadowCounters(config);
    assert.equal(counters?.matched, 1, `${JSON.stringify(extra)}: shadow matched`);
    assert.equal(counters?.diffed, 0, `${JSON.stringify(extra)}: shadow diffed`);
    assert.equal(counters?.sources.schedule?.matched, 1);
    assert.equal(lines.filter((l) => l.includes("[event-rules shadow] diff")).length, 0);
  }
});

// ----------------------------------------------------------- negative controls

test("NEGATIVE: an injected divergence (changed dedupe template) is logged as a diff and the built-in result still wins", async () => {
  const mutated = builtinEventRules().map((r) =>
    r.id === "builtin-slack-mention" ? { ...r, dedupeKey: "slack:{{attr.channel}}:{{attr.ts}}:v2" } : r,
  );
  const h = harness(SHADOW_ENV, mutated);
  const { input } = await proposeForReal("slack", SLACK_MENTION);
  assert.ok(input !== null);

  // The real propose, through the REAL file intake store, AFTER the shadow
  // ran — the built-in path must land its own task untouched.
  const dir = await mkdtemp(join(tmpdir(), "ship-ev3-negative-"));
  const intake = new FileIntakeStore(join(dir, "tasks"));
  await shadowBuiltinIntake(h.deps, { source: "slack", payload: SLACK_MENTION, builtin: input });
  const { task, created } = await intake.propose(input);

  assert.equal(created, true);
  assert.equal(task.dedupeKey, "slack:C123:1720500000.000100", "the built-in key wins in the store");
  assert.equal((await intake.list()).length, 1, "the shadow proposed nothing alongside it");
  assert.deepEqual(
    h.lines.filter((l) => l.includes("[event-rules shadow] diff")),
    [`[event-rules shadow] diff source=slack key=slack:C123:1720500000.000100 fields=dedupeKey`],
  );
  const counters = await readBuiltinShadowCounters(h.config);
  assert.equal(counters?.diffed, 1);
  assert.equal(counters?.matched, 0);
  assert.equal(counters?.sources.slack?.diffed, 1);
});

test("NEGATIVE: a rule set that no longer sees the event is a diff (the built-in still proposes)", async () => {
  // The rule's match drifts to a type the adapter never emits: the rule path
  // proposes nothing while the built-in path proposed a task.
  const mutated = builtinEventRules().map((r) =>
    r.id === "builtin-github-review" ? { ...r, match: { source: "github", types: ["review.other"] } } : r,
  );
  const h = harness(SHADOW_ENV, mutated);
  const { input } = await proposeForReal("github", GITHUB_REVIEW);
  assert.ok(input !== null);
  await shadowBuiltinIntake(h.deps, { source: "github", payload: GITHUB_REVIEW, builtin: input });
  assert.deepEqual(
    h.lines.filter((l) => l.includes("[event-rules shadow] diff")),
    [`[event-rules shadow] diff source=github key=github:o/r#review-55 fields=proposal`],
  );
  assert.equal((await readBuiltinShadowCounters(h.config))?.diffed, 1);
});

test("NEGATIVE: a rule asserting auto over a propose source diffs on policy", async () => {
  const mutated = builtinEventRules().map((r) => (r.id === "builtin-ci-failure" ? { ...r, policy: "auto" as const } : r));
  const h = harness(SHADOW_ENV, mutated);
  const { input } = await proposeForReal("ci", CI_FAILURE);
  await shadowBuiltinIntake(h.deps, { source: "ci", payload: CI_FAILURE, builtin: input });
  assert.deepEqual(
    h.lines.filter((l) => l.includes("[event-rules shadow] diff")),
    [`[event-rules shadow] diff source=ci key=ci:o/r#5:abcdef1234567890 fields=policy`],
  );
});

test("policy: the stored per-source policy compares equal when the source strings agree (auto on both sides)", async () => {
  const h = harness();
  h.deps.policyOf = async () => "auto";
  const { input } = await proposeForReal("slack", SLACK_MENTION);
  await shadowBuiltinIntake(h.deps, { source: "slack", payload: SLACK_MENTION, builtin: input });
  assert.equal(h.lines.length, 0);
  assert.equal((await readBuiltinShadowCounters(h.config))?.matched, 1);
});

// ------------------------------------------------------------ no writes / off

test("shadow writes nothing but the counter: no intake writes, one config key", async () => {
  const h = harness();
  const { input } = await proposeForReal("observe", OBSERVE_ALERT, OBSERVE_REPO);
  await shadowBuiltinIntake(h.deps, { source: "observe", payload: OBSERVE_ALERT, builtin: input, repo: OBSERVE_REPO });
  assert.deepEqual([...new Set(h.config.writes)], [BUILTIN_SHADOW_COUNTER_KEY], "the only write is the counter key");
  assert.deepEqual([...new Set(h.config.reads)], [BUILTIN_SHADOW_COUNTER_KEY]);
});

test("off runs nothing: no reads, no writes, no logs (and on leaves the built-ins alone too)", async () => {
  for (const value of [undefined, "", "off", "on", "yes"]) {
    const env: NodeJS.ProcessEnv = value === undefined ? {} : { SHIP_EVENT_RULES: value };
    const h = harness(env);
    const { input } = await proposeForReal("slack", SLACK_MENTION);
    await shadowBuiltinIntake(h.deps, { source: "slack", payload: SLACK_MENTION, builtin: input });
    assert.equal(h.config.reads.length, 0, `${String(value)}: no config reads`);
    assert.equal(h.config.writes.length, 0, `${String(value)}: no config writes`);
    assert.equal(h.lines.length, 0, `${String(value)}: no log lines`);
  }
});

test("a throwing store cannot break the real path: the error is logged as a shadow error", async () => {
  const h = harness();
  h.config.set = async () => {
    throw new Error("kv unavailable");
  };
  const { input } = await proposeForReal("slack", SLACK_MENTION);
  await shadowBuiltinIntake(h.deps, { source: "slack", payload: SLACK_MENTION, builtin: input });
  assert.equal(h.lines.filter((l) => l.startsWith("[event-rules shadow] error source=slack:")).length, 1);
});

// -------------------------------------------------------------- counters

test("parseBuiltinShadowCounters bounds a damaged document and drops unknown sources", () => {
  assert.equal(parseBuiltinShadowCounters("junk"), null);
  assert.equal(parseBuiltinShadowCounters({ since: "nope", updated: "nope" }), null);
  const parsed = parseBuiltinShadowCounters({
    since: NOW_ISO,
    updated: NOW_ISO,
    deliveries: -5,
    matched: Number.POSITIVE_INFINITY,
    diffed: 1e15,
    sources: { slack: { matched: 3, diffed: 1 }, evil: { matched: 9, diffed: 9 } },
  });
  assert.ok(parsed !== null);
  assert.equal(parsed.deliveries, 0);
  assert.equal(parsed.matched, 0);
  assert.equal(parsed.diffed, 1_000_000_000, "saturates rather than grows");
  assert.equal(parsed.sources.slack?.matched, 3);
  assert.equal(parsed.sources.evil, undefined, "the per-source map is fixed");
});

test("counters accumulate across deliveries and saturate", async () => {
  const h = harness();
  const { input } = await proposeForReal("slack", SLACK_MENTION);
  for (let i = 0; i < 3; i++) {
    await shadowBuiltinIntake(h.deps, { source: "slack", payload: SLACK_MENTION, builtin: input });
  }
  const { input: review } = await proposeForReal("github", GITHUB_REVIEW);
  await shadowBuiltinIntake(h.deps, { source: "github", payload: GITHUB_REVIEW, builtin: review });
  const counters = await readBuiltinShadowCounters(h.config);
  assert.equal(counters?.deliveries, 4);
  assert.equal(counters?.matched, 4);
  assert.equal(counters?.sources.slack?.matched, 3);
  assert.equal(counters?.sources.github?.matched, 1);
  assert.equal(counters?.since, NOW_ISO);
});

// ------------------------------------------------------------------ doctor

test("doctor check: off is a pass, zero diffs is a pass, a diff fails with the remedy", () => {
  const off = checkEventRulesShadow({ SHIP_EVENT_RULES: "off" }, null);
  assert.equal(off.status, "pass");
  assert.match(off.detail, /is off/);

  const soak = checkEventRulesShadow({ SHIP_EVENT_RULES: "shadow" }, {
    since: NOW_ISO,
    updated: NOW_ISO,
    deliveries: 120,
    matched: 120,
    diffed: 0,
    sources: {},
  });
  assert.equal(soak.status, "pass");
  assert.match(soak.detail, /120 built-in delivery\(s\)/);

  const dirty = checkEventRulesShadow({ SHIP_EVENT_RULES: "shadow" }, {
    since: NOW_ISO,
    updated: NOW_ISO,
    deliveries: 120,
    matched: 119,
    diffed: 1,
    sources: {},
  });
  assert.equal(dirty.status, "fail");
  assert.match(dirty.detail, /1 diffed/);
  assert.match(dirty.remedy ?? "", /SHIP_EVENT_RULES=on/);
});

test("detail hashes never leak raw detail text", () => {
  assert.equal(detailHashOf("secret stack content"), detailHashOf("secret stack content"));
  assert.notEqual(detailHashOf("a"), detailHashOf("b"));
  assert.equal(detailHashOf(undefined), detailHashOf(""));
  assert.match(detailHashOf("x"), /^[0-9a-f]{12}$/);
});
