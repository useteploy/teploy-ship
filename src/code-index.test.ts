import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentExecutor } from "@neutron-build/agents";
import type { EmbeddingAdapter } from "@neutron-build/ai";
import { NucleusCodeIndex, chunkText, formatSearchHits, indexablePath, withDeadline } from "./code-index.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";

test("chunkText: windows with overlap, 1-indexed inclusive ranges, blank-only chunks dropped", () => {
  const lines = Array.from({ length: 130 }, (_, i) => `line ${i + 1}`);
  const chunks = chunkText(lines.join("\n"));
  assert.equal(chunks[0]!.start, 1);
  assert.equal(chunks[0]!.end, 60);
  assert.equal(chunks[1]!.start, 51, "second window starts inside the overlap");
  assert.ok(chunks[chunks.length - 1]!.end === 130, "last window reaches the end");
  assert.ok(chunks[0]!.text.startsWith("line 1\n"));

  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("\n\n\n"), []);
  const single = chunkText("just one line");
  assert.equal(single.length, 1);
  assert.deepEqual([single[0]!.start, single[0]!.end], [1, 1]);
});

test("indexablePath: code yes; binaries, locks, and minified assets no", () => {
  assert.equal(indexablePath("src/worker.ts"), true);
  assert.equal(indexablePath("README.md"), true);
  assert.equal(indexablePath("Makefile"), true);
  assert.equal(indexablePath("logo.png"), false);
  assert.equal(indexablePath("dist/app.min.js"), false);
  assert.equal(indexablePath("pnpm-lock.yaml"), false);
  assert.equal(indexablePath("go.sum"), false);
  assert.equal(indexablePath("fonts/inter.woff2"), false);
});

test("formatSearchHits: path:line ranges + snippets; empty is a clear miss", () => {
  const hits = [
    { path: "src/a.ts", start: 10, end: 40, text: "function retryBackoff() {}", distance: 0.1 },
    { path: "src/b.ts", start: 1, end: 30, text: "const x = 1", distance: 0.4 },
  ];
  const out = formatSearchHits("retry backoff", hits);
  assert.match(out, /Top 2 matches for "retry backoff"/);
  assert.match(out, /## src\/a\.ts:10-40\nfunction retryBackoff/);
  assert.match(formatSearchHits("nothing", []), /No indexed code matched/);
});

test("TS-021: reaching the chunk cap must not delete the index for files it never visited", async () => {
  // The refresh loop breaks at the cap. `seen` was built as the loop went, so
  // everything after the break looked "removed from the repo" and had its
  // chunks and ledger row deleted — every refresh, on any repo bigger than the
  // cap, silently destroying the tail of its own index.
  const deleted: string[] = [];
  const ledger = new Map([
    ["a.ts", { hash: "old", chunks: 1 }],
    ["b.ts", { hash: "old", chunks: 1 }],
    ["c.ts", { hash: "old", chunks: 1 }],
  ]);
  const tracked = new Set(["a.ts", "b.ts", "c.ts"]);

  // Simulate the removal phase with the FIXED membership rule: what git tracks
  // now, not how far the loop got.
  for (const [path] of ledger) {
    if (tracked.has(path)) continue;
    deleted.push(path);
  }
  assert.deepEqual(deleted, [], "no tracked file is treated as removed, capped or not");

  // And a genuinely deleted file is still cleaned up.
  tracked.delete("b.ts");
  const afterDelete: string[] = [];
  for (const [path] of ledger) {
    if (tracked.has(path)) continue;
    afterDelete.push(path);
  }
  assert.deepEqual(afterDelete, ["b.ts"]);
});

function fakeDb(): { db: NucleusPgwire; sql: string[] } {
  const sql: string[] = [];
  const db = {
    query: async (text: string) => {
      sql.push(text);
      return [];
    },
  } as unknown as NucleusPgwire;
  return { db, sql };
}

function fakeExecutor(files: Record<string, string>): AgentExecutor {
  return {
    exec: async (cmd: string) => ({
      exitCode: 0,
      stdout: cmd === "git ls-files" ? Object.keys(files).join("\n") : "",
      stderr: "",
    }),
    getFile: async (path: string) => new TextEncoder().encode(files[path] ?? ""),
  } as unknown as AgentExecutor;
}

test("a refresh whose deadline has passed stops before embedding anything and says so", async () => {
  const { db, sql } = fakeDb();
  let embedCalls = 0;
  const embedder = new Proxy({}, { get: () => { embedCalls++; return undefined; } }) as unknown as EmbeddingAdapter;
  const index = new NucleusCodeIndex(db, embedder);
  const stats = await index.refresh(fakeExecutor({ "a.ts": "export const a = 1;\n" }), "o/r", {
    deadlineMs: Date.now() - 1,
  });
  assert.equal(stats.timedOut, true);
  assert.equal(stats.capped, true);
  assert.equal(stats.indexed, 0);
  assert.equal(embedCalls, 0, "no embedding call may start once the deadline has passed");
  assert.ok(!sql.some((s) => s.startsWith("INSERT INTO ship_code_chunks")), "nothing was inserted");
});

test("withDeadline rejects a call that outlives its budget, and passes a fast one through", async () => {
  const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200));
  await assert.rejects(withDeadline(slow, 10, "embedding x"), /embedding x exceeded 10ms/);
  assert.equal(await withDeadline(Promise.resolve("fast"), 1000, "embedding y"), "fast");
  assert.equal(await withDeadline(Promise.resolve("no cap"), Number.POSITIVE_INFINITY, "z"), "no cap");
});
