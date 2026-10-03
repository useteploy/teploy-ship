import { PLAN_EVENT } from "teploy-ship/plan";
import type { AcceptanceState, DeliveryOutcome, ExecutionState, TaskRecord } from "teploy-ship/task-record";

/**
 * S03 — the run page's "Task state" panel, as data.
 *
 * `taskRecord` (src/task-record.ts) projects a task into three SEPARATE states.
 * This maps each to a label, a tone and one plain-language sentence, so the
 * route only lays out markup. Rules the mapping keeps (pinned in
 * task-state.test.ts):
 *  - "finished" is an execution word. It never renders as accepted, and the
 *    execution sentence says so.
 *  - "not-recorded" is its own label. It is never worded as pending, waiting
 *    or "none yet": nothing is claimed about what has not been recorded.
 *  - A later attempt's existence is shown as the earlier approval being
 *    superseded, with who approved it, rather than dropped.
 */

export type Tone = "ok" | "warn" | "bad" | "info" | "muted";

export interface StateCell {
  /** Column heading: what question this state answers. */
  heading: string;
  /** The state, in words. */
  label: string;
  tone: Tone;
  /** One plain sentence on what this state does and does not establish. */
  meaning: string;
  /** False when the state is "not recorded"; the panel marks the cell. */
  recorded: boolean;
}

export interface TaskStateView {
  execution: StateCell;
  acceptance: StateCell;
  delivery: StateCell;
  /** The asked-for statements in attempt order; the last is current. */
  requirements: { runId: string; statement: string; current: boolean }[];
  /** Earlier approvals that a later attempt replaced, one sentence each. */
  superseded: string[];
  notRecorded: string[];
  anomalies: string[];
  attempts: number;
}

const EXECUTION: Record<ExecutionState, { label: string; tone: Tone; meaning: string }> = {
  "not-started": { label: "Not started", tone: "muted", meaning: "No start is recorded for this task." },
  running: { label: "Running", tone: "info", meaning: "The agent is working. Nothing has been reviewed or delivered." },
  "waiting-on-people": { label: "Waiting on people", tone: "warn", meaning: "The agent has stopped at a question or decision that needs a person." },
  finished: { label: "Finished", tone: "ok", meaning: "The agent ended its turn normally. This says nothing about whether the work was accepted or delivered." },
  incomplete: { label: "Ended incomplete", tone: "warn", meaning: "The agent ended without finishing the work it was given." },
  failed: { label: "Failed", tone: "bad", meaning: "The run stopped with an error. Read the failure details." },
  cancelled: { label: "Cancelled", tone: "muted", meaning: "The run was stopped before it finished." },
};

const ACCEPTANCE: Record<AcceptanceState, { label: string; tone: Tone; meaning: string }> = {
  "not-recorded": { label: "Not recorded", tone: "muted", meaning: "No review decision is recorded for this task. Finished work is not accepted work." },
  pending: { label: "Awaiting decision", tone: "warn", meaning: "The change is waiting for a person to approve or decline it." },
  accepted: { label: "Accepted", tone: "ok", meaning: "A person recorded an approval of the change." },
  rejected: { label: "Declined", tone: "bad", meaning: "A person recorded a decision not to accept the change." },
  superseded: { label: "Superseded", tone: "muted", meaning: "A newer attempt replaced the change that was reviewed. The earlier decision does not apply to it." },
};

const DELIVERY: Record<DeliveryOutcome, { label: string; tone: Tone; meaning: string }> = {
  "not-recorded": { label: "Not recorded", tone: "muted", meaning: "No delivery record exists. Nothing here says the change reached anywhere." },
  proposed: { label: "Proposed", tone: "info", meaning: "A delivery is proposed and has not been approved." },
  approved: { label: "Approved", tone: "info", meaning: "A delivery is approved and has not started." },
  executing: { label: "Delivering", tone: "info", meaning: "A delivery is in progress and not yet confirmed." },
  confirmed: { label: "Confirmed", tone: "ok", meaning: "The delivery record says the change reached its destination." },
  unknown: { label: "Outcome unknown", tone: "warn", meaning: "The delivery was attempted but its result could not be established. Check the destination." },
  failed: { label: "Failed", tone: "bad", meaning: "The delivery failed. See the delivery details." },
  held: { label: "Held", tone: "warn", meaning: "The delivery is paused and will not proceed until someone releases it." },
};

function cell(heading: string, label: string, tone: Tone, meaning: string, recorded: boolean): StateCell {
  return { heading, label, tone, meaning, recorded };
}

export function taskStateView(record: TaskRecord): TaskStateView {
  const e = EXECUTION[record.execution];
  const a = ACCEPTANCE[record.acceptance];
  const d = DELIVERY[record.delivery];
  const last = record.attempts[record.attempts.length - 1]?.runId;

  const acceptanceMeaning =
    record.acceptance === "accepted" && record.acceptedBy !== null ? `${a.meaning} Approved by ${record.acceptedBy}.` : a.meaning;

  // Approvals on any attempt but the last are for earlier changes. Shown even
  // when the latest attempt has its own decision, so the history is not lost.
  const superseded = record.attempts
    .slice(0, -1)
    .flatMap((att) =>
      att.decisions
        .filter((x) => x.approved && x.event !== PLAN_EVENT)
        .map((x) => `Approval${x.by !== null ? ` by ${x.by}` : ""} on ${att.runId} is superseded by a later attempt.`),
    );

  return {
    execution: cell("Execution", e.label, e.tone, e.meaning, true),
    acceptance: cell("Acceptance", a.label, a.tone, acceptanceMeaning, record.acceptance !== "not-recorded"),
    delivery: cell("Delivery", d.label, d.tone, d.meaning, record.delivery !== "not-recorded"),
    requirements: record.requirements.map((r) => ({ ...r, current: r.runId === last })),
    superseded,
    notRecorded: record.notRecorded,
    anomalies: record.anomalies,
    attempts: record.attempts.length,
  };
}
