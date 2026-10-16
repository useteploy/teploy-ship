import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalExecutor } from "@neutron-build/agents";
import type { AgentExecutor, ExecResult } from "@neutron-build/agents";
import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";
import { MemoryEventStore, executeRun } from "@neutron-build/workflow";

import { durableAgent } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import {
  LIVE_FLUSH_MS,
  LIVE_POLL_MS,
  clearLiveView,
  liveDiffCommand,
  liveDiffKey,
  liveOutputExecutor,
  liveOutputKey,
  liveOutputRecorder,
  liveViewEnabled,
  liveWatchKey,
  readLiveView,
  serveLiveDiffs,
  type LiveDiffRecord,
  type LiveOutputRecord,
} from "./live-view.js";
import { MemoryRuntimeConfig } from "./runtime-config.js";
import { saveTakeover } from "./takeover.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();

async function row<T>(config: MemoryRuntimeConfig, key: string): Promise<T | null> {
  const raw = await config.get(key);
  return raw ? (JSON.parse(raw) as T) : null;
}

test("live view flag: only `on` enables it", () => {
  assert.equal(liveViewEnabled({}), false);
  assert.equal(liveViewEnabled({ SHIP_LIVE_VIEW: "1" }), false);
  assert.equal(liveViewEnabled({ SHIP_LIVE_VIEW: "true" }), false);
  assert.equal(liveViewEnabled({ SHIP_LIVE_VIEW: "on" }), true);
  assert.equal(liveViewEnabled({ SHIP_LIVE_VIEW: " ON " }), true);
});

test("latency budget: worker flush plus page poll stays inside the 5 s acceptance bound with headroom for the store", () => {
  assert.ok(LIVE_FLUSH_MS + LIVE_POLL_MS <= 3_000, "leaves at least 2 s for the store round trips");
});

test("terminal recorder: a chunk reaches the store within one flush interval, including the trailing flush after a burst", async () => {
  const config = new MemoryRuntimeConfig();
  const recorder = liveOutputRecorder(config, "run-a", "npm test", { turn: 3, flushMs: 60 });
  await sleep(5);
  const first = await row<LiveOutputRecord>(config, liveOutputKey("run-a"));
  assert.equal(first?.running, true);
  assert.equal(first?.command, "npm test");
  assert.equal(first?.turn, 3);
  recorder.chunk("line one\n"); // flushed immediately (no flush yet since start)
  recorder.chunk("line two\n"); // inside the window: deferred to the trailing flush
  await sleep(5);
  const early = await row<LiveOutputRecord>(config, liveOutputKey("run-a"));
  assert.match(early!.output, /line one/);
  const sent = Date.now();
  let seen = 0;
  while (Date.now() - sent < 1_000) {
    const r = await row<LiveOutputRecord>(config, liveOutputKey("run-a"));
    if (r?.output.includes("line two")) {
      seen = Date.now() - sent;
      break;
    }
    await sleep(5);
  }
  assert.ok(seen > 0 && seen <= 60 + 50, `trailing flush landed after ${seen} ms`);
  await recorder.end({ exitCode: 2, timedOut: false });
  const last = await row<LiveOutputRecord>(config, liveOutputKey("run-a"));
  assert.equal(last?.running, false);
  assert.equal(last?.exitCode, 2);
  assert.match(last!.output, /line one\nline two/);
});

test("terminal recorder: the tail is bounded and marked truncated", async () => {
  const config = new MemoryRuntimeConfig();
  const recorder = liveOutputRecorder(config, "run-b", "yes", { flushMs: 0 });
  for (let i = 0; i < 4000; i++) recorder.chunk(`row ${i} ${"x".repeat(20)}\n`);
  await recorder.end({ exitCode: 0, timedOut: false });
  const r = await row<LiveOutputRecord>(config, liveOutputKey("run-b"));
  assert.equal(r?.truncated, true);
  assert.ok(r!.output.length <= 8_500);
  assert.match(r!.output, /row 3999/);
  assert.doesNotMatch(r!.output, /row 0 /);
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 14_000);
});

test("redaction negative control: secrets never reach the terminal row or the page read", async () => {
  const secret = "s3cr3t-value-for-live-view-1234";
  process.env.SHIP_LIVE_TEST_TOKEN = secret;
  try {
    const config = new MemoryRuntimeConfig();
    const recorder = liveOutputRecorder(config, "run-c", `curl -H "Authorization: Bearer ${secret}" x`, { flushMs: 0 });
    recorder.chunk(`token is ${secret}\nghp_abcdefghijklmnopqrstuvwxyz0123456789\n`);
    await recorder.end({ exitCode: 0, timedOut: false });
    const stored = (await config.get(liveOutputKey("run-c")))!;
    assert.ok(!stored.includes(secret), "worker-side redaction");
    assert.ok(!stored.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "pattern redaction");
    // A row written by a worker that did NOT know the secret is still
    // scrubbed by the reader's own environment.
    const raw: LiveOutputRecord = { runId: "run-c", command: "env", startedAt: "", lastChunkAt: "", at: "", running: true, output: `leaked ${secret}`, truncated: false };
    await config.set(liveOutputKey("run-c"), JSON.stringify(raw));
    const diff: LiveDiffRecord = { runId: "run-c", at: new Date().toISOString(), output: `+KEY=${secret}\n` };
    await config.set(liveDiffKey("run-c"), JSON.stringify(diff));
    const view = await readLiveView(config, "run-c", { active: false, by: "viewer" });
    assert.ok(!JSON.stringify(view).includes(secret), "reader-side redaction");
  } finally {
    delete process.env.SHIP_LIVE_TEST_TOKEN;
  }
});

test("streaming executor: output lands while the command runs, and the result is the provider's own", async () => {
  const config = new MemoryRuntimeConfig();
  const plain: AgentExecutor = {
    exec: async () => { throw new Error("the streamed path must be used"); },
    putFile: async () => {},
    getFile: async () => new Uint8Array(),
    destroy: async () => {},
  };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const expected: ExecResult = { exitCode: 0, stdout: "building\ndone\n", stderr: "", timedOut: false, truncated: false };
  const stream = async (_cmd: string, _opts: unknown, onChunk: (s: "stdout" | "stderr", c: string) => void) => {
    onChunk("stdout", "building\n");
    await gate;
    onChunk("stdout", "done\n");
    return expected;
  };
  const exec = liveOutputExecutor(plain, stream, (command) => liveOutputRecorder(config, "run-d", command, { flushMs: 0 }));
  const pending = exec.exec("make", { timeoutMs: 5_000 });
  await sleep(10);
  const mid = await row<LiveOutputRecord>(config, liveOutputKey("run-d"));
  assert.equal(mid?.running, true);
  assert.equal(mid?.output, "building\n");
  release();
  assert.deepEqual(await pending, expected);
  await sleep(5);
  const end = await row<LiveOutputRecord>(config, liveOutputKey("run-d"));
  assert.equal(end?.running, false);
  assert.equal(end?.output, "building\ndone\n");
});

// ── Real git workspace through LocalExecutor ───────────────────────────

async function realWorkspace(): Promise<{ root: string; upstream: string }> {
  const upstream = await mkdtemp(join(tmpdir(), "live-up-"));
  git(upstream, "init", "-q", "-b", "main");
  git(upstream, "config", "user.email", "t@t");
  git(upstream, "config", "user.name", "t");
  await writeFile(join(upstream, "app.txt"), "alpha\nbeta\ngamma\n");
  await writeFile(join(upstream, "keep.txt"), "unchanged\n");
  await writeFile(join(upstream, ".gitignore"), ".env\nnode_modules/\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "base");
  const root = await mkdtemp(join(tmpdir(), "live-ws-"));
  git(root, "clone", "-q", upstream, ".");
  git(root, "config", "user.email", "ship@t");
  git(root, "config", "user.name", "ship");
  git(root, "checkout", "-q", "-b", "ship/run-live");
  // A committed change, an uncommitted change, a new untracked file, and an
  // ignored file holding a secret that must never be shown.
  await writeFile(join(root, "app.txt"), "alpha\nBETA\ngamma\n");
  git(root, "commit", "-q", "-am", "agent commit");
  await writeFile(join(root, "app.txt"), "alpha\nBETA\ngamma\ndelta\n");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "new file.ts"), "export const x = 1;\n");
  await writeFile(join(root, ".env"), "DATABASE_PASSWORD=hunter2-ignored-secret\n");
  return { root, upstream };
}

function events(handle: string, setup: Record<string, unknown>) {
  return [
    { type: "run-started", data: { input: { task: "t", repo: "file:///x" } } },
    { type: "step-completed", name: "sandbox", data: { result: handle } },
    { type: "step-completed", name: "repo-setup", data: { result: setup } },
  ];
}

function runtimeFor(config: MemoryRuntimeConfig, status = "running", log = events("h1", { branch: "ship/run-live", base: "main" })) {
  return {
    config,
    loadMeta: async (_runId: string) => ({ status }),
    store: { load: async (_runId: string) => log },
  };
}

function providerFor(root: string): { provider: Pick<ExecutorProvider, "attach">; execs: () => number } {
  let count = 0;
  const inner = new LocalExecutor({ root });
  return {
    execs: () => count,
    provider: {
      attach: () => ({
        exec: (cmd, opts) => {
          count++;
          return inner.exec(cmd, opts);
        },
        putFile: (p, d) => inner.putFile(p, d),
        getFile: (p) => inner.getFile(p),
        destroy: () => inner.destroy(),
      }),
    },
  };
}

async function watch(config: MemoryRuntimeConfig, runId: string, at = new Date()) {
  await config.set(liveWatchKey(runId), JSON.stringify({ at: at.toISOString(), by: "viewer" }));
}

test("real path: the running diff of a git workspace reconstructs the workspace tree at its recorded instant", async () => {
  const { root, upstream } = await realWorkspace();
  const config = new MemoryRuntimeConfig();
  const { provider } = providerFor(root);
  await watch(config, "run-live");
  const result = await serveLiveDiffs(runtimeFor(config), provider);
  assert.deepEqual(result, { served: ["run-live"], errors: [] });
  const diff = (await row<LiveDiffRecord>(config, liveDiffKey("run-live")))!;
  assert.equal(diff.error, undefined);
  assert.equal(diff.head, git(root, "rev-parse", "HEAD"), "HEAD at the instant");
  assert.equal(diff.base, git(root, "merge-base", "HEAD", "origin/main"), "base = merge-base with origin/main");
  assert.match(diff.sandboxAt ?? "", /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  assert.match(diff.digest ?? "", /^[0-9a-f]{16}$/);
  assert.match(diff.baseLabel ?? "", /merge-base of HEAD with origin\/main/);
  assert.equal(diff.truncated, false);
  const output = diff.output!;
  assert.match(output, /\+BETA/, "committed change vs base");
  assert.match(output, /\+delta/, "uncommitted change");
  assert.match(output, /export const x = 1;/, "untracked file content");
  assert.ok(!output.includes("hunter2-ignored-secret"), "ignored files are never read");
  assert.ok(!output.includes("keep.txt"), "unchanged files are absent");

  // Reconstruction: base + this diff == the workspace's non-ignored tree.
  const scratch = await mkdtemp(join(tmpdir(), "live-check-"));
  git(scratch, "clone", "-q", upstream, ".");
  git(scratch, "checkout", "-q", diff.base!);
  await writeFile(join(scratch, "live.patch"), output);
  git(scratch, "apply", "live.patch");
  for (const file of ["app.txt", "keep.txt", ".gitignore", "src/new file.ts"]) {
    assert.equal(await readFile(join(scratch, file), "utf8"), await readFile(join(root, file), "utf8"), file);
  }

  // Read-only: observing changed nothing in the repository.
  assert.deepEqual(git(root, "status", "--porcelain").split("\n").map((l) => l.trim()).sort(), ["?? src/", "M app.txt"]);
});

test("real path: a PR run's diff is against the head it checked out", async () => {
  const { root } = await realWorkspace();
  const headSha = git(root, "rev-parse", "HEAD~1");
  const config = new MemoryRuntimeConfig();
  const { provider } = providerFor(root);
  await watch(config, "run-pr");
  await serveLiveDiffs(runtimeFor(config, "running", events("h1", { branch: "feature", base: "main", headSha })), provider);
  const diff = (await row<LiveDiffRecord>(config, liveDiffKey("run-pr")))!;
  assert.equal(diff.base, headSha);
  assert.match(diff.baseLabel ?? "", /pull request head/);
});

test("real path: secrets inside changed files are redacted in the stored diff", async () => {
  const { root } = await realWorkspace();
  await writeFile(join(root, "config.ts"), 'export const key = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n');
  const config = new MemoryRuntimeConfig();
  const { provider } = providerFor(root);
  await watch(config, "run-sec");
  await serveLiveDiffs(runtimeFor(config), provider);
  const stored = (await config.get(liveDiffKey("run-sec")))!;
  assert.ok(stored.includes("config.ts"));
  assert.ok(!stored.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
});

test("diff load is bounded: nobody watching, a stale watch, or a settled run costs zero execs", async () => {
  const { root } = await realWorkspace();
  const { provider, execs } = providerFor(root);
  const config = new MemoryRuntimeConfig();
  await serveLiveDiffs(runtimeFor(config), provider);
  assert.equal(execs(), 0, "no watch, no exec");

  await watch(config, "run-stale", new Date(Date.now() - 60_000));
  await serveLiveDiffs(runtimeFor(config), provider);
  assert.equal(execs(), 0, "stale watch, no exec");
  assert.equal(await config.get(liveWatchKey("run-stale")), undefined, "stale watch removed");

  await watch(config, "run-done");
  await serveLiveDiffs(runtimeFor(config, "completed"), provider);
  assert.equal(execs(), 0, "settled run, no exec");
  assert.equal(await config.get(liveWatchKey("run-done")), undefined);
});

test("diff load is bounded: one refresh per interval per run, and a per-sweep cap", async () => {
  const { root } = await realWorkspace();
  const { provider, execs } = providerFor(root);
  const config = new MemoryRuntimeConfig();
  await watch(config, "run-x");
  await serveLiveDiffs(runtimeFor(config), provider);
  await serveLiveDiffs(runtimeFor(config), provider);
  assert.equal(execs(), 1, "second sweep inside the interval reuses the snapshot");
  const later = Date.now() + 10_000;
  await watch(config, "run-x", new Date(later));
  await serveLiveDiffs(runtimeFor(config), provider, { now: () => later });
  assert.equal(execs(), 2, "after the interval it refreshes");

  const many = new MemoryRuntimeConfig();
  for (let i = 0; i < 9; i++) await watch(many, `run-${i}`);
  const r = await serveLiveDiffs(runtimeFor(many), provider, { maxPerSweep: 3 });
  assert.equal(r.served.length, 3);
});

test("a held workspace is never execed by the live diff", async () => {
  const { root } = await realWorkspace();
  const { provider, execs } = providerFor(root);
  const config = new MemoryRuntimeConfig();
  await saveTakeover(config, {
    runId: "run-held",
    holder: "alice",
    generation: 1,
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    ttlSec: 600,
    pathsWritten: [],
    execsRun: [],
  });
  await watch(config, "run-held");
  await serveLiveDiffs(runtimeFor(config), provider);
  assert.equal(execs(), 0);
  const diff = await row<LiveDiffRecord>(config, liveDiffKey("run-held"));
  assert.match(diff?.error ?? "", /holds this workspace/);
});

test("readLiveView refreshes the watch heartbeat only for an active run, and at most every few seconds", async () => {
  const config = new MemoryRuntimeConfig();
  await readLiveView(config, "run-r", { active: false, by: "v" });
  assert.equal(await config.get(liveWatchKey("run-r")), undefined);
  await readLiveView(config, "run-r", { active: true, by: "v" });
  const first = await config.get(liveWatchKey("run-r"));
  assert.ok(first);
  await readLiveView(config, "run-r", { active: true, by: "w" });
  assert.equal(await config.get(liveWatchKey("run-r")), first, "not rewritten inside the refresh window");
  await assert.rejects(readLiveView(config, "../etc", { active: true, by: "v" }));
  await clearLiveView(config, "run-r");
  assert.equal(await config.get(liveWatchKey("run-r")), undefined);
});

test("liveDiffCommand refuses unsafe bases", () => {
  assert.throws(() => liveDiffCommand({ sha: "abc; rm -rf /" }));
  assert.throws(() => liveDiffCommand({ branch: "-x" }));
  assert.throws(() => liveDiffCommand({ branch: "a..b" }));
  assert.throws(() => liveDiffCommand({ branch: "main'; touch pwned; '" }));
});

// ── The durable loop, flag on vs off ───────────────────────────────────

function scriptedModel(turns: string[]): ModelAdapter {
  let i = 0;
  return {
    provider: "scripted",
    modelId: "s1",
    async doGenerate(): Promise<AdapterGenerateResult> {
      const text = turns[i++] ?? "```finish\ndone\n```";
      return { content: [{ type: "text", text }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
    },
    async *doStream() {
      throw new Error("unused");
    },
  };
}

async function runOnce(liveOutput?: MemoryRuntimeConfig) {
  const root = await mkdtemp(join(tmpdir(), "live-durable-"));
  const executor = new LocalExecutor({ root });
  const provider: ExecutorProvider = { create: async () => ({ handle: "h" }), attach: () => executor };
  const wf = durableAgent({
    model: scriptedModel(["```bash\necho hello-live && echo oops >&2\n```", "```finish\nprinted\n```", "```bash\necho hello-live\n```", "```finish\nprinted\n```"]),
    executor: provider,
    ...(liveOutput !== undefined ? { liveOutput } : {}),
  });
  const store = new MemoryEventStore();
  const outcome = await executeRun({ workflow: wf, runId: "run-flag", store, input: { task: "say hello" } });
  const steps = (await store.load("run-flag"))
    .filter((e) => e.type === "step-completed")
    .map((e) => ({ name: e.name, data: (e as { data?: unknown }).data }));
  return { outcome, steps };
}

test("durable loop: flag off writes nothing; flag on records the bash output; the recorded log is identical", async () => {
  const off = await runOnce();
  const config = new MemoryRuntimeConfig();
  const on = await runOnce(config);
  assert.equal(off.outcome.status, on.outcome.status);
  assert.deepEqual(on.steps, off.steps, "same steps, same recorded results");
  await sleep(10);
  const r = await row<LiveOutputRecord>(config, liveOutputKey("run-flag"));
  assert.ok(r !== null, "flag on: the terminal row exists");
  assert.equal(r!.running, false);
  assert.equal(r!.exitCode, 0);
  assert.match(r!.command, /echo hello-live/);
  assert.match(r!.output, /hello-live/);
});
