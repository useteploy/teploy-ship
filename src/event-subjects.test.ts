import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemoryRuntimeConfig } from "./runtime-config.js";
import { FileIntakeStore } from "./intake.js";
import type { IntakeStore, IntakeTask, ProposeInput } from "./intake.js";
import {
  eventRuleKey,
  eventSubjectKey,
  listEventRules,
  listSeenEvents,
  processEvent,
  rateKey,
  saveEventRule,
  saveEventSource,
  takeRateSlot,
  SEEN_LIMIT,
  type EventProcessDeps,
  type RuleOutcome,
} from "./event-subjects.js";
import type { EventRule, ShipEvent } from "./event-rules.js";

/**
 * E7 EV2 pipeline controls. Everything runs against the real file intake
 * store in a temp dir and the in-memory runtime config, so the dedupe
 * layers exercised are the ones production uses: the intake dedupe key and
 * the proposed-to-launched claim sit under the propose calls here, the
 * delivery claim sits one layer up (covered by the web receiver tests).
 */

const NOW = Date.parse("2026-10-17T12:00:00Z");

const RULE: EventRule = {
  id: "rule-1",
  name: "New issue",
  enabled: true,
  match: { source: "acme", types: ["issue.new"] },
  task: { kind: "event", repoFrom: "fixed", repo: "https://git.example.com/acme/app.git", titleTemplate: "Issue: {{subject}}", detailTemplate: "{{title}}" },
  dedupeKey: "rule:{{rule.id}}:{{subject}}",
  closeOn: ["issue.resolved"],
  policy: "propose",
  ratePerHour: 100,
  by: "tyler",
  createdAt: "2026-10-17T00:00:00Z",
};

function event(over: Partial<ShipEvent> = {}): ShipEvent {
  return {
    source: "acme",
    type: "issue.new",
    eventId: "ev-1",
    subject: "acme:checkout",
    occurredAt: "2026-10-17T10:00:00Z",
    title: "Checkout 500s",
    detail: "spike after deploy",
    attrs: {},
    ...over,
  };
}

interface Harness {
  deps: EventProcessDeps;
  intake: IntakeStore;
  config: MemoryRuntimeConfig;
  proposeCalls: ProposeInput[];
}

async function harness(over: Partial<EventRule> = {}): Promise<Harness> {
  const config = new MemoryRuntimeConfig();
  await saveEventSource(config, { id: "acme", auth: "hmac", enabled: true, createdAt: "2026-10-17T00:00:00Z", by: "tyler" });
  const saved = await saveEventRule(config, { ...RULE, ...over }, [{ id: "acme", auth: "hmac", enabled: true, createdAt: "2026-10-17T00:00:00Z", by: "tyler" }]);
  assert.equal(saved.ok, true);
  const proposeCalls: ProposeInput[] = [];
  // A fake propose with the real store underneath, so dedupe-by-key is the
  // production behaviour rather than an assertion.
  const intake: IntakeStore = new FileIntakeStore(await mkdtemp(join(tmpdir(), "ship-ev2-intake-")));
  const deps: EventProcessDeps = {
    config,
    propose: async (input) => {
      proposeCalls.push(input);
      return intake.propose(input);
    },
    getTask: (taskId) => intake.get(taskId),
    log: () => {},
  };
  return { deps, intake, config, proposeCalls };
}

async function run(h: Harness, e: ShipEvent, mode: "on" | "shadow" = "on", nowMs = NOW): Promise<RuleOutcome[]> {
  const result = await processEvent(h.deps, { sourceId: "acme", event: e, deliveryId: null, mode, nowMs });
  return result.outcomes;
}

const created = (outcomes: RuleOutcome[]) => outcomes.filter((o) => o.outcome === "proposed").length;
const tasks = async (h: Harness) => (await h.intake.list()).length;

// ------------------------------------------------------------ rule storage

test("rules and sources persist under their own config keys and reload intact", async () => {
  const h = await harness();
  const rules = await listEventRules(h.config);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.id, "rule-1");
  assert.ok([... (await h.config.list())].some((e) => e.key === eventRuleKey("rule-1")));
  // A damaged row is skipped, not fatal.
  await h.config.set(eventRuleKey("broken"), "{not json");
  assert.equal((await listEventRules(h.config)).length, 1);
});

// --------------------------------------------------------------- dedupe

test("the same event twice (two delivery ids) produces exactly one task", async () => {
  const h = await harness();
  const first = await run(h, event());
  assert.equal(created(first), 1);
  const second = await run(h, event());
  assert.equal(second[0]?.outcome, "existing", "the second delivery collapses onto the same task");
  assert.equal(await tasks(h), 1);
  assert.equal(h.proposeCalls.length, 2, "both deliveries reached propose; intake deduped");
});

test("a burst inside one episode collapses to the episode's one task", async () => {
  const h = await harness();
  await run(h, event({ occurredAt: "2026-10-17T10:00:00Z" }));
  await run(h, event({ occurredAt: "2026-10-17T10:10:00Z", eventId: "ev-2" }));
  await run(h, event({ occurredAt: "2026-10-17T10:20:00Z", eventId: "ev-3" }));
  assert.equal(await tasks(h), 1);
});

// -------------------------------------------------------------- ordering

test("resolved-before-triggered: zero tasks, the trigger is recorded stale", async () => {
  const h = await harness();
  const closeFirst = await run(h, event({ type: "issue.resolved", occurredAt: "2026-10-17T10:05:00Z" }));
  assert.equal(closeFirst[0]?.outcome, "closed");
  const late = await run(h, event({ occurredAt: "2026-10-17T10:00:00Z" }));
  assert.equal(late[0]?.outcome, "stale");
  assert.equal(await tasks(h), 0);
  const seen = await listSeenEvents(h.config, "acme");
  assert.deepEqual(seen[seen.length - 1]?.outcomes.map((o) => o.outcome), ["stale"]);
});

test("a trigger after a close opens a second episode and proposes a second task", async () => {
  const h = await harness();
  await run(h, event({ occurredAt: "2026-10-17T10:00:00Z" }));
  await run(h, event({ type: "issue.resolved", occurredAt: "2026-10-17T10:05:00Z" }));
  const reopened = await run(h, event({ occurredAt: "2026-10-17T11:00:00Z", eventId: "ev-2" }));
  assert.equal(created(reopened), 1);
  const reopenedOutcome = reopened[0] as Extract<RuleOutcome, { outcome: "proposed" }>;
  assert.equal(reopenedOutcome.input.dedupeKey, "rule:rule-1:acme:checkout:e2");
  assert.equal(await tasks(h), 2);
  const subject = JSON.parse(
    (await h.config.get(eventSubjectKey("rule-1", "acme:checkout"))) ?? "{}",
  ) as { episode: number; state: string };
  assert.equal(subject.episode, 2);
  assert.equal(subject.state, "open");
});

// ------------------------------------------------------------ rate limit

test("over-rate parks the event: no task, watermark kept, next hour recovers", async () => {
  const h = await harness({ ratePerHour: 1 });
  const first = await run(h, event({ occurredAt: "2026-10-17T10:00:00Z" }));
  assert.equal(created(first), 1);
  const parked = await run(h, event({ occurredAt: "2026-10-17T10:01:00Z", eventId: "ev-2", subject: "acme:cart" }));
  assert.equal(parked[0]?.outcome, "rate-limited");
  assert.equal(await tasks(h), 1, "the over-rate event proposed nothing");
  // The counter is per rule per UTC hour; an hour later the slot is free.
  const nextHour = await run(h, event({ occurredAt: "2026-10-17T11:01:00Z", subject: "acme:cart" }), "on", NOW + 3_600_000);
  assert.equal(created(nextHour), 1);
});

test("takeRateSlot counts and refuses past the ceiling", async () => {
  const config = new MemoryRuntimeConfig();
  const now = Date.parse("2026-10-17T12:00:00Z");
  assert.equal(await takeRateSlot(config, "r", 2, now), true);
  assert.equal(await takeRateSlot(config, "r", 2, now), true);
  assert.equal(await takeRateSlot(config, "r", 2, now), false);
  assert.equal(await config.get(rateKey("r", "2026-10-17T12")), "2");
  assert.equal(await takeRateSlot(config, "r", 2, now + 3_600_000), true, "a new UTC hour is a fresh budget");
});

// ------------------------------------------------------------ dry-run rule

test("a rule with policy dry-run records the would-be input and proposes nothing", async () => {
  const h = await harness({ policy: "dry-run" });
  const outcomes = await run(h, event());
  assert.equal(outcomes[0]?.outcome, "dry-run");
  assert.equal(h.proposeCalls.length, 0);
  assert.equal(await tasks(h), 0);
  assert.equal((await h.config.get(eventSubjectKey("rule-1", "acme:checkout"))), undefined, "no subject state written");
});

// ---------------------------------------------------------------- shadow

test("shadow mode evaluates without proposing or advancing subjects; the ring still records", async () => {
  const h = await harness();
  const outcomes = await run(h, event(), "shadow");
  assert.equal(outcomes[0]?.outcome, "dry-run", "shadow reports would-propose");
  assert.equal(h.proposeCalls.length, 0);
  assert.equal(await tasks(h), 0);
  assert.equal(await h.config.get(eventSubjectKey("rule-1", "acme:checkout")), undefined, "a flip to on starts from clean state");
  const seen = await listSeenEvents(h.config, "acme");
  assert.equal(seen.length, 1);
  // The same delivery again under on still proposes: shadow claimed nothing.
  const live = await run(h, event());
  assert.equal(created(live), 1);
});

// ------------------------------------------------------- dismissal cooldown

test("a dismissal cooldown suppresses the reopened task until it lapses", async () => {
  const h = await harness({ cooldownAfterDismissSeconds: 3_600, closeOn: undefined, ratePerHour: undefined });
  const first = await run(h, event({ occurredAt: "2026-10-17T10:00:00Z" }));
  const taskId = (first[0] as { taskId: string }).taskId;
  await h.intake.setState(taskId, "dismissed");
  // The clock the cooldown reads is the task's own updatedAt; pin it so the
  // test does not depend on the wall clock (12:00 + 3_600s > NOW).
  h.deps.getTask = async () =>
    ({ taskId, state: "dismissed", updatedAt: "2026-10-17T11:30:00Z" }) as unknown as IntakeTask;
  const inside = await run(h, event({ occurredAt: "2026-10-17T10:10:00Z", eventId: "ev-2" }), "on", NOW);
  assert.equal(inside[0]?.outcome, "cooldown");
  assert.equal(await tasks(h), 1, "intake holds exactly the dismissed original task");
  const after = await run(h, event({ occurredAt: "2026-10-17T12:10:00Z", eventId: "ev-3" }), "on", NOW + 3_600_000);
  assert.equal(created(after), 1, "past the cooldown the key is free again");
});

// ------------------------------------------------------------- seen ring

test("the seen ring keeps only the last SEEN_LIMIT entries per source", async () => {
  const config = new MemoryRuntimeConfig();
  for (let i = 0; i < SEEN_LIMIT + 10; i++) {
    await processEvent(
      { config, propose: async () => { throw new Error("no rules; never called"); } },
      // No rules are stored, so this only exercises the ring.
      { sourceId: "acme", event: event({ eventId: `ev-${i}` }), deliveryId: `d-${i}`, mode: "on", nowMs: NOW + i },
    );
  }
  const seen = await listSeenEvents(config, "acme");
  assert.equal(seen.length, SEEN_LIMIT);
  assert.equal(seen[0]?.eventId, "ev-10");
  assert.equal(seen[seen.length - 1]?.eventId, `ev-${SEEN_LIMIT + 9}`);
});

// ----------------------------------------------------------- attribution

test("repoFrom attribution resolves the repoHint through the injected resolver", async () => {
  const h = await harness({ task: { ...RULE.task, repoFrom: "attribution", repo: undefined } });
  h.deps.resolveRepo = async () => "https://git.example.com/acme/app.git";
  const outcomes = await run(h, { ...event(), repoHint: "acme/app" });
  const proposed = outcomes[0] as Extract<RuleOutcome, { outcome: "proposed" }>;
  assert.equal(proposed.input.repo, "https://git.example.com/acme/app.git");
});
