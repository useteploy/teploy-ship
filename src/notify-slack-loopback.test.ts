import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";

import { slackNotifier } from "./notify.js";

/**
 * B6 (S04): the outbound half of the Slack integration over a real socket.
 * A loopback HTTP server stands in for the incoming-webhook URL
 * (SHIP_SLACK_WEBHOOK_URL) and the notifier uses the real global fetch, so
 * this pins the bytes Slack actually receives: POST, application/json, and a
 * body of exactly {"text": "..."} — the incoming-webhook contract.
 */

interface Seen {
  method: string;
  path: string;
  contentType: string;
  body: string;
}

async function loopback(status = 200): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", contentType: String(req.headers["content-type"] ?? ""), body });
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(status === 200 ? "ok" : "invalid_payload");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/services/T0TEAM/B0HOOK/secretpart`, seen, close: () => new Promise((r) => server.close(() => r())) };
}

test("slack webhook over a real socket: POST, JSON, body is exactly {text}, links to the run", async () => {
  const hook = await loopback();
  try {
    const n = slackNotifier({ webhookUrl: hook.url, publicUrl: "https://ship.example.com/", log: () => {} });
    assert.equal(n.enabled, true);
    assert.equal(await n.runEvent({ runId: "run-a", status: "waiting", eventName: "plan-approval" }), true);
    assert.equal(await n.runEvent({ runId: "run-b", status: "completed", pr: "https://git.example.com/team/site/pulls/7" }), true);
    assert.equal(await n.runEvent({ runId: "run-c", status: "failed" }), true);
    assert.equal(hook.seen.length, 3);
    for (const s of hook.seen) {
      assert.equal(s.method, "POST");
      assert.equal(s.path, "/services/T0TEAM/B0HOOK/secretpart");
      assert.match(s.contentType, /^application\/json/);
      const parsed = JSON.parse(s.body) as Record<string, unknown>;
      assert.deepEqual(Object.keys(parsed), ["text"], "incoming webhooks take {text}; nothing else is sent");
      assert.equal(typeof parsed.text, "string");
    }
    const texts = hook.seen.map((s) => (JSON.parse(s.body) as { text: string }).text);
    assert.equal(texts[0], "Ship run run-a is parked on a plan review — https://ship.example.com/runs/run-a");
    assert.equal(texts[1], "Ship run run-b completed → https://git.example.com/team/site/pulls/7 — https://ship.example.com/runs/run-b");
    assert.equal(texts[2], "Ship run run-c FAILED — https://ship.example.com/runs/run-c");
  } finally {
    await hook.close();
  }
});

test("slack webhook negative controls: progress statuses send nothing; a rejected post stays owed", async () => {
  const ok = await loopback();
  try {
    const n = slackNotifier({ webhookUrl: ok.url, publicUrl: "", log: () => {} });
    for (const status of ["running", "queued", "wake"]) assert.equal(await n.runEvent({ runId: "r", status }), true);
    assert.equal(ok.seen.length, 0);
  } finally {
    await ok.close();
  }
  const bad = await loopback(400);
  const logs: string[] = [];
  try {
    const n = slackNotifier({ webhookUrl: bad.url, publicUrl: "", log: (l) => logs.push(l) });
    assert.equal(await n.runEvent({ runId: "r", status: "failed" }), false, "a refused post must not be settled");
    assert.equal(bad.seen.length, 1);
    assert.match(logs.join("\n"), /slack webhook 400/);
  } finally {
    await bad.close();
  }
  // Nothing listening: the error is logged and reported, never thrown into the run.
  const closed = await loopback();
  const url = closed.url;
  await closed.close();
  const n = slackNotifier({ webhookUrl: url, publicUrl: "", log: () => {} });
  assert.equal(await n.runEvent({ runId: "r", status: "completed" }), false);
  assert.equal(slackNotifier({ webhookUrl: "", log: () => {} }).enabled, false);
});
