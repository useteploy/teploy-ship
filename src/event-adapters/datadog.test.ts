import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { datadogAdapter, DATADOG_PAYLOAD_TEMPLATE } from "./datadog.js";
import type { AdapterOptions, HeaderBag } from "./adapter.js";
import { validateEventRule, type EventSourceRecord } from "../event-rules.js";

/**
 * E7 EV4 — Datadog adapter controls: shared-secret auth through a custom
 * header, the mandatory payload template, and the transition mapping. No
 * HMAC exists for Datadog, so the negative controls are about the token and
 * the template, not a signature.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "event-adapters", "fixtures");
const TOKEN = "dd-token-must-be-32-bytes-long!!"; // 34 chars: the shared-secret floor
const OPTS: AdapterOptions = { secret: TOKEN, nowMs: 0, auth: "shared-secret", tokenHeader: "x-datadog-token" };

const bag = (h: Record<string, string>): HeaderBag => new Headers(h);

const fixture = async (): Promise<string> => await readFile(join(FIXTURES, "datadog-triggered.json"), "utf8");

test("the template payload verifies by custom header and maps to alert.triggered", async () => {
  const body = await fixture();
  const headers = bag({ "x-datadog-token": TOKEN });
  assert.deepEqual(datadogAdapter.verify(headers, body, OPTS), { ok: true });
  const mapped = datadogAdapter.map("dd-prod", headers, body, OPTS);
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;
  const event = mapped.events[0]!;
  assert.equal(event.type, "alert.triggered");
  assert.equal(event.eventId, "1234567"); // $ID, the vendor's own event id
  assert.equal(event.subject, "datadog:1234/9bd4ac313a4d1e8fae2482df7b77628"); // monitor/cycle
  assert.equal(event.occurredAt, new Date(1406662672 * 1000).toISOString()); // $LAST_UPDATED_POSIX
  assert.equal(event.repoHint, "myService"); // $TAGS[service], the attribution hint
  assert.equal(event.attrs.priority, "P1");
});

test("a wrong or missing token is a 401", async () => {
  const body = await fixture();
  const verifyStatus = (v: { ok: true } | { ok: false; status: number }): number => (v.ok ? 200 : v.status);
  assert.equal(verifyStatus(datadogAdapter.verify(bag({ "x-datadog-token": "not-the-token-not-the-token-not" }), body, OPTS)), 401);
  assert.equal(verifyStatus(datadogAdapter.verify(bag({}), body, OPTS)), 401);
  // The default header applies when the source does not name one.
  const defaultHeader = { secret: TOKEN, nowMs: 0, auth: "shared-secret" } as AdapterOptions;
  assert.deepEqual(datadogAdapter.verify(bag({ "x-teploy-token": TOKEN }), body, defaultHeader), { ok: true });
});

test("a payload without the template's id is refused 400, not deduped on nothing", async () => {
  const body = await fixture();
  const stripped = JSON.parse(body) as Record<string, unknown>;
  delete stripped.id;
  const mapped = datadogAdapter.map("dd-prod", bag({}), JSON.stringify(stripped), OPTS);
  assert.equal(mapped.ok, false);
  if (mapped.ok) return;
  assert.equal(mapped.status, 400);
  assert.match(mapped.problem, /"id"/);
  assert.match(mapped.problem, /template/);
});

test("transitions map: Recovered closes, Warn records without a default rule, Re-Triggered re-opens", async () => {
  const base = JSON.parse(await fixture()) as Record<string, string>;
  const withTransition = (transition: string): string => JSON.stringify({ ...base, transition, id: `${base.id}-${transition}`.replace(/[^a-z0-9]/gi, "") });
  const types = (body: string): string | undefined => {
    const mapped = datadogAdapter.map("dd-prod", bag({}), body, OPTS);
    return mapped.ok ? mapped.events[0]?.type : `refused:${mapped.status}`;
  };
  assert.equal(types(withTransition("Recovered")), "alert.recovered");
  assert.equal(types(withTransition("Triggered")), "alert.triggered");
  assert.equal(types(withTransition("Re-Triggered")), "alert.triggered");
  assert.equal(types(withTransition("Warn")), "alert.warn");
  assert.equal(types(withTransition("No Data")), "alert.warn");
  assert.equal(types(withTransition("Renotify")), "alert.warn");
});

test("Decision 12 unchanged here: an auto rule on a Datadog (shared-secret) source is refused at save", () => {
  const source: EventSourceRecord = { id: "dd-prod", auth: "shared-secret", enabled: true, vendor: "datadog", createdAt: "2026-10-17T00:00:00Z", by: "tyler" };
  const rule = {
    id: "auto-rule",
    name: "Auto",
    enabled: true,
    match: { source: "dd-prod", types: ["alert.triggered"] },
    task: { kind: "event", repoFrom: "attribution", titleTemplate: "{{title}}", detailTemplate: "{{detail}}" },
    dedupeKey: "rule:{{rule.id}}:{{subject}}",
    policy: "auto",
    by: "tyler",
    createdAt: "2026-10-17T00:00:00Z",
  };
  const refused = validateEventRule(rule, [source]);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.problem, /auto/);
  const proposed = { ...rule, policy: "propose" as const };
  assert.equal(validateEventRule(proposed, [source]).ok, true);
  assert.match(DATADOG_PAYLOAD_TEMPLATE, /"id":"\$ID"/);
});
