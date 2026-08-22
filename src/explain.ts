import type { WorkflowEvent } from "@neutron-build/workflow";

/**
 * Turn a run's event log into something a human can act on.
 *
 * A finished run explains itself: there is a pull request, and the diff is the
 * answer. A run that did NOT finish leaves a status and several hundred events,
 * and "max-steps" is not an explanation — it is a category. Most of what makes
 * software feel maintained rather than prototyped is what happens when things
 * go wrong, and until now that surface did not exist.
 *
 * Everything here is derived from the log alone. No network, no store, no
 * model call: an explanation you cannot produce offline is useless in exactly
 * the situation you need it.
 */
export interface RunExplanation {
  /** One line. What happened, in the operator's terms rather than the loop's. */
  headline: string;
  /** What the run was asked to do. */
  tried: string;
  /** Where it stopped, and — where the log knows — why. */
  stoppedAt: string;
  /** What a human should do next. Never "check the logs". */
  nextStep: string;
  /** Facts worth surfacing beside the prose: last error, PR, cost, turns. */
  evidence: string[];
  /** Did this run end in a state a human needs to do something about? */
  needsAttention: boolean;
}

interface Digest {
  task?: string;
  status?: string;
  summary?: string;
  pr?: string;
  turns: number;
  failedStep?: { name: string; error: string };
  waitingOn?: string;
  cancelled: boolean;
  failedOutright?: string;
  testOutcome?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function digest(events: WorkflowEvent[]): Digest {
  const d: Digest = { turns: 0, cancelled: false };
  for (const e of events) {
    const data = asRecord(e.data);
    switch (e.type) {
      case "run-started": {
        const input = asRecord(data?.input);
        if (typeof input?.task === "string") d.task = input.task;
        break;
      }
      case "step-completed": {
        const name = e.name ?? "";
        // turn-N-exec is the marker of an executing turn; counting think steps
        // would double-count a turn that was nudged and re-thought.
        const m = /^turn-(\d+)-exec$/.exec(name);
        if (m !== null) d.turns = Math.max(d.turns, Number(m[1]) + 1);
        if (name === "tests") {
          const result = asRecord(data?.result);
          if (typeof result?.kind === "string") d.testOutcome = result.kind;
        }
        break;
      }
      case "step-failed": {
        const err = data?.error;
        d.failedStep = { name: e.name ?? "(unnamed step)", error: typeof err === "string" ? err : JSON.stringify(err ?? "") };
        break;
      }
      case "event-waiting":
        d.waitingOn = e.name ?? "an approval";
        break;
      case "run-cancelled":
        d.cancelled = true;
        break;
      case "run-failed":
        d.failedOutright = typeof data?.error === "string" ? data.error : JSON.stringify(data?.error ?? "the run threw");
        break;
      case "run-completed": {
        const out = asRecord(data?.output);
        if (typeof out?.status === "string") d.status = out.status;
        if (typeof out?.summary === "string") d.summary = out.summary;
        if (typeof out?.pr === "string") d.pr = out.pr;
        if (typeof out?.turns === "number") d.turns = Math.max(d.turns, out.turns);
        break;
      }
      default:
        break;
    }
  }
  return d;
}

/** Trim a task or error to something that fits on a line without lying. */
function brief(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Explain a run from its event log.
 *
 * Ordering matters: the checks run most-specific first, because a run can be
 * several things at once and only the innermost one is actionable. A run that
 * threw while parked on an approval is a crash, not a pending approval.
 */
export function explainRun(events: WorkflowEvent[]): RunExplanation {
  const d = digest(events);
  const tried = d.task !== undefined ? brief(d.task) : "(the log records no task)";
  const evidence: string[] = [];
  if (d.turns > 0) evidence.push(`${d.turns} turn${d.turns === 1 ? "" : "s"}`);
  if (d.pr !== undefined) evidence.push(`pull request: ${d.pr}`);
  if (d.testOutcome !== undefined) evidence.push(`tests: ${d.testOutcome}`);

  // 1. It never started.
  if (events.length === 0) {
    return {
      headline: "This run has no events at all.",
      tried,
      stoppedAt: "Nothing was ever recorded against it.",
      nextStep:
        "The run id exists but its log is empty, which means enqueue wrote nothing or the store is pointed somewhere else. Check that the worker and whoever enqueued it share one store (NUCLEUS_URL).",
      evidence,
      needsAttention: true,
    };
  }

  // 2. It threw. This is the one case where the loop itself is the problem.
  if (d.failedOutright !== undefined) {
    const nondeterminism = /nondeterminism/i.test(d.failedOutright);
    return {
      headline: nondeterminism
        ? "This run can no longer be replayed."
        : "The run stopped with an error rather than a result.",
      tried,
      stoppedAt: `The workflow threw: ${brief(d.failedOutright)}`,
      nextStep: nondeterminism
        ? "Its recorded steps no longer match what the current code would do — almost always because Ship was upgraded while this run was in flight. It cannot be resumed. Cancel it and enqueue the task again. docs/UPGRADING.md §3 explains how to avoid this next time."
        : "This is a fault in Ship or its store, not in the agent's work. The error above is the whole of what the log knows; resuming will re-run from the last completed step.",
      evidence,
      needsAttention: true,
    };
  }

  // 3. A step failed but the run continued or stopped around it.
  if (d.failedStep !== undefined && d.status === undefined) {
    return {
      headline: `The run stopped at the "${d.failedStep.name}" step.`,
      tried,
      stoppedAt: `${d.failedStep.name} failed: ${brief(d.failedStep.error)}`,
      nextStep:
        "The step is recorded as failed, so a resume restarts from it rather than from the beginning. Fix whatever it depends on — credentials, network, or the store — then resume the run.",
      evidence,
      needsAttention: true,
    };
  }

  // 4. Parked, waiting for a person.
  if (d.waitingOn !== undefined && d.status === undefined && !d.cancelled) {
    return {
      headline: "The run is waiting for you.",
      tried,
      stoppedAt: `It parked at "${d.waitingOn}" and is holding its workspace.`,
      nextStep:
        "Approve or deny it. Nothing is burning while it waits — the workspace is snapshotted — but it will not progress on its own.",
      evidence,
      needsAttention: true,
    };
  }

  if (d.cancelled) {
    return {
      headline: "Cancelled.",
      tried,
      stoppedAt: "A person stopped this run; it settled at its next step.",
      nextStep: "Nothing to do. Work completed before the cancellation is still in the log and any pull request it opened still stands.",
      evidence,
      needsAttention: false,
    };
  }

  // 5. It reached a terminal status.
  switch (d.status) {
    case "finished":
      return {
        headline: d.pr !== undefined ? "Finished, and opened a pull request." : "Finished, but published nothing.",
        tried,
        stoppedAt: d.summary !== undefined ? brief(d.summary) : "The agent declared itself done.",
        nextStep:
          d.pr !== undefined
            ? "Review the pull request. If it carries a Verification section, the tests line was produced by Ship after the agent stopped — not by the agent's own account of its work."
            : "The agent finished without a diff to push, so there is nothing to review. That usually means the task was already satisfied, or was understood as a question rather than a change.",
        evidence,
        needsAttention: d.pr === undefined,
      };

    case "max-steps":
      return {
        headline: "Ran out of turns before it finished.",
        tried,
        stoppedAt: `It reached the ${d.turns}-turn ceiling while still working.`,
        nextStep:
          d.pr !== undefined
            ? "A draft pull request was opened anyway, because real fixes die in runs that never got to say 'finish'. Read the diff: partial work is common here, and so is complete work that simply never got to declare itself done."
            : "No diff had been produced by the ceiling, so nothing was published. Raise SHIP_MAX_STEPS for this kind of task, or split it — a task that needs more exploration than turns is usually two tasks.",
        evidence,
        needsAttention: true,
      };

    case "stuck":
      return {
        headline: "Stopped making progress and gave up.",
        tried,
        stoppedAt: "Stuck detection fired: commands kept running but the workspace stopped changing.",
        nextStep:
          "Read the last few turns — this is nearly always a missing dependency, a wrong path, or a test the agent cannot run. It is rarely the model failing to understand the task.",
        evidence,
        needsAttention: true,
      };

    case "settled":
      return {
        headline: "Stopped deliberately.",
        tried,
        stoppedAt: brief(d.summary ?? "It had already made a change and further commands stopped altering the tree."),
        nextStep:
          "This is a clean stop, not a failure: the run judged itself done verifying rather than building. Treat any pull request it opened as complete work.",
        evidence,
        needsAttention: false,
      };

    case "budget-exhausted":
      return {
        headline: "Hit the spend cap.",
        tried,
        stoppedAt: "The run stopped because its source's daily budget was exhausted, not because the work was done.",
        nextStep:
          "Raise the budget for this source in Settings, or wait for the daily window to roll over, then enqueue the task again. The cap is per source and per day.",
        evidence,
        needsAttention: true,
      };

    case "plan-rejected":
      return {
        headline: "You rejected its plan.",
        tried,
        stoppedAt: "The run stopped before touching the workspace.",
        nextStep: "Nothing ran, so there is nothing to clean up. Re-enqueue with a sharper task if the plan was wrong about what you wanted.",
        evidence,
        needsAttention: false,
      };

    default:
      break;
  }

  // 6. Still going.
  return {
    headline: "Still running.",
    tried,
    stoppedAt: d.turns > 0 ? `Currently on turn ${d.turns}.` : "It has started but not yet completed a turn.",
    nextStep: "Nothing to do yet. A run with no worker touching it will look like this too — check that a worker is alive if the turn count is not moving.",
    evidence,
    needsAttention: false,
  };
}

/** Render an explanation as plain text, for the CLI. */
export function formatExplanation(e: RunExplanation): string {
  const lines = [e.headline, "", `Asked to:   ${e.tried}`, `Stopped at: ${e.stoppedAt}`, `Next:       ${e.nextStep}`];
  if (e.evidence.length > 0) lines.push("", e.evidence.join("  ·  "));
  return lines.join("\n");
}
