import { parseAction } from "./actions.js";

/**
 * The ```ask park: the agent stops with a question and the run waits on the
 * answer (durable.ts, `input.ask`). Dependency-free like plan.ts so the
 * dashboard's client half can import the event test without dragging
 * runtime.ts (node-only) into the browser bundle.
 */

/** The event name a turn's ```ask parks on. Deliver an AskDecisionPayload. */
export function askEvent(turn: number): string {
  return `turn-${turn}-ask`;
}

/** True for the park an ```ask produced — the run wants an answer, not an approval. */
export function isAskEvent(eventName: string | undefined): boolean {
  return eventName !== undefined && /^(attempt-\d+-)?turn-\d+-ask$/.test(eventName);
}

/**
 * The operator's answer to an ```ask. `answer` is the text the agent gets.
 * The approve/deny shape is accepted too, so every existing decision surface
 * (the CLI's `deny <run> "<reason>"`, Akiroo's approve-with-reason) can answer
 * a question without learning a new payload: an approval's `reason` IS the
 * answer, and a denial with no text tells the agent to decide for itself.
 */
export interface AskDecisionPayload {
  answer?: string;
  approved?: boolean;
  reason?: string;
  /** Who answered (see actor.ts). Recorded, never read by the loop. */
  by?: string;
}

export const ASK_UNAVAILABLE =
  "Asking the operator is not available on this run. Decide for yourself, prefer the reversible option, and say what you assumed in your finish message.";

export const ASK_DECLINED =
  "The operator did not answer. Decide for yourself, prefer the reversible option, and say what you assumed in your finish message.";

/** What the agent is told after an answer arrives. */
export function askAnswerMessage(decision: AskDecisionPayload): string {
  const text = (decision.answer ?? decision.reason ?? "").trim();
  if (text !== "") return `Operator's answer: ${text}`;
  return ASK_DECLINED;
}

/**
 * The question a run is parked on, when its last park is an ```ask: the text
 * of the ask block in the think step the park belongs to. Read from the log,
 * never from a store — the park and the question are the same event.
 */
export function pendingQuestion(events: ReadonlyArray<{ type: string; name?: string; data?: unknown }>): string | undefined {
  const waiting = events.at(-1);
  if (waiting === undefined || waiting.type !== "event-waiting" || !isAskEvent(waiting.name)) return undefined;
  const think = `${waiting.name!.replace(/-ask$/, "")}-think`;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type !== "step-completed" || e.name !== think) continue;
    const result = (e.data as { result?: unknown } | undefined)?.result;
    const text = typeof result === "string" ? result : String((result as { text?: unknown } | undefined)?.text ?? "");
    const action = parseAction(text);
    return action.kind === "ask" ? action.question : undefined;
  }
  return undefined;
}
