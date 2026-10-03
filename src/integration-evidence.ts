/**
 * S18 — what counts as proof that a producer and a consumer work TOGETHER.
 *
 * coordination.ts verifies a pair STATICALLY (a read-only scan of the client
 * against the API surface at the anchor) and records, honestly, that no
 * integration test ran. A real pair-level test belongs to a future execution
 * kind with authority over a two-repository workspace. This module is the
 * contract that kind's evidence must satisfy, so the rules exist, tested,
 * before the executor does: nothing here runs a command or reads a forge.
 *
 * Rules (each pinned in integration-evidence.test.ts):
 *  1. Two evidence classes, never mixed. A "static" check, however confident,
 *     never satisfies a requirement for an "executed-pair" test.
 *  2. Evidence applies only to the EXACT producer and consumer revisions it
 *     names, compared as full commit ids. When either side has moved, the
 *     evidence is "stale" — a racing upstream change invalidates it; it is not
 *     quietly carried forward and not treated as missing either, because the
 *     difference tells the operator what to re-run.
 *  3. Executed evidence must say what ran: a passing result with no command is
 *     not executed evidence.
 *  4. Only "passed" satisfies. "failed" blocks; "not-run" and "unknown" are
 *     distinct states and block too — they are never read as passed or as
 *     failed.
 *  5. Among evidence for the current revisions, a failure is not outvoted by
 *     an older pass: the NEWEST result decides, and a failure at the same
 *     instant as a pass is a failure.
 *  6. A requirement that was not declared changes nothing: "not-required"
 *     never blocks, so the existing static-only flow is untouched.
 */

export type EvidenceClass = "static" | "executed-pair";
export type EvidenceResult = "passed" | "failed" | "not-run" | "unknown";

export interface RevisionRef {
  /** Canonical full repository identity (forge origin included). */
  repo: string;
  /** Full 40-hex commit id. Abbreviations are not comparable and are refused. */
  sha: string;
}

export interface IntegrationEvidence {
  class: EvidenceClass;
  producer: RevisionRef;
  consumer: RevisionRef;
  /** The pair-level command that ran. Required for executed-pair. */
  command?: string;
  result: EvidenceResult;
  /** ISO time the result was recorded. */
  at: string;
  /** Run or artifact the result can be audited from. */
  source?: string;
}

export type IntegrationState =
  | "not-required"
  | "satisfied"
  | "failed"
  | "stale"
  | "missing"
  | "unresolved";

export interface IntegrationStatus {
  state: IntegrationState;
  /** True for every state except satisfied and not-required. */
  blocking: boolean;
  /** One sentence naming why, for the surface that shows it. */
  reason: string;
  /** The evidence the decision rests on, when there is one. */
  basis?: IntegrationEvidence;
  /** Evidence that was set aside and why (never silently dropped). */
  ignored: { evidence: IntegrationEvidence; why: string }[];
}

const FULL_SHA = /^[0-9a-f]{40}$/;

function result(state: IntegrationState, reason: string, ignored: IntegrationStatus["ignored"], basis?: IntegrationEvidence): IntegrationStatus {
  return { state, blocking: state !== "satisfied" && state !== "not-required", reason, ignored, ...(basis !== undefined ? { basis } : {}) };
}

export function integrationStatus(
  required: boolean,
  evidence: readonly IntegrationEvidence[],
  current: { producer: RevisionRef; consumer: RevisionRef },
): IntegrationStatus {
  if (!required) return result("not-required", "No executed integration test was required for this pair.", []);

  const ignored: IntegrationStatus["ignored"] = [];
  const executed: IntegrationEvidence[] = [];
  for (const e of evidence) {
    if (e.class !== "executed-pair") {
      ignored.push({ evidence: e, why: "static compatibility is a different evidence class and cannot satisfy an executed integration test" });
    } else if (!FULL_SHA.test(e.producer.sha) || !FULL_SHA.test(e.consumer.sha)) {
      ignored.push({ evidence: e, why: "revision is not a full commit id, so it cannot be compared" });
    } else if (e.command === undefined || e.command.trim() === "") {
      ignored.push({ evidence: e, why: "executed evidence must record the command that ran" });
    } else if (e.producer.repo !== current.producer.repo || e.consumer.repo !== current.consumer.repo) {
      ignored.push({ evidence: e, why: "evidence is for a different repository pair" });
    } else if (Number.isNaN(Date.parse(e.at))) {
      ignored.push({ evidence: e, why: "evidence has no usable timestamp" });
    } else {
      executed.push(e);
    }
  }
  if (!FULL_SHA.test(current.producer.sha) || !FULL_SHA.test(current.consumer.sha)) {
    return result("unresolved", "The current producer or consumer revision is not a full commit id, so no evidence can be matched to it.", ignored);
  }
  if (executed.length === 0) {
    return result("missing", "No executed pair-level test has been recorded for this pair.", ignored);
  }

  const exact = executed.filter((e) => e.producer.sha === current.producer.sha && e.consumer.sha === current.consumer.sha);
  if (exact.length === 0) {
    const newest = [...executed].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]!;
    const moved = [
      newest.producer.sha !== current.producer.sha ? "producer" : null,
      newest.consumer.sha !== current.consumer.sha ? "consumer" : null,
    ].filter((m): m is string => m !== null);
    return result("stale", `The recorded integration test ran against an earlier ${moved.join(" and ")} revision; re-run it against the current ones.`, ignored, newest);
  }

  // Newest decides; on a tie a failure wins over a pass.
  const rank = (r: EvidenceResult): number => (r === "failed" ? 3 : r === "unknown" ? 2 : r === "not-run" ? 1 : 0);
  const decisive = [...exact].sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || rank(b.result) - rank(a.result))[0]!;
  switch (decisive.result) {
    case "passed":
      return result("satisfied", "The pair-level test passed against exactly the current producer and consumer revisions.", ignored, decisive);
    case "failed":
      return result("failed", "The pair-level test failed against the current producer and consumer revisions.", ignored, decisive);
    case "not-run":
      return result("unresolved", "The pair-level test was recorded as not run; that is not a pass.", ignored, decisive);
    case "unknown":
      return result("unresolved", "The pair-level test outcome is unknown; that is not a pass.", ignored, decisive);
  }
}
