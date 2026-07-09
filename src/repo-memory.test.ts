import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalExecutor } from "@neutron-build/agents";

import { FileRepoMemory, loadRepoContext, runNote } from "./repo-memory.js";

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
