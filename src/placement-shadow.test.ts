import assert from "node:assert/strict";
import { appendFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentExecutor } from "@neutron-build/agents";
import type { ModelAdapter } from "@neutron-build/ai";
import { MemoryEventStore, executeRun } from "@neutron-build/workflow";

import { durableAgent } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import type { RunRequirement } from "./execution-target.js";
import {
  MemoryPlacementSink,
  PlacementShadow,
  declaredRequirementFromEnv,
  declaredTargetsFromEnv,
  fileSink,
  flushPlacementShadow,
  parsePlacementRecords,
  placementShadowFromEnv,
  readPlacementSummary,
  renderPlacementReport,
  summarisePlacement,
} from "./placement-shadow.js";
import type { DeclaredTarget } from "./placement-shadow.js";
import { SandboxPool } from "./sandbox-pool.js";

/** A fake daemon: counts creates, can refuse, and can report its containers as gone. */
function daemon(name: string, options: { snapshots?: boolean } = {}) {
  let creates = 0;
  let refusing = false;
  let reaped = false;
  const provider: ExecutorProvider = {
    isolated: true,
    async create() {
      if (refusing) throw new Error(`${name} is down`);
      creates += 1;
      return { handle: `${name}-run-${creates}` };
    },
    attach(handle: string) {
      return {
        async exec() {
          if (reaped) throw new Error(`run not found: ${handle}`);
          return { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
        },
      } as unknown as AgentExecutor;
    },
    async destroy() {},
    ...(options.snapshots === true
      ? {
          async snapshot(handle: string) {
            return `${name}-snap-of-${handle}`;
          },
          async createFrom(image: string) {
            creates += 1;
            return { handle: `${name}-from-${image}` };
          },
        }
      : {}),
  };
  return { provider, refuse: (on: boolean) => (refusing = on), reap: () => (reaped = true) };
}

interface Fleet {
  pool: SandboxPool;
  sink: MemoryPlacementSink;
  daemons: ReturnType<typeof daemon>[];
}

function fleet(
  declared: Array<DeclaredTarget | undefined>,
  options: { require?: Partial<RunRequirement>; draining?: string[]; snapshots?: boolean } = {},
): Fleet {
  const sink = new MemoryPlacementSink();
  const daemons = declared.map((_, i) => daemon(`h${i}`, { snapshots: options.snapshots === true }));
  const urls = declared.map((_, i) => `http://h${i}:7439`);
  const shadow = new PlacementShadow({
    sink,
    declared: Object.fromEntries(declared.flatMap((d, i) => (d === undefined ? [] : [[urls[i]!, d]]))),
    ...(options.require !== undefined ? { require: options.require } : {}),
    ...(options.draining !== undefined ? { draining: options.draining } : {}),
  });
  const pool = new SandboxPool({ hosts: daemons.map((d, i) => ({ url: urls[i]!, provider: d.provider })), placementShadow: shadow });
  return { pool, sink, daemons };
}

const last = (f: Fleet) => f.sink.records[f.sink.records.length - 1]!;
const wouldTarget = (r: { would?: { ok: boolean; target?: string } }) => (r.would?.ok === true ? r.would.target : undefined);

// ---- the naive first-healthy / least-loaded choice, run through the real pool -------

test("arch: the pool picks the idle amd64 host for an arm64 run; the shadow disagrees and names the arm64 host", async () => {
  const f = fleet([{ arch: "amd64" }, { arch: "arm64" }], { require: { arch: "arm64" } });
  const { handle } = await f.pool.create();
  await flushPlacementShadow();
  assert.equal(handle.startsWith("0@"), true, "the pool's choice is untouched");
  const r = last(f);
  assert.equal(r.disagreement, "chosen-unsuitable");
  assert.deepEqual(r.chosenRejections?.map((x) => x.code), ["arch"]);
  assert.equal(wouldTarget(r), "http://h1:7439");
});

test("arch: agreement when the pool's host is the arm64 one (the shadow is not just always disagreeing)", async () => {
  const f = fleet([{ arch: "arm64" }, { arch: "amd64" }], { require: { arch: "arm64" } });
  await f.pool.create();
  await flushPlacementShadow();
  assert.equal(last(f).disagreement, null);
});

test("an undeclared host has unknown arch: a requirement naming one is not met by it; no requirement means no disagreement", async () => {
  const named = fleet([undefined], { require: { arch: "amd64" } });
  await named.pool.create();
  const none = fleet([undefined]);
  await none.pool.create();
  await flushPlacementShadow();
  assert.equal(last(named).disagreement, "chosen-unsuitable");
  assert.equal(last(named).would?.ok, false);
  assert.equal(last(none).disagreement, null);
  assert.deepEqual(last(none).defaulted, ["os=linux", "project=(unknown)"], "what was defaulted is stated, not hidden");
});

test("browser: a headed-browser run on a pool that picks the browserless host first", async () => {
  const f = fleet([{ arch: "amd64", browser: "none" }, { arch: "amd64", browser: "headed" }], { require: { browser: "headed" } });
  await f.pool.create();
  await flushPlacementShadow();
  const r = last(f);
  assert.equal(r.disagreement, "chosen-unsuitable");
  assert.match(String(r.chosenRejections?.[0]?.detail), /needs headed browser, target has none/);
  assert.equal(wouldTarget(r), "http://h1:7439");
});

test("draining: the pool has no drain concept, so it places on a draining host; the shadow flags it", async () => {
  const declared = fleet([{ draining: true }, {}]);
  await declared.pool.create();
  const option = fleet([{}, {}], { draining: ["http://h0:7439/"] });
  await option.pool.create();
  await flushPlacementShadow();
  for (const f of [declared, option]) {
    assert.equal(last(f).disagreement, "chosen-unsuitable");
    assert.deepEqual(last(f).chosenRejections?.map((x) => x.code), ["draining"]);
    assert.equal(wouldTarget(last(f)), "http://h1:7439");
  }
});

test("quota: least-loaded still lands on a host at its declared run cap", async () => {
  const f = fleet([{ quota: { maxRuns: 1 } }, { quota: { maxRuns: 5 } }]);
  await f.pool.create(); // h0 (tie -> first)
  await f.pool.create(); // h1 (least loaded)
  await f.pool.create(); // h0 again (tie) but h0 is at 1/1
  await flushPlacementShadow();
  assert.deepEqual(f.sink.records.map((r) => r.disagreement), [null, null, "chosen-unsuitable"]);
  assert.deepEqual(last(f).chosenRejections?.map((x) => x.code), ["quota"]);
  assert.equal(wouldTarget(last(f)), "http://h1:7439");
});

test("per-project quota counts this pool's live runs per project and drops them on destroy", async () => {
  const f = fleet([{ quota: { maxRuns: 9, perProject: 1 } }]);
  const ov = { warm: { repo: "acme/web" } };
  const first = await f.pool.create(ov);
  await f.pool.create(ov);
  await f.pool.destroy(first.handle);
  await f.pool.create(ov);
  await f.pool.create({ warm: { repo: "acme/other" } });
  await flushPlacementShadow();
  assert.deepEqual(f.sink.records.map((r) => r.disagreement), [null, "chosen-unsuitable", "chosen-unsuitable", null]);
  assert.match(String(f.sink.records[1]!.chosenRejections?.[0]?.detail), /project acme\/web has 1\/1/);
  assert.equal(f.sink.records[3]!.requirement.project, "acme/other");
});

test("cooldown: a host placed on during the cooling pass is recorded as unhealthy", async () => {
  const f = fleet([{}, {}]);
  f.daemons[0]!.refuse(true);
  f.daemons[1]!.refuse(true);
  await assert.rejects(f.pool.create(), /no sandbox host could start a sandbox/);
  f.daemons[0]!.refuse(false);
  await f.pool.create();
  await flushPlacementShadow();
  assert.equal(f.sink.records.length, 1, "a create that failed everywhere records nothing");
  assert.equal(last(f).disagreement, "chosen-unsuitable");
  assert.deepEqual(last(f).chosenRejections?.map((x) => x.code), ["unhealthy"]);
});

test("failover: the host that finally took the run is the one judged (benign different-choice)", async () => {
  const f = fleet([{}, {}]);
  f.daemons[0]!.refuse(true);
  const { handle } = await f.pool.create();
  await flushPlacementShadow();
  assert.equal(handle.startsWith("1@"), true);
  assert.equal(last(f).host, "http://h1:7439");
  assert.equal(last(f).disagreement, "different-choice", "placeRun would have tried h0 first; the difference is the failover itself, and it is recorded as such");
  assert.equal(wouldTarget(last(f)), "http://h0:7439");
});

test("createFrom: a restore onto a draining snapshot host is flagged; one onto a healthy host is not", async () => {
  const f = fleet([{ draining: true }, {}], { snapshots: true });
  await f.pool.createFrom!("0@snap-a");
  await f.pool.createFrom!("1@snap-b");
  await flushPlacementShadow();
  assert.deepEqual(f.sink.records.map((r) => [r.point, r.disagreement]), [["createFrom", "chosen-unsuitable"], ["createFrom", null]]);
  assert.equal(f.sink.records[0]!.would?.ok, false);
});

// ---- host loss -----------------------------------------------------------------------

test("observeHostLoss: records both bounds and never claims preservation it cannot show", async () => {
  const f = fleet([{}, {}]);
  const { handle } = await f.pool.create();
  f.pool.observeHostLoss(handle);
  await flushPlacementShadow();
  const r = f.sink.records[1]!;
  assert.equal(r.point, "host-loss");
  assert.equal(r.host, "http://h0:7439");
  assert.equal(r.hostLoss?.ifClean.action, "recover");
  assert.equal(r.hostLoss?.ifClean.action === "recover" && r.hostLoss.ifClean.target.id, "http://h1:7439");
  assert.deepEqual(r.hostLoss?.ifDirty, {
    action: "fail",
    reason: "host http://h0:7439 was lost and the run has no snapshot; the uncommitted working tree is gone and the run cannot restart from its committed state",
    retryable: false,
  });
  assert.equal(r.disagreement, "would-recover");
  assert.equal(r.hostLoss?.hostHealthyPerPool, true, "a healthy host with a dead container looks like TTL expiry, and is labelled as such");
});

test("observeHostLoss on a one-host pool: nothing to recover onto, so no disagreement", async () => {
  const f = fleet([{}]);
  const { handle } = await f.pool.create();
  f.pool.observeHostLoss(handle);
  await flushPlacementShadow();
  const r = last(f);
  assert.equal(r.disagreement, null);
  assert.equal(r.hostLoss?.ifClean.action, "fail");
});

test("the real C5 path: a failed liveness probe is reported to the pool, and the run still fails exactly as before", async () => {
  const f = fleet([{}, {}]);
  f.daemons[0]!.reap();
  const model = {
    provider: "t",
    modelId: "t",
    async doGenerate() {
      throw new Error("model must not be reached");
    },
  } as unknown as ModelAdapter;
  const wf = durableAgent({ model, executor: f.pool });
  const out = await executeRun({ workflow: wf, runId: "run-hostloss", store: new MemoryEventStore(), input: { task: "x" } });
  await flushPlacementShadow();
  assert.equal(out.status, "failed");
  assert.match(String(out.error?.detail ?? ""), /\(0@h0-run-1\) is no longer available/);
  assert.deepEqual(f.sink.records.map((r) => r.point), ["create", "host-loss"]);
  assert.equal(f.sink.records[1]!.hostLoss?.ifClean.action, "recover");
});

// ---- off / equivalence ---------------------------------------------------------------

test("shadow on or off, the pool places identically (handles, order, failover)", async () => {
  const script = async (pool: SandboxPool, ds: ReturnType<typeof daemon>[]) => {
    const out: string[] = [];
    out.push((await pool.create()).handle);
    out.push((await pool.create()).handle);
    ds[0]!.refuse(true);
    out.push((await pool.create()).handle);
    out.push(JSON.stringify(pool.state()));
    return out;
  };
  const on = fleet([{ arch: "amd64", draining: true }, { arch: "arm64" }], { require: { arch: "arm64", browser: "headed" } });
  const offDaemons = [daemon("h0"), daemon("h1")];
  const off = new SandboxPool({ hosts: offDaemons.map((d, i) => ({ url: `http://h${i}:7439`, provider: d.provider })) });
  assert.deepEqual(await script(on.pool, on.daemons), await script(off, offDaemons));
});

test("with no shadow the pool has no bookkeeping and observeHostLoss does nothing", async () => {
  const d = daemon("h0");
  const pool = new SandboxPool({ hosts: [{ url: "http://h0:7439", provider: d.provider }] });
  const { handle } = await pool.create({ warm: { repo: "acme/web" } });
  pool.observeHostLoss(handle);
  await pool.destroy(handle);
  assert.equal(pool.state()[0]!.live, 0);
});

test("a sink that throws cannot fail a placement", async () => {
  const logs: string[] = [];
  const shadow = new PlacementShadow({
    sink: {
      append: async () => {
        throw new Error("disk full");
      },
    },
    log: (l) => logs.push(l),
  });
  const d = daemon("h0");
  const pool = new SandboxPool({ hosts: [{ url: "http://h0:7439", provider: d.provider }], placementShadow: shadow });
  assert.equal((await pool.create()).handle, "0@h0-run-1");
  await flushPlacementShadow();
  assert.ok(logs.some((l) => /could not record: disk full/.test(l)));
});

test("SHIP_PLACEMENT: only 'shadow' turns it on; anything else is off and says so", () => {
  const log: string[] = [];
  assert.equal(placementShadowFromEnv({}, (l) => log.push(l)), undefined);
  assert.equal(placementShadowFromEnv({ SHIP_PLACEMENT: "off" }, (l) => log.push(l)), undefined);
  assert.equal(log.length, 0);
  assert.equal(placementShadowFromEnv({ SHIP_PLACEMENT: "on" }, (l) => log.push(l)), undefined);
  assert.match(log[0]!, /only "shadow" exists/);
  assert.ok(placementShadowFromEnv({ SHIP_PLACEMENT: "Shadow", SHIP_PLACEMENT_SHADOW_FILE: "/dev/null" }) !== undefined);
});

test("declared config: malformed JSON, wrong types and unknown keys fall back to conservative defaults", () => {
  const log: string[] = [];
  assert.deepEqual(declaredTargetsFromEnv({ SHIP_PLACEMENT_TARGETS: "{nope" }, (l) => log.push(l)), {});
  assert.match(log[0]!, /not valid JSON/);
  const t = declaredTargetsFromEnv({
    SHIP_PLACEMENT_TARGETS: JSON.stringify({ "http://a:1/": { arch: "sparc", browser: "headed", cpu: -3, quota: { maxRuns: 2 }, bogus: 1, services: ["pg", 4] } }),
  });
  assert.deepEqual(t, { "http://a:1": { browser: "headed", quota: { maxRuns: 2 } } });
  assert.deepEqual(declaredRequirementFromEnv({ SHIP_PLACEMENT_REQUIRE: JSON.stringify({ arch: "arm64", browser: "none", gpu: 1, x: 1 }) }), { arch: "arm64", gpu: 1 });
});

// ---- file + report -------------------------------------------------------------------

test("records land in JSONL and the report counts disagreements; a missing file is unknown, not zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "placement-shadow-"));
  const file = join(dir, "nested", "placement-shadow.jsonl");
  const missing = await readPlacementSummary(file);
  assert.equal(missing.fileFound, false);
  assert.match(renderPlacementReport(missing, file), /unknown, not zero disagreements/);

  const shadow = new PlacementShadow({
    sink: fileSink(file),
    declared: { "http://h0:7439": { arch: "amd64" }, "http://h1:7439": { arch: "arm64" } },
    require: { arch: "arm64" },
  });
  const ds = [daemon("h0"), daemon("h1")];
  const pool = new SandboxPool({ hosts: ds.map((d, i) => ({ url: `http://h${i}:7439`, provider: d.provider })), placementShadow: shadow });
  await pool.create();
  await pool.create();
  await flushPlacementShadow();
  await appendFile(file, "not json\n");
  const s = await readPlacementSummary(file);
  assert.equal(s.records, 2);
  assert.equal(s.malformedLines, 1);
  assert.equal(s.disagreements, 1);
  assert.deepEqual(s.byRejection, { arch: 1 });
  assert.match(renderPlacementReport(s, file), /1x chosen-unsuitable \(create\) on http:\/\/h0:7439/);
  assert.equal(parsePlacementRecords("").records.length, 0);
  assert.equal(summarisePlacement([]).disagreements, 0);
});
