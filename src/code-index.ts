import { createHash } from "node:crypto";

import { embedMany } from "@neutron-build/ai";
import type { EmbeddingAdapter } from "@neutron-build/ai";
import type { AgentExecutor } from "@neutron-build/agents";

import type { NucleusPgwire } from "./nucleus-pgwire.js";

/**
 * Repo knowledge on Nucleus vectors — the Devin-knowledge/Sweep-embeddings
 * idea, self-hosted on our own database. A repo run refreshes the index
 * incrementally after clone (file-hash diff, recorded step), and the agent
 * gets a ```search action that answers "where is X handled?" by semantic
 * retrieval instead of a full scan.
 *
 * One shared chunk table (`ship_code_chunks`, filtered by repo in
 * metadata) + a file-hash ledger (`ship_code_files`) for the incremental
 * diff. Chunk ids are deterministic (`repo::path#i`), so a changed file's
 * old chunks are deletable without querying the vector table.
 */

export interface CodeSearchHit {
  path: string;
  start: number;
  end: number;
  text: string;
  distance: number;
  /** Symbols declared in the chunk (see symbolsIn). Empty on rows indexed before this existed. */
  symbols?: string[];
}

export interface RefreshStats {
  files: number;
  indexed: number;
  removed: number;
  chunks: number;
  /** True when the per-refresh chunk cap stopped the sweep early. */
  capped: boolean;
  /** True when the refresh deadline stopped the sweep early (what was embedded is kept). */
  timedOut: boolean;
  /** Files this refresh skipped because their content had not changed. */
  unchanged: number;
  /**
   * Of `indexed`, how many were NOT in the ledger before.
   *
   * Coverage is a count of distinct files the index holds, so re-indexing a
   * changed file must not increase it. Conflating the two produced
   * "index holds 6/3 files (200%)" on a real run, which is how this got
   * noticed — the arithmetic was `ledgerSize + indexed`, and three of those
   * three were already counted.
   */
  added: number;
  /** Measured embedding cost, ms per chunk, over this refresh. Null when nothing was embedded. */
  msPerChunk: number | null;
  /** Where the sweep stopped, so the next refresh resumes there instead of restarting at "a". */
  cursor: string | null;
}

/**
 * How much of a repo the index actually holds.
 *
 * This exists because a search MISS was indistinguishable from "the file was
 * never indexed", while prompt.ts told the agent to PREFER search over grep. On
 * 2026-08-26 the production index held 12 files of teploy-ship and 4 of
 * teploy-cli — so nearly every miss was the second kind, and the agent had no
 * way to know.
 */
export interface IndexCoverage {
  repo: string;
  indexedFiles: number;
  trackedFiles: number;
  chunks: number;
  /** The last sweep stopped early — at the chunk cap, or out of time. */
  partial: boolean;
  /** ISO-8601 of the last refresh that wrote this row. */
  at: string;
}

export interface RefreshOptions {
  /** Absolute epoch ms; the sweep stops between files/batches once passed and no single embed call may outlive it. */
  deadlineMs?: number;
  /**
   * What the run is trying to do. Used to ORDER the sweep, which matters far
   * more than it sounds: at the measured embedding rate the budget is around a
   * hundred chunks per run, so the question is not "how much of the repo do we
   * index" but "which hundred chunks". Ordering by relevance to the task puts
   * that budget on files the run might actually search for, instead of on
   * whatever sorts first (`.env.example`, `CHANGELOG.md` — the two files the
   * production index provably spent its entire budget on).
   */
  task?: string;
}

/** Reject after `ms` — used so one hung embedding call cannot hold a run past its sandbox TTL. */
export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  if (!Number.isFinite(ms)) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} exceeded ${Math.max(0, Math.round(ms))}ms`)), Math.max(0, ms));
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface CodeSearch {
  /** Incrementally (re)index the executor's worktree for this repo. */
  refresh(executor: AgentExecutor, repo: string, options?: RefreshOptions): Promise<RefreshStats>;
  /** Semantic retrieval over the repo's indexed chunks. */
  search(repo: string, query: string, limit?: number): Promise<CodeSearchHit[]>;
  /**
   * How much of `repo` the index holds, from the last refresh. Null when the
   * repo has never been indexed — which a caller must render differently from
   * "indexed and nothing matched".
   */
  coverage(repo: string): Promise<IndexCoverage | null>;
}

const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;
const MAX_FILE_BYTES = 100_000;
const MAX_CHUNKS_PER_REFRESH = 3000;

/**
 * Ceiling on one embedding call. It used to be a flat 64, which is the single
 * reason the production index recorded `indexed: 0` on run after run.
 *
 * MEASURED 2026-08-26, against the deployed embedder (nomic-embed-text on a
 * 1 GB CPU ollama behind the gateway): **1.0 s per chunk, and it does not
 * parallelise** — 1, 4 and 8 concurrent requests all came back at ~1000 ms per
 * chunk of effective throughput. So a 64-chunk batch is a 64-second call, and
 * against the 120 s `SHIP_INDEX_TIMEOUT_MS` two of them overrun the deadline.
 * `withDeadline` then REJECTED mid-batch, the rejection escaped `refresh()`,
 * and durable.ts recorded `index refresh failed: embedding CHANGELOG.md
 * exceeded 119402ms` — throwing away every chunk the sweep had already
 * committed. Eleven of the last forty runs ended exactly that way.
 *
 * The batch is now sized to what the remaining budget can actually pay for, at
 * the rate this refresh has measured. See `#embedBudgeted`.
 */
const EMBED_BATCH_MAX = 64;

/**
 * Starting guess at ms-per-chunk, before this refresh has measured its own.
 * Deliberately the measured production figure rather than something
 * optimistic: guessing low is what produces an over-long first batch, and the
 * first batch is the one with no measurement to correct it.
 */
const EMBED_MS_PER_CHUNK_GUESS = 1000;

/**
 * How many chunks the FIRST call of a refresh may ask for, before this refresh
 * has measured anything.
 *
 * Small on purpose, and this is the second thing a live run taught. The seeded
 * guess of 1 s/chunk came from probing the embedder with one-line strings; on
 * real code — 60-line windows of dense TypeScript — the deployed embedder takes
 * **16 s per chunk**. So the first batch of every refresh was sized sixteen
 * times too large, overran the whole 60 s budget in a single call, and the
 * round wrote NOTHING: rounds 3 and 4 of a live convergence probe against
 * teploy-ship recorded `0 chunks @ null ms, timedOut=true`.
 *
 * A short probe batch costs one round of slightly lower throughput and buys a
 * measurement that sizes every batch after it. Combined with the rate persisted
 * across refreshes (see #writeCoverage), a repo only pays this once.
 */
const EMBED_PROBE_CHUNKS = 4;

/** Extensions that are never worth embedding (binary or generated). */
const SKIP_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "svg", "pdf", "zip", "gz", "tar", "tgz",
  "woff", "woff2", "ttf", "eot", "mp3", "mp4", "mov", "webm", "wasm", "jar", "class",
  "so", "dylib", "dll", "exe", "bin", "lock", "min.js", "min.css", "map",
]);

/**
 * Files that are text, tracked, and still not worth a second of embedding.
 *
 * This list earns its keep only because the budget is tiny. At 1 s per chunk a
 * run indexes on the order of a hundred chunks, and the production logs show
 * where those seconds went: `CHANGELOG.md` and `.env.example`, over and over,
 * because they sort early. A changelog answers no question an agent asks of a
 * code index — "where is X handled?" — and a lockfile answers none either.
 */
const SKIP_BASENAMES = new Set([
  "pnpm-lock.yaml", "package-lock.json", "yarn.lock", "cargo.lock", "go.sum", "composer.lock", "gemfile.lock", "poetry.lock",
  "changelog.md", "changelog", "license", "license.md", "license.txt", "notice", "authors", "contributors",
  ".env.example", ".env.sample", ".env.template", ".gitignore", ".gitattributes", ".dockerignore", ".npmignore",
]);

/** Directories whose contents are vendored, generated or otherwise not this repo's own code. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "vendor", "third_party", "target", ".git", "__pycache__", ".next", ".output", "coverage"]);

export function indexablePath(path: string): boolean {
  const segments = path.split("/");
  for (const segment of segments.slice(0, -1)) {
    if (SKIP_DIRS.has(segment)) return false;
  }
  const base = segments[segments.length - 1] ?? path;
  const lower = base.toLowerCase();
  if (SKIP_BASENAMES.has(lower)) return false;
  for (const ext of SKIP_EXT) {
    if (lower.endsWith(`.${ext}`)) return false;
  }
  return true;
}

/**
 * The order the sweep visits files in — the highest-leverage thing in this
 * file, given the budget.
 *
 * `git ls-files` is path-sorted, and the sweep breaks when it runs out of
 * time. Visiting in that order means a repo gets an ALPHABETICAL PREFIX of
 * itself indexed, which is not a sample of anything: `src/actions.ts` is in and
 * `src/worker.ts` is out, forever, because of their initials.
 *
 * Three rules, in order:
 *   1. Resume where the last sweep stopped, so repeated runs converge on full
 *      coverage instead of re-walking the same prefix. Unchanged files are free
 *      (the hash ledger skips them), so the cost of the wrap-around is small.
 *   2. Files whose path words overlap the task go first. With a hundred-chunk
 *      budget, "which hundred" is the whole question.
 *   3. Otherwise round-robin across top-level directories, so no single
 *      directory can eat the budget just by sorting first.
 */
export function orderPaths(paths: string[], options: { task?: string; cursor?: string | null } = {}): string[] {
  const words = new Set(
    (options.task ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3),
  );
  const score = (path: string): number => {
    if (words.size === 0) return 0;
    let hits = 0;
    for (const token of path.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length >= 3 && words.has(token)) hits += 1;
    }
    return hits;
  };

  const relevant = paths.filter((p) => score(p) > 0).sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  const relevantSet = new Set(relevant);
  const rest = paths.filter((p) => !relevantSet.has(p));

  // Round-robin the remainder across top-level directories.
  const groups = new Map<string, string[]>();
  for (const path of rest) {
    const top = path.includes("/") ? path.slice(0, path.indexOf("/")) : ".";
    const list = groups.get(top);
    if (list === undefined) groups.set(top, [path]);
    else list.push(path);
  }
  const keys = [...groups.keys()].sort();
  const interleaved: string[] = [];
  for (let i = 0; ; i++) {
    let added = false;
    for (const key of keys) {
      const item = groups.get(key)![i];
      if (item !== undefined) {
        interleaved.push(item);
        added = true;
      }
    }
    if (!added) break;
  }

  // Resume: rotate the non-relevant remainder so the sweep continues past
  // where it stopped. Relevance still wins — a task-relevant file is worth
  // re-checking (it is free when unchanged) ahead of continuing the walk.
  const cursor = options.cursor ?? null;
  if (cursor !== null) {
    const at = interleaved.indexOf(cursor);
    if (at >= 0) {
      const rotated = [...interleaved.slice(at + 1), ...interleaved.slice(0, at + 1)];
      return [...relevant, ...rotated];
    }
  }
  return [...relevant, ...interleaved];
}

/**
 * Symbol names declared inside a chunk, for the hit header.
 *
 * A hit used to read `## src/agent.ts:520-580` and a snippet, so a reader (the
 * agent, and a human reading a run log) had to reconstruct what they were
 * looking at from the body. Deliberately regex-based and language-agnostic
 * rather than a parser: this runs once per chunk during a sweep whose budget is
 * already spent on embeddings, and a wrong guess costs a slightly worse header,
 * not a wrong answer.
 */
export function symbolsIn(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?:[:=]\s*(?:async\s*)?(?:\(|function\b))/g,
    /^\s*def\s+([A-Za-z_][\w]*)/gm,
    /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/gm,
    /^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)/gm,
    /^\s*([a-z_][\w]*)\s*\(\)\s*\{/gm, // shell functions
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined && !found.includes(name)) found.push(name);
    }
  }
  return found.slice(0, 6);
}

export interface CodeChunk {
  /** 1-indexed line range, inclusive. */
  start: number;
  end: number;
  text: string;
}

/** Fixed-size line windows with overlap; deterministic for a given text. */
export function chunkText(text: string): CodeChunk[] {
  const lines = text.split("\n");
  if (lines.length === 0 || text.trim() === "") return [];
  const chunks: CodeChunk[] = [];
  let start = 0;
  for (;;) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const slice = lines.slice(start, end).join("\n");
    if (slice.trim() !== "") chunks.push({ start: start + 1, end, text: slice });
    if (end >= lines.length) break;
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function chunkId(repo: string, path: string, index: number): string {
  return `${repo}::${path}#${index}`;
}

/**
 * REQUIRES Nucleus >= c22219d (2026-07-09): older engines corrupt
 * VECTOR() values in any parameterized statement (dogfood finding #30)
 * and silently ignore ORDER BY on select-list aliases (#31). Both are
 * fixed upstream; ORDER BY still uses the full expression (harmless and
 * one less thing to depend on).
 */
function vectorLiteral(vector: number[]): string {
  for (const x of vector) {
    if (typeof x !== "number" || !Number.isFinite(x)) throw new Error("embedding contains a non-finite value");
  }
  return `[${vector.join(",")}]`;
}

/** Looks like binary content (NUL byte in the first 8KB)? */
function isBinary(data: Uint8Array): boolean {
  const scan = data.subarray(0, 8192);
  return scan.includes(0);
}

export interface CodeIndexOptions {
  /**
   * Ceiling on chunks written by one refresh. Exposed so a test can reach the
   * cap without building a 150,000-line fixture — the cap's behaviour at the
   * boundary is exactly what the TS-021 regression is about, and a test that
   * cannot reach it has to re-implement the rule instead of exercising it.
   */
  maxChunksPerRefresh?: number;
}

export class NucleusCodeIndex implements CodeSearch {
  #db: NucleusPgwire;
  #embedder: EmbeddingAdapter;
  #ready: Promise<void> | null = null;
  #chunksReady: Promise<void> | null = null;
  #reposReady: Promise<void> | null = null;
  #ratesReady: Promise<void> | null = null;
  #maxChunks: number;

  constructor(db: NucleusPgwire, embedder: EmbeddingAdapter, options: CodeIndexOptions = {}) {
    this.#db = db;
    this.#embedder = embedder;
    this.#maxChunks =
      options.maxChunksPerRefresh !== undefined && Number.isFinite(options.maxChunksPerRefresh) && options.maxChunksPerRefresh > 0
        ? Math.trunc(options.maxChunksPerRefresh)
        : MAX_CHUNKS_PER_REFRESH;
  }

  /** The file-hash ledger has no dimension dependency — create eagerly. */
  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_code_files (
          repo TEXT,
          path TEXT,
          hash TEXT,
          chunks TEXT
        )`,
      )
      .then(() => undefined)
      // A failed ensure must not be cached: one transient store error would
      // otherwise poison every later call for the life of the process.
      .catch((error: unknown) => {
        this.#ready = null;
        throw error;
      });
    return this.#ready;
  }

  /** The chunk table needs the embedding dimension — create on first vector. */
  #ensureChunks(dimension: number): Promise<void> {
    this.#chunksReady ??= (async () => {
      await this.#db.query(
        `CREATE TABLE IF NOT EXISTS ship_code_chunks (id TEXT PRIMARY KEY, embedding VECTOR(${Math.trunc(dimension)}), metadata JSONB DEFAULT '{}')`,
      );
      await this.#db.query(
        `CREATE INDEX IF NOT EXISTS idx_ship_code_chunks_embedding ON ship_code_chunks USING VECTOR (embedding) WITH (metric = 'cosine')`,
      );
    })();
    return this.#chunksReady;
  }

  /**
   * The per-repo coverage row, in its own table.
   *
   * A SIBLING table rather than columns on an existing one: `ship_code_files`
   * is populated on every deployed box, and Nucleus cannot ALTER-ADD to a
   * populated table — the same constraint that put host load in
   * `ship_fleet_load` (see fleet.ts:207). Created lazily and used
   * best-effort: coverage is a reporting signal, and a run must not fail
   * because a reporting table could not be written.
   */
  #ensureRepos(): Promise<void> {
    this.#reposReady ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_code_repos (
          repo TEXT,
          indexed_files TEXT,
          tracked_files TEXT,
          chunks TEXT,
          partial TEXT,
          cursor TEXT,
          at TEXT
        )`,
      )
      .then(() => undefined)
      .catch((error) => {
        // Unlike #ensureChunks, a failure is NOT cached: a transient Nucleus
        // catalog write must not disable coverage for the life of the process.
        this.#reposReady = null;
        throw error;
      });
    return this.#reposReady;
  }

  async coverage(repo: string): Promise<IndexCoverage | null> {
    try {
      await this.#ensureRepos();
      const rows = await this.#db.query(
        "SELECT repo, indexed_files, tracked_files, chunks, partial, at FROM ship_code_repos WHERE repo = $1",
        [repo],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        repo,
        indexedFiles: Number(row.indexed_files) || 0,
        trackedFiles: Number(row.tracked_files) || 0,
        chunks: Number(row.chunks) || 0,
        partial: String(row.partial) === "true",
        at: String(row.at ?? ""),
      };
    } catch {
      // Absent and unreadable are the same thing to a caller: it must not
      // claim coverage it cannot see.
      return null;
    }
  }

  async #readCursor(repo: string): Promise<string | null> {
    try {
      const rows = await this.#db.query("SELECT cursor FROM ship_code_repos WHERE repo = $1", [repo]);
      const cursor = rows[0]?.cursor;
      return cursor === undefined || cursor === null || String(cursor) === "" ? null : String(cursor);
    } catch {
      return null;
    }
  }

  /**
   * The embedding rate this repo measured last time, if any.
   *
   * Persisted across refreshes because the rate is a property of the EMBEDDER
   * and the code, not of one run — and a refresh that has to rediscover it
   * spends a probe batch doing so. A repo pays for the measurement once.
   */
  async #readRate(repo: string): Promise<number | null> {
    try {
      await this.#ensureRates();
      const rows = await this.#db.query("SELECT ms_per_chunk FROM ship_code_rates WHERE repo = $1", [repo]);
      const value = Number(rows[0]?.ms_per_chunk);
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Record what this refresh left behind.
   *
   * `indexedFiles` is the ledger's size AFTER the sweep, not this sweep's
   * count: coverage is a statement about the index, and a run that added three
   * files to an index that already held forty has forty-three.
   */
  async #writeCoverage(repo: string, stats: RefreshStats, ledgerSizeBefore: number, previousRate?: number | null): Promise<void> {
    // ADDED, not indexed: re-indexing a file that changed leaves the number of
    // distinct files the index holds exactly where it was.
    const indexedFiles = Math.max(0, ledgerSizeBefore + stats.added - stats.removed);
    const now = new Date().toISOString();
    try {
      await this.#db.query("DELETE FROM ship_code_repos WHERE repo = $1", [repo]).catch(() => {});
      await this.#db.query(
        "INSERT INTO ship_code_repos (repo, indexed_files, tracked_files, chunks, partial, cursor, at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [
          repo,
          String(indexedFiles),
          String(stats.files),
          String(stats.chunks),
          String(stats.capped || stats.timedOut || indexedFiles < stats.files),
          stats.cursor ?? "",
          now,
        ],
      );
    } catch {
      // Advisory. A refresh that worked must not be reported as failed because
      // its bookkeeping row could not be written.
    }
    // The measured rate rides a SIBLING table, not a column on the one above.
    //
    // Found by a live run: `CREATE TABLE IF NOT EXISTS` is a no-op against an
    // existing table, and Nucleus cannot ALTER-ADD to a populated one — so
    // adding `ms_per_chunk` to ship_code_repos made every INSERT fail against
    // any engine that already had the table, and coverage silently stopped
    // being recorded at all. This is the same constraint that put host load in
    // `ship_fleet_load` (fleet.ts:207); it applies here for the same reason and
    // I had to be shown it.
    //
    // Carry the previous measurement forward when this sweep measured nothing,
    // so a refresh that timed out before embedding does not throw away what the
    // last one learned.
    const rate = stats.msPerChunk ?? previousRate ?? null;
    if (rate !== null) {
      try {
        await this.#ensureRates();
        await this.#db.query("DELETE FROM ship_code_rates WHERE repo = $1", [repo]).catch(() => {});
        await this.#db.query("INSERT INTO ship_code_rates (repo, ms_per_chunk, at) VALUES ($1, $2, $3)", [
          repo,
          String(rate),
          now,
        ]);
      } catch {
        // Advisory too: without it the next refresh spends one probe batch
        // rediscovering the rate, which is a cost, not a failure.
      }
    }
  }

  #ensureRates(): Promise<void> {
    this.#ratesReady ??= this.#db
      .query("CREATE TABLE IF NOT EXISTS ship_code_rates (repo TEXT, ms_per_chunk TEXT, at TEXT)")
      .then(() => undefined)
      .catch((error) => {
        this.#ratesReady = null;
        throw error;
      });
    return this.#ratesReady;
  }

  async #deleteFileChunks(repo: string, path: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await this.#db.query("DELETE FROM ship_code_chunks WHERE id = $1", [chunkId(repo, path, i)]).catch(() => {});
    }
  }

  /**
   * Embed `values`, never overrunning `budgetMs`, and report what it cost.
   *
   * The old code handed the WHOLE remaining budget to a 64-chunk call and let
   * `withDeadline` reject if it overran. That rejection escaped `refresh()`
   * entirely, so a sweep that had already committed fifty chunks reported
   * `index refresh failed` and zero — see EMBED_BATCH_MAX for the production
   * evidence. Here the call is sized to what the budget can pay for at the
   * measured rate, and a timeout returns what it has instead of throwing.
   */
  async #embedBudgeted(
    values: string[],
    budgetMs: number,
    label: string,
    rate: { msPerChunk: number; measured: boolean },
  ): Promise<{ embeddings: number[][]; timedOut: boolean }> {
    if (values.length === 0) return { embeddings: [], timedOut: false };
    if (budgetMs <= 0) return { embeddings: [], timedOut: true };
    const affordable = Number.isFinite(budgetMs) ? Math.floor(budgetMs / Math.max(1, rate.msPerChunk)) : values.length;
    // Nothing is affordable AT THE ESTIMATED RATE. Stop — unless the estimate
    // is still the seeded guess, in which case try exactly one chunk to learn
    // the real rate. A guess that is too high must not deadlock a fast
    // embedder at zero progress, which is what refusing here would do.
    // Until this refresh has measured its own rate, ask for a PROBE-sized batch
    // rather than whatever the estimate says it can afford: an estimate that is
    // wrong by 16x turns the first call into one that cannot possibly fit, and
    // a call that overruns writes nothing at all.
    const ceiling = rate.measured ? EMBED_BATCH_MAX : Math.min(EMBED_BATCH_MAX, EMBED_PROBE_CHUNKS);
    const floor = rate.measured ? 0 : 1;
    const take = Math.max(floor, Math.min(values.length, affordable, ceiling));
    if (take === 0) return { embeddings: [], timedOut: true };
    const started = Date.now();
    try {
      const { embeddings } = await withDeadline(
        embedMany({ model: this.#embedder, values: values.slice(0, take) }),
        budgetMs,
        `embedding ${label}`,
      );
      const elapsed = Date.now() - started;
      // Learn the real rate from this refresh rather than trusting the guess.
      // A refresh against a fast embedder should not be held to the slow one's
      // batch size, and vice versa.
      rate.msPerChunk = Math.max(1, Math.round(elapsed / Math.max(1, take)));
      rate.measured = true;
      return { embeddings, timedOut: false };
    } catch {
      // Out of time, or the embedder failed. Either way the sweep keeps what
      // it has already written; it does not unwind it.
      rate.msPerChunk = Math.max(rate.msPerChunk, Math.round((Date.now() - started) / Math.max(1, take)));
      rate.measured = true;
      return { embeddings: [], timedOut: true };
    }
  }

  /**
   * Content hashes for every path, in ONE executor round-trip.
   *
   * `git hash-object --stdin-paths` hashes the WORKING TREE copy of each path,
   * which is what an index of a checked-out sandbox must key on. It replaces
   * one `getFile` per file whose only purpose was to compute a hash and then,
   * for the overwhelming majority of files, discard the bytes because the hash
   * had not changed. On a 500-file repo that is 500 round-trips traded for one.
   *
   * Returns null when git cannot do it (an old git, a path git refuses), and
   * the caller falls back to the per-file read it always did.
   */
  async #hashAll(executor: AgentExecutor, paths: string[]): Promise<Map<string, string> | null> {
    if (paths.length === 0) return new Map();
    try {
      const script = `printf '%s\\n' ${paths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" ")} | git hash-object --stdin-paths`;
      const result = await executor.exec(script, { timeoutMs: 120_000 });
      if (result.exitCode !== 0) return null;
      const hashes = result.stdout.split("\n").map((h) => h.trim()).filter((h) => h !== "");
      if (hashes.length !== paths.length) return null;
      return new Map(paths.map((path, i) => [path, hashes[i]!]));
    } catch {
      return null;
    }
  }

  async refresh(executor: AgentExecutor, repo: string, options: RefreshOptions = {}): Promise<RefreshStats> {
    await this.#ensure();
    await this.#ensureRepos();
    const deadline = options.deadlineMs ?? Number.POSITIVE_INFINITY;
    const remaining = (): number => deadline - Date.now();

    const listing = await executor.exec("git ls-files");
    if (listing.exitCode !== 0) {
      throw new Error(`git ls-files failed: ${listing.stderr.slice(0, 200)}`);
    }
    const tracked = listing.stdout.split("\n").map((p) => p.trim()).filter((p) => p !== "" && indexablePath(p));

    const rows = await this.#db.query("SELECT path, hash, chunks FROM ship_code_files WHERE repo = $1", [repo]);
    const ledger = new Map(rows.map((r) => [String(r.path), { hash: String(r.hash), chunks: Number(r.chunks) }]));

    const previous = await this.coverage(repo);
    const paths = orderPaths(tracked, {
      ...(options.task !== undefined ? { task: options.task } : {}),
      cursor: previous === null ? null : await this.#readCursor(repo),
    });

    const stats: RefreshStats = {
      files: tracked.length,
      indexed: 0,
      removed: 0,
      chunks: 0,
      capped: false,
      timedOut: false,
      unchanged: 0,
      added: 0,
      msPerChunk: null,
      cursor: null,
    };
    // Every path GIT still tracks, established up front.
    //
    // This used to be built incrementally as the loop visited files, and the
    // loop breaks at the chunk cap — so every path after the break was missing
    // from the set, and the removal phase below read "not in seen" as "left the
    // repository" and deleted their chunks and ledger rows. A repo bigger than
    // the cap therefore destroyed the tail of its own index on every refresh,
    // then re-embedded it next time: expensive, and search silently missed
    // files that were right there.
    const trackedSet = new Set(tracked);
    const learned = await this.#readRate(repo);
    // `measured: true` when the rate came from a previous refresh of THIS repo:
    // it is a real measurement over this repo's own chunk sizes, so there is no
    // reason to spend another probe batch rediscovering it.
    const rate = { msPerChunk: learned ?? EMBED_MS_PER_CHUNK_GUESS, measured: learned !== null };
    const hashes = await this.#hashAll(executor, paths);

    for (const path of paths) {
      if (stats.chunks >= this.#maxChunks) {
        stats.capped = true;
        break;
      }
      // Time is the other budget, and on the deployed embedder it is the one
      // that binds: 1.0 s per chunk, measured 2026-08-26, against a 120 s cap.
      if (remaining() <= 0) {
        stats.capped = true;
        stats.timedOut = true;
        break;
      }

      // The cheap skip first: a file whose content has not changed costs
      // nothing, and after #hashAll it costs nothing to KNOW that either.
      const known = ledger.get(path);
      const preHash = hashes?.get(path);
      if (known !== undefined && preHash !== undefined && known.hash === preHash) {
        stats.unchanged += 1;
        stats.cursor = path;
        continue;
      }

      let data: Uint8Array;
      try {
        data = await executor.getFile(path);
      } catch {
        continue; // unreadable (submodule stub, broken symlink) — skip
      }
      if (data.byteLength === 0 || data.byteLength > MAX_FILE_BYTES || isBinary(data)) continue;
      const hash = preHash ?? sha256(data);
      if (known !== undefined && known.hash === hash) {
        stats.unchanged += 1;
        stats.cursor = path;
        continue;
      }

      const text = new TextDecoder().decode(data);
      const chunks = chunkText(text);
      if (known !== undefined) await this.#deleteFileChunks(repo, path, known.chunks);

      // Embed in batches; insert with deterministic ids so re-runs replace.
      // The cap is enforced INSIDE the file too: checking only before a file
      // meant one large file could carry stats.chunks far past the advertised
      // ceiling in a single refresh.
      const room = Math.max(0, this.#maxChunks - stats.chunks);
      const budgeted = chunks.slice(0, room);
      if (budgeted.length < chunks.length) stats.capped = true;
      let written = 0;
      let ranOut = false;
      for (let offset = 0; offset < budgeted.length; ) {
        if (remaining() <= 0) {
          ranOut = true;
          break;
        }
        const slice = budgeted.slice(offset, offset + EMBED_BATCH_MAX);
        const { embeddings, timedOut } = await this.#embedBudgeted(
          slice.map((c) => `${path}\n${c.text}`),
          remaining(),
          path,
          rate,
        );
        if (embeddings.length === 0) {
          ranOut = ranOut || timedOut;
          break;
        }
        for (let i = 0; i < embeddings.length; i++) {
          const vector = embeddings[i];
          const chunk = slice[i];
          if (vector === undefined || vector.length === 0 || chunk === undefined) continue;
          await this.#ensureChunks(vector.length);
          const id = chunkId(repo, path, offset + i);
          const meta = JSON.stringify({
            repo,
            path,
            start: chunk.start,
            end: chunk.end,
            text: chunk.text,
            // What a reader needs to know what they are looking at without
            // reading the body. Absent on rows written before symbols existed,
            // and the hit renderer treats absent as "no symbols found".
            symbols: symbolsIn(chunk.text),
          });
          await this.#db.query("DELETE FROM ship_code_chunks WHERE id = $1", [id]).catch(() => {});
          await this.#db.query("INSERT INTO ship_code_chunks (id, embedding, metadata) VALUES ($1, VECTOR($2), $3)", [
            id,
            vectorLiteral(vector),
            meta,
          ]);
          written += 1;
        }
        offset += embeddings.length;
        if (timedOut) {
          ranOut = true;
          break;
        }
      }

      // A file that was only PARTLY embedded must record what it actually
      // wrote, not what it wanted to. #deleteFileChunks counts on this number,
      // and the next refresh's hash comparison must see a hash that matches
      // the rows that exist — so a partial file keeps no ledger row at all and
      // is re-attempted next time from scratch.
      if (written > 0 && (written === budgeted.length || !ranOut)) {
        await this.#db.query("DELETE FROM ship_code_files WHERE repo = $1 AND path = $2", [repo, path]);
        await this.#db.query("INSERT INTO ship_code_files (repo, path, hash, chunks) VALUES ($1, $2, $3, $4)", [
          repo,
          path,
          hash,
          String(written),
        ]);
        stats.indexed += 1;
        if (known === undefined) stats.added += 1;
        stats.cursor = path;
      } else if (written > 0) {
        // Partial: the rows exist but the file is not fully represented. Drop
        // them rather than leave a ledger row claiming the file is done.
        await this.#deleteFileChunks(repo, path, written);
        written = 0;
      }
      stats.chunks += written;
      if (ranOut) {
        // One file being unaffordable is not the sweep being over.
        //
        // This used to `break`, and a live run showed what that costs: the
        // first file in relevance order needed 114 s for its single chunk
        // against a 90 s budget, so the sweep gave up having indexed NOTHING —
        // while the old code, which happened to meet small files first,
        // managed three. Chunk cost varies enormously with content (16 s for a
        // source window, 114 s for a dense JSON blob), so the next file may
        // well fit. Stop only when the clock has actually run out.
        stats.timedOut = true;
        stats.capped = true;
        if (remaining() <= 0) break;
        continue;
      }
      if (stats.capped) break;
    }

    // Files that left the tree take their chunks with them. Membership is
    // decided by what git tracks NOW, not by how far this refresh happened to
    // get before the cap.
    for (const [path, known] of ledger) {
      if (trackedSet.has(path)) continue;
      await this.#deleteFileChunks(repo, path, known.chunks);
      await this.#db.query("DELETE FROM ship_code_files WHERE repo = $1 AND path = $2", [repo, path]);
      stats.removed += 1;
    }

    stats.msPerChunk = stats.chunks > 0 ? rate.msPerChunk : null;
    await this.#writeCoverage(repo, stats, ledger.size, learned);
    return stats;
  }

  async search(repo: string, query: string, limit = 8): Promise<CodeSearchHit[]> {
    await this.#ensure();
    const { embeddings } = await embedMany({ model: this.#embedder, values: [query] });
    const vector = embeddings[0];
    if (vector === undefined || vector.length === 0) return [];
    await this.#ensureChunks(vector.length);
    const k = Math.max(1, Math.trunc(limit));
    const dist = "VECTOR_DISTANCE(embedding, VECTOR($1), 'cosine')";
    const rows = await this.#db.query(
      `SELECT id, metadata, ${dist} AS distance
       FROM ship_code_chunks WHERE metadata->>'repo' = $2 ORDER BY ${dist} LIMIT ${k}`,
      [vectorLiteral(vector), repo],
    );
    return rows.map((row) => {
      const meta = (typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata ?? {})) as {
        path?: string;
        start?: number;
        end?: number;
        text?: string;
        symbols?: unknown;
      };
      return {
        path: String(meta.path ?? ""),
        start: Number(meta.start ?? 0),
        end: Number(meta.end ?? 0),
        text: String(meta.text ?? ""),
        distance: Number(row.distance),
        ...(Array.isArray(meta.symbols) && meta.symbols.length > 0 ? { symbols: meta.symbols.map(String) } : {}),
      };
    });
  }
}

/**
 * One line stating how much of the repo the index actually holds.
 *
 * This is the whole point of IndexCoverage. Without it, "No indexed code
 * matched" reads as "that code is not in this repository" — and the system
 * prompt was simultaneously telling the agent to PREFER search over grep. On
 * the deployed index that combination was actively misleading: it held 12
 * files of teploy-ship, so nearly every miss meant "never indexed", and the
 * agent had no way to tell.
 */
export function coverageLine(coverage: IndexCoverage | null | undefined): string {
  if (coverage === null || coverage === undefined) {
    return "This repository has not been indexed, so a miss here means nothing. Use grep/rg via ```bash.";
  }
  if (coverage.trackedFiles <= 0) {
    return "The index holds no files for this repository. Use grep/rg via ```bash.";
  }
  const pct = Math.round((coverage.indexedFiles / coverage.trackedFiles) * 100);
  const scope = `${coverage.indexedFiles} of ${coverage.trackedFiles} files (${pct}%)`;
  return coverage.partial || pct < 95
    ? `Index coverage: ${scope} of this repository. A miss may simply mean "not indexed" — confirm with grep/rg via \`\`\`bash before concluding something does not exist.`
    : `Index coverage: ${scope} of this repository.`;
}

/**
 * The observation a ```search action produces.
 *
 * Coverage is stated on BOTH the hit and the miss path, on purpose. On a miss
 * it is the difference between a fact and a false one; on a hit it warns that
 * a better match may exist in the part of the tree that was never indexed.
 */
export function formatSearchHits(query: string, hits: CodeSearchHit[], coverage?: IndexCoverage | null): string {
  const note = coverage === undefined ? "" : `\n\n${coverageLine(coverage)}`;
  if (hits.length === 0) return `No indexed code matched "${query}".${note}`;
  const parts = hits.map((h) => {
    const symbols = h.symbols !== undefined && h.symbols.length > 0 ? `  (${h.symbols.join(", ")})` : "";
    return `## ${h.path}:${h.start}-${h.end}${symbols}\n${h.text}`;
  });
  return `Top ${hits.length} matches for "${query}":\n\n${parts.join("\n\n")}${note}`;
}
