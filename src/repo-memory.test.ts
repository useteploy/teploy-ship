import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalExecutor } from "@neutron-build/agents";

import { repoKeyOf } from "./durable.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { FileRepoMemory, NucleusRepoMemory, loadRepoContext, runNote } from "./repo-memory.js";

async function fresh(): Promise<LocalExecutor> {
  return new LocalExecutor({ root: await mkdtemp(join(tmpdir(), "repo-mem-")) });
}

test("repo memory: records and returns most-recent-first, repo-scoped", async () => {
  const memory = new FileRepoMemory(await mkdtemp(join(tmpdir(), "mem-store-")));
  await memory.record({ repo: "o/a", note: "first", runId: "r1" });
  await memory.record({ repo: "o/a", note: "second", runId: "r2" });
  await memory.record({ repo: "o/b", note: "other repo" });

  const notes = await memory.recent("o/a", 5);
  assert.deepEqual(notes.map((n) => n.note), ["second", "first"]);
  assert.equal((await memory.recent("o/a", 1)).length, 1);
  assert.deepEqual((await memory.recent("o/b", 5)).map((n) => n.note), ["other repo"]);
  assert.deepEqual(await memory.recent("o/none", 5), []);
});

test("loadRepoContext: playbook from the tree + notes; empty when neither exists", async () => {
  // neither playbook nor notes -> empty string (no noise in the prompt)
  const bare = await fresh();
  assert.equal(await loadRepoContext(bare, { repo: "o/r" }), "");

  // SHIP.md wins and is injected verbatim under the playbook header
  const withPlaybook = await fresh();
  await withPlaybook.putFile("SHIP.md", "Run tests with `make check`. Never touch vendored/.");
  const context = await loadRepoContext(withPlaybook, { repo: "o/r" });
  assert.match(context, /Repository playbook \(SHIP\.md\)/);
  assert.match(context, /make check/);

  // .ship/playbook.md is the fallback location
  const withHidden = await fresh();
  await withHidden.putFile(".ship/playbook.md", "hidden playbook rules");
  assert.match(await loadRepoContext(withHidden, { repo: "o/r" }), /hidden playbook rules/);

  // ecosystem conventions are read too: AGENTS.md, CLAUDE.md, copilot-instructions
  const withAgents = await fresh();
  await withAgents.putFile("AGENTS.md", "agents.md conventions here");
  assert.match(await loadRepoContext(withAgents, { repo: "o/r" }), /Repository playbook \(AGENTS\.md\)[\s\S]*agents\.md conventions/);
  const withCopilot = await fresh();
  await withCopilot.putFile(".github/copilot-instructions.md", "copilot rules");
  assert.match(await loadRepoContext(withCopilot, { repo: "o/r" }), /copilot rules/);

  // SHIP.md outranks the ecosystem files when both exist
  const withBoth = await fresh();
  await withBoth.putFile("AGENTS.md", "generic agent rules");
  await withBoth.putFile("SHIP.md", "ship-specific rules");
  const picked = await loadRepoContext(withBoth, { repo: "o/r" });
  assert.match(picked, /ship-specific rules/);
  assert.doesNotMatch(picked, /generic agent rules/);

  // notes are appended when a memory store is supplied
  const memory = new FileRepoMemory(await mkdtemp(join(tmpdir(), "mem-ctx-")));
  await memory.record({ repo: "o/r", note: "fixed the login bug → PR #1" });
  const both = await loadRepoContext(withPlaybook, { repo: "o/r", memory });
  assert.match(both, /make check/);
  assert.match(both, /recent history/);
  assert.match(both, /login bug/);

  // oversized playbooks are capped, not dropped
  const big = await fresh();
  await big.putFile("SHIP.md", "x".repeat(10_000));
  const capped = await loadRepoContext(big, { repo: "o/r" });
  assert.ok(capped.length < 5000);
  assert.match(capped, /playbook truncated/);
});

test("runNote compacts task/summary and names the outcome", () => {
  const withPr = runNote({ task: "fix\nthe   bug", summary: "did  it\nwell", pr: "http://x/pulls/9" });
  assert.match(withPr, /fix the bug → PR http:\/\/x\/pulls\/9\. did it well/);
  const noPr = runNote({ task: "t", summary: "s" });
  assert.match(noPr, /no PR \(empty diff\)/);
});

test("TS-047: notes are removed by id, so same-millisecond siblings survive", async () => {
  const store = new FileRepoMemory(await mkdtemp(join(tmpdir(), "repo-mem-id-")));
  const repo = "forge.test/tyler/ship";

  // Two runs finishing together write two notes with the same timestamp.
  const a = await store.record({ repo, note: "first run" });
  const b = await store.record({ repo, note: "second run" });
  assert.notEqual(a.noteId, b.noteId, "each note gets its own identity");

  await store.remove(a.noteId);
  const left = await store.recent(repo, 10);
  assert.equal(left.length, 1, "deleting one note deletes exactly one note");
  assert.equal(left[0]?.note, "second run");
});

test("TS-022: repository scope includes the origin, so two hosts do not share memory", async () => {
  const store = new FileRepoMemory(await mkdtemp(join(tmpdir(), "repo-mem-origin-")));
  await store.record({ repo: "github.com/tyler/ship", note: "public repo history" });
  await store.record({ repo: "100.108.123.49:49152/tyler/ship", note: "private mirror history" });

  const publicNotes = await store.recent("github.com/tyler/ship", 10);
  assert.deepEqual(publicNotes.map((n) => n.note), ["public repo history"]);

  const privateNotes = await store.recent("100.108.123.49:49152/tyler/ship", 10);
  assert.deepEqual(privateNotes.map((n) => n.note), ["private mirror history"]);
});

test("repoKeyOf keeps same-path repositories on different hosts apart", () => {
  assert.notEqual(repoKeyOf("https://github.com/tyler/ship"), repoKeyOf("http://100.108.123.49:49152/tyler/ship"));
  assert.equal(repoKeyOf("https://github.com/tyler/ship.git"), repoKeyOf("https://github.com/tyler/ship"));
});

test("nucleus memory: a failed table ensure is retried, not cached for the process", async () => {
  // Seam: the first CREATE fails (a transient engine error), every later call
  // must try again instead of replaying the rejection forever. Found live —
  // /knowledge 500'd on every request after one I/O error at startup.
  let calls = 0;
  const db = {
    async query(sql: string): Promise<Record<string, unknown>[]> {
      if (sql.startsWith("CREATE TABLE")) {
        calls++;
        if (calls === 1) throw new Error("catalog persistence failed: I/O error");
        return [];
      }
      return [{ repo: "o/a" }];
    },
  } as unknown as NucleusPgwire;
  const memory = new NucleusRepoMemory(db);
  await assert.rejects(memory.repos(), /catalog persistence failed/);
  assert.deepEqual(await memory.repos(), [{ repo: "o/a", count: 1 }]);
  assert.equal(calls, 2);
});
