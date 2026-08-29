import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { WorkflowEvent } from "@neutron-build/workflow";
import { isCursorEvent } from "@neutron-build/workflow";

import { NATIVE_HARNESS_ID } from "./harness.js";
import type { DurableAgentInput } from "./durable.js";

/**
 * The upgrade fence: can THIS build replay a run that ANOTHER build enqueued?
 *
 * docs/UPGRADING.md section 3 states the hazard and section 3a states the
 * guard. In short: a durable run is an event log that is REPLAYED, so a run
 * enqueued under old code is re-executed by new code, and if the new code's
 * step sequence differs from the log the engine raises a NondeterminismError
 * that `executeRun` THROWS rather than records. Nothing in the run is damaged,
 * but the run cannot move again until the code that wrote its log comes back.
 *
 * The fingerprint answers that question BEFORE a replay is attempted, which is
 * what makes `teploy-ship preflight` possible at all: a deploy script has to be
 * able to ask "would this build break the runs that are in flight" without
 * executing any of them.
 *
 * WHAT IT IS COMPUTED FROM
 *
 * Two halves, and the split is the whole design:
 *
 *   1. The ordered list of step names the workflow can record. Declared in
 *      `WORKFLOW_STEPS` below, and PROVEN against the code by
 *      step-fingerprint.test.ts, which extracts the same sequence statically
 *      from the compiled `durable.js` and `harness-external.js` and asserts
 *      the two are identical. So the list cannot quietly fall behind the
 *      workflow: adding, renaming, reordering or removing a step fails the
 *      test until this table is updated, and whoever updates it is standing
 *      in front of the doc comment explaining the gate.
 *   2. A per-step gate (`admits`) saying which recorded-input field makes the
 *      step appear at all.
 *
 * The declared table, not the extraction, is what the running code reads. The
 * extraction is a test, deliberately: a fence that did file I/O on its own dist
 * directory at run time would have a failure mode (a bundler, a rename) in
 * which it computes a fingerprint that matches nothing and parks the entire
 * queue. A stale table fails CI; a broken reader would fail production.
 *
 * The fingerprint of a run is the hash of the step names its RECORDED INPUT
 * admits, in source order. That reproduces the UPGRADING table exactly:
 *
 *   - a new step gated on a run-input flag absent from old logs  -> old runs
 *     do not admit it, their fingerprint is unchanged, no park. (This is the
 *     shape every optional feature in this codebase takes, and a fingerprint
 *     without gates would park every in-flight run on every such change,
 *     which trains an operator to ignore it.)
 *   - a new step added unconditionally -> admitted by every input, every
 *     in-flight run's fingerprint moves, every one parks.
 *   - a renamed step -> same.
 *   - anything outside these modules (web routes, docs, intake, comments,
 *     formatting, a threshold, a step's BODY) -> the sequence is unchanged
 *     and no run parks.
 *
 * WHERE IT IS CONSERVATIVE, AND WHERE IT IS BLIND
 *
 * Conservative (it parks a run that would have been fine):
 *
 *   - SOURCE order is a proxy for EXECUTION order. Moving a helper function
 *     to a different place in the file changes the fingerprint even though
 *     nothing about a replay changed. That is a deliberate trade: a false park
 *     costs a rollback-or-resume, a missed break costs the run.
 *   - A gate is a fact about the INPUT only. A step whose presence also
 *     depends on what the run did (`publish-on-failure`, `change-rejected`,
 *     `turn-N-condense`) is admitted by every input that could reach it.
 *
 * Blind (it can miss a real break), which is why it is not the only guard:
 *
 *   - A reordering achieved by swapping two CALL SITES of helpers that each
 *     contain a step does not move either step's position in the source.
 *
 * The backstop for that is in worker.ts: a `NondeterminismError` out of a
 * replay parks the run on exactly the same hold rather than being logged and
 * retried every tick forever. The fingerprint makes the common break cheap to
 * see; the backstop makes every break survivable.
 *
 * WHERE THE FINGERPRINT IS STORED
 *
 * On the `run-started` event, as a SIBLING of `input` (`data.stepFingerprint`)
 * — never inside the input itself. The recorded input is what gates step
 * presence, so a field added there changes how an in-flight run replays: a
 * fingerprint stored in the input could cause the very failure it exists to
 * prevent. The engine reads only `data.workflow` and `data.input` and ignores
 * anything else on that event (see executeRun), so a sibling key is inert to
 * replay, needs no schema change, needs no migration, and travels with the log
 * it describes.
 *
 * A run whose log carries no fingerprint at all (enqueued before this existed,
 * or executed directly by `executeRun`, which writes its own `run-started`)
 * is NOT parked. Parking those would park every run in flight on the very
 * deploy that introduces the fence.
 */

// ---------------------------------------------------------------------------
// Static extraction
// ---------------------------------------------------------------------------

type Token = { k: "str"; v: string } | { k: "name"; v: string } | { k: "punct"; v: string };

/** Identifiers after which a `/` opens a regular expression rather than dividing. */
const REGEX_AFTER_KEYWORD = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "do",
  "else",
  "yield",
  "await",
  "instanceof",
]);

function regexAllowed(prev: Token | undefined): boolean {
  if (prev === undefined) return true;
  if (prev.k === "name") return REGEX_AFTER_KEYWORD.has(prev.v);
  if (prev.k === "str") return false;
  return prev.v !== ")" && prev.v !== "]" && prev.v !== "}";
}

/**
 * Enough of a JavaScript lexer to answer "which string literal is the first
 * argument of this `.step(` call", and no more.
 *
 * Written out rather than regex-scanned because both cheap alternatives are
 * wrong in ways that matter here. A regex over the raw text matches inside
 * comments (`durable.ts` discusses `ctx.step(` in prose), and a naive
 * quote-tracker desynchronises on `` `'${v.replace(/'/g, `'\\''`)}'` `` in
 * harness-external.ts — a template holding a regex holding a quote holding a
 * nested template. A desynchronised scanner does not fail loudly; it silently
 * returns a different sequence, which would make this whole control report a
 * confident wrong answer.
 */
export function tokenize(source: string): Token[] {
  const out: Token[] = [];
  // Template frames: literal chunks collected so far, `*` standing in for each
  // `${...}` expression. A nested template inside `${}` gets its own frame.
  const templates: string[][] = [];
  // What each open brace is: an ordinary block, or the `${` of a template.
  const braces: Array<"code" | "template"> = [];
  let mode: "code" | "template" = "code";
  let prev: Token | undefined;
  let i = 0;
  const n = source.length;

  // Tokens inside a `${...}` interpolation are dropped: they belong to the
  // template's own expression, not to the statement being scanned, and leaving
  // them in would put `p` between `.step(` and the template it interpolates.
  // `prev` still advances over them so regex-vs-division stays correct.
  const emit = (token: Token): void => {
    prev = token;
    if (templates.length === 0) out.push(token);
  };

  while (i < n) {
    if (mode === "template") {
      const frame = templates[templates.length - 1]!;
      const c = source[i]!;
      if (c === "\\") {
        frame.push(source[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (c === "`") {
        templates.pop();
        emit({ k: "str", v: frame.join("") });
        mode = "code";
        i++;
        continue;
      }
      if (c === "$" && source[i + 1] === "{") {
        frame.push("*");
        braces.push("template");
        mode = "code";
        i += 2;
        continue;
      }
      frame.push(c);
      i++;
      continue;
    }

    const c = source[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "/" && regexAllowed(prev)) {
      i++;
      let inClass = false;
      while (i < n) {
        const r = source[i]!;
        if (r === "\\") {
          i += 2;
          continue;
        }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) {
          i++;
          break;
        } else if (r === "\n") break; // unterminated: treat as division after all
        i++;
      }
      while (i < n && /[a-z]/.test(source[i]!)) i++;
      prev = { k: "punct", v: "/re/" };
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      let value = "";
      while (i < n) {
        const s = source[i]!;
        if (s === "\\") {
          value += source[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (s === c) {
          i++;
          break;
        }
        value += s;
        i++;
      }
      emit({ k: "str", v: value });
      continue;
    }
    if (c === "`") {
      templates.push([]);
      mode = "template";
      i++;
      continue;
    }
    if (/[A-Za-z_$0-9]/.test(c)) {
      let value = "";
      while (i < n && /[A-Za-z_$0-9]/.test(source[i]!)) {
        value += source[i]!;
        i++;
      }
      emit({ k: "name", v: value });
      continue;
    }
    if (c === "{") braces.push("code");
    if (c === "}") {
      if (braces.pop() === "template") {
        mode = "template";
        i++;
        continue;
      }
    }
    emit({ k: "punct", v: c });
    i++;
  }
  return out;
}

/**
 * The ordered deterministic operations one compiled module can record.
 *
 * `step:<name>` for a recorded step, `wait:<expr>` for a `waitForEvent` (its
 * argument is an identifier or a call, so the source text of the expression is
 * what changes when the event is renamed). A `${...}` in a step name — the
 * attempt prefix, the turn number — normalises to `*`, so renaming the local
 * variable that fills it is not a change.
 *
 * A `.step(` whose first argument is not a literal records `step:<computed>`:
 * that is a step whose name this cannot know, and collapsing every such call
 * to one opaque marker keeps the sequence honest rather than silently short.
 */
export function extractStepSequence(source: string): string[] {
  const tokens = tokenize(source);
  const found: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const dot = tokens[i]!;
    if (!(dot.k === "punct" && dot.v === ".")) continue;
    const name = tokens[i + 1];
    if (name === undefined || name.k !== "name") continue;
    if (name.v !== "step" && name.v !== "waitForEvent") continue;
    // Bounded skip to the call's open paren, so a bare `.step` reference used
    // as a value cannot run the scan off the end of the file.
    let j = i + 2;
    const limit = Math.min(tokens.length, j + 8);
    while (j < limit && !(tokens[j]!.k === "punct" && tokens[j]!.v === "(")) j++;
    if (j >= limit) continue;
    const arg = tokens[j + 1];
    if (arg === undefined) continue;
    if (name.v === "step") {
      found.push(arg.k === "str" ? `step:${arg.v}` : "step:<computed>");
      continue;
    }
    // waitForEvent: keep the argument's source text up to the argument
    // separator, so `approvalEvent(turn)` and `PLAN_EVENT` are distinguishable
    // and a rename of either is a change.
    let expr = "";
    let depth = 0;
    for (let k = j + 1; k < tokens.length; k++) {
      const t = tokens[k]!;
      if (t.k === "punct") {
        if (t.v === "(") depth++;
        else if (t.v === ")") {
          if (depth === 0) break;
          depth--;
        } else if (t.v === "," && depth === 0) break;
      }
      expr += t.k === "str" ? JSON.stringify(t.v) : t.v;
    }
    found.push(`wait:${expr}`);
  }
  return found;
}

/**
 * The compiled modules whose step calls make up the coding-agent workflow.
 *
 * Only these two contain `ctx.step` today. A module added later that records
 * steps must be added here, and step-fingerprint.test.ts fails if one exists
 * and is missing — the list cannot quietly fall behind the code.
 */
export const WORKFLOW_STEP_MODULES = ["durable.js", "harness-external.js", "ladder-steps.js"] as const;

let cachedSequence: Promise<string[]> | null = null;

/** The running build's step sequence, read from the compiled modules beside this one. */
export async function buildStepSequence(): Promise<string[]> {
  cachedSequence ??= (async () => {
    const parts: string[] = [];
    for (const module of WORKFLOW_STEP_MODULES) {
      const path = fileURLToPath(new URL(`./${module}`, import.meta.url));
      parts.push(...extractStepSequence(await readFile(path, "utf8")));
    }
    if (parts.length === 0) {
      // Refusing beats guessing. An empty extraction means the layout this
      // reads changed (a bundler, a rename); a fingerprint computed from it
      // would differ from every recorded one and park the entire queue.
      throw new Error(
        `no workflow steps found in ${WORKFLOW_STEP_MODULES.join(", ")} beside ${import.meta.url} — ` +
          `the upgrade fence cannot compute a fingerprint for this build`,
      );
    }
    return parts;
  })();
  return await cachedSequence;
}

/**
 * Does the declared table agree with what the compiled modules actually record?
 *
 * The comparison `step-fingerprint.test.ts` makes at TEST time, factored out so
 * `teploy-ship preflight` can make the same one at DEPLOY time — the deploy
 * recipe runs preflight but not the suite, and a stale table made preflight
 * vouch for a build whose fence was misdeclared. Returns a human-readable
 * description of the divergence, or null when the two agree.
 *
 * Deploy-time only, deliberately. The running fence reads the declared table,
 * never this: a runtime extraction feeding live fingerprints would have a
 * failure mode (a bundler, a rename) that parks the entire queue, whereas a
 * stale table caught HERE fails one deploy with the reason named.
 */
export function tableDrift(extracted: readonly string[]): string | null {
  const declared = WORKFLOW_STEPS.map((s) => s.key);
  const n = Math.min(declared.length, extracted.length);
  for (let i = 0; i < n; i++) {
    if (declared[i] !== extracted[i]) {
      return `the table and the compiled workflow diverge at position ${i}: the table declares '${declared[i]}', the code records '${extracted[i]}'`;
    }
  }
  if (declared.length !== extracted.length) {
    const fromTable = declared.length > extracted.length;
    const extra = fromTable ? declared[n] : extracted[n];
    return `the ${fromTable ? "table declares an entry the code does not record" : "code records an entry the table does not declare"}: '${extra}' at position ${n}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The gate table
// ---------------------------------------------------------------------------

/** A recorded run input, as it comes back off the log. */
export type RecordedInput = Readonly<DurableAgentInput>;

export interface WorkflowStep {
  /** The extracted marker: `step:<name>` or `wait:<expr>`, `*` for an interpolation. */
  readonly key: string;
  /**
   * Could a run with this recorded input reach the step at all?
   *
   * A fact about the INPUT, never about the run's behaviour or the worker's
   * config — those cannot be known from a log without replaying it, which is
   * the thing this exists to avoid. When the answer is not obvious, say `true`:
   * an over-admitting gate parks a run that would have been fine, an
   * under-admitting one lets a real break through.
   */
  readonly admits: (input: RecordedInput) => boolean;
}

const always = (): boolean => true;
const repoRun = (i: RecordedInput): boolean => i.repo !== undefined;
const prRun = (i: RecordedInput): boolean => i.repo !== undefined && i.pr !== undefined;
/** The code index is keyed on a repo OR an explicit workspace key (durable.ts scopeKey). */
const scoped = (i: RecordedInput): boolean => i.repo !== undefined || i.workspaceKey !== undefined;
const multiAttempt = (i: RecordedInput): boolean => (i.harnessAttempts?.length ?? 0) >= 2;
/** Absent `harness` means native; only an external adapter records its own steps. */
const externalHarness = (i: RecordedInput): boolean =>
  (i.harness !== undefined && i.harness.id !== NATIVE_HARNESS_ID) ||
  (i.harnessAttempts ?? []).some((h) => h.id !== NATIVE_HARNESS_ID);

/**
 * Every deterministic operation the workflow can record, in the order the
 * compiled modules declare them, with the input field that admits each.
 *
 * KEEP THIS IN THE ORDER `extractStepSequence` RETURNS — the test asserts
 * exactly that, and the order is part of the fingerprint.
 */
export const WORKFLOW_STEPS: readonly WorkflowStep[] = [
  { key: "step:sandbox", admits: always },
  { key: "step:repo-setup", admits: repoRun },
  { key: "step:repo-context", admits: repoRun },
  { key: "step:repo-index", admits: (i) => i.index === true && scoped(i) },
  { key: "step:injection-guard", admits: (i) => i.guard === true && repoRun(i) },
  { key: "step:pr-review-comments", admits: prRun },
  { key: "step:scan-findings", admits: (i) => i.mode === "scan" },
  // Only reachable when the harness threw AND the tree was publishable, both
  // facts about the run rather than the input; gated on the input it needs.
  { key: "step:publish-on-failure", admits: repoRun },
  { key: "step:*sandbox", admits: multiAttempt },
  { key: "step:*repo-setup", admits: multiAttempt },
  { key: "step:*diff", admits: multiAttempt },
  { key: "step:harness-pick", admits: multiAttempt },
  { key: "step:*plan-think", admits: (i) => i.plan === true },
  { key: "step:*plan-snapshot", admits: (i) => i.plan === true },
  { key: "wait:PLAN_EVENT", admits: (i) => i.plan === true },
  { key: "step:*plan-restore", admits: (i) => i.plan === true },
  { key: "step:*turn-*-steer", admits: (i) => i.steer === true },
  // No input gate: condensing fires on transcript size.
  { key: "step:*turn-*-condense", admits: always },
  { key: "step:*turn-*-think", admits: always },
  { key: "step:*turn-*-finish-tree", admits: (i) => i.requireEdit === true },
  // Iterate-until-green's exhaustion record: only a run given a bound can hit it.
  { key: "step:*turn-*-fix-exhausted", admits: (i) => i.fixRetries !== undefined },
  { key: "step:*turn-*-critic-diff", admits: (i) => i.critic === true },
  { key: "step:*turn-*-critic", admits: (i) => i.critic === true },
  // The ```search action is offered on any run; deliberately ungated.
  { key: "step:*turn-*-search", admits: always },
  { key: "step:*turn-*-snapshot", admits: always },
  { key: "wait:approvalEvent(turn)", admits: always },
  { key: "step:*turn-*-restore", admits: always },
  { key: "step:*turn-*-exec", admits: always },
  // Mirrors `recoveryOn` in durable.ts: settle turns the tracker on too.
  {
    key: "step:*turn-*-fingerprint",
    admits: (i) => i.recovery !== false && (i.recovery !== undefined || i.settle === true),
  },
  { key: "step:*turn-*-hold-recheck", admits: (i) => i.requireEdit === true },
  { key: "step:change-class", admits: (i) => i.changeClass === true },
  { key: "wait:CHANGE_EVENT", admits: (i) => i.changeClass === true },
  { key: "step:change-rejected", admits: (i) => i.changeClass === true },
  { key: "step:repo-push", admits: repoRun },
  { key: "step:repo-memory", admits: repoRun },
  { key: "step:repo-comment", admits: prRun },
  { key: "step:repo-pr", admits: repoRun },
  // The boundary park (C1), in the source order of mergeGateIfSerious. Its
  // steps and its wait are admitted by mergeGate alone — NOT by changeClass —
  // so a run enqueued under the old routing (no mergeGate in its input) keeps
  // the fingerprint it recorded and replays under the mid-run park it parked
  // at, while a run with both flags gets the moved park.
  { key: "step:merge-park", admits: (i) => i.mergeGate === true },
  { key: "step:merge-snapshot", admits: (i) => i.mergeGate === true },
  { key: "wait:MERGE_EVENT", admits: (i) => i.mergeGate === true },
  { key: "step:merge-restore", admits: (i) => i.mergeGate === true },
  { key: "step:merge-decision", admits: (i) => i.mergeGate === true },
  { key: "step:merge-rebase", admits: (i) => i.mergeGate === true },
  { key: "step:merge-decision", admits: (i) => i.mergeGate === true },
  { key: "step:merge-decision", admits: (i) => i.mergeGate === true },
  { key: "step:rollback", admits: (i) => i.rollback === true },
  { key: "step:auto-rebase", admits: (i) => i.autoMerge === true },
  { key: "step:auto-merge", admits: (i) => i.autoMerge === true },
  { key: "step:repo-reviewers", admits: (i) => i.reviewers !== undefined },
  // The preview-deploy gate mirrors previewIfAsked exactly: the run asked via
  // `preview`, or its declared ladder carries a preview rung (C4).
  { key: "step:preview-deploy", admits: (i) => i.preview === true || i.verification?.preview !== undefined },
  { key: "step:telemetry-check", admits: (i) => i.telemetry === true },
  { key: "step:verification", admits: repoRun },
  { key: "step:tests", admits: (i) => i.tests === true },
  // runSuite, shared by the publish gate (""), the C4 baseline and the critic.
  { key: "step:*tests", admits: (i) => i.tests === true },
  { key: "step:*harness-preflight", admits: externalHarness },
  { key: "step:*harness-run", admits: externalHarness },
  // The ladder's own steps (ladder-steps.js, third module above), in that
  // file's source order. Each is admitted by the rung it records, all off
  // `verification` — a field no pre-ladder log carries, so those runs'
  // fingerprints are untouched.
  { key: "step:build", admits: (i) => i.verification?.build !== undefined },
  { key: "step:preview-smoke", admits: (i) => i.verification?.preview !== undefined },
  { key: "step:visual-diff", admits: (i) => i.verification?.visual === true },
  { key: "step:observe-window", admits: (i) => i.verification?.observeWindowMin !== undefined },
  { key: "step:ladder", admits: (i) => i.verification !== undefined },
];

// ---------------------------------------------------------------------------
// The fingerprint
// ---------------------------------------------------------------------------

/**
 * Bumped when the way a fingerprint is COMPUTED changes (a new extraction rule,
 * a different hash), as opposed to when the workflow changes. Old runs carry
 * an old scheme and are treated as uncomparable rather than as mismatched — a
 * scheme change is our doing, not theirs.
 */
export const FINGERPRINT_SCHEME = "s1";

/** The step keys a run with this recorded input can produce, in source order. */
export function admittedSteps(input: RecordedInput): string[] {
  return WORKFLOW_STEPS.filter((s) => s.admits(input)).map((s) => s.key);
}

function hash(keys: readonly string[]): string {
  return `${FINGERPRINT_SCHEME}:${createHash("sha256").update(keys.join("\n")).digest("hex").slice(0, 16)}`;
}

/**
 * The fingerprint of an arbitrary step table for one input. Exported so a test
 * can hold the input fixed and vary the TABLE — which is the only way to assert
 * "a new unconditional step moves every run's fingerprint, a new input-gated
 * one moves only the runs that set the flag" without editing durable.ts.
 */
export function fingerprintOf(steps: readonly WorkflowStep[], input: RecordedInput): string {
  return hash(steps.filter((s) => s.admits(input)).map((s) => s.key));
}

/** The fingerprint of a run with this recorded input, under this build. */
export function stepFingerprint(input: RecordedInput): string {
  return hash(admittedSteps(input));
}

/**
 * One stable name for this build's workflow shape: the hash of the WHOLE
 * declared sequence, before any gate applies.
 *
 * Not what a run records — a run's fingerprint is the gated subsequence its own
 * input admits — but it is the number a person comparing two deployments wants,
 * and the one `preflight` prints so two boxes can be checked against each other
 * without reading a run.
 */
export function buildFingerprint(): string {
  return hash(WORKFLOW_STEPS.map((s) => s.key));
}

/** What `run-started` carries beyond the engine's own two fields. */
interface ShipRunStartedData {
  workflow?: string;
  input?: unknown;
  stepFingerprint?: string;
}

function runStarted(events: readonly WorkflowEvent[]): ShipRunStartedData | undefined {
  const started = events.find((e) => e.type === "run-started");
  const data = started?.data;
  return typeof data === "object" && data !== null ? (data as ShipRunStartedData) : undefined;
}

/** The fingerprint a run recorded at enqueue, or undefined if it recorded none. */
export function recordedFingerprint(events: readonly WorkflowEvent[]): string | undefined {
  const value = runStarted(events)?.stepFingerprint;
  return typeof value === "string" && value !== "" ? value : undefined;
}

export interface ReplayDrift {
  /** What the run recorded at enqueue. */
  recorded: string;
  /** What this build computes for the same input. */
  current: string;
}

/**
 * Would replaying this run under the running build change its step sequence?
 *
 * `null` means "go ahead", and it is the answer in four distinct cases that
 * all deserve to proceed: the fingerprints agree, the run predates the fence
 * (no recorded fingerprint — see the header), the run was recorded under a
 * different fingerprint SCHEME, which says nothing about the workflow, or the
 * run has recorded NOTHING REPLAYABLE — a log with no cursor events is a
 * fresh start under any build, and holding it parks a run no deploy can hurt
 * while telling the operator an untruth about why.
 */
export function replayDrift(events: readonly WorkflowEvent[]): ReplayDrift | null {
  const recorded = recordedFingerprint(events);
  if (recorded === undefined) return null;
  if (!recorded.startsWith(`${FINGERPRINT_SCHEME}:`)) return null;
  // Replay walks CURSOR events one-by-one; with none there is nothing to
  // walk and no divergence is possible. The recorded fingerprint stays stale
  // in the log — a later fence read may false-park against the enqueue-time
  // build after this one has run — which is the fence's standing conservative
  // trade (a false park costs a rollback-or-resume), not a broken run.
  if (!events.some(isCursorEvent)) return null;
  const input = runStarted(events)?.input;
  if (typeof input !== "object" || input === null) return null;
  const current = stepFingerprint(input as RecordedInput);
  return current === recorded ? null : { recorded, current };
}

/**
 * The event name a run held by the fence waits on (defined in fence.ts so
 * dashboard routes can import it without the file-reading machinery).
 *
 * Never delivered — nothing signals it, and NOTHING IS APPENDED TO THE EVENT
 * LOG to create the hold. That is not an optimisation: `event-waiting` is a
 * cursor event, so writing one would itself change the recorded sequence and
 * break the replay this exists to protect. The hold lives entirely in the run
 * INDEX (status `waiting`, so the run stops coming due every tick) and in the
 * run's meta, both of which are outside the log.
 *
 * It reuses the ordinary park state rather than a status of its own so the run
 * arrives in the inbox as a decision — a new status string would map to
 * `pending` in every consumer, which is quieter than a park and the opposite
 * of what a held run needs. `eventName` is what separates it from an approval,
 * and inbox.ts asks the right question and offers the right two actions.
 *
 * The hold is cleared by `teploy-ship resume`, or on its own once the running
 * build agrees with the run again (a rollback): the fingerprint is recomputed
 * on every execution attempt and by the worker's sweep, never remembered.
 */
export { UPGRADE_HOLD_EVENT, upgradeHoldRefusal } from "./fence.js";

/** What an operator is told about a held run, in one line plus the fix. */
export function upgradeHoldReason(runId: string, drift: ReplayDrift): string {
  return (
    `run ${runId} was enqueued by a build whose workflow step sequence (${drift.recorded}) differs from this one ` +
    `(${drift.current}). Replaying it here would raise a NondeterminismError, so it is held instead. ` +
    `Roll the deployment back to release it, or cancel the run if you are willing to lose it.`
  );
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** What a single in-flight run says about deploying this build. */
export type PreflightVerdict =
  /** This build replays the run's recorded sequence. */
  | "ok"
  /** This build's sequence differs from the run's; replaying it would break. */
  | "would-break"
  /**
   * The run recorded no comparable fingerprint — enqueued before the fence
   * existed, or under a different fingerprint scheme. Nothing can be said
   * about it either way, which is why it is its own answer and not "ok".
   */
  | "unrecorded";

export interface PreflightRun {
  runId: string;
  status: string;
  task: string;
  verdict: PreflightVerdict;
  recorded?: string;
  current?: string;
}

export interface PreflightReport {
  /** This build's whole-workflow fingerprint (`buildFingerprint`). */
  build: string;
  /** Only runs whose log has no terminal event — the ones a deploy can hurt. */
  runs: PreflightRun[];
  wouldBreak: number;
  unrecorded: number;
  /** False means a deploy of this build would leave at least one run held. */
  safe: boolean;
}

const TERMINAL_TYPES: ReadonlySet<string> = new Set(["run-completed", "run-failed", "run-cancelled"]);

/**
 * Would deploying this build be safe against the runs that are in flight?
 *
 * Pure over the logs it is handed, so a deploy script's answer and a test's
 * answer come from the same function. Terminal runs are dropped here rather
 * than by the caller: `RunMeta.status` can lag the log, and the log is the
 * only thing that actually decides whether a run can still be replayed.
 *
 * `unrecorded` runs count as unsafe by default. That is deliberately awkward
 * for exactly one deploy — the one that first introduces the fence, when every
 * in-flight run predates it — and `allowUnrecorded` is the acknowledgement.
 * The alternative, treating "we cannot tell" as "fine", makes the command
 * answer a question it did not ask.
 */
export function preflightReport(
  runs: readonly { runId: string; status: string; task: string; events: readonly WorkflowEvent[] }[],
  options: { allowUnrecorded?: boolean } = {},
): PreflightReport {
  const rows: PreflightRun[] = [];
  for (const run of runs) {
    if (run.events.length === 0) continue;
    if (run.events.some((e) => TERMINAL_TYPES.has(e.type))) continue;
    const recorded = recordedFingerprint(run.events);
    if (recorded === undefined || !recorded.startsWith(`${FINGERPRINT_SCHEME}:`)) {
      rows.push({ runId: run.runId, status: run.status, task: run.task, verdict: "unrecorded", ...(recorded !== undefined ? { recorded } : {}) });
      continue;
    }
    const drift = replayDrift(run.events);
    rows.push(
      drift === null
        ? { runId: run.runId, status: run.status, task: run.task, verdict: "ok", recorded, current: recorded }
        : { runId: run.runId, status: run.status, task: run.task, verdict: "would-break", recorded: drift.recorded, current: drift.current },
    );
  }
  const wouldBreak = rows.filter((r) => r.verdict === "would-break").length;
  const unrecorded = rows.filter((r) => r.verdict === "unrecorded").length;
  return {
    build: buildFingerprint(),
    runs: rows,
    wouldBreak,
    unrecorded,
    safe: wouldBreak === 0 && (unrecorded === 0 || options.allowUnrecorded === true),
  };
}
