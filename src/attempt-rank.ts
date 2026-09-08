/**
 * Ranking the attempts a multi-attempt run produced (P6-1).
 *
 * The selection of WHICH attempt to publish is a decision a machine makes
 * without a person, so it has to be answerable from recorded fact rather than
 * from one model's opinion of a diff. This file holds the RANKING as a pure
 * function over recorded outcomes — suite verdict, build verdict, changed-file
 * count — and the critic's pick is only the last tie-break among attempts those
 * three could not separate. The steps that produce the outcomes live in
 * durable.ts; the verification paragraph and the pull request's Verification
 * section read the winner back off the same records.
 *
 * ORDER, and why each rung is where it is:
 *
 *   1. The declared test command PASSED. The suite is the project's own
 *      statement of what correct means, run by the harness over exactly the
 *      bytes being judged. An attempt that failed it is never selected over
 *      one that passed it — never, whatever the critic prefers, whatever the
 *      diff looks like. This is the whole point of ranking by executable
 *      verification instead of by review.
 *   2. The declared build PASSED. A weaker signal than the suite (most suites
 *      fail on a broken build) but free, already recorded, and it separates a
 *      passing-suite attempt that cannot compile its own docs from one that
 *      can.
 *   3. Fewest changed files among the still-tied attempts. Two attempts that
 *      both satisfy the project's verification have each demonstrated the
 *      task; the smaller one is the easier one to review and the less likely
 *      to have fixed something it was not asked about. Counting FILES rather
 *      than lines because a line count rewards the attempt that wrote the
 *      densest diff, which is not a virtue.
 *   4. Only when all of that ties: the critic's pick, exactly as P5-4 had it.
 *      An opinion is the last resort, not the first.
 *
 * Absent outcomes are WORSE than present ones at rungs 1 and 2 — an attempt
 * with no recorded suite outcome sorts below one whose suite passed. An
 * attempt that produced no diff at all is the CALLER's to exclude before
 * ranking: there is nothing to publish, whatever its suite said, and the
 * publish gate refuses an empty tree anyway.
 */
import type { ChangeClass } from "./change-class.js";
import type { TestOutcome } from "./tests.js";

/**
 * What one recorded attempt contributes to the ranking. Everything here is a
 * recorded step's output or a fact the workflow already held; nothing is read
 * from the worker's environment, so a replay ranks the same attempts in the
 * same order.
 */
export interface AttemptOutcome {
  /** 1-based, the label the critic answers with and the PR body quotes. */
  attempt: number;
  /** The adapter id, for the reason strings a person reads. */
  harness: string;
  /** The project's suite over this attempt's tree, when it ran. */
  tests?: TestOutcome;
  /** The project's build command over this attempt's tree, when it ran. */
  build?: TestOutcome;
  /** How many files this attempt changed; 0 when it produced no diff. */
  changedFiles: number;
}

/** Did this outcome pass? Absent and non-passing are both "no". */
function passed(outcome: TestOutcome | undefined): boolean {
  return outcome?.kind === "passed";
}

/** A short human rendering of a suite verdict, for the reason strings. */
export function attemptOutcomeLine(attempt: AttemptOutcome): string {
  const suite =
    attempt.tests === undefined
      ? "suite not run"
      : attempt.tests.kind === "passed"
        ? "suite passed"
        : attempt.tests.kind === "failed"
          ? `suite failed (exit ${attempt.tests.exitCode})`
          : attempt.tests.kind === "errored"
            ? `suite could not run`
            : `suite not configured`;
  const build =
    attempt.build === undefined
      ? ""
      : attempt.build.kind === "passed"
        ? ", build passed"
        : attempt.build.kind === "failed"
          ? `, build failed (exit ${attempt.build.exitCode})`
          : attempt.build.kind === "errored"
            ? ", build could not run"
            : "";
  return `${suite}${build}, ${attempt.changedFiles} file${attempt.changedFiles === 1 ? "" : "s"} changed`;
}

/**
 * Rank the attempts. Pure: same outcomes in, same order out, with the winner
 * first. `criticPick` is the attempt number the critic chose (1-based), or null
 * when it named nothing / was not asked.
 *
 * Returns the attempts in publish-preference order together with the reason the
 * winner won, so the `harness-pick` step and the Verification section can say
 * "selected attempt 2 of 3: suite passed; attempts 1 and 3 failed the suite"
 * from the same value.
 */
export function rankAttempts(attempts: readonly AttemptOutcome[], criticPick: number | null): {
  order: AttemptOutcome[];
  winner: AttemptOutcome | undefined;
  /**
   * The attempts the first three rungs could not separate from the winner —
   * same suite verdict, same build verdict, same changed-file count. More than
   * one entry is the caller's cue to ask the critic, and ONLY then: everything
   * outside this list lost on recorded verification, not on opinion.
   */
  tied: number[];
  /** Why the winner won, one line, quoting the loser outcomes for contrast. */
  reason: string;
} {
  // Stable sort: Array.prototype.sort is stable in every runtime this ships
  // on, so two attempts the rungs cannot separate keep their launch order —
  // which is also the order they are numbered in, and therefore the order a
  // person reading the timeline expects.
  const order = [...attempts].sort((a, b) => {
    // 1. The suite. The rung the whole change exists for.
    const suite = Number(passed(b.tests)) - Number(passed(a.tests));
    if (suite !== 0) return suite;
    // 2. The build.
    const build = Number(passed(b.build)) - Number(passed(a.build));
    if (build !== 0) return build;
    // 3. Fewest changed files.
    const files = a.changedFiles - b.changedFiles;
    if (files !== 0) return files;
    // 4. The critic's pick, only among attempts the rungs could not separate.
    const pick = (n: AttemptOutcome): number => (criticPick !== null && n.attempt === criticPick ? 1 : 0);
    return pick(b) - pick(a);
  });
  const winner = order[0];
  if (winner === undefined) return { order, winner: undefined, tied: [], reason: "no attempt finished" };
  // Which attempts the first three rungs left level with the winner. This is
  // the set the critic may legitimately be asked about; anything outside it
  // lost on recorded verification, and no opinion can promote it.
  const tied = order.filter((a) => passed(a.tests) === passed(winner.tests) && passed(a.build) === passed(winner.build) && a.changedFiles === winner.changedFiles).map((a) => a.attempt);
  const losers = order.slice(1);
  const of = attempts.length;
  const selected = `selected attempt ${winner.attempt} of ${of}: ${attemptOutcomeLine(winner)}`;
  const reason =
    losers.length === 0
      ? selected
      : `${selected}; ${losers.map((l) => `attempt ${l.attempt} ${attemptOutcomeLine(l)}`).join("; ")}`;
  return { order, winner, tied, reason };
}
