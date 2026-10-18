import { test } from "node:test";
import assert from "node:assert/strict";

import {
  conditionMatches,
  conditionsMatch,
  cooldownActive,
  decideEvent,
  episodeDedupeKey,
  eventRulesMode,
  eventSourceSecret,
  freshSubjectRecord,
  renderEventTemplate,
  ruleSeesEvent,
  shipEventFromEnvelope,
  validateEventRule,
  validateEventSource,
  type Condition,
  type EventRule,
  type EventSourceRecord,
  type ShipEvent,
} from "./event-rules.js";

const SOURCE: EventSourceRecord = { id: "acme", auth: "hmac", enabled: true, createdAt: "2026-10-17T00:00:00Z", by: "tyler" };
const SHARED: EventSourceRecord = { id: "datadog", auth: "shared-secret", enabled: true, createdAt: "2026-10-17T00:00:00Z", by: "tyler" };

function rule(over: Partial<EventRule> = {}): EventRule {
  return {
    id: "rule-1",
    name: "New issue",
    enabled: true,
    match: { source: "acme", types: ["issue.new"] },
    task: { kind: "event", repoFrom: "fixed", repo: "https://git.example.com/acme/app.git", titleTemplate: "Issue: {{attr.severity}} {{subject}}", detailTemplate: "{{detail}} ({{attr.count}})" },
    dedupeKey: "rule:{{rule.id}}:{{subject}}",
    closeOn: ["issue.resolved"],
    policy: "propose",
    by: "tyler",
    createdAt: "2026-10-17T00:00:00Z",
    ...over,
  };
}

function event(over: Partial<ShipEvent> = {}): ShipEvent {
  return {
    source: "acme",
    type: "issue.new",
    eventId: "ev-1",
    subject: "acme:checkout",
    occurredAt: "2026-10-17T10:00:00Z",
    title: "Checkout 500s",
    detail: "spike after deploy",
    attrs: { severity: "high", count: 12 },
    ...over,
  };
}

// ---------------------------------------------------------------- mode/secret

test("eventRulesMode: default off; exactly shadow and on are recognised", () => {
  assert.equal(eventRulesMode({}), "off");
  assert.equal(eventRulesMode({ SHIP_EVENT_RULES: "" }), "off");
  assert.equal(eventRulesMode({ SHIP_EVENT_RULES: "off" }), "off");
  assert.equal(eventRulesMode({ SHIP_EVENT_RULES: "shadow" }), "shadow");
  assert.equal(eventRulesMode({ SHIP_EVENT_RULES: "on" }), "on");
  assert.equal(eventRulesMode({ SHIP_EVENT_RULES: "ON" }), "on");
  assert.equal(eventRulesMode({ SHIP_EVENT_RULES: "yes" }), "off");
});

test("eventSourceSecret maps a source id to its env var, dashes and case included", () => {
  assert.equal(eventSourceSecret("acme-ci", { SHIP_EVENT_SECRET_ACME_CI: "s3cret" }), "s3cret");
  assert.equal(eventSourceSecret("acme", { SHIP_EVENT_SECRET_ACME: " " }), undefined);
  assert.equal(eventSourceSecret("acme", {}), undefined);
});

// ---------------------------------------------------------------- validation

test("validateEventRule accepts a well-formed rule and rejects structural damage", () => {
  assert.equal(validateEventRule(rule(), [SOURCE]).ok, true);
  const cases: Array<[Partial<EventRule>, RegExp]> = [
    [{ id: "Bad_Id" }, /id/],
    [{ match: { source: "acme", types: [] } }, /match\.types/],
    [{ task: { ...rule().task, kind: "mega-fix" as never } }, /task\.kind/],
    [{ task: { ...rule().task, repoFrom: "fixed", repo: undefined } as EventRule["task"] }, /task\.repo/],
    [{ dedupeKey: "rule:{{subject}}:{{typo}}" }, /unknown template token/],
    [{ policy: "always" as never }, /policy/],
    [{ ratePerHour: 0 }, /ratePerHour/],
    [{ when: [{ attr: "severity", op: "matches", value: 3 } as unknown as Condition] }, /matches/],
  ];
  for (const [over, pattern] of cases) {
    const checked = validateEventRule(rule(over), [SOURCE]);
    assert.equal(checked.ok, false, `expected refusal for ${JSON.stringify(over)}`);
    assert.match((checked as { problem: string }).problem, pattern);
  }
});

test("Decision 12: policy auto is refused on a shared-secret source, allowed on hmac; propose/dry-run always pass", () => {
  const auto = rule({ policy: "auto", match: { source: "datadog", types: ["alert.triggered"] } });
  const refused = validateEventRule(auto, [SHARED]);
  assert.equal(refused.ok, false);
  assert.match((refused as { problem: string }).problem, /Decision 12/);
  assert.equal(validateEventRule(auto, [SOURCE, SHARED]).ok, false, "no override exists");
  const onHmac = rule({ policy: "auto" });
  assert.equal(validateEventRule(onHmac, [SOURCE]).ok, true);
  assert.equal(validateEventRule(rule({ policy: "propose", match: { source: "datadog", types: ["alert.triggered"] } }), [SHARED]).ok, true);
  assert.equal(validateEventRule(rule({ policy: "dry-run", match: { source: "datadog", types: ["alert.triggered"] } }), [SHARED]).ok, true);
});

test("validateEventRule refuses a rule whose source is not registered", () => {
  const checked = validateEventRule(rule(), []);
  assert.equal(checked.ok, false);
  assert.match((checked as { problem: string }).problem, /not registered/);
});

test("validateEventSource checks ids, auth, and the window bounds", () => {
  assert.equal(validateEventSource({ id: "acme", auth: "hmac", enabled: true, createdAt: "2026-10-17T00:00:00Z", by: "tyler" }).ok, true);
  assert.equal(validateEventSource({ id: "No", auth: "hmac", enabled: true, createdAt: "2026-10-17T00:00:00Z", by: "tyler" }).ok, false);
  assert.equal(validateEventSource({ id: "acme", auth: "token" as never, enabled: true, createdAt: "2026-10-17T00:00:00Z", by: "tyler" }).ok, false);
  assert.equal(validateEventSource({ id: "acme", auth: "hmac", enabled: true, replayWindowSeconds: 10, createdAt: "2026-10-17T00:00:00Z", by: "tyler" }).ok, false);
});

// ---------------------------------------------------------------- conditions

test("conditions: eq/ne/in/gte/lte/matches over attrs and the type pseudo-attr", () => {
  const e = event();
  assert.equal(conditionMatches(e, { attr: "severity", op: "eq", value: "high" }), true);
  assert.equal(conditionMatches(e, { attr: "severity", op: "eq", value: "low" }), false);
  assert.equal(conditionMatches(e, { attr: "severity", op: "ne", value: "low" }), true);
  assert.equal(conditionMatches(e, { attr: "severity", op: "in", value: ["high", "critical"] }), true);
  assert.equal(conditionMatches(e, { attr: "count", op: "gte", value: 10 }), true);
  assert.equal(conditionMatches(e, { attr: "count", op: "lte", value: 10 }), false);
  assert.equal(conditionMatches(e, { attr: "type", op: "eq", value: "issue.new" }), true);
  assert.equal(conditionMatches(e, { attr: "env", op: "eq", value: "prod" }), false, "missing attr is not equal");
  assert.equal(conditionMatches(e, { attr: "env", op: "ne", value: "prod" }), true, "missing attr is not-equal");
  assert.equal(conditionMatches(e, { attr: "severity", op: "matches", value: "^hi" }), true);
  assert.equal(conditionMatches(e, { attr: "count", op: "gte", value: "10" }), false, "mixed types never order");
  assert.equal(conditionsMatch(e, [{ attr: "severity", op: "eq", value: "high" }, { attr: "count", op: "gte", value: 5 }]), true);
  assert.equal(conditionsMatch(e, [{ attr: "severity", op: "eq", value: "high" }, { attr: "count", op: "gte", value: 50 }]), false);
});

// ---------------------------------------------------------------- templates

test("templates substitute built-ins and clamped attrs; unknown tokens render empty", () => {
  const r = rule();
  const e = event();
  assert.equal(renderEventTemplate("rule:{{rule.id}}:{{subject}}", r, e), "rule:rule-1:acme:checkout");
  assert.equal(renderEventTemplate("{{type}} {{attr.severity}} {{attr.count}}", r, e), "issue.new high 12");
  assert.equal(renderEventTemplate("{{attr.missing}}", r, e), "");
  const long = event({ attrs: { blob: "x".repeat(5_000) } });
  assert.ok(renderEventTemplate("{{attr.blob}}", r, long).length <= 301);
});

test("episodeDedupeKey appends the episode counter only for episodic rules", () => {
  const episodic = rule();
  const flat = rule({ closeOn: undefined });
  assert.equal(episodeDedupeKey("rule:1:sub", episodic, 2), "rule:1:sub:e2");
  assert.equal(episodeDedupeKey("rule:1:sub", flat, 2), "rule:1:sub");
});

// ------------------------------------------------------------------ adapter

test("shipEventFromEnvelope maps the envelope, clamps, redacts, and drops URL repoHints", () => {
  const envelope = {
    eventId: "ev-9",
    schemaVersion: "1.0",
    type: "issue.new",
    cursor: 7,
    occurredAt: "2026-10-17T10:00:00Z",
    data: {
      subject: "acme:checkout",
      title: "Checkout 500s sk-abcdefghijklmnopqrstuvwx",
      detail: "spike after deploy",
      attrs: { severity: "high", count: 12, nested: { x: 1 } },
      repoHint: "acme/app",
    },
  };
  const mapped = shipEventFromEnvelope("acme", envelope);
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;
  assert.equal(mapped.event.source, "acme");
  assert.equal(mapped.event.eventId, "ev-9");
  assert.equal(mapped.event.seq, 7);
  assert.equal(mapped.event.repoHint, "acme/app");
  assert.equal(mapped.event.attrs.severity, "high");
  assert.equal("nested" in mapped.event.attrs, false, "non-scalar attrs are dropped");
  assert.ok(!mapped.event.title.includes("sk-abcdefghijklmnopqrstuvwx"), "provider tokens are redacted");

  const urlHint = shipEventFromEnvelope("acme", { ...envelope, data: { ...envelope.data, repoHint: "https://evil.example.com/x.git" } });
  assert.equal(urlHint.ok && urlHint.event.repoHint, undefined, "a payload URL is never a repoHint");

  assert.equal(shipEventFromEnvelope("acme", { ...envelope, data: { ...envelope.data, subject: "" } }).ok, false);
  assert.equal(shipEventFromEnvelope("acme", { ...envelope, data: null }).ok, false);
});

// ----------------------------------------------------------------- ordering

test("decideEvent: a resolved older than the open trigger is stale and produces no input", () => {
  const r = rule();
  const open = decideEvent(r, event({ occurredAt: "2026-10-17T10:00:00Z" }), null, "2026-10-17T10:00:05Z", undefined);
  assert.equal(open.action, "task");
  if (open.action !== "task") return;
  assert.equal(open.episode, 1);
  const record = open.record;
  const late = decideEvent(r, event({ type: "issue.resolved", occurredAt: "2026-10-17T09:59:00Z" }), record, "2026-10-17T10:01:00Z", undefined);
  assert.equal(late.action, "stale");
});

test("decideEvent: a close after an open closes; a newer trigger opens episode 2 with a suffixed key", () => {
  const r = rule();
  const open = decideEvent(r, event({ occurredAt: "2026-10-17T10:00:00Z" }), null, "2026-10-17T10:00:01Z", undefined);
  if (open.action !== "task") return assert.fail("expected task");
  const close = decideEvent(r, event({ type: "issue.resolved", occurredAt: "2026-10-17T10:05:00Z" }), open.record, "2026-10-17T10:05:01Z", undefined);
  assert.equal(close.action, "close");
  if (close.action !== "close") return;
  assert.equal(close.record.state, "closed");
  const again = decideEvent(r, event({ occurredAt: "2026-10-17T11:00:00Z", eventId: "ev-2" }), close.record, "2026-10-17T11:00:01Z", undefined);
  assert.equal(again.action, "task");
  if (again.action !== "task") return;
  assert.equal(again.newEpisode, true);
  assert.equal(again.episode, 2);
  assert.equal(again.dedupeKey, "rule:rule-1:acme:checkout:e2");
});

test("decideEvent: a resolved arriving BEFORE any trigger starts closed, and an older trigger is stale", () => {
  const r = rule();
  const close = decideEvent(r, event({ type: "issue.resolved", occurredAt: "2026-10-17T10:05:00Z" }), null, "2026-10-17T10:05:01Z", undefined);
  assert.equal(close.action, "close", "a close with no open episode just sets the watermark");
  if (close.action !== "close") return;
  const trigger = decideEvent(r, event({ occurredAt: "2026-10-17T10:00:00Z" }), close.record, "2026-10-17T10:06:00Z", undefined);
  assert.equal(trigger.action, "stale", "the trigger the close already answered is stale");
});

test("decideEvent: an exact-timestamp tie favours the trigger (open wins)", () => {
  const r = rule();
  const open = decideEvent(r, event({ occurredAt: "2026-10-17T10:00:00Z" }), null, "2026-10-17T10:00:01Z", undefined);
  if (open.action !== "task") return assert.fail("expected task");
  const tieClose = decideEvent(r, event({ type: "issue.resolved", occurredAt: "2026-10-17T10:00:00Z" }), open.record, "2026-10-17T10:00:02Z", undefined);
  assert.equal(tieClose.action, "tie-open", "an exact-tie close does not close the episode");
  // The direction that matters for a human: a trigger at an exact tie with a
  // closed watermark still opens the next episode.
  const closedRecord = { ...open.record, state: "closed" as const };
  const tieTrigger = decideEvent(r, event({ occurredAt: "2026-10-17T10:00:00Z", eventId: "ev-2" }), closedRecord, "2026-10-17T10:00:03Z", undefined);
  assert.equal(tieTrigger.action, "task");
  if (tieTrigger.action !== "task") return;
  assert.equal(tieTrigger.newEpisode, true);
});

test("decideEvent: seq breaks timestamp ties in both directions", () => {
  const r = rule({ closeOn: undefined, debounceSeconds: undefined });
  const base = { ruleId: "rule-1", subject: "acme:checkout", episode: 1, state: "open" as const, lastOccurredAt: "2026-10-17T10:00:00Z", lastSeq: 5, episodeFired: true, updatedAt: "2026-10-17T10:00:00Z" };
  const olderSeq = decideEvent(r, event({ occurredAt: "2026-10-17T10:00:00Z", seq: 4 }), base, "2026-10-17T10:00:01Z", undefined);
  assert.equal(olderSeq.action, "stale");
  const newerSeq = decideEvent(r, event({ occurredAt: "2026-10-17T10:00:00Z", seq: 6 }), base, "2026-10-17T10:00:01Z", undefined);
  assert.equal(newerSeq.action, "task", "same timestamp, higher seq: acts");
});

test("decideEvent: conditions gate closes too; debounce absorbs later events in the window", () => {
  const r = rule({ when: [{ attr: "severity", op: "eq", value: "high" }], debounceSeconds: 300 });
  const open = decideEvent(r, event({ occurredAt: "2026-10-17T10:00:00Z" }), null, "2026-10-17T10:00:01Z", undefined);
  assert.equal(open.action, "task");
  if (open.action !== "task") return;
  const quiet = decideEvent(r, event({ type: "issue.resolved", occurredAt: "2026-10-17T10:02:00Z", attrs: { severity: "low" } }), open.record, "2026-10-17T10:02:01Z", undefined);
  assert.equal(quiet.action, "skip", "a close the conditions reject does not close the episode");
  const burst = decideEvent(r, event({ occurredAt: "2026-10-17T10:03:00Z", eventId: "ev-2" }), open.record, "2026-10-17T10:03:01Z", undefined);
  assert.equal(burst.action, "absorb");
  if (burst.action !== "absorb") return;
  assert.equal(burst.record.absorbed, 1);
  const after = decideEvent(r, event({ occurredAt: "2026-10-17T10:30:00Z", eventId: "ev-3" }), burst.record, "2026-10-17T10:30:01Z", undefined);
  assert.equal(after.action, "task", "past the debounce window the episode's task is re-offered (intake collapses it)");
  if (after.action !== "task") return;
  assert.equal(after.dedupeKey, open.dedupeKey);
});

test("decideEvent: the proposed input carries the events: source namespace and the fixed repo", () => {
  const decision = decideEvent(rule(), event(), null, "2026-10-17T10:00:01Z", undefined);
  if (decision.action !== "task") return assert.fail("expected task");
  assert.equal(decision.input.source, "events:acme");
  assert.equal(decision.input.kind, "event");
  assert.equal(decision.input.repo, "https://git.example.com/acme/app.git");
  assert.equal(decision.input.title, "Issue: high acme:checkout");
  assert.equal(decision.input.detail, "spike after deploy (12)");
  assert.equal(decision.input.dedupeKey, "rule:rule-1:acme:checkout:e1");
});

test("ruleSeesEvent matches types and closeOn for the rule's own source only", () => {
  const r = rule();
  assert.equal(ruleSeesEvent(r, event()), true);
  assert.equal(ruleSeesEvent(r, event({ type: "issue.resolved" })), true);
  assert.equal(ruleSeesEvent(r, event({ type: "issue.ignored" })), false);
  assert.equal(ruleSeesEvent(r, event({ source: "other" })), false);
  assert.equal(ruleSeesEvent({ ...r, enabled: false }, event()), false);
});

test("cooldownActive is false without a record or a window, true inside one", () => {
  assert.equal(cooldownActive(null, Date.now()), false);
  assert.equal(cooldownActive(freshSubjectRecord("r", "s", "2026-10-17T00:00:00Z"), Date.now()), false);
  const until = new Date(Date.parse("2026-10-17T11:00:00Z")).toISOString();
  const rec = { ...freshSubjectRecord("r", "s", "2026-10-17T00:00:00Z"), dismissedUntil: until };
  assert.equal(cooldownActive(rec, Date.parse("2026-10-17T10:00:00Z")), true);
  assert.equal(cooldownActive(rec, Date.parse("2026-10-17T11:00:01Z")), false);
});
