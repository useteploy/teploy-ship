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
  | { kind: "abort"; message: string };

export class RecoveryTracker {
  #config: RecoveryConfig;
  #recentActions: string[] = [];
  #consecutiveFailures = 0;
  #nudges = 0;
  #lastProgress: string | undefined;
  #sinceProgress = 0;

  constructor(config: RecoveryConfig = defaultRecoveryConfig) {
    this.#config = config;
  }

  /**
   * Record a turn and get a signal. Call after parsing the action and
   * (if executed) observing its exit code. `exitCode` is undefined for
   * non-executing turns (finish/none).
   */
  observe(action: Action, exitCode: number | undefined, progress?: string): RecoverySignal {
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

    this.#nudges += 1;
    // Clearing the windows prevents the same rut from firing every
    // subsequent turn; the agent gets a fresh chance to change course.
    this.#recentActions = [];
    this.#consecutiveFailures = 0;
    this.#sinceProgress = 0;

    if (this.#nudges > this.#config.maxNudges) {
      return {
        kind: "abort",
        message: looping
          ? "Aborting: the agent kept repeating the same action after repeated nudges."
          : thrashing
            ? "Aborting: the agent kept failing after repeated nudges."
            : "Aborting: the agent kept running commands without changing anything after repeated nudges.",
      };
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
