/**
 * Wiring for surfacing the S08 test-integrity detector (src/test-integrity.ts)
 * where a reviewer or a consumer actually looks: the pull request body and the
 * run-completion webhook. Approved by the owner 2026-10-04 (programme wave-5
 * notes); before that the detector's only surface was the run page's read-time
 * panel (web/src/lib/test-integrity-view.ts), which nothing outside the
 * dashboard reads.
 *
 * MODES (`SHIP_TEST_INTEGRITY_SURFACING`), the standing shadow-first rule for
 * a worker-path change:
 *
 *   unset / "off"  default. Nothing is computed or written; the pull request
 *                  body and the webhook payload are byte-identical to a build
 *                  without this module (pinned by a test).
 *   "shadow"       the detector runs at the same points and what it WOULD
 *                  surface is logged; nothing is written. Run this on a real
 *                  worker and read the logs before turning "on".
 *   "on"           findings are surfaced: a "Test integrity" part inside the
 *                  pull request's existing Verification section
 *                  (verification.ts) and an additive `test_integrity` field
 *                  on the run webhook payload (notify.ts).
 *
 * An unreadable value is treated as "off" and logged, the same contract as
 * SHIP_BUDGET_RESERVATION (budget-gate.ts): an operator typo must not turn
 * surfacing on by accident.
 *
 * WHAT IS NOT CHANGED. No workflow step is added and no recorded step result
 * changes, in any mode: the analysis runs beside the existing publish points
 * and nothing is written to the durable log, so a replay reads back exactly
 * what it recorded. The delivery record (delivery.ts) is untouched — the
 * approval was pull request body and webhook only. The one step-sequence
 * effect, under "on" only: a run whose ONLY verification part is an integrity
 * finding now records the existing `verification` step where it previously
 * had nothing to publish. ADVISORY ONLY, like the panel: nothing here feeds
 * approval, merge, classification or the delivery record.
 *
 * CLEAN MEANS NOTHING TO SAY. With the flag on and no findings, no section is
 * added and no field is sent. Printing "no test-tampering patterns found" on
 * every clean pull request would train a reviewer to skip the section that
 * sometimes carries the real thing (the same rule fix-evidence.ts states), and
 * on the wire an absent field is the honest shape: a consumer treats absent
 * as "nothing surfaced", never as "the tests are sound".
 */
import { analyzeTestIntegrity } from "./test-integrity.js";
import type { TestIntegrityFinding } from "./test-integrity.js";

export type TestIntegritySurfacingMode = "off" | "shadow" | "on";

export const TEST_INTEGRITY_SURFACING_FLAG = "SHIP_TEST_INTEGRITY_SURFACING";

export function testIntegritySurfacingMode(env: NodeJS.ProcessEnv = process.env): { mode: TestIntegritySurfacingMode; invalid?: string } {
  const raw = (env[TEST_INTEGRITY_SURFACING_FLAG] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "off") return { mode: "off" };
  if (raw === "shadow" || raw === "on") return { mode: raw };
  return { mode: "off", invalid: env[TEST_INTEGRITY_SURFACING_FLAG] as string };
}

/** `SHIP_ORACLE_PATHS`: comma-separated globs, blanks dropped; unset is no oracle. Same contract as the web panel's parser. */
export function parseOraclePaths(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
}

/** How many findings travel; the rest are counted in `omitted`. The detector clips each evidence line itself. */
export const SURFACE_FINDINGS_CAP = 20;

/** The middle-cut marker git.ts truncateMiddle writes (web/src/lib/test-integrity-view.ts reads the same shape). */
const DIFF_CUT = /\.\.\. \[(?:\d+ chars )?omitted from the middle of this diff\] \.\.\./;

export type SurfaceFinding = Pick<TestIntegrityFinding, "kind" | "file" | "line" | "severity" | "confidence" | "evidence">;

export interface TestIntegrityRecord {
  /** Findings exist whenever a record exists, so this is never "clean". */
  verdict: "suspicious" | "tampered";
  total: number;
  findings: SurfaceFinding[];
  /** Findings past SURFACE_FINDINGS_CAP, still counted in `total`. */
  omitted?: number;
  /** False when the published diff had a middle section cut out, so the read is partial. */
  diffComplete: boolean;
  oracleConfigured: boolean;
}

/**
 * The detector over a published diff, bounded for both surfaces. Undefined —
 * never a throw — when there is no diff, nothing parseable, or no finding:
 * every one of those adds nothing, by the rule in the module header.
 */
export function testIntegrityRecord(diff: string | undefined, oraclePaths: string[]): TestIntegrityRecord | undefined {
  if (typeof diff !== "string" || !diff.includes("diff --git ")) return undefined;
  let analysed: ReturnType<typeof analyzeTestIntegrity>;
  try {
    analysed = analyzeTestIntegrity(diff, { oraclePaths });
  } catch {
    // Advisory: a detector fault must not fail a run or a delivery.
    return undefined;
  }
  const findings = analysed.findings;
  if (findings.length === 0) return undefined;
  const shown = findings.slice(0, SURFACE_FINDINGS_CAP).map(({ kind, file, line, severity, confidence, evidence }) => ({
    kind,
    file,
    line,
    severity,
    confidence,
    evidence,
  }));
  return {
    verdict: analysed.verdict === "tampered" ? "tampered" : "suspicious",
    total: findings.length,
    findings: shown,
    ...(findings.length > shown.length ? { omitted: findings.length - shown.length } : {}),
    diffComplete: !DIFF_CUT.test(diff),
    oracleConfigured: oraclePaths.length > 0,
  };
}

/**
 * The pull request's Test integrity part. Wording follows the run page's
 * panel (web/src/views/workspace.tsx TestIntegrityLine) on purpose: the two
 * surfaces should read as the same statement, and the panel's wording is
 * already pinned by its own tests.
 */
export function testIntegritySection(record: TestIntegrityRecord): string {
  const lines = [
    `**Test integrity** — ${record.verdict} (${record.total} finding${record.total === 1 ? "" : "s"}). A person should look; this flags patterns, it does not prove intent.`,
    ...record.findings.map((f) => `- \`${f.file}${f.line > 0 ? `:${f.line}` : ""}\` ${f.kind} [${f.severity}/${f.confidence}] ${f.evidence}`),
  ];
  if (record.omitted !== undefined && record.omitted > 0) lines.push(`- … and ${record.omitted} more.`);
  if (!record.diffComplete) lines.push("Part of the published diff was omitted, so this read is incomplete.");
  return lines.join("\n");
}

export interface IntegrityLogEvent {
  type: string;
  name?: string;
  data?: unknown;
}

/**
 * The diff a run published, off its recorded `repo-push` step — the same read
 * the web panel does, so the two surfaces cannot analyse different bytes.
 * Undefined when no push was recorded, nothing was pushed, or the diff was
 * not recorded.
 */
export function pushDiffFromEvents(events: readonly IntegrityLogEvent[]): string | undefined {
  const push = events.filter((e) => e.type === "step-completed" && e.name === "repo-push").at(-1);
  const result = push?.data as { result?: { kind?: unknown; diff?: unknown } } | undefined;
  if (result?.result?.kind !== "pushed") return undefined;
  return typeof result.result.diff === "string" ? result.result.diff : undefined;
}

/**
 * What both surface points call: read the mode, run the detector over the
 * diff, and either hand back the record ("on"), log and hand back nothing
 * ("shadow"), or do nothing at all ("off"). Returns undefined whenever
 * nothing should be surfaced, so every caller is one conditional spread.
 */
export function surfacedTestIntegrity(args: {
  diff: string | undefined;
  /** Read for the mode AND the oracle paths, so a test can pass a fake env. */
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** What the shadow log names as the destination, e.g. "the run webhook payload". */
  where: string;
  runId?: string;
}): TestIntegrityRecord | undefined {
  const env = args.env ?? process.env;
  const log = args.log ?? ((line: string) => console.warn(line));
  const { mode, invalid } = testIntegritySurfacingMode(env);
  if (invalid !== undefined) {
    log(`[test-integrity] ${TEST_INTEGRITY_SURFACING_FLAG}=${JSON.stringify(invalid)} is not off|shadow|on; treated as off`);
  }
  if (mode === "off") return undefined;
  const record = testIntegrityRecord(args.diff, parseOraclePaths(env.SHIP_ORACLE_PATHS));
  if (record === undefined) return undefined;
  if (mode === "shadow") {
    log(
      `[test-integrity] shadow: ${args.runId !== undefined ? `run ${args.runId}: ` : ""}would surface ${record.verdict} (${record.total} finding${record.total === 1 ? "" : "s"}) on ${args.where}; nothing was written`,
    );
    return undefined;
  }
  return record;
}
