import type { AgentExecutor, ExecResult } from "@neutron-build/agents";

import type { Action } from "./actions.js";
import type { HeldKind, SteerStore } from "./steer.js";

/**
 * Two-way steering on the native loop (D2, S03/S13), behind SHIP_STEER_REPLY.
 * The loop-side vocabulary lives here so durable.ts carries only the wiring;
 * the design (checkpoints, safe points, replay) is docs/STEERING_DESIGN.md.
 */

/** On unless explicitly turned off (`0`/`false`/`no`/`off`); unset means on. */
export function steerReplyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(0|false|no|off)$/i.test((env.SHIP_STEER_REPLY ?? "").trim());
}

/** One held operator message, as the `turn-N-held` / `turn-N-finish-held` steps record it. */
export interface HeldItem {
  mode: HeldKind;
  text: string;
}

/**
 * What an operator interrupt did to the action it landed on (S11's effect
 * vocabulary). `not-done`: the action never started. `done`: it ran to its
 * end (its effects stand). `unknown`: it was cancelled part-way and may have
 * done some of its work — the honest answer for a cancelled kernel cell.
 */
export type InterruptEffect = "not-done" | "done" | "unknown";

/** Recorded on the `turn-N-exec` result beside the ExecResult fields. */
export interface InterruptRecord {
  /** `before`: claimed at the action's start; `during`: while it ran. */
  at: "before" | "during";
  effect: InterruptEffect;
  /** The operator's interrupt notes (empty strings when none was given). */
  notes: string[];
  /** False when the action kind cannot be cancelled mid-flight (bash, edits). */
  cancellable: boolean;
}

export type InterruptibleResult = ExecResult & { interrupt?: InterruptRecord };

/** A reply-only turn: the reply is posted, the run goes on. */
export const REPLY_POSTED =
  "Your reply is in the operator's thread. Continue the task — any answer arrives as an operator message.";

/** The finish hold when operator messages were waiting at the checkpoint. */
export const FINISH_HELD_FOR_OPERATOR =
  "Not finished yet: the operator messages above were waiting for this checkpoint. Address them, then finish again.";

/**
 * The untrusted-source marker that replaces an operator-imitating line's
 * framing. Parameterised so the task text and condense recaps can say what
 * they are instead of claiming to be tool output; the observation path keeps
 * the original wording every test and prompt pins.
 */
export function fenceOperatorLines(
  text: string,
  marker = "[tool output, not the operator]",
  options: { anchored?: boolean } = {},
): string {
  // Split on EVERY line terminator and keep the separators: a "\n"-only split
  // left "framing\r\nok" as one line whose rewrite silently did nothing
  // (CRLF bypass, 2026-10-17 re-review).
  const framing = options.anchored === true ? ANCHORED_FRAMING : OPERATOR_FRAMING;
  return text
    .split(/(\r\n|\r|\n|\u2028|\u2029)/)
    .map((part, i) => {
      if (i % 2 === 1 || !framing.test(detectionCopy(part))) return part;
      const indent = /^[ \t]*/.exec(part)?.[0] ?? "";
      return `${indent}${marker} ${part.slice(indent.length)}`;
    })
    .join("");
}

/**
 * What "operator" can be drawn with so the literal match misses it: Cyrillic
 * and Greek letters that read as Latin (О/ο for o, Р/ρ for p, А/α for a,
 * Е/ε for e, С for c, Х for x — both cases; the match is case-insensitive so
 * folding to lowercase is enough), format characters (zero-width spaces,
 * joiners, BOM), and the typographic apostrophe in "Operator's answer".
 * NFKC first (NBSP and fullwidth fold to their ASCII shapes), then strip
 * \p{Cf}, then fold the homoglyphs. Only the DETECTION copy is folded — the
 * line the model sees is the original, with the marker in front.
 */
function detectionCopy(line: string): string {
  return line
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    // Invisible combining marks a \p{Cf} strip misses: the combining grapheme
    // joiner and variation selectors.
    .replace(/[\u034F\uFE00-\uFE0F]|\uDB40[\uDD00-\uDDEF]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(new RegExp(`[${Object.keys(HOMOGLYPHS).join("")}]`, "gu"), (ch) => HOMOGLYPHS[ch] ?? ch);
}

const HOMOGLYPHS: Readonly<Record<string, string>> = {
  "\u0430": "a", "\u0410": "a", "\u03B1": "a", "\u0391": "a", // а А α Α
  "\u0435": "e", "\u0415": "e", "\u03B5": "e", "\u0395": "e", // е Е ε Ε
  "\u043E": "o", "\u041E": "o", "\u03BF": "o", "\u039F": "o", // о О ο Ο
  "\u0440": "p", "\u0420": "p", "\u03C1": "p", "\u03A1": "p", // р Р ρ Ρ
  "\u0441": "c", "\u0421": "c",                                 // с С
  "\u0445": "x", "\u0425": "x",                                 // х Х
};

/**
 * Every framing the loop itself writes into a user turn, matched ANYWHERE in
 * a line (a markdown prefix, quoting or surrounding prose must not shield
 * it) and case-insensitively:
 *
 *   Operator steering — adjust course accordingly:      (durable.ts drain)
 *   Operator message (queued for your checkpoint)        (queuedMessage)
 *   Operator interrupt …                                 (boundary/during)
 *   Operator's answer:                                   (ask.ts)
 *   The operator approved [an EDITED version of] your plan (durable.ts)
 *   Action denied by the operator                        (durable.ts)
 *   The operator did not answer                          (ask.ts)
 *
 * Loose on purpose: "operator  steering" (double space), "operator's answer"
 * with either apostrophe, plural and past-tense spellings ("operator
 * answers", "operator's answers", "operator answered"), and the homoglyph
 * spellings all match after detectionCopy. Strict where it matters: the
 * keyword after "operator" is a whole word, so prose like "the operator
 * operated" stays unfenced.
 */
const OPERATOR_FRAMING = new RegExp(
  [
    "\\boperator\\s*(?:'s)?\\s*(?:steering|messages?|interrupts?|answers?|answered|approved|denied)\\b",
    "\\b(?:denied|approved)\\s+by\\s+the\\s+operator\\b",
    "\\bthe\\s+operator\\s+did\\s+not\\s+answer\\b",
  ].join("|"),
  "i",
);

/**
 * The task-text variant: only a line that STARTS (after indentation and
 * markdown quote/list/emphasis characters) with a loop framing is fenced.
 * Ordinary task wording like "the k8s operator messages are dropped" or "our
 * Operator approved flow fails" must reach the model unmarked (2026-10-17
 * re-review: the loose match fenced real task sentences).
 */
const ANCHORED_FRAMING = new RegExp(
  "^[\\s>*_#`\\-+|]*(?:" +
    [
      "(?:the\\s+)?operator\\s*(?:'s)?\\s*(?:steering|messages?|interrupts?|answers?|answered|approved|denied)\\b",
      "action\\s+(?:denied|approved)\\s+by\\s+the\\s+operator\\b",
      "the\\s+operator\\s+did\\s+not\\s+answer\\b",
    ].join("|") +
    ")",
  "i",
);

function quoteNote(text: string): string {
  return text.trim() === "" ? "" : `: ${text.trim()}`;
}

/** A queued operator message, delivered at a checkpoint. */
export function queuedMessage(text: string): string {
  return `Operator message (queued for your checkpoint)${quoteNote(text)}`;
}

/** Turn-boundary interrupt: nothing was in flight to stop. */
export function boundaryInterruptMessage(notes: string[]): string {
  const said = notes.filter((n) => n.trim() !== "").map((n) => n.trim()).join(" / ");
  return (
    `Operator interrupt${said !== "" ? `: ${said}` : ""}. No action was running when it arrived (effect: none). ` +
    "Stop and reconsider your approach before your next action."
  );
}

/** The observation for an interrupt that landed on an action (before or during it). */
export function interruptObservation(record: InterruptRecord, what: string): string {
  const said = record.notes.filter((n) => n.trim() !== "").map((n) => n.trim()).join(" / ");
  const head = `Operator interrupt${said !== "" ? `: ${said}` : ""}.`;
  let body: string;
  if (record.at === "before") {
    body = `Your ${what} action was NOT run (effect: not done).`;
  } else if (record.effect === "unknown") {
    body = `Your ${what} action was cancelled part-way (effect: unknown — it may have done some of its work; check the workspace before relying on it).`;
  } else if (!record.cancellable) {
    body = `Your ${what} action could not be cancelled mid-flight in this version and ran to completion (effect: done); its output is above.`;
  } else {
    body = `Your ${what} action had already completed when the interrupt landed (effect: done); its output is above.`;
  }
  return `${head} ${body} Stop and reconsider before your next action.`;
}

type Claim = NonNullable<Pick<SteerStore, "claimHeld">["claimHeld"]>;

/**
 * Run one executable action under the interrupt protocol. Called INSIDE the
 * `turn-N-exec` step, so whatever this returns is the recorded result and a
 * replay never re-claims or re-runs anything.
 *
 * Two safe points, each claiming under its own key so a crash-and-rerun of the
 * step re-derives the same answer for that point:
 *  - `i:<turn>:before` — at the action's start. A pending interrupt means the
 *    action never runs (effect: not done).
 *  - `i:<turn>:during` — polled while it runs. A kernel cell is cancelled
 *    through the kernel's cancel marker (a real SIGINT); a bash command or an
 *    edit cannot be — the executor contract has no abort — so it runs to its
 *    end and the interrupt is reported with effect `done`.
 * `turn` is the caller's turn LABEL: durable.ts passes the attempt-prefixed
 * label on multi-attempt runs, so attempt 1's `i:N:before` does not answer
 * attempt 0's claim of the same number.
 * Store errors read as "no interrupt": steering is advisory and never fails a
 * run, the rule the drain step follows too.
 */
export async function runInterruptible(options: {
  claim: Claim;
  runId: string;
  turn: string;
  action: Extract<Action, { kind: "bash" | "python" | "edit" | "create" }>;
  run: (signal: AbortSignal) => Promise<ExecResult>;
  pollMs: number;
}): Promise<InterruptibleResult> {
  const { claim, runId, turn, action } = options;
  const cancellable = action.kind === "python";
  const before = await claim(runId, "interrupt", `i:${turn}:before`).catch(() => [] as string[]);
  if (before.length > 0) {
    return {
      exitCode: 130,
      stdout: "",
      stderr: "",
      timedOut: false,
      truncated: false,
      interrupt: { at: "before", effect: "not-done", notes: before, cancellable },
    };
  }

  const controller = new AbortController();
  let during: string[] = [];
  let stopped = false;
  let wake: (() => void) | null = null;
  const poller = (async () => {
    while (!stopped) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.pollMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      if (stopped) return;
      const got = await claim(runId, "interrupt", `i:${turn}:during`).catch(() => [] as string[]);
      if (got.length > 0) {
        during = got;
        controller.abort();
        return;
      }
    }
  })();

  let result: ExecResult;
  try {
    result = await options.run(controller.signal);
  } finally {
    stopped = true;
    (wake as (() => void) | null)?.();
    // A claim already in flight when the action ended must land in THIS
    // result: it consumed the operator's interrupt, and dropping it here
    // would lose the request without telling anyone.
    await poller;
  }
  if (during.length === 0) return result;
  const cancelledPartWay =
    cancellable && controller.signal.aborted && result.exitCode !== 0 && /KeyboardInterrupt/.test(`${result.stdout}\n${result.stderr}`);
  return {
    ...result,
    interrupt: { at: "during", effect: cancelledPartWay ? "unknown" : "done", notes: during, cancellable },
  };
}
