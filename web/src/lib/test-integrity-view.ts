/**
 * The run page's test-integrity line (S08, advisory). A read-time projection of
 * the diff the run PUBLISHED, taken from the recorded `repo-push` step: nothing
 * is added to the workflow, no step is recorded, and old runs project the same
 * way as new ones (a run with no recorded diff says "not analysed").
 *
 * ADVISORY ONLY. Nothing here feeds approval, merge, classification or the
 * delivery record. It exists so a reviewer SEES that a green suite was reached
 * by skipping or loosening tests, in the same panel as the test result.
 *
 * Three honesty rules, each pinned by a test:
 *   - No recorded diff is `not-analysed`, never `clean`. Absence of evidence
 *     is not a finding of none.
 *   - `clean` means "no patterns found", worded so it cannot read as "tests
 *     verified" (see CLEAN_TEXT).
 *   - The recorded diff is cut in the middle past 100k chars (git.ts
 *     publishedDiff). Analysing a cut diff is allowed, but the result says it
 *     is incomplete so a clean result over half a diff is not read as whole.
 */
import { analyzeTestIntegrity, type TestIntegrityFinding, type TestIntegrityKind, type TestIntegrityVerdict } from "../../../dist/test-integrity.js";

export const CLEAN_TEXT = "no test-tampering patterns found (heuristic; not proof the tests are sound)";
export const LIMITS_NOTE =
  "Heuristic over the published diff: it flags skips, deletions, weakened or edited assertions and bypassed test commands. It cannot prove intent or that the tests are sound, and it does not see skips set outside the diff.";
const TOP_FINDINGS = 5;

export interface IntegrityLogEvent {
  type: string;
  name?: string;
  data?: unknown;
}

export type TestIntegrityPanel =
  | { state: "not-analysed"; reason: string }
  | {
      state: "analysed";
      verdict: TestIntegrityVerdict;
      /** False when the recorded diff had a middle section cut out. */
      complete: boolean;
      total: number;
      byKind: Partial<Record<TestIntegrityKind, number>>;
      top: Pick<TestIntegrityFinding, "kind" | "file" | "line" | "evidence" | "confidence" | "severity">[];
      oracleConfigured: boolean;
      /**
       * The wording, decided here and not in the view: the view is bundled for
       * the browser and must import only types from this file, or the whole
       * analyser would ride along into the client bundle.
       */
      headline: string;
      note: string;
    };

const rec = (v: unknown): Record<string, any> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});

/** `SHIP_ORACLE_PATHS`: comma-separated globs, blanks dropped; unset is no oracle. */
export function parseOraclePaths(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
}

export function testIntegrityPanel(events: IntegrityLogEvent[], oraclePaths: string[] = []): TestIntegrityPanel {
  const push = events.filter((e) => e.type === "step-completed" && e.name === "repo-push").at(-1);
  if (push === undefined) return { state: "not-analysed", reason: "This run recorded no published change." };
  const result = rec(rec(push.data).result);
  if (result.kind !== "pushed") return { state: "not-analysed", reason: "No change was published, so there is no diff to read." };
  const diff = result.diff;
  if (typeof diff !== "string" || !diff.includes("diff --git ")) return { state: "not-analysed", reason: "The published diff was not recorded for this run." };
  const complete = !/\.\.\. \[(?:\d+ chars )?omitted from the middle of this diff\] \.\.\./.test(diff);
  const r = analyzeTestIntegrity(diff, { oraclePaths });
  return {
    state: "analysed",
    verdict: r.verdict,
    complete,
    total: r.findings.length,
    byKind: r.summary.byKind,
    top: r.findings.slice(0, TOP_FINDINGS).map(({ kind, file, line, evidence, confidence, severity }) => ({ kind, file, line, evidence, confidence, severity })),
    oracleConfigured: r.summary.oracleConfigured,
    headline:
      r.verdict === "clean"
        ? `Test integrity: ${CLEAN_TEXT}.${complete ? "" : " Part of the recorded diff was omitted, so this read is incomplete."}`
        : `Test integrity: ${r.verdict} (${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}). A person should look; this flags patterns, it does not prove intent.${complete ? "" : " Part of the recorded diff was omitted, so this read is incomplete."}`,
    note: LIMITS_NOTE,
  };
}
