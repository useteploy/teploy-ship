import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { gitlabAdapter } from "./gitlab.js";
import type { AdapterOptions, HeaderBag } from "./adapter.js";
import { MemoryRuntimeConfig } from "../runtime-config.js";
import { FileIntakeStore } from "../intake.js";
import { ciFixTaskFromWorkflowRun } from "../intake-sources.js";
import { processEvent, saveEventRule, saveEventSource, type EventProcessDeps } from "../event-subjects.js";
import type { EventRule } from "../event-rules.js";

/**
 * E7 EV4 — GitLab adapter controls against the documented payloads
 * (docs.gitlab.com, fetched 2026-10-17): the Standard Webhooks signing
 * token, the X-Gitlab-Token fallback, the delivery id, and the headline
 * property — a pipeline.failed on a ship/ branch collapses onto the SAME
 * CI task the forge webhooks and the PR poll already produce.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "event-adapters", "fixtures");
const NOW = Date.parse("2016-08-12T15:30:00Z");
const SIGNING_KEY = "K3nuzLbVvJ6qR0xY+F8MnTQ4sBzA1wPj9CDEfg5Hi6o="; // the base64 key under GitLab's whsec_ prefix
const TOKEN = "gitlab-secret-token-32-bytes-long!!";

const bag = (h: Record<string, string>): HeaderBag => new Headers(h);

const signOpts = (over: Partial<AdapterOptions> = {}): AdapterOptions => ({ secret: `whsec_${SIGNING_KEY}`, nowMs: NOW, auth: "hmac", ...over });
const tokenOpts = (over: Partial<AdapterOptions> = {}): AdapterOptions => ({ secret: TOKEN, nowMs: NOW, auth: "shared-secret", ...over });

const WEBHOOK_ID = "f5e5f430-f57b-4e6e-9fac-d9128cd7232f";
const TIMESTAMP = String(Math.floor(NOW / 1000));

function signedHeaders(body: string, over: Record<string, string> = {}, key = SIGNING_KEY): HeaderBag {
  const digest = createHmac("sha256", Buffer.from(key, "base64")).update(`${WEBHOOK_ID}.${TIMESTAMP}.${body}`, "utf8").digest("base64");
  return bag({ "webhook-id": WEBHOOK_ID, "webhook-timestamp": TIMESTAMP, "webhook-signature": `v1,${digest}`, ...over });
}

const fixture = async (name: string): Promise<string> => await readFile(join(FIXTURES, name), "utf8");

test("the documented pipeline example verifies by signing token and maps to pipeline.failed", async () => {
  const body = await fixture("gitlab-pipeline-failed.json");
  const headers = signedHeaders(body);
  assert.deepEqual(gitlabAdapter.verify(headers, body, signOpts()), { ok: true });
  const mapped = gitlabAdapter.map("gl-main", headers, body, signOpts());
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;
  const event = mapped.events[0]!;
  assert.equal(event.type, "pipeline.failed");
  assert.equal(event.eventId, WEBHOOK_ID); // webhook-id == Idempotency-Key, stable across retries
  assert.equal(event.subject, `gitlab:gitlab-org/gitlab-test/pipeline/bcbb5ec396a2c0f828686f14fac9b80b780504f2`);
  assert.equal(event.repoHint, "gitlab-org/gitlab-test");
  // The CI dedupe key family: same attrs the GitHub workflow_run path uses.
  assert.equal(event.attrs.repo, "gitlab-org/gitlab-test");
  assert.equal(event.attrs.pr, 7);
  assert.equal(event.attrs.sha, "bcbb5ec396a2c0f828686f14fac9b80b780504f2");
  assert.equal(event.seq, 31); // pipeline id: the monotonic tie-breaker
});

test("signing-token negatives: mutated body 401, stale timestamp 401, wrong key 401", async () => {
  const body = await fixture("gitlab-pipeline-failed.json");
  const mutated = body.replace('"status": "failed"', '"status": "failed "');
  assert.equal(gitlabAdapter.verify(signedHeaders(body), mutated, signOpts()).ok, false);
  const stale = signOpts({ nowMs: NOW + 3600_000 });
  assert.deepEqual(gitlabAdapter.verify(signedHeaders(body), body, stale), { ok: false, status: 401, reason: "expired" });
  const wrongKey = signOpts({ secret: "whsec_Wron0gKeyVjpZTaXj2+DZ8W9QxHcPl1sUm4NBvGf0eY=" });
  assert.equal(gitlabAdapter.verify(signedHeaders(body), body, wrongKey).ok, false);
  // The message id is read from webhook-id; a delivery that only sends the
  // legacy Idempotency-Key cannot be verified (map still dedupes on it).
  const digest = createHmac("sha256", Buffer.from(SIGNING_KEY, "base64")).update(`${WEBHOOK_ID}.${TIMESTAMP}.${body}`, "utf8").digest("base64");
  const legacy = bag({ "Idempotency-Key": WEBHOOK_ID, "webhook-timestamp": TIMESTAMP, "webhook-signature": `v1,${digest}` });
  assert.deepEqual(gitlabAdapter.verify(legacy, body, signOpts()), { ok: false, status: 401, reason: "malformed-signature" });
  assert.equal(gitlabAdapter.verify(bag({ "webhook-id": WEBHOOK_ID, "webhook-timestamp": TIMESTAMP }), body, signOpts()).ok, false);
});

test("the secret-token mode verifies X-Gitlab-Token in constant time (shared-secret class)", async () => {
  const body = await fixture("gitlab-pipeline-failed.json");
  const headers = bag({ "x-gitlab-token": TOKEN, "idempotency-key": WEBHOOK_ID });
  assert.deepEqual(gitlabAdapter.verify(headers, body, tokenOpts()), { ok: true });
  const verifyStatus = (v: { ok: true } | { ok: false; status: number }): number => (v.ok ? 200 : v.status);
  assert.equal(verifyStatus(gitlabAdapter.verify(bag({ "x-gitlab-token": "not-the-token-not-the-token-not!" }), body, tokenOpts())), 401);
  assert.equal(gitlabAdapter.verify(bag({ "idempotency-key": WEBHOOK_ID }), body, tokenOpts()).ok, false);
});

test("no webhook-id and no Idempotency-Key means no dedupe id: refused 400", async () => {
  const body = await fixture("gitlab-pipeline-failed.json");
  const mapped = gitlabAdapter.map("gl-main", bag({}), body, signOpts());
  assert.equal(mapped.ok, false);
  if (mapped.ok) return;
  assert.equal(mapped.status, 400);
  assert.match(mapped.problem, /webhook-id/);
});

test("the documented merge example maps action merge to pr.merged; a passing pipeline maps to nothing", async () => {
  const body = await fixture("gitlab-mr-merged.json");
  const headers = signedHeaders(body);
  const mapped = gitlabAdapter.map("gl-main", headers, body, signOpts());
  assert.equal(mapped.ok && mapped.events[0]?.type, "pr.merged");
  assert.equal(mapped.ok && mapped.events[0]?.subject, "gitlab:flightjs/flight-management!16");

  const pipeline = await fixture("gitlab-pipeline-failed.json");
  const green = pipeline.replace('"status": "failed"', '"status": "success"');
  const okPipeline = gitlabAdapter.map("gl-main", signedHeaders(green), green, signOpts());
  assert.equal(okPipeline.ok && okPipeline.events.length, 0);
});

test("a pipeline.failed on a ship/ branch collapses onto the existing CI task (same dedupe key family)", async () => {
  const config = new MemoryRuntimeConfig();
  const sources = [{ id: "gl-main", auth: "hmac" as const, enabled: true, vendor: "gitlab" as const, createdAt: "2026-10-17T00:00:00Z", by: "tyler" }];
  await saveEventSource(config, sources[0]!);
  // The rule's key template renders exactly what ciFixTaskFromWorkflowRun
  // writes: ci:<full_name>#<pr>:<head_sha> (src/intake-sources.ts).
  const rule: EventRule = {
    id: "ci-fail",
    name: "CI failed",
    enabled: true,
    match: { source: "gl-main", types: ["pipeline.failed"] },
    task: { kind: "event", repoFrom: "attribution", titleTemplate: "CI failed on !{{attr.pr}}: {{title}}", detailTemplate: "{{detail}}" },
    dedupeKey: "ci:{{attr.repo}}#{{attr.pr}}:{{attr.sha}}",
    policy: "propose",
    by: "tyler",
    createdAt: "2026-10-17T00:00:00Z",
  };
  assert.equal((await saveEventRule(config, rule, sources)).ok, true);
  const intake = new FileIntakeStore(mkdtempSync(join(tmpdir(), "ship-ev4-gitlab-")));
  const deps: EventProcessDeps = { config, propose: (input) => intake.propose(input), log: () => {} };

  const body = await fixture("gitlab-pipeline-failed.json");
  const headers = signedHeaders(body);
  const mapped = gitlabAdapter.map("gl-main", headers, body, signOpts());
  if (!mapped.ok) throw new Error("pipeline fixture must map");
  const result = await processEvent(deps, { sourceId: "gl-main", event: mapped.events[0]!, deliveryId: mapped.deliveryId, mode: "on", nowMs: NOW });
  assert.equal(result.outcomes[0]!.outcome, "proposed");
  assert.equal(result.outcomes[0]!.outcome === "proposed" && result.outcomes[0].input.dedupeKey, "ci:gitlab-org/gitlab-test#7:bcbb5ec396a2c0f828686f14fac9b80b780504f2");
  const webhookTask = (await intake.list())[0]!;

  // The same failure reported the GitHub way — a workflow_run the poll or
  // the forge webhook delivered — proposes the SAME key and collapses.
  const ciInput = ciFixTaskFromWorkflowRun({
    action: "completed",
    workflow_run: {
      name: "Pipeline for branch: ship/checkout-fix",
      conclusion: "failure",
      head_branch: "ship/checkout-fix",
      head_sha: "bcbb5ec396a2c0f828686f14fac9b80b780504f2",
      pull_requests: [{ number: 7 }],
    },
    repository: { full_name: "gitlab-org/gitlab-test", clone_url: "http://192.168.64.1:3005/gitlab-org/gitlab-test.git" },
  });
  assert.ok(ciInput !== null);
  assert.equal(ciInput!.dedupeKey, "ci:gitlab-org/gitlab-test#7:bcbb5ec396a2c0f828686f14fac9b80b780504f2");
  const second = await intake.propose(ciInput!);
  assert.equal(second.created, false);
  assert.equal(second.task.taskId, webhookTask.taskId);
  assert.equal((await intake.list()).length, 1);
});
