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

/**
 * A NucleusPgwire fake that actually STORES rows.
 *
 * The previous TS-021 test re-implemented the removal rule in its own body and
 * asserted against its own copy: deleting the fix in code-index.ts left it
 * green. A regression test that cannot fail when the code regresses is worse
 * than no test, because it reads as coverage. This fake understands exactly
 * the statements refresh() issues, so the test below drives the real function.
 */
function storingDb(): { db: NucleusPgwire; files: Map<string, { hash: string; chunks: string }>; chunks: Set<string> } {
  const files = new Map<string, { hash: string; chunks: string }>();
  const chunks = new Set<string>();
  const key = (repo: string, path: string): string => `${repo}\u0000${path}`;
  const db = {
    query: async (text: string, params: unknown[] = []): Promise<Array<Record<string, unknown>>> => {
      const sql = text.trim();
      if (sql.startsWith("CREATE ")) return [];
      if (sql.startsWith("SELECT path, hash, chunks FROM ship_code_files")) {
        const repo = String(params[0]);
        return [...files.entries()]
          .filter(([k]) => k.startsWith(`${repo}\u0000`))
          .map(([k, v]) => ({ path: k.split("\u0000")[1], hash: v.hash, chunks: v.chunks }));
      }
      if (sql.startsWith("DELETE FROM ship_code_files")) {
        files.delete(key(String(params[0]), String(params[1])));
        return [];
      }
      if (sql.startsWith("INSERT INTO ship_code_files")) {
        files.set(key(String(params[0]), String(params[1])), { hash: String(params[2]), chunks: String(params[3]) });
        return [];
      }
      if (sql.startsWith("DELETE FROM ship_code_chunks")) {
        chunks.delete(String(params[0]));
        return [];
      }
      if (sql.startsWith("INSERT INTO ship_code_chunks")) {
        chunks.add(String(params[0]));
        return [];
      }
      return [];
    },
  } as unknown as NucleusPgwire;
  return { db, files, chunks };
}

/** An embedder that returns a fixed-dimension vector per value, and counts calls. */
function countingEmbedder(): { embedder: EmbeddingAdapter; calls: () => number } {
  let calls = 0;
  const embedder: EmbeddingAdapter = {
    provider: "test",
    modelId: "fake-embed",
    async doEmbed(values: string[]) {
      calls += 1;
      return { embeddings: values.map(() => [0.1, 0.2, 0.3]), usage: { inputTokens: values.length } };
    },
  };
  return { embedder, calls: () => calls };
}

test("TS-021: reaching the chunk cap must not delete the index for files it never visited", async () => {
  // The refresh loop breaks at the cap. `seen` was built as the loop went, so
  // everything after the break looked "removed from the repo" and had its
  // chunks and ledger row deleted — every refresh, on any repo bigger than the
  // cap, silently destroying the tail of its own index.
  //
  // This drives the REAL refresh() with a cap of 1 chunk, so the break fires
  // on the second file and c.ts is never visited. Reverting code-index.ts's
  // `const tracked = new Set(paths)` to an incrementally-built set fails here.
  const { db, files } = storingDb();
  const { embedder } = countingEmbedder();
  const source = "export const x = 1;\n";
  const executor = fakeExecutor({ "a.ts": source, "b.ts": source, "c.ts": source });

  // Pass 1, uncapped: all three files land in the ledger.
  const seeded = new NucleusCodeIndex(db, embedder);
  const first = await seeded.refresh(executor, "o/r");
  assert.equal(first.indexed, 3);
  assert.deepEqual([...files.keys()].map((k) => k.split("\u0000")[1]).sort(), ["a.ts", "b.ts", "c.ts"]);

  // Pass 2, capped at one chunk, with every file's content changed so the
  // hash-match shortcut cannot skip the work and hide the break.
  const changed = "export const x = 2;\n";
  const capped = new NucleusCodeIndex(db, embedder, { maxChunksPerRefresh: 1 });
  const stats = await capped.refresh(fakeExecutor({ "a.ts": changed, "b.ts": changed, "c.ts": changed }), "o/r");

  assert.equal(stats.capped, true, "the cap must have been reached — otherwise this test proves nothing");
  assert.ok(stats.indexed < 3, `the sweep must have stopped short, indexed ${stats.indexed}`);
  assert.equal(stats.removed, 0, "no tracked file may be treated as removed just because the sweep stopped early");
  assert.deepEqual(
    [...files.keys()].map((k) => k.split("\u0000")[1]).sort(),
    ["a.ts", "b.ts", "c.ts"],
    "every tracked file keeps its ledger row",
  );
});

test("a file that really left the repo is still cleaned up", async () => {
  const { db, files, chunks } = storingDb();
  const { embedder } = countingEmbedder();
  const source = "export const x = 1;\n";
  const index = new NucleusCodeIndex(db, embedder);
  await index.refresh(fakeExecutor({ "a.ts": source, "b.ts": source }), "o/r");
  assert.equal(files.size, 2);
  assert.ok(chunks.size >= 2);

  const stats = await index.refresh(fakeExecutor({ "a.ts": source }), "o/r");
  assert.equal(stats.removed, 1, "b.ts is gone from git and must leave the index");
  assert.deepEqual([...files.keys()].map((k) => k.split("\u0000")[1]), ["a.ts"]);
});

test("an unchanged file is not re-embedded on the next refresh", async () => {
  const { db } = storingDb();
  const { embedder, calls } = countingEmbedder();
  const index = new NucleusCodeIndex(db, embedder);
  const tree = { "a.ts": "export const a = 1;\n", "b.ts": "export const b = 2;\n" };
  await index.refresh(fakeExecutor(tree), "o/r");
  const afterFirst = calls();
  assert.ok(afterFirst > 0);
  const stats = await index.refresh(fakeExecutor(tree), "o/r");
  assert.equal(calls(), afterFirst, "the hash ledger must make a no-op refresh free");
  assert.equal(stats.indexed, 0);
  assert.equal(stats.removed, 0);
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
