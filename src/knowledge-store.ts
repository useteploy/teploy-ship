import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { withFileLock, writeTextFile } from "./file-store.js";
import type { KnowledgeRecord } from "./knowledge-record.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { stateDir } from "./run-store.js";

/**
 * Where S21 knowledge records live: a SIDECAR to ship_memory / the repo-memory
 * JSONL, never a change to them.
 *
 * A note keeps its existing row/line byte for byte. Its provenance (source,
 * derivedFrom, scope.project, corrections, verification, invalidated) is a
 * KnowledgeRecord stored under the same id in a NEW table (Nucleus) or a NEW
 * directory (file store). Nucleus cannot safely ALTER a populated table
 * (migrations.ts), so a new table created with CREATE TABLE IF NOT EXISTS is
 * the additive route: it needs no migration, holds no pre-existing rows, and
 * dropping it loses only provenance, never a note.
 *
 * Records are keyed by `id`. For a note that is the note's noteId; a condensed
 * summary has its own deterministic id. `repo` is the scope key the record was
 * written under (canonical when the repo has a canonical form).
 */
export interface KnowledgeStore {
  /** Insert or replace by id. */
  put(record: KnowledgeRecord): Promise<void>;
  /** Insert only when no record has this id. Returns whether it inserted. */
  putIfAbsent(record: KnowledgeRecord): Promise<boolean>;
  get(id: string): Promise<KnowledgeRecord | undefined>;
  /** Every record written under this repo key. */
  list(repo: string): Promise<KnowledgeRecord[]>;
  remove(id: string): Promise<void>;
}

export class InMemoryKnowledgeStore implements KnowledgeStore {
  #records = new Map<string, KnowledgeRecord>();
  async put(record: KnowledgeRecord): Promise<void> {
    this.#records.set(record.id, structuredClone(record));
  }
  async putIfAbsent(record: KnowledgeRecord): Promise<boolean> {
    if (this.#records.has(record.id)) return false;
    this.#records.set(record.id, structuredClone(record));
    return true;
  }
  async get(id: string): Promise<KnowledgeRecord | undefined> {
    const r = this.#records.get(id);
    return r === undefined ? undefined : structuredClone(r);
  }
  async list(repo: string): Promise<KnowledgeRecord[]> {
    return [...this.#records.values()].filter((r) => r.scope.repo === repo).map((r) => structuredClone(r));
  }
  async remove(id: string): Promise<void> {
    this.#records.delete(id);
  }
}

/**
 * File-backed: one JSONL per repo key under `<state>/knowledge-records`. A
 * different directory from repo-memory, so FileRepoMemory.repos() (which counts
 * every .jsonl it finds) never sees these. Writes are lock + atomic rewrite,
 * like FileRepoMemory.remove.
 */
export class FileKnowledgeStore implements KnowledgeStore {
  #dir: string;
  constructor(dir = join(stateDir(), "knowledge-records")) {
    this.#dir = dir;
  }
  #file(repo: string): string {
    return join(this.#dir, `${repo.replace(/[^a-zA-Z0-9._-]/g, "_")}.jsonl`);
  }
  #parse(raw: string): KnowledgeRecord[] {
    const out: KnowledgeRecord[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push(JSON.parse(line) as KnowledgeRecord);
      } catch {
        // torn tail line — skip
      }
    }
    return out;
  }
  async #mutate(repo: string, fn: (records: KnowledgeRecord[]) => KnowledgeRecord[] | null): Promise<void> {
    const path = this.#file(repo);
    await withFileLock(path, async () => {
      const current = this.#parse(await readFile(path, "utf8").catch(() => ""));
      const next = fn(current);
      if (next === null) return;
      await writeTextFile(path, next.map((r) => JSON.stringify(r)).join("\n") + (next.length > 0 ? "\n" : ""));
    });
  }
  async put(record: KnowledgeRecord): Promise<void> {
    await this.#mutate(record.scope.repo, (rs) => [...rs.filter((r) => r.id !== record.id), record]);
  }
  async putIfAbsent(record: KnowledgeRecord): Promise<boolean> {
    let inserted = false;
    await this.#mutate(record.scope.repo, (rs) => {
      if (rs.some((r) => r.id === record.id)) return null;
      inserted = true;
      return [...rs, record];
    });
    return inserted;
  }
  async #all(): Promise<KnowledgeRecord[]> {
    const files = await readdir(this.#dir).catch(() => [] as string[]);
    const out: KnowledgeRecord[] = [];
    for (const f of files) {
      if (f.endsWith(".jsonl")) out.push(...this.#parse(await readFile(join(this.#dir, f), "utf8").catch(() => "")));
    }
    return out;
  }
  async get(id: string): Promise<KnowledgeRecord | undefined> {
    return (await this.#all()).find((r) => r.id === id);
  }
  async list(repo: string): Promise<KnowledgeRecord[]> {
    // Filter by scope.repo: the filename is sanitized, so repos can collide on one file.
    return this.#parse(await readFile(this.#file(repo), "utf8").catch(() => "")).filter((r) => r.scope.repo === repo);
  }
  async remove(id: string): Promise<void> {
    const found = await this.get(id);
    if (found === undefined) return;
    await this.#mutate(found.scope.repo, (rs) => rs.filter((r) => r.id !== id));
  }
}

/** Nucleus-backed: a NEW table, created on first use. */
export class NucleusKnowledgeStore implements KnowledgeStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;
  constructor(db: NucleusPgwire) {
    this.#db = db;
  }
  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_knowledge_records (
          record_id TEXT,
          repo TEXT,
          project TEXT,
          record TEXT,
          updated_at TEXT
        )`,
      )
      .then(() => undefined)
      // Same rule as ship_memory: a failed ensure must not be cached.
      .catch((error: unknown) => {
        this.#ready = null;
        throw error;
      });
    return this.#ready;
  }
  #parse(row: Record<string, unknown>): KnowledgeRecord | undefined {
    try {
      return JSON.parse(String(row.record)) as KnowledgeRecord;
    } catch {
      return undefined;
    }
  }
  async put(record: KnowledgeRecord): Promise<void> {
    await this.#ensure();
    // No upsert: delete-then-insert, the pattern the other Nucleus stores use.
    await this.#db.query("DELETE FROM ship_knowledge_records WHERE record_id = $1", [record.id]);
    await this.#insert(record);
  }
  async #insert(record: KnowledgeRecord): Promise<void> {
    await this.#db.query(
      "INSERT INTO ship_knowledge_records (record_id, repo, project, record, updated_at) VALUES ($1, $2, $3, $4, $5)",
      [record.id, record.scope.repo, record.scope.project, JSON.stringify(record), new Date().toISOString()],
    );
  }
  async putIfAbsent(record: KnowledgeRecord): Promise<boolean> {
    await this.#ensure();
    if ((await this.get(record.id)) !== undefined) return false;
    await this.#insert(record);
    return true;
  }
  async get(id: string): Promise<KnowledgeRecord | undefined> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT record FROM ship_knowledge_records WHERE record_id = $1", [id]);
    return rows.length === 0 ? undefined : this.#parse(rows[0]!);
  }
  async list(repo: string): Promise<KnowledgeRecord[]> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT record FROM ship_knowledge_records WHERE repo = $1", [repo]);
    return rows.map((r) => this.#parse(r)).filter((r): r is KnowledgeRecord => r !== undefined);
  }
  async remove(id: string): Promise<void> {
    await this.#ensure();
    await this.#db.query("DELETE FROM ship_knowledge_records WHERE record_id = $1", [id]);
  }
}
