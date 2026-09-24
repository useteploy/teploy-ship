import test from "node:test";
import assert from "node:assert/strict";

import {
  TAKEOVER_HISTORY_LIMIT,
  TAKEOVER_CONTENT_LIMIT,
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
import {
  REPLY_WRITE_ATTEMPTS,
  WORKSPACE_ROW_BYTES_LIMIT,
  fitReply,
  requestKey,
  requestWorkspace,
  serveWorkspaceRequests,
  sweepLapsedTakeovers,
  TAKEOVER_CONSOLE_COMMAND_LIMIT,
  type PendingReply,
} from "./workspace-requests.js";
import { FileArtifacts, type ArtifactStore } from "./artifacts.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/**
 * The S12 panel ops need an executor that actually behaves like the daemon's
 * fenced exec: it answers the editor's bounded base64 read from a virtual
 * file tree, runs console commands (streaming chunks), records the
 * credential every call arrived with, and answers browser actions with a
 * FAKE driver speaking the same JSON-over-stdio protocol as the real
 * in-sandbox Chromium driver (src/takeover-browser.ts). Live-chromium proof
 * is the orchestrator's script, not this suite — a stub that answers the
 * protocol is what a unit test can honestly assert against.
 */
/** A real PNG signature + payload: the artifact store sniffs magic bytes, so a fake image must look like one. */
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const fakePng = (tag: string): string => Buffer.concat([PNG_MAGIC, Buffer.from(tag)]).toString("base64");

function fakeBrowserDriver(action: Record<string, unknown>): { exitCode: number; stdout: string; stderr: string; timedOut: boolean; truncated: boolean } {
  const line = (obj: unknown): string => JSON.stringify(obj) + "\n";
  if (action.action === "navigate") {
    if (typeof action.url !== "string" || !/^https?:\/\//.test(action.url))
      return { exitCode: 0, stdout: line({ ok: false, error: "only http(s) URLs are accepted" }), stderr: "", timedOut: false, truncated: false };
    return {
      exitCode: 0,
      stdout: line({ ok: true, action: "navigate", url: action.url, width: 1280, height: 800, format: "png", image: fakePng("fake-png") }),
      stderr: "", timedOut: false, truncated: false,
    };
  }
  if (action.action === "click")
    return { exitCode: 0, stdout: line({ ok: true, action: "click", url: "http://localhost:8000/clicked", width: 1280, height: 800, format: "png", image: fakePng("fake-png-2") }), stderr: "", timedOut: false, truncated: false };
  if (action.action === "close")
    return { exitCode: 0, stdout: line({ ok: true, action: "close" }), stderr: "", timedOut: false, truncated: false };
  return { exitCode: 0, stdout: line({ ok: true, action: String(action.action), url: "http://localhost:8000/", width: 1280, height: 800, format: "png", image: fakePng("fake-png-3") }), stderr: "", timedOut: false, truncated: false };
}

function panelHarness(files: Record<string, string>) {
  const values = new Map<string, string>();
  const artifacts: ArtifactStore = new FileArtifacts(mkdtempSync(join(tmpdir(), "takeover-artifacts-")));
  const replyWrites: { id: string; running?: boolean; output?: string }[] = [];
  const calls: { op: string; cred: unknown; command: string }[] = [];
  const runtime = {
    config: {
      list: async () => [...values.keys()].map((key) => ({ key })),
      get: async (k: string) => values.get(k),
      set: async (k: string, v: string) => {
        values.set(k, v);
        if (k === takeoverReplyKey("run-1") && v !== "") {
          const parsed = JSON.parse(v) as { id: string; running?: boolean; output?: string };
          replyWrites.push({ id: parsed.id, ...(parsed.running !== undefined ? { running: parsed.running } : {}), ...(parsed.output !== undefined ? { output: parsed.output } : {}) });
        }
      },
    },
    loadMeta: async () => ASK,
    artifacts,
    projects: { list: async () => [], forRepo: async () => ({ testCommand: "pnpm test" }) },
    store: {
      load: async () => [
        { type: "run-started", data: { input: { repo: "https://github.com/team/repo" } } },
        { type: "step-completed", name: "sandbox", data: { result: { handle: "box-1" } } },
      ],
    },
    steer: { add: async () => {} },
  } as never;
  const executor = {
    attach: () => {
      throw new Error("panel ops must not use the unfenced attach path");
    },
    lease: {
      acquire: async () => ({ generation: 7, expiresAt: new Date(Date.now() + 1800_000).toISOString() }),
      renew: async () => ({ expiresAt: new Date(Date.now() + 1800_000).toISOString() }),
      release: async () => {},
      execAs: async (
        _handle: string,
        cred: { owner: string; generation: number },
        command: string,
        _opts?: unknown,
        onChunk?: (stream: "stdout" | "stderr", chunk: string) => void,
      ) => {
        calls.push({ op: "execAs", cred, command });
        const read = /^head -c (\d+) '\.\/(.*)' \| base64 \| tr -d/.exec(command);
        if (read !== null) {
          const bytes = Buffer.from(files[read[2]] ?? "", "utf8");
          if (bytes.length === 0) return { exitCode: 1, stdout: "", stderr: "no such file", timedOut: false, truncated: false };
          const stdout = bytes.subarray(0, Number(read[1])).toString("base64");
          return { exitCode: 0, stdout, stderr: "", timedOut: false, truncated: false };
        }
        const browser = /^exec node \.ship\/browser-driver\.mjs '([A-Za-z0-9+/=]+)'$/.exec(command.split("\n").at(-1) ?? "");
        if (browser !== null) {
          const action = JSON.parse(Buffer.from(browser[1], "base64").toString("utf8")) as Record<string, unknown>;
          return fakeBrowserDriver(action);
        }
        const consoleCmd = /^echo (.+)$/.exec(command);
        if (consoleCmd !== null) {
          const out = `hello ${consoleCmd[1]}`;
          onChunk?.("stdout", out.slice(0, 3));
          onChunk?.("stdout", out.slice(3));
          return { exitCode: 0, stdout: out, stderr: "", timedOut: false, truncated: false };
        }
        if (command.includes("status")) return { exitCode: 0, stdout: " M src/a.ts", stderr: "", timedOut: false, truncated: false };
        return { exitCode: 0, stdout: `ran ${command}`, stderr: "", timedOut: false, truncated: false };
      },
      writeFileAs: async (_handle: string, cred: unknown, path: string, bytes: Uint8Array) => {
        calls.push({ op: "writeFileAs", cred, command: `${path}:${Buffer.from(bytes).toString("utf8")}` });
        files[path] = Buffer.from(bytes).toString("utf8");
      },
    },
  } as never;
  const replyOf = (): any => JSON.parse(values.get(takeoverReplyKey("run-1")) ?? "null");
  return { runtime, executor, calls, replyWrites, values, replyOf, files, artifacts };
}

async function panelRequest(runtime: unknown, kind: string, by: string, path?: string, extra?: { content?: string; command?: string; browser?: string; reason?: string }) {
  await requestWorkspace(runtime as never, "run-1", kind as never, by, path, extra);
}

test("the console runs a submitted command fenced, streams it, and records it in the session", async () => {
  const h = panelHarness({});
  await panelRequest(h.runtime, "takeover-acquire", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  await panelRequest(h.runtime, "takeover-console", "alice", undefined, { command: "echo world" });
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().output, /\$ echo world\nexit 0\nhello world/);
  const exec = h.calls.find((c) => c.op === "execAs" && c.command === "echo world")!;
  assert.deepEqual(exec.cred, { owner: "alice", generation: 7 });
  // streamed: an intermediate running reply landed before the final one
  assert.ok(h.replyWrites.some((w) => w.running === true));
  // the session record carries the command (execsRun), so handback tells the agent
  assert.deepEqual(JSON.parse(h.values.get(takeoverKey("run-1"))!).execsRun, ["echo world"]);
  await panelRequest(h.runtime, "takeover-release", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  const history = JSON.parse(h.values.get(takeoverHistoryKey("run-1"))!) as any[];
  assert.deepEqual(history[0].execsRun, ["echo world"]);
});

test("the console is holder-only and length-capped", async () => {
  const h = panelHarness({});
  await panelRequest(h.runtime, "takeover-acquire", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  await panelRequest(h.runtime, "takeover-console", "bob", undefined, { command: "echo no" });
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().error, /held by alice/);
  await assert.rejects(
    panelRequest(h.runtime, "takeover-console", "alice", undefined, { command: "x".repeat(TAKEOVER_CONSOLE_COMMAND_LIMIT + 1) }),
    /limited to/,
  );
  // defense in depth: a crafted oversized request is refused at serve time too
  h.values.set(
    requestKey("run-1"),
    JSON.stringify({ id: "r-big", runId: "run-1", kind: "takeover-console", at: new Date().toISOString(), by: "alice", command: "x".repeat(TAKEOVER_CONSOLE_COMMAND_LIMIT + 1) }),
  );
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().error, /up to \d+ characters/);
});

test("the editor reads through the fence, bounded, binary-refused, path-checked", async () => {
  const h = panelHarness({ "src/a.ts": "export const a = 1;\n", "big.txt": "y".repeat(TAKEOVER_CONTENT_LIMIT + 10), "blob.bin": "\x00\x01binary" });
  await panelRequest(h.runtime, "takeover-acquire", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  // a normal read returns the file VERBATIM (round-trips into a later write)
  await panelRequest(h.runtime, "takeover-read", "alice", "src/a.ts");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.equal(h.replyOf().kind, "takeover-read");
  assert.equal(h.replyOf().output, "export const a = 1;\n");
  const read = h.calls.find((c) => c.op === "execAs" && c.command.includes("head -c"))!;
  assert.deepEqual(read.cred, { owner: "alice", generation: 7 });
  // over the cap: refused, not silently shortened
  await panelRequest(h.runtime, "takeover-read", "alice", "big.txt");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().error, /larger than/);
  // binary sniff
  await panelRequest(h.runtime, "takeover-read", "alice", "blob.bin");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().error, /binary/);
  // outside the work tree
  await panelRequest(h.runtime, "takeover-read", "alice", "../escape");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().error, /relative repository path/);
  // a read the daemon fenced off (non-holder) never reaches execAs with a foreign credential
  await panelRequest(h.runtime, "takeover-read", "bob", "src/a.ts");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().error, /held by alice/);
});

test("an editor write after a read rides the same fenced path and refreshes the session record", async () => {
  const h = panelHarness({ "src/a.ts": "old content\n" });
  await panelRequest(h.runtime, "takeover-acquire", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  await panelRequest(h.runtime, "takeover-read", "alice", "src/a.ts");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  const edited = h.replyOf().output.replace("old", "new");
  await panelRequest(h.runtime, "takeover-write", "alice", "src/a.ts", { content: edited });
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().output, /Wrote src\/a\.ts/);
  assert.equal(h.files["src/a.ts"], edited);
  assert.deepEqual(JSON.parse(h.values.get(takeoverKey("run-1"))!).pathsWritten, ["src/a.ts"]);
});

test("a lost lease during a panel read fails honestly instead of serving unowned bytes", async () => {
  const h = panelHarness({ "src/a.ts": "content" });
  await panelRequest(h.runtime, "takeover-acquire", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  (h.executor as any).lease.renew = async () => {
    throw new Error("no active generation 7 lease held by \"alice\" on run box-1");
  };
  await panelRequest(h.runtime, "takeover-read", "alice", "src/a.ts");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().error, /lease was lost/);
  assert.equal(h.values.get(takeoverKey("run-1")), "");
  const history = JSON.parse(h.values.get(takeoverHistoryKey("run-1"))!) as any[];
  assert.equal(history[0].outcome, "lapsed");
});

test("the browser tab dispatches actions through the fence, bounded, and records every op in the session", async () => {
  const h = panelHarness({});
  await panelRequest(h.runtime, "takeover-acquire", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  await panelRequest(h.runtime, "takeover-browser", "alice", undefined, { browser: JSON.stringify({ action: "navigate", url: "http://localhost:8000/" }) });
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  const reply = h.replyOf();
  assert.equal(reply.kind, "takeover-browser");
  assert.match(reply.output, /navigate http:\/\/localhost:8000\//);
  // the picture rides the artifact store; the reply carries only its id
  assert.equal(reply.browser.image, undefined);
  assert.match(reply.browser.artifact, /^[a-f0-9]{64}$/);
  const stored = await h.artifacts.get(reply.browser.artifact);
  assert.equal(stored?.mime, "image/png");
  assert.equal(stored?.data, fakePng("fake-png"), "the reference round-trips to the exact screenshot");
  assert.equal(reply.browser.url, "http://localhost:8000/");
  // fenced: the driver exec carried the holder credential, and the action rode base64 argv
  const exec = h.calls.find((c) => c.op === "execAs" && c.command.includes("browser-driver.mjs"))!;
  assert.deepEqual(exec.cred, { owner: "alice", generation: 7 });
  assert.match(exec.command, /exec node \.ship\/browser-driver\.mjs '[A-Za-z0-9+/=]+'/);
  // the op is session-recorded like a console command
  assert.deepEqual(JSON.parse(h.values.get(takeoverKey("run-1"))!).browserOps, ["navigate http://localhost:8000/"]);
  // a second action appends rather than dedupes — repeated clicks are real history
  await panelRequest(h.runtime, "takeover-browser", "alice", undefined, { browser: JSON.stringify({ action: "click", x: 40, y: 40 }) });
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.equal(h.replyOf().browser.url, "http://localhost:8000/clicked");
  assert.deepEqual(JSON.parse(h.values.get(takeoverKey("run-1"))!).browserOps, ["navigate http://localhost:8000/", "click 40,40"]);
});

test("the browser tab is holder-only, and a crafted request is re-validated at serve time", async () => {
  const h = panelHarness({});
  await panelRequest(h.runtime, "takeover-acquire", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  await panelRequest(h.runtime, "takeover-browser", "bob", undefined, { browser: JSON.stringify({ action: "navigate", url: "http://localhost:8000/" }) });
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().error, /held by alice/);
  // request-time guard: file:// never becomes a request at all
  await assert.rejects(
    panelRequest(h.runtime, "takeover-browser", "alice", undefined, { browser: JSON.stringify({ action: "navigate", url: "file:///etc/passwd" }) }),
    /http and https only/,
  );
  // defense in depth: a crafted request written straight to the key is refused at serve time, before any exec
  h.values.set(
    requestKey("run-1"),
    JSON.stringify({ id: "r-bad", runId: "run-1", kind: "takeover-browser", at: new Date().toISOString(), by: "alice", browser: { action: "navigate", url: "file:///etc/passwd" } }),
  );
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().error, /http and https only/);
  assert.equal(
    h.calls.some((c) => c.op === "execAs" && c.command.includes("browser-driver.mjs")),
    false,
    "a refused action never reaches the sandbox",
  );
  // an oversized crafted screenshot reply is an honest error, never a trimmed image
  h.values.set(
    requestKey("run-1"),
    JSON.stringify({ id: "r-big", runId: "run-1", kind: "takeover-browser", at: new Date().toISOString(), by: "alice", browser: { action: "navigate", url: "http://localhost:8000/" } }),
  );
  const realExecAs = (h.executor as any).lease.execAs;
  (h.executor as any).lease.execAs = async (_handle: string, cred: unknown, command: string) => {
    const r = await realExecAs(_handle, cred, command);
    return { ...r, stdout: JSON.stringify({ ok: true, action: "navigate", image: "A".repeat(400_001) }) + "\n" };
  };
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().error, /cap/);
});

test("handback closes the browser under the still-held lease and records the disposition", async () => {
  const h = panelHarness({});
  await panelRequest(h.runtime, "takeover-acquire", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  await panelRequest(h.runtime, "takeover-browser", "alice", undefined, { browser: JSON.stringify({ action: "navigate", url: "http://localhost:8000/" }) });
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  const steerNotes: string[] = [];
  (h.runtime as any).steer = { add: async (_runId: string, text: string) => { steerNotes.push(text); } };
  await panelRequest(h.runtime, "takeover-release", "alice", undefined, { reason: "clicked through the app" });
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().output, /Handed back/);
  // the close op ran as a fenced exec with the close action
  const closeB64 = Buffer.from(JSON.stringify({ action: "close" })).toString("base64");
  const close = h.calls.find((c) => c.op === "execAs" && c.command.includes("browser-driver.mjs") && c.command.includes(closeB64))!;
  assert.deepEqual(close.cred, { owner: "alice", generation: 7 });
  const history = JSON.parse(h.values.get(takeoverHistoryKey("run-1"))!) as any[];
  assert.deepEqual(history[0].browserOps, ["navigate http://localhost:8000/"]);
  assert.match(history[0].note, /browser closed, profile wiped/);
  // the steer note (handback) tells the resumed agent the browser was used
  assert.match(steerNotes[0], /Browser actions/);
});

test("a lapsed lease records the browser profile disposition honestly", async () => {
  const h = panelHarness({});
  await panelRequest(h.runtime, "takeover-acquire", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  await panelRequest(h.runtime, "takeover-browser", "alice", undefined, { browser: JSON.stringify({ action: "navigate", url: "http://localhost:8000/" }) });
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  (h.executor as any).lease.renew = async () => {
    throw new Error("no active generation 7 lease held by \"alice\" on run box-1");
  };
  await panelRequest(h.runtime, "takeover-browser", "alice", undefined, { browser: JSON.stringify({ action: "click", x: 1, y: 1 }) });
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().error, /lease was lost/);
  const history = JSON.parse(h.values.get(takeoverHistoryKey("run-1"))!) as any[];
  assert.equal(history[0].outcome, "lapsed");
  assert.deepEqual(history[0].browserOps, ["navigate http://localhost:8000/"]);
  assert.match(history[0].note, /browser profile left in place/);
});

// --- 2026-09-23 wave-9 live defect: an unstorable reply re-served forever ---

const browserExecs = (h: ReturnType<typeof panelHarness>): number =>
  h.calls.filter((c) => c.op === "execAs" && c.command.includes("browser-driver.mjs")).length;

test("a large screenshot never touches the config store — only its reference does", async () => {
  const h = panelHarness({});
  const big = Buffer.concat([PNG_MAGIC, Buffer.alloc(290_000, 7)]).toString("base64"); // ~387K chars, under the driver cap
  const configWrites: string[] = [];
  const realSet = (h.runtime as any).config.set;
  (h.runtime as any).config.set = async (k: string, v: string) => {
    configWrites.push(v);
    return realSet(k, v);
  };
  const realExecAs = (h.executor as any).lease.execAs;
  (h.executor as any).lease.execAs = async (handle: string, cred: unknown, command: string, o?: unknown, cb?: unknown) => {
    const r = await realExecAs(handle, cred, command, o, cb);
    if (!command.includes("browser-driver.mjs")) return r;
    return { ...r, stdout: JSON.stringify({ ok: true, action: "navigate", url: "http://localhost:8000/", width: 1280, height: 800, format: "png", image: big }) + "\n" };
  };
  await panelRequest(h.runtime, "takeover-acquire", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  await panelRequest(h.runtime, "takeover-browser", "alice", undefined, { browser: JSON.stringify({ action: "navigate", url: "http://localhost:8000/" }) });
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  for (const v of configWrites) assert.ok(Buffer.byteLength(v) <= WORKSPACE_ROW_BYTES_LIMIT, `config row of ${Buffer.byteLength(v)} bytes`);
  const reply = h.replyOf();
  assert.equal(reply.error, undefined);
  assert.equal((await h.artifacts.get(reply.browser.artifact))?.data, big, "the reference round-trips");
  assert.equal(reply.browser.bytes, 290_008);
});

test("a failed screenshot store is an error on the reply, not a retried action", async () => {
  const h = panelHarness({});
  (h.runtime as any).artifacts = { put: async () => { throw new Error("I/O error: disk full"); }, get: async () => null };
  await panelRequest(h.runtime, "takeover-acquire", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  await panelRequest(h.runtime, "takeover-browser", "alice", undefined, { browser: JSON.stringify({ action: "click", x: 3, y: 4 }) });
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.match(h.replyOf().error, /action ran, but its screenshot could not be stored \(I\/O error: disk full\)/);
  // the op happened and is on the session record; the takeover was not lapsed
  assert.deepEqual(JSON.parse(h.values.get(takeoverKey("run-1"))!).browserOps, ["click 3,4"]);
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  assert.equal(browserExecs(h), 1, "served once; later ticks see the reply and never re-click");
});

test("a reply whose write permanently fails is retried a bounded number of times, never re-executed, then recorded terminally", async () => {
  const h = panelHarness({});
  await panelRequest(h.runtime, "takeover-acquire", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  const ledger = new Map<string, PendingReply>();
  const realSet = (h.runtime as any).config.set;
  // The live shape: every write of the browser reply is refused.
  (h.runtime as any).config.set = async (k: string, v: string) => {
    if (k === takeoverReplyKey("run-1") && v.includes('"kind":"takeover-browser"') && !v.includes("could not be stored after"))
      throw new Error("I/O error: row too large for inline storage");
    return realSet(k, v);
  };
  await panelRequest(h.runtime, "takeover-browser", "alice", undefined, { browser: JSON.stringify({ action: "click", x: 1, y: 2 }) });
  const errors: string[] = [];
  for (let tick = 0; tick < REPLY_WRITE_ATTEMPTS + 3; tick++) {
    await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" }, ledger).catch((e: Error) => errors.push(e.message));
  }
  assert.equal(browserExecs(h), 1, "the action ran exactly once — retries re-deliver, they do not re-click");
  assert.equal(errors.length, REPLY_WRITE_ATTEMPTS, "bounded: one error per attempt, then silence");
  assert.match(errors.at(-1)!, /abandoned after 3 attempts; failure recorded/);
  const terminal = h.replyOf();
  assert.match(terminal.error, /could not be stored after 3 attempts \(I\/O error: row too large/);
  assert.equal(ledger.size, 0);
});

test("when even the terminal record cannot be stored, the request is cleared so it stops being served", async () => {
  const h = panelHarness({});
  await panelRequest(h.runtime, "takeover-acquire", "alice");
  await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" });
  const realSet = (h.runtime as any).config.set;
  (h.runtime as any).config.set = async (k: string, v: string) => {
    if (k === takeoverReplyKey("run-1") && v !== "") throw new Error("I/O error: failed to insert into fresh page");
    return realSet(k, v);
  };
  await panelRequest(h.runtime, "takeover-browser", "alice", undefined, { browser: JSON.stringify({ action: "click", x: 1, y: 2 }) });
  const errors: string[] = [];
  const ledger = new Map<string, PendingReply>();
  for (let tick = 0; tick < REPLY_WRITE_ATTEMPTS + 3; tick++) {
    await serveWorkspaceRequests(h.runtime, h.executor, { allowlist: "https://github.com" }, ledger).catch((e: Error) => errors.push(e.message));
  }
  assert.equal(errors.length, REPLY_WRITE_ATTEMPTS);
  assert.match(errors.at(-1)!, /could not be recorded either; request SHIP_WORKSPACE_REQUEST_run-1 cleared/);
  assert.equal(h.values.get(requestKey("run-1")), "", "the poisoned request is gone");
  assert.equal(browserExecs(h), 1);
});

test("one run's permanently failing reply does not starve another run's request in the same tick", async () => {
  const values = new Map<string, string>();
  const served: string[] = [];
  const runtime = {
    config: {
      list: async () => [...values.keys()].map((key) => ({ key })),
      get: async (k: string) => values.get(k),
      set: async (k: string, v: string) => {
        if (k === "SHIP_WORKSPACE_REPLY_run-a" && v !== "") throw new Error("I/O error: row too large for inline storage");
        values.set(k, v);
      },
    },
    loadMeta: async () => ASK,
    projects: { list: async () => [] },
    store: {
      load: async () => [
        { type: "run-started", data: { input: { repo: "https://github.com/team/repo" } } },
        { type: "step-completed", name: "sandbox", data: { result: "box" } },
      ],
    },
  } as never;
  const executor = {
    attach: (handle: string) => ({
      exec: async () => {
        served.push(handle);
        return { exitCode: 0, stdout: "a.ts", stderr: "", timedOut: false, truncated: false };
      },
    }),
  } as never;
  await requestWorkspace(runtime, "run-a", "files", "alice");
  await requestWorkspace(runtime, "run-b", "files", "alice");
  // run-a sorts first: its failure must not stop run-b in the SAME tick
  await assert.rejects(serveWorkspaceRequests(runtime, executor, { allowlist: "https://github.com" }, new Map()), /run-a/);
  assert.equal(JSON.parse(values.get("SHIP_WORKSPACE_REPLY_run-b")!).output, "a.ts");
});

test("the lapse sweep isolates records: an unreadable one does not stop an expired one from lapsing", async () => {
  const values = new Map<string, string>([
    ["SHIP_TAKEOVER_run-bad", "{}"],
    ["SHIP_TAKEOVER_run-old", JSON.stringify({ holder: "alice", generation: 1, expiresAt: new Date(0).toISOString(), acquiredAt: new Date(0).toISOString(), ttlSec: 60, pathsWritten: [], execsRun: [] })],
    ["SHIP_TAKEOVER_REPLY_run-old", "not json at all"],
  ]);
  const runtime = {
    config: {
      list: async () => [...values.keys()].sort().map((key) => ({ key })),
      get: async (k: string) => {
        if (k === "SHIP_TAKEOVER_run-bad") throw new Error("I/O error: page checksum");
        if (k.startsWith("SHIP_TAKEOVER_REPLY_")) throw new Error("reply rows must not be read by the lapse sweep");
        return values.get(k);
      },
      set: async (k: string, v: string) => void values.set(k, v),
    },
    store: { load: async () => [] },
  } as never;
  const failures = await sweepLapsedTakeovers(runtime, {} as never);
  assert.deepEqual(failures, ["SHIP_TAKEOVER_run-bad: I/O error: page checksum"]);
  assert.equal(values.get("SHIP_TAKEOVER_run-old"), "", "the expired record still lapsed");
  assert.equal(JSON.parse(values.get(takeoverHistoryKey("run-old"))!)[0].outcome, "lapsed");
});

test("fitReply: console output is trimmed under the row bound; an oversized editor read is refused, never shortened", () => {
  const at = new Date().toISOString();
  const escapes = '"\\\n'.repeat(5000); // 15000 chars that JSON-escape to 30000 bytes
  const fitted = fitReply({ id: "r", at, kind: "takeover-console", output: escapes + "TAIL" });
  assert.ok(Buffer.byteLength(JSON.stringify(fitted)) <= WORKSPACE_ROW_BYTES_LIMIT);
  assert.equal(fitted.truncated, true);
  assert.ok(fitted.output!.endsWith("TAIL"), "console keeps the tail");
  const read = fitReply({ id: "r", at, kind: "takeover-read", output: "y".repeat(20_000) });
  assert.equal(read.output, undefined);
  assert.match(read.error!, /too large to open in the editor/);
  const small = { id: "r", at, kind: "takeover-console" as const, output: "ok" };
  assert.equal(fitReply(small), small);
});

test("a request too large for its row is refused at request time, with a reason", async () => {
  const values = new Map<string, string>();
  const runtime = { config: { set: async (k: string, v: string) => void values.set(k, v) }, loadMeta: async () => ASK } as never;
  await assert.rejects(
    requestWorkspace(runtime, "run-1", "takeover-write", "alice", "big.txt", { content: "z".repeat(20_000) }),
    /too large to send through the workspace request store/,
  );
  assert.equal(values.size, 0);
});
