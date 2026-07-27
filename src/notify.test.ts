import assert from "node:assert/strict";
import { test } from "node:test";

import type { Notifier } from "./notify.js";
import {
  formatRunNotification,
  multiNotifier,
  notifiable,
  runWebhookPayload,
  signWebhookBody,
  slackNotifier,
  webhookNotifier,
} from "./notify.js";

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

test("webhook payload carries what a machine consumer needs to route and act", () => {
  const p = runWebhookPayload(
    { runId: "run-9", status: "waiting", eventName: "turn-3-approval", repo: "tyler/akiroo-lite", task: "fix the 5xx" },
    "http://box:7460/",
  );
  assert.equal(p.run_id, "run-9");
  assert.equal(p.status, "waiting");
  // event_name is load-bearing: it is what a decision gets delivered back to.
  assert.equal(p.event_name, "turn-3-approval");
  assert.equal(p.repo, "tyler/akiroo-lite");
  assert.equal(p.task, "fix the 5xx");
  assert.equal(p.url, "http://box:7460/runs/run-9");
});

test("webhook payload omits absent fields rather than sending empty strings", () => {
  const p = runWebhookPayload({ runId: "run-1", status: "completed" });
  assert.deepEqual(Object.keys(p).sort(), ["run_id", "status"]);
});

test("webhook signature matches the shared teploy construction", async () => {
  const { createHmac } = await import("node:crypto");
  const body = JSON.stringify({ run_id: "r", status: "waiting" });
  const headers = await signWebhookBody("s3cr3t", body, 1700000000);
  const want = createHmac("sha256", "s3cr3t").update(`1700000000.${body}`).digest("hex");
  assert.equal(headers["X-Teploy-Timestamp"], "1700000000");
  assert.equal(headers["X-Teploy-Signature"], `sha256=${want}`);
});

test("no secret signs nothing, so an unconfigured install delivers as before", async () => {
  assert.deepEqual(await signWebhookBody("", "{}"), {});
});

test("webhook notifier signs its delivery and skips non-notifiable statuses", async () => {
  const seen: { body: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seen.push({ body: String(init.body), headers: init.headers as Record<string, string> });
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;

  const n = webhookNotifier({ webhookUrl: "http://sink/hook", secret: "k", fetchImpl, log: () => {} });
  assert.ok(n.enabled);
  n.runEvent({ runId: "run-1", status: "running" }); // progress: not notifiable
  n.runEvent({ runId: "run-2", status: "waiting", eventName: "turn-1-approval" });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(seen.length, 1, "only the parked event should have been delivered");
  const { createHmac } = await import("node:crypto");
  const ts = seen[0]!.headers["X-Teploy-Timestamp"]!;
  const want = createHmac("sha256", "k").update(`${ts}.${seen[0]!.body}`).digest("hex");
  assert.equal(seen[0]!.headers["X-Teploy-Signature"], `sha256=${want}`);
});

test("webhook notifier is disabled without a url, so nothing is sent", () => {
  assert.equal(webhookNotifier({ webhookUrl: "", fetchImpl: (() => { throw new Error("must not fetch"); }) as unknown as typeof fetch }).enabled, false);
});

test("multiNotifier fans out to enabled members and stays disabled when none are", () => {
  const calls: string[] = [];
  const on = (name: string): Notifier => ({ enabled: true, runEvent: () => calls.push(name) });
  const off: Notifier = { enabled: false, runEvent: () => calls.push("off") };

  const both = multiNotifier([on("a"), off, on("b")]);
  assert.ok(both.enabled);
  both.runEvent({ runId: "r", status: "completed" });
  assert.deepEqual(calls, ["a", "b"], "a disabled member must not receive events");

  assert.equal(multiNotifier([off, off]).enabled, false);
});

test("outbound notify secret is separate from the inbound forge webhook secret", () => {
  // SHIP_WEBHOOK_SECRET is how Forgejo proves ITS deliveries to us
  // (web/src/routes/hooks/forgejo.tsx). Reusing it to sign OUR outbound
  // deliveries would force both onto one value or break whichever was
  // configured second.
  const prevInbound = process.env.SHIP_WEBHOOK_SECRET;
  const prevOutbound = process.env.SHIP_NOTIFY_SECRET;
  const prevUrl = process.env.SHIP_NOTIFY_URL;
  try {
    process.env.SHIP_WEBHOOK_SECRET = "inbound-forge-secret";
    delete process.env.SHIP_NOTIFY_SECRET;
    process.env.SHIP_NOTIFY_URL = "http://sink/hook";
    let sentHeaders: Record<string, string> = {};
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      sentHeaders = init.headers as Record<string, string>;
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof fetch;
    const n = webhookNotifier({ fetchImpl, log: () => {} });
    n.runEvent({ runId: "r", status: "waiting" });
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        assert.equal(
          sentHeaders["X-Teploy-Signature"],
          undefined,
          "the inbound forge secret must not be picked up as the outbound signing secret",
        );
        resolve();
      }, 20),
    );
  } finally {
    if (prevInbound === undefined) delete process.env.SHIP_WEBHOOK_SECRET;
    else process.env.SHIP_WEBHOOK_SECRET = prevInbound;
    if (prevOutbound === undefined) delete process.env.SHIP_NOTIFY_SECRET;
    else process.env.SHIP_NOTIFY_SECRET = prevOutbound;
    if (prevUrl === undefined) delete process.env.SHIP_NOTIFY_URL;
    else process.env.SHIP_NOTIFY_URL = prevUrl;
  }
});
