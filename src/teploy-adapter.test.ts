import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { CommandRunner } from "./deploy.js";
import {
  CONFORMANCE_CHECK_NAMES,
  DestinationLocks,
  conformanceSuite,
  makeRecoveryPlan,
  runDeliveryJourney,
  runRecovery,
  type AdapterHarness,
  type Authorisation,
  type DeliveryIdentity,
  type Ok,
  type RecoveryPlan,
  type TargetChange,
  type TargetRef,
  type TargetState,
} from "./deployment-adapter.js";
import { executeDelivery, executeDeliveryRollback, readBackDelivery, type DeliveryRecord } from "./delivery.js";
import { DEFAULT_LEASE_DIRNAME, DEPLOY_ADAPTER_ENV, TEPLOY_UNSUPPORTED, TeployAdapter, deployAdapterFlagOn, serviceFromTeployYml, teployDeliveryAdapterFactory, type TeployAdapterOptions } from "./teploy-adapter.js";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "fixtures", "fake-teploy.mjs");

const T: TargetRef = { service: "svc-a", destination: "prod" };
const R0 = { revision: "rev-0", artifact: "img:0" };
const R1 = { revision: "rev-1", artifact: "img:1" };
const RIVAL = { revision: "rev-9", artifact: "img:9" };
const ident = (r: { revision: string; artifact: string }): DeliveryIdentity => ({ ...T, ...r });
const AUTH: Authorisation = { kind: "deploy", actor: "op@ship", ...T };
const RAUTH: Authorisation = { ...AUTH, kind: "recover" };

interface World {
  root: string;
  dir: string;
  stateFile: string;
  calls: string[];
  stats: { deployCalls: number; maxInFlight: number; inFlight: number };
  run: CommandRunner;
  adapter: TeployAdapter;
  harness: AdapterHarness;
  read(): Promise<Record<string, any>>;
  arm(patch: Record<string, unknown>): Promise<void>;
}

/** A real child process per command: the adapter's argv really reaches the fake CLI. */
async function world(over: Partial<TeployAdapterOptions> = {}, seedState: Record<string, unknown> = {}): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "teploy-adapter-"));
  const dir = join(root, "trusted");
  await import("node:fs/promises").then((fs) => fs.mkdir(dir));
  await writeFile(join(dir, "teploy.yml"), "app: svc-a\nserver: 100.64.0.9\n");
  const stateFile = join(root, "state.json");
  await writeFile(stateFile, JSON.stringify({ app: "svc-a", server: "100.64.0.9", releases: [], containers: [], ...seedState }));
  const calls: string[] = [];
  const stats = { deployCalls: 0, maxInFlight: 0, inFlight: 0 };
  const run: CommandRunner = (argv, opts) =>
    new Promise((resolve) => {
      calls.push(argv.join(" "));
      if (argv[0] !== "teploy") return resolve({ code: 127, stdout: "", stderr: `not allowed: ${argv[0]}` });
      const isDeploy = argv[1] === "deploy";
      if (isDeploy) { stats.deployCalls++; stats.inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight); }
      execFile(process.execPath, [FAKE, ...argv.slice(1)], { cwd: opts.cwd, timeout: opts.timeoutMs, env: { ...process.env, FAKE_TEPLOY_STATE: stateFile } }, (error, stdout, stderr) => {
        if (isDeploy) stats.inFlight--;
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  const adapter = new TeployAdapter({ ...T, dir, run, leaseDir: join(root, "leases"), ...over });
  const read = async () => JSON.parse(await readFile(stateFile, "utf8")) as Record<string, any>;
  const write = (s: Record<string, unknown>) => writeFile(stateFile, JSON.stringify(s));
  const arm = async (patch: Record<string, unknown>) => write({ ...(await read()), ...patch });
  const land = (s: Record<string, any>, r: { revision: string; artifact: string }) => {
    s.current_hash = r.revision;
    let image = r.artifact;
    if (s.idForm || s.hideArtifact) {
      image = `${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`;
      s.imageTags = { ...(s.imageTags ?? {}), [image]: [r.artifact] };
    }
    s.containers = [{ ID: `c${Math.random().toString(16).slice(2, 10)}`, Name: `svc-a-web-${r.revision}`, Image: image, State: "running" }];
    s.releases = [...s.releases.filter((x: { hash: string }) => x.hash !== r.revision), { hash: r.revision, image: r.artifact }];
  };
  const harness: AdapterHarness = {
    adapter,
    seed: async (_t, state) => { const s = await read(); land(s, state); await write(s); },
    truth: async () => {
      const s = await read();
      const running = (s.containers as Array<{ Image: string; State: string }>).filter((c) => c.State === "running");
      return running.length === 0 ? { serving: false } : { serving: true, revision: s.current_hash, artifact: running[0]!.Image };
    },
    outOfBand: async (_t, change: TargetChange) => {
      const s = await read();
      if ("unreadable" in change) s.unreadable = "exit"; else land(s, change);
      await write(s);
    },
    interfere: async (when, change) => arm({ pending: { when, change } }),
    restoreReads: async () => arm({ unreadable: null }),
    stats: () => ({ deployCalls: stats.deployCalls, maxInFlightDeploys: stats.maxInFlight }),
  };
  return { root, dir, stateFile, calls, stats, run, adapter, harness, read, arm };
}

const okOf = <V>(r: { kind: string }): V => { assert.equal(r.kind, "ok", JSON.stringify(r)); return (r as Ok<V>).value; };

// ------------------------------------------------------------------ conformance

/** The checks this adapter cannot honestly pass, each tied to a declared gap. */
const EXPECTED_SKIPPED: Record<string, string> = {
  "deploy-fenced-on-generation": "fencing compare-and-set not declared",
  "journey-refuses-stale-plan": "fencing compare-and-set not declared",
  "logs-attribute-service": "capability logs not declared",
  "observe-attributes-service": "capability observe not declared",
  "no-readback-never-confirms": "adapter declares readback",
};

test("the 27-check conformance suite: every check passes or is skipped for a DECLARED gap, none fails", async () => {
  const report = await conformanceSuite(async () => (await world()).harness);
  assert.equal(report.adapter, "teploy");
  assert.equal(report.checks.length, CONFORMANCE_CHECK_NAMES.length);
  assert.equal(CONFORMANCE_CHECK_NAMES.length, 27);
  assert.deepEqual(report.failed, [], report.checks.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.detail}`).join("\n"));
  assert.equal(report.conformant, true);
  assert.deepEqual([...report.skipped].sort(), Object.keys(EXPECTED_SKIPPED).sort());
  for (const c of report.checks.filter((c) => c.status === "skipped")) {
    assert.ok(c.detail.startsWith(EXPECTED_SKIPPED[c.name]!), `${c.name} skipped for an unexpected reason: ${c.detail}`);
  }
  // 22 passes, 5 skips: the skip is a report, never a pass.
  assert.equal(report.checks.filter((c) => c.status === "pass").length, 22);
  // The skipped checks line up with declarations, not silence.
  const declared = new Set(TEPLOY_UNSUPPORTED.map((u) => u.capability));
  for (const needed of ["destination-fence-vs-manual-deploy", "provider-dry-run", "target-generation-token", "recovery-artifact-digest", "logs"]) {
    assert.ok(declared.has(needed), `${needed} must be declared unsupported`);
  }
  assert.deepEqual((await world()).adapter.capabilities().unsupported, TEPLOY_UNSUPPORTED);
});

test("capability declaration: no dry-run, lease-only fencing, one recovery mode; no lease directory means no fencing at all", async () => {
  const w = await world();
  const caps = w.adapter.capabilities();
  assert.equal(caps.dryRun, false);
  assert.equal(caps.provisioning, false);
  assert.deepEqual(caps.fencing, ["lease"]);
  assert.deepEqual(caps.recovery, ["rollback-to-version"]);
  const bare = (await world({ leaseDir: undefined })).adapter;
  assert.deepEqual(bare.capabilities().fencing, []);
  assert.equal(bare.acquireLease, undefined);
});

// ------------------------------------------------------------------ journey on the fake CLI

test("a faithful deploy runs the legacy argv and is confirmed only by reading status back", async () => {
  const w = await world();
  await w.harness.seed(T, R0);
  const r = await runDeliveryJourney(w.adapter, { identity: ident(R1), authorisation: AUTH, locks: new DestinationLocks() });
  assert.equal(r.outcome, "confirmed", r.reason);
  assert.ok(w.calls.includes("teploy deploy --image img:1 --version rev-1 --skip-dns-check"), w.calls.join("\n"));
  assert.equal(r.plan?.validatedByProvider, false);
  assert.equal((await w.harness.truth(T)).revision, "rev-1");
});

test("dry run plans without any deploy command and says the provider did not validate it", async () => {
  const w = await world();
  await w.harness.seed(T, R0);
  const r = await runDeliveryJourney(w.adapter, { identity: ident(R1), authorisation: AUTH, dryRun: true, locks: new DestinationLocks() });
  assert.equal(r.outcome, "planned");
  assert.match(r.reason, /without provider validation/);
  assert.equal(w.stats.deployCalls, 0);
});

test("unreadable status: the journey holds before acting (exit failure and non-JSON), and after a deploy it is unknown, never failed", async () => {
  for (const mode of ["exit", "garbage"]) {
    const w = await world();
    await w.harness.seed(T, R0);
    await w.arm({ unreadable: mode });
    const before = await runDeliveryJourney(w.adapter, { identity: ident(R1), authorisation: AUTH, locks: new DestinationLocks() });
    assert.equal(before.outcome, "held", mode);
    assert.equal(before.acted, false);
    assert.equal(w.stats.deployCalls, 0, "an unread target must not be acted on");
  }
  const w = await world();
  await w.harness.seed(T, R0);
  await w.harness.interfere("after-deploy", { unreadable: true });
  const after = await runDeliveryJourney(w.adapter, { identity: ident(R1), authorisation: AUTH, locks: new DestinationLocks() });
  assert.equal(after.outcome, "unknown", after.reason);
  assert.equal(after.acted, true);
});

test("wrong service: a status that names another app is unknown for inspect AND readback, and nothing is deployed", async () => {
  const w = await world();
  await w.harness.seed(T, R0);
  await w.arm({ wrongApp: "someone-elses-app" });
  for (const r of [await w.adapter.inspect(T), await w.adapter.readback(T)]) {
    assert.equal(r.kind, "unknown");
    assert.match((r as { reason: string }).reason, /someone-elses-app.*wrong-service attribution refused/);
  }
  const j = await runDeliveryJourney(w.adapter, { identity: ident(R1), authorisation: AUTH, locks: new DestinationLocks() });
  assert.equal(j.outcome, "held");
  assert.equal(w.stats.deployCalls, 0);
});

test("an adapter bound to one service@destination refuses to answer for another", async () => {
  const w = await world();
  assert.equal((await w.adapter.inspect({ service: "svc-b", destination: "prod" })).kind, "refused");
  assert.equal((await w.adapter.readback({ service: "svc-a", destination: "staging" })).kind, "refused");
  assert.equal((await w.adapter.acquireLease!({ service: "svc-b", destination: "prod" }, "x")).kind, "refused");
});

test("hidden artifact: an image ID that cannot be resolved is unknown (a lost read), never a mismatch or a confirm", async () => {
  const w = await world({}, { idForm: true });
  await w.harness.seed(T, R0);
  await w.arm({ hideArtifact: true });
  const read = await w.adapter.readback(ident(R0));
  assert.equal(read.kind, "unknown");
  assert.match((read as { reason: string }).reason, /could not be resolved/);
  const j = await runDeliveryJourney(w.adapter, { identity: ident(R1), authorisation: AUTH, locks: new DestinationLocks() });
  assert.notEqual(j.outcome, "confirmed");
  assert.notEqual(j.outcome, "failed");
});

test("ID-form images resolve to the approved tag through teploy exec, and a different tag is a readable mismatch", async () => {
  const w = await world({}, { idForm: true });
  await w.harness.seed(T, R0);
  const same = okOf<TargetState>(await w.adapter.readback(ident(R0)));
  assert.equal(same.artifact, "img:0");
  assert.ok(w.calls.some((c) => c.startsWith("teploy exec 100.64.0.9 -- docker image inspect")), "must resolve through the server teploy.yml names");
  const other = okOf<TargetState>(await w.adapter.readback(ident(R1)));
  assert.equal(other.artifact, "img:0", "reports what the target runs, not what was asked");
  const j = await runDeliveryJourney(w.adapter, { identity: ident(R1), authorisation: AUTH, locks: new DestinationLocks() });
  assert.equal(j.outcome, "confirmed", j.reason);
});

test("a rival landing after the deploy applied is a hold on a readable mismatch, never a confirm", async () => {
  const w = await world();
  await w.harness.seed(T, R0);
  await w.harness.interfere("after-deploy", RIVAL);
  const r = await runDeliveryJourney(w.adapter, { identity: ident(R1), authorisation: AUTH, locks: new DestinationLocks() });
  assert.equal(r.outcome, "held", r.reason);
});

test("racing deploys to one destination are serialised and leave the last confirmed release serving", async () => {
  const w = await world();
  await w.harness.seed(T, R0);
  const locks = new DestinationLocks();
  const [a, b] = await Promise.all([
    runDeliveryJourney(w.adapter, { identity: ident(R1), authorisation: AUTH, locks }),
    runDeliveryJourney(w.adapter, { identity: ident(RIVAL), authorisation: AUTH, locks }),
  ]);
  assert.equal(w.stats.maxInFlight, 1);
  assert.deepEqual([a.outcome, b.outcome], ["confirmed", "confirmed"]);
  assert.equal((await w.harness.truth(T)).revision, "rev-9");
});

test("deploy exit code is not the verdict: exit 1 after the swap is indeterminate and the journey reads it back as confirmed", async () => {
  const w = await world();
  await w.harness.seed(T, R0);
  await w.arm({ failDeploy: "exit-after-apply" });
  const r = await runDeliveryJourney(w.adapter, { identity: ident(R1), authorisation: AUTH, locks: new DestinationLocks() });
  assert.equal(r.outcome, "confirmed", r.reason);
  assert.match(r.reason, /indeterminate/);
});

test("deploy exit 1 before anything changed: never confirmed, held (not failed: a non-zero exit is indeterminate, not proof of no change)", async () => {
  const w = await world();
  await w.harness.seed(T, R0);
  await w.arm({ failDeploy: "exit-before" });
  const r = await runDeliveryJourney(w.adapter, { identity: ident(R1), authorisation: AUTH, locks: new DestinationLocks() });
  assert.equal(r.outcome, "held", r.reason);
  assert.equal((await w.harness.truth(T)).revision, "rev-0");
});

// ------------------------------------------------------------------ the declared gaps, pinned

test("pre-command compare: a change between plan and deploy() is rejected stale-generation and no deploy command runs", async () => {
  const w = await world();
  await w.harness.seed(T, R0);
  const base = okOf<TargetState>(await w.adapter.inspect(T));
  const plan = okOf<import("./deployment-adapter.js").DeliveryPlan>(await w.adapter.plan(ident(R1), base));
  await w.harness.outOfBand(T, RIVAL);
  const receipt = await w.adapter.deploy({ plan, authorisation: AUTH, expectGeneration: base.generation });
  assert.equal(receipt.outcome, "rejected");
  assert.equal(receipt.rejection, "stale-generation");
  assert.equal(w.stats.deployCalls, 0);
  assert.equal((await w.harness.truth(T)).revision, "rev-9");
});

test("DECLARED GAP: a rival landing inside the deploy command (after the compare) is NOT fenced; the rollback-less overwrite is the destination-fence gap", async () => {
  // This pins the limitation `destination-fence-vs-manual-deploy` declares. If
  // teploy ever grows a real destination fence, this test must start failing
  // and the declaration and the skipped checks be revisited together.
  const w = await world();
  await w.harness.seed(T, R0);
  await w.harness.interfere("before-deploy", RIVAL);
  const r = await runDeliveryJourney(w.adapter, { identity: ident(R1), authorisation: AUTH, locks: new DestinationLocks() });
  assert.equal(r.outcome, "confirmed", "the window is real: the deploy overwrote the rival and read back as the approved release");
  assert.ok(TEPLOY_UNSUPPORTED.some((u) => u.capability === "destination-fence-vs-manual-deploy"));
});

test("the lease is exclusive among Ship releases and is checked at deploy time", async () => {
  const w = await world();
  await w.harness.seed(T, R0);
  const a = okOf<import("./deployment-adapter.js").Lease>(await w.adapter.acquireLease!(T, "one"));
  assert.equal((await w.adapter.acquireLease!(T, "two")).kind, "refused");
  // A journey while another holder has the lease holds without acting.
  const held = await runDeliveryJourney(w.adapter, { identity: ident(R1), authorisation: AUTH, locks: new DestinationLocks() });
  assert.equal(held.outcome, "held");
  assert.equal(held.acted, false);
  assert.equal(w.stats.deployCalls, 0);
  // A deploy carrying a lease that is not the held one is rejected.
  const base = okOf<TargetState>(await w.adapter.inspect(T));
  const plan = okOf<import("./deployment-adapter.js").DeliveryPlan>(await w.adapter.plan(ident(R1), base));
  const forged = await w.adapter.deploy({ plan, authorisation: AUTH, expectGeneration: base.generation, lease: { ...a, token: "forged" } });
  assert.equal(forged.outcome, "rejected");
  assert.equal(w.stats.deployCalls, 0);
  await w.adapter.releaseLease!(a);
  assert.equal((await w.adapter.acquireLease!(T, "two")).kind, "ok");
});

test("an expired lease can be reclaimed, an unreadable lease file is never broken, and release by a stale token does not free a newer lease", async () => {
  let t = Date.parse("2026-10-04T00:00:00Z");
  const w = await world({ now: () => new Date(t), leaseTtlMs: 1000 });
  const first = okOf<import("./deployment-adapter.js").Lease>(await w.adapter.acquireLease!(T, "one"));
  t += 2000;
  const second = okOf<import("./deployment-adapter.js").Lease>(await w.adapter.acquireLease!(T, "two"));
  await w.adapter.releaseLease!(first); // stale token: must not free `second`
  assert.equal((await w.adapter.acquireLease!(T, "three")).kind, "refused");
  await w.adapter.releaseLease!(second);
  const path = join(w.root, "leases", `${encodeURIComponent("svc-a@prod")}.lease`);
  await writeFile(path, "not json");
  assert.equal((await w.adapter.acquireLease!(T, "four")).kind, "refused");
});

test("deploy and recover refuse authority that is for another kind or destination, and run no command", async () => {
  const w = await world();
  await w.harness.seed(T, R0);
  const base = okOf<TargetState>(await w.adapter.inspect(T));
  const plan = okOf<import("./deployment-adapter.js").DeliveryPlan>(await w.adapter.plan(ident(R1), base));
  const bad = await w.adapter.deploy({ plan, authorisation: { ...AUTH, destination: "elsewhere" }, expectGeneration: base.generation });
  assert.equal(bad.rejection, "unauthorised");
  const wrongKind = await w.adapter.deploy({ plan, authorisation: RAUTH, expectGeneration: base.generation });
  assert.equal(wrongKind.rejection, "unauthorised");
  assert.equal(w.stats.deployCalls, 0);
});

// ------------------------------------------------------------------ recovery

test("rollback-to-version recovers through teploy rollback --to and verifies by readback (revision only)", async () => {
  const w = await world();
  await w.harness.seed(T, R0);
  const j = await runDeliveryJourney(w.adapter, { identity: ident(R1), authorisation: AUTH, locks: new DestinationLocks() });
  assert.equal(j.outcome, "confirmed");
  const plan = okOf<RecoveryPlan>(await makeRecoveryPlan(w.adapter, ident(R1), "rollback-to-version", { revision: "rev-0" }));
  const r = await runRecovery(w.adapter, { plan, authorisation: RAUTH, locks: new DestinationLocks() });
  assert.equal(r.outcome, "recovered", r.reason);
  assert.deepEqual(r.verifiedAgainst, ["revision"], "the recovery artifact digest is not recorded, so only the revision is verified");
  assert.ok(w.calls.includes("teploy rollback --to rev-0"));
  assert.equal((await w.harness.truth(T)).revision, "rev-0");
});

test("invalid recovery is refused: unsupported modes, an explicit-less target, a target that moved, an unretained version", async () => {
  const w = await world();
  await w.harness.seed(T, R0);
  await runDeliveryJourney(w.adapter, { identity: ident(R1), authorisation: AUTH, locks: new DestinationLocks() });
  const base = okOf<TargetState>(await w.adapter.readback(ident(R1)));
  for (const mode of ["redeploy-previous-artifact", "roll-forward"] as const) {
    const r = await runRecovery(w.adapter, { plan: { mode, target: T, delivered: ident(R1), to: { revision: "rev-0" }, baselineGeneration: base.generation, madeAt: "2026-10-04T00:00:00Z" }, authorisation: RAUTH, locks: new DestinationLocks() });
    assert.equal(r.outcome, "held", mode);
    assert.equal(r.acted, false);
  }
  assert.equal((await makeRecoveryPlan(w.adapter, ident(R1), "rollback-to-version", { revision: "" })).kind, "refused");
  assert.ok(!w.calls.some((c) => c.startsWith("teploy rollback")), "no rollback command for refused plans");
  // An unretained version: the command fails, the receipt is indeterminate, the outcome is held (target unchanged), never recovered.
  const plan = okOf<RecoveryPlan>(await makeRecoveryPlan(w.adapter, ident(R1), "rollback-to-version", { revision: "rev-404" }));
  const r = await runRecovery(w.adapter, { plan, authorisation: RAUTH, locks: new DestinationLocks() });
  assert.notEqual(r.outcome, "recovered");
  assert.equal((await w.harness.truth(T)).revision, "rev-1");
  // A target that moved after the plan: held without acting.
  const plan2 = okOf<RecoveryPlan>(await makeRecoveryPlan(w.adapter, ident(R1), "rollback-to-version", { revision: "rev-0" }));
  await w.harness.outOfBand(T, RIVAL);
  const before = w.calls.filter((c) => c.startsWith("teploy rollback")).length;
  const moved = await runRecovery(w.adapter, { plan: plan2, authorisation: RAUTH, locks: new DestinationLocks() });
  assert.equal(moved.outcome, "held");
  assert.equal(w.calls.filter((c) => c.startsWith("teploy rollback")).length, before);
  assert.equal((await w.harness.truth(T)).revision, "rev-9");
});

// ------------------------------------------------------------------ observe, flag, service

test("observe is declared only when bound, and only answers for its own service", async () => {
  const w = await world({ observe: { service: "svc-a", read: async () => ({ health: "healthy", reason: "0 errors" }) } });
  assert.equal(w.adapter.capabilities().observe, true);
  const mine = okOf<{ service: string; health: string }>(await w.adapter.observe!(T));
  assert.equal(mine.service, "svc-a");
  assert.equal((await w.adapter.observe!({ service: "svc-b", destination: "prod" })).kind, "unknown");
  const failing = await world({ observe: { service: "svc-a", read: async () => { throw new Error("observe down"); } } });
  assert.equal((await failing.adapter.observe!(T)).kind, "unknown");
  // With observe bound the whole suite still has no failure, and its observe check now runs.
  const report = await conformanceSuite(async () => (await world({ observe: { service: "svc-a", read: async () => ({ health: "healthy", reason: "ok" }) } })).harness);
  assert.deepEqual(report.failed, []);
  assert.ok(!report.skipped.includes("observe-attributes-service"));
});

test("the opt-in flag is exactly SHIP_DEPLOY_ADAPTER=teploy and defaults off", () => {
  assert.equal(DEPLOY_ADAPTER_ENV, "SHIP_DEPLOY_ADAPTER");
  assert.equal(deployAdapterFlagOn({}), false);
  for (const v of ["", "1", "true", "TEPLOY", "teploy ", "kubernetes"]) assert.equal(deployAdapterFlagOn({ SHIP_DEPLOY_ADAPTER: v }), false, v);
  assert.equal(deployAdapterFlagOn({ SHIP_DEPLOY_ADAPTER: "teploy" }), true);
  assert.equal(DEFAULT_LEASE_DIRNAME, ".teploy-ship-leases");
});

test("serviceFromTeployYml reads the app line as teploy does, and is absent when unreadable", async () => {
  const w = await world();
  assert.equal(await serviceFromTeployYml(w.dir), "svc-a");
  await writeFile(join(w.dir, "teploy.yml"), 'app: "quoted-app"\nserver: x\n');
  assert.equal(await serviceFromTeployYml(w.dir), "quoted-app");
  assert.equal(await serviceFromTeployYml(join(w.root, "nowhere")), undefined);
});

// ------------------------------------------------------------------ through delivery.ts (the real call path)

const IMAGE = "ship-delivery-abc123";
const dRecord = (over: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  id: "run-s27",
  runId: "run-s27",
  repo: "http://forge.example:3000/Tyler/app.git",
  mergedSha: "abc123def456",
  destination: "prod",
  recoveryVersion: "rev-0",
  actor: "token",
  state: "executing",
  updatedAt: "2026-10-04T00:00:00.000Z",
  ...over,
});

/** The vcs/cat/build plumbing around the fake CLI: only `teploy status|deploy|rollback|exec` reach it. */
function plumbed(w: World): CommandRunner {
  return async (argv, opts) => {
    if (argv[0] === "teploy" && argv[1] === "build") { w.calls.push(argv.join(" ")); return { code: 0, stdout: JSON.stringify({ image: IMAGE }), stderr: "" }; }
    if (argv[0] === "teploy") return w.run(argv, opts);
    w.calls.push(argv.join(" "));
    if (argv[0] === "cat") return readFile(argv[1]!, "utf8").then((stdout) => ({ code: 0, stdout, stderr: "" }), () => ({ code: 1, stdout: "", stderr: "no such file" }));
    if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "add") { await mkdir(argv[4]!, { recursive: true }); return { code: 0, stdout: "", stderr: "" }; }
    if (argv[0] === "git" && argv[1] === "worktree" && argv[2] === "remove") { await rm(argv[4]!, { recursive: true, force: true }); return { code: 0, stdout: "", stderr: "" }; }
    if (argv[0] === "git" && argv[1] === "symbolic-ref") return { code: 1, stdout: "", stderr: "no default branch" };
    return { code: 0, stdout: "", stderr: "" };
  };
}
const now = () => "2026-10-04T00:00:00.000Z";
const deployCall = (w: World): string[] => w.calls.filter((c) => c.startsWith("teploy deploy"));

test("flag OFF (no adapter option): the legacy path runs the inline deploy, never touches a lease, and an explicit undefined adapter is identical", async () => {
  const a = await world();
  await a.harness.seed(T, R0);
  const legacy = await executeDelivery(dRecord(), { dir: a.dir, run: plumbed(a), now });
  const b = await world();
  await b.harness.seed(T, R0);
  const explicit = await executeDelivery(dRecord(), { dir: b.dir, run: plumbed(b), now, adapter: undefined });
  assert.deepEqual(legacy, explicit);
  assert.equal(legacy.state, "unknown");
  assert.equal(legacy.artifactDigest, IMAGE);
  assert.equal(legacy.reason, "deployment command completed; target state not yet read back");
  assert.deepEqual(deployCall(a), [`teploy deploy --image ${IMAGE} --version abc123d --skip-dns-check`]);
  // The legacy sequence is exactly the inline one: one status read, no re-inspects, no lease directory.
  assert.equal(a.calls.filter((c) => c === "teploy status --json").length, 1);
  await assert.rejects(stat(join(a.root, "leases")), /ENOENT/);
  await assert.rejects(stat(join(a.dir, DEFAULT_LEASE_DIRNAME)), /ENOENT/);
  // The env flag is read in the worker, never in delivery.ts.
  assert.equal(deployAdapterFlagOn({}), false);
});

test("flag ON: the adapter journey sends the SAME deploy argv, the record stays unknown for the sweep, and the legacy read-back then confirms", async () => {
  const legacyWorld = await world();
  await legacyWorld.harness.seed(T, R0);
  await executeDelivery(dRecord(), { dir: legacyWorld.dir, run: plumbed(legacyWorld), now });

  const w = await world();
  await w.harness.seed(T, R0);
  const out = await executeDelivery(dRecord(), { dir: w.dir, run: plumbed(w), now, adapter: teployDeliveryAdapterFactory({ dir: w.dir, run: plumbed(w), leaseDir: join(w.root, "leases") }) });
  assert.equal(out.state, "unknown");
  assert.equal(out.artifactDigest, IMAGE);
  assert.match(out.reason ?? "", /deployment adapter \(teploy\) deployed and read the target back/);
  assert.deepEqual(deployCall(w), deployCall(legacyWorld), "the adapter must issue the byte-identical deploy command");
  assert.ok(w.calls.filter((c) => c === "teploy status --json").length > 1, "the adapter reads the target repeatedly (inspect, re-inspect, pre-command, readback)");
  // The sweep (legacy, untouched) reconciles the same record from the same target.
  const read = await readBackDelivery({ ...dRecord({ state: "unknown" }), artifactDigest: IMAGE }, { dir: w.dir, run: plumbed(w), observe: {} });
  assert.equal(read.outcome, "confirmed");
  // The lease was released.
  assert.equal((await w.adapter.acquireLease!(T, "after")).kind, "ok");
});

test("flag ON refusals hold WITHOUT a deploy command: unreadable status, wrong service in teploy.yml, no app line, no recorded destination", async () => {
  const factoryFor = (w: World) => teployDeliveryAdapterFactory({ dir: w.dir, run: plumbed(w), leaseDir: join(w.root, "leases") });
  const unreadable = await world();
  await unreadable.harness.seed(T, R0);
  await unreadable.arm({ unreadable: "garbage" });
  const a = await executeDelivery(dRecord(), { dir: unreadable.dir, run: plumbed(unreadable), now, adapter: factoryFor(unreadable) });
  assert.equal(a.state, "held");
  assert.match(a.reason ?? "", /could not be inspected/);
  assert.equal(deployCall(unreadable).length, 0);

  const wrong = await world();
  await wrong.harness.seed(T, R0);
  await writeFile(join(wrong.dir, "teploy.yml"), "app: some-other-app\nserver: 100.64.0.9\n");
  const b = await executeDelivery(dRecord(), { dir: wrong.dir, run: plumbed(wrong), now, adapter: factoryFor(wrong) });
  assert.equal(b.state, "held");
  assert.match(b.reason ?? "", /wrong-service attribution refused/);
  assert.equal(deployCall(wrong).length, 0);

  const noApp = await world();
  await noApp.harness.seed(T, R0);
  await writeFile(join(noApp.dir, "teploy.yml"), "server: 100.64.0.9\n");
  const c = await executeDelivery(dRecord(), { dir: noApp.dir, run: plumbed(noApp), now, adapter: factoryFor(noApp) });
  assert.equal(c.state, "held");
  assert.match(c.reason ?? "", /deployment adapter unavailable: no `app:` line/);
  assert.equal(deployCall(noApp).length, 0);

  const noDest = await world();
  const d = await executeDelivery(dRecord({ destination: undefined }), { dir: noDest.dir, run: plumbed(noDest), now, adapter: factoryFor(noDest) });
  assert.equal(d.state, "held");
  assert.match(d.reason ?? "", /needs the destination/);
  assert.equal(noDest.calls.length, 0, "nothing at all ran before the destination check");
});

test("flag ON: a rival lands after the deploy applied; the record is unknown (acted), never confirmed", async () => {
  const w = await world();
  await w.harness.seed(T, R0);
  await w.harness.interfere("after-deploy", RIVAL);
  const out = await executeDelivery(dRecord(), { dir: w.dir, run: plumbed(w), now, adapter: teployDeliveryAdapterFactory({ dir: w.dir, run: plumbed(w), leaseDir: join(w.root, "leases") }) });
  assert.equal(out.state, "unknown");
  assert.doesNotMatch(out.reason ?? "", /read the target back on the approved version/);
  assert.match(out.reason ?? "", /may have changed/);
  const read = await readBackDelivery({ ...dRecord({ state: "unknown" }), artifactDigest: IMAGE }, { dir: w.dir, run: plumbed(w), observe: {} });
  assert.equal(read.outcome, "mismatch");
});

test("rollback flag ON vs OFF: both restore the retained version; the adapter path refuses a target that moved or is unreadable and runs no rollback command", async () => {
  const rolling = (): DeliveryRecord => dRecord({ state: "confirmed", artifactDigest: IMAGE, rollback: { state: "executing", actor: "token", reason: "bad", requestedAt: now() } });
  const prepare = async (): Promise<World> => {
    const w = await world();
    await w.harness.seed(T, R0);
    await executeDelivery(dRecord(), { dir: w.dir, run: plumbed(w), now });
    return w;
  };
  const rollbackCalls = (w: World): string[] => w.calls.filter((c) => c.startsWith("teploy rollback"));
  const factoryFor = (w: World) => teployDeliveryAdapterFactory({ dir: w.dir, run: plumbed(w), leaseDir: join(w.root, "leases") });

  const legacy = await prepare();
  const lr = await executeDeliveryRollback(rolling(), { dir: legacy.dir, run: plumbed(legacy), now });
  assert.equal(lr.state, "done", lr.evidence);

  const on = await prepare();
  const factory = factoryFor(on);
  const r = await executeDeliveryRollback(rolling(), { dir: on.dir, run: plumbed(on), now, adapter: factory });
  assert.equal(r.state, "done", r.evidence);
  assert.deepEqual(rollbackCalls(on), rollbackCalls(legacy));
  assert.equal((await on.harness.truth(T)).revision, "rev-0");
  // Retried after it landed: already on the retained version, no second command.
  const again = await executeDeliveryRollback(rolling(), { dir: on.dir, run: plumbed(on), now, adapter: factory });
  assert.equal(again.state, "done");
  assert.match(again.evidence ?? "", /already/);
  assert.equal(rollbackCalls(on).length, 1);

  // A newer delivery replaced this one: rolling back would undo it too.
  const moved = await prepare();
  await moved.harness.outOfBand(T, RIVAL);
  const m = await executeDeliveryRollback(rolling(), { dir: moved.dir, run: plumbed(moved), now, adapter: factoryFor(moved) });
  assert.equal(m.state, "failed");
  assert.equal(rollbackCalls(moved).length, 0);
  assert.equal((await moved.harness.truth(T)).revision, "rev-9");

  // Unreadable target: never acted on.
  const dark = await prepare();
  await dark.arm({ unreadable: "exit" });
  const u = await executeDeliveryRollback(rolling(), { dir: dark.dir, run: plumbed(dark), now, adapter: factoryFor(dark) });
  assert.equal(u.state, "failed");
  assert.equal(rollbackCalls(dark).length, 0);

  // No digest recorded: the adapter path says so rather than guessing.
  const noDigest = await executeDeliveryRollback(dRecord({ state: "confirmed", rollback: { state: "executing", actor: "token", reason: "x", requestedAt: now() } }), { dir: on.dir, run: plumbed(on), now, adapter: factory });
  assert.equal(noDigest.state, "failed");
  assert.match(noDigest.evidence ?? "", /artifact digest/);
});
