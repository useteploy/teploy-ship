import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ADAPTER_OPERATIONS,
  CONFORMANCE_CHECK_NAMES,
  DestinationLocks,
  TEPLOY_ADAPTER_MAPPING,
  assertConformant,
  authorisationCovers,
  compareToIdentity,
  conformanceSuite,
  makeRecoveryPlan,
  ok,
  refused,
  runDeliveryJourney,
  runProvisioning,
  runRecovery,
  unknown,
  type AdapterCapabilities,
  type AdapterHarness,
  type AdapterResult,
  type Authorisation,
  type DeliveryIdentity,
  type DeliveryPlan,
  type DeployInput,
  type DeployReceipt,
  type DeploymentAdapter,
  type Lease,
  type ProvisioningAdapter,
  type ProvisioningIdentity,
  type ProvisioningPlan,
  type Ok,
  type RecoverInput,
  type RecoveryPlan,
  type TargetChange,
  type TargetRef,
  type TargetState,
} from "./deployment-adapter.js";

// ------------------------------------------------------------------ fakes

type Fault =
  | "lies-about-readback"
  | "wrong-service"
  | "partial-reported-as-rejected"
  | "partial-reported-as-applied"
  | "blind-overwrite"
  | "static-generation"
  | "unreadable-as-absent"
  | "approximates-recovery"
  | "shared-lease";

interface FakeOptions {
  /** teploy-like: CAS + lease, rollback-to-version, observe, logs. external-ci: CAS only, no logs/observe/recovery. */
  profile?: "teploy-like" | "external-ci";
  fault?: Fault;
  /** Declares readback false and answers unknown to every readback. */
  noReadback?: boolean;
}

interface World { revision?: string; artifact?: string; generation: number; readable: boolean }
const key = (t: TargetRef): string => `${t.service}@${t.destination}`;

/**
 * An in-memory deployment system plus the harness hooks a conformance run
 * needs. The faithful behaviour is the default; each Fault is one deliberate
 * defect, named for the contract rule it breaks.
 */
function makeFake(options: FakeOptions = {}): AdapterHarness & { world: Map<string, World> } {
  const profile = options.profile ?? "teploy-like";
  const fault = options.fault;
  const world = new Map<string, World>();
  const leases = new Map<string, string>();
  const claimed = new Map<string, { revision: string; artifact: string }>();
  const pending: { when: "before-deploy" | "after-deploy"; change: TargetChange }[] = [];
  let deployCalls = 0;
  let inFlight = 0;
  let maxInFlight = 0;

  const w = (t: TargetRef): World => {
    let s = world.get(key(t));
    if (s === undefined) { s = { generation: 0, readable: true }; world.set(key(t), s); }
    return s;
  };
  const bump = (s: World): void => { s.generation += 1; };
  const applyChange = (t: TargetRef, change: TargetChange): void => {
    const s = w(t);
    if ("unreadable" in change) { s.readable = false; bump(s); return; }
    s.revision = change.revision; s.artifact = change.artifact; bump(s);
  };
  const gen = (s: World): string => (fault === "static-generation" ? "g0" : `g${s.generation}`);
  const label = (t: TargetRef): string => (fault === "wrong-service" ? `${t.service}-canary` : t.service);
  const state = (t: TargetRef, s: World): TargetState => ({
    service: label(t), destination: t.destination, serving: s.revision !== undefined,
    ...(s.revision !== undefined ? { revision: s.revision, artifact: s.artifact! } : {}),
    generation: gen(s),
  });
  const takeInterference = (when: "before-deploy" | "after-deploy"): TargetChange | undefined => {
    const i = pending.findIndex((p) => p.when === when);
    return i === -1 ? undefined : pending.splice(i, 1)[0]!.change;
  };
  const yieldTurn = (): Promise<void> => new Promise((r) => setImmediate(r));

  const caps: AdapterCapabilities = {
    adapter: `fake-${profile}${fault !== undefined ? `-${fault}` : ""}${options.noReadback === true ? "-no-readback" : ""}`,
    readback: options.noReadback !== true,
    logs: profile === "teploy-like",
    observe: profile === "teploy-like",
    dryRun: false,
    provisioning: false,
    fencing: profile === "teploy-like" ? ["compare-and-set", "lease"] : ["compare-and-set"],
    recovery: profile === "teploy-like" && fault !== "approximates-recovery" ? ["rollback-to-version"] : [],
  };

  const authorised = (a: Authorisation, t: TargetRef): boolean => a.service === t.service && a.destination === t.destination;

  const adapter: DeploymentAdapter = {
    capabilities: () => caps,
    async inspect(t) { return ok(state(t, w(t))); },
    async plan(identity, baseline): Promise<AdapterResult<DeliveryPlan>> {
      return ok({
        planId: `plan-${identity.revision}`, identity, steps: [`deploy ${identity.artifact}`], validatedByProvider: false,
        baseline: { generation: baseline.generation, ...(baseline.revision !== undefined ? { revision: baseline.revision } : {}) },
      });
    },
    async deploy(input: DeployInput): Promise<DeployReceipt> {
      deployCalls += 1; inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const t = input.plan.identity;
        claimed.set(key(t), { revision: t.revision, artifact: t.artifact });
        await yieldTurn();
        const before = takeInterference("before-deploy");
        if (before !== undefined) applyChange(t, before);
        if (fault === "partial-reported-as-rejected") {
          const s = w(t); s.artifact = t.artifact; s.revision = t.revision; bump(s);
          return { outcome: "rejected", rejection: "other", detail: "provider error after the artifact was switched" };
        }
        if (!authorised(input.authorisation, t)) return { outcome: "rejected", rejection: "unauthorised", detail: "authorisation does not cover this destination" };
        const s = w(t);
        if (fault !== "blind-overwrite" && input.expectGeneration !== gen(s)) {
          return { outcome: "rejected", rejection: "stale-generation", detail: `target is at ${gen(s)}, plan expected ${input.expectGeneration}` };
        }
        if (fault === "partial-reported-as-applied") {
          s.artifact = t.artifact; bump(s);
          return { outcome: "applied", detail: "all steps applied" };
        }
        s.revision = t.revision; s.artifact = t.artifact; bump(s);
        const after = takeInterference("after-deploy");
        if (after !== undefined) applyChange(t, after);
        return { outcome: "applied", detail: "applied" };
      } finally {
        inFlight -= 1;
      }
    },
    async readback(t): Promise<AdapterResult<TargetState>> {
      if (options.noReadback === true) return unknown("this adapter has no readback");
      const s = w(t);
      if (!s.readable) {
        return fault === "unreadable-as-absent" ? ok({ service: label(t), destination: t.destination, serving: false, generation: gen(s) }) : unknown("target unreachable");
      }
      if (fault === "lies-about-readback") {
        const c = claimed.get(key(t));
        if (c !== undefined) return ok({ service: t.service, destination: t.destination, serving: true, revision: c.revision, artifact: c.artifact, generation: gen(s) });
      }
      return ok(state(t, s));
    },
    async recover(input: RecoverInput): Promise<DeployReceipt> {
      const t = input.plan.target;
      if (!caps.recovery.includes(input.plan.mode) && fault !== "approximates-recovery") {
        return { outcome: "rejected", rejection: "other", detail: `mode ${input.plan.mode} unsupported` };
      }
      const s = w(t);
      if (input.expectGeneration !== gen(s)) return { outcome: "rejected", rejection: "stale-generation", detail: "stale" };
      s.revision = input.plan.to.revision; s.artifact = input.plan.to.artifact ?? s.artifact; bump(s);
      return { outcome: "applied", detail: "restored" };
    },
  };
  if (profile === "teploy-like") {
    adapter.observe = async (t) => ok({ service: label(t), health: "healthy", reason: "RED within thresholds" });
    adapter.logs = async (t, limit) => ok({ service: label(t), lines: ["boot", "listening"].slice(0, limit) });
    adapter.acquireLease = async (t, holder): Promise<AdapterResult<Lease>> => {
      if (fault !== "shared-lease" && leases.has(key(t))) return refused(`held by ${leases.get(key(t))}`);
      leases.set(key(t), holder);
      return ok({ target: t, token: `${holder}-${leases.size}`, holder });
    };
    adapter.releaseLease = async (l) => { leases.delete(key(l.target)); };
  }

  return {
    adapter,
    world,
    seed(t, st) { const s = w(t); s.revision = st.revision; s.artifact = st.artifact; s.readable = true; bump(s); },
    truth(t) {
      const s = w(t);
      return { serving: s.revision !== undefined, ...(s.revision !== undefined ? { revision: s.revision, artifact: s.artifact! } : {}) };
    },
    outOfBand(t, change) { applyChange(t, change); },
    interfere(when, change) { pending.push({ when, change }); },
    restoreReads(t) { w(t).readable = true; },
    stats: () => ({ deployCalls, maxInFlightDeploys: maxInFlight }),
  };
}

const T: TargetRef = { service: "svc-a", destination: "prod" };
const ID1: DeliveryIdentity = { ...T, revision: "rev-1", artifact: "img:1" };
const AUTH: Authorisation = { kind: "deploy", actor: "tyler", ...T };
const RAUTH: Authorisation = { ...AUTH, kind: "recover" };
const NOW = new Date("2026-10-03T12:00:00Z");

function seeded(options: FakeOptions = {}): ReturnType<typeof makeFake> {
  const h = makeFake(options);
  h.seed(T, { revision: "rev-0", artifact: "img:0" });
  return h;
}
const run = (h: AdapterHarness, extra: Parameters<typeof runDeliveryJourney>[1] extends infer R ? Partial<R> : never = {}) =>
  runDeliveryJourney(h.adapter, { identity: ID1, authorisation: AUTH, locks: new DestinationLocks(), now: () => NOW, ...extra });
const wrap = (h: AdapterHarness, over: Partial<DeploymentAdapter>): DeploymentAdapter => ({ ...h.adapter, ...over });

// ------------------------------------------------------------------ conformance: faithful

for (const profile of ["teploy-like", "external-ci"] as const) {
  test(`conformance: faithful ${profile} fake passes every applicable check`, async () => {
    const report = await conformanceSuite(() => makeFake({ profile }));
    assertConformant(report);
    assert.deepEqual(report.failed, []);
    // Every named check is accounted for, as pass or explicit skip.
    assert.deepEqual(report.checks.map((c) => c.name).sort(), [...CONFORMANCE_CHECK_NAMES].sort());
    if (profile === "teploy-like") {
      // Applicable checks actually ran: the strongest ones are passes, not skips.
      for (const n of ["readback-truthful", "deploy-fenced-on-generation", "lease-is-exclusive", "recovery-succeeds-when-supported", "journey-serialises-competing-releases"]) {
        assert.equal(report.checks.find((c) => c.name === n)!.status, "pass", n);
      }
    } else {
      // Capabilities it does not declare are SKIPPED with a reason, not passed.
      for (const n of ["lease-is-exclusive", "observe-attributes-service", "logs-attribute-service", "recovery-succeeds-when-supported", "recovery-refused-when-changed-out-of-band"]) {
        const c = report.checks.find((c) => c.name === n)!;
        assert.equal(c.status, "skipped", n);
        assert.match(c.detail, /not declared/);
      }
      assert.equal(report.checks.find((c) => c.name === "recovery-refuses-unsupported-mode")!.status, "pass");
    }
  });
}

test("conformance: an adapter without readback conforms only by never confirming", async () => {
  const report = await conformanceSuite(() => makeFake({ noReadback: true }));
  assert.deepEqual(report.failed, []);
  assert.equal(report.checks.find((c) => c.name === "no-readback-never-confirms")!.status, "pass");
  assert.equal(report.checks.find((c) => c.name === "journey-confirms-faithful-deploy")!.status, "skipped");
});

// ------------------------------------------------------------------ conformance: negative controls

const FAULTS: { fault: Fault; mustFail: string }[] = [
  { fault: "lies-about-readback", mustFail: "readback-truthful" },
  { fault: "wrong-service", mustFail: "readback-attributes-service" },
  { fault: "partial-reported-as-rejected", mustFail: "rejected-means-unchanged" },
  { fault: "partial-reported-as-applied", mustFail: "applied-means-converged" },
  { fault: "blind-overwrite", mustFail: "deploy-fenced-on-generation" },
  { fault: "static-generation", mustFail: "generation-advances-on-change" },
  { fault: "unreadable-as-absent", mustFail: "unreadable-is-unknown" },
  { fault: "approximates-recovery", mustFail: "undeclared-recovery-refused" },
  { fault: "shared-lease", mustFail: "lease-is-exclusive" },
];

for (const { fault, mustFail } of FAULTS) {
  test(`conformance negative control: ${fault} fails ${mustFail}`, async () => {
    const report = await conformanceSuite(() => makeFake({ fault }));
    assert.equal(report.conformant, false);
    assert.ok(report.failed.includes(mustFail), `expected ${mustFail} in [${report.failed.join(", ")}]`);
    assert.throws(() => assertConformant(report), new RegExp(mustFail));
    // The same check passes against the faithful adapter, so the failure is the fault's.
    const good = await conformanceSuite(() => makeFake());
    assert.equal(good.checks.find((c) => c.name === mustFail)!.status, "pass");
  });
}

test("conformance negative control: blind overwrite is also caught at journey level", async () => {
  const report = await conformanceSuite(() => makeFake({ fault: "blind-overwrite" }));
  assert.ok(report.failed.includes("journey-refuses-stale-plan"));
});

test("conformance negative control: a lying readback is caught as a false confirm", async () => {
  const report = await conformanceSuite(() => makeFake({ fault: "lies-about-readback" }));
  assert.ok(report.failed.includes("journey-no-false-confirm"));
});

test("conformance: a throwing adapter fails with the throw recorded, not a crash", async () => {
  const report = await conformanceSuite(() => {
    const h = makeFake();
    h.adapter.readback = async () => { throw new Error("boom"); };
    return h;
  });
  assert.ok(report.failed.includes("readback-truthful"));
  assert.match(report.checks.find((c) => c.name === "unreadable-is-unknown")!.detail, /boom/);
});

// ------------------------------------------------------------------ journey invariants

test("journey: uncontested release confirms only after a matching readback", async () => {
  const h = seeded();
  const r = await run(h);
  assert.equal(r.outcome, "confirmed");
  assert.deepEqual(r.steps, ["lease", "inspect", "plan", "re-inspect", "deploy", "readback"]);
  assert.equal(r.health?.health, "healthy");
  assert.equal(r.observed?.revision, "rev-1");
});

test("journey: authority is per kind, service and destination, and expires", async () => {
  const h = seeded();
  assert.equal((await run(h, { authorisation: undefined })).outcome, "held");
  assert.match((await run(h, { authorisation: { ...AUTH, kind: "provision" } })).reason, /provision, not deploy/);
  assert.match((await run(h, { authorisation: { ...AUTH, destination: "staging" } })).reason, /covers svc-a@staging/);
  assert.match((await run(h, { authorisation: { ...AUTH, expiresAt: "2026-10-03T11:00:00Z" } })).reason, /expired/);
  assert.match((await run(h, { authorisation: { ...AUTH, actor: " " } })).reason, /no actor/);
  assert.equal(h.stats().deployCalls, 0);
  assert.equal(authorisationCovers({ ...AUTH, expiresAt: "nonsense" }, "deploy", T, NOW).ok, false);
});

test("journey: an unfenced adapter is refused before acting", async () => {
  const h = seeded();
  const unfenced = wrap(h, { capabilities: () => ({ ...h.adapter.capabilities(), fencing: [] }) });
  const r = await runDeliveryJourney(unfenced, { identity: ID1, authorisation: AUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.equal(r.outcome, "held");
  assert.equal(r.acted, false);
  assert.match(r.reason, /no fencing/);
});

test("journey: no readback means unknown at best, and only when unverifiable is explicitly allowed", async () => {
  const h = seeded({ noReadback: true });
  const refusedFirst = await run(h);
  assert.equal(refusedFirst.outcome, "held");
  assert.equal(refusedFirst.acted, false);
  const allowed = await run(h, { allowUnverifiable: true });
  assert.equal(allowed.outcome, "unknown");
  assert.equal(allowed.acted, true);
});

test("journey: inspect that cannot read refuses to act (unknown is not zero)", async () => {
  const h = seeded();
  const r = await run(h, { holder: "x" });
  assert.equal(r.outcome, "confirmed");
  const broken = wrap(h, { inspect: async () => unknown("api down") });
  const r2 = await runDeliveryJourney(broken, { identity: { ...ID1, revision: "rev-2", artifact: "img:2" }, authorisation: AUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.equal(r2.outcome, "held");
  assert.equal(r2.acted, false);
  assert.match(r2.reason, /never act on an unread target/);
});

test("journey: wrong-service inspection is refused before acting", async () => {
  const h = seeded({ fault: "wrong-service" });
  const r = await run(h);
  assert.equal(r.outcome, "held");
  assert.equal(r.acted, false);
  assert.match(r.reason, /wrong-service attribution/);
  assert.equal(h.stats().deployCalls, 0);
});

test("journey: a plan for another identity, or another generation, is refused", async () => {
  const h = seeded();
  const otherIdentity = wrap(h, { plan: async (id, base) => {
    const p = await h.adapter.plan({ ...id, artifact: "img:evil" }, base);
    return p;
  } });
  const a = await runDeliveryJourney(otherIdentity, { identity: ID1, authorisation: AUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.equal(a.outcome, "held");
  assert.match(a.reason, /different identity/);
  const otherGen = wrap(h, { plan: async (id, base) => h.adapter.plan(id, { ...base, generation: "g999" }) });
  const b = await runDeliveryJourney(otherGen, { identity: ID1, authorisation: AUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.match(b.reason, /different target generation/);
  assert.equal(h.stats().deployCalls, 0);
});

test("journey: dry run plans and never acts", async () => {
  const h = seeded();
  const r = await run(h, { dryRun: true });
  assert.equal(r.outcome, "planned");
  assert.equal(r.acted, false);
  assert.match(r.reason, /without provider validation/);
  assert.equal(h.stats().deployCalls, 0);
});

test("journey: a racing release between plan and deploy is fenced and the rival survives", async () => {
  const h = seeded();
  h.interfere("before-deploy", { revision: "rev-9", artifact: "img:9" });
  const r = await run(h);
  assert.equal(r.outcome, "held");
  assert.match(r.reason, /stale-generation/);
  assert.deepEqual(await h.truth(T), { serving: true, revision: "rev-9", artifact: "img:9" });
});

test("journey: a change between inspect and re-inspect is caught by the orchestrator pre-check", async () => {
  const h = seeded();
  let calls = 0;
  const racing = wrap(h, { inspect: async (t) => {
    calls += 1;
    if (calls === 2) h.outOfBand(T, { revision: "rev-9", artifact: "img:9" }); // after the first inspect, before the re-inspect
    return h.adapter.inspect(t);
  } });
  const r = await runDeliveryJourney(racing, { identity: ID1, authorisation: AUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.equal(r.outcome, "held");
  assert.equal(r.acted, false);
  assert.match(r.reason, /changed after the plan/);
});

test("journey: readable mismatch holds, with logs attached and attributed", async () => {
  const h = seeded();
  h.interfere("after-deploy", { revision: "rev-9", artifact: "img:9" });
  const r = await run(h);
  assert.equal(r.outcome, "held");
  assert.match(r.reason, /serves revision rev-9/);
  assert.deepEqual(r.logs?.lines, ["boot", "listening"]);
});

test("journey: unreadable after deploy is unknown, never failed or confirmed", async () => {
  const h = seeded();
  h.interfere("after-deploy", { unreadable: true });
  const r = await run(h);
  assert.equal(r.outcome, "unknown");
  assert.equal(r.acted, true);
});

test("journey: a deploy that throws is indeterminate and reconciled by readback", async () => {
  const h = seeded();
  const throwing = wrap(h, { deploy: async (i) => { await h.adapter.deploy(i); throw new Error("connection reset"); } });
  const landed = await runDeliveryJourney(throwing, { identity: ID1, authorisation: AUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.equal(landed.outcome, "confirmed"); // the deploy had landed; only the receipt was lost
  const h2 = seeded();
  const throwsFirst = wrap(h2, { deploy: async () => { throw new Error("refused to connect"); } });
  const notLanded = await runDeliveryJourney(throwsFirst, { identity: ID1, authorisation: AUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.equal(notLanded.outcome, "held"); // indeterminate + target still on rev-0: not confirmed, not silently failed
});

test("journey: rejected on a readable, unchanged target is failed", async () => {
  const h = seeded();
  const rejecting = wrap(h, { deploy: async () => ({ outcome: "rejected", rejection: "other", detail: "build failed" }) });
  const r = await runDeliveryJourney(rejecting, { identity: ID1, authorisation: AUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.equal(r.outcome, "failed");
});

test("journey: partial provider failure is reconciled by readback, not by the receipt", async () => {
  const h = seeded({ fault: "partial-reported-as-applied" });
  const r = await run(h);
  assert.equal(r.outcome, "held");
  assert.match(r.reason, /serves revision rev-0 \/ artifact img:1/);
  const h2 = seeded({ fault: "partial-reported-as-rejected" });
  const r2 = await run(h2);
  assert.equal(r2.outcome, "confirmed"); // truthful readback outranks the lying receipt...
  assert.ok(r2.reason.includes("rejected")); // ...and the receipt is preserved in the reason
});

test("journey: a readback without artifact identity is unknown, not confirmed", async () => {
  const h = seeded();
  const opaque = wrap(h, { readback: async (t) => {
    const r = await h.adapter.readback(t);
    if (r.kind !== "ok") return r;
    const { artifact: _drop, ...rest } = r.value;
    return ok(rest as TargetState);
  } });
  const r = await runDeliveryJourney(opaque, { identity: ID1, authorisation: AUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.equal(r.outcome, "unknown");
});

test("journey: telemetry for another service is discarded to unknown health", async () => {
  const h = seeded();
  const misattributed = wrap(h, { observe: async () => ok({ service: "svc-b", health: "degraded", reason: "5xx spike" }) });
  const r = await runDeliveryJourney(misattributed, { identity: ID1, authorisation: AUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.equal(r.outcome, "confirmed");
  assert.equal(r.health?.health, "unknown");
  assert.match(r.health!.reason, /svc-b/);
});

test("journey: a held lease refuses without touching the target", async () => {
  const h = seeded();
  await h.adapter.acquireLease!(T, "other-operator");
  const r = await run(h);
  assert.equal(r.outcome, "held");
  assert.equal(r.acted, false);
  assert.equal(h.stats().deployCalls, 0);
});

test("journey: the lease is released afterwards, even after a hold", async () => {
  const h = seeded();
  h.interfere("before-deploy", { revision: "rev-9", artifact: "img:9" });
  await run(h);
  const again = await h.adapter.acquireLease!(T, "next");
  assert.equal(again.kind, "ok");
});

test("journey: competing releases to one destination never overlap in the adapter", async () => {
  const h = seeded();
  const locks = new DestinationLocks();
  const [a, b] = await Promise.all([
    run(h, { locks }),
    run(h, { locks, identity: { ...ID1, revision: "rev-2", artifact: "img:2" } }),
  ]);
  assert.equal(h.stats().maxInFlightDeploys, 1);
  assert.equal(a.outcome, "confirmed");
  assert.equal(b.outcome, "confirmed");
  assert.equal((await h.truth(T)).revision, "rev-2");
});

test("negative control: without the destination lock the same releases do overlap", async () => {
  const h = seeded({ profile: "external-ci" }); // no lease, so only the in-process lock serialises
  const [a, b] = await Promise.all([
    run(h, { locks: new DestinationLocks() }),
    run(h, { locks: new DestinationLocks(), identity: { ...ID1, revision: "rev-2", artifact: "img:2" } }),
  ]);
  assert.equal(h.stats().maxInFlightDeploys, 2, "separate lock instances must not serialise; the lock is what prevents overlap");
  // The adapter's compare-and-set is the second line: exactly one of the racers wins, the other is held.
  assert.equal([a, b].filter((r) => r.outcome === "confirmed").length, 1);
  assert.equal([a, b].filter((r) => r.outcome === "held").length, 1);
});

test("locks: keys are independent and a failure releases the lock", async () => {
  const locks = new DestinationLocks();
  const order: string[] = [];
  await assert.rejects(locks.run("a", async () => { order.push("a1"); throw new Error("x"); }));
  await Promise.all([
    locks.run("a", async () => { order.push("a2"); }),
    locks.run("b", async () => { order.push("b"); }),
  ]);
  assert.deepEqual(order.sort(), ["a1", "a2", "b"]);
});

// ------------------------------------------------------------------ compareToIdentity

test("compareToIdentity: needs service, destination, serving, and both identity halves", () => {
  const good: TargetState = { ...T, serving: true, revision: "rev-1", artifact: "img:1", generation: "g1" };
  assert.equal(compareToIdentity(good, ID1).kind, "match");
  assert.equal(compareToIdentity({ ...good, service: "svc-b" }, ID1).kind, "wrong-target");
  assert.equal(compareToIdentity({ ...good, destination: "staging" }, ID1).kind, "wrong-target");
  assert.equal(compareToIdentity({ ...good, serving: false }, ID1).kind, "mismatch");
  assert.equal(compareToIdentity({ ...good, revision: "rev-0" }, ID1).kind, "mismatch");
  assert.equal(compareToIdentity({ ...good, artifact: "img:0" }, ID1).kind, "mismatch");
  const { artifact: _a, ...noArtifact } = good;
  assert.equal(compareToIdentity(noArtifact, ID1).kind, "opaque");
});

// ------------------------------------------------------------------ recovery

const planValue = (r: AdapterResult<RecoveryPlan>): RecoveryPlan => {
  assert.equal(r.kind, "ok");
  return (r as Ok<RecoveryPlan>).value;
};

async function deliveredThenPlan(h: ReturnType<typeof makeFake>) {
  const j = await run(h);
  assert.equal(j.outcome, "confirmed");
  const plan = await makeRecoveryPlan(h.adapter, ID1, "rollback-to-version", { revision: "rev-0", artifact: "img:0" }, () => NOW);
  assert.equal(plan.kind, "ok");
  return plan.kind === "ok" ? plan.value : (undefined as never);
}

test("recovery: supported rollback restores the retained release and reads it back", async () => {
  const h = seeded();
  const plan = await deliveredThenPlan(h);
  const r = await runRecovery(h.adapter, { plan, authorisation: RAUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.equal(r.outcome, "recovered");
  assert.deepEqual(r.verifiedAgainst, ["revision", "artifact"]);
  assert.equal((await h.truth(T)).revision, "rev-0");
});

test("recovery: a retained version without an artifact is verified on revision only, and says so", async () => {
  const h = seeded();
  await run(h);
  const plan = await makeRecoveryPlan(h.adapter, ID1, "rollback-to-version", { revision: "rev-0" }, () => NOW);
  assert.equal(plan.kind, "ok");
  const r = await runRecovery(h.adapter, { plan: planValue(plan), authorisation: RAUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.deepEqual(r.verifiedAgainst, ["revision"]);
});

test("recovery: refused when the target changed out of band since the plan", async () => {
  const h = seeded();
  const plan = await deliveredThenPlan(h);
  h.outOfBand(T, { revision: "rev-9", artifact: "img:9" });
  const r = await runRecovery(h.adapter, { plan, authorisation: RAUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.equal(r.outcome, "held");
  assert.equal(r.acted, false);
  assert.match(r.reason, /changed since the recovery plan/);
  assert.equal((await h.truth(T)).revision, "rev-9");
});

test("recovery: unsupported mode is held, never approximated by another mode", async () => {
  const h = seeded();
  const plan = await deliveredThenPlan(h);
  const r = await runRecovery(h.adapter, { plan: { ...plan, mode: "redeploy-previous-artifact" }, authorisation: RAUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.equal(r.outcome, "held");
  assert.equal(r.acted, false);
  assert.match(r.reason, /does not support recovery mode redeploy-previous-artifact/);
  assert.equal((await h.truth(T)).revision, "rev-1");
  // An adapter that declares no recovery at all refuses even the usual mode.
  const none = seeded({ profile: "external-ci" });
  await run(none);
  const p2 = await makeRecoveryPlan(none.adapter, ID1, "rollback-to-version", { revision: "rev-0", artifact: "img:0" }, () => NOW);
  const r2 = await runRecovery(none.adapter, { plan: planValue(p2), authorisation: RAUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.equal(r2.outcome, "held");
});

test("recovery: needs recover authority, an explicit version, and a target that serves the delivery", async () => {
  const h = seeded();
  const plan = await deliveredThenPlan(h);
  const noAuth = await runRecovery(h.adapter, { plan, authorisation: AUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.match(noAuth.reason, /deploy, not recover/);
  const previous = await makeRecoveryPlan(h.adapter, ID1, "rollback-to-version", { revision: " " }, () => NOW);
  assert.equal(previous.kind, "refused");
  const notServing = await makeRecoveryPlan(h.adapter, { ...ID1, revision: "rev-5", artifact: "img:5" }, "rollback-to-version", { revision: "rev-0" }, () => NOW);
  assert.equal(notServing.kind, "refused");
});

test("recovery: an unreadable target refuses to act; already-recovered is idempotent", async () => {
  const h = seeded();
  const plan = await deliveredThenPlan(h);
  h.outOfBand(T, { unreadable: true });
  const r = await runRecovery(h.adapter, { plan, authorisation: RAUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.equal(r.outcome, "held");
  assert.match(r.reason, /unread target/);
  h.restoreReads(T);
  h.outOfBand(T, { revision: "rev-0", artifact: "img:0" });
  const done = await runRecovery(h.adapter, { plan, authorisation: RAUTH, locks: new DestinationLocks(), now: () => NOW });
  assert.equal(done.outcome, "recovered");
  assert.equal(done.acted, false);
});

// ------------------------------------------------------------------ provisioning

const PID: ProvisioningIdentity = { account: "acct-1", region: "eu-west-1", resource: "db-main", estimatedMonthlyUsd: 40 };
const PAUTH: Authorisation = { kind: "provision", actor: "tyler", service: "db-main", destination: "acct-1/eu-west-1" };

function fakeProvisioner(over: { plan?: Partial<ProvisioningPlan>; outcome?: DeployReceipt["outcome"]; exists?: boolean; readable?: boolean } = {}) {
  let applied = 0;
  const adapter: ProvisioningAdapter = {
    async dryRun(identity) {
      return ok({ planId: "p1", identity, changes: ["1 to add"], destructive: false, migrationRisk: "none", ...over.plan });
    },
    async apply() { applied += 1; return { outcome: over.outcome ?? "applied", detail: "provider said so" }; },
    async readback(identity) {
      return over.readable === false ? unknown("provider API down") : ok({ identity, exists: over.exists ?? true });
    },
  };
  return { adapter, applied: () => applied };
}

test("provisioning: dry-run first; apply needs provision authority, a known cost under the ceiling", async () => {
  const p = fakeProvisioner();
  const dry = await runProvisioning(p.adapter, { identity: PID, authorisation: undefined, dryRunOnly: true });
  assert.equal(dry.outcome, "planned");
  assert.equal(p.applied(), 0);
  const base = { identity: PID, authorisation: PAUTH, costCeilingUsd: 50, now: () => NOW };
  assert.match((await runProvisioning(p.adapter, { ...base, authorisation: { ...PAUTH, kind: "deploy" } })).reason, /deploy, not provision/);
  assert.match((await runProvisioning(p.adapter, { ...base, authorisation: { ...PAUTH, destination: "acct-2/eu-west-1" } })).reason, /covers/);
  assert.match((await runProvisioning(p.adapter, { ...base, costCeilingUsd: undefined })).reason, /no cost ceiling/);
  assert.match((await runProvisioning(p.adapter, { ...base, costCeilingUsd: 10 })).reason, /exceeds/);
  assert.equal(p.applied(), 0);
  const done = await runProvisioning(p.adapter, base);
  assert.equal(done.outcome, "provisioned");
  assert.equal(p.applied(), 1);
});

test("provisioning: unknown cost, destructive or unknown migration risk are not approximated as fine", async () => {
  const unknownCost = fakeProvisioner({ plan: { identity: { ...PID, estimatedMonthlyUsd: "unknown" } } });
  assert.match((await runProvisioning(unknownCost.adapter, { identity: { ...PID, estimatedMonthlyUsd: "unknown" }, authorisation: PAUTH, costCeilingUsd: 1e9, now: () => NOW })).reason, /cost .* unknown/);
  const destructive = fakeProvisioner({ plan: { destructive: true } });
  const req = { identity: PID, authorisation: PAUTH, costCeilingUsd: 50, now: () => NOW };
  assert.match((await runProvisioning(destructive.adapter, req)).reason, /destructive/);
  assert.equal((await runProvisioning(destructive.adapter, { ...req, acceptDestructive: true })).outcome, "provisioned");
  const migr = fakeProvisioner({ plan: { migrationRisk: "unknown" } });
  assert.match((await runProvisioning(migr.adapter, req)).reason, /unknown migration risk/);
  assert.equal(migr.applied(), 0);
});

test("provisioning: wrong account/region dry-run is refused; partial failure and lost reads are not success", async () => {
  const wrongRegion = fakeProvisioner({ plan: { identity: { ...PID, region: "us-east-1" } } });
  const req = { identity: PID, authorisation: PAUTH, costCeilingUsd: 50, now: () => NOW };
  assert.match((await runProvisioning(wrongRegion.adapter, req)).reason, /us-east-1/);
  assert.equal(wrongRegion.applied(), 0);
  const partial = fakeProvisioner({ outcome: "partial", exists: true });
  assert.equal((await runProvisioning(partial.adapter, req)).outcome, "held");
  const lying = fakeProvisioner({ outcome: "applied", exists: false });
  assert.equal((await runProvisioning(lying.adapter, req)).outcome, "held");
  const lost = fakeProvisioner({ readable: false });
  assert.equal((await runProvisioning(lost.adapter, req)).outcome, "unknown");
  const rejected = fakeProvisioner({ outcome: "rejected", exists: false });
  assert.equal((await runProvisioning(rejected.adapter, req)).outcome, "failed");
});

// ------------------------------------------------------------------ Teploy mapping

const missingOperations = (m: readonly { operation: string }[]): string[] =>
  ADAPTER_OPERATIONS.filter((op) => !m.some((e) => e.operation === op));

test("teploy mapping: every contract operation is mapped onto delivery.ts or has a named gap", () => {
  assert.deepEqual(missingOperations(TEPLOY_ADAPTER_MAPPING), []);
  for (const entry of TEPLOY_ADAPTER_MAPPING) {
    assert.ok(entry.today.length > 0);
    if (/^none/.test(entry.today)) assert.ok(entry.gap, `${entry.operation} has no implementation today and must name its gap`);
  }
  // Negative control: the completeness check does notice a missing operation.
  assert.deepEqual(missingOperations(TEPLOY_ADAPTER_MAPPING.filter((e) => e.operation !== "readback")), ["readback"]);
});
