import type { Action } from "./actions.js";

/**
 * Stuck detection — the recovery half of agent quality. Agents fail not
 * by crashing but by looping: re-running the same failing command, or
 * thrashing through many nonzero exits without progress. The tracker
 * watches the action/observation stream and, when a rut is detected,
 * yields a nudge to inject; after too many ruts it recommends aborting
 * rather than burning the whole step budget in a loop. (Pattern informed
 * by OpenHands' stuck-detection; implemented against our own loop.)
 */
export interface RecoveryConfig {
  /** Identical action repeats before it's a loop (default 3). */
  loopThreshold: number;
  /** Consecutive nonzero exits before it's thrashing (default 4). */
  failureThreshold: number;
  /** Nudges before recommending abort (default 3). */
  maxNudges: number;
  /**
   * Successful actions that change NOTHING before that counts as spinning
   * (default 6).
   *
   * Loop and failure detection both look at syntax and exit codes, which misses
   * the most expensive failure mode: an agent that keeps succeeding without
   * moving. Re-reading files, re-listing directories, re-running a passing test
   * — all exit 0, all different enough to evade the repeat check, none of it
   * progress. Progress is measured by the caller supplying a fingerprint of the
   * work (the diff); when that stops changing across successful actions, say so.
   */
  noProgressThreshold: number;
  /**
   * Treat a settled working tree as a reason to FINISH rather than to abort
   * (default off — absent from `defaultRecoveryConfig`, so every existing
   * construction behaves exactly as before).
   *
   * Spinning over an ALREADY-DIRTY tree is a different failure from spinning
   * over a clean one. A clean tree means nothing was built; a dirty tree means
   * the work is plausibly done and the agent is verifying it — which is what
   * the finish gate asked for, and which is zero-progress activity by
   * construction. The old spinning nudge offered such an agent one exit only,
   * "say plainly that you cannot", which an agent holding a correct fix will
   * never say; it then burned the rest of the budget and was recorded as an
   * error. With `settle` on, that state gets the exit it lacked: one finish-now
   * nudge, and then a terminal `stop` in place of the abort.
   *
   * Deliberately narrow. It requires exit 0 and neither looping nor thrashing,
   * so an agent that is failing repeatedly still aborts — being stuck is not
   * the same as being finished.
   */
  settle?: boolean;
}

export const defaultRecoveryConfig: RecoveryConfig = {
  loopThreshold: 3,
  failureThreshold: 4,
  maxNudges: 3,
  noProgressThreshold: 6,
};

export type RecoverySignal =
  | { kind: "ok" }
  | { kind: "nudge"; message: string }
  /** Stop deliberately: the work looks complete and has stopped moving. */
  | { kind: "stop"; message: string }
  | { kind: "abort"; message: string };

/**
 * The settle nudge and the settle stop, exported so callers and tests assert
 * the exact strings instead of keeping a second copy of the wording.
 */
export const SETTLE_NUDGE =
  "Your working tree already contains changes, and your last several commands changed nothing further — you are verifying, not building. If the change this task requires is complete, finish NOW with a ```finish block summarising what you changed and how you verified it. If it is not complete, make the next concrete edit instead.";

export const SETTLE_STOP =
  "Stopped: the working tree holds a complete-looking change and further commands stopped changing it.";

export class RecoveryTracker {
  #config: RecoveryConfig;
  #recentActions: string[] = [];
  #consecutiveFailures = 0;
  #nudges = 0;
  #lastProgress: string | undefined;
  #sinceProgress = 0;
  #settleNudged = false;

  constructor(config: RecoveryConfig = defaultRecoveryConfig) {
    this.#config = config;
  }

  /**
   * Record a turn and get a signal. Call after parsing the action and
   * (if executed) observing its exit code. `exitCode` is undefined for
   * non-executing turns (finish/none).
   *
   * `dirty` says whether the work fingerprinted by `progress` is non-empty —
   * i.e. whether the tree holds a candidate change at all. It only matters
   * when `settle` is on; left undefined, the settle path can never fire.
   */
  observe(action: Action, exitCode: number | undefined, progress?: string, dirty?: boolean): RecoverySignal {
    const signature = actionSignature(action);
    if (signature !== null) {
      this.#recentActions.push(signature);
      if (this.#recentActions.length > this.#config.loopThreshold) {
        this.#recentActions.shift();
      }
    }

    if (exitCode !== undefined) {
      this.#consecutiveFailures = exitCode === 0 ? 0 : this.#consecutiveFailures + 1;
    }

    // Progress is "the work changed", not "the command worked".
    if (progress !== undefined && exitCode === 0) {
      if (this.#lastProgress !== undefined && progress === this.#lastProgress) this.#sinceProgress += 1;
      else this.#sinceProgress = 0;
      this.#lastProgress = progress;
    }

    const looping =
      signature !== null &&
      this.#recentActions.length === this.#config.loopThreshold &&
      this.#recentActions.every((s) => s === signature);
    const thrashing = this.#consecutiveFailures >= this.#config.failureThreshold;
    const spinning = this.#sinceProgress >= this.#config.noProgressThreshold;

    if (!looping && !thrashing && !spinning) {
      return { kind: "ok" };
    }

    // The rut is "work already done, agent still poking at it" rather than
    // "agent is stuck". Only this shape gets the settle treatment: a failing or
    // repeating agent is still aborted, whatever the tree looks like.
    // Deliberately NOT gated on `exitCode === 0`. The pathology being caught is
    // "keeps re-running tests over work that is already done", so the triggering
    // turn is very often a test command — and a single nonzero exit there (a
    // flaky test, a typo'd path, an unrelated import error) would otherwise flip
    // a run that had been succeeding for twenty turns back into an abort. A
    // genuinely failing agent is already excluded by `thrashing`, which needs
    // `failureThreshold` consecutive failures; `spinning` itself only advances
    // on successful actions. One bad command at the wrong moment is not a signal
    // about the quality of the tree, and the patch submitted is identical either
    // way — only the recorded ending differs.
    const settleReady =
      this.#config.settle === true && dirty === true && spinning && !looping && !thrashing;

    this.#nudges += 1;
    // Clearing the windows prevents the same rut from firing every
    // subsequent turn; the agent gets a fresh chance to change course.
    this.#recentActions = [];
    this.#consecutiveFailures = 0;
    this.#sinceProgress = 0;

    if (this.#nudges > this.#config.maxNudges) {
      // Same step the run would have died on either way — this only changes
      // whether the ending is recorded as a failure or as a deliberate stop.
      if (settleReady) return { kind: "stop", message: SETTLE_STOP };
      return {
        kind: "abort",
        message: looping
          ? "Aborting: the agent kept repeating the same action after repeated nudges."
          : thrashing
            ? "Aborting: the agent kept failing after repeated nudges."
            : "Aborting: the agent kept running commands without changing anything after repeated nudges.",
      };
    }

    // At most once per run: offering "you may be done" every rut would talk a
    // still-working agent into quitting. After this the ordinary spinning nudge
    // resumes, and the run still ends at the stop above or at maxSteps.
    if (settleReady && !this.#settleNudged) {
      this.#settleNudged = true;
      return { kind: "nudge", message: SETTLE_NUDGE };
    }

    return {
      kind: "nudge",
      message: looping
        ? "You have repeated the same action several times without progress. Stop and reconsider: what assumption is wrong? Try a different approach or gather more information (inspect files, read the error carefully)."
        : thrashing
          ? "Several commands in a row have failed. Stop and diagnose the root cause before trying again — read the errors, check paths and prerequisites, and change strategy rather than retrying variations."
          : "Your last several commands succeeded but changed nothing — you are inspecting, not building. Make the actual edit the task requires, or say plainly in a finish block that you cannot.",
    };
  }
}

/**
 * Normalizes an action into a repeat signature.
 *
 * Whitespace is collapsed and edit/create/search are covered too: the old
 * version only signed bash and python and compared them with an exact trimmed
 * match, so re-indenting a command or thrashing between two file edits evaded
 * loop detection entirely.
 */
function actionSignature(action: Action): string | null {
  const norm = (text: string): string => text.trim().replace(/\s+/g, " ");
  switch (action.kind) {
    case "bash":
    case "python":
      return `${action.kind}:${norm(action.code)}`;
    case "edit":
      return `edit:${action.file}:${norm(action.search)}`;
    case "create":
      return `create:${action.file}:${norm(action.content)}`;
    case "search":
      return `search:${norm(action.query)}`;
    default:
      return null;
  }
}
