import assert from "node:assert/strict";
import { test } from "node:test";
import { attentionRows, ageBrief, ATTENTION_CAP } from "./attention.server.js";
import type { AttentionDeps } from "./attention.server.js";
import type { RunMeta, IntakeTask } from "teploy-ship/runtime";
import type { DeliveryRecord } from "../../../dist/delivery.js";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

const meta = (runId: string, over: Partial<RunMeta>): RunMeta => ({
  runId,
  task: `Task of ${runId}`,
  status: "queued",
  model: "test-model",
  createdAt: iso(2 * DAY),
  updatedAt: iso(1 * HOUR),
  ...over,
});

const intakeTask = (taskId: string, over: Partial<IntakeTask>): IntakeTask => ({
  taskId,
  source: "manual",
  kind: "task",
  title: `Request ${taskId}`,
  dedupeKey: `manual:${taskId}`,
  state: "proposed",
  createdAt: iso(1 * HOUR),
  updatedAt: iso(1 * HOUR),
  ...over,
});

const delivery = (id: string, over: Partial<DeliveryRecord>): DeliveryRecord =>
  ({
    id,
    runId: `run-${id}`,
    repo: "https://github.com/team/repo",
    state: "proposed",
    updatedAt: iso(30 * MIN),
    ...over,
  }) as DeliveryRecord;

function deps(over: {
  metas?: RunMeta[];
  events?: Record<string, unknown[]>;
  tasks?: IntakeTask[];
  configKeys?: Record<string, string>;
  deliveries?: DeliveryRecord[];
}): AttentionDeps {
  const values = new Map<string, string>(Object.entries(over.configKeys ?? {}));
  return {
    listMeta: async () => over.metas ?? [],
    store: { load: async (runId: string) => over.events?.[runId] ?? [] },
    intake: { list: async () => over.tasks ?? [] },
    config: {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: string) => {
        values.set(key, value);
      },
      remove: async (key: string) => {
        values.delete(key);
      },
      list: async () => [...values.keys()].map((key) => ({ key, set: true, updatedAt: "" })),
    },
    deliveryRecords: { list: async () => over.deliveries ?? [] },
  };
}

const scheduleDef = (id: string, over: Record<string, unknown>): string =>
  JSON.stringify({
    id,
    name: `Schedule ${id}`,
    repo: "team/repo",
    task: "Do the thing",
    mode: "scan",
    plan: false,
    everyMinutes: 1440,
    enabled: true,
    createdAt: iso(3 * DAY),
    by: "tester",
    ...over,
  });

const digestEntry = (scheduleId: string, runId: string, outcome: string, msAgo: number): string =>
  JSON.stringify({
    runId,
    scheduleId,
    outcome,
    summary: outcome === "failed" ? "clone refused" : "all clear",
    at: iso(msAgo),
  });

test("attention collects only what needs a human, each row linking to its page", async () => {
  const d = deps({
    metas: [
      meta("run-ask", { status: "waiting", eventName: "turn-2-ask", updatedAt: iso(2 * HOUR) }),
      meta("run-merge", { status: "waiting", eventName: "approve-merge", updatedAt: iso(4 * DAY) }),
      meta("run-upgrade", { status: "waiting", eventName: "ship-upgrade-hold", updatedAt: iso(1 * HOUR) }),
      meta("run-fail", { status: "failed", updatedAt: iso(3 * HOUR) }),
      meta("run-fail-old", { status: "failed", updatedAt: iso(3 * DAY) }),
      meta("run-done", { status: "completed", updatedAt: iso(1 * HOUR) }),
    ],
    events: { "run-fail": [{ type: "run-failed", data: { error: "model refused" } }] },
    tasks: [
      intakeTask("t-stale", { createdAt: iso(4 * DAY) }),
      intakeTask("t-fresh", { createdAt: iso(1 * HOUR) }),
    ],
    configKeys: {
      "SHIP_SCHEDULE_DEF_s-paused": scheduleDef("s-paused", { enabled: false }),
      "SHIP_SCHEDULE_DEF_s-broken": scheduleDef("s-broken", {}),
      "SHIP_SCHEDULE_DEF_s-healthy": scheduleDef("s-healthy", {}),
      "SHIP_SCHEDULE_DIGEST_run-sb": digestEntry("s-broken", "run-sb", "failed", 1 * HOUR),
      "SHIP_SCHEDULE_DIGEST_run-sh": digestEntry("s-healthy", "run-sh", "completed", 1 * HOUR),
      "SHIP_TAKEOVER_HISTORY_run-tk1": JSON.stringify([
        { holder: "tyler", acquiredAt: iso(3 * HOUR), releasedAt: iso(2 * HOUR), outcome: "released", pathsWritten: [], execsRun: [] },
        { holder: "tyler", acquiredAt: iso(3 * HOUR), releasedAt: iso(2 * HOUR), outcome: "lapsed", pathsWritten: ["src/a.ts"], execsRun: [] },
      ]),
      "SHIP_TAKEOVER_HISTORY_run-tk2": JSON.stringify([
        { holder: "tyler", acquiredAt: iso(3 * HOUR), releasedAt: iso(2 * HOUR), outcome: "released", pathsWritten: [], execsRun: [] },
      ]),
    },
    deliveries: [
      delivery("d-held", { state: "held", reason: "no trusted delivery dir" }),
      delivery("d-ok", { state: "confirmed" }),
      delivery("d-unknown", { state: "unknown", updatedAt: iso(4 * DAY) }),
    ],
  });
  const { rows, truncated } = await attentionRows(d, NOW);
  assert.equal(truncated, false);
  const byId = new Map(rows.map((r) => [r.id, r]));

  // (a) decisions — every waiting run, with its decision named and aged.
  const ask = byId.get("decision:run-ask")!;
  assert.equal(ask.href, "/runs/run-ask");
  assert.match(ask.detail, /question from the agent \(for 2h\)/);
  assert.equal(ask.aging, false);
  assert.match(byId.get("decision:run-merge")!.detail, /merge review \(for 4d\)/);
  assert.equal(byId.get("decision:run-merge")!.aging, true);
  assert.match(byId.get("decision:run-upgrade")!.nextAction, /Roll the deployment back/);

  // (b) failures — last 24h only, reason from the run's own log.
  const fail = byId.get("failure:run-fail")!;
  assert.match(fail.detail, /failed 3h ago: model refused/);
  assert.equal(byId.has("failure:run-fail-old"), false);
  assert.equal(byId.has("failure:run-done"), false);

  // (c) held/failed deliveries link to the run's verification view.
  const held = byId.get("delivery:d-held")!;
  assert.equal(held.href, "/runs/run-d-held?view=verification");
  assert.match(held.detail, /held: no trusted delivery dir/);
  assert.equal(byId.has("delivery:d-ok"), false);

  // (d) schedules — paused-while-due and last-launch-failed, nothing for healthy.
  const paused = byId.get("schedule:paused-due:s-paused")!;
  assert.equal(paused.href, "/workflows#schedules");
  assert.match(paused.detail, /paused while occurrence \d+ is due/);
  const broken = byId.get("schedule:last-failed:s-broken")!;
  assert.equal(broken.href, "/runs/run-sb");
  assert.match(broken.detail, /last occurrence failed 1h ago: clone refused/);
  assert.equal(byId.has("schedule:last-failed:s-healthy"), false);

  // (e) lapsed takeovers — last session only, within 24h.
  const lapsed = byId.get("takeover:run-tk1")!;
  assert.equal(lapsed.href, "/runs/run-tk1");
  assert.match(lapsed.detail, /lease lapsed 2h ago \(holder tyler\)/);
  assert.equal(byId.has("takeover:run-tk2"), false);

  // (f) aging — the stale proposal and the stalled unknown delivery.
  assert.match(byId.get("aging:intake:t-stale")!.detail, /proposed in the Inbox for 4d/);
  assert.equal(byId.has("aging:intake:t-fresh"), false);
  assert.equal(byId.get("aging:delivery:d-unknown")!.aging, true);

  // Waiting runs already appear as decisions; aging delivery rows are separate.
  assert.equal(rows.filter((r) => r.kind === "decision").length, 3);
});

test("a busy fleet caps the queue and says so rather than walling", async () => {
  const metas: RunMeta[] = [];
  for (let i = 0; i < ATTENTION_CAP + 10; i++) {
    metas.push(meta(`run-w${i}`, { status: "waiting", eventName: "turn-1-ask", updatedAt: iso(1 * HOUR) }));
  }
  const { rows, truncated } = await attentionRows(deps({ metas }), NOW);
  assert.equal(truncated, true);
  assert.equal(rows.length, ATTENTION_CAP);
});

test("ageBrief reads compactly across scales", () => {
  assert.equal(ageBrief(iso(5 * MIN), NOW), "5m");
  assert.equal(ageBrief(iso(3 * HOUR), NOW), "3h");
  assert.equal(ageBrief(iso(2 * DAY), NOW), "2d");
});
