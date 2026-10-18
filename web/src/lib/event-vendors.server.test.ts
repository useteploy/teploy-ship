import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

import { handleEventIntake, handleEventRuleSave, handleEventSourceSave } from "./event-rules.server.js";
import { FileIntakeStore } from "../../../dist/intake.js";
import { MemoryRuntimeConfig } from "../../../dist/runtime-config.js";
import { saveEventRule, saveEventSource, listSeenEvents } from "../../../dist/event-subjects.js";
import type { EventSourceRecord } from "../../../dist/event-rules.js";
import type { EventRulesRuntime } from "./event-rules.server.js";

/**
 * E7 EV4 — the vendor leg of `/hooks/events/:source` behind the same flag
 * ladder and delivery claim as the envelope leg. The deep per-vendor
 * controls live in the root suite (src/event-adapters/*.test.ts); these pin
 * the ROUTE contract: 503/404 unchanged, 401 on a bad signature, 400 on an
 * id-less payload, one task per delivery, and Decision 12 at save.
 */

const NOW = Date.parse("2025-11-10T21:00:00Z"); // just after the Sentry fixture's lastSeen
const SENTRY_SECRET = "sentry-client-secret";
const DD_TOKEN = "dd-token-must-be-32-bytes-long!!"; // 34 chars: the shared-secret floor
const GL_TOKEN = "gitlab-secret-token-32-bytes-long!!";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "event-adapters", "fixtures");

const fixture = async (name: string): Promise<string> => await readFile(join(FIXTURES, name), "utf8");

interface Harness {
  runtime: EventRulesRuntime;
  env: NodeJS.ProcessEnv;
  config: MemoryRuntimeConfig;
  intake: FileIntakeStore;
  claims: string[];
}

async function harness(source: EventSourceRecord, rule: { types: string[]; dedupeKey?: string }, secretEnv: Record<string, string>): Promise<Harness> {
  const config = new MemoryRuntimeConfig();
  const intake = new FileIntakeStore(mkdtempSync(join(tmpdir(), "ship-ev4-web-")));
  await saveEventSource(config, source);
  await saveEventRule(
    config,
    {
      id: "rule-1",
      name: "Vendor rule",
      enabled: true,
      match: { source: source.id, types: rule.types },
      task: { kind: "event", repoFrom: "fixed", repo: "https://git.example.com/acme/app.git", titleTemplate: "{{title}}", detailTemplate: "{{detail}}" },
      dedupeKey: rule.dedupeKey ?? "rule:{{rule.id}}:{{subject}}",
      policy: "propose",
      by: "tyler",
      createdAt: "2026-10-17T00:00:00Z",
    },
    [source],
  );
  const claims: string[] = [];
  return {
    config,
    intake,
    claims,
    env: { SHIP_EVENT_RULES: "on", ...secretEnv },
    runtime: {
      config,
      deliveries: {
        claim: async (s, id) => {
          const key = `${s}:${id}`;
          if (claims.includes(key)) return false;
          claims.push(key);
          return true;
        },
      },
      intake,
      projects: { list: async () => [{ url: "https://git.example.com/acme/app.git" }], forRepo: async () => null },
    },
  };
}

const deps = (h: Harness) => ({ runtime: h.runtime, env: h.env, now: () => NOW, log: () => {} });

const sentrySource: EventSourceRecord = { id: "sentry-prod", auth: "hmac", enabled: true, vendor: "sentry", createdAt: "2026-10-17T00:00:00Z", by: "tyler" };

function sentryRequest(body: string, over: Record<string, string> = {}, secret = SENTRY_SECRET, signBody = body): Request {
  return new Request("https://ship.test/hooks/events/sentry-prod", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "sentry-hook-resource": "issue",
      "request-id": "8a2e4f0e-6f7b-4d3a-9c1d-2b6e8f0a5d7c",
      "sentry-hook-signature": createHmac("sha256", secret).update(signBody, "utf8").digest("hex"),
      ...over,
    },
  });
}

test("a signed Sentry issue delivery verifies, maps and proposes one task", async () => {
  const body = await fixture("sentry-issue-created.json");
  const h = await harness(sentrySource, { types: ["issue.new"] }, { SHIP_EVENT_SECRET_SENTRY_PROD: SENTRY_SECRET });
  const res = await handleEventIntake(sentryRequest(body), "sentry-prod", deps(h));
  assert.equal(res.status, 200);
  const payload = JSON.parse(await res.text()) as { outcomes: Array<{ outcome: string }>; vendor: string };
  assert.equal(payload.vendor, "sentry");
  assert.deepEqual(payload.outcomes.map((o) => o.outcome), ["proposed"]);
  assert.equal((await h.intake.list()).length, 1);
  assert.equal((await listSeenEvents(h.config, "sentry-prod"))[0]?.eventId, "8a2e4f0e-6f7b-4d3a-9c1d-2b6e8f0a5d7c");

  // The same delivery id again (a Sentry retry) is skipped before any rule runs.
  const retry = await handleEventIntake(sentryRequest(body), "sentry-prod", deps(h));
  assert.equal(retry.status, 200);
  assert.match(await retry.text(), /duplicate delivery/);
  assert.equal((await h.intake.list()).length, 1);
});

test("a mutated Sentry body is a 401 with nothing stored", async () => {
  const body = await fixture("sentry-issue-created.json");
  const h = await harness(sentrySource, { types: ["issue.new"] }, { SHIP_EVENT_SECRET_SENTRY_PROD: SENTRY_SECRET });
  const mutated = body.replace('"fatal"', '"error"');
  // Signed over the ORIGINAL body: the signature no longer covers the bytes.
  const res = await handleEventIntake(sentryRequest(mutated, {}, SENTRY_SECRET, body), "sentry-prod", deps(h));
  assert.equal(res.status, 401);
  assert.match(await res.text(), /bad-signature/);
  assert.deepEqual(h.claims, []);
  assert.equal((await h.intake.list()).length, 0);
  assert.equal((await listSeenEvents(h.config, "sentry-prod")).length, 0);
});

test("a Sentry delivery without Request-ID is a 400, not a body-hash dedupe", async () => {
  const body = await fixture("sentry-issue-created.json");
  const h = await harness(sentrySource, { types: ["issue.new"] }, { SHIP_EVENT_SECRET_SENTRY_PROD: SENTRY_SECRET });
  const res = await handleEventIntake(sentryRequest(body, { "request-id": "" }), "sentry-prod", deps(h));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Request-ID/);
  assert.deepEqual(h.claims, []);
});

test("the flag ladder still rules the vendor leg: off answers 503, unknown source 404", async () => {
  const body = await fixture("sentry-issue-created.json");
  const h = await harness(sentrySource, { types: ["issue.new"] }, { SHIP_EVENT_SECRET_SENTRY_PROD: SENTRY_SECRET });
  const off = await handleEventIntake(sentryRequest(body), "sentry-prod", { ...deps(h), env: { ...h.env, SHIP_EVENT_RULES: "" } });
  assert.equal(off.status, 503);
  const unknown = await handleEventIntake(sentryRequest(body), "nope", deps(h));
  assert.equal(unknown.status, 404);
});

test("a Datadog source takes its token from the configured custom header, and an id-less payload is a 400", async () => {
  const body = await fixture("datadog-triggered.json");
  const source: EventSourceRecord = { id: "dd-prod", auth: "shared-secret", enabled: true, vendor: "datadog", tokenHeader: "x-datadog-token", createdAt: "2026-10-17T00:00:00Z", by: "tyler" };
  const h = await harness(source, { types: ["alert.triggered", "alert.recovered"] }, { SHIP_EVENT_SECRET_DD_PROD: DD_TOKEN });
  const ok = new Request("https://ship.test/hooks/events/dd-prod", { method: "POST", body, headers: { "x-datadog-token": DD_TOKEN } });
  const res = await handleEventIntake(ok, "dd-prod", { ...deps(h), now: () => Date.parse("2014-07-29T18:40:00Z") });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /proposed/);
  const wrong = new Request("https://ship.test/hooks/events/dd-prod", { method: "POST", body, headers: { "x-datadog-token": "not-the-token-not-the-token-not" } });
  assert.equal((await handleEventIntake(wrong, "dd-prod", { ...deps(h), now: () => Date.parse("2014-07-29T18:40:00Z") })).status, 401);
  const stripped = JSON.parse(body) as Record<string, unknown>;
  delete stripped.id;
  const idless = new Request("https://ship.test/hooks/events/dd-prod", { method: "POST", body: JSON.stringify(stripped), headers: { "x-datadog-token": DD_TOKEN } });
  const refused = await handleEventIntake(idless, "dd-prod", { ...deps(h), now: () => Date.parse("2014-07-29T18:40:00Z") });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /is missing/); // names the missing template key and the template to paste
});

test("a GitLab token-mode delivery proposes through the route, and an expired Datadog body is skipped softly", async () => {
  const body = await fixture("gitlab-pipeline-failed.json");
  const source: EventSourceRecord = { id: "gl-old", auth: "shared-secret", enabled: true, vendor: "gitlab", createdAt: "2026-10-17T00:00:00Z", by: "tyler" };
  const h = await harness(
    source,
    { types: ["pipeline.failed"], dedupeKey: "ci:{{attr.repo}}#{{attr.pr}}:{{attr.sha}}" },
    { SHIP_EVENT_SECRET_GL_OLD: GL_TOKEN },
  );
  const ok = new Request("https://ship.test/hooks/events/gl-old", {
    method: "POST",
    body,
    headers: { "x-gitlab-token": GL_TOKEN, "idempotency-key": "f5e5f430-f57b-4e6e-9fac-d9128cd7232f" },
  });
  const res = await handleEventIntake(ok, "gl-old", { ...deps(h), now: () => Date.parse("2016-08-12T15:30:00Z") });
  assert.equal(res.status, 200);
  const tasks = await h.intake.list();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.dedupeKey, "ci:gitlab-org/gitlab-test#7:bcbb5ec396a2c0f828686f14fac9b80b780504f2");

  // Datadog body from 2014 against a 2025 clock: recorded as expired, no task.
  const ddSource: EventSourceRecord = { id: "dd-old", auth: "shared-secret", enabled: true, vendor: "datadog", tokenHeader: "x-datadog-token", createdAt: "2026-10-17T00:00:00Z", by: "tyler" };
  const dh = await harness(ddSource, { types: ["alert.triggered"] }, { SHIP_EVENT_SECRET_DD_OLD: DD_TOKEN });
  const ddBody = await fixture("datadog-triggered.json");
  const old = new Request("https://ship.test/hooks/events/dd-old", { method: "POST", body: ddBody, headers: { "x-datadog-token": DD_TOKEN } });
  const skipped = await handleEventIntake(old, "dd-old", deps(dh));
  assert.equal(skipped.status, 200);
  const skippedPayload = JSON.parse(await skipped.text()) as { skipped: Array<{ reason: string }>; outcomes: unknown[] };
  assert.deepEqual(skippedPayload.outcomes, []);
  assert.equal(skippedPayload.skipped?.[0]?.reason, "expired");
  assert.equal((await dh.intake.list()).length, 0);
  assert.equal((await listSeenEvents(dh.config, "dd-old"))[0]?.outcomes[0]?.outcome, "expired");
});

test("registering vendors through the API: jira needs a label, and datadog refuses an auto rule", async () => {
  const h = await harness(sentrySource, { types: ["issue.new"] }, { SHIP_EVENT_SECRET_SENTRY_PROD: SENTRY_SECRET });
  const save = (source: unknown) => handleEventSourceSave(new Request("https://ship.test/api/event-sources", { method: "POST", body: JSON.stringify({ source }) }), "tyler", deps(h));

  const noLabel = await save({ id: "jira-cloud", auth: "hmac", enabled: true, vendor: "jira", createdAt: "2026-10-17T00:00:00Z", by: "tyler" });
  assert.equal(noLabel.status, 400);
  assert.match(await noLabel.text(), /label/);
  const ddOk = await save({ id: "dd-prod", auth: "shared-secret", enabled: true, vendor: "datadog", tokenHeader: "x-datadog-token", createdAt: "2026-10-17T00:00:00Z", by: "tyler" });
  assert.equal(ddOk.status, 400); // the token is not set in this harness's env
  assert.match(await ddOk.text(), /SHIP_EVENT_SECRET_DD_PROD/);

  const ddEnv = { ...h.env, SHIP_EVENT_SECRET_DD_PROD: DD_TOKEN };
  const registered = await handleEventSourceSave(
    new Request("https://ship.test/api/event-sources", { method: "POST", body: JSON.stringify({ source: { id: "dd-prod", auth: "shared-secret", enabled: true, vendor: "datadog", tokenHeader: "x-datadog-token", createdAt: "2026-10-17T00:00:00Z", by: "tyler" } }) }),
    "tyler",
    { ...deps(h), env: ddEnv },
  );
  assert.equal(registered.status, 200);
  const autoRule = await handleEventRuleSave(
    new Request("https://ship.test/api/event-rules", {
      method: "POST",
      body: JSON.stringify({
        rule: {
          id: "dd-auto", name: "No", enabled: true, match: { source: "dd-prod", types: ["alert.triggered"] },
          task: { kind: "event", repoFrom: "fixed", repo: "https://git.example.com/acme/app.git", titleTemplate: "{{title}}", detailTemplate: "{{detail}}" },
          dedupeKey: "rule:{{rule.id}}:{{subject}}", policy: "auto", by: "tyler", createdAt: "2026-10-17T00:00:00Z",
        },
      }),
    }),
    "tyler",
    { ...deps(h), env: ddEnv },
  );
  assert.equal(autoRule.status, 400);
  assert.match(await autoRule.text(), /auto/);
});
