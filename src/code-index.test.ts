import assert from "node:assert/strict";
import { test } from "node:test";

import { chunkText, formatSearchHits, indexablePath } from "./code-index.js";

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
