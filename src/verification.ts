/**
 * The evidence a run gathered, in the pull request body.
 *
 * P1-3. The body is what a reviewer reads first and what merge automation
 * parses; a comment is a footnote under it. A preview URL and a measured
 * before/after posted as two separate comments are two footnotes — findable if
 * you scroll, invisible if you do not.
 *
 * The body is written when the PR opens, before any of this evidence exists,
 * so it is amended afterwards. Amended, not rewritten: the section lives
 * between markers and a re-run replaces exactly that span, so a branch that is
 * pushed to three times ends with one Verification section and whatever the
 * reviewer wrote around it.
 *
 * The tests line is produced by Ship running an operator-configured command
 * after the agent has stopped — never by the agent's own account of its
 * testing, which is exactly the claim the verified-finish gate exists because
 * models get wrong. See tests.ts.
 */
import type { PreviewOutcome } from "./deploy.js";
import { previewComment } from "./deploy.js";
import type { TelemetryVerdict } from "./observe.js";
import { telemetryComment } from "./observe.js";
import type { TestOutcome } from "./tests.js";
import { testComment, testScopeNote } from "./tests.js";
import type { Rung } from "./ladder.js";

export const VERIFICATION_START = "<!-- teploy-ship:verification -->";
export const VERIFICATION_END = "<!-- /teploy-ship:verification -->";

export interface Evidence {
  tests?: TestOutcome;
  /**
   * The same suite, run BEFORE the agent edited anything. Present only on runs
   * that took a baseline; absent means "we cannot tell a regression from
   * inherited breakage", which is what every run before C4 was.
   */
  testsBaseline?: TestOutcome;
  preview?: PreviewOutcome;
  telemetry?: TelemetryVerdict;
  /**
   * The recorded rung list (`ladder` step, C4) — every rung with its status,
   * the one list the webhook and the run page also carry. Present only on a
   * run that declared a ladder.
   */
  rungs?: Rung[];
  /**
   * Repository-relative paths the run changed (the change-class step's list).
   * Only read to warn when a root-level suite cannot have covered a change
   * confined to one subtree (tests.ts:testScopeNote). Absent on runs that
   * did not classify their change.
   */
  changedPaths?: string[];
}

/**
 * Render the section, or null when there is nothing worth saying.
 *
 * "Nothing worth saying" is specifically: a worker that is not wired for
 * either feature. That is operator configuration, not a result, and printing
 * "not measured, not deployed" on every pull request would train a reviewer to
 * skip the section that sometimes carries the real thing.
 */
export function verificationSection(evidence: Evidence, runId: string): string | null {
  const parts: string[] = [];
  // Tests first: it is the question a reviewer asks before "where can I see it".
  const tests = evidence.tests;
  if (tests !== undefined && tests.kind !== "disabled") {
    parts.push(testComment(tests, evidence.testsBaseline));
    const scope = testScopeNote(tests.command, evidence.changedPaths ?? []);
    if (scope !== undefined) parts.push(`**Scope:** ${scope}`);
  }
  const preview = evidence.preview;
  if (preview !== undefined && preview.kind !== "skipped") {
    parts.push(previewComment(preview, runId));
  }
  const telemetry = evidence.telemetry;
  if (telemetry !== undefined && telemetry.kind !== "disabled") {
    parts.push(telemetryComment(telemetry, runId));
  }
  // The ladder (C4): every rung, in ladder order, with its status — the same
  // list the webhook's `verification.rungs` carries. Rendered as a list
  // because it IS a list; a sentence would rank the rungs the reader should
  // rank for themselves.
  if (evidence.rungs !== undefined && evidence.rungs.length > 0) {
    parts.push(
      `**Verification ladder**\n\n${evidence.rungs
        .map((r) => `- ${r.name}: ${r.status}${r.detail !== undefined && r.detail !== "" ? ` — ${r.detail}` : ""}`)
        .join("\n")}`,
    );
  }
  if (parts.length === 0) return null;
  return `${VERIFICATION_START}\n## Verification\n\n${parts.join("\n\n---\n\n")}\n${VERIFICATION_END}`;
}

/**
 * Put the section into a body, replacing any previous one.
 *
 * Idempotent by construction: three pushes to a branch leave one section, not
 * three. Anything the reviewer wrote outside the markers is untouched.
 */
export function spliceVerification(body: string, section: string): string {
  const start = body.indexOf(VERIFICATION_START);
  const end = body.indexOf(VERIFICATION_END);
  if (start !== -1 && end !== -1 && end > start) {
    const before = body.slice(0, start);
    const after = body.slice(end + VERIFICATION_END.length);
    return `${before}${section}${after}`;
  }
  // A body with a start marker and no end (truncated by a forge, or hand-edited)
  // is left alone below the append point rather than being cut at a guess.
  return body.trimEnd() === "" ? section : `${body.trimEnd()}\n\n---\n\n${section}`;
}
