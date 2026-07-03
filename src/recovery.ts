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
}

export const defaultRecoveryConfig: RecoveryConfig = {
  loopThreshold: 3,
  failureThreshold: 4,
  maxNudges: 3,
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

  constructor(config: RecoveryConfig = defaultRecoveryConfig) {
    this.#config = config;
  }

  /**
   * Record a turn and get a signal. Call after parsing the action and
   * (if executed) observing its exit code. `exitCode` is undefined for
   * non-executing turns (finish/none).
   */
  observe(action: Action, exitCode: number | undefined): RecoverySignal {
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

    const looping =
      signature !== null &&
      this.#recentActions.length === this.#config.loopThreshold &&
      this.#recentActions.every((s) => s === signature);
    const thrashing = this.#consecutiveFailures >= this.#config.failureThreshold;

    if (!looping && !thrashing) {
      return { kind: "ok" };
    }

    this.#nudges += 1;
    // Clearing the windows prevents the same rut from firing every
    // subsequent turn; the agent gets a fresh chance to change course.
    this.#recentActions = [];
    this.#consecutiveFailures = 0;

    if (this.#nudges > this.#config.maxNudges) {
      return {
        kind: "abort",
        message: looping
          ? "Aborting: the agent kept repeating the same action after repeated nudges."
          : "Aborting: the agent kept failing after repeated nudges.",
      };
    }

    return {
      kind: "nudge",
      message: looping
        ? "You have repeated the same action several times without progress. Stop and reconsider: what assumption is wrong? Try a different approach or gather more information (inspect files, read the error carefully)."
        : "Several commands in a row have failed. Stop and diagnose the root cause before trying again — read the errors, check paths and prerequisites, and change strategy rather than retrying variations.",
    };
  }
}

function actionSignature(action: Action): string | null {
  if (action.kind === "bash" || action.kind === "python") {
    return `${action.kind}:${action.code.trim()}`;
  }
  return null;
}
