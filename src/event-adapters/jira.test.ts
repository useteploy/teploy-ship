import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { jiraAdapter } from "./jira.js";
import type { AdapterOptions, HeaderBag } from "./adapter.js";
import { MemoryRuntimeConfig } from "../runtime-config.js";
import { FileIntakeStore, type ProposeInput } from "../intake.js";
import { processEvent, saveEventRule, saveEventSource, type EventProcessDeps } from "../event-subjects.js";
import type { EventRule } from "../event-rules.js";

/**
 * E7 EV4 — Jira adapter controls: the X-Hub-Signature scheme (pinned to
 * Atlassian's documented test vector), the label mapping, the webhook
 * identifier as the dedupe id, and the Secondary-flow ordering check — a
 * delivery older than the subject's watermark is stale, never a re-open.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "event-adapters", "fixtures");
const SECRET = "G8j4166a5OkXRD4WbqV3"; // the shape of the docs' registration example
const OPTS: AdapterOptions = { secret: SECRET, nowMs: 0, auth: "hmac", label: "ship" };

const bag = (h: Record<string, string>): HeaderBag => new Headers(h);

const sign = (body: string, secret = SECRET): string => `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

const fixture = async (name: string): Promise<string> => await readFile(join(FIXTURES, name), "utf8");

test("Atlassian's documented test vector verifies", () => {
  // developer.atlassian.com/cloud/jira/platform/webhooks: secret
  // "It's a Secret to Everybody", payload "Hello World!", method sha256.
  const vectorSecret = "It's a Secret to Everybody";
  const payload = "Hello World!";
  const header = "sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9";
  const result = jiraAdapter.verify(bag({ "x-hub-signature": header }), payload, { secret: vectorSecret, nowMs: 0, auth: "hmac" });
  assert.deepEqual(result, { ok: true });
});

test("the documented issue-created example verifies and maps to ticket.labelled", async () => {
  const body = await fixture("jira-issue-created.json");
  const headers = bag({ "x-hub-signature": sign(body), "x-atlassian-webhook-identifier": "e2c1c22d-2e57-4cd3-8f0c-4e7a3d5f9b01", "x-atlassian-webhook-flow": "Primary" });
  assert.deepEqual(jiraAdapter.verify(headers, body, OPTS), { ok: true });
  const mapped = jiraAdapter.map("jira-cloud", headers, body, OPTS);
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;
  const event = mapped.events[0]!;
  assert.equal(event.type, "ticket.labelled");
  assert.equal(event.eventId, "e2c1c22d-2e57-4cd3-8f0c-4e7a3d5f9b01"); // stable across Jira's five retries
  assert.equal(event.subject, "jira:JRA-20002");
  assert.equal(event.occurredAt, new Date(1606480436302).toISOString());
  assert.equal(event.attrs.label, "ship");
  assert.equal(event.attrs.project, "EXA");
  assert.equal(event.attrs.flow, "Primary");
  assert.equal(mapped.deliveryId, "e2c1c22d-2e57-4cd3-8f0c-4e7a3d5f9b01");
});

test("an update maps only when the changelog ADDS the label; every later edit of a labelled issue maps to nothing", async () => {
  const body = await fixture("jira-issue-updated.json");
  const headers = (id: string) => bag({ "x-hub-signature": sign(body), "x-atlassian-webhook-identifier": id });
  const added = jiraAdapter.map("jira-cloud", headers("upd-1"), body, OPTS);
  assert.equal(added.ok && added.events[0]?.type, "ticket.labelled");

  const parsed = JSON.parse(body) as { changelog: { items: unknown[] } };
  parsed.changelog.items = parsed.changelog.items.filter((item) => (item as { field: string }).field !== "labels");
  const relabelled = jiraAdapter.map("jira-cloud", headers("upd-2"), JSON.stringify(parsed), OPTS);
  assert.equal(relabelled.ok && relabelled.events.length, 0);
});

test("a comment maps to ticket.comment, which no default rule matches", async () => {
  const body = await fixture("jira-issue-updated.json");
  const parsed = JSON.parse(body) as Record<string, unknown>;
  parsed.webhookEvent = "comment_created";
  parsed.comment = { body: "Please look at the failing checkout tests" };
  const headers = bag({ "x-hub-signature": sign(body), "x-atlassian-webhook-identifier": "cmt-1" });
  const mapped = jiraAdapter.map("jira-cloud", headers, JSON.stringify(parsed), OPTS);
  assert.equal(mapped.ok && mapped.events[0]?.type, "ticket.comment");
});

test("a mutated body or an unknown method prefix is a 401", async () => {
  const body = await fixture("jira-issue-created.json");
  const headers = bag({ "x-hub-signature": sign(body), "x-atlassian-webhook-identifier": "x-1" });
  const mutated = body.replace("I feel the need for speed", "I feel the need for speeed");
  const verifyStatus = (v: { ok: true } | { ok: false; status: number }): number => (v.ok ? 200 : v.status);
  assert.equal(verifyStatus(jiraAdapter.verify(headers, mutated, OPTS)), 401);
  // The method must be parsed, not assumed: sha1 is refused by name.
  const sha1 = jiraAdapter.verify(bag({ "x-hub-signature": `sha1=${"a".repeat(40)}` }), body, OPTS);
  assert.equal(sha1.ok, false);
  if (!sha1.ok) assert.match(sha1.reason, /unsupported-signature-method/);
});

test("no X-Atlassian-Webhook-Identifier means no dedupe id: refused 400", async () => {
  const body = await fixture("jira-issue-created.json");
  const headers = bag({ "x-hub-signature": sign(body) });
  const mapped = jiraAdapter.map("jira-cloud", headers, body, OPTS);
  assert.equal(mapped.ok, false);
  if (mapped.ok) return;
  assert.equal(mapped.status, 400);
  assert.match(mapped.problem, /X-Atlassian-Webhook-Identifier/);
});

test("a Secondary delivery older than the subject watermark is stale and creates no task", async () => {
  const config = new MemoryRuntimeConfig();
  const sources = [{ id: "jira-cloud", auth: "hmac" as const, enabled: true, vendor: "jira" as const, label: "ship", createdAt: "2026-10-17T00:00:00Z", by: "tyler" }];
  await saveEventSource(config, sources[0]!);
  const rule: EventRule = {
    id: "labelled",
    name: "Labelled",
    enabled: true,
    match: { source: "jira-cloud", types: ["ticket.labelled"] },
    task: { kind: "event", repoFrom: "attribution", titleTemplate: "{{title}}", detailTemplate: "{{detail}}" },
    dedupeKey: "rule:{{rule.id}}:{{subject}}",
    policy: "propose",
    by: "tyler",
    createdAt: "2026-10-17T00:00:00Z",
  };
  assert.equal((await saveEventRule(config, rule, sources)).ok, true);
  const intake = new FileIntakeStore(mkdtempSync(join(tmpdir(), "ship-ev4-jira-")));
  const proposeCalls: ProposeInput[] = [];
  const deps: EventProcessDeps = { config, propose: async (input) => { proposeCalls.push(input); return intake.propose(input); }, log: () => {} };

  const updated = await fixture("jira-issue-updated.json"); // timestamp 1606480536302 (newer)
  const created = await fixture("jira-issue-created.json"); // timestamp 1606480436302 (older)
  const mapped = (body: string, id: string, flow: string, ts: number) =>
    jiraAdapter.map("jira-cloud", bag({ "x-hub-signature": sign(body), "x-atlassian-webhook-identifier": id, "x-atlassian-webhook-flow": flow }), body, { ...OPTS, nowMs: ts });
  const newer = mapped(updated, "flow-primary", "Primary", Date.parse("2026-10-17T12:00:00Z"));
  const older = mapped(created, "flow-secondary", "Secondary", Date.parse("2026-10-17T12:00:01Z"));
  if (!newer.ok || !older.ok) throw new Error("jira fixtures must map");

  const first = await processEvent(deps, { sourceId: "jira-cloud", event: newer.events[0]!, deliveryId: "flow-primary", mode: "on", nowMs: Date.parse("2026-10-17T12:00:00Z") });
  assert.equal(first.outcomes[0]!.outcome, "proposed");
  // The lagging Secondary delivery is RECORDED as stale and proposes nothing.
  const second = await processEvent(deps, { sourceId: "jira-cloud", event: older.events[0]!, deliveryId: "flow-secondary", mode: "on", nowMs: Date.parse("2026-10-17T12:00:01Z") });
  assert.deepEqual(second.outcomes[0]!.outcome, "stale");
  assert.equal(proposeCalls.length, 1);
  assert.equal((await intake.list()).length, 1);
});
