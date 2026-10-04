import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import type { AgentExecutor } from "@neutron-build/agents";
import { MemoryEventStore, deliverEvent, executeRun } from "@neutron-build/workflow";

import { PLAN_EVENT, durableAgent } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";

/**
 * S07 wiring, advisory. Every case here drives the REAL plan-park path —
 * durableAgent, a scripted model, `plan: true`, the park on PLAN_EVENT — with
 * the workspace backed by a real git repository read through a real
 * LocalExecutor, the same way a run's checkout is read. There is no mock of
 * git and no shortcut around the park emission.
 */

const GIT = ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false"];
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [...GIT, ...args], { cwd, encoding: "utf8" }).trim();
}

const TREE = {
  "package.json": JSON.stringify({ name: "x", scripts: { build: "tsc", test: "node --test" } }),
  "src/billing/invoice.ts": "export function computeProration(a: number) { return a; }\n",
  "src/index.ts": "export const x = 1;\n",
};

/** A real committed tree; the workspace executor runs inside it. */
async function repoWorkspace(tree: Record<string, string>): Promise<{
  root: string;
  sha: string;
  provider: ExecutorProvider;
  execCount: () => number;
  done: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "plan-grounding-park-"));
  git(root, "init", "-q", "-b", "main");
  for (const [p, text] of Object.entries(tree)) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), text);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const sha = git(root, "rev-parse", "HEAD");
  let execs = 0;
  const attach = (): AgentExecutor => {
    const inner = new LocalExecutor({ root });
    return {
      async exec(cmd, opts) {
        execs++;
        return inner.exec(cmd, opts);
      },
      putFile: (p, d) => inner.putFile(p, d),
      getFile: (p) => inner.getFile(p),
      destroy: () => inner.destroy(),
    };
  };
  const shared = attach();
  return {
    root,
    sha,
    execCount: () => execs,
    provider: {
      async create() {
        return { handle: root };
      },
      attach() {
        return shared;
      },
    },
    done: () => rm(root, { recursive: true, force: true }),
  };
}

// A model that reacts to the last observation (durable.test.ts's shape), so
// the run can be driven past the park and through the finish gate.
function reactiveModel(turns: Array<string | ((obs: string) => string)>): { model: ModelAdapter; callCount: () => number } {
  let index = 0;
  let calls = 0;
  return {
    callCount: () => calls,
    model: {
      provider: "scripted",
      modelId: "s1",
      async doGenerate(options): Promise<AdapterGenerateResult> {
        calls++;
        const lastUser = [...options.messages].reverse().find((m) => m.role === "user");
        const obs = typeof lastUser?.content === "string" ? lastUser.content : "";
        const turn = turns[index++] ?? "```finish\nout of script\n```";
        const text = typeof turn === "function" ? turn(obs) : turn;
        return { content: [{ type: "text", text }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
      },
      async *doStream() {
        throw new Error("unused");
      },
    },
  };
}

const FLAG = "SHIP_PLAN_GROUNDING";
async function withFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env[FLAG];
    else process.env[FLAG] = before;
  }
}

type Logged = { type: string; name?: string; data?: unknown };

async function planStepOf(store: MemoryEventStore, runId: string): Promise<{ result: Record<string, unknown>; names: string[] }> {
  const events: Logged[] = await store.load(runId);
  const step = events.find((e) => e.type === "step-completed" && e.name === "plan-think");
  assert.ok(step, "no plan-think step");
  return {
    result: (step.data as { result: Record<string, unknown> }).result,
    names: events.filter((e) => e.type === "step-completed").map((e) => e.name ?? ""),
  };
}

const WORK_TURNS = [
  "```bash\necho ok > done.txt\n```",
  (obs: string) => (obs.includes("exit 0") ? "```finish\nplanned and done\n```" : "```bash\necho hmm\n```"),
  (obs: string) => (obs.includes("Before finishing") ? "```bash\nls\n```" : "```bash\necho hmm\n```"),
  (obs: string) => (obs.includes("exit 0") ? "```finish\nplanned and done\n```" : "```bash\necho hmm\n```"),
];

const PLAN = [
  "1. Edit `src/billing/invoice.ts` so `computeProration()` rounds.",
  "2. Then edit `src/billing/ledger.ts` and run `pnpm run migrate` after `pnpm run build`.",
].join("\n");

const statusOf = (grounding: unknown, name: string): string | undefined => {
  const refs = (grounding as { refs?: { name: string; status: string }[] } | undefined)?.refs;
  return refs?.find((r) => r.name === name)?.status;
};

test("default off: the park's recorded plan step is byte-identical with the flag unset and explicitly off", async () => {
  const run = async (flag: string | undefined) => {
    const w = await repoWorkspace(TREE);
    try {
      return await withFlag(flag, async () => {
        const { model } = reactiveModel([PLAN, ...WORK_TURNS]);
        const store = new MemoryEventStore();
        const parked = await executeRun({ workflow: durableAgent({ model, executor: w.provider }), runId: "park-off", store, input: { task: "t", plan: true } });
        assert.equal(parked.status, "waiting");
        assert.equal(parked.eventName, PLAN_EVENT);
        return planStepOf(store, "park-off");
      });
    } finally {
      await w.done();
    }
  };
  const unset = await run(undefined);
  const off = await run("off");
  assert.equal("grounding" in unset.result, false);
  assert.equal(JSON.stringify(unset.result), JSON.stringify(off.result), "unset and explicit off record the same bytes");
  assert.equal(JSON.stringify(unset.result), JSON.stringify({ text: PLAN, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }), "the pre-wiring {text, usage} shape, unchanged");
});

test("flag on: the real park path grounds the plan against the workspace's committed tree, adds no step, and never re-runs on replay", async () => {
  const w = await repoWorkspace(TREE);
  try {
    await withFlag("on", async () => {
      const { model, callCount } = reactiveModel([PLAN, ...WORK_TURNS]);
      const store = new MemoryEventStore();
      const parked = await executeRun({ workflow: durableAgent({ model, executor: w.provider }), runId: "park-on", store, input: { task: "t", plan: true } });
      assert.equal(parked.status, "waiting", "a grounding report never keeps the run from parking");
      assert.equal(parked.eventName, PLAN_EVENT);
      const { result, names } = await planStepOf(store, "park-on");
      const g = result.grounding as { revision: string; counts: Record<string, number>; allCheckedGrounded: boolean };
      assert.ok(g, "the park's plan step carries a grounding report");
      assert.equal(g.revision, w.sha);
      assert.equal(statusOf(g, "src/billing/invoice.ts"), "grounded");
      assert.equal(statusOf(g, "computeProration"), "grounded");
      assert.equal(statusOf(g, "src/billing/ledger.ts"), "ungrounded");
      assert.equal(statusOf(g, "pnpm run migrate"), "ungrounded");
      assert.equal(statusOf(g, "pnpm run build"), "grounded");
      assert.equal(g.counts.ungrounded, 2);
      assert.equal(g.allCheckedGrounded, false);
      assert.equal(result.text, PLAN, "the plan text itself is untouched");

      await deliverEvent(store, "park-on", PLAN_EVENT, { approved: true });
      const done = await executeRun({ workflow: durableAgent({ model, executor: w.provider }), runId: "park-on", store });
      assert.equal(done.status, "completed");
      assert.equal((done.output as { agentSummary: string }).agentSummary, "planned and done");

      // Same script with the flag off: identical step sequence (no new step).
      const offW = await repoWorkspace(TREE);
      try {
        const offNames = await withFlag(undefined, async () => {
          const { model: m } = reactiveModel([PLAN, ...WORK_TURNS]);
          const s = new MemoryEventStore();
          const p = await executeRun({ workflow: durableAgent({ model: m, executor: offW.provider }), runId: "park-seq", store: s, input: { task: "t", plan: true } });
          assert.equal(p.status, "waiting");
          await deliverEvent(s, "park-seq", PLAN_EVENT, { approved: true });
          await executeRun({ workflow: durableAgent({ model: m, executor: offW.provider }), runId: "park-seq", store: s });
          return (await s.load("park-seq")).filter((e: Logged) => e.type === "step-completed").map((e: Logged) => e.name ?? "");
        });
        const onNames = (await store.load("park-on")).filter((e: Logged) => e.type === "step-completed").map((e: Logged) => e.name ?? "");
        assert.deepEqual(onNames, offNames, "the flag adds no step and removes none");
      } finally {
        await offW.done();
      }

      // Replay of the finished run: the report is read back, git never re-runs.
      const execsBefore = w.execCount();
      const callsBefore = callCount();
      const again = await executeRun({ workflow: durableAgent({ model, executor: w.provider }), runId: "park-on", store });
      assert.equal(again.status, "completed");
      assert.equal(w.execCount(), execsBefore, "replay must not re-run the grounding git queries");
      assert.equal(callCount(), callsBefore);
    });
  } finally {
    await w.done();
  }
});

test("negative control: a fully ungrounded plan still parks, lists what is missing, and approves unchanged", async () => {
  const w = await repoWorkspace(TREE);
  try {
    await withFlag("on", async () => {
      const ghost = "1. Edit `src/ghost_dir/ghost.ts` and call `ghostFunction()` and `ghostHelper.now`, then run `pnpm run exorcise`.";
      const { model } = reactiveModel([ghost, ...WORK_TURNS]);
      const store = new MemoryEventStore();
      const parked = await executeRun({ workflow: durableAgent({ model, executor: w.provider }), runId: "park-ghost", store, input: { task: "t", plan: true } });
      assert.equal(parked.status, "waiting", "ungrounded never blocks the park");
      assert.equal(parked.eventName, PLAN_EVENT);
      const { result } = await planStepOf(store, "park-ghost");
      const g = result.grounding as { counts: Record<string, number>; refs: { name: string; status: string; detail: string }[] };
      assert.equal(result.text, ghost, "grounding never mutates the plan under review");
      assert.equal(statusOf(g, "src/ghost_dir/ghost.ts"), "ungrounded");
      assert.equal(statusOf(g, "ghostFunction"), "ungrounded");
      assert.equal(statusOf(g, "ghostHelper.now"), "ungrounded");
      assert.equal(statusOf(g, "pnpm run exorcise"), "ungrounded");
      assert.equal(g.counts.grounded, 0);
      assert.equal(g.counts.ungrounded, 4);
      assert.ok(g.refs.every((r) => r.status !== "grounded"));
      assert.ok(g.refs.find((r) => r.name === "src/ghost_dir/ghost.ts")?.detail.includes("no such path"));

      await deliverEvent(store, "park-ghost", PLAN_EVENT, { approved: true });
      const done = await executeRun({ workflow: durableAgent({ model, executor: w.provider }), runId: "park-ghost", store });
      assert.equal(done.status, "completed", "the operator's approve is the authority, not the advisory");
    });
  } finally {
    await w.done();
  }
});

test("flag on but the workspace is not a git repository: the field is omitted, the park is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-grounding-bare-"));
  try {
    await writeFile(join(root, "loose.txt"), "not a repo\n");
    let execs = 0;
    const inner = new LocalExecutor({ root });
    const executor: AgentExecutor = {
      async exec(cmd, opts) {
        execs++;
        return inner.exec(cmd, opts);
      },
      putFile: (p, d) => inner.putFile(p, d),
      getFile: (p) => inner.getFile(p),
      destroy: () => inner.destroy(),
    };
    const provider: ExecutorProvider = {
      async create() {
        return { handle: root };
      },
      attach() {
        return executor;
      },
    };
    await withFlag("on", async () => {
      const { model } = reactiveModel([PLAN, ...WORK_TURNS]);
      const store = new MemoryEventStore();
      const parked = await executeRun({ workflow: durableAgent({ model, executor: provider }), runId: "park-bare", store, input: { task: "t", plan: true } });
      assert.equal(parked.status, "waiting");
      assert.equal(parked.eventName, PLAN_EVENT);
      const { result } = await planStepOf(store, "park-bare");
      assert.equal("grounding" in result, false, "no committed tree, no report — not an empty all-ungrounded one");
      assert.equal(result.text, PLAN);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
