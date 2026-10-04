import { createRecord, freshness, redactionPlan, applyRedactionPlan, visibleTo } from "./knowledge-record.js";
import type { Freshness, KnowledgeRecord, KnowledgeScope, KnowledgeSource, CurrentRevisionOf } from "./knowledge-record.js";
import type { KnowledgeStore } from "./knowledge-store.js";
import { canonicalRepositoryURL } from "./repository-reference.js";
import type { RepoNote } from "./repo-memory.js";

/**
 * S21 wiring: knowledge-record.ts applied to repo memory, behind
 * SHIP_KNOWLEDGE_PROVENANCE.
 *
 *   off     (default) nothing here runs. No store is built, nothing is written.
 *   shadow  provenance records are written ALONGSIDE the existing notes, and
 *           retrieval logs what it WOULD have hidden or labelled. What a run
 *           retrieves is never changed.
 *   on      context retrieval hides notes whose provenance is invalidated or
 *           unverifiable and labels the rest fresh|stale|unknown.
 *
 * PROJECT: Ship's repo-memory scope key (`repoKeyOf`) is repo-only; a project
 * is a separate record that can own several repos and has no hand in a note's
 * key. KnowledgeScope.project is required by the record module, so it is
 * OPTIONAL here: absent means REPO_ONLY_PROJECT (""), which matches exactly
 * itself, as visibleTo requires. Passing a real project later partitions
 * records without a schema change. Nothing infers a project from a repo.
 *
 * Redaction is not mode-gated beyond "off": a shadow record holds the note's
 * text, so deleting the note must delete (or invalidate) its record and
 * anything derived from it, or "shadow" would quietly retain deleted content.
 */
export type KnowledgeMode = "off" | "shadow" | "on";

export function knowledgeProvenanceMode(env: NodeJS.ProcessEnv = process.env): KnowledgeMode {
  const raw = (env.SHIP_KNOWLEDGE_PROVENANCE ?? "").trim().toLowerCase();
  return raw === "shadow" ? "shadow" : raw === "on" || raw === "1" || raw === "true" ? "on" : "off";
}

/** The project component for a note recorded without a project (see header). */
export const REPO_ONLY_PROJECT = "";

export const knowledgeScope = (repo: string, project: string = REPO_ONLY_PROJECT): KnowledgeScope => ({
  repo: canonicalRepositoryURL(repo) ?? repo,
  project,
});

/** What a caller knows about where a note's claim came from. All optional. */
export interface NoteProvenanceHint {
  /** The revision the claim is about (a run records the sha it pushed). */
  revision?: string;
  branch?: string;
  /** Overrides the inferred source kind (a run => 'run', no run => 'human'). */
  sourceKind?: KnowledgeSource["kind"];
  by?: string;
  project?: string;
}

/** What retrieval knows about the repo right now, so freshness can be judged. */
export interface RetrievalContext {
  head?: string;
  branch?: string;
}

export interface ShadowDecision {
  event: "knowledge-provenance";
  mode: KnowledgeMode;
  repo: string;
  /** Notes that `on` would have hidden, with the reason. */
  wouldHide: { noteId: string; reason: string }[];
  /** Label `on` would have attached, by note id. */
  wouldLabel: Record<string, Freshness>;
  /** Notes with no provenance record (written before the flag): shown, labelled unknown. */
  unrecorded: string[];
}

export interface KnowledgeProvenanceOptions {
  mode: KnowledgeMode;
  store: KnowledgeStore;
  /** One JSON line per retrieval that had something to report. */
  log?: (line: string) => void;
  now?: () => string;
}

export class KnowledgeProvenance {
  readonly mode: KnowledgeMode;
  #store: KnowledgeStore;
  #log: (line: string) => void;
  #now: () => string;

  constructor(options: KnowledgeProvenanceOptions) {
    this.mode = options.mode;
    this.#store = options.store;
    this.#log = options.log ?? ((line) => console.error(line));
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Write the provenance record for a note that was just recorded.
   *
   * A note is a HYPOTHESIS: its text is a model-written summary of a run, so
   * "the run is the source" says where it came from, not that it is true. It
   * becomes a fact only through verify() with independent evidence.
   */
  async recordNote(note: RepoNote, hint: NoteProvenanceHint = {}): Promise<void> {
    if (this.mode === "off") return;
    const scope = knowledgeScope(note.repo, hint.project);
    const kind = hint.sourceKind ?? (note.runId !== undefined ? "run" : "human");
    const source: KnowledgeSource = {
      kind,
      repo: scope.repo,
      revision: hint.revision ?? "",
      ...(hint.branch !== undefined ? { branch: hint.branch } : {}),
      ...(note.runId !== undefined ? { runId: note.runId } : {}),
      ...(kind === "human" ? { by: hint.by ?? "dashboard" } : hint.by !== undefined ? { by: hint.by } : {}),
    };
    await this.#store.put(
      createRecord({ id: note.noteId, kind: "hypothesis", statement: note.note, source, scope, createdAt: note.createdAt }),
    );
  }

  /**
   * A condenser summary: derivation 'summary', an agent claim, never evidence.
   * Idempotent by id — a replayed run reaches the same call again and must not
   * overwrite the first record (which may know more of derivedFrom).
   */
  async recordSummary(input: {
    id: string;
    repo: string;
    runId: string;
    summary: string;
    derivedFrom: string[];
    project?: string;
  }): Promise<void> {
    if (this.mode === "off") return;
    const scope = knowledgeScope(input.repo, input.project);
    await this.#store.putIfAbsent(
      createRecord({
        id: input.id,
        kind: "hypothesis",
        statement: input.summary,
        source: { kind: "agent-claim", repo: scope.repo, revision: "", runId: input.runId, by: "condenser" },
        scope,
        createdAt: this.#now(),
        derivedFrom: input.derivedFrom,
        derivation: "summary",
      }),
    );
  }

  /**
   * Decide what retrieval would do with `notes`. `on` returns the filtered,
   * labelled notes; `shadow` returns them untouched and logs the decision.
   * A provenance store that cannot be read: `on` fails closed (no notes),
   * `shadow` fails open and says so.
   */
  async screen(repo: string, notes: RepoNote[], ctx: RetrievalContext = {}, project?: string): Promise<RepoNote[]> {
    if (this.mode === "off" || notes.length === 0) return notes;
    const scope = knowledgeScope(repo, project);
    let records: KnowledgeRecord[];
    try {
      records = await this.#store.list(scope.repo);
    } catch (error) {
      this.#log(JSON.stringify({ event: "knowledge-provenance-error", mode: this.mode, repo: scope.repo, error: String(error) }));
      return this.mode === "on" ? [] : notes;
    }
    const visible = new Set(visibleTo(records, scope).map((r) => r.id));
    const byId = new Map(records.map((r) => [r.id, r]));
    // Without a resolvable head freshness is `unknown`, never `fresh`.
    const current: CurrentRevisionOf = () =>
      ctx.head === undefined || ctx.head === ""
        ? null
        : { head: ctx.head, ...(ctx.branch !== undefined ? { branch: ctx.branch } : {}), exists: true };

    const kept: RepoNote[] = [];
    const decision: ShadowDecision = { event: "knowledge-provenance", mode: this.mode, repo: scope.repo, wouldHide: [], wouldLabel: {}, unrecorded: [] };
    for (const note of notes) {
      const record = byId.get(note.noteId);
      if (record === undefined) {
        decision.unrecorded.push(note.noteId);
        decision.wouldLabel[note.noteId] = "unknown";
        kept.push({ ...note, freshness: "unknown" });
        continue;
      }
      if (!visible.has(record.id)) {
        decision.wouldHide.push({ noteId: note.noteId, reason: record.invalidated ? `invalidated: ${record.invalidated.reason}` : "outside scope or provenance unverifiable" });
        continue;
      }
      const label = freshness(record, current).freshness;
      decision.wouldLabel[note.noteId] = label;
      kept.push({ ...note, freshness: label });
    }
    if (this.mode === "shadow") {
      this.#log(JSON.stringify(decision));
      return notes;
    }
    return kept;
  }

  /**
   * Delete notes' provenance: the records themselves, and everything derived
   * from them (summaries invalidated, embeddings/exports deleted). Returns the
   * ids the plan DELETED (other than the requested ones), so a caller that
   * also holds those as notes can remove them too.
   */
  async redact(noteIds: readonly string[], repoHint?: string): Promise<{ deleted: string[]; invalidated: string[] }> {
    if (this.mode === "off") return { deleted: [], invalidated: [] };
    const found: KnowledgeRecord[] = [];
    const repos = new Set<string>(repoHint !== undefined && repoHint !== "" ? [knowledgeScope(repoHint).repo] : []);
    for (const id of noteIds) {
      const r = await this.#store.get(id);
      if (r !== undefined) repos.add(r.scope.repo);
    }
    for (const repo of repos) found.push(...(await this.#store.list(repo)));
    // A requested id with no record (a note from before the flag) can still be
    // the parent of a summary; a stub makes it a root so the cascade runs.
    const have = new Set(found.map((r) => r.id));
    const stubs: KnowledgeRecord[] = [];
    for (const id of noteIds) {
      if (have.has(id)) continue;
      for (const repo of repos) {
        stubs.push({ ...createRecord({ id, kind: "hypothesis", statement: "", source: { kind: "document", repo, revision: "" }, scope: { repo, project: REPO_ONLY_PROJECT }, createdAt: this.#now() }) });
      }
    }
    const plan = redactionPlan([...found, ...stubs], { deleteIds: noteIds });
    const real = new Set(found.map((r) => r.id));
    const after = new Map(applyRedactionPlan(found, plan).map((r) => [r.id, r]));
    const deleted: string[] = [];
    const invalidated: string[] = [];
    for (const step of plan.steps) {
      if (!real.has(step.id)) continue;
      if (step.action === "delete") {
        await this.#store.remove(step.id);
        if (!noteIds.includes(step.id)) deleted.push(step.id);
      } else {
        await this.#store.put(after.get(step.id)!);
        invalidated.push(step.id);
      }
    }
    return { deleted, invalidated };
  }
}
