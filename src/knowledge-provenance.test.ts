import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AdapterGenerateResult, ModelAdapter, Message } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import type { AgentExecutor } from "@neutron-build/agents";
import { MemoryEventStore, executeRun } from "@neutron-build/workflow";

import { durableAgent } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import { KnowledgeProvenance, knowledgeProvenanceMode, knowledgeScope } from "./knowledge-provenance.js";
import type { KnowledgeMode } from "./knowledge-provenance.js";
import { createRecord, verify } from "./knowledge-record.js";
import type { KnowledgeRecord } from "./knowledge-record.js";
import { FileKnowledgeStore, InMemoryKnowledgeStore, NucleusKnowledgeStore } from "./knowledge-store.js";
import type { KnowledgeStore } from "./knowledge-store.js";
import { condenseIfNeeded } from "./memory.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { FileRepoMemory, loadRepoContext } from "./repo-memory.js";
import { ScopedRepoMemory } from "./scoped-repo-memory.js";

const REPO = "https://github.com/tyler/app";
const REPO_URL = "https://github.com/tyler/app";

/** A fake Nucleus that understands exactly the statements NucleusKnowledgeStore issues. */
function fakeNucleus(options: { failList?: boolean } = {}): { db: NucleusPgwire; rows: Record<string, unknown>[]; sql: string[] } {
  const rows: Record<string, unknown>[] = [];
  const sql: string[] = [];
  const db = {
    async query(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
      sql.push(text);
      if (/^CREATE TABLE IF NOT EXISTS ship_knowledge_records/.test(text)) return [];
      if (/^INSERT INTO ship_knowledge_records/.test(text)) {
        rows.push({ record_id: params[0], repo: params[1], project: params[2], record: params[3] });
        return [];
      }
      if (/^DELETE FROM ship_knowledge_records WHERE record_id/.test(text)) {
        for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.record_id === params[0]) rows.splice(i, 1);
        return [];
      }
      if (/^SELECT record FROM ship_knowledge_records WHERE record_id/.test(text)) return rows.filter((r) => r.record_id === params[0]).map((r) => ({ record: r.record }));
      if (/^SELECT record FROM ship_knowledge_records WHERE repo/.test(text)) {
        if (options.failList) throw new Error("store down");
        return rows.filter((r) => r.repo === params[0]).map((r) => ({ record: r.record }));
      }
      throw new Error(`fakeNucleus cannot parse: ${text}`);
    },
  } as unknown as NucleusPgwire;
  return { db, rows, sql };
}

type StoreFactory = { name: string; make: () => Promise<KnowledgeStore> };
const factories: StoreFactory[] = [
  { name: "in-memory", make: async () => new InMemoryKnowledgeStore() },
  { name: "file", make: async () => new FileKnowledgeStore(await mkdtemp(join(tmpdir(), "kn-store-"))) },
  { name: "fake nucleus", make: async () => new NucleusKnowledgeStore(fakeNucleus().db) },
];

const sample = (id: string, extra: Partial<KnowledgeRecord> = {}): KnowledgeRecord => ({
  ...createRecord({
    id,
    kind: "hypothesis",
    statement: `statement ${id}`,
    source: { kind: "run", repo: REPO, revision: "abc", runId: "run-1" },
    scope: knowledgeScope(REPO),
    createdAt: "2026-10-04T00:00:00.000Z",
  }),
  ...extra,
});

for (const f of factories) {
  test(`${f.name} knowledge store: put/get/list/remove, putIfAbsent never overwrites, repos stay apart`, async () => {
    const store = await f.make();
    await store.put(sample("a"));
    assert.equal(await store.putIfAbsent(sample("a", { statement: "OVERWRITE" })), false);
    assert.equal(await store.putIfAbsent(sample("b")), true);
    assert.equal((await store.get("a"))?.statement, "statement a");
    await store.put(sample("c", { scope: knowledgeScope("github.com/other/repo") }));
    assert.deepEqual((await store.list(REPO)).map((r) => r.id).sort(), ["a", "b"]);
    await store.put(sample("a", { statement: "replaced" }));
    assert.equal((await store.list(REPO)).filter((r) => r.id === "a").length, 1, "put replaces, never duplicates");
    assert.equal((await store.get("a"))?.statement, "replaced");
    await store.remove("a");
    assert.equal(await store.get("a"), undefined);
    assert.deepEqual((await store.list(REPO)).map((r) => r.id), ["b"]);
  });
}

test("the nucleus store creates only a NEW table and never touches ship_memory", async () => {
  const { db, sql } = fakeNucleus();
  const store = new NucleusKnowledgeStore(db);
  await store.put(sample("a"));
  await store.list(REPO);
  assert.ok(sql.every((s) => /ship_knowledge_records/.test(s)), "every statement targets the new table");
  assert.ok(!sql.some((s) => /ALTER|DROP|ship_memory/i.test(s)));
});

test("a failed table ensure is retried, not cached", async () => {
  let creates = 0;
  const db = {
    async query(text: string): Promise<Record<string, unknown>[]> {
      if (text.startsWith("CREATE TABLE")) {
        creates++;
        if (creates === 1) throw new Error("transient");
      }
      return [];
    },
  } as unknown as NucleusPgwire;
  const store = new NucleusKnowledgeStore(db);
  await assert.rejects(store.list(REPO), /transient/);
  assert.deepEqual(await store.list(REPO), []);
  assert.equal(creates, 2);
});

test("knowledgeProvenanceMode: off unless explicitly shadow or on", () => {
  assert.equal(knowledgeProvenanceMode({}), "off");
  assert.equal(knowledgeProvenanceMode({ SHIP_KNOWLEDGE_PROVENANCE: "" }), "off");
  assert.equal(knowledgeProvenanceMode({ SHIP_KNOWLEDGE_PROVENANCE: "bogus" }), "off");
  assert.equal(knowledgeProvenanceMode({ SHIP_KNOWLEDGE_PROVENANCE: "shadow" }), "shadow");
  assert.equal(knowledgeProvenanceMode({ SHIP_KNOWLEDGE_PROVENANCE: " ON " }), "on");
});

async function rig(mode: KnowledgeMode | "none", opts: { store?: KnowledgeStore; plain?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "kn-rig-"));
  const raw = new FileRepoMemory(join(dir, "memory"));
  const store = opts.store ?? new InMemoryKnowledgeStore();
  const logs: string[] = [];
  const provenance = mode === "none" ? undefined : new KnowledgeProvenance({ mode, store, log: (l) => logs.push(l) });
  const memory = new ScopedRepoMemory(raw, new MemoryEventStore(), provenance);
  return { dir, raw, store, logs, memory };
}

test("default off: the stored note is byte-identical, no provenance is written, retrieval is untouched", async () => {
  const bare = await rig("none");
  const off = await rig("off");
  for (const r of [bare, off]) {
    await r.memory.record({ repo: REPO_URL, note: "n1", runId: "run-1", provenance: { revision: "abc" } });
  }
  const file = async (r: { dir: string }) => {
    const names = await readdir(join(r.dir, "memory"));
    return (await readFile(join(r.dir, "memory", names[0]!), "utf8")).replace(/"noteId":"[^"]+"/, "").replace(/"createdAt":"[^"]+"/, "");
  };
  assert.equal(await file(off), await file(bare));
  assert.ok(!(await file(off)).includes("provenance") && !(await file(off)).includes("abc"), "the hint never reaches the note");
  assert.deepEqual(await off.store.list(REPO), [], "mode off writes nothing");
  assert.equal(off.memory.provenanceMode(), "off");
  const ctx = { head: "zzz" };
  const a = await bare.memory.recent(REPO_URL, 5, { context: ctx });
  const b = await off.memory.recent(REPO_URL, 5, { context: ctx });
  assert.deepEqual(a.map((n) => [n.note, n.freshness]), b.map((n) => [n.note, n.freshness]));
  assert.ok(b.every((n) => n.freshness === undefined));
  assert.deepEqual(off.logs, []);
});

test("shadow: writes a hypothesis record alongside the note (run as source), note bytes unchanged", async () => {
  const s = await rig("shadow");
  const note = await s.memory.record({ repo: REPO_URL, note: "task → PR 1. done", runId: "run-9", provenance: { revision: "sha1" } });
  const rec = await s.store.get(note.noteId);
  assert.ok(rec);
  assert.equal(rec.kind, "hypothesis", "a model-written note is never born a fact");
  assert.deepEqual(rec.source, { kind: "run", repo: REPO, revision: "sha1", runId: "run-9" });
  assert.deepEqual(rec.scope, { repo: REPO, project: "" }, "project is optional: repo-only scope");
  assert.deepEqual(rec.derivedFrom, []);
  const stored = (await s.raw.recent(REPO, 5))[0]!;
  assert.deepEqual(Object.keys(stored).sort(), ["createdAt", "note", "noteId", "repo", "runId"]);
  // a dashboard note has no run: its source is a human, not a run
  const manual = await s.memory.record({ repo: REPO_URL, note: "manual" });
  assert.equal((await s.store.get(manual.noteId))?.source.kind, "human");
});

test("a provenance write failure never fails recording the note", async () => {
  const broken: KnowledgeStore = {
    put: async () => { throw new Error("boom"); },
    putIfAbsent: async () => { throw new Error("boom"); },
    get: async () => undefined,
    list: async () => { throw new Error("boom"); },
    remove: async () => undefined,
  };
  const s = await rig("on", { store: broken });
  const note = await s.memory.record({ repo: REPO_URL, note: "kept", runId: "r" });
  assert.equal((await s.raw.recent(REPO, 5))[0]?.noteId, note.noteId);
});

async function seeded(mode: KnowledgeMode) {
  const s = await rig(mode);
  const ids: Record<string, string> = {};
  for (const [name, revision] of [["current", "HEAD1"], ["old", "OLD"], ["norev", ""], ["poison", "HEAD1"]] as const) {
    ids[name] = (await s.memory.record({ repo: REPO_URL, note: name, runId: `run-${name}`, provenance: { revision } })).noteId;
  }
  // a note recorded before the flag: no provenance record at all
  ids.legacy = (await s.raw.record({ repo: REPO, note: "legacy" })).noteId;
  const poisoned = (await s.store.get(ids.poison!))!;
  await s.store.put({ ...poisoned, invalidated: { reason: "deleted source" } });
  return { ...s, ids };
}

test("on: invalidated notes are hidden, the rest labelled fresh|stale|unknown, legacy shown as unknown", async () => {
  const s = await seeded("on");
  const notes = await s.memory.recent(REPO_URL, 10, { context: { head: "HEAD1" } });
  const label = Object.fromEntries(notes.map((n) => [n.note, n.freshness]));
  assert.deepEqual(label, { current: "fresh", old: "stale", norev: "unknown", legacy: "unknown" });
  assert.ok(!("poison" in label), "invalidated provenance is never served");
});

test("on: freshness without a resolvable head is unknown, never fresh", async () => {
  const s = await seeded("on");
  const notes = await s.memory.recent(REPO_URL, 10, { context: {} });
  assert.ok(notes.every((n) => n.freshness === "unknown"));
});

test("on: the dashboard listing (no context) is never filtered, so a hidden note stays deletable", async () => {
  const s = await seeded("on");
  const all = await s.memory.recent(REPO_URL, 10);
  assert.equal(all.length, 5);
  assert.ok(all.every((n) => n.freshness === undefined));
});

test("on: a record outside the viewer's project is hidden; a derived record whose parent is missing is hidden", async () => {
  const s = await rig("on");
  const n = await s.memory.record({ repo: REPO_URL, note: "scoped elsewhere", runId: "r", provenance: { revision: "H", project: "proj-a" } });
  const d = await s.memory.record({ repo: REPO_URL, note: "orphan", runId: "r2", provenance: { revision: "H" } });
  await s.store.put({ ...(await s.store.get(d.noteId))!, derivedFrom: ["missing-parent"] });
  assert.ok(n.noteId);
  assert.deepEqual(await s.memory.recent(REPO_URL, 10, { context: { head: "H" } }), [], "repo-only viewer sees neither");
});

test("on: an unreadable provenance store fails closed (no notes); shadow fails open and logs", async () => {
  const { db } = fakeNucleus({ failList: true });
  for (const [mode, expected] of [["on", 0], ["shadow", 1]] as const) {
    const s = await rig(mode, { store: new NucleusKnowledgeStore(db) });
    await s.raw.record({ repo: REPO, note: "x" });
    const notes = await s.memory.recent(REPO_URL, 5, { context: { head: "H" } });
    assert.equal(notes.length, expected, mode);
    assert.ok(s.logs.some((l) => l.includes("knowledge-provenance-error")), `${mode} logs the failure`);
  }
});

test("shadow: retrieval is IDENTICAL to off, and the log says what on would have done", async () => {
  const shadow = await seeded("shadow");
  const off = await rig("none");
  for (const n of ["current", "old", "norev", "poison"]) await off.raw.record({ repo: REPO, note: n });
  await off.raw.record({ repo: REPO, note: "legacy" });
  const a = (await shadow.memory.recent(REPO_URL, 10, { context: { head: "HEAD1" } })).map((n) => [n.note, n.freshness]);
  const b = (await off.memory.recent(REPO_URL, 10, { context: { head: "HEAD1" } })).map((n) => [n.note, n.freshness]);
  assert.deepEqual(a.sort(), b.sort());
  assert.ok(a.some(([note]) => note === "poison"), "the invalidated note is still served in shadow");
  const decision = JSON.parse(shadow.logs.at(-1)!);
  assert.equal(decision.event, "knowledge-provenance");
  assert.equal(decision.mode, "shadow");
  assert.deepEqual(decision.wouldHide.map((h: { noteId: string }) => h.noteId), [shadow.ids.poison]);
  assert.match(decision.wouldHide[0].reason, /invalidated: deleted source/);
  assert.equal(decision.wouldLabel[shadow.ids.current!], "fresh");
  assert.equal(decision.wouldLabel[shadow.ids.old!], "stale");
  assert.deepEqual(decision.unrecorded, [shadow.ids.legacy]);
});

function execStub(head: string | null): AgentExecutor {
  return {
    exec: async (cmd: string) => {
      if (cmd.startsWith("git rev-parse")) return head === null ? { exitCode: 128, stdout: "", stderr: "x" } : { exitCode: 0, stdout: `${head}\n`, stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "" };
    },
  } as unknown as AgentExecutor;
}

test("loadRepoContext: labels only with on; shadow and off produce the same bytes as before", async () => {
  const contexts: Record<string, string> = {};
  for (const mode of ["none", "off", "shadow", "on"] as const) {
    const s = await seeded(mode === "none" ? "off" : mode);
    const memory = mode === "none" ? new ScopedRepoMemory(s.raw, new MemoryEventStore()) : s.memory;
    contexts[mode] = (await loadRepoContext(execStub("HEAD1"), { repo: REPO_URL, memory })).replace(/\[\d{4}-\d\d-\d\d\]/g, "[d]");
  }
  assert.equal(contexts.off, contexts.none);
  assert.equal(contexts.shadow, contexts.none.replace(/^/, ""), "shadow does not change what the model reads");
  assert.ok(!/\((fresh|stale|unknown)\)/.test(contexts.shadow!));
  assert.match(contexts.on!, /\[d\] \(fresh\) current/);
  assert.match(contexts.on!, /\[d\] \(stale\) old/);
  assert.ok(!contexts.on!.includes("poison"));
});

test("loadRepoContext in on mode: no git head means every note reads unknown", async () => {
  const s = await seeded("on");
  const text = await loadRepoContext(execStub(null), { repo: REPO_URL, memory: s.memory });
  assert.ok(!/\((fresh|stale)\)/.test(text));
  assert.match(text, /\(unknown\) current/);
});

test("redaction: deleting a note removes its record, invalidates summaries, deletes embeddings; they are never served", async () => {
  const s = await rig("on");
  const n = await s.memory.record({ repo: REPO_URL, note: "secret", runId: "r1", provenance: { revision: "H" } });
  const keep = await s.memory.record({ repo: REPO_URL, note: "other", runId: "r2", provenance: { revision: "H" } });
  await s.memory.recordSummary({ id: "summary-1", repo: REPO_URL, runId: "r3", summary: "recap of secret", derivedFrom: [n.noteId] });
  await s.store.put({ ...createRecord({ id: "emb-1", kind: "hypothesis", statement: "vec", source: { kind: "agent-claim", repo: REPO, revision: "" }, scope: knowledgeScope(REPO), createdAt: "t", derivedFrom: [n.noteId], derivation: "embedding" }) });

  await s.memory.remove(n.noteId, REPO_URL);

  assert.deepEqual((await s.raw.recent(REPO, 10)).map((x) => x.noteId), [keep.noteId], "the note itself is gone");
  assert.equal(await s.store.get(n.noteId), undefined);
  assert.equal(await s.store.get("emb-1"), undefined, "embeddings cannot be edited down: deleted");
  const summary = await s.store.get("summary-1");
  assert.ok(summary?.invalidated, "summary kept for audit but flagged");
  assert.ok((await s.store.get(keep.noteId)) !== undefined, "unrelated records untouched");
  const served = await s.memory.recent(REPO_URL, 10, { context: { head: "H" } });
  assert.deepEqual(served.map((x) => x.note), ["other"]);
});

test("redaction cascades from a note with NO provenance record when the repo is given", async () => {
  const s = await rig("on");
  const legacy = await s.raw.record({ repo: REPO, note: "predates the flag" });
  await s.memory.recordSummary({ id: "summary-L", repo: REPO_URL, runId: "r", summary: "recap", derivedFrom: [legacy.noteId] });
  await s.memory.remove(legacy.noteId, REPO_URL);
  assert.ok((await s.store.get("summary-L"))?.invalidated);
});

test("redaction runs in shadow too (a shadow record holds the deleted text); a failure is logged, not thrown", async () => {
  const s = await rig("shadow");
  const n = await s.memory.record({ repo: REPO_URL, note: "gone", runId: "r" });
  await s.memory.remove(n.noteId, REPO_URL);
  assert.equal(await s.store.get(n.noteId), undefined);

  const failing: KnowledgeStore = { ...new InMemoryKnowledgeStore(), put: async () => undefined, putIfAbsent: async () => true, get: async () => { throw new Error("down"); }, list: async () => [], remove: async () => undefined };
  const sh = await rig("shadow", { store: failing });
  const m = await sh.raw.record({ repo: REPO, note: "k" });
  await sh.memory.remove(m.noteId, REPO_URL);
  assert.deepEqual(await sh.raw.recent(REPO, 5), [], "the note is still deleted");
  const on = await rig("on", { store: failing });
  const m2 = await on.raw.record({ repo: REPO, note: "k2" });
  await assert.rejects(on.memory.remove(m2.noteId, REPO_URL), /down/, "on does not swallow a redaction failure");
});

test("redaction does nothing with provenance off", async () => {
  const s = await rig("off");
  const n = await s.memory.record({ repo: REPO_URL, note: "x" });
  await s.memory.remove(n.noteId, REPO_URL);
  assert.deepEqual(await s.raw.recent(REPO, 5), []);
});

test("a condenser summary is a derived agent claim: a hypothesis, idempotent, and unusable as evidence", async () => {
  const s = await rig("shadow");
  const n = await s.memory.record({ repo: REPO_URL, note: "src", runId: "r1" });
  await s.memory.recordSummary({ id: "summary-r-1", repo: REPO_URL, runId: "r", summary: "first", derivedFrom: [n.noteId] });
  await s.memory.recordSummary({ id: "summary-r-1", repo: REPO_URL, runId: "r", summary: "replay", derivedFrom: [] });
  const sum = (await s.store.get("summary-r-1"))!;
  assert.equal(sum.derivation, "summary");
  assert.equal(sum.kind, "hypothesis");
  assert.equal(sum.source.kind, "agent-claim");
  assert.deepEqual(sum.derivedFrom, [n.noteId]);
  assert.equal(sum.statement, "first", "a replayed run does not overwrite the first record");
  // it cannot verify another claim: evidence that cites a record is refused
  const target = (await s.store.get(n.noteId))!;
  const res = verify(target, [{ kind: "run", repo: REPO, revision: "x", runId: "other", recordId: sum.id }]);
  assert.equal(res.verified, false);
  // nor can it be promoted without evidence
  assert.equal(verify(sum, []).verified, false);
});

test("condenseIfNeeded: the observer sees the summary; messages are identical with or without it; a throw is swallowed", async () => {
  const messages: Message[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "task" },
    ...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} ${"x".repeat(200)}` }) as Message),
  ];
  const cfg = { maxTokens: 100, keepRecent: 4, maxSummaryLayers: 3 };
  const summarize = async () => "RECAP";
  const plain = await condenseIfNeeded(messages, summarize, cfg);
  const seen: { summary: string; condensed: number }[] = [];
  const observed = await condenseIfNeeded(messages, summarize, cfg, (i) => { seen.push(i); });
  assert.deepEqual(observed, plain);
  assert.deepEqual(seen, [{ summary: "RECAP", condensed: 26 }]);
  const thrown = await condenseIfNeeded(messages, summarize, cfg, () => { throw new Error("nope"); });
  assert.deepEqual(thrown, plain);
  const under = await condenseIfNeeded(messages, summarize, { ...cfg, maxTokens: 10_000_000 }, (i) => { seen.push(i); });
  assert.equal(under, messages);
  assert.equal(seen.length, 1, "no summary, no callback");
});

// ---- the real call path: a durable repo run ---------------------------------

async function repoRun(mode: KnowledgeMode | "none") {
  const bareDir = await mkdtemp(join(tmpdir(), "kn-bare-"));
  const seedDir = await mkdtemp(join(tmpdir(), "kn-seed-"));
  const seeder = new LocalExecutor({ root: seedDir });
  await seeder.exec(
    `git init -q -b main . && git config user.email t@t && git config user.name t && printf 'Run tests with make check-42.\\n' > SHIP.md && git add -A && git commit -qm seed && git clone -q --bare . ${bareDir}/owner/repo.git`,
  );
  const r = await rig(mode);
  await r.memory.record({ repo: "file:///owner/repo", note: "previously fixed the parser", runId: "old-run", provenance: { revision: "0000000" } });
  const prompts: string[] = [];
  const model: ModelAdapter = {
    provider: "scripted",
    modelId: "s1",
    async doGenerate(options): Promise<AdapterGenerateResult> {
      prompts.push(String(options.messages[0]?.content ?? ""));
      const finishes = options.messages.filter((m) => typeof m.content === "string" && m.content.includes("Before finishing")).length;
      const asst = options.messages.filter((m) => m.role === "assistant").length;
      const text = asst === 0 ? "```bash\ntrue\n```" : finishes > 0 ? "```finish\nnothing to change\n```" : "```bash\ntrue\n```";
      return { content: [{ type: "text", text }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
    },
    async *doStream() { throw new Error("unused"); },
  };
  const work = await mkdtemp(join(tmpdir(), "kn-work-"));
  const provider: ExecutorProvider = { async create() { return { handle: work }; }, attach: (handle: string) => new LocalExecutor({ root: handle }) };
  const wf = durableAgent({ model, executor: provider, workdir: ".", repoMemory: r.memory });
  const store = new MemoryEventStore();
  const outcome = await executeRun({ workflow: wf, runId: "run-kn", store, input: { task: "check the build", repo: `file://${bareDir}/owner/repo.git` } });
  assert.equal(outcome.status, "completed");
  const steps = (await store.load("run-kn")).filter((e) => e.type === "step-completed").map((e) => (e as { name: string }).name);
  return { ...r, prompts, steps };
}

test("durable repo run: off, shadow and on share one step sequence; shadow's prompt equals off's; publish records the run as source", async () => {
  const off = await repoRun("none");
  const shadow = await repoRun("shadow");
  const on = await repoRun("on");
  assert.deepEqual(shadow.steps, off.steps, "durable step names and order are unchanged");
  assert.deepEqual(on.steps, off.steps);
  assert.equal(shadow.prompts[0], off.prompts[0], "shadow never changes what the model reads");
  assert.match(on.prompts[0]!, /previously fixed the parser/);
  assert.match(on.prompts[0]!, /\((fresh|stale|unknown)\) previously fixed the parser/);
  assert.ok(!/\((fresh|stale|unknown)\) previously/.test(shadow.prompts[0]!));

  for (const r of [shadow, on]) {
    const recs = await r.store.list("file:///owner/repo");
    const published = recs.find((x) => x.source.runId === "run-kn");
    assert.ok(published, "the publish note has a provenance record");
    assert.equal(published.kind, "hypothesis");
    assert.equal(published.source.kind, "run");
  }
  assert.deepEqual(await off.store.list("file:///owner/repo"), [], "off writes no records");
  assert.ok(shadow.logs.some((l) => l.includes('"event":"knowledge-provenance"')), "shadow logged its would-be decision");
});

test("screen() itself never alters the list in shadow, even for invalidated or unrecorded notes", async () => {
  const store = new InMemoryKnowledgeStore();
  const logs: string[] = [];
  const shadow = new KnowledgeProvenance({ mode: "shadow", store, log: (l) => logs.push(l) });
  const base = { repo: REPO, createdAt: "t" };
  await store.put({ ...sample("bad"), invalidated: { reason: "r" } });
  const notes = [
    { ...base, noteId: "bad", note: "bad" },
    { ...base, noteId: "unrecorded", note: "u" },
  ];
  const out = await shadow.screen(REPO, notes, { head: "abc" });
  assert.deepEqual(out, notes);
  assert.ok(out.every((n) => !("freshness" in n)), "no label leaks into shadow output");
  assert.equal(logs.length, 1);
});
