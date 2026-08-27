import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import { MemoryEventStore, executeRun } from "@neutron-build/workflow";

import { durableAgent } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import { FINDINGS_MARKER } from "./findings.js";
import type { ScanFinding } from "./findings.js";
import { DailyBudgetExceededError, assertDailyBudget, enqueueRun } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";
import { FileSpendStore } from "./spend.js";
import type { SpendStore } from "./spend.js";

/**
 * L2 / D3 — scan mode.
 *
 * Its own file rather than more of durable.test.ts: the four properties under
 * test here (no publish, findings recorded as run data, the flags a scan
 * suppresses, and the enqueue budget) cut across durable.ts, runtime.ts and
 * spend.ts, and reading them together is the point.
 */

function scriptedModel(turns: string[]): { model: ModelAdapter; calls: () => number } {
  let index = 0;
  let calls = 0;
  return {
    calls: () => calls,
    model: {
      provider: "scripted",
      modelId: "s1",
      async doGenerate(): Promise<AdapterGenerateResult> {
        calls++;
        const text = turns[index++] ?? "```finish\nout of script\n```";
        return { content: [{ type: "text", text }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
      },
      async *doStream() {
        throw new Error("unused");
      },
    },
  };
}

/** A bare file:// remote, plus a fetch that FAILS the test if a PR is opened. */
async function scanRepo(name: string): Promise<{ repo: string; provider: ExecutorProvider; calls: string[]; restore: () => void }> {
  const bareDir = await mkdtemp(join(tmpdir(), `scan-${name}-bare-`));
  const seedDir = await mkdtemp(join(tmpdir(), `scan-${name}-seed-`));
  const seeder = new LocalExecutor({ root: seedDir });
  await seeder.exec(
    `git init -q -b main . && git config user.email t@t && git config user.name t && printf 'hello\\n' > f.txt && git add -A && git commit -qm seed && git clone -q --bare . ${bareDir}/owner/repo.git`,
  );
  const work = await mkdtemp(join(tmpdir(), `scan-${name}-work-`));
  const calls: string[] = [];
  const orig = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = (url: unknown, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ number: 1, html_url: "http://example/pulls/1", body: "" }) });
  };
  return {
    repo: `file://${bareDir}/owner/repo.git`,
    calls,
    provider: {
      async create() {
        return { handle: work };
      },
      attach(handle: string) {
        return new LocalExecutor({ root: handle });
      },
    },
    restore: () => {
      globalThis.fetch = orig;
    },
  };
}

const FINDINGS = `[{"title":"password is hardcoded","severity":"high","file":"f.txt","line":1,"detail":"the literal is committed","fix":"read it from the environment"}]`;

test("a scan run publishes NOTHING, and records its findings as run data", async () => {
  const fixture = await scanRepo("publish");
  try {
    // The scan tries to edit anyway — five of the seven 2026-08-26 nightly
    // scans did exactly this — and is refused by the loop.
    const { model } = scriptedModel([
      "```bash\ncat f.txt\n```",
      "```create f.txt\nfixed\n```",
      `\`\`\`finish\nOne real issue.\n\n${FINDINGS_MARKER}\n${FINDINGS}\n\`\`\``,
    ]);
    const wf = durableAgent({ model, executor: fixture.provider });
    const store = new MemoryEventStore();
    const outcome = await executeRun({
      workflow: wf,
      runId: "run-scan-1",
      store,
      input: { task: "audit this repo", repo: fixture.repo, mode: "scan" },
    });
    assert.equal(outcome.status, "completed");

    const steps = (await store.load("run-scan-1")).filter((e) => e.type === "step-completed").map((e) => e.name);
    // The publish gate must not RUN, not merely produce nothing: no push step,
    // no PR step, no memory note, no test run.
    for (const forbidden of ["repo-push", "repo-pr", "repo-memory", "tests", "change-class"]) {
      assert.ok(!steps.includes(forbidden), `a scan must not record a ${forbidden} step; got ${steps.join(", ")}`);
    }
    assert.deepEqual(fixture.calls, [], "a scan must not touch the forge API");
    assert.ok(steps.includes("scan-findings"), `findings must be a recorded step; got ${steps.join(", ")}`);

    const output = outcome.output as { pr?: string; findings?: ScanFinding[] };
    assert.equal(output.pr, undefined, "no pull request");
    assert.deepEqual(output.findings, [
      { title: "password is hardcoded", severity: "high", file: "f.txt", line: 1, detail: "the literal is committed", fix: "read it from the environment" },
    ]);

    // The ```create was refused in the loop, so it never became a step either.
    assert.ok(!steps.includes("turn-1-exec"), `a refused edit records no exec step; got ${steps.join(", ")}`);
  } finally {
    fixture.restore();
  }
});

test("a scan whose finish carries no findings is sent back once, then honoured", async () => {
  const fixture = await scanRepo("nudge");
  try {
    const { model } = scriptedModel([
      "```bash\ncat f.txt\n```",
      "```finish\nI found a hardcoded password and a curl-pipe-bash installer.\n```",
      `\`\`\`finish\nOne real issue.\n\n${FINDINGS_MARKER}\n${FINDINGS}\n\`\`\``,
    ]);
    const wf = durableAgent({ model, executor: fixture.provider });
    const store = new MemoryEventStore();
    const outcome = await executeRun({
      workflow: wf,
      runId: "run-scan-2",
      store,
      input: { task: "audit", repo: fixture.repo, mode: "scan" },
    });
    const output = outcome.output as { turns: number; findings?: ScanFinding[] };
    assert.equal(output.turns, 3, "the empty finish was held and the run continued");
    assert.equal(output.findings?.length, 1);
  } finally {
    fixture.restore();
  }
});

test('a scan that reports "nothing found" is honoured immediately — [] is an answer', async () => {
  const fixture = await scanRepo("clean");
  try {
    const { model } = scriptedModel([
      "```bash\ncat f.txt\n```",
      `\`\`\`finish\nNothing worth reporting.\n\n${FINDINGS_MARKER}\n[]\n\`\`\``,
      "```bash\necho the run should never reach this turn\n```",
    ]);
    const wf = durableAgent({ model, executor: fixture.provider });
    const store = new MemoryEventStore();
    const outcome = await executeRun({
      workflow: wf,
      runId: "run-scan-3",
      store,
      input: { task: "audit", repo: fixture.repo, mode: "scan" },
    });
    const output = outcome.output as { turns: number; findings?: ScanFinding[] };
    assert.equal(output.turns, 2, "an explicit empty array finishes the scan");
    assert.deepEqual(output.findings, []);
  } finally {
    fixture.restore();
  }
});

test("REPLAY: a recorded scan replays through the same step sequence with no model or executor calls", async () => {
  // The sharpest constraint in this repo. A scan log's steps are a strict
  // subset of a fix run's, so the risk is the other direction: a replay that
  // decides to publish would request steps the log does not contain.
  const fixture = await scanRepo("replay");
  try {
    const { model, calls } = scriptedModel([
      "```bash\ncat f.txt\n```",
      `\`\`\`finish\nDone.\n\n${FINDINGS_MARKER}\n${FINDINGS}\n\`\`\``,
    ]);
    const wf = durableAgent({ model, executor: fixture.provider });
    const store = new MemoryEventStore();
    const first = await executeRun({ workflow: wf, runId: "run-scan-4", store, input: { task: "audit", repo: fixture.repo, mode: "scan" } });
    const callsAfter = calls();
    const stepsAfter = (await store.load("run-scan-4")).filter((e) => e.type === "step-completed").map((e) => e.name);

    const again = await executeRun({ workflow: wf, runId: "run-scan-4", store, input: { task: "audit", repo: fixture.repo, mode: "scan" } });
    assert.equal(again.status, "completed");
    assert.deepEqual(again.output, first.output, "the replayed output must equal the recorded output");
    assert.equal(calls(), callsAfter, "the model must not be re-called on replay");
    assert.deepEqual(
      (await store.load("run-scan-4")).filter((e) => e.type === "step-completed").map((e) => e.name),
      stepsAfter,
      "the step sequence must be unchanged",
    );
  } finally {
    fixture.restore();
  }
});

/** Capture-only runtime: enqueueRun touches store.append, saveMeta and kind. */
function captureRuntime(spend?: SpendStore): { runtime: ShipRuntime; inputs: Array<Record<string, unknown>> } {
  const inputs: Array<Record<string, unknown>> = [];
  const runtime = {
    kind: "file",
    ...(spend !== undefined ? { spend } : {}),
    evidence: { forRepo: async () => ({ repo: "owner/repo", testCommand: "pnpm test", observeService: "svc" }) },
    projects: { forRepo: async () => null },
    policies: { list: async () => [] },
    governance: { get: async () => ({ authority: {}, windows: {}, reviewers: [] }) },
    store: {
      append: async (_runId: string, event: { type: string; data?: { input?: Record<string, unknown> } }) => {
        if (event.type === "run-started") inputs.push(event.data!.input!);
      },
    },
    saveMeta: async () => {},
  } as unknown as ShipRuntime;
  return { runtime, inputs };
}

test("enqueueRun materialises mode:scan and suppresses every flag that is about a CHANGE", async () => {
  const { runtime, inputs } = captureRuntime();
  // Deliberately hostile environment: every change-shaped feature switched on.
  const env = { SHIP_TESTS: "1", SHIP_TELEMETRY: "1", SHIP_PREVIEW: "1", SHIP_CHANGE_CLASS: "1", SHIP_SETTLE: "1" };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    await enqueueRun(runtime, {
      runId: "run-s1",
      task: "audit",
      model: "m",
      repo: "https://git.example.com/owner/repo",
      mode: "scan",
      // Even asked for explicitly, these are dropped: a scan reviews no diff
      // and parks on no plan.
      plan: true,
      critic: true,
    });
    await enqueueRun(runtime, { runId: "run-f1", task: "fix it", model: "m", repo: "https://git.example.com/owner/repo" });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  const scan = inputs[0]!;
  assert.equal(scan.mode, "scan");
  for (const flag of ["tests", "testsFeedback", "telemetry", "preview", "changeClass", "requireEdit", "plan", "critic", "settle"]) {
    assert.equal(scan[flag], undefined, `${flag} must be absent from a scan's recorded input`);
  }
  // Absent, not false: presence is what gates step sequences, and a scan log
  // must look to a replay exactly like a run that never asked for the step.
  assert.ok(!Object.hasOwn(scan, "requireEdit"));

  const fix = inputs[1]!;
  assert.equal(fix.mode, undefined, "an ordinary run records no mode, so old logs are unchanged");
  assert.equal(fix.tests, true, "the same environment still turns the change-shaped features on for a fix run");
  assert.equal(fix.requireEdit, true);
});

/** A spend store that counts what the budget check does to the ledger. */
function countingSpend(): { store: SpendStore; reserves: string[]; releases: string[]; settled: Map<string, number> } {
  const reserves: string[] = [];
  const releases: string[] = [];
  const holds = new Map<string, { source: string; day: string; amountUSD: number }>();
  const settled = new Map<string, number>();
  return {
    reserves,
    releases,
    settled,
    store: {
      async add(source, day, amountUSD) {
        settled.set(`${day} ${source}`, (settled.get(`${day} ${source}`) ?? 0) + amountUSD);
      },
      async get(source, day) {
        let total = settled.get(`${day} ${source}`) ?? 0;
        for (const h of holds.values()) if (h.source === source && h.day === day) total += h.amountUSD;
        return total;
      },
      async list() {
        return [];
      },
      async reserve(id, source, day, amountUSD) {
        reserves.push(id);
        holds.set(id, { source, day, amountUSD });
      },
      async release(id) {
        releases.push(id);
        holds.delete(id);
      },
      async held(id) {
        return holds.has(id);
      },
    },
  };
}

test("enqueueRun is subject to the per-source daily cap — the bypass that cost $24 in one night", async () => {
  const spend = countingSpend();
  const { runtime, inputs } = captureRuntime(spend.store);
  const saved = process.env.SHIP_DAILY_BUDGET_USD;
  process.env.SHIP_DAILY_BUDGET_USD = "1";
  try {
    // $0.90 already spent today, and one run is estimated at $0.50.
    await spend.store.add("scan", new Date().toISOString().slice(0, 10), 0.9);
    await assert.rejects(
      () => enqueueRun(runtime, { runId: "run-b1", task: "audit", model: "m", source: "scan", mode: "scan" }),
      (error: unknown) => {
        assert.ok(error instanceof DailyBudgetExceededError);
        assert.equal(error.source, "scan");
        assert.equal(error.budgetUSD, 1);
        return true;
      },
    );
    assert.deepEqual(inputs, [], "the run must not exist: a refusal after store.append leaves a ghost run");
    assert.deepEqual(spend.releases, ["run-b1"], "the refused hold is given back");
  } finally {
    if (saved === undefined) delete process.env.SHIP_DAILY_BUDGET_USD;
    else process.env.SHIP_DAILY_BUDGET_USD = saved;
  }
});

test("an enqueue under the cap passes, and holds exactly one estimate", async () => {
  const spend = countingSpend();
  const { runtime, inputs } = captureRuntime(spend.store);
  const saved = process.env.SHIP_DAILY_BUDGET_USD;
  process.env.SHIP_DAILY_BUDGET_USD = "10";
  try {
    await enqueueRun(runtime, { runId: "run-b2", task: "audit", model: "m", source: "scan", mode: "scan" });
    assert.equal(inputs.length, 1);
    assert.deepEqual(spend.reserves, ["run-b2"]);
    assert.deepEqual(spend.releases, [], "the hold stands until the worker settles the run");
  } finally {
    if (saved === undefined) delete process.env.SHIP_DAILY_BUDGET_USD;
    else process.env.SHIP_DAILY_BUDGET_USD = saved;
  }
});

test("the intake sweep's reservation is NOT double-counted, and its admission is not re-decided", async () => {
  // sweepIntake reserves under the runId at worker.ts:286 and then calls
  // enqueueRun with that same runId through its `launch` callback. Both halves
  // matter: the ledger must not move, and the check must not throw — a refusal
  // inside `launch` propagates out of the worker tick.
  const spend = countingSpend();
  const { runtime, inputs } = captureRuntime(spend.store);
  const saved = process.env.SHIP_DAILY_BUDGET_USD;
  process.env.SHIP_DAILY_BUDGET_USD = "1";
  const day = new Date().toISOString().slice(0, 10);
  try {
    await spend.store.add("forgejo", day, 0.9);
    await spend.store.reserve("run-b3", "forgejo", day, 0.5); // the sweep admitted it
    const before = await spend.store.get("forgejo", day);
    await enqueueRun(runtime, { runId: "run-b3", task: "fix", model: "m", source: "forgejo" });
    assert.equal(inputs.length, 1, "an already-admitted run is enqueued, not re-judged");
    assert.equal(await spend.store.get("forgejo", day), before, "the ledger must not move");
    assert.deepEqual(spend.reserves, ["run-b3"], "no second reservation");
  } finally {
    if (saved === undefined) delete process.env.SHIP_DAILY_BUDGET_USD;
    else process.env.SHIP_DAILY_BUDGET_USD = saved;
  }
});

test("reserve is idempotent by id, so even a store without held() cannot double-count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scan-spend-"));
  const store = new FileSpendStore(dir);
  await store.reserve("run-x", "scan", "2026-08-26", 0.5);
  await store.reserve("run-x", "scan", "2026-08-26", 0.5);
  assert.equal(await store.get("scan", "2026-08-26"), 0.5);
  await store.release("run-x");
  assert.equal(await store.get("scan", "2026-08-26"), 0);
});

test("an unsourced run is not held against a budget — nothing would ever release it", async () => {
  // worker.ts:617 returns early on a run with no source, so it is never
  // settled either; holding an estimate for one would leak it for a day.
  const spend = countingSpend();
  const { runtime } = captureRuntime(spend.store);
  await assertDailyBudget(runtime, { runId: "run-b4" });
  assert.deepEqual(spend.reserves, []);
});

test("a cap of 0 disables the check, exactly as it does in the worker", async () => {
  const spend = countingSpend();
  const { runtime } = captureRuntime(spend.store);
  const saved = process.env.SHIP_DAILY_BUDGET_USD;
  process.env.SHIP_DAILY_BUDGET_USD = "0";
  try {
    await spend.store.add("scan", new Date().toISOString().slice(0, 10), 1000);
    await assertDailyBudget(runtime, { runId: "run-b5", source: "scan" });
    assert.deepEqual(spend.reserves, []);
  } finally {
    if (saved === undefined) delete process.env.SHIP_DAILY_BUDGET_USD;
    else process.env.SHIP_DAILY_BUDGET_USD = saved;
  }
});
