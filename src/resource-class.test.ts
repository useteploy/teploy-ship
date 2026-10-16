import assert from "node:assert/strict";
import { test } from "node:test";

import { sandboxOverridesOf, sandboxProvider } from "./durable.js";
import { PER_RUN_MB } from "./host-load.js";
import { resolveSandboxLimits } from "./worker.js";
import { BROWSER_MEMORY_DELTA_MB, classAwareMemoryMB, classMemoryDeltaMB, resourceClassOf, runHostMemoryMB } from "./resource-class.js";

// ---------------------------------------------------------------------------
// THE CLASS ITSELF
// ---------------------------------------------------------------------------

test("a run's class is a fact of its recorded input, and only look makes it browser", () => {
  assert.equal(resourceClassOf({ look: true }), "browser");
  assert.equal(resourceClassOf({ look: false }), "plain", "an explicit false is a plain run");
  assert.equal(resourceClassOf({}), "plain", "a pre-look log carries no look field at all");
  assert.equal(resourceClassOf(undefined), "plain");
});

test("the browser delta is the measured overhead rounded UP, never down", () => {
  // 512 MB: the top of the measured ~300-500 MB browser overhead
  // (evals/receipts/2026-10-14-egress-proxy-browser-proof.txt), rounded up to
  // the daemon's own browser quantum (SBX_SHM_MB defaults to 512 because
  // "Chromium needs 512 MB or more"). The plain run underneath is
  // docs/capacity.md's measured 350-400 MB, taken as 400. Pinning the number
  // here means nobody can quietly halve the reservation the ceiling depends on.
  assert.equal(BROWSER_MEMORY_DELTA_MB, 512);
  assert.equal(runHostMemoryMB("plain"), PER_RUN_MB, "a plain run is exactly the capacity.md per-run cost");
  assert.equal(runHostMemoryMB("browser"), PER_RUN_MB + 512, "a browser run commits the plain cost plus the browser");
  assert.equal(classMemoryDeltaMB("plain"), 0);
});

// ---------------------------------------------------------------------------
// THE FUNNEL: the class rides sandboxOverridesOf like the network tier does
// ---------------------------------------------------------------------------

test("sandboxOverridesOf carries the resource class beside the run's other overrides", () => {
  const look = sandboxOverridesOf({ task: "t", look: true } as never);
  assert.equal(look!.resourceClass, "browser");
  // Combined with the other materialised fields, on the same funnel every
  // workspace creation (sandbox, plan-restore, turn-N-restore, merge-restore)
  // passes through.
  const combined = sandboxOverridesOf({ task: "t", look: true, sandboxNetwork: "open", sandboxLimits: { memoryMb: 2048 } } as never);
  assert.equal(combined!.resourceClass, "browser");
  assert.equal(combined!.network, "open");
  assert.deepEqual(combined!.limits, { memoryMb: 2048 });
});

test("flag-off equivalence: a plain run's overrides carry no class and are shape-identical to before", () => {
  // The exact objects a plain run produced before resource classes existed.
  assert.equal(sandboxOverridesOf({ task: "t" } as never), undefined, "no overrides-worthy field, still undefined");
  const tiered = sandboxOverridesOf({ task: "t", trust: "operator", sandboxNetwork: "open" } as never);
  assert.deepEqual(tiered, { network: "open" }, "no resourceClass key appears for a plain run");
  const limited = sandboxOverridesOf({ task: "t", sandboxLimits: { memoryMb: 1024, cpus: 2 } } as never);
  assert.deepEqual(limited, { limits: { memoryMb: 1024, cpus: 2 } });
});

// ---------------------------------------------------------------------------
// CREATE LIMITS: a look run's create carries the raised limit
// ---------------------------------------------------------------------------

test("a browser run's resolved limit carries the delta on every base, a plain run's is unchanged", () => {
  const derived = { memoryMb: 1024, cpus: 2 };
  // The look run over the derived default.
  assert.deepEqual(resolveSandboxLimits({ resourceClass: "browser" }, derived), { memoryMb: 1024 + 512, cpus: 2 });
  // The look run over a project-pinned base: the delta rides on top, because
  // the browser's footprint does not care who chose the base.
  assert.deepEqual(
    resolveSandboxLimits({ resourceClass: "browser", limits: { memoryMb: 2048, pids: 256 } }, derived),
    { memoryMb: 2048 + 512, cpus: 2, pids: 256 },
  );
  // Equivalence: plain runs resolve exactly the numbers they resolved before
  // resource classes existed, pids and per-field precedence included.
  assert.deepEqual(resolveSandboxLimits(undefined, derived), derived);
  assert.deepEqual(resolveSandboxLimits({}, derived), derived);
  assert.deepEqual(resolveSandboxLimits({ limits: { memoryMb: 2048, cpus: 4, pids: 128 } }, derived), {
    memoryMb: 2048,
    cpus: 4,
    pids: 128,
  });
  assert.equal(classAwareMemoryMB(4096, "browser"), 4608, "deliberately not clamped to SANDBOX_MAX_MEMORY_MB: clamping would under-reserve");
});

test("the raised limit reaches the daemon and the class itself never does", async () => {
  // The daemon rejects unknown fields, so `resourceClass` riding the wire
  // would fail every look run's create with an unhelpful 400. limits ride as
  // they did before (B1), carrying the class-raised number.
  const bodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ runId: "sbx-1", id: "sbx-1" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const provider = sandboxProvider({ baseURL: "http://sbx", token: "t", image: "node:22", network: "allowlist", fetch: fetchImpl });

  // A look run's overrides, limits resolved as the worker resolves them.
  const lookOverrides = sandboxOverridesOf({ task: "t", look: true, sandboxLimits: { memoryMb: 1024 } } as never)!;
  await provider.create({ ...lookOverrides, limits: resolveSandboxLimits(lookOverrides, { memoryMb: 1024, cpus: 2 }) });
  assert.deepEqual(bodies[0]!.limits, { memoryMb: 1024 + 512, cpus: 2 }, "the create carries the raised limit");
  assert.ok(!("resourceClass" in bodies[0]!), "the class is placement-side only");

  // The restore path a parked look run takes goes through the same funnel.
  await provider.createFrom!("snap:1", { ...lookOverrides, limits: resolveSandboxLimits(lookOverrides, { memoryMb: 1024, cpus: 2 }) });
  assert.deepEqual(bodies[1]!.limits, { memoryMb: 1024 + 512, cpus: 2 });
  assert.ok(!("resourceClass" in bodies[1]!), "createFrom strips it the same way");

  // A plain run's create is byte-identical to before the class existed.
  const plain = sandboxOverridesOf({ task: "t", sandboxLimits: { memoryMb: 1024 } } as never)!;
  await provider.create({ ...plain, limits: resolveSandboxLimits(plain, { memoryMb: 1024, cpus: 2 }) });
  assert.deepEqual(bodies[2]!.limits, { memoryMb: 1024, cpus: 2 }, "no delta, no new keys");
  assert.ok(!("resourceClass" in bodies[2]!), "no class key on the wire for a plain run");
});
