import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * E7 EV3 — the built-in shadow wired through the REAL hook routes. The slack,
 * linear, github and observe action() handlers a deployed web process runs,
 * with correctly signed payloads, under SHIP_EVENT_RULES=shadow: every real
 * built-in intake is also evaluated through the default rule set, the counter
 * records a match, and the task in the store is the built-in path's own.
 * With the flag off the same routes stop counting entirely.
 */

const SLACK_SECRET = "slack-signing-secret-test";
const LINEAR_SECRET = "linear-signing-secret-test";
const GITHUB_SECRET = "github-webhook-secret-test";
const OBSERVE_SECRET = "observe-signing-secret-test";
const REPO = "https://git.example.com/team/site";

process.env.SHIP_STORE = "file";
process.env.TEPLOY_SHIP_STATE = mkdtempSync(join(tmpdir(), "ship-ev3-shadow-"));
process.env.SHIP_SLACK_SIGNING_SECRET = SLACK_SECRET;
process.env.SHIP_LINEAR_SIGNING_SECRET = LINEAR_SECRET;
process.env.SHIP_WEBHOOK_SECRET = GITHUB_SECRET;
process.env.SHIP_OBSERVE_SIGNING_SECRET = OBSERVE_SECRET;
process.env.SHIP_REPO_ALLOWLIST = REPO;
process.env.SHIP_EVENT_RULES = "shadow";

const slack = await import("../routes/hooks/slack.js");
const linear = await import("../routes/hooks/linear.js");
const github = await import("../routes/hooks/github.js");
const observe = await import("../routes/hooks/observe.js");
const { shipRuntime } = await import("./store.server.js");
const { readBuiltinShadowCounters } = await import("teploy-ship/runtime");
const runtime = await shipRuntime();

function slackRequest(body: string): Request {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", SLACK_SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  return new Request("https://ship.test/hooks/slack", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": sig },
  });
}

function linearRequest(body: string): Request {
  const sig = createHmac("sha256", LINEAR_SECRET).update(body).digest("hex");
  return new Request("https://ship.test/hooks/linear", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "linear-signature": sig, "linear-delivery": `ld-${Math.random()}` },
  });
}

function githubRequest(event: string, body: string): Request {
  const sig = `sha256=${createHmac("sha256", GITHUB_SECRET).update(body).digest("hex")}`;
  return new Request("https://ship.test/hooks/github", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": `gd-${Math.random()}`,
      "x-hub-signature-256": sig,
    },
  });
}

function observeRequest(body: string): Request {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `sha256=${createHmac("sha256", OBSERVE_SECRET).update(`${ts}.${body}`).digest("hex")}`;
  return new Request("https://ship.test/hooks/observe", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "x-observe-timestamp": ts, "x-observe-signature": sig, "x-observe-delivery": `od-${Math.random()}` },
  });
}

async function counters() {
  return readBuiltinShadowCounters(runtime.config);
}

test("slack route in shadow mode: task lands, counter records the match", async () => {
  const body = JSON.stringify({
    type: "event_callback",
    event: { type: "app_mention", user: "U0ADA", text: `<@U0SHIP> fix the flaky test repo:${REPO}`, ts: "1760700000.000100", channel: "C0ENG" },
  });
  const res = await slack.action({ request: slackRequest(body) });
  assert.equal(res.status, 201);
  const created = (await res.json()) as { taskId: string };
  const task = (await runtime.intake.list()).find((t) => t.taskId === created.taskId);
  assert.ok(task !== null);
  assert.equal(task.dedupeKey, "slack:C0ENG:1760700000.000100");
  const c = await counters();
  assert.equal(c?.sources.slack?.matched, 1);
  assert.equal(c?.sources.slack?.diffed, 0);
  assert.equal(c?.diffed, 0);
});

test("linear route in shadow mode: ship-labeled issue lands and matches", async () => {
  const body = JSON.stringify({
    action: "create",
    type: "Issue",
    url: "https://linear.app/t/issue/ENG-7",
    webhookTimestamp: Date.now(),
    data: { id: "uuid-ev3", identifier: "ENG-7", title: "Cache stampede on deploy", description: "repo:" + REPO, labels: [{ name: "ship" }] },
  });
  const res = await linear.action({ request: linearRequest(body) });
  assert.equal(res.status, 201);
  const c = await counters();
  assert.equal(c?.sources.linear?.matched, 1);
  assert.equal(c?.sources.linear?.diffed, 0);
});

test("github CI route in shadow mode: failed ship-branch run lands and matches", async () => {
  const body = JSON.stringify({
    action: "completed",
    workflow_run: {
      name: "CI",
      conclusion: "failure",
      head_branch: "ship/run-1",
      head_sha: "abcdef1234567890abcdef1234567890abcdef12",
      html_url: "https://git.example.com/team/site/actions/runs/9",
      pull_requests: [{ number: 3 }],
    },
    repository: { full_name: "team/site", clone_url: REPO },
  });
  const res = await github.action({ request: githubRequest("workflow_run", body) });
  assert.equal(res.status, 201);
  const c = await counters();
  assert.equal(c?.sources.ci?.matched, 1);
  assert.equal(c?.sources.ci?.diffed, 0);
});

test("observe route in shadow mode: an outbox incident lands and matches (unbound repo and all)", async () => {
  const body = JSON.stringify({
    kind: "incident_opened",
    incident_id: "oinc-ev3",
    rule_id: "rule-9",
    rule_name: "error rate over 5%",
    metric: "error_rate",
    value: 9.5,
    threshold: "5",
    site_id: "site-x",
    evaluated_at: new Date().toISOString(),
  });
  const res = await observe.action({ request: observeRequest(body) });
  assert.equal(res.status, 201);
  const c = await counters();
  assert.equal(c?.sources.observe?.matched, 1);
  assert.equal(c?.sources.observe?.diffed, 0);
  // Every shadowed delivery so far matched: nothing but the counter moved.
  assert.equal(c?.matched, c?.deliveries);
});

test("SHIP_EVENT_RULES=off: the same routes stop counting and still propose exactly as before", async () => {
  const before = await counters();
  assert.ok(before !== null);
  const saved = process.env.SHIP_EVENT_RULES;
  process.env.SHIP_EVENT_RULES = "off";
  try {
    const body = JSON.stringify({
      type: "event_callback",
      event: { type: "app_mention", user: "U0ADA", text: "<@U0SHIP> second task", ts: "1760700009.000900", channel: "C0ENG" },
    });
    const res = await slack.action({ request: slackRequest(body) });
    assert.equal(res.status, 201);
  } finally {
    process.env.SHIP_EVENT_RULES = saved;
  }
  const after = await counters();
  assert.equal(after?.deliveries, before.deliveries, "off does not even read the counter");
  assert.deepEqual(after?.sources.slack, before.sources.slack);
  const slackTasks = (await runtime.intake.list()).filter((t) => t.source === "slack");
  assert.equal(slackTasks.length, 2, "the built-in path itself is unchanged");
});
