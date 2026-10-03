/**
 * Finding continuity across review revisions (S09).
 *
 * WHY THIS FILE EXISTS. A review of revision 2 that does not know about the
 * review of revision 1 starts from zero every time: findings the author fixed
 * look the same as findings the reviewer forgot, a defect a human already
 * signed off reappears as if it were news, and "resolved" quietly means
 * "stopped being mentioned". This module is the pure comparison that fixes
 * that: given the earlier review's findings (and the revision they applied
 * to), the later review's findings, and optionally the unified diff between
 * the two revisions, say what happened to every finding.
 *
 * THE RULES, in the order they bite:
 *
 *  1. IDENTITY IS NOT A LINE NUMBER. A finding is anchored on file + the
 *     normalised code it cites + its symbol + its wording. Line numbers are a
 *     weak tiebreaker only, and when a diff is available the prior line is
 *     first translated through the diff's hunks. Matching on line alone
 *     misclassifies every insertion above the finding (drift) as "fixed + new".
 *  2. NOTHING IS SILENTLY DROPPED. Every input finding ends up in an entry,
 *     either as its `prior`/`current` or in `mergedDuplicates`.
 *  3. "RESOLVED" NEEDS EVIDENCE. A prior finding that is absent from the later
 *     report is `resolved` ONLY when the diff shows its cited code changed in a
 *     way that is not a pure reformat (or its file was deleted). A finding
 *     whose code is untouched but which the reviewer stopped reporting is
 *     `unconfirmed-disappearance`: the reviewer may have missed it, which is
 *     exactly the case a reviewer-only signal cannot tell from a fix. With no
 *     diff at all nothing can be proven fixed, so nothing is `resolved`.
 *  4. A RESOLUTION IS A DECISION. A prior finding carrying a `resolution`
 *     (human or automated) that shows up again is `regressed`, never quietly
 *     `still-open`, and a human resolution that a later automated finding
 *     contradicts says so (`humanResolutionOverridden`). Unmatched, it stays
 *     `resolved` with the decision carried.
 *  5. ATTRIBUTION IS HONEST ABOUT ITS BASIS. `introduced` / `existing` come
 *     from whether the cited lines are touched by a diff. The revision-to-
 *     revision diff can prove "touched by this revision" but cannot prove
 *     "pre-existing": untouched there means introduced by an earlier revision
 *     OR pre-existing. So without a base..head diff, untouched is
 *     `undeterminable`, with the reason stated, not guessed.
 *
 * Pure and dependency-free (besides the finding types and node:crypto): no
 * I/O, no clock, deterministic ordering. Not yet wired into the review flow.
 */

import { createHash } from "node:crypto";
import type { FindingSeverity, ScanFinding } from "./findings.js";

// ── Types ─────────────────────────────────────────────────────────────────

export type FindingConfidence = "low" | "med" | "high";

export type AttributionKind = "introduced" | "existing" | "undeterminable";

export interface FindingResolution {
  by: "human" | "automated";
  /** Who or what resolved it (login, check name). */
  actor?: string;
  at?: string;
  note?: string;
}

export interface FindingComment {
  author: string;
  body: string;
  at?: string;
}

/**
 * A scan finding plus what a revision-aware review needs. Everything beyond
 * ScanFinding is optional so existing `ScanFinding[]` flow in unchanged; the
 * more of `snippet`/`symbol` a review supplies, the better identity holds.
 */
export interface ReviewFinding extends ScanFinding {
  /** Stable identity assigned by an earlier continuity pass; carried forward. */
  id?: string;
  confidence?: FindingConfidence;
  /** Concrete evidence (command output, trace, quoted code) for the claim. */
  evidence?: string;
  /** The code the finding cites, verbatim. The strongest identity anchor. */
  snippet?: string;
  /** Enclosing function/class/symbol, when the reviewer named one. */
  symbol?: string;
  /** Present when someone (or something) decided this finding is dealt with. */
  resolution?: FindingResolution;
  comments?: FindingComment[];
  /** Attribution established by an earlier pass; kept when determinable. */
  attribution?: AttributionKind;
}

export interface ReviewSnapshot {
  /** Commit/head the findings were produced against. */
  revision: string;
  findings: ReviewFinding[];
}

export type ContinuityStatus =
  | "still-open"
  | "resolved"
  | "regressed"
  | "new"
  | "moved"
  | "superseded"
  | "unconfirmed-disappearance";

export interface Attribution {
  kind: AttributionKind;
  /** Which diff the answer rests on. */
  basis: "base-diff" | "revision-diff" | "carried" | "none";
  reason: string;
}

export interface ContinuityEntry {
  /** Stable across revisions: the prior's id when matched. */
  id: string;
  status: ContinuityStatus;
  /** The freshest version of the finding (current if it exists, else prior). */
  finding: ReviewFinding;
  prior?: ReviewFinding;
  current?: ReviewFinding;
  reason: string;
  attribution: Attribution;
  /** 0..1 identity score when a prior was matched to a current finding. */
  matchScore?: number;
  renamedFrom?: string;
  movedFrom?: { file: string; line?: number };
  /** Near-duplicates folded into this entry (kept, never discarded). */
  mergedDuplicates: ReviewFinding[];
  supersededBy?: string;
  supersedes?: string;
  humanResolutionOverridden?: boolean;
  /** Carried decision, for resolved entries whose resolution came from a person/check. */
  resolution?: FindingResolution;
  /** Union of prior and current comments (de-duplicated). */
  comments: FindingComment[];
}

export interface ContinuityInput {
  prior: ReviewSnapshot;
  later: ReviewSnapshot;
  /** Unified diff prior.revision..later.revision. */
  diff?: string;
  /** Unified diff base..later.revision, the only basis that can prove `existing`. */
  baseDiff?: string;
}

export interface ContinuityResult {
  entries: ContinuityEntry[];
  counts: Record<ContinuityStatus, number>;
  diffAvailable: boolean;
  warnings: string[];
}

// ── Unified diff ──────────────────────────────────────────────────────────

interface DiffLine {
  t: "+" | "-" | " ";
  text: string;
  /** 1-based line in the old file (for " " and "-"). */
  old?: number;
  /** 1-based line in the new file (for " " and "+"). */
  neu?: number;
  /** For "+": last old line seen before it (0 = file start). */
  afterOld?: number;
}

interface DiffHunk {
  lines: DiffLine[];
  oldStart: number;
  oldCount: number;
}

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  hunks: DiffHunk[];
}

function stripPrefix(p: string): string {
  const cut = p.split("\t")[0]!.trim();
  return /^[ab]\//.test(cut) ? cut.slice(2) : cut;
}

/** Parse a unified diff. Hunk bodies are consumed by their header counts, so a
 * removed line that happens to read `-- x` is never mistaken for a file header. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  const rows = text.replace(/\r\n/g, "\n").split("\n");
  let cur: DiffFile | null = null;
  const start = (): DiffFile => {
    cur = { oldPath: null, newPath: null, hunks: [] };
    files.push(cur);
    return cur;
  };
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.startsWith("diff --git ")) {
      const f = start();
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(row);
      if (m) {
        f.oldPath = m[1]!;
        f.newPath = m[2]!;
      }
    } else if (row.startsWith("rename from ") && cur) (cur as DiffFile).oldPath = row.slice(12);
    else if (row.startsWith("rename to ") && cur) (cur as DiffFile).newPath = row.slice(10);
    else if (row.startsWith("--- ") && rows[i + 1]?.startsWith("+++ ")) {
      // A bare unified diff has no `diff --git` line: a `---` followed by `+++`
      // outside a hunk starts a file.
      const f = cur && (cur as DiffFile).hunks.length === 0 ? (cur as DiffFile) : start();
      const o = row.slice(4);
      const n = rows[i + 1]!.slice(4);
      f.oldPath = o.startsWith("/dev/null") ? null : stripPrefix(o);
      f.newPath = n.startsWith("/dev/null") ? null : stripPrefix(n);
      i += 1;
    } else if (row.startsWith("new file mode") && cur) (cur as DiffFile).oldPath = null;
    else if (row.startsWith("deleted file mode") && cur) (cur as DiffFile).newPath = null;
    else if (row.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
      if (!m || !cur) continue;
      const oldStart = Number(m[1]);
      const oldCount = m[2] === undefined ? 1 : Number(m[2]);
      let neu = Number(m[3]);
      const newCount = m[4] === undefined ? 1 : Number(m[4]);
      let old = oldCount === 0 ? oldStart + 1 : oldStart;
      if (oldCount === 0 && neu === 0) neu = 1;
      const hunk: DiffHunk = { lines: [], oldStart: old, oldCount };
      let o = 0;
      let n = 0;
      while ((o < oldCount || n < newCount) && i + 1 < rows.length) {
        const body = rows[i + 1]!;
        const c = body[0];
        if (c === "\\") {
          i += 1;
          continue;
        }
        if (c === "+") {
          hunk.lines.push({ t: "+", text: body.slice(1), neu, afterOld: old - 1 });
          neu += 1;
          n += 1;
        } else if (c === "-") {
          hunk.lines.push({ t: "-", text: body.slice(1), old });
          old += 1;
          o += 1;
        } else if (c === " " || body === "") {
          hunk.lines.push({ t: " ", text: body.slice(1), old, neu });
          old += 1;
          neu += 1;
          o += 1;
          n += 1;
        } else break;
        i += 1;
      }
      (cur as DiffFile).hunks.push(hunk);
    }
  }
  return files.filter((f) => f.oldPath !== null || f.newPath !== null);
}

const squash = (s: string): string => s.replace(/\s+/g, "").replace(/[;,]+$/, "");

class DiffIndex {
  private byOld = new Map<string, DiffFile>();
  private byNew = new Map<string, DiffFile>();
  constructor(readonly files: DiffFile[]) {
    for (const f of files) {
      if (f.oldPath !== null) this.byOld.set(f.oldPath, f);
      if (f.newPath !== null) this.byNew.set(f.newPath, f);
    }
  }
  /** Where an old path lives after the diff; null if the file was deleted. */
  mapPath(old: string): string | null {
    const f = this.byOld.get(old);
    return f ? f.newPath : old;
  }
  oldNameOf(neu: string): string | undefined {
    const f = this.byNew.get(neu);
    return f && f.oldPath !== null && f.oldPath !== neu ? f.oldPath : undefined;
  }
  isNewFile(neu: string): boolean {
    const f = this.byNew.get(neu);
    return !!f && f.oldPath === null;
  }
  /** Old line to its new number, or null when the diff removed/changed it. */
  mapLine(oldPath: string, line: number): number | null {
    const f = this.byOld.get(oldPath);
    if (!f) return line;
    if (f.newPath === null) return null;
    let delta = 0;
    for (const h of f.hunks) {
      if (line < h.oldStart) return line + delta;
      if (line < h.oldStart + h.oldCount) {
        const hit = h.lines.find((l) => l.t === " " && l.old === line);
        return hit ? hit.neu! : null;
      }
      delta += h.lines.filter((l) => l.t === "+").length - h.lines.filter((l) => l.t === "-").length;
    }
    return line + delta;
  }
  /**
   * Did the diff change the old range [a,b] of a file in a way that matters?
   * `touched` is any removal in range or insertion strictly inside it;
   * `meaningful` is false when the change is only whitespace/punctuation
   * reformatting or a line shuffled within its hunk. An insertion just
   * before or after the range does NOT count: a guard added above a cited
   * line may or may not be the fix, so it stays an unconfirmed disappearance.
   */
  changedOld(oldPath: string, a: number, b: number, snippetNorm: string[]): { touched: boolean; meaningful: boolean; why: string } {
    const f = this.byOld.get(oldPath);
    if (!f) return { touched: false, meaningful: false, why: "file not in diff" };
    if (f.newPath === null) return { touched: true, meaningful: true, why: "file deleted by the diff" };
    let touched = false;
    let meaningful = false;
    let why = "";
    for (const h of f.hunks) {
      const removed = h.lines.filter((l) => l.t === "-");
      const added = h.lines.filter((l) => l.t === "+");
      const removedSet = new Set(removed.map((l) => squash(l.text)));
      const addedSet = new Set(added.map((l) => squash(l.text)));
      for (const l of removed) {
        const inRange = l.old! >= a && l.old! <= b;
        const bySnippet = squash(l.text) !== "" && snippetNorm.includes(squash(l.text));
        if (!inRange && !bySnippet) continue;
        touched = true;
        if (squash(l.text) !== "" && !addedSet.has(squash(l.text))) {
          meaningful = true;
          why = `line ${l.old} removed or rewritten`;
        }
      }
      for (const l of added) {
        if (l.afterOld! >= a && l.afterOld! < b) {
          touched = true;
          if (squash(l.text) !== "" && !removedSet.has(squash(l.text))) {
            meaningful = true;
            why ||= `lines inserted inside the cited range at ${l.neu}`;
          }
        }
      }
    }
    return { touched, meaningful, why: why || (touched ? "only whitespace or reordering changed" : "cited lines not in any hunk") };
  }
  /** Was any line of new range [a,b] added by the diff (or snippet line added)? */
  addedNew(neuPath: string, a: number | null, b: number | null, snippetNorm: string[]): boolean {
    const f = this.byNew.get(neuPath);
    if (!f) return false;
    if (f.oldPath === null) return true;
    for (const h of f.hunks)
      for (const l of h.lines) {
        if (l.t !== "+") continue;
        if (a !== null && b !== null && l.neu! >= a && l.neu! <= b) return true;
        if (a === null && snippetNorm.includes(squash(l.text)) && squash(l.text) !== "") return true;
      }
    return false;
  }
}

// ── Normalisation and similarity ──────────────────────────────────────────

const STOP = new Set(["the", "a", "an", "is", "are", "of", "in", "to", "and", "or", "for", "on", "this", "that", "not", "be", "can", "may", "with", "when", "it", "as", "at", "by"]);

function snippetLines(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split("\n")
    .map(squash)
    .filter((l) => l !== "");
}

function words(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function snippetSim(a: ReviewFinding, b: ReviewFinding): number | null {
  const la = snippetLines(a.snippet);
  const lb = snippetLines(b.snippet);
  if (la.length === 0 || lb.length === 0) return null;
  // Line-set overlap catches a moved block; token overlap catches a renamed
  // variable inside otherwise identical lines. Token overlap is discounted.
  return Math.max(jaccard(la, lb), 0.9 * jaccard(words(a.snippet!), words(b.snippet!)));
}

const titleSim = (a: ReviewFinding, b: ReviewFinding): number => jaccard(words(a.title), words(b.title));

function symbolOf(f: ReviewFinding): string | null {
  if (f.symbol && f.symbol.trim() !== "") return f.symbol.trim();
  const m = /\b(?:function|class|def|fn|func|interface|type)\s+([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/.exec(f.snippet ?? "");
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** Cited range [a,b], or null if the finding cites no line. */
function rangeOf(f: ReviewFinding): [number, number] | null {
  if (f.line === undefined) return null;
  const n = Math.max(1, (f.snippet ?? "").split("\n").filter((l) => l.trim() !== "").length);
  return [f.line, f.line + n - 1];
}

/** Stable fingerprint: file + symbol + code (or wording when no code is cited). */
export function findingFingerprint(f: ReviewFinding): string {
  const code = snippetLines(f.snippet).join("\n");
  const anchor = code !== "" ? code : words(f.title).sort().join(" ");
  const h = createHash("sha256").update(`${f.file}\u0000${symbolOf(f) ?? ""}\u0000${anchor}`).digest("hex");
  return `fnd_${h.slice(0, 12)}`;
}

const SEV: Record<FindingSeverity, number> = { low: 0, med: 1, high: 2 };

// ── De-duplication within one report ──────────────────────────────────────

interface Folded {
  f: ReviewFinding;
  dups: ReviewFinding[];
}

function nearDuplicate(a: ReviewFinding, b: ReviewFinding): boolean {
  if (a.file !== b.file) return false;
  const snip = snippetSim(a, b);
  const t = titleSim(a, b);
  if (snip !== null) return snip >= 0.9 && t >= 0.4;
  const close = a.line === undefined || b.line === undefined || Math.abs(a.line - b.line) <= 3;
  return t >= 0.8 && close;
}

function fold(list: ReviewFinding[]): Folded[] {
  const out: Folded[] = [];
  for (const f of list) {
    const hit = out.find((o) => nearDuplicate(o.f, f));
    if (!hit) {
      out.push({ f, dups: [] });
      continue;
    }
    if (SEV[f.severity] > SEV[hit.f.severity]) {
      hit.dups.push(hit.f);
      hit.f = f;
    } else hit.dups.push(f);
  }
  return out;
}

// ── Classification ────────────────────────────────────────────────────────

const THRESHOLD = 0.55;

interface PriorCtx {
  f: ReviewFinding;
  id: string;
  /** File after the revision diff (rename-aware); null if deleted. */
  mappedFile: string | null;
  mappedLine: number | null;
  dups: ReviewFinding[];
}

function score(p: PriorCtx, l: ReviewFinding): number {
  const sameFile = p.mappedFile === l.file;
  const snip = snippetSim(p.f, l);
  const title = titleSim(p.f, l);
  if (!sameFile) {
    // A block that left its file is only recognised by identical code, and
    // a trivial one-liner is not identity (`return null` is everywhere).
    if (snip === null || snip < 0.9 || title < 0.3 || snippetLines(p.f.snippet).join("").length < 12) return 0;
  }
  const sa = symbolOf(p.f);
  const sb = symbolOf(l);
  const sym = sa && sb ? (sa === sb ? 1 : 0) : null;
  const target = p.mappedLine ?? p.f.line;
  const lineNear = target !== undefined && target !== null && l.line !== undefined ? Math.max(0, 1 - Math.abs(target - l.line) / 20) : null;
  if (snip !== null) {
    let s = 0.5 * snip + 0.3 * title + 0.1 * (sym ?? 0.5) + 0.1 * (lineNear ?? 0.5);
    if (sym === 0) s -= 0.1;
    return s;
  }
  return 0.6 * title + 0.15 * (sym ?? 0.5) + 0.25 * (lineNear ?? 0.5);
}

function mergeComments(...lists: (FindingComment[] | undefined)[]): FindingComment[] {
  const seen = new Set<string>();
  const out: FindingComment[] = [];
  for (const c of lists.flatMap((l) => l ?? [])) {
    const k = `${c.author}\u0000${c.body}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

function attribute(f: ReviewFinding, ix: DiffIndex | null, basis: "base-diff" | "revision-diff", carried?: AttributionKind): Attribution {
  if (carried && carried !== "undeterminable") return { kind: carried, basis: "carried", reason: `attribution established by an earlier review (${carried}) is kept` };
  if (!ix) return { kind: "undeterminable", basis: "none", reason: "no diff was supplied, so whether the cited lines are touched is unknown" };
  const r = rangeOf(f);
  const snip = snippetLines(f.snippet);
  if (r === null && snip.length === 0 && !ix.isNewFile(f.file))
    return { kind: "undeterminable", basis: "none", reason: "the finding cites neither a line nor code, so it cannot be placed against the diff" };
  const touched = ix.addedNew(f.file, r ? r[0] : null, r ? r[1] : null, snip);
  if (touched)
    return {
      kind: "introduced",
      basis,
      reason: basis === "base-diff" ? "cited lines are added or changed by the change under review" : "cited lines were added or changed by this revision",
    };
  if (basis === "base-diff") return { kind: "existing", basis, reason: "cited lines are not touched by the change under review" };
  return {
    kind: "undeterminable",
    basis: "revision-diff",
    reason: "cited lines are untouched by this revision, which means introduced by an earlier revision OR pre-existing; a base diff is needed to tell",
  };
}

export function classifyFindingContinuity(input: ContinuityInput): ContinuityResult {
  const warnings: string[] = [];
  const revDiff = input.diff !== undefined ? new DiffIndex(parseUnifiedDiff(input.diff)) : null;
  if (input.diff !== undefined && input.diff.trim() !== "" && revDiff!.files.length === 0) warnings.push("the supplied diff contained no parseable files; treated as unavailable evidence of change");
  const usableRev = revDiff && revDiff.files.length > 0 ? revDiff : revDiff && input.diff!.trim() === "" ? revDiff : null;
  const baseIx = input.baseDiff !== undefined ? new DiffIndex(parseUnifiedDiff(input.baseDiff)) : null;
  const attrIx = baseIx && baseIx.files.length > 0 ? baseIx : null;
  if (input.baseDiff !== undefined && !attrIx && input.baseDiff.trim() !== "") warnings.push("the supplied base diff contained no parseable files");

  const priors: PriorCtx[] = fold(input.prior.findings).map(({ f, dups }) => {
    const mappedFile = usableRev ? usableRev.mapPath(f.file) : f.file;
    const mappedLine = f.line === undefined ? null : usableRev ? usableRev.mapLine(f.file, f.line) : f.line;
    return { f, id: f.id ?? findingFingerprint(f), mappedFile, mappedLine, dups };
  });
  const laters = fold(input.later.findings);

  // Greedy one-to-one assignment by descending score; ties by input order.
  const pairs: { p: number; l: number; s: number }[] = [];
  priors.forEach((p, pi) =>
    laters.forEach((l, li) => {
      const s = score(p, l.f);
      if (s >= THRESHOLD) pairs.push({ p: pi, l: li, s });
    }),
  );
  pairs.sort((a, b) => b.s - a.s || a.p - b.p || a.l - b.l);
  const matchOf = new Map<number, { l: number; s: number }>();
  const claimed = new Set<number>();
  for (const pr of pairs) {
    if (matchOf.has(pr.p) || claimed.has(pr.l)) continue;
    matchOf.set(pr.p, { l: pr.l, s: pr.s });
    claimed.add(pr.l);
  }

  const entries: ContinuityEntry[] = [];
  const usedIds = new Set<string>();
  const uniqueId = (id: string): string => {
    let out = id;
    for (let n = 2; usedIds.has(out); n++) out = `${id}-${n}`;
    usedIds.add(out);
    return out;
  };
  const superseders = new Map<number, string>(); // later index -> prior id

  const attributionFor = (f: ReviewFinding, carried?: AttributionKind): Attribution => (attrIx ? attribute(f, attrIx, "base-diff", carried) : attribute(f, usableRev, "revision-diff", carried));

  priors.forEach((p, pi) => {
    const id = uniqueId(p.id);
    const m = matchOf.get(pi);
    const decided = p.f.resolution;
    if (m) {
      const cur = laters[m.l]!;
      const renamedFrom = p.f.file !== cur.f.file && usableRev?.mapPath(p.f.file) === cur.f.file ? p.f.file : undefined;
      const crossFile = p.f.file !== cur.f.file && renamedFrom === undefined;
      const sameCode = (snippetSim(p.f, cur.f) ?? 0) >= 0.9;
      // Where the diff says the cited line should now be. A line the diff
      // removed (cut and pasted elsewhere) is compared at its old number.
      const expected = p.mappedLine ?? p.f.line;
      const jumped = usableRev !== null && !crossFile && sameCode && expected !== undefined && expected !== null && cur.f.line !== undefined && Math.abs(expected - cur.f.line) > 3;
      const base = {
        id,
        finding: cur.f,
        prior: p.f,
        current: cur.f,
        matchScore: Math.round(m.s * 1000) / 1000,
        mergedDuplicates: [...p.dups, ...cur.dups],
        attribution: attributionFor(cur.f, p.f.attribution ?? cur.f.attribution),
        comments: mergeComments(p.f.comments, cur.f.comments),
        ...(renamedFrom ? { renamedFrom } : {}),
      };
      if (decided) {
        entries.push({
          ...base,
          status: "regressed",
          reason: `previously resolved${decided.by === "human" ? " by a human" : " automatically"}${decided.actor ? ` (${decided.actor})` : ""}, reported again at revision ${input.later.revision}`,
          resolution: decided,
          ...(decided.by === "human" ? { humanResolutionOverridden: true } : {}),
        });
      } else if (crossFile || jumped) {
        entries.push({
          ...base,
          status: "moved",
          reason: crossFile ? `same code now reported in ${cur.f.file}` : `same code, line ${expected} expected after the diff but reported at ${cur.f.line}: a relocation, not drift`,
          movedFrom: { file: p.f.file, ...(p.f.line !== undefined ? { line: p.f.line } : {}) },
        });
      } else {
        entries.push({
          ...base,
          status: "still-open",
          reason: renamedFrom ? `still reported; file renamed from ${renamedFrom}` : "still reported; line drift, if any, is explained by the diff or within tolerance",
        });
      }
      return;
    }

    const prAttr: Attribution = p.f.attribution
      ? { kind: p.f.attribution, basis: "carried", reason: "earlier attribution kept; no current finding to re-attribute" }
      : { kind: "undeterminable", basis: "none", reason: "no current finding to attribute" };
    const common = { id, finding: p.f, prior: p.f, mergedDuplicates: p.dups, attribution: prAttr, comments: mergeComments(p.f.comments) };

    // Superseded: the same place is reported again under a different
    // diagnosis. Preferred over resolved/unconfirmed because the location is
    // still being reviewed, just not as this finding.
    let best: { li: number; s: number } | null = null;
    laters.forEach((l, li) => {
      if (claimed.has(li) || p.mappedFile !== l.f.file) return;
      const snip = snippetSim(p.f, l.f);
      const target = p.mappedLine ?? p.f.line;
      const near = target !== undefined && target !== null && l.f.line !== undefined ? Math.max(0, 1 - Math.abs(target - l.f.line) / 6) : 0;
      const s = Math.max(snip ?? 0, near);
      if ((snip !== null && snip >= 0.4) || near >= 0.5) if (!best || s > best.s) best = { li, s };
    });
    if (decided) {
      entries.push({ ...common, status: "resolved", reason: `resolution carried from an earlier revision${decided.by === "human" ? " (human decision)" : ""}; not reported again`, resolution: decided });
      return;
    }
    if (best) {
      const li = (best as { li: number }).li;
      claimed.add(li);
      superseders.set(li, id);
      entries.push({ ...common, status: "superseded", reason: `the same location is now reported as "${laters[li]!.f.title}"` });
      return;
    }
    if (!usableRev) {
      entries.push({ ...common, status: "unconfirmed-disappearance", reason: "no longer reported, and no diff was supplied, so a fix cannot be shown; not treated as resolved" });
      return;
    }
    if (p.mappedFile === null) {
      entries.push({ ...common, status: "resolved", reason: "its file was deleted by the diff" });
      return;
    }
    const r = rangeOf(p.f);
    const snip = snippetLines(p.f.snippet);
    if (r === null && snip.length === 0) {
      entries.push({ ...common, status: "unconfirmed-disappearance", reason: "no longer reported; the finding cited neither a line nor code, so the diff cannot show whether it was fixed" });
      return;
    }
    const ch = usableRev.changedOld(p.f.file, r ? r[0] : Number.MAX_SAFE_INTEGER, r ? r[1] : -1, snip);
    if (ch.touched && ch.meaningful) entries.push({ ...common, status: "resolved", reason: `cited code changed by the diff: ${ch.why}` });
    else
      entries.push({
        ...common,
        status: "unconfirmed-disappearance",
        reason: ch.touched
          ? `no longer reported, but the cited code only changed cosmetically (${ch.why}); not treated as resolved`
          : `no longer reported, but the cited code is unchanged by the diff (${ch.why}); the reviewer may have missed it, not treated as resolved`,
      });
  });

  laters.forEach((l, li) => {
    if (claimed.has(li) && !superseders.has(li)) return;
    const sup = superseders.get(li);
    entries.push({
      id: uniqueId(l.f.id ?? findingFingerprint(l.f)),
      status: "new",
      finding: l.f,
      current: l.f,
      reason: sup ? `replaces earlier finding ${sup} at the same location` : "not present in the earlier review",
      attribution: attributionFor(l.f, l.f.attribution),
      mergedDuplicates: l.dups,
      comments: mergeComments(l.f.comments),
      ...(sup ? { supersedes: sup } : {}),
    });
  });
  for (const e of entries) {
    if (e.status !== "superseded") continue;
    const by = entries.find((x) => x.supersedes === e.id);
    if (by) e.supersededBy = by.id;
  }

  const counts: Record<ContinuityStatus, number> = { "still-open": 0, resolved: 0, regressed: 0, new: 0, moved: 0, superseded: 0, "unconfirmed-disappearance": 0 };
  for (const e of entries) counts[e.status] += 1;
  return { entries, counts, diffAvailable: usableRev !== null, warnings };
}
