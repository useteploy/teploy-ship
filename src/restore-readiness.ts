/**
 * S19: restore-readiness — does a restored store hold what the backup held?
 *
 * `scripts/ship-backup.sh rehearse` proves an archive unpacks and an engine
 * boots; it does not prove the restored HISTORY matches. This module compares
 * two history snapshots (taken from the source store at backup time and from
 * the restored store) and refuses to say "restored" unless it actually
 * compared and everything agreed.
 *
 * Rules:
 *  - Unknown is not pass. A missing snapshot, a malformed side, or a backup
 *    with no runs yields "unverified", never "restored-match".
 *  - Counts alone are weak (a restore that swaps rows keeps the count), so each
 *    snapshot carries a per-run digest of the run's recorded event sequence and
 *    the comparison is per run id: missing, extra and changed runs are named.
 *  - Waiting decisions (runs parked on an approval/answer) are compared as a
 *    set, because losing one silently strands a person's decision.
 *  - Snapshots hold ids, counts and digests only; no event bodies, so the
 *    report cannot carry credentials from run history.
 *
 * `digestRun` is the one place the digest is defined. Taking the snapshots
 * from a real store is not implemented here (it needs live access): this is
 * the comparison half.
 */

import { createHash } from "node:crypto";

export interface RunSnapshot {
  runId: string;
  /** Number of recorded events. */
  events: number;
  /** digestRun() over the ordered event sequence. */
  digest: string;
  /** Open decision this run is parked on, if any (e.g. "approval:<id>"). */
  waiting?: string;
  /** Step fingerprint recorded on the run, if any. */
  fingerprint?: string;
}

export interface HistorySnapshot {
  /** When and where this was taken; informational. */
  takenAt: string;
  source: string;
  runs: RunSnapshot[];
}

export type ReadinessVerdict = "restored-match" | "mismatch" | "unverified";

export interface ReadinessReport {
  verdict: ReadinessVerdict;
  backupRuns: number;
  restoredRuns: number;
  eventsBackup: number;
  eventsRestored: number;
  missing: string[];
  extra: string[];
  changed: string[];
  waitingLost: string[];
  waitingExtra: string[];
  fingerprintChanged: string[];
  /** Why the verdict is unverified, when it is. */
  reason?: string;
}

/** Order-sensitive digest of a run's events. Bodies are hashed, never stored. */
export function digestRun(events: ReadonlyArray<{ type: string; name?: string; data?: unknown }>): string {
  const h = createHash("sha256");
  for (const e of events) {
    h.update(`${e.type}\u0000${e.name ?? ""}\u0000`);
    h.update(createHash("sha256").update(JSON.stringify(e.data ?? null)).digest());
  }
  return h.digest("hex");
}

function validSnapshot(s: unknown): s is HistorySnapshot {
  if (typeof s !== "object" || s === null) return false;
  const r = (s as HistorySnapshot).runs;
  return Array.isArray(r) && r.every((x) => typeof x?.runId === "string" && typeof x.events === "number" && typeof x.digest === "string");
}

const NONE = { backupRuns: 0, restoredRuns: 0, eventsBackup: 0, eventsRestored: 0, missing: [], extra: [], changed: [], waitingLost: [], waitingExtra: [], fingerprintChanged: [] };

export function compareHistory(backup: unknown, restored: unknown): ReadinessReport {
  if (!validSnapshot(backup)) return { ...NONE, verdict: "unverified", reason: "backup snapshot is missing or malformed" };
  if (!validSnapshot(restored)) return { ...NONE, backupRuns: backup.runs.length, verdict: "unverified", reason: "restored snapshot is missing or malformed" };
  if (backup.runs.length === 0) {
    return { ...NONE, restoredRuns: restored.runs.length, verdict: "unverified", reason: "backup snapshot holds no runs: nothing was compared" };
  }
  const b = new Map(backup.runs.map((r) => [r.runId, r]));
  const r = new Map(restored.runs.map((x) => [x.runId, x]));
  const missing = [...b.keys()].filter((k) => !r.has(k)).sort();
  const extra = [...r.keys()].filter((k) => !b.has(k)).sort();
  const changed: string[] = [];
  const fingerprintChanged: string[] = [];
  for (const [id, br] of b) {
    const rr = r.get(id);
    if (rr === undefined) continue;
    if (br.events !== rr.events || br.digest !== rr.digest) changed.push(id);
    if (br.fingerprint !== rr.fingerprint) fingerprintChanged.push(id);
  }
  const wb = new Set(backup.runs.filter((x) => x.waiting !== undefined).map((x) => `${x.runId}:${x.waiting}`));
  const wr = new Set(restored.runs.filter((x) => x.waiting !== undefined).map((x) => `${x.runId}:${x.waiting}`));
  const waitingLost = [...wb].filter((k) => !wr.has(k)).sort();
  const waitingExtra = [...wr].filter((k) => !wb.has(k)).sort();
  changed.sort();
  fingerprintChanged.sort();
  const clean = [missing, extra, changed, waitingLost, waitingExtra, fingerprintChanged].every((a) => a.length === 0);
  return {
    verdict: clean ? "restored-match" : "mismatch",
    backupRuns: backup.runs.length,
    restoredRuns: restored.runs.length,
    eventsBackup: backup.runs.reduce((n, x) => n + x.events, 0),
    eventsRestored: restored.runs.reduce((n, x) => n + x.events, 0),
    missing,
    extra,
    changed,
    waitingLost,
    waitingExtra,
    fingerprintChanged,
  };
}
