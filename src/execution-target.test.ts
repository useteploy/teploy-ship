import assert from "node:assert/strict";
import { test } from "node:test";

import { conformance, isConformant, judgeTarget, onHostLoss, placeRun } from "./execution-target.js";
import type {
  PlacementState,
  RunOnHost,
  RunRequirement,
  Target,
  TargetAdapter,
  TargetCapabilities,
  TargetState,
} from "./execution-target.js";

function caps(over: Partial<TargetCapabilities> = {}): TargetCapabilities {
  return {
    kind: "local-container",
    hosting: "managed",
    os: "linux",
    arch: "amd64",
    cpu: 4,
    memMB: 8192,
    diskMB: 50_000,
    browser: "headless",
    desktop: false,
    services: ["docker"],
    hardware: { gpu: 0, mobileSim: [] },
    network: [],
    snapshotFormats: ["oci-image"],
    isolated: true,
    credentialMode: "static",
    quota: { maxRuns: 4 },
    ...over,
  };
}

const t = (id: string, over: Partial<TargetCapabilities> = {}): Target => ({ id, caps: caps(over) });
const st = (over: Partial<TargetState> = {}): TargetState => ({
  healthy: true,
  draining: false,
  live: 0,
  usedCpu: 0,
  usedMemMB: 0,
  usedDiskMB: 0,
  projectRuns: {},
  ...over,
});
const req = (over: Partial<RunRequirement> = {}): RunRequirement => ({ project: "p1", os: "linux", ...over });

/**
 * The placement this module replaces, in the sandbox-pool.ts idiom minus the
 * capability model: first healthy host. Used only to show each rule has teeth.
 */
function naiveFirstHealthy(targets: Target[], state: PlacementState): Target | undefined {
  return targets.find((x) => state[x.id]?.healthy === true);
}

function refused(p: ReturnType<typeof placeRun>) {
  assert.equal(p.ok, false);
  return p as Extract<typeof p, { ok: false }>;
}
function codes(p: ReturnType<typeof placeRun>, id: string): string[] {
  return p.verdicts.find((v) => v.targetId === id)!.rejections.map((r) => r.code);
}

test("least-loaded among suitable targets, ties by declaration order", () => {
  const ts = [t("a"), t("b"), t("c")];
  const s = { a: st({ live: 2 }), b: st({ live: 1 }), c: st({ live: 1 }) };
  const p = placeRun(req(), ts, s);
  assert.ok(p.ok);
  assert.equal(p.target.id, "b");
  assert.deepEqual(p.suitable, ["a", "b", "c"]);
});

test("utilisation, not raw count: a big box with more runs can still be less loaded", () => {
  const ts = [t("small", { quota: { maxRuns: 2 } }), t("big", { quota: { maxRuns: 16 } })];
  const p = placeRun(req(), ts, { small: st({ live: 1 }), big: st({ live: 3 }) });
  assert.ok(p.ok);
  assert.equal(p.target.id, "big");
});

test("a warm volume breaks an exact tie only", () => {
  const ts = [t("a"), t("b")];
  const tied = placeRun(req({ warmRepo: "r" }), ts, { a: st(), b: st({ warmRepos: ["r"] }) });
  assert.ok(tied.ok);
  assert.equal(tied.target.id, "b");
  const loaded = placeRun(req({ warmRepo: "r" }), ts, { a: st(), b: st({ warmRepos: ["r"], live: 1 }) });
  assert.ok(loaded.ok);
  assert.equal(loaded.target.id, "a");
});

test("arch mismatch: arm64 never lands on amd64, and the refusal says so", () => {
  const ts = [t("amd", { arch: "amd64" })];
  const p = refused(placeRun(req({ arch: "arm64" }), ts, { amd: st() }));
  assert.equal(p.refusal, "no-suitable-target");
  assert.deepEqual(codes(p, "amd"), ["arch"]);
  assert.match(p.reason, /needs arm64, target is amd64/);
  // negative control: first-healthy puts it on the wrong architecture
  assert.equal(naiveFirstHealthy(ts, { amd: st() })!.caps.arch, "amd64");
  // and with an arm64 target present, only it is chosen even though it is more loaded
  const both = [t("amd"), t("arm", { arch: "arm64" })];
  const q = placeRun(req({ arch: "arm64" }), both, { amd: st(), arm: st({ live: 3 }) });
  assert.ok(q.ok);
  assert.equal(q.target.id, "arm");
  assert.equal(naiveFirstHealthy(both, { amd: st(), arm: st({ live: 3 }) })!.id, "amd");
});

test("no arch stated means any architecture; os is never defaulted across targets", () => {
  const p = placeRun(req(), [t("arm", { arch: "arm64" })], { arm: st() });
  assert.ok(p.ok);
  const w = refused(placeRun(req({ os: "windows" }), [t("lin")], { lin: st() }));
  assert.deepEqual(codes(w, "lin"), ["os"]);
});

test("browser: a headless-only target never takes a headed run; headed satisfies headless", () => {
  const ts = [t("hl", { browser: "headless" }), t("none", { browser: "none" })];
  const s = { hl: st(), none: st() };
  const p = refused(placeRun(req({ browser: "headed" }), ts, s));
  assert.equal(p.refusal, "no-suitable-target");
  assert.deepEqual(codes(p, "hl"), ["capability"]);
  assert.match(p.reason, /needs headed browser, target has headless/);
  assert.equal(naiveFirstHealthy(ts, s)!.caps.browser, "headless"); // negative control
  const headed = [t("hd", { browser: "headed", desktop: true })];
  assert.ok(placeRun(req({ browser: "headless" }), headed, { hd: st() }).ok);
  assert.ok(placeRun(req({ browser: "headed", desktop: true }), headed, { hd: st() }).ok);
  assert.equal(refused(placeRun(req({ browser: "headless" }), [t("none", { browser: "none" })], { none: st() })).refusal, "no-suitable-target");
});

test("services, gpu, mobile simulator and private network are each required, not assumed", () => {
  const plain = t("plain");
  const s = { plain: st() };
  for (const r of [req({ services: ["postgres"] }), req({ gpu: 1 }), req({ mobileSim: "ios" }), req({ network: ["corp-lan"] }), req({ desktop: true })]) {
    const p = refused(placeRun(r, [plain], s));
    assert.equal(p.refusal, "no-suitable-target");
    assert.deepEqual(codes(p, "plain"), ["capability"]);
  }
  const rich = t("rich", { services: ["docker", "postgres"], hardware: { gpu: 2, mobileSim: ["ios"] }, network: ["corp-lan"], desktop: true });
  assert.ok(placeRun(req({ services: ["postgres"], gpu: 1, mobileSim: "ios", network: ["corp-lan"], desktop: true }), [plain, rich], { ...s, rich: st() }).ok);
});

test("hosting, isolation and disposable credentials are hard requirements", () => {
  const managed = t("m");
  const customer = t("c", { hosting: "customer", kind: "customer-worker", isolated: false, credentialMode: "disposable" });
  const s = { m: st(), c: st() };
  const onlyCustomer = placeRun(req({ hosting: "customer" }), [managed, customer], s);
  assert.ok(onlyCustomer.ok);
  assert.equal(onlyCustomer.target.id, "c");
  assert.deepEqual(codes(onlyCustomer, "m"), ["hosting"]);
  const managedOnly = placeRun(req({ hosting: "managed" }), [customer, managed], s);
  assert.ok(managedOnly.ok);
  assert.equal(managedOnly.target.id, "m");
  // external task: the non-isolating customer worker is rejected even though first in the list
  const iso = placeRun(req({ isolated: true }), [customer, managed], s);
  assert.ok(iso.ok);
  assert.equal(iso.target.id, "m");
  assert.deepEqual(codes(iso, "c"), ["isolation"]);
  const cred = placeRun(req({ credentials: "disposable" }), [managed, customer], s);
  assert.ok(cred.ok);
  assert.equal(cred.target.id, "c");
});

test("draining: no new work, and it is a retry, not a failure", () => {
  const ts = [t("a"), t("b")];
  const s = { a: st({ draining: true }), b: st({ live: 3 }) };
  const p = placeRun(req(), ts, s);
  assert.ok(p.ok);
  assert.equal(p.target.id, "b");
  assert.deepEqual(codes(p, "a"), ["draining"]);
  const all = refused(placeRun(req(), ts, { a: st({ draining: true }), b: st({ draining: true }) }));
  assert.equal(all.refusal, "retry-later");
  assert.equal(naiveFirstHealthy(ts, s)!.id, "a"); // negative control: naive keeps feeding the draining host
});

test("quota: per-target cap and per-project cap, each named", () => {
  const ts = [t("a", { quota: { maxRuns: 2, perProject: 1 } })];
  const full = refused(placeRun(req(), ts, { a: st({ live: 2 }) }));
  assert.equal(full.refusal, "retry-later");
  assert.match(full.reason, /2\/2 runs/);
  const proj = refused(placeRun(req({ project: "greedy" }), ts, { a: st({ live: 1, projectRuns: { greedy: 1 } }) }));
  assert.deepEqual(codes(proj, "a"), ["quota"]);
  assert.match(proj.reason, /project greedy has 1\/1/);
  // another project is unaffected by greedy's usage
  assert.ok(placeRun(req({ project: "quiet" }), ts, { a: st({ live: 1, projectRuns: { greedy: 1 } }) }).ok);
  assert.equal(naiveFirstHealthy(ts, { a: st({ live: 2 }) })!.id, "a"); // negative control
});

test("capacity: free cpu/memory/disk are checked; an oversize run is permanent, a busy host is transient", () => {
  const ts = [t("a", { cpu: 4, memMB: 4096, diskMB: 10_000 })];
  const busy = refused(placeRun(req({ cpu: 2, memMB: 2048 }), ts, { a: st({ usedCpu: 3, usedMemMB: 3000 }) }));
  assert.equal(busy.refusal, "retry-later");
  assert.deepEqual(codes(busy, "a"), ["capacity", "capacity"]);
  const huge = refused(placeRun(req({ memMB: 16_384 }), ts, { a: st() }));
  assert.equal(huge.refusal, "no-suitable-target");
  assert.deepEqual(codes(huge, "a"), ["capability"]);
  assert.ok(placeRun(req({ cpu: 1, memMB: 1024, diskMB: 1000 }), ts, { a: st({ usedCpu: 3 }) }).ok);
});

test("unhealthy and unknown-state targets are rejected (unknown is not healthy)", () => {
  const ts = [t("a"), t("b")];
  const p = placeRun(req(), ts, { a: st({ healthy: false }) });
  assert.equal(p.ok, false);
  assert.deepEqual(codes(p, "a"), ["unhealthy"]);
  assert.deepEqual(codes(p, "b"), ["unhealthy"]);
  assert.match(refused(p).reason, /no state reported/);
  assert.equal(refused(p).refusal, "retry-later");
  assert.equal(refused(placeRun(req(), [], {})).refusal, "no-suitable-target");
});

test("mixed rejection reasons: permanent on one, transient on another means retry-later; all permanent means fail", () => {
  const ts = [t("arm", { arch: "arm64" }), t("amd")];
  const mix = refused(placeRun(req({ arch: "amd64" }), ts, { arm: st(), amd: st({ draining: true }) }));
  assert.equal(mix.refusal, "retry-later");
  assert.deepEqual(codes(mix, "arm"), ["arch"]);
  assert.deepEqual(codes(mix, "amd"), ["draining"]);
  const perm = refused(placeRun(req({ arch: "arm64", browser: "headed" }), [t("amd")], { amd: st({ draining: true }) }));
  assert.equal(perm.refusal, "no-suitable-target");
});

test("snapshot restore: format, os/arch and host-locality must all match", () => {
  const snap = { format: "oci-image", os: "linux", arch: "amd64" } as const;
  const wrongFormat = t("vm", { snapshotFormats: ["vm-disk"] });
  const wrongArch = t("arm", { arch: "arm64" });
  const ok = t("ok");
  const s = { vm: st(), arm: st(), ok: st() };
  const p = placeRun(req({ restore: snap }), [wrongFormat, wrongArch, ok], s);
  assert.ok(p.ok);
  assert.equal(p.target.id, "ok");
  assert.deepEqual(codes(p, "vm"), ["snapshot-incompatible"]);
  assert.deepEqual(codes(p, "arm"), ["snapshot-incompatible"]);
  // negative control: first-healthy would restore an oci image onto the vm-disk-only target
  assert.equal(naiveFirstHealthy([wrongFormat, wrongArch, ok], s)!.id, "vm");
  // host-local snapshot: only the holder, even though another target is compatible and idle
  const local = placeRun(req({ restore: { ...snap, host: "ok2" } }), [ok, t("ok2")], { ok: st(), ok2: st({ live: 3 }) });
  assert.ok(local.ok);
  assert.equal(local.target.id, "ok2");
  // holder draining: the restore waits for it, it does not move to the other host
  const wait = refused(placeRun(req({ restore: { ...snap, host: "ok2" } }), [ok, t("ok2")], { ok: st(), ok2: st({ draining: true }) }));
  assert.equal(wait.refusal, "retry-later");
  // nothing compatible at all is a permanent refusal
  const none = refused(placeRun(req({ restore: snap }), [wrongFormat, wrongArch], s));
  assert.equal(none.refusal, "no-suitable-target");
});

test("judgeTarget reports every reason, not just the first", () => {
  const v = judgeTarget(req({ arch: "arm64", browser: "headed" }), t("x", { browser: "none" }), st({ draining: true }));
  assert.deepEqual(v.rejections.map((r) => r.code), ["arch", "capability", "draining"]);
});

// ---- host loss -------------------------------------------------------------

function run(over: Partial<RunOnHost> = {}): RunOnHost {
  return { id: "r1", targetId: "a", requirement: req(), uncommittedWork: false, restartableFromCommitted: true, ...over };
}

test("host loss with a portable snapshot recovers onto a compatible target and states what was lost", () => {
  const ts = [t("a"), t("b"), t("arm", { arch: "arm64" })];
  const s = { a: st({ healthy: false }), b: st(), arm: st() };
  const snap = { format: "oci-image", os: "linux", arch: "amd64" } as const;
  const d = onHostLoss(run({ snapshot: snap, uncommittedWork: true }), ts, s);
  assert.equal(d.action, "recover");
  assert.ok(d.action === "recover");
  assert.equal(d.target.id, "b");
  assert.equal(d.from, "snapshot");
  assert.equal(d.preserved, false);
  assert.match(d.lost[0]!, /after the last snapshot/);
  const clean = onHostLoss(run({ snapshot: snap }), ts, s);
  assert.ok(clean.action === "recover");
  assert.equal(clean.preserved, true);
  assert.deepEqual(clean.lost, []);
});

test("host loss: a snapshot held only by the lost host is gone; uncommitted work is not presented as preserved", () => {
  const ts = [t("a"), t("b")];
  const s = { a: st({ healthy: false }), b: st() };
  const local = { format: "oci-image", os: "linux", arch: "amd64", host: "a" } as const;
  // cannot restart from committed: fail, naming the loss
  const failed = onHostLoss(run({ snapshot: local, uncommittedWork: true, restartableFromCommitted: false }), ts, s);
  assert.ok(failed.action === "fail");
  assert.match(failed.reason, /with its only snapshot/);
  assert.match(failed.reason, /uncommitted working tree is gone/);
  assert.equal(failed.retryable, false);
  // no snapshot, uncommitted, not restartable: fail
  const none = onHostLoss(run({ uncommittedWork: true, restartableFromCommitted: false }), ts, s);
  assert.ok(none.action === "fail");
  assert.match(none.reason, /has no snapshot/);
  // restartable: recovers from committed state, but preserved is false and the loss is stated
  const restart = onHostLoss(run({ snapshot: local, uncommittedWork: true }), ts, s);
  assert.ok(restart.action === "recover");
  assert.equal(restart.from, "committed");
  assert.equal(restart.preserved, false);
  assert.deepEqual(restart.lost, ["uncommitted working tree on the lost host"]);
  // clean tree, all pushed: recovery loses nothing
  const clean = onHostLoss(run(), ts, s);
  assert.ok(clean.action === "recover");
  assert.equal(clean.preserved, true);
});

test("host loss never falls back to an unsuitable target", () => {
  // only an amd64 target survives; the run needs arm64
  const ts = [t("a", { arch: "arm64" }), t("b", { arch: "amd64" })];
  const s = { a: st({ healthy: false }), b: st() };
  const d = onHostLoss(run({ requirement: req({ arch: "arm64" }) }), ts, s);
  assert.ok(d.action === "fail");
  assert.match(d.reason, /needs arm64, target is amd64/);
  assert.equal(d.retryable, false);
  // snapshot incompatible with every survivor
  const snapFail = onHostLoss(run({ snapshot: { format: "vm-disk", os: "linux", arch: "amd64" } }), [t("a"), t("b")], { a: st(), b: st() });
  assert.ok(snapFail.action === "fail");
  assert.match(snapFail.reason, /snapshot cannot be restored/);
  // naive negative control: first-healthy after loss picks b, the wrong arch
  assert.equal(naiveFirstHealthy(ts, s)!.caps.arch, "amd64");
});

test("host loss with no capacity left is a retryable failure, and the lost host is excluded even if state says healthy", () => {
  const ts = [t("a"), t("b", { quota: { maxRuns: 1 } })];
  const full = onHostLoss(run(), ts, { a: st(), b: st({ live: 1 }) });
  assert.ok(full.action === "fail");
  assert.equal(full.retryable, true);
  assert.match(full.reason, /b: quota/);
  // stale state for the lost host still reads healthy: it must not be chosen
  const stale = onHostLoss(run(), [t("a"), t("b")], { a: st(), b: st({ live: 3 }) });
  assert.ok(stale.action === "recover");
  assert.equal(stale.target.id, "b");
});

// ---- conformance, against two backends of different shape -------------------

/** A Docker-like backend: Linux amd64 container, headless browser, image snapshots, long-lived static credentials. */
function fakeContainerBackend(over: { lie?: boolean } = {}): TargetAdapter {
  const declared = caps({ services: ["docker", "postgres"], snapshotFormats: ["oci-image"] });
  let accepting = true;
  return {
    declared,
    observe: async () => ({
      os: "linux",
      arch: over.lie === true ? "arm64" : "amd64",
      cpu: 8,
      memMB: 16_384,
      diskMB: 100_000,
      browser: "headless",
      desktop: false,
      services: ["docker", "postgres"],
      gpu: 0,
      mobileSim: [],
    }),
    snapshotRoundTrip: async (f) => f === "oci-image",
    drain: async () => {
      accepting = false;
      return { acceptsNew: accepting };
    },
  };
}

/** A customer's macOS VM: arm64, headed browser and desktop, iOS simulator, private LAN, disk snapshots, minted-and-revoked credentials. */
function fakeMacVmBackend(over: { reuseCredentials?: boolean; noReach?: boolean } = {}): TargetAdapter {
  const declared = caps({
    kind: "customer-worker",
    hosting: "customer",
    os: "macos",
    arch: "arm64",
    browser: "headed",
    desktop: true,
    services: [],
    hardware: { gpu: 0, mobileSim: ["ios"] },
    network: ["corp-lan"],
    snapshotFormats: ["vm-disk"],
    isolated: false,
    credentialMode: "disposable",
  });
  const live = new Set<string>();
  let n = 0;
  return {
    declared,
    observe: async () => ({ os: "macos", arch: "arm64", cpu: 10, memMB: 32_768, diskMB: 500_000, browser: "headed", desktop: true, services: [], gpu: 0, mobileSim: ["ios"] }),
    reach: async (net) => over.noReach !== true && net === "corp-lan",
    snapshotRoundTrip: async (f) => f === "vm-disk",
    drain: async () => ({ acceptsNew: false }),
    credential: {
      mint: async () => {
        const id = over.reuseCredentials === true ? "static" : `cred-${++n}`;
        live.add(id);
        return { id };
      },
      valid: async (id) => live.has(id),
      revoke: async (id) => void live.delete(id),
    },
  };
}

test("conformance: two different backends both pass honestly, with no unobservable claims", async () => {
  for (const b of [fakeContainerBackend(), fakeMacVmBackend()]) {
    const r = await conformance(b);
    assert.deepEqual(r.filter((x) => x.status !== "pass"), []);
    assert.ok(isConformant(r));
  }
  const mac = (await conformance(fakeMacVmBackend())).map((x) => x.check);
  assert.ok(mac.includes("network:corp-lan") && mac.includes("mobileSim:ios") && mac.includes("credentials:disposable") && mac.includes("snapshot:vm-disk"));
  const ctr = (await conformance(fakeContainerBackend())).map((x) => x.check);
  assert.ok(ctr.includes("service:postgres") && !ctr.some((c) => c.startsWith("network:")));
});

test("conformance negative controls: an overstated declaration fails the specific check", async () => {
  const lie = await conformance(fakeContainerBackend({ lie: true }));
  assert.deepEqual(lie.filter((x) => x.status === "fail").map((x) => x.check), ["arch"]);
  assert.equal(isConformant(lie), false);

  const noLan = await conformance(fakeMacVmBackend({ noReach: true }));
  assert.deepEqual(noLan.filter((x) => x.status === "fail").map((x) => x.check), ["network:corp-lan"]);

  const reuse = await conformance(fakeMacVmBackend({ reuseCredentials: true }));
  assert.deepEqual(reuse.filter((x) => x.status === "fail").map((x) => x.check), ["credentials:disposable"]);

  // declares a headed browser it does not have
  const base = fakeContainerBackend();
  const liar: TargetAdapter = { ...base, declared: caps({ browser: "headed", desktop: true, services: ["docker", "postgres"] }) };
  assert.deepEqual((await conformance(liar)).filter((x) => x.status === "fail").map((x) => x.check), ["browser", "desktop"]);

  // an adapter that accepts any snapshot format cannot back "snapshot-incompatible"
  const permissive: TargetAdapter = { ...fakeContainerBackend(), snapshotRoundTrip: async () => true };
  assert.deepEqual((await conformance(permissive)).filter((x) => x.status === "fail").map((x) => x.check), ["snapshot:undeclared-refused"]);

  // drain that keeps accepting work
  const leaky: TargetAdapter = { ...fakeContainerBackend(), drain: async () => ({ acceptsNew: true }) };
  assert.deepEqual((await conformance(leaky)).filter((x) => x.status === "fail").map((x) => x.check), ["draining"]);
});

test("conformance: an unobservable claim is not a pass", async () => {
  const blind: TargetAdapter = { declared: caps(), observe: async () => ({ os: "linux" }) };
  const r = await conformance(blind);
  assert.equal(r.find((x) => x.check === "os")!.status, "pass");
  assert.equal(r.find((x) => x.check === "arch")!.status, "not-observable");
  assert.equal(r.find((x) => x.check === "draining")!.status, "not-observable");
  assert.equal(isConformant(r), false);
});

test("conformed fake backends feed placement: Windows and mobile work needs a target that says so", () => {
  const container = t("ctr");
  const mac = { id: "mac", caps: caps({ os: "macos", arch: "arm64", kind: "customer-worker", hosting: "customer", hardware: { gpu: 0, mobileSim: ["ios"] }, browser: "headed", desktop: true }) };
  const s = { ctr: st(), mac: st() };
  const ios = placeRun(req({ os: "macos", mobileSim: "ios", browser: "headed" }), [container, mac], s);
  assert.ok(ios.ok);
  assert.equal(ios.target.id, "mac");
  assert.equal(refused(placeRun(req({ os: "windows" }), [container, mac], s)).refusal, "no-suitable-target");
});
