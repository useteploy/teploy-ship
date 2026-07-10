import assert from "node:assert/strict";
import { test } from "node:test";

import { ciFixTaskFromWorkflowRun, linearTaskFromIssue, parseRepoToken, slackTaskFromMention } from "./intake-sources.js";

test("slack mention → task: strips the mention, binds repo:, dedupes on channel+ts", () => {
  const task = slackTaskFromMention({
    text: "<@U0BOT> fix the flaky auth test repo:https://github.com/o/r.git please",
    channel: "C123",
    ts: "1720500000.000100",
  });
  assert.ok(task !== null);
  assert.equal(task.source, "slack");
  assert.equal(task.repo, "https://github.com/o/r.git");
  assert.equal(task.title, "fix the flaky auth test please");
  assert.equal(task.dedupeKey, "slack:C123:1720500000.000100");

  assert.equal(slackTaskFromMention({ text: "<@U0BOT>", channel: "C1", ts: "1" }), null, "empty mention is skipped");
  const plain = slackTaskFromMention({ text: "<@U0BOT> summarize the runbook", channel: "C1", ts: "2" });
  assert.equal(plain?.repo, undefined, "no repo token → workspace task");
});

test("linear issue → task: gated on the ship label, keyed on issue id", () => {
  const payload = {
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
  };
  const task = linearTaskFromIssue(payload);
  assert.ok(task !== null);
  assert.equal(task.source, "linear");
  assert.equal(task.title, "[ABC-12] Retry logic drops the backoff cap");
  assert.equal(task.repo, "http://forge/o/r.git");
  assert.equal(task.dedupeKey, "linear:uuid-1");
  assert.match(task.detail ?? "", /linear\.app/);

  assert.equal(linearTaskFromIssue({ ...payload, data: { ...payload.data, labels: [{ name: "bug" }] } }), null, "no ship label → skip");
  assert.equal(linearTaskFromIssue({ ...payload, action: "remove" }), null);
  assert.equal(linearTaskFromIssue({ ...payload, type: "Comment" }), null);
});

test("parseRepoToken finds urls and tolerates punctuation", () => {
  assert.equal(parseRepoToken("do it repo:https://h/o/r.git, thanks"), "https://h/o/r.git");
  assert.equal(parseRepoToken("no binding here"), undefined);
});

test("workflow_run failure on a ship/ PR → CI fix task; everything else skipped", () => {
  const payload = {
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
  const task = ciFixTaskFromWorkflowRun(payload);
  assert.ok(task !== null);
  assert.equal(task.source, "ci");
  assert.equal(task.pr, 5);
  assert.equal(task.repo, "http://forge/o/r.git");
  assert.equal(task.dedupeKey, "ci:o/r#5:abcdef1234567890");
  assert.match(task.detail ?? "", /FAILED.*ship\/run-9a8b7c6d/);

  assert.equal(ciFixTaskFromWorkflowRun({ ...payload, workflow_run: { ...payload.workflow_run, conclusion: "success" } }), null);
  assert.equal(ciFixTaskFromWorkflowRun({ ...payload, workflow_run: { ...payload.workflow_run, head_branch: "main" } }), null, "only Ship's own PR branches");
  assert.equal(ciFixTaskFromWorkflowRun({ ...payload, action: "requested" }), null);
  assert.equal(ciFixTaskFromWorkflowRun({ ...payload, workflow_run: { ...payload.workflow_run, pull_requests: [] } }), null);
});
