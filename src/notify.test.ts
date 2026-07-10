import assert from "node:assert/strict";
import { test } from "node:test";

import { formatRunNotification, notifiable, slackNotifier } from "./notify.js";

test("run notifications format parks, failures, and PRs with dashboard links", () => {
  assert.equal(
    formatRunNotification({ runId: "run-1", status: "waiting", eventName: "plan-approval" }, "http://box:7460/"),
    "Ship run run-1 is parked on a plan review — http://box:7460/runs/run-1",
  );
  assert.match(formatRunNotification({ runId: "run-2", status: "waiting", eventName: "turn-3-approval" }), /parked on an approval/);
  assert.match(formatRunNotification({ runId: "run-3", status: "failed" }), /FAILED/);
  assert.match(formatRunNotification({ runId: "run-4", status: "completed", pr: "http://f/o/r/pulls/9" }), /→ http:\/\/f\/o\/r\/pulls\/9/);
});

test("notifiable pings on human-needed + terminal, not progress", () => {
  for (const status of ["waiting", "completed", "failed", "cancelled"]) assert.ok(notifiable(status), status);
  for (const status of ["running", "queued", "wake"]) assert.ok(!notifiable(status), status);
});

test("slackNotifier posts the message; disabled without a webhook URL", async () => {
  const posts: string[] = [];
  const notifier = slackNotifier({
    webhookUrl: "https://hooks.slack.example/T/B/x",
    publicUrl: "http://box:7460",
    log: () => {},
    fetchImpl: (async (_url: unknown, init?: { body?: string }) => {
      posts.push(String(init?.body ?? ""));
      return { ok: true } as Response;
    }) as typeof fetch,
  });
  notifier.runEvent({ runId: "run-9", status: "completed", pr: "PR#1" });
  notifier.runEvent({ runId: "run-9", status: "running" }); // filtered
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(posts.length, 1);
  assert.match(posts[0]!, /run-9 completed → PR#1/);

  assert.equal(slackNotifier({ webhookUrl: "", log: () => {} }).enabled, false);
});
