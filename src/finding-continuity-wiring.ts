/**
 * Wiring for finding continuity (S09): how a review run finds the earlier
 * review of the same pull request, compares against it, and records the
 * answer. The comparison itself is finding-continuity.ts and is untouched.
 *
 * ADVISORY ONLY, behind SHIP_FINDING_CONTINUITY=on (default off). Nothing
 * here feeds approval, merge, classification or the delivery record; the
 * result is text a reviewer reads. A gate built on thresholds nobody has
 * validated on real pull requests would be a guess with authority.
 *
 * WHERE IT RUNS. Inside the existing `scan-findings` step, not a new one. The
 * durable rule is that the step sequence is a function of the input, and a
 * flag read from the environment is not input: a new step present on some
 * workers and absent on others would make a replayed log disagree with itself.
 * The step's RESULT gains an additive `continuity` field instead, which a
 * replay reads back from the log and never recomputes.
 *
 * WHICH RUN IS "EARLIER". The most recent run before this one that was a scan
 * of the same repo and the same pull request (or, with no pull request, the
 * same task text), completed, and recorded a findings array. Ordered by the
 * recorded `run-started` time, never by run id. Anything unreadable is
 * skipped, and no earlier review at all means no continuity section, not an
 * "everything is new" one: a first review has nothing to be continuous with.
 *
 * WHAT IT WILL NOT CLAIM. "Resolved" needs a revision diff showing the cited
 * code changed (finding-continuity.ts rule 3). Here the diff comes from the
 * sandbox checkout (`git diff prior..head`); a shallow clone that lacks the
 * earlier commit yields no diff, and the answer is then `unconfirmed-
 * disappearance`, never `resolved`. The record says which it was.
 */

import {
  classifyFindingContinuity,
  type ContinuityEntry,
  type ContinuityStatus,
  type ReviewFinding,
  type ReviewSnapshot,
} from "./finding-continuity.js";
import type { ParsedFindings, ScanFinding } from "./findings.js";

export const FINDING_CONTINUITY_FLAG = "SHIP_FINDING_CONTINUITY";

/** On only for an explicit "on" (or 1/true). Anything else, including unset, is off. */
export function findingContinuityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(on|1|true)$/i.test((env[FINDING_CONTINUITY_FLAG] ?? "").trim());
}

type LoggedEvent = { type: string; name?: string; at?: string; data?: unknown };

/** The slice of PreviewLineage (preview-supersede.ts) this needs: run history, read only. */
export interface ReviewHistory {
  loadEvents(runId: string): Promise<readonly LoggedEvent[]>;
  recentRunIds?(): Promise<string[]>;
}

export interface PriorReview {
  runId: string;
  snapshot: ReviewSnapshot;
}

/** How many recent runs are opened looking for the earlier review. Bounded: each is a log read. */
export const MAX_HISTORY_RUNS = 60;
const MAX_RECORDED_ENTRIES = 40;
const MAX_DIFF_BYTES = 1_000_000;

function startedInput(events: readonly LoggedEvent[]): { at?: string; input: Record<string, unknown> } | null {
  const started = events.find((e) => e.type === "run-started");
  const input = (started?.data as { input?: unknown } | undefined)?.input;
  if (typeof input !== "object" || input === null) return null;
  return { ...(typeof started?.at === "string" ? { at: started.at } : {}), input: input as Record<string, unknown> };
}

function recordedFindings(events: readonly LoggedEvent[]): ReviewFinding[] | null {
  const step = events.find((e) => e.type === "step-completed" && e.name === "scan-findings");
  const result = (step?.data as { result?: { found?: unknown; findings?: unknown } } | undefined)?.result;
  if (result?.found !== true || !Array.isArray(result.findings)) return null;
  return result.findings.filter(
    (f): f is ReviewFinding =>
      typeof f === "object" && f !== null && typeof (f as ScanFinding).title === "string" && typeof (f as ScanFinding).file === "string",
  );
}

function headOf(events: readonly LoggedEvent[]): string | undefined {
  const step = events.find((e) => e.type === "step-completed" && e.name === "repo-setup");
  const sha = (step?.data as { result?: { headSha?: unknown } } | undefined)?.result?.headSha;
  return typeof sha === "string" && SHA.test(sha) ? sha : undefined;
}

const SHA = /^[a-f0-9]{7,64}$/i;

/** The earlier review of this repo + pull request, or null. Never throws. */
export async function loadPriorReview(
  history: ReviewHistory,
  query: { runId: string; repo: string; pr?: number; task: string },
): Promise<PriorReview | null> {
  let own: { at?: string } | null = null;
  try {
    own = startedInput(await history.loadEvents(query.runId));
  } catch {
    own = null;
  }
  // Without our own start time "earlier" cannot be decided, and picking the
  // newest run would let a recovered old run compare against a newer one.
  if (own?.at === undefined) return null;
  let ids: string[] = [];
  try {
    ids = (await history.recentRunIds?.()) ?? [];
  } catch {
    return null;
  }
  let best: { at: string; prior: PriorReview } | null = null;
  for (const id of ids.filter((i) => i !== query.runId).slice(0, MAX_HISTORY_RUNS)) {
    let events: readonly LoggedEvent[];
    try {
      events = await history.loadEvents(id);
    } catch {
      continue;
    }
    const s = startedInput(events);
    if (s?.at === undefined || !(s.at < own.at)) continue;
    const input = s.input;
    if (input.mode !== "scan" || input.repo !== query.repo) continue;
    if (query.pr !== undefined ? input.pr !== query.pr : input.pr !== undefined || input.task !== query.task) continue;
    if (!events.some((e) => e.type === "run-completed")) continue;
    const findings = recordedFindings(events);
    if (findings === null) continue;
    if (best !== null && !(s.at > best.at)) continue;
    best = { at: s.at, prior: { runId: id, snapshot: { revision: headOf(events) ?? "unknown", findings } } };
  }
  return best?.prior ?? null;
}

/** The slice of an executor needed to read a revision diff. */
export type ExecLike = (command: string, options: { timeoutMs: number }) => Promise<{ stdout: string; exitCode: number }>;

/**
 * `git diff prior..head` from the checkout, or undefined when it cannot be
 * had (unknown revision, commit absent from a shallow clone, oversize).
 * Identical revisions are an empty diff, which is real evidence: nothing
 * changed. Both ids are validated hex before being put in a command line.
 */
export async function revisionDiff(exec: ExecLike, prior: string, head: string | undefined): Promise<string | undefined> {
  if (head === undefined || !SHA.test(head) || !SHA.test(prior)) return undefined;
  if (prior.toLowerCase() === head.toLowerCase()) return "";
  try {
    const r = await exec(`git diff --no-color --no-ext-diff ${prior}..${head}`, { timeoutMs: 30_000 });
    if (r.exitCode !== 0 || Buffer.byteLength(r.stdout) > MAX_DIFF_BYTES) return undefined;
    return r.stdout;
  } catch {
    return undefined;
  }
}

// ── What is recorded ──────────────────────────────────────────────────────

export interface ContinuityRecordEntry {
  id: string;
  status: ContinuityStatus;
  title: string;
  file: string;
  line?: number;
  severity: string;
  reason: string;
  attribution: string;
  humanResolutionOverridden?: true;
  movedFrom?: { file: string; line?: number };
}

/** The additive `continuity` field on the `scan-findings` step's result. */
export interface ContinuityRecord {
  priorRunId: string;
  priorRevision: string;
  revision?: string;
  /** "unavailable" means nothing could be proven fixed; see the module header. */
  diff: "available" | "unavailable";
  counts: Record<ContinuityStatus, number>;
  warnings: string[];
  entries: ContinuityRecordEntry[];
  /** Entries past the recording cap (still counted in `counts`). */
  omitted?: number;
  advisory: string[];
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const STATUS_TEXT: Record<ContinuityStatus, string> = {
  "still-open": "still open",
  resolved: "resolved",
  regressed: "regressed",
  new: "new",
  moved: "moved",
  superseded: "superseded",
  "unconfirmed-disappearance": "not reported again (unconfirmed)",
};

/** Order the reader should see them in: what needs attention first. */
const ORDER: ContinuityStatus[] = ["regressed", "new", "still-open", "moved", "unconfirmed-disappearance", "superseded", "resolved"];

export function advisoryLines(r: Omit<ContinuityRecord, "advisory">): string[] {
  const parts = ORDER.filter((s) => r.counts[s] > 0).map((s) => `${r.counts[s]} ${STATUS_TEXT[s]}`);
  const rev = r.priorRevision === "unknown" ? "" : ` of revision ${r.priorRevision.slice(0, 8)}`;
  const lines = [`Compared with the earlier review${rev} (run ${r.priorRunId}): ${parts.length > 0 ? parts.join(", ") : "no findings in either review"}.`];
  for (const status of ORDER) {
    for (const e of r.entries.filter((x) => x.status === status)) {
      lines.push(`[${STATUS_TEXT[status]}] ${e.title} (${e.file}${e.line !== undefined ? `:${e.line}` : ""}): ${e.reason}`);
    }
  }
  if (r.omitted !== undefined && r.omitted > 0) lines.push(`${r.omitted} more not listed here.`);
  if (r.diff === "unavailable") lines.push("No revision diff was available, so no finding is marked resolved: a finding that disappeared may have been missed rather than fixed.");
  for (const w of r.warnings) lines.push(`Note: ${w}`);
  lines.push("Advisory only. This comparison does not gate approval or merge.");
  return lines;
}

function recordEntry(e: ContinuityEntry): ContinuityRecordEntry {
  const f = e.finding;
  return {
    id: e.id,
    status: e.status,
    title: clip(f.title, 200),
    file: clip(f.file, 300),
    ...(f.line !== undefined ? { line: f.line } : {}),
    severity: f.severity,
    reason: clip(e.reason, 300),
    attribution: e.attribution.kind,
    ...(e.humanResolutionOverridden === true ? { humanResolutionOverridden: true as const } : {}),
    ...(e.movedFrom !== undefined ? { movedFrom: e.movedFrom } : {}),
  };
}

/**
 * Compare this review's parsed findings with the prior one. Returns the
 * parsed findings with stable `id`s assigned (additive: so the NEXT review
 * keeps identity through renames) and the record to attach to the step.
 */
export function compareWithPrior(args: {
  parsed: ParsedFindings;
  prior: PriorReview;
  revision?: string;
  diff?: string;
  baseDiff?: string;
}): { parsed: ParsedFindings; continuity: ContinuityRecord } {
  const later: ReviewSnapshot = { revision: args.revision ?? "unknown", findings: args.parsed.findings as ReviewFinding[] };
  const result = classifyFindingContinuity({
    prior: args.prior.snapshot,
    later,
    ...(args.diff !== undefined ? { diff: args.diff } : {}),
    ...(args.baseDiff !== undefined ? { baseDiff: args.baseDiff } : {}),
  });
  const ids = new Map<ReviewFinding, string>();
  for (const e of result.entries) if (e.current !== undefined) ids.set(e.current, e.id);
  const findings = args.parsed.findings.map((f) => {
    const id = ids.get(f as ReviewFinding);
    return id !== undefined ? { ...f, id } : f;
  });
  const shown = result.entries.slice(0, MAX_RECORDED_ENTRIES);
  const base = {
    priorRunId: args.prior.runId,
    priorRevision: args.prior.snapshot.revision,
    ...(args.revision !== undefined ? { revision: args.revision } : {}),
    diff: result.diffAvailable ? ("available" as const) : ("unavailable" as const),
    counts: result.counts,
    warnings: result.warnings.slice(0, 5).map((w) => clip(w, 300)),
    entries: shown.map(recordEntry),
    ...(result.entries.length > shown.length ? { omitted: result.entries.length - shown.length } : {}),
  };
  const continuity: ContinuityRecord = { ...base, advisory: advisoryLines(base) };
  return { parsed: { ...args.parsed, findings, continuity }, continuity };
}
