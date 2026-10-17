import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * B6 (S04): Slack and Linear intake proven through the REAL route handlers —
 * the action() a deployed web process runs at /hooks/slack and /hooks/linear —
 * with correctly signed payloads in the shapes Slack's Events API and Linear's
 * webhooks send, against a real file-backed intake store.
 */

const SLACK_SECRET = "slack-signing-secret-test";
const LINEAR_SECRET = "linear-signing-secret-test";
const REPO = "https://git.example.com/team/site";

process.env.SHIP_STORE = "file";
process.env.TEPLOY_SHIP_STATE = mkdtempSync(join(tmpdir(), "ship-slack-linear-"));
process.env.SHIP_SLACK_SIGNING_SECRET = SLACK_SECRET;
process.env.SHIP_LINEAR_SIGNING_SECRET = LINEAR_SECRET;
process.env.SHIP_REPO_ALLOWLIST = REPO;

const slack = await import("../routes/hooks/slack.js");
const linear = await import("../routes/hooks/linear.js");
const { shipRuntime } = await import("./store.server.js");
const runtime = await shipRuntime();

async function tasksFrom(source: string) {
  return (await runtime.intake.list()).filter((t) => t.source === source);
}

// ── Slack ─────────────────────────────────────────────────────────────────

function slackRequest(body: string, opts: { ts?: number; secret?: string; signature?: string; retry?: string } = {}): Request {
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = opts.signature ?? `v0=${createHmac("sha256", opts.secret ?? SLACK_SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  return new Request("https://ship.test/hooks/slack", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig,
      ...(opts.retry !== undefined ? { "x-slack-retry-num": opts.retry, "x-slack-retry-reason": "http_timeout" } : {}),
    },
  });
}

/** The Events API envelope Slack posts for an app_mention. */
function mention(text: string, ts: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    token: "legacy-verification-token-unused",
    team_id: "T0TEAM",
    api_app_id: "A0SHIP",
    type: "event_callback",
    event_id: `Ev${ts.replace(".", "")}`,
    event_time: Math.floor(Date.now() / 1000),
    event: { type: "app_mention", user: "U0ADA", text, ts, channel: "C0ENG", event_ts: ts, ...extra },
  });
}

test("slack url_verification handshake echoes the challenge (signed)", async () => {
  const res = await slack.action({ request: slackRequest(JSON.stringify({ type: "url_verification", challenge: "abc123", token: "x" })) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { challenge: "abc123" });
});

test("slack: a signed app_mention becomes exactly one task; a retried delivery is still one", async () => {
  const body = mention(`<@U0SHIP> fix the flaky auth test repo:${REPO}`, "1760600000.000100");
  const first = await slack.action({ request: slackRequest(body) });
  assert.equal(first.status, 201);
  const created = (await first.json()) as { taskId: string; created: boolean };
  assert.equal(created.created, true);
  // Slack retries resend the same body with a fresh timestamp + signature.
  const retry = await slack.action({ request: slackRequest(body, { retry: "1" }) });
  assert.equal(retry.status, 200);
  assert.match(JSON.stringify(await retry.json()), /duplicate delivery/);
  const tasks = await tasksFrom("slack");
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.taskId, created.taskId);
  assert.equal(tasks[0]!.title, "fix the flaky auth test");
  assert.equal(tasks[0]!.repo, REPO);
  assert.equal(tasks[0]!.requestedBy, "U0ADA");
  assert.equal(tasks[0]!.state, "proposed", "unlisted sources default to propose: a human launches it");
});

test("slack refusals: bad signature, wrong secret, stale timestamp, missing timestamp — and nothing is written", async () => {
  const before = (await tasksFrom("slack")).length;
  const body = mention("<@U0SHIP> do something", "1760600001.000200");
  assert.equal((await slack.action({ request: slackRequest(body, { signature: "v0=" + "0".repeat(64) }) })).status, 401);
  assert.equal((await slack.action({ request: slackRequest(body, { secret: "not-the-secret" }) })).status, 401);
  // Validly signed, but signed six minutes ago: outside the replay window.
  const stale = await slack.action({ request: slackRequest(body, { ts: Math.floor(Date.now() / 1000) - 360 }) });
  assert.equal(stale.status, 401);
  assert.match(JSON.stringify(await stale.json()), /stale/);
  const noTs = new Request("https://ship.test/hooks/slack", { method: "POST", body, headers: { "x-slack-signature": "v0=x" } });
  assert.equal((await slack.action({ request: noTs })).status, 401);
  // A body tampered after signing.
  const tampered = slackRequest(body);
  const forged = new Request(tampered.url, { method: "POST", headers: tampered.headers, body: body.replace("do something", "rm -rf") });
  assert.equal((await slack.action({ request: forged })).status, 401);
  assert.equal((await tasksFrom("slack")).length, before);
});

test("slack negative controls: bot messages, non-mention events and empty mentions are ignored", async () => {
  const before = (await tasksFrom("slack")).length;
  const bot = await slack.action({ request: slackRequest(mention("<@U0SHIP> loop", "1760600002.000300", { bot_id: "B0BOT" })) });
  assert.match(JSON.stringify(await bot.json()), /bot message/);
  const msg = JSON.stringify({ type: "event_callback", event: { type: "message", text: "hello", ts: "1760600003.0004", channel: "C0ENG" } });
  assert.match(JSON.stringify(await (await slack.action({ request: slackRequest(msg) })).json()), /not an app_mention/);
  const empty = await slack.action({ request: slackRequest(mention("<@U0SHIP>", "1760600004.000500")) });
  assert.match(JSON.stringify(await empty.json()), /empty mention/);
  assert.equal((await tasksFrom("slack")).length, before);
});

test("slack: a repo outside the allowlist is refused with 403, not silently dropped", async () => {
  const res = await slack.action({ request: slackRequest(mention("<@U0SHIP> fix it repo:https://evil.example.com/x/y", "1760600005.000600")) });
  assert.equal(res.status, 403);
  assert.equal((await tasksFrom("slack")).filter((t) => t.repo === "https://evil.example.com/x/y").length, 0);
});

test("slack: intake is off (503) when the signing secret is unset", async () => {
  const saved = process.env.SHIP_SLACK_SIGNING_SECRET;
  delete process.env.SHIP_SLACK_SIGNING_SECRET;
  try {
    assert.equal((await slack.action({ request: slackRequest(mention("<@U0SHIP> x", "1760600006.0007")) })).status, 503);
  } finally {
    process.env.SHIP_SLACK_SIGNING_SECRET = saved;
  }
});

// ── Linear ────────────────────────────────────────────────────────────────

function linearRequest(body: string, opts: { delivery?: string; secret?: string; signature?: string } = {}): Request {
  const sig = opts.signature ?? createHmac("sha256", opts.secret ?? LINEAR_SECRET).update(body).digest("hex");
  return new Request("https://ship.test/hooks/linear", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "linear-signature": sig,
      "linear-delivery": opts.delivery ?? randomUUID(),
      "linear-event": "Issue",
      "user-agent": "Linear-Webhook",
    },
  });
}

/** The Issue webhook body Linear sends (data trimmed to the fields Ship reads plus a few it ignores). */
function issueEvent(opts: { id?: string; action?: string; labels?: string[]; description?: string; at?: number } = {}): string {
  const id = opts.id ?? randomUUID();
  return JSON.stringify({
    action: opts.action ?? "create",
    type: "Issue",
    createdAt: new Date().toISOString(),
    organizationId: "org-1",
    webhookId: "wh-1",
    webhookTimestamp: opts.at ?? Date.now(),
    url: `https://linear.app/acme/issue/ENG-42/flaky-login`,
    actor: { id: "user-1", type: "user", name: "Ada", email: "ada@example.com" },
    data: {
      id,
      identifier: "ENG-42",
      number: 42,
      title: "Flaky login test",
      description: opts.description ?? `The login test fails one run in five.\n\nrepo:${REPO}`,
      priority: 2,
      teamId: "team-1",
      labelIds: (opts.labels ?? ["ship"]).map((n) => `label-${n}`),
      labels: (opts.labels ?? ["ship"]).map((name) => ({ id: `label-${name}`, name, color: "#5e6ad2" })),
    },
  });
}

test("linear: a signed, ship-labelled Issue create becomes exactly one task; duplicate deliveries stay one", async () => {
  const id = randomUUID();
  const body = issueEvent({ id });
  const delivery = randomUUID();
  const first = await linear.action({ request: linearRequest(body, { delivery }) });
  assert.equal(first.status, 201);
  // Same delivery id (Linear retry): refused at the delivery claim.
  const again = await linear.action({ request: linearRequest(body, { delivery }) });
  assert.match(JSON.stringify(await again.json()), /duplicate delivery/);
  // A later update to the same issue under a new delivery: same task, not a second one.
  const update = await linear.action({ request: linearRequest(issueEvent({ id, action: "update" })) });
  assert.equal(update.status, 200);
  assert.equal(((await update.json()) as { created: boolean }).created, false);
  const tasks = (await tasksFrom("linear")).filter((t) => t.dedupeKey === `linear:${id}`);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.title, "[ENG-42] Flaky login test");
  assert.equal(tasks[0]!.repo, REPO);
  assert.equal(tasks[0]!.requestedBy, "ada@example.com");
  assert.match(tasks[0]!.detail ?? "", /linear\.app\/acme\/issue\/ENG-42/);
});

test("linear: an unlabelled issue (and a non-Issue event) is ignored", async () => {
  const before = (await tasksFrom("linear")).length;
  const unlabelled = await linear.action({ request: linearRequest(issueEvent({ labels: ["bug"] })) });
  assert.equal(unlabelled.status, 200);
  assert.match(JSON.stringify(await unlabelled.json()), /not a ship-labeled issue/);
  const comment = JSON.stringify({ action: "create", type: "Comment", webhookTimestamp: Date.now(), data: { id: "c1", body: "ship it" } });
  assert.match(JSON.stringify(await (await linear.action({ request: linearRequest(comment) })).json()), /not a ship-labeled/);
  const removed = await linear.action({ request: linearRequest(issueEvent({ action: "remove" })) });
  assert.match(JSON.stringify(await removed.json()), /not a ship-labeled/);
  assert.equal((await tasksFrom("linear")).length, before);
});

test("linear refusals: bad signature, wrong secret, tampered body, stale webhookTimestamp — nothing written", async () => {
  const before = (await tasksFrom("linear")).length;
  const body = issueEvent();
  assert.equal((await linear.action({ request: linearRequest(body, { signature: "0".repeat(64) }) })).status, 401);
  assert.equal((await linear.action({ request: linearRequest(body, { secret: "nope" }) })).status, 401);
  const signed = linearRequest(body);
  const forged = new Request(signed.url, { method: "POST", headers: signed.headers, body: body.replace("Flaky login test", "Exfiltrate secrets") });
  assert.equal((await linear.action({ request: forged })).status, 401);
  // A validly signed capture replayed later under a FRESH delivery id: the
  // header is unsigned, so only the signed webhookTimestamp can refuse it.
  const old = await linear.action({ request: linearRequest(issueEvent({ at: Date.now() - 10 * 60 * 1000 })) });
  assert.equal(old.status, 401);
  assert.match(JSON.stringify(await old.json()), /stale/);
  assert.equal((await tasksFrom("linear")).length, before);
});

test("linear: intake is off (503) when the signing secret is unset", async () => {
  const saved = process.env.SHIP_LINEAR_SIGNING_SECRET;
  delete process.env.SHIP_LINEAR_SIGNING_SECRET;
  try {
    assert.equal((await linear.action({ request: linearRequest(issueEvent()) })).status, 503);
  } finally {
    process.env.SHIP_LINEAR_SIGNING_SECRET = saved;
  }
});

test("linear: the same signed body under a FRESH delivery id is a duplicate (dedupe on the body hash, not the unsigned header)", async () => {
  const id = randomUUID();
  const body = issueEvent({ id });
  const first = await linear.action({ request: linearRequest(body, { delivery: randomUUID() }) });
  assert.equal(first.status, 201);
  // A captured body re-sent under a fresh delivery id: the Linear-Delivery
  // header is unsigned, so its claim passes and only the hash of the signed
  // bytes can refuse the replay.
  const replay = await linear.action({ request: linearRequest(body, { delivery: randomUUID() }) });
  assert.equal(replay.status, 200);
  assert.match(JSON.stringify(await replay.json()), /duplicate delivery/);
  const tasks = (await tasksFrom("linear")).filter((t) => t.dedupeKey === `linear:${id}`);
  assert.equal(tasks.length, 1, "the replayed body never becomes a second task");
});

test("linear: webhookTimestamp is required — a body without one, or with a non-numeric one, gets 401", async () => {
  const before = (await tasksFrom("linear")).length;
  const without = JSON.parse(issueEvent()) as Record<string, unknown>;
  delete without.webhookTimestamp;
  const missing = await linear.action({ request: linearRequest(JSON.stringify(without)) });
  assert.equal(missing.status, 401);
  assert.match(JSON.stringify(await missing.json()), /webhookTimestamp/);
  const notNumber = JSON.parse(issueEvent()) as { webhookTimestamp: unknown };
  notNumber.webhookTimestamp = "just now";
  const textual = await linear.action({ request: linearRequest(JSON.stringify(notNumber)) });
  assert.equal(textual.status, 401);
  assert.match(JSON.stringify(await textual.json()), /webhookTimestamp/);
  assert.equal((await tasksFrom("linear")).length, before, "nothing written");
});

test("slack: a signature header whose UTF-8 bytes differ in length is a 401, never a crash", async () => {
  // 67 characters — the same STRING length as a v0 signature — but each é is
  // two UTF-8 bytes, so the buffers differ in length and a byte-blind
  // timingSafeEqual compare would throw (a 500 from an unsigned request).
  const res = await slack.action({ request: slackRequest(mention("<@U0SHIP> crash probe", "1760600008.000900"), { signature: `v0=${"é".repeat(64)}` }) });
  assert.equal(res.status, 401);
});

test("linear: a signature header whose UTF-8 bytes differ in length is a 401, never a crash", async () => {
  // 64 characters — the same STRING length as a Linear signature — of
  // two-byte é: the buffers differ in length; the compare must not throw.
  const res = await linear.action({ request: linearRequest(issueEvent(), { signature: "é".repeat(64) }) });
  assert.equal(res.status, 401);
});
