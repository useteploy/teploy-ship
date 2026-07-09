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
}

export interface RefreshStats {
  files: number;
  indexed: number;
  removed: number;
  chunks: number;
  /** True when the per-refresh chunk cap stopped the sweep early. */
  capped: boolean;
}

export interface CodeSearch {
  /** Incrementally (re)index the executor's worktree for this repo. */
  refresh(executor: AgentExecutor, repo: string): Promise<RefreshStats>;
  /** Semantic retrieval over the repo's indexed chunks. */
  search(repo: string, query: string, limit?: number): Promise<CodeSearchHit[]>;
}

const CHUNK_LINES = 60;
const CHUNK_OVERLAP = 10;
const MAX_FILE_BYTES = 100_000;
const MAX_CHUNKS_PER_REFRESH = 3000;
const EMBED_BATCH = 64;

/** Extensions that are never worth embedding (binary or generated). */
const SKIP_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "svg", "pdf", "zip", "gz", "tar", "tgz",
  "woff", "woff2", "ttf", "eot", "mp3", "mp4", "mov", "webm", "wasm", "jar", "class",
  "so", "dylib", "dll", "exe", "bin", "lock", "min.js", "min.css", "map",
]);

export function indexablePath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (base === "pnpm-lock.yaml" || base === "package-lock.json" || base === "yarn.lock" || base === "Cargo.lock" || base === "go.sum") return false;
  const lower = base.toLowerCase();
  for (const ext of SKIP_EXT) {
    if (lower.endsWith(`.${ext}`)) return false;
  }
  return true;
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
 * Statements touching the vector table use NO $N parameters at all:
 * Nucleus's prepared-statement AST fast-path corrupts VECTOR() whenever
 * the statement carries any parameter — even inline vector literals in
 * the same statement come back with garbage distances (repro: SELECT
 * VECTOR_DISTANCE(VECTOR('[1,0,0]'), VECTOR('[0,1,0]'), 'cosine'), $1
 * → 0.992, without $1 → 1.0 exactly; found 2026-07-09, tracked as a
 * Nucleus dogfood finding). Until that's fixed upstream, every value is
 * inlined: vectors are validated-finite numbers, and text is escaped
 * with the same rules Nucleus's own substitution applies (quotes and
 * backslashes doubled, NUL stripped).
 */
function vectorLiteral(vector: number[]): string {
  for (const x of vector) {
    if (typeof x !== "number" || !Number.isFinite(x)) throw new Error("embedding contains a non-finite value");
  }
  return `'[${vector.join(",")}]'`;
}

function textLiteral(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/\0/g, "")}'`;
}

/** Looks like binary content (NUL byte in the first 8KB)? */
function isBinary(data: Uint8Array): boolean {
  const scan = data.subarray(0, 8192);
  return scan.includes(0);
}

export class NucleusCodeIndex implements CodeSearch {
  #db: NucleusPgwire;
  #embedder: EmbeddingAdapter;
  #ready: Promise<void> | null = null;
  #chunksReady: Promise<void> | null = null;

  constructor(db: NucleusPgwire, embedder: EmbeddingAdapter) {
    this.#db = db;
    this.#embedder = embedder;
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
      .then(() => undefined);
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

  async #deleteFileChunks(repo: string, path: string, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      await this.#db
        .query(`DELETE FROM ship_code_chunks WHERE id = ${textLiteral(chunkId(repo, path, i))}`)
        .catch(() => {});
    }
  }

  async refresh(executor: AgentExecutor, repo: string): Promise<RefreshStats> {
    await this.#ensure();

    const listing = await executor.exec("git ls-files");
    if (listing.exitCode !== 0) {
      throw new Error(`git ls-files failed: ${listing.stderr.slice(0, 200)}`);
    }
    const paths = listing.stdout.split("\n").map((p) => p.trim()).filter((p) => p !== "" && indexablePath(p));

    const rows = await this.#db.query("SELECT path, hash, chunks FROM ship_code_files WHERE repo = $1", [repo]);
    const ledger = new Map(rows.map((r) => [String(r.path), { hash: String(r.hash), chunks: Number(r.chunks) }]));

    const stats: RefreshStats = { files: paths.length, indexed: 0, removed: 0, chunks: 0, capped: false };
    const seen = new Set<string>();

    for (const path of paths) {
      seen.add(path);
      if (stats.chunks >= MAX_CHUNKS_PER_REFRESH) {
        stats.capped = true;
        break;
      }
      let data: Uint8Array;
      try {
        data = await executor.getFile(path);
      } catch {
        continue; // unreadable (submodule stub, broken symlink) — skip
      }
      if (data.byteLength === 0 || data.byteLength > MAX_FILE_BYTES || isBinary(data)) continue;
      const hash = sha256(data);
      const known = ledger.get(path);
      if (known !== undefined && known.hash === hash) continue;

      const text = new TextDecoder().decode(data);
      const chunks = chunkText(text);
      if (known !== undefined) await this.#deleteFileChunks(repo, path, known.chunks);

      // Embed in batches; insert with deterministic ids so re-runs replace.
      for (let offset = 0; offset < chunks.length; offset += EMBED_BATCH) {
        const batch = chunks.slice(offset, offset + EMBED_BATCH);
        const { embeddings } = await embedMany({
          model: this.#embedder,
          values: batch.map((c) => `${path}\n${c.text}`),
        });
        for (let i = 0; i < batch.length; i++) {
          const vector = embeddings[i];
          if (vector === undefined || vector.length === 0) continue;
          await this.#ensureChunks(vector.length);
          const id = chunkId(repo, path, offset + i);
          const meta = JSON.stringify({ repo, path, start: batch[i]!.start, end: batch[i]!.end, text: batch[i]!.text });
          await this.#db.query(`DELETE FROM ship_code_chunks WHERE id = ${textLiteral(id)}`).catch(() => {});
          await this.#db.query(
            `INSERT INTO ship_code_chunks (id, embedding, metadata) VALUES (${textLiteral(id)}, VECTOR(${vectorLiteral(vector)}), ${textLiteral(meta)})`,
          );
        }
      }

      await this.#db.query("DELETE FROM ship_code_files WHERE repo = $1 AND path = $2", [repo, path]);
      await this.#db.query("INSERT INTO ship_code_files (repo, path, hash, chunks) VALUES ($1, $2, $3, $4)", [
        repo,
        path,
        hash,
        String(chunks.length),
      ]);
      stats.indexed += 1;
      stats.chunks += chunks.length;
    }

    // Files that left the tree take their chunks with them.
    for (const [path, known] of ledger) {
      if (seen.has(path)) continue;
      await this.#deleteFileChunks(repo, path, known.chunks);
      await this.#db.query("DELETE FROM ship_code_files WHERE repo = $1 AND path = $2", [repo, path]);
      stats.removed += 1;
    }

    return stats;
  }

  async search(repo: string, query: string, limit = 8): Promise<CodeSearchHit[]> {
    await this.#ensure();
    const { embeddings } = await embedMany({ model: this.#embedder, values: [query] });
    const vector = embeddings[0];
    if (vector === undefined || vector.length === 0) return [];
    await this.#ensureChunks(vector.length);
    const k = Math.max(1, Math.trunc(limit));
    // ORDER BY repeats the expression: Nucleus silently ignores ORDER BY
    // on a select-list alias (second dogfood finding, same date).
    const dist = `VECTOR_DISTANCE(embedding, VECTOR(${vectorLiteral(vector)}), 'cosine')`;
    const rows = await this.#db.query(
      `SELECT id, metadata, ${dist} AS distance
       FROM ship_code_chunks WHERE metadata->>'repo' = ${textLiteral(repo)} ORDER BY ${dist} LIMIT ${k}`,
    );
    return rows.map((row) => {
      const meta = (typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata ?? {})) as {
        path?: string;
        start?: number;
        end?: number;
        text?: string;
      };
      return {
        path: String(meta.path ?? ""),
        start: Number(meta.start ?? 0),
        end: Number(meta.end ?? 0),
        text: String(meta.text ?? ""),
        distance: Number(row.distance),
      };
    });
  }
}

/** The observation a ```search action produces. */
export function formatSearchHits(query: string, hits: CodeSearchHit[]): string {
  if (hits.length === 0) return `No indexed code matched "${query}".`;
  const parts = hits.map((h) => `## ${h.path}:${h.start}-${h.end}\n${h.text}`);
  return `Top ${hits.length} matches for "${query}":\n\n${parts.join("\n\n")}`;
}
