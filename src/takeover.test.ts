import test from "node:test";
import assert from "node:assert/strict";

import {
  TAKEOVER_HISTORY_LIMIT,
  appendTakeoverHistory,
  diffEvidence,
  handbackNote,
  loadTakeover,
  mayAcquireTakeover,
  takeoverHistoryKey,
  takeoverKey,
  takeoverPathValid,
  takeoverReplyKey,
  type TakeoverRecord,
} from "./takeover.js";
import { requestKey, requestWorkspace, serveWorkspaceRequests } from "./workspace-requests.js";

const ASK = { status: "waiting", eventName: "ship-ask-1" };
const MERGE_PARK = { status: "waiting", eventName: "approve-merge" };

test("takeover is offered only at a park the resumed agent consumes", () => {
  assert.deepEqual(mayAcquireTakeover(ASK), { ok: true });
  assert.equal(mayAcquireTakeover(MERGE_PARK).ok, false);
  assert.equal(mayAcquireTakeover({ status: "waiting", eventName: "ship-upgrade-hold" }).ok, false);
  // executing / resumed: eventName is what says "parked at a decision"
  assert.equal(mayAcquireTakeover({ status: "waiting" }).ok, false);
  assert.equal(mayAcquireTakeover({ status: "running" }).ok, false);
  assert.equal(mayAcquireTakeover(null).ok, false);
});

test("takeover write paths stay inside the work tree", () => {
  assert.equal(takeoverPathValid("src/file.ts").ok, true);
  assert.equal(takeoverPathValid("../escape").ok, false);
  assert.equal(takeoverPathValid(".git/config").ok, false);
  assert.equal(takeoverPathValid("/absolute").ok, false);
  assert.equal(takeoverPathValid("a\x00b").ok, false);
  assert.equal(takeoverPathValid("").ok, false);
});

function record(overrides: Partial<TakeoverRecord> = {}): TakeoverRecord {
  return {
    runId: "run-1",
    holder: "alice",
    generation: 3,
    acquiredAt: "2026-09-22T00:00:00Z",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ttlSec: 1800,
    pathsWritten: [],
    execsRun: [],
    ...overrides,
  };
}

test("an expired takeover record reads as not held", async () => {
  const values = new Map<string, string>([
    [takeoverKey("run-1"), JSON.stringify(record({ expiresAt: new Date(Date.now() - 1000).toISOString() }))],
  ]);
  const runtime = { config: { get: async (k: string) => values.get(k) } } as never;
  assert.equal(await loadTakeover(runtime, "run-1"), null);
  values.set(takeoverKey("run-1"), JSON.stringify(record()));
  assert.equal((await loadTakeover(runtime, "run-1"))!.generation, 3);
});

test("history keeps only the most recent sessions", async () => {
  const values = new Map<string, string>();
  const config = {
    get: async (k: string) => values.get(k),
    set: async (k: string, v: string) => {
      if (v === "") values.delete(k);
      else values.set(k, v);
    },
    remove: async (k: string) => {
      values.delete(k);
    },
    list: async () => [...values.keys()].map((key) => ({ key })),
  };
  for (let i = 0; i < TAKEOVER_HISTORY_LIMIT + 3; i++) {
    await appendTakeoverHistory(config, "run-1", {
      holder: `user-${i}`,
      acquiredAt: "2026-09-22T00:00:00Z",
      releasedAt: "2026-09-22T00:10:00Z",
      outcome: "released",
      pathsWritten: [],
      execsRun: [],
    });
  }
  const history = JSON.parse(values.get(takeoverHistoryKey("run-1"))!) as { holder: string }[];
  assert.equal(history.length, TAKEOVER_HISTORY_LIMIT);
  assert.equal(history.at(-1)!.holder, `user-${TAKEOVER_HISTORY_LIMIT + 2}`);
});

test("diff evidence digests the full diff and bounds the excerpt", () => {
  const big = "x".repeat(50_000);
  const evidence = diffEvidence(big);
  assert.equal(evidence.excerpt.length <= 12_000, true);
  assert.equal(evidence.digest.length, 16);
  assert.equal(diffEvidence(big).digest, evidence.digest);
});

test("the handback note tells the agent the workspace moved under it", () => {
  const note = handbackNote({
    holder: "alice",
    acquiredAt: "2026-09-22T00:00:00Z",
    releasedAt: "2026-09-22T00:10:00Z",
    outcome: "released",
    pathsWritten: ["src/a.ts"],
    execsRun: ["pnpm test"],
    diffDigest: "abc123",
    note: "fixed the import",
  });
  assert.match(note, /alice/);
  assert.match(note, /NOT committed/);
  assert.match(note, /src\/a\.ts/);
  assert.match(note, /abc123/);
  assert.match(note, /fixed the import/);
});

/** A Map-backed runtime + lease-recording executor for the serve-flow tests. */
function harness(meta: { status: string; eventName?: string }, project: { testCommand?: string; verification?: { tests?: string } } | null) {
  const values = new Map<string, string>();
  const steerNotes: string[] = [];
  const calls: { op: string; args: unknown[] }[] = [];
  const runtime = {
    config: {
      list: async () => [...values.keys()].map((key) => ({ key })),
      get: async (k: string) => values.get(k),
      set: async (k: string, v: string) => {
        values.set(k, v);
      },
    },
    loadMeta: async () => meta,
    projects: {
      list: async () => [],
      forRepo: async () => project,
    },
    store: {
      load: async () => [
        { type: "run-started", data: { input: { repo: "https://github.com/team/repo" } } },
        { type: "step-completed", name: "sandbox", data: { result: { handle: "box-1" } } },
      ],
    },
    steer: { add: async (_runId: string, text: string) => { steerNotes.push(text); } },
  } as never;
  const executor = {
    attach: () => {
      throw new Error("takeover must not use the unfenced attach path");
    },
    lease: {
      acquire: async (handle: string, owner: string, ttlSec: number) => {
        calls.push({ op: "acquire", args: [handle, owner, ttlSec] });
        return { generation: 7, expiresAt: new Date(Date.now() + ttlSec * 1000).toISOString() };
      },
      renew: async (handle: string, owner: string, generation: number, ttlSec: number) => {
        calls.push({ op: "renew", args: [handle, owner, generation, ttlSec] });
        return { expiresAt: new Date(Date.now() + ttlSec * 1000).toISOString() };
      },
      release: async (handle: string, owner: string, generation: number) => {
        calls.push({ op: "release", args: [handle, owner, generation] });
      },
      execAs: async (handle: string, cred: unknown, command: string) => {
        calls.push({ op: "execAs", args: [handle, cred, command] });
        if (command.includes("status")) return { exitCode: 0, stdout: " M src/a.ts", stderr: "", timedOut: false, truncated: false };
        return { exitCode: 0, stdout: `ran ${command}`, stderr: "", timedOut: false, truncated: false };
      },
      writeFileAs: async (handle: string, cred: unknown, path: string, bytes: Uint8Array) => {
        calls.push({ op: "writeFileAs", args: [handle, cred, path, Buffer.from(bytes).toString("utf8")] });
      },
    },
  } as never;
  const replyOf = (): any => JSON.parse(values.get(takeoverReplyKey("run-1")) ?? "null");
  return { runtime, executor, calls, steerNotes, values, replyOf };
}

async function request(runtime: unknown, kind: string, by: string, path?: string, extra?: { content?: string; reason?: string }) {
  await requestWorkspace(runtime as never, "run-1", kind as never, by, path, extra);
}

test("the takeover chain: acquire is exclusive, writes carry the holder credential, handback steers the agent", async () => {
  const h = harness(ASK, { testCommand: "pnpm test" });
  await request(h.runtime, "takeover-acquire", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.equal(h.replyOf().takeover.generation, 7);
  assert.equal(JSON.parse(h.values.get(takeoverKey("run-1"))!).holder, "alice");
  // id-dedupe: a re-sweep of the same request does nothing
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.equal(h.calls.filter((c) => c.op === "acquire").length, 1);

  // another user cannot operate the held workspace
  await request(h.runtime, "takeover-write", "bob", "src/a.ts", { content: "new" });
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().error, /held by alice/);

  // the holder writes: renewal first, then the fenced write with owner+generation
  await request(h.runtime, "takeover-write", "alice", "src/a.ts", { content: "new content" });
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().output, /Wrote src\/a\.ts/);
  const write = h.calls.find((c) => c.op === "writeFileAs")!;
  assert.deepEqual(write.args[1], { owner: "alice", generation: 7 });
  assert.equal(write.args[3], "new content");
  assert.deepEqual(JSON.parse(h.values.get(takeoverKey("run-1"))!).pathsWritten, ["src/a.ts"]);

  // exec runs exactly the project's declared tests command, under the credential
  await request(h.runtime, "takeover-exec", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().output, /pnpm test/);
  const exec = h.calls.find((c) => c.op === "execAs" && (c.args[2] as string).includes("pnpm"))!;
  assert.deepEqual(exec.args[1], { owner: "alice", generation: 7 });

  // handback: diff recorded, lease released, history kept, agent steered
  await request(h.runtime, "takeover-release", "alice", undefined, { reason: "fixed the failing import" });
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().output, /Handed back/);
  assert.ok(h.calls.some((c) => c.op === "release"));
  assert.equal(h.values.get(takeoverKey("run-1")), "");
  const history = JSON.parse(h.values.get(takeoverHistoryKey("run-1"))!) as any[];
  assert.equal(history.length, 1);
  assert.equal(history[0].outcome, "released");
  assert.deepEqual(history[0].pathsWritten, ["src/a.ts"]);
  assert.equal(h.steerNotes.length, 1);
  assert.match(h.steerNotes[0], /alice/);
  assert.match(h.steerNotes[0], /NOT committed/);
});

test("exec without a declared tests command is refused, not improvised", async () => {
  const h = harness(ASK, {});
  await request(h.runtime, "takeover-acquire", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  await request(h.runtime, "takeover-exec", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().error, /declares no tests command/);
});

test("a merge review refuses takeover instead of trapping edits outside the PR", async () => {
  const h = harness(MERGE_PARK, null);
  await request(h.runtime, "takeover-acquire", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().error, /merge/);
  assert.equal(h.values.get(takeoverKey("run-1")), undefined);
});

test("an expired lease lapses to history without losing the evidence", async () => {
  const h = harness(ASK, null);
  h.values.set(
    takeoverKey("run-1"),
    JSON.stringify(record({ expiresAt: new Date(Date.now() - 1000).toISOString(), pathsWritten: ["src/gone.ts"] })),
  );
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.equal(h.values.get(takeoverKey("run-1")), "");
  const history = JSON.parse(h.values.get(takeoverHistoryKey("run-1"))!) as any[];
  assert.equal(history[0].outcome, "lapsed");
  assert.deepEqual(history[0].pathsWritten, ["src/gone.ts"]);
});

test("a lost lease fails the operation honestly instead of writing unowned", async () => {
  const h = harness(ASK, { testCommand: "pnpm test" });
  await request(h.runtime, "takeover-acquire", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  (h.executor as any).lease.renew = async () => {
    throw new Error("no active generation 7 lease held by \"alice\" on run box-1");
  };
  await request(h.runtime, "takeover-write", "alice", "src/a.ts", { content: "x" });
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().error, /lease was lost/);
  assert.equal(h.values.get(takeoverKey("run-1")), "");
  const history = JSON.parse(h.values.get(takeoverHistoryKey("run-1"))!) as any[];
  assert.equal(history[0].outcome, "lapsed");
});

test("requests for runs without a workspace or repo are refused plainly", async () => {
  const values = new Map<string, string>();
  const runtime = {
    config: {
      list: async () => [...values.keys()].map((key) => ({ key })),
      get: async (k: string) => values.get(k),
      set: async (k: string, v: string) => {
        values.set(k, v);
      },
    },
    loadMeta: async () => ASK,
    projects: { list: async () => [] },
    store: { load: async () => [{ type: "run-started", data: { input: { repo: "https://github.com/team/repo" } } }] },
  } as never;
  values.set(
    requestKey("run-1"),
    JSON.stringify({ id: "r1", runId: "run-1", kind: "takeover-acquire", at: new Date().toISOString(), by: "alice" }),
  );
  await serveWorkspaceRequests(runtime, { lease: {} } as never, { allowlist: "https://github.com" });
  const reply = JSON.parse(values.get(takeoverReplyKey("run-1"))!);
  assert.match(reply.error, /not available/);
});
