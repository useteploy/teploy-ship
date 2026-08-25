import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import { MemoryEventStore, executeRun } from "@neutron-build/workflow";

import { durableAgent } from "./durable.js";
import type { DurableAgentOutput, ExecutorProvider } from "./durable.js";
import { FileRepoMemory } from "./repo-memory.js";
import type { HarnessAdapter } from "./harness.js";
import { parsePick, pickPrompt } from "./critic.js";

/** A fake harness that writes one file and claims success. */
function fakeAdapter(id: string, opts: { file: string; content: string; priced?: boolean; costUSD?: number }): HarnessAdapter & { runs: number } {
  const adapter = {
    id,
    version: "1",
    isolated: true,
    runs: 0,
    async run(_task: unknown, ws: { executor: LocalExecutor; ctx: { step: <T>(name: string, fn: () => Promise<T>) => Promise<T> }; stepPrefix: string }) {
      adapter.runs += 1;
      await ws.ctx.step(`${ws.stepPrefix}${id}-edit`, async () => {
        await ws.executor.putFile(opts.file, opts.content);
        return true;
      });
      return {
        status: "finished" as const,
        summary: `${id} wrote ${opts.file}`,
        turns: 2,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, ...(opts.priced === false ? { priced: false } : {}), ...(opts.costUSD !== undefined ? { costUSD: opts.costUSD } : {}) },
        incomplete: false,
      };
    },
  };
  return adapter as unknown as HarnessAdapter & { runs: number };
}

function pickerModel(answer: string): { model: ModelAdapter; calls: () => number; prompts: string[] } {
  let calls = 0;
  const prompts: string[] = [];
  return {
    calls: () => calls,
    prompts,
    model: {
      provider: "scripted",
      modelId: "picker",
      async doGenerate(options): Promise<AdapterGenerateResult> {
        calls += 1;
        prompts.push(options.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"));
        return { content: [{ type: "text", text: answer }], finishReason: "stop", usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 }, raw: null };
      },
      async *doStream() {
        throw new Error("unused");
      },
    },
  };
}

async function bareRepo(): Promise<string> {
  const bareDir = await mkdtemp(join(tmpdir(), "attempts-bare-"));
  const seedDir = await mkdtemp(join(tmpdir(), "attempts-seed-"));
  await new LocalExecutor({ root: seedDir }).exec(
    `git init -q -b main . && git config user.email t@t && git config user.name t && printf 'a\\n' > lib.ts && git add -A && git commit -qm seed && git clone -q --bare . ${bareDir}/owner/repo.git`,
  );
  return `file://${bareDir}/owner/repo.git`;
}

function stubPrApi(): { restore: () => void; posted: string[] } {
  const realFetch = globalThis.fetch;
  const posted: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.startsWith("file:///api/v1/")) return realFetch(url, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    if (u.endsWith("/pulls") && method === "GET") return json([]);
    if (u.endsWith("/pulls") && method === "POST") {
      posted.push((JSON.parse(String(init?.body)) as { body: string }).body);
      return json({ number: 5, html_url: "file:///owner/repo/pulls/5" }, 201);
    }
    return json({ number: 5, body: "" });
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = realFetch), posted };
}

test("parsePick reads the last-line verdict and refuses attempts that were not offered", () => {
  assert.equal(parsePick("ATTEMPT 2", [1, 2]), 2);
  assert.equal(parsePick("Candidate 1 is incomplete.\nATTEMPT 1.", [1, 2]), 1);
  assert.equal(parsePick("ATTEMPT 3", [1, 2]), null);
  assert.equal(parsePick("I prefer the first", [1, 2]), null);
  const prompt = pickPrompt("t", [{ attempt: 1, harness: "a", summary: "s", diff: "x".repeat(20_000) }, { attempt: 2, harness: "b", summary: "s", diff: "y" }]);
  assert.match(prompt, /truncated/);
  assert.match(prompt, /ATTEMPT 2 \(harness: b\)/);
});

test("multi-harness attempts: each harness works its own checkout, the critic picks, only the winner is published and the losers are released", async () => {
  const repo = await bareRepo();
  const handles: string[] = [];
  const destroyed: string[] = [];
  const provider: ExecutorProvider = {
    isolated: true,
    async create() {
      const dir = await mkdtemp(join(tmpdir(), "attempts-work-"));
      handles.push(dir);
      return { handle: dir };
    },
    attach: (h) => new LocalExecutor({ root: h }),
    async destroy(h) {
      destroyed.push(h);
    },
  };
  const alpha = fakeAdapter("alpha", { file: "alpha.txt", content: "from alpha\n" });
  const beta = fakeAdapter("beta", { file: "beta.txt", content: "from beta\n", priced: false });
  const picker = pickerModel("Beta's change is the more complete one.\nATTEMPT 2");
  const wf = durableAgent({
    model: picker.model,
    executor: provider,
    workdir: ".",
    repoMemory: new FileRepoMemory(await mkdtemp(join(tmpdir(), "attempts-mem-"))),
    harnesses: [alpha, beta],
  });
  const api = stubPrApi();
  try {
    const store = new MemoryEventStore();
    const input = {
      task: "add a file",
      repo,
      trust: "operator" as const,
      harness: { id: "alpha", version: "1" },
      harnessAttempts: [
        { id: "alpha", version: "1" },
        { id: "beta", version: "1" },
      ],
    };
    const outcome = await executeRun({ workflow: wf, runId: "run-attempts", store, input });
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    const out = outcome.output as DurableAgentOutput;
    assert.equal(out.status, "finished");
    assert.match(out.summary, /^beta wrote beta.txt/);
    assert.match(out.summary, /Picked from 2 harness attempts: alpha, beta \(published\)/);
    assert.equal(out.pr, "file:///owner/repo/pulls/5");
    assert.equal(out.turns, 4, "turns sum across attempts");
    assert.equal(out.usage?.priced, false, "one unpriced attempt makes the run unpriced");
    assert.equal(out.usage?.inputTokens, 27, "attempt usage plus the pick call");
    assert.equal(alpha.runs, 1);
    assert.equal(beta.runs, 1);
    assert.equal(picker.calls(), 1, "the critic is asked once");
    assert.match(picker.prompts[0]!, /ATTEMPT 1 \(harness: alpha\)[\s\S]*alpha\.txt[\s\S]*ATTEMPT 2 \(harness: beta\)[\s\S]*beta\.txt/);

    const events = await store.load("run-attempts");
    const steps = events.filter((e) => e.type === "step-completed").map((e) => e.name);
    assert.deepEqual(steps, [
      "sandbox",
      "repo-setup",
      "repo-context",
      "attempt-0-alpha-edit",
      "attempt-0-diff",
      "attempt-1-sandbox",
      "attempt-1-repo-setup",
      "attempt-1-beta-edit",
      "attempt-1-diff",
      "harness-pick",
      "repo-push",
      "repo-pr",
      "repo-memory",
    ]);
    const pick = events.find((e) => e.type === "step-completed" && e.name === "harness-pick")?.data as { result: { winner: number; candidates: number[] } };
    assert.equal(pick.result.winner, 1);
    assert.deepEqual(pick.result.candidates, [1, 2]);

    // Two workspaces were created; both are released, the loser before the publish.
    assert.equal(handles.length, 2);
    assert.deepEqual(new Set(destroyed), new Set(handles));

    // Only beta's tree was pushed.
    const bare = repo.slice("file://".length);
    const files = await new LocalExecutor({ root: tmpdir() }).exec(
      `for ref in $(git --git-dir=${bare} for-each-ref --format='%(refname)' refs/heads); do git --git-dir=${bare} ls-tree --name-only -r "$ref"; done`,
    );
    assert.match(files.stdout, /beta\.txt/);
    assert.doesNotMatch(files.stdout, /alpha\.txt/);

    // Replay: no attempt re-runs, no second pick.
    const again = await executeRun({ workflow: wf, runId: "run-attempts", store, input });
    assert.equal(again.status, "completed");
    assert.equal(alpha.runs, 1);
    assert.equal(beta.runs, 1);
    assert.equal(picker.calls(), 1);
  } finally {
    api.restore();
  }
});

test("multi-harness attempts: with one diff there is nothing to pick and the critic is not called; an unparseable verdict falls back to the first candidate", async () => {
  const repo = await bareRepo();
  const provider: ExecutorProvider = {
    async create() {
      return { handle: await mkdtemp(join(tmpdir(), "attempts-work-")) };
    },
    attach: (h) => new LocalExecutor({ root: h }),
  };
  const api = stubPrApi();
  try {
    // Only alpha produces a diff (beta "writes" lib.ts's existing content).
    const alpha = fakeAdapter("alpha", { file: "alpha.txt", content: "x\n" });
    const same = fakeAdapter("beta", { file: "lib.ts", content: "a\n" });
    const picker = pickerModel("ATTEMPT 2");
    const store = new MemoryEventStore();
    const wf = durableAgent({ model: picker.model, executor: provider, workdir: ".", harnesses: [alpha, same] });
    const outcome = await executeRun({
      workflow: wf,
      runId: "run-one-diff",
      store,
      input: { task: "t", repo, trust: "operator", harnessAttempts: [{ id: "alpha", version: "1" }, { id: "beta", version: "1" }] },
    });
    assert.equal(outcome.status, "completed", JSON.stringify(outcome));
    assert.equal(picker.calls(), 0);
    const pick = (await store.load("run-one-diff")).find((e) => e.type === "step-completed" && e.name === "harness-pick")?.data as { result: { winner: number; reason: string } };
    assert.equal(pick.result.winner, 0);
    assert.match(pick.result.reason, /only one attempt/);

    // Two diffs, verdict names nothing: first candidate, recorded as a fallback.
    const gamma = fakeAdapter("gamma", { file: "gamma.txt", content: "g\n" });
    const mumble = pickerModel("they both look fine to me");
    const store2 = new MemoryEventStore();
    const wf2 = durableAgent({ model: mumble.model, executor: provider, workdir: ".", harnesses: [alpha, gamma] });
    const outcome2 = await executeRun({
      workflow: wf2,
      runId: "run-mumble",
      store: store2,
      input: { task: "t", repo, trust: "operator", harnessAttempts: [{ id: "alpha", version: "1" }, { id: "gamma", version: "1" }] },
    });
    assert.equal(outcome2.status, "completed", JSON.stringify(outcome2));
    const pick2 = (await store2.load("run-mumble")).find((e) => e.type === "step-completed" && e.name === "harness-pick")?.data as { result: { winner: number; reason: string } };
    assert.equal(pick2.result.winner, 0);
    assert.match(pick2.result.reason, /did not name an attempt/);
  } finally {
    api.restore();
  }
});

test("multi-harness attempts on a workspace run are a single attempt (no checkout to clone)", async () => {
  const provider: ExecutorProvider = {
    async create() {
      return { handle: await mkdtemp(join(tmpdir(), "attempts-ws-")) };
    },
    attach: (h) => new LocalExecutor({ root: h }),
  };
  const alpha = fakeAdapter("alpha", { file: "a.txt", content: "a\n" });
  const beta = fakeAdapter("beta", { file: "b.txt", content: "b\n" });
  const picker = pickerModel("ATTEMPT 2");
  const store = new MemoryEventStore();
  const wf = durableAgent({ model: picker.model, executor: provider, workdir: ".", harnesses: [alpha, beta] });
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-ws-attempts",
    store,
    input: { task: "t", harness: { id: "alpha", version: "1" }, harnessAttempts: [{ id: "alpha", version: "1" }, { id: "beta", version: "1" }] },
  });
  assert.equal(outcome.status, "completed");
  assert.equal(alpha.runs, 1);
  assert.equal(beta.runs, 0);
  assert.equal(picker.calls(), 0);
});
