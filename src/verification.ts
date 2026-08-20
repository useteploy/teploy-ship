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
 * What is deliberately NOT claimed here: that the tests passed. Ship has no
 * structured test result — the verified-finish gate asks whether the agent ran
 * something and whether the tree changed, which is not the same thing. Adding
 * a "tests: green" line off that would be a claim the run cannot support.
 */
import type { PreviewOutcome } from "./deploy.js";
import { previewComment } from "./deploy.js";
import type { TelemetryVerdict } from "./observe.js";
import { telemetryComment } from "./observe.js";

export const VERIFICATION_START = "<!-- teploy-ship:verification -->";
export const VERIFICATION_END = "<!-- /teploy-ship:verification -->";

export interface Evidence {
  preview?: PreviewOutcome;
  telemetry?: TelemetryVerdict;
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
  const preview = evidence.preview;
  if (preview !== undefined && preview.kind !== "skipped") {
    parts.push(previewComment(preview, runId));
  }
  const telemetry = evidence.telemetry;
  if (telemetry !== undefined && telemetry.kind !== "disabled") {
    parts.push(telemetryComment(telemetry, runId));
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
