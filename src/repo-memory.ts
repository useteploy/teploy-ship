import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentExecutor } from "@neutron-build/agents";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { stateDir } from "./run-store.js";

/**
 * Per-repo knowledge, two layers — the Devin-wiki idea, self-hosted:
 *
 * 1. The PLAYBOOK: a repo-committed SHIP.md (or .ship/playbook.md) the
 *    maintainer writes once — test commands, conventions, no-go zones.
 *    Read from the fresh clone at setup time, injected into every run
 *    on that repo.
 * 2. MEMORY: notes Ship records about its own past runs (task → PR,
 *    outcome), stored repo-scoped in the runtime's store and injected
 *    as "recent history" so later runs know what already happened.
 */

export interface RepoNote {
  /** owner/repo — the scope key. */
  repo: string;
  note: string;
  runId?: string;
  createdAt: string;
}

export interface RepoMemoryStore {
  record(note: Omit<RepoNote, "createdAt">): Promise<void>;
  /** Most recent first. */
  recent(repo: string, limit: number): Promise<RepoNote[]>;
  /** Every repo that has notes, with its note count — for the dashboard. */
  repos(): Promise<{ repo: string; count: number }[]>;
  /** Delete a single note, keyed by repo + its createdAt timestamp. */
  remove(repo: string, createdAt: string): Promise<void>;
}

/** File-backed memory: one JSONL per repo under the state dir. */
export class FileRepoMemory implements RepoMemoryStore {
  #dir: string;

  constructor(dir = join(stateDir(), "repo-memory")) {
    this.#dir = dir;
  }

  #file(repo: string): string {
    return join(this.#dir, `${repo.replace(/[^a-zA-Z0-9._-]/g, "_")}.jsonl`);
  }

  async record(note: Omit<RepoNote, "createdAt">): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const full: RepoNote = { ...note, createdAt: new Date().toISOString() };
    const path = this.#file(note.repo);
    const existing = await readFile(path, "utf8").catch(() => "");
    await writeFile(path, existing + JSON.stringify(full) + "\n");
  }

  #parse(raw: string): RepoNote[] {
    const notes: RepoNote[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        notes.push(JSON.parse(line) as RepoNote);
      } catch {
        // torn tail line — skip
      }
    }
    return notes;
  }

  async recent(repo: string, limit: number): Promise<RepoNote[]> {
    const raw = await readFile(this.#file(repo), "utf8").catch(() => "");
    return this.#parse(raw).reverse().slice(0, limit);
  }

  async repos(): Promise<{ repo: string; count: number }[]> {
    const { readdir } = await import("node:fs/promises");
    let files: string[];
    try {
      files = await readdir(this.#dir);
    } catch {
      return [];
    }
    const counts = new Map<string, number>();
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const raw = await readFile(join(this.#dir, file), "utf8").catch(() => "");
      for (const note of this.#parse(raw)) counts.set(note.repo, (counts.get(note.repo) ?? 0) + 1);
    }
    return [...counts.entries()].map(([repo, count]) => ({ repo, count }));
  }

  async remove(repo: string, createdAt: string): Promise<void> {
    const path = this.#file(repo);
    const raw = await readFile(path, "utf8").catch(() => "");
    const kept = this.#parse(raw).filter((n) => n.createdAt !== createdAt);
    await writeFile(path, kept.map((n) => JSON.stringify(n)).join("\n") + (kept.length > 0 ? "\n" : ""));
  }
}

/** Nucleus-backed memory over a ship_memory table (pgwire adapter). */
export class NucleusRepoMemory implements RepoMemoryStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_memory (
          repo TEXT,
          note TEXT,
          run_id TEXT,
          created_at TEXT
        )`,
      )
      .then(() => undefined);
    return this.#ready;
  }

  async record(note: Omit<RepoNote, "createdAt">): Promise<void> {
    await this.#ensure();
    await this.#db.query("INSERT INTO ship_memory (repo, note, run_id, created_at) VALUES ($1, $2, $3, $4)", [
      note.repo,
      note.note,
      note.runId ?? null,
      new Date().toISOString(),
    ]);
  }

  async recent(repo: string, limit: number): Promise<RepoNote[]> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT * FROM ship_memory WHERE repo = $1", [repo]);
    return rows
      .map((row) => {
        const note: RepoNote = {
          repo: String(row.repo),
          note: String(row.note),
          createdAt: String(row.created_at),
        };
        if (row.run_id !== null && row.run_id !== undefined) note.runId = String(row.run_id);
        return note;
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  async repos(): Promise<{ repo: string; count: number }[]> {
    await this.#ensure();
    // Aggregate client-side — simple SELECT is the reliably-supported path.
    const rows = await this.#db.query("SELECT repo FROM ship_memory");
    const counts = new Map<string, number>();
    for (const row of rows) {
      const repo = String(row.repo);
      counts.set(repo, (counts.get(repo) ?? 0) + 1);
    }
    return [...counts.entries()].map(([repo, count]) => ({ repo, count }));
  }

  async remove(repo: string, createdAt: string): Promise<void> {
    await this.#ensure();
    await this.#db.query("DELETE FROM ship_memory WHERE repo = $1 AND created_at = $2", [repo, createdAt]);
  }
}

const PLAYBOOK_FILES = ["SHIP.md", ".ship/playbook.md"];
const PLAYBOOK_CAP = 4000;
const NOTE_CAP = 300;
const RECENT_NOTES = 5;

/**
 * Assemble the context block injected into repo-run prompts: the repo's
 * playbook (if committed) plus Ship's recent notes on this repo. Reads
 * the playbook from the CLONED TREE via the executor — the same bytes
 * the agent could cat, so there is nothing to keep in sync.
 */
export async function loadRepoContext(
  executor: AgentExecutor,
  options: { repo: string; memory?: RepoMemoryStore },
): Promise<string> {
  const parts: string[] = [];
  for (const file of PLAYBOOK_FILES) {
    const result = await executor.exec(`cat ${file} 2>/dev/null`);
    if (result.exitCode === 0 && result.stdout.trim() !== "") {
      let text = result.stdout.trim();
      if (text.length > PLAYBOOK_CAP) text = `${text.slice(0, PLAYBOOK_CAP)}\n…(playbook truncated)`;
      parts.push(`# Repository playbook (${file}) — follow these instructions\n\n${text}`);
      break;
    }
  }
  if (options.memory !== undefined) {
    const notes = await options.memory.recent(options.repo, RECENT_NOTES);
    if (notes.length > 0) {
      const lines = notes.map((n) => `- [${n.createdAt.slice(0, 10)}] ${n.note}`);
      parts.push(`# Ship's recent history on this repository\n\n${lines.join("\n")}`);
    }
  }
  return parts.join("\n\n");
}

/** The compact note recorded after a repo run publishes (or declines to). */
export function runNote(options: { task: string; summary: string; pr?: string }): string {
  const task = options.task.replace(/\s+/g, " ").slice(0, 120);
  const outcome =
    options.pr !== undefined ? `PR ${options.pr}` : "no PR (empty diff)";
  const summary = options.summary.replace(/\s+/g, " ").slice(0, NOTE_CAP);
  return `${task} → ${outcome}. ${summary}`;
}
