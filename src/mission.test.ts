import assert from "node:assert/strict";
import test from "node:test";
import { aggregateAcceptance, applyOutcome, createMission, nodeReadiness, readyNodes, validateMission, MissionError } from "./mission.js";
import type { Mission, MissionLimits, MissionSpec, NodeSpec } from "./mission.js";

const LIMITS: MissionLimits = { maxNodes: 8, maxDepth: 3, maxFanOut: 4, maxAttempts: 2 };
const ALL = ["read:api", "write:api", "read:client", "write:client", "network"];

function node(id: string, over: Partial<NodeSpec> = {}): NodeSpec {
  return {
    id,
    goal: `do ${id}`,
    deliverableType: "patch",
    dependsOn: [],
    inputRevisions: {},
    authority: { grants: ["read:api"] },
    budget: { costCents: 10, steps: 5 },
    acceptance: { contract: `${id} passes review`, covers: [`req-${id}`] },
    ...over,
  };
}
function spec(nodes: NodeSpec[], over: Partial<MissionSpec> = {}): MissionSpec {
  return { id: "m1", goal: "ship it", authority: { grants: ALL }, budget: { costCents: 1000, steps: 500 }, nodes, ...over };
}
const codes = (s: MissionSpec) => validateMission(s, LIMITS).issues.map((i) => i.code);

/** Drive one node to accepted with a deliverable. */
function accept(m: Mission, id: string, revision: string, type = "patch"): Mission {
  let x = applyOutcome(m, id, { kind: "started" }, LIMITS);
  x = applyOutcome(x, id, { kind: "completed", deliverable: { type, revision } }, LIMITS);
  return applyOutcome(x, id, { kind: "accepted" }, LIMITS);
}
const state = (m: Mission, id: string) => m.nodes.find((n) => n.id === id)?.state;

// Serial pair: api then client, the coordination.ts shape as a graph.
const pair = () =>
  createMission(
    spec([
      node("api", { authority: { grants: ["write:api"] } }),
      node("client", { dependsOn: ["api"], inputRevisions: { api: "r1" }, authority: { grants: ["write:client"] } }),
    ]),
    LIMITS,
  );

test("a valid serial pair and a diamond validate", () => {
  assert.equal(validateMission(spec([node("a"), node("b", { dependsOn: ["a"], inputRevisions: { a: "1" } })]), LIMITS).ok, true);
  const diamond = spec([
    node("a", { authority: { grants: ["write:api"] } }),
    node("b", { dependsOn: ["a"], inputRevisions: { a: "1" }, authority: { grants: ["write:api"] } }),
    node("c", { dependsOn: ["a"], inputRevisions: { a: "1" }, authority: { grants: ["write:client"] } }),
    node("d", { dependsOn: ["b", "c"], inputRevisions: { b: "1", c: "1" }, authority: { grants: ["read:api"] } }),
  ]);
  assert.deepEqual(validateMission(diamond, LIMITS).issues, []);
});

test("diamond: the join is ready only when BOTH branches are accepted", () => {
  let m = createMission(
    spec([
      node("a"),
      node("b", { dependsOn: ["a"], inputRevisions: { a: "1" } }),
      node("c", { dependsOn: ["a"], inputRevisions: { a: "1" } }),
      node("d", { dependsOn: ["b", "c"], inputRevisions: { b: "2", c: "3" } }),
    ]),
    LIMITS,
  );
  assert.deepEqual(readyNodes(m).map((n) => n.id), ["a"]);
  m = accept(m, "a", "1");
  assert.deepEqual(readyNodes(m).map((n) => n.id), ["b", "c"]); // parallel siblings
  m = accept(m, "b", "2");
  assert.deepEqual(readyNodes(m).map((n) => n.id), ["c"]);
  m = accept(m, "c", "3");
  assert.deepEqual(readyNodes(m).map((n) => n.id), ["d"]);
});

test("cycle, self dependency, dangling dependency and duplicate id are refused", () => {
  const rev = (d: string) => ({ [d]: "1" });
  assert.ok(
    codes(
      spec([
        node("a", { dependsOn: ["c"], inputRevisions: rev("c") }),
        node("b", { dependsOn: ["a"], inputRevisions: rev("a") }),
        node("c", { dependsOn: ["b"], inputRevisions: rev("b") }),
      ]),
    ).includes("cycle"),
  );
  assert.ok(codes(spec([node("a", { dependsOn: ["a"], inputRevisions: rev("a") })])).includes("self-dependency"));
  assert.ok(codes(spec([node("a", { dependsOn: ["ghost"], inputRevisions: rev("ghost") })])).includes("dangling-dependency"));
  assert.ok(codes(spec([node("a"), node("a")])).includes("duplicate-id"));
  assert.throws(() => createMission(spec([node("a"), node("a")]), LIMITS), MissionError);
});

test("a diamond is not reported as a cycle (negative control for the cycle check)", () => {
  const s = spec([
    node("a"),
    node("b", { dependsOn: ["a"], inputRevisions: { a: "1" } }),
    node("c", { dependsOn: ["a"], inputRevisions: { a: "1" } }),
    node("d", { dependsOn: ["b", "c"], inputRevisions: { b: "1", c: "1" } }),
  ]);
  assert.ok(!codes(s).includes("cycle"));
});

test("limits: too many nodes, too wide, nested delegation beyond max depth", () => {
  const many = Array.from({ length: 9 }, (_, i) => node(`n${i}`, { parent: i === 0 ? undefined : `n${Math.floor((i - 1) / 4)}` }));
  assert.ok(codes(spec(many)).includes("too-many-nodes"));
  const wide = Array.from({ length: 5 }, (_, i) => node(`w${i}`, { budget: { costCents: 1, steps: 1 } }));
  assert.ok(codes(spec(wide)).includes("too-wide"));
  const chain = (n: number) =>
    spec(Array.from({ length: n }, (_, i) => node(`d${i}`, { parent: i === 0 ? undefined : `d${i - 1}`, budget: { costCents: 100 - i, steps: 50 - i } })));
  assert.deepEqual(validateMission(chain(3), LIMITS).issues, []); // at the limit: fine
  const deep = validateMission(chain(4), LIMITS).issues;
  assert.ok(deep.some((i) => i.code === "too-deep" && i.node === "d3"));
});

test("authority: a child cannot hold a grant its parent lacks; nested too", () => {
  const esc = spec([node("a", { authority: { grants: ["read:api", "write:api"] } })], { authority: { grants: ["read:api"] } });
  const issue = validateMission(esc, LIMITS).issues.find((i) => i.code === "authority-escalation");
  assert.equal(issue?.node, "a");
  const nested = spec([node("p", { authority: { grants: ["read:api"] } }), node("c", { parent: "p", authority: { grants: ["read:api", "network"] } })]);
  assert.equal(validateMission(nested, LIMITS).issues.find((i) => i.code === "authority-escalation")?.node, "c");
  // A wildcard is not a superset: grants are exact strings.
  const wild = spec([node("a", { authority: { grants: ["write:api"] } })], { authority: { grants: ["write:*"] } });
  assert.ok(codes(wild).includes("authority-escalation"));
  // Control: an equal or smaller grant set is fine.
  assert.deepEqual(validateMission(spec([node("a", { authority: { grants: ["read:api"] } })], { authority: { grants: ["read:api"] } }), LIMITS).issues, []);
});

test("budget: children summing past the parent is refused on either dimension", () => {
  const cost = spec([node("a", { budget: { costCents: 600, steps: 1 } }), node("b", { budget: { costCents: 401, steps: 1 } })]);
  assert.ok(codes(cost).includes("budget-oversubscribed"));
  const steps = spec([node("a", { budget: { costCents: 1, steps: 300 } }), node("b", { budget: { costCents: 1, steps: 201 } })]);
  assert.ok(codes(steps).includes("budget-oversubscribed"));
  const exact = spec([node("a", { budget: { costCents: 600, steps: 250 } }), node("b", { budget: { costCents: 400, steps: 250 } })]);
  assert.deepEqual(validateMission(exact, LIMITS).issues, []);
  const nested = spec([
    node("p", { budget: { costCents: 100, steps: 10 } }),
    node("c1", { parent: "p", budget: { costCents: 60, steps: 5 } }),
    node("c2", { parent: "p", budget: { costCents: 60, steps: 5 } }),
  ]);
  assert.equal(validateMission(nested, LIMITS).issues.find((i) => i.code === "budget-oversubscribed")?.node, "p");
  assert.ok(codes(spec([node("a", { budget: { costCents: -1, steps: 1 } })])).includes("budget-invalid"));
});

test("unreachable: a parent cycle never reaches the mission root; dangling parent is named", () => {
  assert.ok(codes(spec([node("a", { parent: "b" }), node("b", { parent: "a" })])).includes("unreachable"));
  assert.ok(codes(spec([node("a", { parent: "ghost" })])).includes("dangling-parent"));
});

test("conflict: parallel writers to one grant are refused; ordering them resolves it", () => {
  const w = { grants: ["write:api"] };
  assert.ok(codes(spec([node("a", { authority: w }), node("b", { authority: w })])).includes("write-conflict"));
  assert.ok(!codes(spec([node("a", { authority: w }), node("b", { authority: w, dependsOn: ["a"], inputRevisions: { a: "1" } })])).includes("write-conflict"));
  // Transitive ordering counts too.
  assert.ok(
    !codes(
      spec([
        node("a", { authority: w }),
        node("m", { dependsOn: ["a"], inputRevisions: { a: "1" } }),
        node("b", { authority: w, dependsOn: ["m"], inputRevisions: { m: "1" } }),
      ]),
    ).includes("write-conflict"),
  );
  // A delegator and its own child share a grant legitimately.
  assert.ok(!codes(spec([node("p", { authority: w }), node("c", { parent: "p", authority: w, budget: { costCents: 1, steps: 1 } })])).includes("write-conflict"));
});

test("a dependency on an own ancestor is refused; a missing input revision is refused", () => {
  assert.ok(codes(spec([node("p"), node("c", { parent: "p", dependsOn: ["p"], inputRevisions: { p: "1" } })])).includes("dependency-on-lineage"));
  assert.ok(codes(spec([node("a"), node("b", { dependsOn: ["a"] })])).includes("missing-input-revision"));
});

test("stale input revision: the dependency moved, so the dependant is not ready", () => {
  let m = pair();
  m = accept(m, "api", "r2"); // client was planned on r1
  assert.deepEqual(readyNodes(m), []);
  const r = nodeReadiness(m, "client");
  assert.equal(r.ready, false);
  assert.match(r.reasons[0], /stale/);
  assert.throws(() => applyOutcome(m, "client", { kind: "started" }, LIMITS), /not ready/);
  // Control: the matching revision does release it.
  assert.deepEqual(readyNodes(accept(pair(), "api", "r1")).map((n) => n.id), ["client"]);
});

test("a dependency that completed but is not yet accepted does not satisfy", () => {
  let m = applyOutcome(pair(), "api", { kind: "started" }, LIMITS);
  m = applyOutcome(m, "api", { kind: "completed", deliverable: { type: "patch", revision: "r1" } }, LIMITS);
  assert.deepEqual(readyNodes(m), []);
});

test("the deliverable type is enforced", () => {
  const m = applyOutcome(pair(), "api", { kind: "started" }, LIMITS);
  assert.throws(() => applyOutcome(m, "api", { kind: "completed", deliverable: { type: "report", revision: "r1" } }, LIMITS), /must deliver "patch"/);
});

test("failed child blocks dependants and completion; completed siblings keep their work", () => {
  const m0 = createMission(
    spec([node("a"), node("b"), node("c", { dependsOn: ["a"], inputRevisions: { a: "1" } }), node("d", { dependsOn: ["c"], inputRevisions: { c: "1" } })]),
    LIMITS,
  );
  let m = accept(m0, "b", "b1");
  m = applyOutcome(m, "a", { kind: "started" }, LIMITS);
  m = applyOutcome(m, "a", { kind: "failed", reason: "tests red" }, LIMITS);
  assert.equal(state(m, "c"), "blocked");
  assert.equal(state(m, "d"), "blocked"); // transitively
  assert.deepEqual(m.nodes.find((n) => n.id === "c")?.blockedBy, ["a"]);
  assert.deepEqual(readyNodes(m), []);
  assert.equal(state(m, "b"), "accepted");
  assert.equal(m.nodes.find((n) => n.id === "b")?.deliverable?.revision, "b1");
  const agg = aggregateAcceptance(m, [{ id: "req-b" }]);
  assert.equal(agg.accepted, false); // the one requirement is covered, but a child failed
  assert.deepEqual(agg.unmet, []);
  assert.ok(agg.openNodes.some((n) => n.id === "a" && n.state === "failed"));
  // Cancellation blocks the same way.
  const c = applyOutcome(m0, "a", { kind: "cancelled", reason: "scope change" }, LIMITS);
  assert.equal(state(c, "c"), "blocked");
});

test("retry preserves completed work, reuses the node and unblocks only its dependants", () => {
  let m = accept(createMission(spec([node("a"), node("b"), node("c", { dependsOn: ["a"], inputRevisions: { a: "1" } })]), LIMITS), "b", "b1");
  const bBefore = JSON.stringify(m.nodes.find((n) => n.id === "b"));
  m = applyOutcome(m, "a", { kind: "started" }, LIMITS);
  m = applyOutcome(m, "a", { kind: "failed", reason: "x" }, LIMITS);
  m = applyOutcome(m, "a", { kind: "retry" }, LIMITS);
  assert.equal(m.nodes.length, 3); // no duplicate node
  assert.equal(state(m, "a"), "pending");
  assert.equal(state(m, "c"), "pending"); // unblocked
  assert.equal(m.nodes.find((n) => n.id === "a")?.attempts, 1);
  assert.equal(JSON.stringify(m.nodes.find((n) => n.id === "b")), bBefore); // untouched
  assert.deepEqual(readyNodes(m).map((n) => n.id), ["a"]); // b is accepted, not re-offered
});

test("retry is refused on finished work, and bounded by maxAttempts", () => {
  const m = accept(pair(), "api", "r1");
  assert.throws(() => applyOutcome(m, "api", { kind: "retry" }, LIMITS), /cannot apply "retry"/);
  let x = createMission(spec([node("a")]), LIMITS);
  for (let i = 0; i < LIMITS.maxAttempts; i++) {
    if (i > 0) x = applyOutcome(x, "a", { kind: "retry" }, LIMITS);
    x = applyOutcome(x, "a", { kind: "started" }, LIMITS);
    x = applyOutcome(x, "a", { kind: "failed", reason: "x" }, LIMITS);
  }
  assert.throws(() => applyOutcome(x, "a", { kind: "retry" }, LIMITS), /escalate/);
});

test("a rejected deliverable blocks dependants; retry drops it so it cannot satisfy anyone", () => {
  let m = applyOutcome(pair(), "api", { kind: "started" }, LIMITS);
  m = applyOutcome(m, "api", { kind: "completed", deliverable: { type: "patch", revision: "r1" } }, LIMITS);
  m = applyOutcome(m, "api", { kind: "rejected", reason: "wrong" }, LIMITS);
  assert.equal(state(m, "client"), "blocked");
  m = applyOutcome(m, "api", { kind: "retry" }, LIMITS);
  assert.equal(m.nodes.find((n) => n.id === "api")?.deliverable, undefined);
  assert.deepEqual(readyNodes(m).map((n) => n.id), ["api"]);
});

test("applyOutcome is immutable", () => {
  const m = pair();
  const snapshot = JSON.stringify(m);
  applyOutcome(m, "api", { kind: "started" }, LIMITS);
  assert.equal(JSON.stringify(m), snapshot);
});

const reqs = [{ id: "req-a" }, { id: "req-b" }, { id: "req-docs", deliverableType: "report" }];

test("all children done but a requirement uncovered is NOT accepted", () => {
  let m = createMission(spec([node("a"), node("b")]), LIMITS);
  m = accept(accept(m, "a", "1"), "b", "2");
  assert.ok(m.nodes.every((n) => n.state === "accepted")); // every child finished
  const r = aggregateAcceptance(m, reqs);
  assert.equal(r.accepted, false);
  assert.equal(r.verdict, "not-accepted");
  assert.deepEqual(r.unmet, ["req-docs"]);
});

test("accepted only when every requirement is covered; type must match", () => {
  const nodes = [node("a"), node("b"), node("docs", { deliverableType: "report", acceptance: { contract: "c", covers: ["req-docs"] } })];
  let m = createMission(spec(nodes), LIMITS);
  m = accept(accept(accept(m, "a", "1"), "b", "2"), "docs", "3", "report");
  const r = aggregateAcceptance(m, reqs);
  assert.equal(r.accepted, true);
  assert.equal(r.verdict, "accepted");
  // Type control: a patch claiming the report requirement does not cover it.
  const wrong = [node("a"), node("b"), node("docs", { deliverableType: "patch", acceptance: { contract: "c", covers: ["req-docs"] } })];
  let w = createMission(spec(wrong), LIMITS);
  w = accept(accept(accept(w, "a", "1"), "b", "2"), "docs", "3");
  assert.deepEqual(aggregateAcceptance(w, reqs).unmet, ["req-docs"]);
});

test("a completed-but-unaccepted deliverable covers nothing", () => {
  let m = applyOutcome(createMission(spec([node("a")]), LIMITS), "a", { kind: "started" }, LIMITS);
  m = applyOutcome(m, "a", { kind: "completed", deliverable: { type: "patch", revision: "1" } }, LIMITS);
  assert.deepEqual(aggregateAcceptance(m, [{ id: "req-a" }]).unmet, ["req-a"]);
});

test("a waiver is recorded but is not a pass", () => {
  const m = accept(createMission(spec([node("a")]), LIMITS), "a", "1");
  const rq = [{ id: "req-a" }, { id: "req-x" }];
  const waived = aggregateAcceptance(m, rq, [{ requirementId: "req-x", actor: "tyler", reason: "out of scope this release" }]);
  assert.equal(waived.accepted, false);
  assert.equal(waived.verdict, "waived");
  assert.deepEqual(waived.unmet, []);
  assert.deepEqual(waived.waived, [{ requirement: "req-x", actor: "tyler", reason: "out of scope this release" }]);
  // Blank actor/reason or unknown requirement: not a waiver at all.
  for (const bad of [
    { requirementId: "req-x", actor: " ", reason: "r" },
    { requirementId: "req-x", actor: "t", reason: "" },
    { requirementId: "nope", actor: "t", reason: "r" },
  ]) {
    const r = aggregateAcceptance(m, rq, [bad]);
    assert.equal(r.verdict, "not-accepted");
    assert.deepEqual(r.unmet, ["req-x"]);
    assert.deepEqual(r.invalidWaivers, [bad.requirementId]);
  }
  // A waiver cannot cover a failed child.
  let f = createMission(spec([node("a"), node("b")]), LIMITS);
  f = applyOutcome(accept(f, "a", "1"), "b", { kind: "failed", reason: "x" }, LIMITS);
  assert.equal(aggregateAcceptance(f, [{ id: "req-a" }, { id: "req-b" }], [{ requirementId: "req-b", actor: "t", reason: "r" }]).verdict, "not-accepted");
});

test("a node accepted on a revision that later moved no longer covers its requirement", () => {
  let m = accept(pair(), "api", "r1");
  m = accept(m, "client", "c1");
  const rq = [{ id: "req-client" }];
  assert.equal(aggregateAcceptance(m, rq).accepted, true);
  // The API is re-delivered at r2 (e.g. replan): swap its deliverable.
  const moved: Mission = { ...m, nodes: m.nodes.map((n) => (n.id === "api" ? { ...n, deliverable: { type: "patch", revision: "r2" } } : n)) };
  const r = aggregateAcceptance(moved, rq);
  assert.equal(r.accepted, false);
  assert.deepEqual(r.staleNodes, ["client"]);
  assert.deepEqual(r.unmet, ["req-client"]);
});

test("nested delegation validates and runs: children under a delegating parent", () => {
  const s = spec([
    node("p", { authority: { grants: ["read:api", "write:api"] }, budget: { costCents: 100, steps: 50 } }),
    node("c", { parent: "p", authority: { grants: ["read:api"] }, budget: { costCents: 40, steps: 20 } }),
    node("e", { parent: "p", authority: { grants: ["write:api"] }, budget: { costCents: 40, steps: 20 }, dependsOn: ["c"], inputRevisions: { c: "1" } }),
  ]);
  assert.deepEqual(validateMission(s, LIMITS).issues, []);
  const m = accept(createMission(s, LIMITS), "c", "1");
  assert.deepEqual(readyNodes(m).map((n) => n.id).sort(), ["e", "p"]);
});
