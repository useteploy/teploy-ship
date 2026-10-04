import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, mock, test } from "node:test";

import type { AgentExecutor, ExecResult } from "@neutron-build/agents";

import { executeAction } from "./agent.js";
import { runWebhookPayload, webhookNotifier } from "./notify.js";
import type { RunNotification } from "./notify.js";
import { observeToolCall, readShadowRecords, resetToolManifestShadow } from "./tool-manifest-shadow.js";
import { CursorTracker, EventDedupe, verifyEvent } from "./tool-manifest.js";
import type { ToolManifest } from "./tool-manifest.js";

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.js");

function tool(name: string, effects: string[]): Record<string, unknown> {
  return {
    name, input: { type: "object" }, output: { type: "object" },
    permissions: { effects, hosts: [], scopes: [] },
    secrets: [], secretTransport: "none", timeoutMs: 30_000, cancellation: "kill", approval: "never",
  };
}
const manifest = (tools: Record<string, unknown>[]): ToolManifest =>
  ({ schemaVersion: "1.0", name: "ship-loop", version: "1.0.0", tools }) as unknown as ToolManifest;

// ------------------------------------------------------------ webhook envelope

const EVENT: RunNotification = { runId: "run-1", status: "waiting", eventName: "turn-1-approval", eventSeq: 7, eventAt: "2026-10-04T10:00:00.000Z", task: "fix ünïcode" };

async function deliver(opts: { eventEnvelope?: boolean; secret?: string; event?: RunNotification }) {
  const seen: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  mock.method(Date, "now", () => 1_790_000_000_000);
  try {
    const n = webhookNotifier({ webhookUrl: "http://sink/hook", secret: opts.secret ?? "k", fetchImpl, log: () => {}, ...(opts.eventEnvelope !== undefined ? { eventEnvelope: opts.eventEnvelope } : {}) });
    assert.equal(await n.runEvent(opts.event ?? EVENT, "run-1:waiting:turn-1-approval:7"), true);
  } finally {
    mock.restoreAll();
  }
  assert.equal(seen.length, 1);
  return { url: seen[0]!.url, init: seen[0]!.init, headers: seen[0]!.init.headers as Record<string, string>, body: String(seen[0]!.init.body) };
}

afterEach(() => {
  delete process.env.SHIP_EVENT_ENVELOPE;
  delete process.env.SHIP_TOOL_MANIFEST;
  delete process.env.SHIP_TOOL_MANIFEST_FILE;
  delete process.env.SHIP_TOOL_MANIFEST_SHADOW_FILE;
  resetToolManifestShadow();
});

test("envelope flag off (default and explicit): the delivery is byte-identical to the pre-S24 shape", async () => {
  // Golden built WITHOUT the new code path: the exact headers and body the notifier sent before.
  const body = JSON.stringify(runWebhookPayload(EVENT, undefined));
  const ts = "1790000000";
  const golden = {
    "content-type": "application/json",
    "X-Teploy-Delivery": "run-1:waiting:turn-1-approval:7",
    "X-Teploy-Timestamp": ts,
    "X-Teploy-Signature": `sha256=${createHmac("sha256", "k").update(`${ts}.${body}`).digest("hex")}`,
  };
  for (const eventEnvelope of [undefined, false]) {
    const d = await deliver(eventEnvelope === undefined ? {} : { eventEnvelope });
    assert.equal(d.body, body);
    assert.deepEqual(d.headers, golden);
    assert.deepEqual(Object.keys(d.headers), Object.keys(golden), "same header order too");
  }
  // an unrecognised env value is also off
  process.env.SHIP_EVENT_ENVELOPE = "yes";
  assert.deepEqual((await deliver({})).headers, golden);
});

test("envelope flag on: body and existing headers unchanged, two extra headers verify with verifyEvent", async () => {
  const off = await deliver({ eventEnvelope: false });
  const on = await deliver({ eventEnvelope: true });
  assert.equal(on.body, off.body, "body is byte-identical");
  const { "X-Teploy-Event": ev, "X-Teploy-Event-Signature": evSig, ...rest } = on.headers;
  assert.deepEqual(rest, off.headers, "every pre-existing header is unchanged");
  assert.ok(ev !== undefined && evSig !== undefined);
  assert.match(ev!, /^[\x20-\x7e]+$/, "header value is ASCII");

  const dedupe = new EventDedupe();
  const cursors = new CursorTracker(6);
  const opts = { nowMs: 1_790_000_000_000, dedupe, cursors };
  const first = verifyEvent(ev!, { timestamp: on.headers["X-Teploy-Timestamp"]!, signature: evSig! }, "k", opts);
  assert.equal(first.ok, true);
  assert.ok(first.ok && !first.duplicate);
  if (first.ok && !first.duplicate) {
    assert.equal(first.event.eventId, "run-1:waiting:turn-1-approval:7");
    assert.equal(first.event.cursor, 7);
    assert.equal(first.event.type, "run.waiting");
    assert.equal((first.event.data as { payloadSha256: string }).payloadSha256, createHash("sha256").update(on.body).digest("hex"), "bound to the exact body");
  }
  assert.equal(cursors.resumeFrom, 7);
  // a retry of the same delivery is recognised as a duplicate
  const again = verifyEvent(ev!, { timestamp: on.headers["X-Teploy-Timestamp"]!, signature: evSig! }, "k", opts);
  assert.ok(again.ok && again.duplicate);
});

test("envelope: tamper, wrong secret and a body swap are all caught (negative controls)", async () => {
  const on = await deliver({ eventEnvelope: true });
  const h = { timestamp: on.headers["X-Teploy-Timestamp"]!, signature: on.headers["X-Teploy-Event-Signature"]! };
  const ev = on.headers["X-Teploy-Event"]!;
  const o = { nowMs: 1_790_000_000_000 };
  assert.deepEqual(verifyEvent(ev.replace('"cursor":7', '"cursor":8'), h, "k", o), { ok: false, reason: "bad-signature" });
  assert.deepEqual(verifyEvent(ev, h, "other", o), { ok: false, reason: "bad-signature" });
  // the BODY signature header must not verify the envelope (distinct MAC input)
  assert.deepEqual(verifyEvent(ev, { ...h, signature: on.headers["X-Teploy-Signature"]! }, "k", o), { ok: false, reason: "bad-signature" });
  // a different body no longer matches the bound hash
  const r = verifyEvent(ev, h, "k", o);
  assert.ok(r.ok && !r.duplicate);
  if (r.ok && !r.duplicate) assert.notEqual((r.event.data as { payloadSha256: string }).payloadSha256, createHash("sha256").update(on.body + " ").digest("hex"));
});

test("the examples/http-client.mjs verifyEvent port accepts Ship's real delivery, dedupes, and refuses tampering", async () => {
  // @ts-expect-error plain .mjs example with no declarations
  const client = (await import("../examples/http-client.mjs")) as { verifyEvent: Function; EventDedupe: new () => unknown };
  const on = await deliver({ eventEnvelope: true });
  const headers = Object.fromEntries(Object.entries(on.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const dedupe = new client.EventDedupe();
  const o = { nowMs: 1_790_000_000_000, dedupe };
  const first = client.verifyEvent(headers, on.body, "k", o);
  assert.ok(first.ok && !first.duplicate && first.event.cursor === 7);
  assert.ok(client.verifyEvent(headers, on.body, "k", o).duplicate, "retry is a duplicate");
  const fresh = { nowMs: 1_790_000_000_000 };
  assert.equal(client.verifyEvent(headers, on.body + " ", "k", fresh).reason, "body-mismatch");
  assert.equal(client.verifyEvent(headers, on.body, "wrong", fresh).reason, "bad-signature");
  assert.equal(client.verifyEvent({ ...headers, "x-teploy-event": headers["x-teploy-event"]!.replace('"cursor":7', '"cursor":9') }, on.body, "k", fresh).reason, "bad-signature");
  assert.equal(client.verifyEvent(headers, on.body, "k", { nowMs: 1_790_000_000_000 + 10 * 60_000 }).reason, "expired");
  const off = await deliver({ eventEnvelope: false });
  assert.equal(client.verifyEvent(Object.fromEntries(Object.entries(off.headers).map(([k, v]) => [k.toLowerCase(), v])), off.body, "k", fresh).reason, "no-envelope");
});

test("envelope is omitted when it cannot be honest: no secret, or no event_seq", async () => {
  const noSeq = await deliver({ eventEnvelope: true, event: { runId: "run-2", status: "failed" } });
  assert.equal(noSeq.headers["X-Teploy-Event"], undefined);
  const noSecret = await deliver({ eventEnvelope: true, secret: "" });
  assert.equal(noSecret.headers["X-Teploy-Event"], undefined);
  assert.equal(noSecret.headers["X-Teploy-Signature"], undefined);
});

test("SHIP_EVENT_ENVELOPE=on turns the headers on through the environment", async () => {
  process.env.SHIP_EVENT_ENVELOPE = "on";
  assert.ok((await deliver({})).headers["X-Teploy-Event"] !== undefined);
});

// ------------------------------------------------------------ tool shadow

const OK: ExecResult = { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, truncated: false };
function fakeExecutor(): AgentExecutor & { puts: string[] } {
  const puts: string[] = [];
  return {
    puts,
    async exec() { return OK; },
    async putFile(path: string) { puts.push(path); },
    async getFile() { return new Uint8Array(); },
    async destroy() {},
  } as unknown as AgentExecutor & { puts: string[] };
}

async function setup(m: unknown): Promise<{ dir: string; shadow: string }> {
  const dir = await mkdtemp(join(tmpdir(), "tm-shadow-"));
  await writeFile(join(dir, "manifest.json"), typeof m === "string" ? m : JSON.stringify(m));
  process.env.SHIP_TOOL_MANIFEST_FILE = join(dir, "manifest.json");
  process.env.SHIP_TOOL_MANIFEST_SHADOW_FILE = join(dir, "shadow.jsonl");
  return { dir, shadow: join(dir, "shadow.jsonl") };
}

test("shadow off (default): executeAction records nothing, even with a manifest configured", async () => {
  const { dir, shadow } = await setup(manifest([tool("bash", ["read"])]));
  try {
    const r = await executeAction(fakeExecutor(), { kind: "bash", code: "rm -rf x" });
    assert.deepEqual(r, OK);
    await observeToolCall({ kind: "bash", code: "x" });
    assert.deepEqual(await readdir(dir), ["manifest.json"], "no shadow file was created");
    process.env.SHIP_TOOL_MANIFEST = "off";
    await observeToolCall({ kind: "bash", code: "x" });
    assert.deepEqual(await readdir(dir), ["manifest.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shadow on the real executeAction path: findings are logged, the call is never blocked or altered", async () => {
  // bash declared read-only; edit declared read-only; create and python undeclared.
  const { dir, shadow } = await setup(manifest([tool("bash", ["read"]), tool("edit", ["read"])]));
  try {
    process.env.SHIP_TOOL_MANIFEST = "shadow";
    const ex = fakeExecutor();
    const outputs = [
      await executeAction(ex, { kind: "bash", code: "make" }),
      await executeAction(ex, { kind: "create", file: "a.txt", content: "hi" }),
    ];
    assert.equal(outputs[0], OK, "result object returned untouched");
    assert.match(outputs[1]!.stdout, /created a\.txt/, "the create still happened");
    assert.deepEqual(ex.puts, ["a.txt"]);
    await new Promise((r) => setTimeout(r, 50));
    const recs = await readShadowRecords(shadow);
    const kinds = recs.map((r) => (r.kind === "finding" ? `${r.tool}:${r.finding.kind}` : r.kind)).sort();
    // bash performed exec but declared only read; create is not declared at all.
    assert.deepEqual(kinds, ["bash:undeclared-effect", "create:unknown-tool"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shadow: a conforming call records nothing; an effect the manifest declares is not a finding", async () => {
  const { dir, shadow } = await setup(manifest([tool("bash", ["exec", "read"])]));
  try {
    process.env.SHIP_TOOL_MANIFEST = "shadow";
    await observeToolCall({ kind: "bash", code: "ls" });
    assert.deepEqual(await readShadowRecords(shadow), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shadow: write by a read-only declaration is classed write-when-read-only", async () => {
  const { dir, shadow } = await setup(manifest([tool("edit", ["read"])]));
  try {
    process.env.SHIP_TOOL_MANIFEST = "shadow";
    await observeToolCall({ kind: "edit" });
    const recs = await readShadowRecords(shadow);
    assert.equal(recs.length, 1);
    assert.ok(recs[0]!.kind === "finding" && recs[0]!.finding.kind === "write-when-read-only");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shadow: no manifest file configured records nothing; a bad manifest records ONE error, not a finding per call", async () => {
  const { dir, shadow } = await setup("{ not json");
  try {
    process.env.SHIP_TOOL_MANIFEST = "shadow";
    delete process.env.SHIP_TOOL_MANIFEST_FILE;
    await observeToolCall({ kind: "bash", code: "x" });
    assert.deepEqual(await readShadowRecords(shadow), []);
    process.env.SHIP_TOOL_MANIFEST_FILE = join(dir, "manifest.json");
    for (let i = 0; i < 3; i++) await observeToolCall({ kind: "bash", code: "x" });
    const recs = await readShadowRecords(shadow);
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.kind, "error");
    // invalid-but-parseable manifest (unknown field) is also an error, never trusted
    resetToolManifestShadow();
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ ...manifest([tool("bash", ["exec"])]), grants: ["all"] }));
    await observeToolCall({ kind: "bash", code: "x" });
    const after = await readShadowRecords(shadow);
    assert.equal(after.length, 2);
    assert.match((after[1] as { error: string }).error, /unknown field "grants"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shadow cannot fail the call: an unwritable shadow path is swallowed", async () => {
  const { dir } = await setup(manifest([tool("bash", ["read"])]));
  try {
    process.env.SHIP_TOOL_MANIFEST = "shadow";
    process.env.SHIP_TOOL_MANIFEST_SHADOW_FILE = join(dir, "manifest.json", "nope", "x.jsonl"); // parent is a file
    assert.deepEqual(await executeAction(fakeExecutor(), { kind: "bash", code: "x" }), OK);
    await observeToolCall({ kind: "bash", code: "x" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ CLI dry run

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string; home: string }> {
  const home = await mkdtemp(join(tmpdir(), "tool-cli-home-"));
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? "", HOME: home, XDG_STATE_HOME: home }, timeout: 60_000 });
    return { code: 0, stdout, stderr, home: (await readdir(home)).join(",") };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "", home: (await readdir(home)).join(",") };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("tool validate: valid manifest, grant intersection, excess reported, nothing persisted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-cli-"));
  try {
    const m = manifest([{ ...tool("list-issues", ["read", "network", "exec"]), permissions: { effects: ["read", "network", "exec"], hosts: ["api.forge.example", "evil.example"], scopes: ["issues:read", "admin"] } }]);
    await writeFile(join(dir, "m.json"), JSON.stringify(m));
    const before = await readdir(dir);
    const r = await cli(["tool", "validate", join(dir, "m.json"), "--grant", JSON.stringify({ effects: ["read", "network"], hosts: ["*.forge.example"], scopes: ["issues:read"] })]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /manifest: valid/);
    assert.match(r.stdout, /granted: effects read,network {2}hosts api\.forge\.example {2}scopes issues:read/);
    assert.match(r.stdout, /NOT granted: effects exec {2}hosts evil\.example {2}scopes admin/);
    assert.match(r.stdout, /nothing was installed, stored or enforced/);
    assert.deepEqual(await readdir(dir), before, "no files written next to the manifest");
    assert.equal(r.home, "", "no state written to the home/state directory");

    const json = await cli(["tool", "validate", join(dir, "m.json"), "--json"]);
    const report = JSON.parse(json.stdout);
    assert.equal(report.dryRun, true);
    assert.deepEqual(report.tools[0].granted, { effects: [], hosts: [], scopes: [] }, "no --grant grants nothing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tool validate: an invalid manifest exits 1 and grants nothing; a bad --grant is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tool-cli-"));
  try {
    await writeFile(join(dir, "bad.json"), JSON.stringify({ ...manifest([tool("a", ["read"])]), sudo: true }));
    const r = await cli(["tool", "validate", join(dir, "bad.json"), "--grant", '{"effects":["read"]}']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /INVALID/);
    assert.match(r.stdout, /unknown field "sudo"/);
    assert.doesNotMatch(r.stdout, /granted:/);
    const g = await cli(["tool", "validate", join(dir, "bad.json"), "--grant", '{"effects":"read"}']);
    assert.notEqual(g.code, 0);
    assert.match(g.stderr, /bad --grant/);
    const missing = await cli(["tool", "validate", join(dir, "nope.json")]);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /cannot read manifest/);
    assert.equal((await readFile(join(dir, "bad.json"), "utf8")).includes("sudo"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
