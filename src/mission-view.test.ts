import assert from "node:assert/strict";
import { test } from "node:test";

import { launchNext } from "./coordination.js";
import type { CoordinationChild, CoordinationRecord } from "./coordination.js";
import { CHANGE_EVENT } from "./plan.js";
import { coordinationFacts, coordinationMissionView, missionViewEnabled, missionViewFor, NO_FACTS } from "./mission-view.js";
import type { CoordinationFacts } from "./mission-view.js";
import type { ShipRuntime } from "./runtime.js";

const A = "a".repeat(40);
const A2 = "b".repeat(40);
const C = "c".repeat(40);
const API = "https://forge.example/team/api.git";
const CLIENT = "https://forge.example/team/client.git";
const NOW = "2026-10-04T10:00:00.000Z";

function child(repo: string, patch: Partial<CoordinationChild> = {}): CoordinationChild {
  return { repo, state: "pending", attempts: 0, ...patch };
}
function record(api: Partial<CoordinationChild>, client: Partial<CoordinationChild>, extra: Partial<CoordinationRecord> = {}): CoordinationRecord {
  return {
    id: "coord-fixture",
    parentIntent: "add /v2/quotes and surface it in the app",
    model: "m",
    api: child(API, api),
    client: child(CLIENT, client),
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}
const facts = (api: CoordinationFacts["api"], client: CoordinationFacts["client"] = { acceptance: "not-recorded" }, plannedOn?: string): CoordinationFacts => ({
  api,
  client,
  ...(plannedOn !== undefined ? { plannedOn } : {}),
});
const accepted = { acceptance: "accepted" as const };

// ---- recorded fixtures (shapes a real record takes at each stage) ----

const fresh = () => record({}, {});
const apiRunning = () => record({ state: "running", attempts: 1, runId: "run-coord-api1" }, {});
const apiMergedUnaccepted = () => record({ state: "merged", attempts: 1, runId: "run-coord-api1", anchorSha: A, mergedSha: A }, {});
const apiFailedHold = () =>
  record(
    { state: "failed", attempts: 1, runId: "run-coord-api1", failReason: "the run failed" },
    { state: "held", holdReason: "The API change failed before merging (the run failed)." },
  );
const clientRunning = () =>
  record({ state: "delivered", attempts: 1, runId: "r-api", anchorSha: A, mergedSha: A }, { state: "running", attempts: 1, runId: "r-client", anchorSha: A });
const bothMerged = (clientCheck?: CoordinationChild["clientCheck"], extra: Partial<CoordinationChild> = {}) =>
  record(
    { state: "delivered", attempts: 1, runId: "r-api", anchorSha: A, mergedSha: A },
    { state: "merged", attempts: 1, runId: "r-client", anchorSha: C, mergedSha: C, ...(clientCheck !== undefined ? { clientCheck } : {}), ...extra },
  );

test("default flag: off unless exactly SHIP_MISSION_VIEW=on", () => {
  assert.equal(missionViewEnabled({}), false);
  assert.equal(missionViewEnabled({ SHIP_MISSION_VIEW: "off" }), false);
  assert.equal(missionViewEnabled({ SHIP_MISSION_VIEW: "1" }), false);
  assert.equal(missionViewEnabled({ SHIP_MISSION_VIEW: " ON " }), true);
});

test("a fresh pair: only the api node is ready; the client waits on an unaccepted api", () => {
  const v = coordinationMissionView(fresh());
  assert.deepEqual(v.ready, ["api"]);
  assert.deepEqual(v.blocked, []);
  assert.equal(v.verdict, "not-accepted");
  const client = v.nodes.find((n) => n.id === "client")!;
  assert.match(client.reasons.join(";"), /"api" is pending, not accepted/);
});

test("api running: nothing is ready", () => {
  assert.deepEqual(coordinationMissionView(apiRunning()).ready, []);
});

test("api accepted at the anchor: the client becomes ready (view only, nothing launched)", () => {
  const v = coordinationMissionView(apiMergedUnaccepted(), facts(accepted));
  assert.deepEqual(v.ready, ["client"]);
  assert.deepEqual(v.stale, []);
  assert.equal(v.nodes.find((n) => n.id === "client")!.plannedOn, A);
});

test("NEGATIVE CONTROL: a finished (merged) but UNACCEPTED api child does not make the client ready or count toward acceptance", () => {
  for (const acceptance of ["not-recorded", "pending", "superseded"] as const) {
    const v = coordinationMissionView(apiMergedUnaccepted(), facts({ acceptance }));
    assert.equal(v.nodes.find((n) => n.id === "api")!.state, "completed", acceptance);
    assert.deepEqual(v.ready, [], acceptance);
    assert.deepEqual(v.aggregate.covered, [], acceptance);
    assert.ok(v.aggregate.unmet.includes("api-change"), acceptance);
    assert.equal(v.verdict, "not-accepted", acceptance);
  }
});

test("a rejected api child blocks the client, like a failure", () => {
  const v = coordinationMissionView(apiMergedUnaccepted(), facts({ acceptance: "rejected" }));
  assert.equal(v.nodes.find((n) => n.id === "api")!.state, "rejected");
  assert.deepEqual(v.blocked, [{ id: "client", by: ["api"] }]);
});

test("failed-API hold: client is blocked by api, nothing ready", () => {
  const v = coordinationMissionView(apiFailedHold());
  assert.equal(v.nodes.find((n) => n.id === "api")!.state, "failed");
  assert.deepEqual(v.blocked, [{ id: "client", by: ["api"] }]);
  assert.deepEqual(v.ready, []);
  assert.equal(v.verdict, "not-accepted");
  assert.ok(v.notes.some((n) => /Client held: The API change failed/.test(n)));
  assert.deepEqual(v.aggregate.openNodes.map((n) => n.state).sort(), ["blocked", "failed"]);
});

test("a retry that returns the api to pending clears the block", () => {
  const retried = record({ state: "pending", attempts: 1 }, { state: "pending" });
  const v = coordinationMissionView(retried);
  assert.deepEqual(v.blocked, []);
  assert.deepEqual(v.ready, ["api"]);
});

test("full pair accepted with a compatible check: aggregate accepted", () => {
  const v = coordinationMissionView(bothMerged("compatible"), facts(accepted, accepted, A));
  assert.equal(v.aggregate.accepted, true);
  assert.equal(v.verdict, "accepted");
  assert.deepEqual(v.aggregate.unmet, []);
  assert.deepEqual(v.stale, []);
});

test("NEGATIVE CONTROL: both children merged and compatible but the client has no recorded acceptance => not accepted", () => {
  const v = coordinationMissionView(bothMerged("compatible"), facts(accepted, { acceptance: "not-recorded" }, A));
  assert.equal(v.aggregate.accepted, false);
  assert.equal(v.verdict, "not-accepted");
  assert.ok(v.aggregate.unmet.includes("client-change"));
});

test("compatibility not yet compatible (running/incompatible without accept-risk) => requirement unmet", () => {
  for (const check of ["running", "incompatible", "uncertain", "pending"] as const) {
    const v = coordinationMissionView(bothMerged(check), facts(accepted, accepted, A));
    assert.ok(v.aggregate.unmet.includes("compatibility"), check);
    assert.equal(v.verdict, "not-accepted", check);
  }
});

test("waiver: accept-risk over an incompatible check is WAIVED, never accepted", () => {
  const rec = bothMerged("incompatible", { checkAccepted: { by: "user-9", at: NOW } });
  const v = coordinationMissionView(rec, facts(accepted, accepted, A));
  assert.equal(v.verdict, "waived");
  assert.equal(v.aggregate.accepted, false);
  assert.deepEqual(v.aggregate.waived, [{ requirement: "compatibility", actor: "user-9", reason: "accepted the risk of an incompatible compatibility check" }]);
  assert.deepEqual(v.aggregate.unmet, []);
});

test("waiver without a named actor is invalid and does not waive", () => {
  const rec = bothMerged("uncertain");
  const v = coordinationMissionView(rec, facts(accepted, accepted, A), { waivers: [{ requirementId: "compatibility", actor: "  ", reason: "ship it" }] });
  assert.equal(v.verdict, "not-accepted");
  assert.deepEqual(v.aggregate.invalidWaivers, ["compatibility"]);
});

test("stale revision: the delivery record's merge sha differs from the anchor the client was built on", () => {
  // The coordination anchored the client on A; the delivery record says the api merged B.
  const v = coordinationMissionView(bothMerged("compatible"), facts({ acceptance: "accepted", deliverySha: A2 }, accepted));
  assert.deepEqual(v.stale, ["client"]);
  assert.deepEqual(v.aggregate.staleNodes, ["client"]);
  assert.equal(v.verdict, "not-accepted");
  assert.equal(v.nodes.find((n) => n.id === "api")!.revision, A2);
  // Stale accepted work covers nothing.
  assert.ok(v.aggregate.unmet.includes("client-change"));
});

test("stale revision on a pending client: not ready (stale, not satisfied, not missing)", () => {
  // launchNext would launch the client on api.anchorSha (A); the delivery record says B.
  const rec = record({ state: "delivered", attempts: 1, anchorSha: A, mergedSha: A, runId: "r-api" }, { state: "pending" });
  const v = coordinationMissionView(rec, facts({ acceptance: "accepted", deliverySha: A2 }));
  assert.deepEqual(v.ready, []);
  assert.deepEqual(v.stale, ["client"]);
  assert.match(v.nodes.find((n) => n.id === "client")!.reasons.join(";"), /stale/);
  // Control: the same record with a matching delivery sha is ready.
  assert.deepEqual(coordinationMissionView(rec, facts({ acceptance: "accepted", deliverySha: A })).ready, ["client"]);
  // A running client planned on A against a moved api is flagged stale too.
  const running = coordinationMissionView(clientRunning(), facts({ acceptance: "accepted", deliverySha: A2 }));
  assert.deepEqual(running.stale, ["client"]);
});

test("a merge recorded without a sha has no deliverable: it is not completed, accepted or ready-making", () => {
  const rec = record({ state: "merged", attempts: 1, runId: "r-api" }, { state: "held", holdReason: "no anchor" });
  const v = coordinationMissionView(rec, facts(accepted));
  assert.equal(v.nodes.find((n) => n.id === "api")!.state, "running");
  assert.deepEqual(v.ready, []);
  assert.ok(v.notes.some((n) => /without a recorded commit sha/.test(n)));
});

test("integration gate: declared+flag on => missing evidence blocks an otherwise accepted pair", () => {
  const rec = { ...bothMerged("compatible"), integrationCheck: { command: "pnpm test:pair", evidence: [] } };
  const on = coordinationMissionView(rec, facts(accepted, accepted, A), { env: { SHIP_INTEGRATION_CHECK: "on" } });
  assert.equal(on.integration?.state, "missing");
  assert.equal(on.aggregate.accepted, true); // the node aggregate alone is satisfied...
  assert.equal(on.verdict, "not-accepted"); // ...the integration gate holds the combined verdict.
  const off = coordinationMissionView(rec, facts(accepted, accepted, A), { env: {} });
  assert.equal(off.integration, null);
  assert.equal(off.verdict, "accepted");
});

test("integration gate: passing evidence at the exact pair heads satisfies it", () => {
  const rec = {
    ...bothMerged("compatible"),
    integrationCheck: {
      command: "pnpm test:pair",
      evidence: [
        {
          class: "executed-pair" as const,
          producer: { repo: API, sha: A },
          consumer: { repo: CLIENT, sha: C },
          command: "pnpm test:pair",
          result: "passed" as const,
          at: NOW,
        },
      ],
    },
  };
  const v = coordinationMissionView(rec, facts(accepted, accepted, A), { env: { SHIP_INTEGRATION_CHECK: "on" } });
  assert.equal(v.integration?.state, "satisfied");
  assert.equal(v.verdict, "accepted");
});

test("the projection does not mutate the coordination record", () => {
  const rec = bothMerged("compatible");
  const before = JSON.stringify(rec);
  coordinationMissionView(rec, facts(accepted, accepted, A));
  assert.equal(JSON.stringify(rec), before);
});

// ---- real call path: stores -> facts -> view, and launchNext unaffected ----

function ev(seq: number, type: string, name?: string, data?: unknown) {
  return { v: 1, seq, type, at: NOW, ...(name !== undefined ? { name } : {}), ...(data !== undefined ? { data } : {}) };
}
function runtimeWith(events: Record<string, unknown[]>, deliveries: Record<string, { state: string; mergedSha?: string }>): ShipRuntime {
  return {
    store: { load: async (id: string) => events[id] ?? [] },
    deliveryRecords: { get: async (id: string) => deliveries[id] ?? null },
  } as unknown as ShipRuntime;
}
const started = (extra: object = {}) => ev(1, "run-started", undefined, { input: { task: "t" }, ...extra });
const approve = (approved: boolean) => [ev(2, "event-waiting", CHANGE_EVENT), ev(3, "event-received", CHANGE_EVENT, { payload: { approved, by: "user-7" } })];

test("facts read from the stores: recorded change decision => accepted; delivery sha is carried", async () => {
  const rec = bothMerged("compatible");
  const rt = runtimeWith(
    { "r-api": [started(), ...approve(true)], "r-client": [started(), ...approve(true)] },
    { "r-api": { state: "confirmed", mergedSha: A }, "r-client": { state: "confirmed", mergedSha: C } },
  );
  const f = await coordinationFacts(rt, rec);
  assert.deepEqual(f.api, { acceptance: "accepted", deliverySha: A });
  assert.deepEqual(f.client, { acceptance: "accepted", deliverySha: C });
  const out = await missionViewFor(rt, rec, {});
  assert.ok("view" in out);
  assert.equal(out.view.verdict, "accepted");
});

test("NEGATIVE CONTROL (real path): a confirmed delivery without a recorded decision is NOT acceptance", async () => {
  const rec = bothMerged("compatible");
  const rt = runtimeWith(
    { "r-api": [started(), ev(2, "run-completed", undefined, { output: { status: "finished" } })], "r-client": [started(), ...approve(true)] },
    { "r-api": { state: "confirmed", mergedSha: A }, "r-client": { state: "confirmed", mergedSha: C } },
  );
  const out = await missionViewFor(rt, rec, {});
  assert.ok("view" in out);
  assert.equal(out.view.nodes.find((n) => n.id === "api")!.state, "completed");
  assert.equal(out.view.verdict, "not-accepted");
});

test("a denied decision is rejected and blocks the client; an unreadable store is not-recorded, never accepted", async () => {
  const rec = bothMerged("compatible");
  const rt = runtimeWith({ "r-api": [started(), ...approve(false)], "r-client": [] }, {});
  const out = await missionViewFor(rt, rec, {});
  assert.ok("view" in out);
  assert.equal(out.view.nodes.find((n) => n.id === "api")!.state, "rejected");
  const broken = { store: { load: async () => { throw new Error("boom"); } } } as unknown as ShipRuntime;
  assert.deepEqual((await coordinationFacts(broken, rec)).api, { acceptance: "not-recorded" });
});

test("launchNext on a failed-API coordination behaves as before with the view module loaded and used", async () => {
  // Minimal in-memory runtime for the real launchNext path (api failed => client held, no enqueue).
  const store = new Map<string, string>();
  const rec = record({ state: "failed", attempts: 1, runId: "r-api", failReason: "the run failed" }, { state: "pending" });
  store.set("SHIP_COORDINATION_coord-fixture", JSON.stringify(rec));
  const runtime = {
    config: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: string) => void store.set(k, v),
    },
    store: { load: async () => [] },
    loadMeta: async () => null,
    deliveryRecords: { get: async () => null },
  } as unknown as ShipRuntime;
  const first = await launchNext(runtime, "coord-fixture");
  assert.equal(first.launched, null);
  assert.equal(first.record.client.state, "held");
  const viewed = coordinationMissionView(first.record, NO_FACTS);
  assert.deepEqual(viewed.blocked, [{ id: "client", by: ["api"] }]);
  const second = await launchNext(runtime, "coord-fixture");
  assert.equal(second.launched, null);
  assert.equal(second.record.client.state, "held");
});
