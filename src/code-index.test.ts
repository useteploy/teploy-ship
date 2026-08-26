import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentExecutor } from "@neutron-build/agents";
import type { EmbeddingAdapter } from "@neutron-build/ai";
import { NucleusCodeIndex, chunkText, coverageLine, formatSearchHits, indexablePath, orderPaths, symbolsIn, withDeadline } from "./code-index.js";
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
function storingDb(): {
  db: NucleusPgwire;
  files: Map<string, { hash: string; chunks: string }>;
  chunks: Set<string>;
  repos: Map<string, Record<string, string>>;
} {
  const files = new Map<string, { hash: string; chunks: string }>();
  const chunks = new Set<string>();
  const repos = new Map<string, Record<string, string>>();
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
      if (sql.startsWith("SELECT repo, indexed_files")) {
        const row = repos.get(String(params[0]));
        return row === undefined ? [] : [row];
      }
      if (sql.startsWith("SELECT cursor FROM ship_code_repos")) {
        const row = repos.get(String(params[0]));
        return row === undefined ? [] : [{ cursor: row.cursor }];
      }
      if (sql.startsWith("DELETE FROM ship_code_repos")) {
        repos.delete(String(params[0]));
        return [];
      }
      if (sql.startsWith("INSERT INTO ship_code_repos")) {
        repos.set(String(params[0]), {
          repo: String(params[0]),
          indexed_files: String(params[1]),
          tracked_files: String(params[2]),
          chunks: String(params[3]),
          partial: String(params[4]),
          cursor: String(params[5]),
          at: String(params[6]),
        });
        return [];
      }
      return [];
    },
  } as unknown as NucleusPgwire;
  return { db, files, chunks, repos };
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

// --- C1: the index is budget-bound, and must degrade rather than destroy ----
//
// Measured on the deployed embedder 2026-08-26 (nomic-embed-text, 1 GB CPU
// ollama behind the gateway): 1.0 s per chunk, and it does NOT parallelise —
// 1, 4 and 8 concurrent requests all returned ~1000 ms/chunk effective. So a
// 120 s refresh buys about 120 chunks, and the old flat 64-chunk batch put two
// calls over the deadline. `withDeadline` then rejected, the rejection escaped
// refresh(), and durable.ts recorded "index refresh failed" with zero indexed
// — throwing away everything the sweep had already committed. Eleven of the
// last forty production runs ended exactly that way.

/** An embedder that takes `msPerChunk` of wall clock, like the real one. */
function slowEmbedder(msPerChunk: number): EmbeddingAdapter {
  return {
    provider: "test",
    modelId: "slow",
    async doEmbed(values: string[]) {
      await new Promise((r) => setTimeout(r, msPerChunk * values.length));
      return { embeddings: values.map(() => [0.1, 0.2, 0.3]), usage: { inputTokens: values.length } };
    },
  };
}

const manyFiles = (n: number): Record<string, string> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/f${String(i).padStart(2, "0")}.ts`, `export const v${i} = ${i};\n`]));

test("a slow embedder costs the sweep its tail, never the work it already did", async () => {
  const { db, files, chunks } = storingDb();
  const index = new NucleusCodeIndex(db, slowEmbedder(20));
  const stats = await index.refresh(fakeExecutor(manyFiles(12)), "o/r", { deadlineMs: Date.now() + 220 });

  assert.equal(stats.timedOut, true, "the deadline must have bitten — otherwise this test proves nothing");
  assert.ok(stats.indexed > 0, `work done before the deadline must be KEPT, indexed=${stats.indexed}`);
  assert.ok(stats.indexed < 12, `and the sweep must actually have stopped short, indexed=${stats.indexed}`);
  assert.equal(files.size, stats.indexed, "the ledger matches what was written");
  assert.ok(chunks.size > 0, "chunks were committed and left committed");
  assert.equal(stats.removed, 0, "a sweep that ran out of time removes nothing");
});

test("the next refresh resumes past where the last one stopped, instead of re-walking the same prefix", async () => {
  const { db, files } = storingDb();
  const tree = manyFiles(12);
  const index = new NucleusCodeIndex(db, slowEmbedder(20));

  const first = await index.refresh(fakeExecutor(tree), "o/r", { deadlineMs: Date.now() + 220 });
  const afterFirst = new Set(files.keys());
  assert.ok(first.indexed > 0 && first.indexed < 12, `first sweep must be partial, got ${first.indexed}`);

  const second = await index.refresh(fakeExecutor(tree), "o/r", { deadlineMs: Date.now() + 220 });
  const afterSecond = new Set(files.keys());

  assert.ok(second.indexed > 0, "the second sweep indexed something new rather than re-embedding the first prefix");
  assert.ok(afterSecond.size > afterFirst.size, `coverage must grow: ${afterFirst.size} -> ${afterSecond.size}`);
  for (const path of afterFirst) {
    assert.ok(afterSecond.has(path), `${path} must not be lost by the second sweep`);
  }
});

test("coverage is recorded and readable, and says when it is partial", async () => {
  const { db } = storingDb();
  const index = new NucleusCodeIndex(db, countingEmbedder().embedder);
  assert.equal(await index.coverage("o/r"), null, "an unindexed repo reports null, not zero");

  await index.refresh(fakeExecutor({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 2;\n" }), "o/r");
  const full = await index.coverage("o/r");
  assert.equal(full?.indexedFiles, 2);
  assert.equal(full?.trackedFiles, 2);
  assert.equal(full?.partial, false);

  const capped = new NucleusCodeIndex(db, countingEmbedder().embedder, { maxChunksPerRefresh: 1 });
  const tree = { "a.ts": "export const a = 3;\n", "b.ts": "export const b = 4;\n", "c.ts": "export const c = 5;\n" };
  await capped.refresh(fakeExecutor(tree), "o/r2");
  const partial = await capped.coverage("o/r2");
  assert.equal(partial?.partial, true, "a sweep that stopped at the cap must not report full coverage");
});

// --- C1: a miss must be interpretable -------------------------------------

test("coverageLine distinguishes 'not in the repo' from 'never indexed'", () => {
  assert.match(coverageLine(null), /has not been indexed/);
  assert.match(coverageLine(null), /grep/, "and points at the tool that CAN answer");

  const thin = { repo: "o/r", indexedFiles: 12, trackedFiles: 400, chunks: 40, partial: true, at: "" };
  assert.match(coverageLine(thin), /12 of 400 files \(3%\)/);
  assert.match(coverageLine(thin), /may simply mean "not indexed"/);

  const complete = { repo: "o/r", indexedFiles: 400, trackedFiles: 400, chunks: 4000, partial: false, at: "" };
  assert.match(coverageLine(complete), /400 of 400 files \(100%\)/);
  assert.doesNotMatch(coverageLine(complete), /may simply mean/, "full coverage must not hedge");
});

test("formatSearchHits carries coverage on the miss AND the hit", () => {
  const thin = { repo: "o/r", indexedFiles: 12, trackedFiles: 400, chunks: 40, partial: true, at: "" };
  const miss = formatSearchHits("where is the retry backoff", [], thin);
  assert.match(miss, /No indexed code matched/);
  assert.match(miss, /12 of 400 files/, "the miss is the case this exists for");

  const hit = formatSearchHits("retry", [{ path: "a.ts", start: 1, end: 9, text: "x", distance: 0.1 }], thin);
  assert.match(hit, /Top 1 matches/);
  assert.match(hit, /12 of 400 files/, "a hit on 3% coverage still warns that a better match may be unindexed");

  // Callers that pass no coverage keep the old output exactly.
  assert.equal(formatSearchHits("q", []), 'No indexed code matched "q".');
});

test("a hit names the symbols it contains", () => {
  const out = formatSearchHits("retry", [
    { path: "src/a.ts", start: 10, end: 40, text: "function retryBackoff() {}", distance: 0.1, symbols: ["retryBackoff", "MAX"] },
  ]);
  assert.match(out, /## src\/a\.ts:10-40 {2}\(retryBackoff, MAX\)/);
});

test("symbolsIn finds declarations across the languages this repo actually indexes", () => {
  assert.deepEqual(symbolsIn("export function retryBackoff(a) {}"), ["retryBackoff"]);
  assert.deepEqual(symbolsIn("export class NucleusCodeIndex {}"), ["NucleusCodeIndex"]);
  assert.deepEqual(symbolsIn("export interface CodeSearch {}"), ["CodeSearch"]);
  assert.deepEqual(symbolsIn("export const hostOk = (): boolean => true;"), ["hostOk"]);
  assert.deepEqual(symbolsIn("def parse_config(path):"), ["parse_config"]);
  assert.deepEqual(symbolsIn("func (s *Server) Handle(w http.ResponseWriter) {"), ["Handle"]);
  assert.deepEqual(symbolsIn("pub fn spawn_worker() {}"), ["spawn_worker"]);
  assert.deepEqual(symbolsIn("const x = 1;\nlet y = 2;"), [], "plain values are not symbols worth a header");
  assert.ok(symbolsIn("function a(){}\nfunction b(){}\nfunction c(){}\nfunction d(){}\nfunction e(){}\nfunction f(){}\nfunction g(){}").length <= 6);
});

// --- C1: which hundred chunks -----------------------------------------------

test("orderPaths puts task-relevant files first — with a hundred-chunk budget that is the whole game", () => {
  const paths = ["CHANGELOG.md", "docs/intro.md", "src/actions.ts", "src/worker.ts", "web/app.tsx"];
  const ordered = orderPaths(paths, { task: "the worker holds launches when the host is out of memory" });
  assert.equal(ordered[0], "src/worker.ts", `got ${JSON.stringify(ordered)}`);
});

test("orderPaths round-robins directories, so no directory wins on its initial", () => {
  const paths = ["a/1.ts", "a/2.ts", "a/3.ts", "a/4.ts", "b/1.ts", "b/2.ts", "z/1.ts", "z/2.ts"];
  const ordered = orderPaths(paths);
  const tops = ordered.slice(0, 3).map((p) => p.split("/")[0]);
  assert.deepEqual(tops, ["a", "b", "z"], `alphabetical order would have been a,a,a — got ${JSON.stringify(ordered)}`);
  assert.deepEqual([...ordered].sort(), [...paths].sort(), "nothing added, nothing dropped");
});

test("orderPaths resumes after the cursor so repeated sweeps converge", () => {
  const paths = ["a/1.ts", "a/2.ts", "b/1.ts", "b/2.ts"];
  const first = orderPaths(paths);
  const resumed = orderPaths(paths, { cursor: first[1] });
  assert.notDeepEqual(resumed, first, "a resumed sweep must not restart at the same file");
  assert.equal(resumed[0], first[2], "it continues where the last one stopped");
  assert.deepEqual([...resumed].sort(), [...paths].sort(), "and still covers everything");
});

test("orderPaths tolerates a cursor for a file that no longer exists", () => {
  const paths = ["a/1.ts", "b/1.ts"];
  assert.deepEqual([...orderPaths(paths, { cursor: "gone.ts" })].sort(), [...paths].sort());
});

test("the budget is not spent on files that answer no question a code index is asked", () => {
  // Production evidence: the deployed index burned its entire 120s budget on
  // CHANGELOG.md and .env.example, over and over, because they sort early.
  assert.equal(indexablePath("CHANGELOG.md"), false);
  assert.equal(indexablePath("changelog.md"), false);
  assert.equal(indexablePath(".env.example"), false);
  assert.equal(indexablePath("LICENSE"), false);
  assert.equal(indexablePath("node_modules/react/index.js"), false);
  assert.equal(indexablePath("dist/app.js"), false);
  assert.equal(indexablePath("vendor/lib/x.go"), false);
  // And the things that DO answer it are still indexed.
  assert.equal(indexablePath("src/worker.ts"), true);
  assert.equal(indexablePath("README.md"), true);
  assert.equal(indexablePath("docs/DEPLOY.md"), true);
  assert.equal(indexablePath("Makefile"), true);
});
