import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";

import { handleEventIntake, handleEventRuleDryRun, handleEventRuleSave, handleEventSourceSave, SHARED_SECRET_MIN_BYTES } from "./event-rules.server.js";
import { signEvent } from "../../../dist/tool-manifest.js";
import type { EventEnvelope } from "../../../dist/tool-manifest.js";
import { FileIntakeStore } from "../../../dist/intake.js";
import { MemoryRuntimeConfig } from "../../../dist/runtime-config.js";
import { listSeenEvents, saveEventRule, saveEventSource } from "../../../dist/event-subjects.js";
import type { EventRulesRuntime } from "./event-rules.server.js";

/**
 * E7 EV2 — the generic signed receiver's contract: the S24 envelope over
 * X-Teploy-Timestamp / X-Teploy-Signature, the per-source secret, the
 * replay window, the delivery claim, and the flag ladder
 * (off: 503 / shadow: log only / on: act). These mirror the
 * incident-intake receiver tests; the engine's own controls (episodes,
 * rate, cooldown) live in the root suite.
 */

const SECRET = "acme-hmac-secret";
const NOW = Date.parse("2026-10-17T12:00:00Z");

function envelope(over: Partial<EventEnvelope["data"]> = {}, type = "issue.new"): EventEnvelope {
  return {
    eventId: "ev-1",
    schemaVersion: "1.0",
    type,
    cursor: 0,
    occurredAt: "2026-10-17T10:00:00Z",
    data: { subject: "acme:checkout", title: "Checkout 500s", detail: "spike after deploy", attrs: { severity: "high" }, ...over },
  };
}

function signed(env: EventEnvelope, over: Record<string, string> = {}, secret = SECRET, nowMs = NOW): Request {
  const signedBody = signEvent(env, secret, nowMs);
  return new Request("https://ship.test/hooks/events/acme", {
    method: "POST",
    body: signedBody.body,
    headers: { "content-type": "application/json", ...signedBody.headers, ...over },
  });
}

interface Harness {
  runtime: EventRulesRuntime;
  env: NodeJS.ProcessEnv;
  config: MemoryRuntimeConfig;
  intake: FileIntakeStore;
  claims: string[];
}

async function harness(envOver: Record<string, string> = {}): Promise<Harness> {
  const config = new MemoryRuntimeConfig();
  const intake = new FileIntakeStore(mkdtempSync(join(tmpdir(), "ship-ev2-web-")));
  await saveEventSource(config, { id: "acme", auth: "hmac", enabled: true, createdAt: "2026-10-17T00:00:00Z", by: "tyler" });
  await saveEventRule(
    config,
    {
      id: "rule-1",
      name: "New issue",
      enabled: true,
      match: { source: "acme", types: ["issue.new"] },
      task: { kind: "event", repoFrom: "fixed", repo: "https://git.example.com/acme/app.git", titleTemplate: "Issue: {{subject}}", detailTemplate: "{{detail}}" },
      dedupeKey: "rule:{{rule.id}}:{{subject}}",
      closeOn: ["issue.resolved"],
      policy: "propose",
      by: "tyler",
      createdAt: "2026-10-17T00:00:00Z",
    },
    [{ id: "acme", auth: "hmac", enabled: true, createdAt: "2026-10-17T00:00:00Z", by: "tyler" }],
  );
  const claims: string[] = [];
  const h: Harness = {
    config,
    intake,
    claims,
    env: { SHIP_EVENT_RULES: "on", SHIP_EVENT_SECRET_ACME: SECRET, ...envOver },
    runtime: {
      config,
      deliveries: {
        claim: async (source, id) => {
          const key = `${source}:${id}`;
          if (claims.includes(key)) return false;
          claims.push(key);
          return true;
        },
      },
      intake,
      // The project record widens proposeExternal's clone allowlist with its
      // URL, exactly as a registered project would for any other source.
      projects: { list: async () => [{ url: "https://git.example.com/acme/app.git" }], forRepo: async () => null },
    },
  };
  return h;
}

const deps = (h: Harness) => ({ runtime: h.runtime, env: h.env, now: () => NOW, log: () => {} });

async function snapshot(h: Harness): Promise<unknown> {
  return { config: await h.config.list(), tasks: await h.intake.list(), claims: [...h.claims] };
}

// ------------------------------------------------------------------- flag

test("off (the default) answers 503 and nothing is stored", async () => {
  const h = await harness({ SHIP_EVENT_RULES: "" });
  const before = await snapshot(h);
  const res = await handleEventIntake(signed(envelope()), "acme", deps(h));
  assert.equal(res.status, 503);
  assert.deepEqual(await snapshot(h), before);
});

test("an unknown or disabled source is a 404, indistinguishable to the caller", async () => {
  const h = await harness();
  assert.equal((await handleEventIntake(signed(envelope()), "nope", deps(h))).status, 404);
  await h.config.set("SHIP_EVENT_SOURCE_acme", ""); // remove() via empty value
  assert.equal((await handleEventIntake(signed(envelope()), "acme", deps(h))).status, 404);
});

// -------------------------------------------------------------------- auth

test("a bad signature is a 401 and nothing is stored", async () => {
  const h = await harness();
  const before = await snapshot(h);
  const res = await handleEventIntake(signed(envelope(), {}, "not-the-secret"), "acme", deps(h));
  assert.equal(res.status, 401);
  assert.match(await res.text(), /bad-signature/);
  assert.deepEqual(await snapshot(h), before, "no claim, no ring, no task");
});

test("a stale timestamp is a 401 even with a valid MAC", async () => {
  const h = await harness();
  const res = await handleEventIntake(signed(envelope(), {}, SECRET, NOW - 3_600_000), "acme", deps(h));
  assert.equal(res.status, 401);
  assert.match(await res.text(), /expired/);
  assert.equal((await h.intake.list()).length, 0);
});

test("a missing secret is a 503; a malformed envelope body is a 400", async () => {
  const h = await harness({ SHIP_EVENT_SECRET_ACME: "" });
  assert.equal((await handleEventIntake(signed(envelope()), "acme", deps(h))).status, 503);
  const ok = await harness();
  const ts = String(Math.floor(NOW / 1000));
  const mac = `sha256=${createHmac("sha256", SECRET).update(`${ts}.{not json`).digest("hex")}`;
  const malformed = new Request("https://ship.test/hooks/events/acme", {
    method: "POST",
    body: "{not json",
    headers: { "x-teploy-timestamp": ts, "x-teploy-signature": mac },
  });
  assert.equal((await handleEventIntake(malformed, "acme", deps(ok))).status, 400);
});

// ------------------------------------------------------------------- dedupe

test("a duplicate delivery is skipped; the same event under a second delivery id collapses to one task", async () => {
  const h = await harness();
  const first = await handleEventIntake(signed(envelope(), { "x-teploy-delivery": "d1" }), "acme", deps(h));
  assert.equal(first.status, 200);
  const again = await handleEventIntake(signed(envelope(), { "x-teploy-delivery": "d1" }), "acme", deps(h));
  assert.equal(again.status, 200);
  assert.match(await again.text(), /duplicate delivery/);
  const other = await handleEventIntake(signed(envelope(), { "x-teploy-delivery": "d2" }), "acme", deps(h));
  assert.match(await other.text(), /existing/);
  const tasks = await h.intake.list();
  assert.equal(tasks.length, 1);
});

test("resolved before triggered: one stale outcome, zero tasks, stale recorded in the ring", async () => {
  const h = await harness();
  const resolved = { ...envelope({}, "issue.resolved"), occurredAt: "2026-10-17T10:05:00Z" };
  const close = await handleEventIntake(signed(resolved, { "x-teploy-delivery": "d1" }), "acme", deps(h));
  assert.match(JSON.stringify(await close.json()), /closed/);
  const late = await handleEventIntake(signed(envelope(), { "x-teploy-delivery": "d2" }), "acme", deps(h));
  const outcomes = (await late.json()) as { outcomes: Array<{ outcome: string }> };
  assert.equal(outcomes.outcomes[0]?.outcome, "stale");
  assert.equal((await h.intake.list()).length, 0);
  const seen = await listSeenEvents(h.config, "acme");
  assert.equal(seen[seen.length - 1]?.outcomes[0]?.outcome, "stale");
});

// ------------------------------------------------------------------- shadow

test("shadow evaluates and records the ring but proposes nothing and writes no subjects", async () => {
  const h = await harness({ SHIP_EVENT_RULES: "shadow" });
  const res = await handleEventIntake(signed(envelope(), { "x-teploy-delivery": "d1" }), "acme", deps(h));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { mode: string; outcomes: Array<{ outcome: string }> };
  assert.equal(body.mode, "shadow");
  assert.equal(body.outcomes[0]?.outcome, "dry-run");
  assert.equal((await h.intake.list()).length, 0);
  const subjects = (await h.config.list()).filter((e) => e.key.startsWith("SHIP_EVENT_SUBJECT_"));
  assert.equal(subjects.length, 0, "a flip to on starts from clean subject state");
  assert.equal((await listSeenEvents(h.config, "acme")).length, 1);
});

// ----------------------------------------------------------- shared secret

test("shared-secret source: constant-time token, 401 on a miss, expired bodies skipped not refused", async () => {
  const token = "t".repeat(SHARED_SECRET_MIN_BYTES);
  const h = await harness({ SHIP_EVENT_SECRET_DATADOG: token });
  await saveEventSource(h.config, { id: "datadog", auth: "shared-secret", enabled: true, createdAt: "2026-10-17T00:00:00Z", by: "tyler" });
  const post = (over: Record<string, string>, env: EventEnvelope) =>
    new Request("https://ship.test/hooks/events/datadog", { method: "POST", body: JSON.stringify(env), headers: { "content-type": "application/json", ...over } });
  assert.equal((await handleEventIntake(post({ "x-teploy-token": "wrong" }, envelope()), "datadog", deps(h))).status, 401);
  assert.equal((await handleEventIntake(post({}, envelope()), "datadog", deps(h))).status, 401, "no token is a refusal");
  // No rules match the datadog source, so a good token lands and records.
  const ok = await handleEventIntake(post({ "x-teploy-token": token }, envelope()), "datadog", deps(h));
  assert.equal(ok.status, 200);
  const old = await handleEventIntake(
    post({ "x-teploy-token": token }, { ...envelope(), eventId: "ev-old", occurredAt: "2026-10-15T10:00:00Z" }),
    "datadog",
    deps(h),
  );
  assert.match(await old.text(), /expired/);
});

test("saving an auto rule on a shared-secret source is refused; propose saves", async () => {
  const h = await harness({ SHIP_EVENT_SECRET_DATADOG: "t".repeat(SHARED_SECRET_MIN_BYTES) });
  const sourceReq = (source: unknown) => new Request("https://ship.test/api/event-sources", { method: "POST", body: JSON.stringify({ source }) });
  assert.equal((await handleEventSourceSave(sourceReq({ id: "datadog", auth: "shared-secret", enabled: true }), "tyler", deps(h))).status, 200);

  const ruleReq = (rule: unknown) => new Request("https://ship.test/api/event-rules", { method: "POST", body: JSON.stringify({ rule }) });
  const base = {
    id: "dd-1",
    name: "Alert",
    enabled: true,
    match: { source: "datadog", types: ["alert.triggered"] },
    task: { kind: "event", repoFrom: "fixed", repo: "https://git.example.com/acme/app.git", titleTemplate: "{{subject}}", detailTemplate: "{{detail}}" },
    dedupeKey: "rule:{{rule.id}}:{{subject}}",
    policy: "auto",
    by: "",
    createdAt: "2026-10-17T00:00:00Z",
  };
  const refused = await handleEventRuleSave(ruleReq(base), "tyler", deps(h));
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /Decision 12/);
  const allowed = await handleEventRuleSave(ruleReq({ ...base, policy: "propose" }), "tyler", deps(h));
  assert.equal(allowed.status, 200);
});

test("a shared-secret source cannot be registered without a 32-byte secret", async () => {
  const h = await harness({ SHIP_EVENT_SECRET_DATADOG: "short" });
  const req = (source: unknown) => new Request("https://ship.test/api/event-sources", { method: "POST", body: JSON.stringify({ source }) });
  const res = await handleEventSourceSave(req({ id: "datadog", auth: "shared-secret", enabled: true }), "tyler", deps(h));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /SHIP_EVENT_SECRET_DATADOG/);
});

// ------------------------------------------------------------------ dry run

test("dry run returns the exact ProposeInput and writes nothing (store diff empty)", async () => {
  const h = await harness();
  // A live delivery first, so the dry run collapses onto a REAL task and the
  // subject record exists.
  await handleEventIntake(signed(envelope(), { "x-teploy-delivery": "d1" }), "acme", deps(h));
  const task = (await h.intake.list())[0]!;

  const payload = JSON.stringify(envelope());
  const req = new Request("https://ship.test/api/event-rules/rule-1/dry-run", { method: "POST", body: JSON.stringify({ payload }) });
  const before = await snapshot(h);
  const res = await handleEventRuleDryRun("rule-1", req, deps(h));
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    dryRun: boolean;
    ordering: { action: string };
    input: { source: string; kind: string; repo: string; title: string; detail: string; dedupeKey: string };
    dedupeKey: string;
    collapsesOnto: string;
  };
  assert.equal(body.dryRun, true);
  assert.equal(body.ordering.action, "task");
  assert.deepEqual(body.input, {
    source: "events:acme",
    kind: "event",
    repo: "https://git.example.com/acme/app.git",
    title: "Issue: acme:checkout",
    detail: "spike after deploy",
    dedupeKey: "rule:rule-1:acme:checkout:e1",
  });
  assert.equal(body.dedupeKey, "rule:rule-1:acme:checkout:e1");
  assert.equal(body.collapsesOnto, task.taskId, "it names the task the delivery would collapse onto");
  assert.deepEqual(await snapshot(h), before, "a dry run writes literally nothing");

  const missing = new Request("https://ship.test/api/event-rules/rule-1/dry-run", { method: "POST", body: JSON.stringify({ payload: "{bad" }) });
  assert.equal((await handleEventRuleDryRun("rule-1", missing, deps(h))).status, 400);
  const unknown = new Request("https://ship.test/api/event-rules/rule-x/dry-run", { method: "POST", body: JSON.stringify({ payload }) });
  assert.equal((await handleEventRuleDryRun("rule-x", unknown, deps(h))).status, 404);
});

test("dry run replays a recorded delivery by event id and reports a stale ordering verdict", async () => {
  const h = await harness();
  // resolved first at 10:05, so the recorded trigger at 10:00 replays stale.
  const resolved = { ...envelope({}, "issue.resolved"), eventId: "ev-resolved", occurredAt: "2026-10-17T10:05:00Z" };
  await handleEventIntake(signed(resolved, { "x-teploy-delivery": "d1" }), "acme", deps(h));
  await handleEventIntake(signed(envelope(), { "x-teploy-delivery": "d2" }), "acme", deps(h));
  const req = new Request("https://ship.test/api/event-rules/rule-1/dry-run", { method: "POST", body: JSON.stringify({ recorded: "ev-1" }) });
  const before = await snapshot(h);
  const res = await handleEventRuleDryRun("rule-1", req, deps(h));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ordering: { action: string; watermark?: string } };
  assert.equal(body.ordering.action, "stale");
  assert.deepEqual(await snapshot(h), before);
});
