import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";

import { resolveModelId } from "./model-id.js";
import {
  MemorySegmentSink,
  MemoryToolCallJournal,
  NucleusSegmentSink,
  routedModelId,
  routingFromEnv,
  routingTaskFromEnv,
  withRoutedFallback,
} from "./model-routing-wire.js";
import type { Routing } from "./model-routing-wire.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { defaultRetryPolicy, withRetry } from "./provider.js";

const cand = (model: string, extra: Record<string, unknown> = {}) => ({
  model,
  effort: "high",
  capabilities: ["tools"],
  dataDestination: { host: "gw.internal", class: "vpc" },
  retention: "none",
  maxContext: 200_000,
  ...extra,
});

function policyFile(over: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "routing-wire-"));
  const path = join(dir, "p.json");
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      version: "v7",
      fallbackOn: ["outage", "rate-limit", "refusal"],
      roles: { worker: [cand("zai/glm-5.3"), cand("anthropic/claude-sonnet-5")] },
      ...over,
    }),
  );
  return path;
}

const ENV = (mode: string, over: Record<string, unknown> = {}): NodeJS.ProcessEnv => ({
  SHIP_MODEL_ROUTING: mode,
  SHIP_MODEL_ROUTING_POLICY: policyFile(over),
  SHIP_MODEL_ROUTING_DESTINATIONS: "class:vpc",
});

const ok = (text: string): AdapterGenerateResult =>
  ({ content: [{ type: "text", text }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null }) as AdapterGenerateResult;

function adapter(modelId: string, behave: () => AdapterGenerateResult | never): { model: ModelAdapter; calls: () => number } {
  let calls = 0;
  const model = {
    provider: "test",
    modelId,
    async doGenerate(): Promise<AdapterGenerateResult> {
      calls += 1;
      return behave();
    },
    async *doStream() {
      throw new Error("unused");
    },
  } as ModelAdapter;
  return { model, calls: () => calls };
}

const rateLimited = () => {
  throw Object.assign(new Error("slow down"), { status: 429 });
};

function routing(mode: string, over: Partial<Routing> = {}, policyOver: Record<string, unknown> = {}) {
  const sink = new MemorySegmentSink();
  const r = routingFromEnv({ env: ENV(mode, policyOver), sink, scope: `t-${Math.random()}`, now: () => new Date("2026-10-04T00:00:00Z"), ...over });
  assert.ok(r);
  return { r, sink };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// --- default-off equivalence ------------------------------------------------

test("off: routedModelId is resolveModelId, byte for byte, for every precedence input", () => {
  for (const [flag, env, config] of [
    [undefined, {}, undefined],
    ["a/b", {}, "c/d"],
    ["", { SHIP_MODEL: " e/f " }, "c/d"],
    [undefined, {}, "c/d"],
  ] as const) {
    assert.equal(routedModelId(flag, env, config, undefined), resolveModelId(flag, env, config));
  }
});

test("off: routingFromEnv is undefined even if a policy path is set; the adapter is returned untouched", () => {
  assert.equal(routingFromEnv({ env: { SHIP_MODEL_ROUTING_POLICY: policyFile() } }), undefined);
  const { model } = adapter("m", () => ok("x"));
  assert.equal(withRoutedFallback(model, undefined, "m"), model);
});

// --- loading -----------------------------------------------------------------

test("shadow with no usable policy logs and runs unrouted; on fails closed", () => {
  const lines: string[] = [];
  assert.equal(routingFromEnv({ env: { SHIP_MODEL_ROUTING: "shadow" }, log: (l) => lines.push(l) }), undefined);
  assert.match(lines.join(), /no usable policy/);
  assert.throws(() => routingFromEnv({ env: { SHIP_MODEL_ROUTING: "on" } }), /no usable policy/);
  assert.throws(
    () => routingFromEnv({ env: { SHIP_MODEL_ROUTING: "on", SHIP_MODEL_ROUTING_POLICY: "/nope.json" } }),
    /cannot read policy file/,
  );
});

// --- selection ---------------------------------------------------------------

test("shadow selection: records what the policy would choose, returns the unrouted model", async () => {
  const { r, sink } = routing("shadow");
  const id = routedModelId(undefined, { SHIP_MODEL: "other/model" }, undefined, r);
  assert.equal(id, "other/model", "shadow never changes the model");
  await settle();
  assert.equal(sink.records.length, 1);
  const rec = sink.records[0]!;
  assert.equal(rec.kind, "selection");
  assert.equal(rec.enforced, false);
  assert.equal(rec.actualModel, "other/model");
  assert.equal(rec.segment?.model, "zai/glm-5.3");
  assert.equal(rec.segment?.policyVersion, "v7");
  assert.equal(rec.policyDigest.length, 64);
});

test("on selection: the policy picks; an explicit --model still wins; refusal fails closed", async () => {
  const { r, sink } = routing("on");
  assert.equal(routedModelId(undefined, { SHIP_MODEL: "other/model" }, undefined, r), "zai/glm-5.3");
  assert.equal(routedModelId("my/flag", {}, undefined, r), "my/flag");
  await settle();
  assert.equal(sink.records[0]!.enforced, true);
  assert.equal(sink.records[1]!.enforced, false);
  assert.match(sink.records[1]!.note ?? "", /explicit/);

  // Private data and no permitted destination: nothing is eligible.
  const strict = routingFromEnv({ env: { ...ENV("on"), SHIP_MODEL_ROUTING_DESTINATIONS: "" }, sink: new MemorySegmentSink() })!;
  assert.throws(() => routedModelId(undefined, {}, undefined, strict), /refused to start/);
});

test("routingTaskFromEnv: cautious defaults, unknown-priced model reserved at the highest rate", () => {
  const t = routingTaskFromEnv({});
  assert.equal(t.dataClass, "private");
  assert.equal(t.allowedDestinations, undefined);
  assert.equal(routingTaskFromEnv({ SHIP_MODEL_ROUTING_DATA_CLASS: "bogus" }).dataClass, "private");
});

test("unknown pricing is reserved at the highest rate, and a small budget then blocks it", async () => {
  const policy = { roles: { worker: [cand("zz/never-heard-of-it")] } };
  const { r } = routing("shadow", {}, policy);
  const sink = new MemorySegmentSink();
  const loose = { ...r, sink };
  routedModelId(undefined, {}, undefined, loose);
  await settle();
  assert.equal(sink.records[0]!.segment?.pricing, "unknown-highest-rate");
  assert.ok(sink.records[0]!.segment!.reservedUSD > 0);

  const sink2 = new MemorySegmentSink();
  const tight = { ...r, sink: sink2, env: { ...r.env, SHIP_MAX_RUN_COST_USD: "0.0001" } };
  routedModelId(undefined, {}, undefined, tight);
  await settle();
  assert.match(sink2.records[0]!.refused?.join() ?? "", /budget|reserved/);
});

// --- fallback: shadow --------------------------------------------------------

test("shadow fallback: records the would-be switch and rethrows the ORIGINAL error without calling the fallback", async () => {
  const journal = new MemoryToolCallJournal();
  const { r, sink } = routing("shadow", { journal });
  let built = 0;
  r.build = () => {
    built += 1;
    return adapter("anthropic/claude-sonnet-5", () => ok("fallback")).model;
  };
  const primary = adapter("zai/glm-5.3", rateLimited);
  const wrapped = withRoutedFallback(primary.model, r, "zai/glm-5.3");
  await assert.rejects(() => wrapped.doGenerate({ messages: [] } as never), /slow down/);
  await settle();
  assert.equal(built, 0, "shadow must not build or call a fallback");
  assert.equal(primary.calls(), 1);
  const rec = sink.records[0]!;
  assert.equal(rec.kind, "fallback");
  assert.equal(rec.enforced, false);
  assert.equal(rec.failure?.class, "rate-limit");
  assert.equal(rec.failure?.trigger, "rate-limit");
  assert.equal(rec.actualModel, "zai/glm-5.3");
  assert.equal(rec.segment?.model, "anthropic/claude-sonnet-5");
  assert.equal(rec.segment?.reason, "fallback:rate-limit");
});

test("fallback is considered only after withRetry gave up (placed outside it)", async () => {
  const { r, sink } = routing("shadow", { journal: new MemoryToolCallJournal() });
  const primary = adapter("zai/glm-5.3", rateLimited);
  const retried = withRetry(primary.model, { ...defaultRetryPolicy, attempts: 3, baseDelayMs: 1, maxDelayMs: 1 }, { sleep: async () => {} });
  const wrapped = withRoutedFallback(retried, r, "zai/glm-5.3");
  await assert.rejects(() => wrapped.doGenerate({ messages: [] } as never));
  await settle();
  assert.equal(primary.calls(), 3, "all retries on the same model first");
  assert.equal(sink.records.length, 1, "one routing decision, not one per retry");
});

test("a failure that is not a trigger (auth, unknown, context-length) is never routed or recorded", async () => {
  for (const e of [Object.assign(new Error("bad key"), { status: 401 }), new Error("???"), Object.assign(new Error("too many tokens"), { status: 400 })]) {
    const { r, sink } = routing("on", { journal: new MemoryToolCallJournal() });
    let built = 0;
    r.build = () => (built++, adapter("x", () => ok("x")).model);
    const wrapped = withRoutedFallback(adapter("zai/glm-5.3", () => { throw e; }).model, r, "zai/glm-5.3");
    await assert.rejects(() => wrapped.doGenerate({ messages: [] } as never), e as Error);
    await settle();
    assert.equal(built, 0);
    assert.equal(sink.records.length, 0);
  }
});

test("a policy that does not list the trigger refuses the switch, and says so", async () => {
  const { r, sink } = routing("on", { journal: new MemoryToolCallJournal() }, { fallbackOn: ["outage"] });
  r.build = () => adapter("anthropic/claude-sonnet-5", () => ok("fallback")).model;
  const wrapped = withRoutedFallback(adapter("zai/glm-5.3", rateLimited).model, r, "zai/glm-5.3");
  await assert.rejects(() => wrapped.doGenerate({ messages: [] } as never), /slow down/);
  await settle();
  assert.match(sink.records[0]!.refused?.join() ?? "", /does not permit fallback on rate-limit/);
});

// --- fallback: on ------------------------------------------------------------

test("on: a permitted fallback is actually called, recorded as enforced, and not sticky", async () => {
  const { r, sink } = routing("on", { journal: new MemoryToolCallJournal() });
  const backup = adapter("anthropic/claude-sonnet-5", () => ok("from-backup"));
  r.build = (id) => {
    assert.equal(id, "anthropic/claude-sonnet-5");
    return backup.model;
  };
  let primaryOk = false;
  const primary = adapter("zai/glm-5.3", () => (primaryOk ? ok("from-primary") : rateLimited()));
  const wrapped = withRoutedFallback(primary.model, r, "zai/glm-5.3");
  const first = await wrapped.doGenerate({ messages: [] } as never);
  assert.equal((first.content[0] as { text: string }).text, "from-backup");
  await settle();
  assert.equal(sink.records[0]!.enforced, true);
  // The next call goes to the primary again: a shared worker adapter must not keep one run's switch.
  primaryOk = true;
  const second = await wrapped.doGenerate({ messages: [] } as never);
  assert.equal((second.content[0] as { text: string }).text, "from-primary");
});

test("an aborted call is never routed", async () => {
  const { r, sink } = routing("on", { journal: new MemoryToolCallJournal() });
  r.build = () => adapter("anthropic/claude-sonnet-5", () => ok("x")).model;
  const ctl = new AbortController();
  ctl.abort();
  const wrapped = withRoutedFallback(adapter("zai/glm-5.3", rateLimited).model, r, "zai/glm-5.3");
  await assert.rejects(() => wrapped.doGenerate({ messages: [], abortSignal: ctl.signal } as never));
  await settle();
  assert.equal(sink.records.length, 0);
});

// --- side effects ------------------------------------------------------------

test("a side effect that may have happened blocks any switch (pending write tool)", async () => {
  const journal = new MemoryToolCallJournal();
  journal.begin("bash"); // begun, never ended: did it run? unknown.
  const { r, sink } = routing("on", { journal });
  let built = 0;
  r.build = () => (built++, adapter("anthropic/claude-sonnet-5", () => ok("x")).model);
  const wrapped = withRoutedFallback(adapter("zai/glm-5.3", rateLimited).model, r, "zai/glm-5.3");
  await assert.rejects(() => wrapped.doGenerate({ messages: [] } as never), /slow down/);
  await settle();
  assert.equal(built, 0, "the other model must never be called");
  assert.match(sink.records[0]!.refused?.join() ?? "", /uncertain side effect/);
  assert.equal(sink.records[0]!.enforced, false);
});

test("a read-only or finished call does not block; unknown outcome on a write does", () => {
  const j = new MemoryToolCallJournal();
  const a = j.begin("grep");
  assert.equal(j.uncertain(), false, "read-only in flight is not uncertain");
  assert.deepEqual(j.inFlight(), { tool: "grep", sideEffect: "none" });
  j.end(a, "ok");
  const b = j.begin("edit");
  assert.equal(j.uncertain(), true);
  j.end(b, "ok");
  assert.equal(j.uncertain(), false);
  assert.equal(j.inFlight(), undefined);
  const c = j.begin("edit");
  j.end(c, "unknown");
  assert.equal(j.uncertain(), true, "an outcome we could not observe still blocks");
  assert.equal(new MemoryToolCallJournal().begin("deploy-x"), 0);
  assert.equal(j.begin("idem", "idempotent") >= 0 && j.inFlight()?.sideEffect, "idempotent");
});

test("no journal wired means unknown, and unknown is not none: switch refused, reason recorded", async () => {
  const { r, sink } = routing("on"); // no journal
  let built = 0;
  r.build = () => (built++, adapter("anthropic/claude-sonnet-5", () => ok("x")).model);
  const wrapped = withRoutedFallback(adapter("zai/glm-5.3", rateLimited).model, r, "zai/glm-5.3");
  await assert.rejects(() => wrapped.doGenerate({ messages: [] } as never), /slow down/);
  await settle();
  assert.equal(built, 0);
  assert.match(sink.records[0]!.note ?? "", /no tool-call journal/);
});

// --- gates survive the wiring ------------------------------------------------

test("a fallback whose destination is not permitted is skipped, not chosen because it is the only one up", async () => {
  const policy = {
    roles: { worker: [cand("zai/glm-5.3"), cand("anthropic/claude-sonnet-5", { dataDestination: { host: "api.example.com", class: "hosted" } })] },
  };
  const { r, sink } = routing("on", { journal: new MemoryToolCallJournal() }, policy);
  let built = 0;
  r.build = () => (built++, adapter("x", () => ok("x")).model);
  const wrapped = withRoutedFallback(adapter("zai/glm-5.3", rateLimited).model, r, "zai/glm-5.3");
  await assert.rejects(() => wrapped.doGenerate({ messages: [] } as never), /slow down/);
  await settle();
  assert.equal(built, 0);
  assert.match(sink.records[0]!.refused?.join() ?? "", /not a permitted destination/);
});

// --- recording ---------------------------------------------------------------

test("a sink that throws never fails the run", async () => {
  const lines: string[] = [];
  const { r } = routing("shadow", { journal: new MemoryToolCallJournal(), log: (l) => lines.push(l), sink: { append: async () => { throw new Error("db down"); } } });
  const wrapped = withRoutedFallback(adapter("zai/glm-5.3", rateLimited).model, r, "zai/glm-5.3");
  await assert.rejects(() => wrapped.doGenerate({ messages: [] } as never), /slow down/, "the provider's error, not the sink's");
  await settle();
  assert.match(lines.join("\n"), /could not record/);
});

test("NucleusSegmentSink is insert-only into a new table and round-trips a record", async () => {
  const statements: string[] = [];
  const stored: unknown[][] = [];
  const db = {
    async query(sql: string, params?: unknown[]) {
      statements.push(sql);
      if (sql.startsWith("INSERT")) stored.push(params!);
      if (sql.startsWith("SELECT")) return stored.map((p) => ({ payload: p[2] }));
      return [];
    },
  } as unknown as NucleusPgwire;
  const sink = new NucleusSegmentSink(db);
  const { r } = routing("shadow", { sink });
  routedModelId(undefined, {}, undefined, r);
  await settle();
  const rows = await sink.forScope(r.scope);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, "selection");
  assert.match(statements[0]!, /^CREATE TABLE IF NOT EXISTS ship_model_segments/);
  for (const s of statements) assert.doesNotMatch(s, /\b(UPDATE|DELETE|ALTER|DROP)\b/i);
});
