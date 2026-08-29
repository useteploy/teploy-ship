/**
 * The "what I did / what I verified / what I could not verify" paragraph.
 *
 * Every run ends with one. It is built from RECORDED STEP OUTCOMES — the
 * baseline suite, the suite after the change, the fix attempts a red suite
 * cost, the critic's advisory notes, the push, the pull request, the preview,
 * the telemetry read — and the agent's own account is only the first clause of
 * the first sentence. The point is that the paragraph cannot claim a
 * verification that no step recorded: an agent that says "all tests pass" over
 * a run whose `tests` step says `failed` produces a paragraph that says the
 * suite failed.
 *
 * Two producers, one renderer. The workflow assembles `VerificationFacts` from
 * the values it holds (it cannot read its own event log mid-run) and renders
 * them into the run output's `summary` and the pull request's lead. Anything
 * that only has the event log — the webhook (`verification.summary`), the run
 * page, a CLI reading a finished run — calls `runVerificationSummary(events)`,
 * which extracts the same facts from the recorded steps and renders them the
 * same way. durable.test.ts asserts the two agree on a real run.
 */
import type { WorkflowEvent } from "@neutron-build/workflow";

import { isApproved } from "./critic.js";
import type { ObserveOutcome, SmokeOutcome, VisualOutcome } from "./ladder.js";
import { telemetryRegression, type TelemetryVerdict } from "./observe.js";
import type { TestOutcome } from "./tests.js";
import { preExisting } from "./tests.js";

/** The wire budget for the paragraph (contract 2: `verification.summary` ≤ 2000). */
export const SUMMARY_LIMIT = 2000;

export interface VerificationFacts {
  /** The agent's own finish message. Only its first sentence is used. */
  agent?: string;
  /** How the run ended, when it did not end at a finish. */
  status?: string;
  baseline?: TestOutcome;
  /** The project's build command (the ladder's `build` rung), when it ran. */
  build?: TestOutcome;
  /** The suite over the tree that was published. */
  tests?: TestOutcome;
  /** Red finishes that were sent back to work with the failure output. */
  fixAttempts?: number;
  /** The bound those attempts were given (`SHIP_FIX_RETRIES`). */
  fixRetries?: number;
  /** The suite was still red when the attempts ran out. */
  fixExhausted?: { attempts: number; exitCode: number };
  /** The critic's advisory verdict over the verified tree. */
  critic?: { approved: boolean; notes: string };
  changeClass?: { class: string; files: number };
  push?: { kind: "pushed"; sha: string } | { kind: "refused" } | { kind: "empty" };
  pr?: { url: string; number: number };
  preview?: { kind: "deployed"; url: string } | { kind: "skipped" | "failed"; reason: string };
  /** The smoke command against the deployed preview (the ladder's preview rung's second half). */
  smoke?: SmokeOutcome;
  /** The screenshot pair the visual rung captured, or why it could not. */
  visual?: VisualOutcome;
  /** The observe window after the preview (the ladder's `observe` rung). */
  observeWindow?: ObserveOutcome;
  telemetry?: { kind: "compared"; worse: boolean } | { kind: "disabled" | "insufficient" | "unavailable"; reason: string };
  rollback?: { kind: string };
  merge?: MergeFact;
}

/**
 * How the run's merge question resolved. `merged` says WHO authorised it
 * (`via`) because that is the fact an overseer audits; the held/blocked
 * kinds carry the recorded reasons so the paragraph quotes the gate, not a
 * paraphrase of it.
 */
export type MergeFact =
  | { kind: "merged"; via: "auto" | "approved" }
  | { kind: "held"; reasons: string[] }
  | { kind: "closed"; reason: string }
  | { kind: "ready" }
  | { kind: "blocked"; reasons: string[] }
  | { kind: "merge-failed"; reason: string };

/**
 * Map a recorded `auto-merge` or `merge-decision` step onto a MergeFact.
 * Exported because both producers use it: the workflow over its own step
 * value, the extractor over the recorded JSON.
 */
export function mergeFact(v: unknown, via: "auto" | "approved"): MergeFact | undefined {
  const r = obj(v);
  if (r === undefined || typeof r.kind !== "string") return undefined;
  switch (r.kind) {
    case "merged":
      return { kind: "merged", via };
    case "held":
    case "blocked":
      return { kind: r.kind, reasons: Array.isArray(r.reasons) ? r.reasons.map(String) : [] };
    case "closed":
      return { kind: "closed", reason: String(r.reason ?? "") };
    case "ready":
      return { kind: "ready" };
    case "failed":
    case "merge-failed":
      return { kind: "merge-failed", reason: String(r.reason ?? "") };
    default:
      return undefined;
  }
}

const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

/** First sentence of the agent's account, bounded — it is a clause, not the body. */
function firstSentence(text: string, max = 240): string {
  const line = text.trim().split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
  const cut = line.search(/[.!?](\s|$)/);
  const sentence = cut === -1 ? line : line.slice(0, cut + 1);
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

/**
 * The account as the paragraph's lead clause. A FINISH is a claim, so only its
 * first sentence is owed a place; a run that ended on a harness sentence
 * (errored, stuck, a limit) is not claiming anything, and its message often
 * carries the operator's next step ("not on PATH — run images/build.sh …")
 * which the first-sentence cut would drop.
 */
function accountOf(facts: VerificationFacts): string {
  if (facts.agent === undefined) return "";
  if (facts.status !== undefined && facts.status !== "finished") {
    return facts.agent.trim().split("\n")[0]!.slice(0, 600).trim();
  }
  return firstSentence(facts.agent).replace(/[.!?]$/, "");
}

/** Render the facts into the paragraph. Pure, so a replay renders the same bytes. */
export function verificationSummary(facts: VerificationFacts): string {
  const did: string[] = [];
  const verified: string[] = [];
  const not: string[] = [];

  const account = accountOf(facts);
  if (account !== "") did.push(account);
  if (facts.changeClass !== undefined) {
    did.push(`changed ${facts.changeClass.files} file${facts.changeClass.files === 1 ? "" : "s"} (classified ${facts.changeClass.class})`);
  }
  if (facts.push?.kind === "pushed") did.push(`pushed ${facts.push.sha.slice(0, 10)}`);
  else if (facts.push?.kind === "refused") did.push("the push was refused by the diff screen, so nothing left the sandbox");
  else if (facts.push?.kind === "empty") did.push("produced no diff, so nothing was pushed");
  if (facts.pr !== undefined) did.push(`opened pull request #${facts.pr.number}`);
  if (facts.status !== undefined && facts.status !== "finished") did.push(`the run ended as ${facts.status}`);
  if (did.length === 0) did.push("nothing was recorded");

  const b = facts.baseline;
  if (b?.kind === "passed") verified.push(`the suite passed on the base branch before any edit (\`${b.command}\`)`);
  else if (b?.kind === "failed") verified.push(`the suite was already failing on the base branch (exit ${b.exitCode}) before any edit`);
  else if (b?.kind === "errored") not.push(`the baseline suite could not run (${b.reason})`);

  const bd = facts.build;
  if (bd?.kind === "passed") verified.push(`the build passed (\`${bd.command}\`)`);
  else if (bd?.kind === "failed") not.push(`the build FAILED (exit ${bd.exitCode})`);
  else if (bd?.kind === "errored") not.push(`the build could not run (${bd.reason})`);

  const t = facts.tests;
  const attempts = facts.fixAttempts ?? 0;
  const after = attempts > 0 ? ` after ${attempts} fix attempt${attempts === 1 ? "" : "s"} on a red suite` : "";
  if (t?.kind === "passed") verified.push(`the suite passed over the published tree (\`${t.command}\`, ${seconds(t.durationMs)})${after}`);
  else if (t?.kind === "failed") {
    if (facts.fixExhausted !== undefined) {
      const bound = facts.fixRetries !== undefined ? ` of ${facts.fixRetries}` : "";
      not.push(
        `the suite is still red (exit ${t.exitCode}) after ${facts.fixExhausted.attempts}${bound} fix attempts — the last failure is attached and the change needs a human`,
      );
    } else if (preExisting(facts.baseline, t)) {
      not.push(`the suite fails the same way it did on the base branch (exit ${t.exitCode}), which is inherited breakage, not this change`);
    } else {
      not.push(`the suite FAILED over the published tree (\`${t.command}\`, exit ${t.exitCode})${after}`);
    }
  } else if (t?.kind === "errored") not.push(`the suite could not run (${t.reason})`);
  else if (t?.kind === "disabled") not.push(`no test suite (${t.reason})`);
  else if (t === undefined && b === undefined) not.push("no test suite was run by Ship");
  else if (t === undefined && b !== undefined) not.push("the suite never ran over the change — the run ended before its finish gate");

  if (facts.critic !== undefined) {
    // "after the suite" only when there was one — a suite-less run's critic
    // is the advisory check it has, and the paragraph must not imply a suite.
    const when = facts.tests !== undefined ? " after the suite" : "";
    if (facts.critic.approved) verified.push(`the critic reviewed the diff${when} and raised nothing`);
    else verified.push(`the critic reviewed the diff${when} and left risk notes (advisory, on the pull request)`);
  }

  const p = facts.preview;
  if (p?.kind === "deployed") verified.push(`a preview deployed at ${p.url}`);
  else if (p?.kind === "failed") not.push(`the preview deploy failed (${p.reason})`);
  else if (p?.kind === "skipped") not.push(`no preview (${p.reason})`);

  const s = facts.smoke;
  if (s?.kind === "passed") verified.push(`the preview's smoke passed (\`${s.command}\`)`);
  else if (s?.kind === "failed") not.push(`the preview's smoke FAILED (exit ${s.exitCode})`);
  else if (s?.kind === "errored") not.push(`the preview's smoke could not run (${s.reason})`);

  const v = facts.visual;
  if (v?.kind === "captured") {
    verified.push(`screenshots captured of the preview and main, ${v.differs ? "and they DIFFER" : "and they are identical"}`);
  } else if (v?.kind === "failed") not.push(`the visual diff failed (${v.reason})`);
  else if (v?.kind === "skipped") not.push(`no visual diff (${v.reason})`);

  const m = facts.telemetry;
  if (m?.kind === "compared") {
    if (m.worse) not.push("telemetry got WORSE after the change");
    else verified.push("telemetry before and after showed no regression");
  } else if (m !== undefined) not.push(`telemetry (${m.reason})`);

  const ow = facts.observeWindow;
  if (ow?.kind === "healthy") verified.push(`the observe window (${ow.windowMin}m) saw no error-rate rise after the preview`);
  else if (ow?.kind === "worse") not.push(`the observe window (${ow.windowMin}m) judged the preview WORSE and it was torn down: ${ow.reasons.join("; ")}`);
  else if (ow?.kind === "insufficient" || ow?.kind === "unavailable" || ow?.kind === "disabled") not.push(`no observe window (${ow.reason})`);

  if (facts.rollback?.kind === "rolled-back") not.push("the service got worse and was rolled back");
  const mg = facts.merge;
  if (mg?.kind === "merged") {
    did.push(mg.via === "auto" ? "merged it under the repo's auto-merge authority" : "merged it on the approved merge decision");
  } else if (mg?.kind === "ready") did.push("the approved pull request was marked ready for review");
  else if (mg?.kind === "closed") did.push(`the merge was denied and the pull request closed${mg.reason !== "" ? ` (${mg.reason.slice(0, 120)})` : ""}`);
  else if (mg?.kind === "held" && mg.reasons.length > 0) not.push(`auto-merge held: ${mg.reasons[0]}`);
  else if (mg?.kind === "blocked" && mg.reasons.length > 0) not.push(`the merge was approved but blocked: ${mg.reasons[0]}`);
  else if (mg?.kind === "merge-failed") not.push(`the merge attempt failed (${mg.reason.slice(0, 120)})`);

  const text =
    `What I did: ${did.join("; ")}. ` +
    `What I verified: ${verified.length > 0 ? verified.join("; ") : "nothing — no verification step recorded a result"}. ` +
    `What I could not verify: ${not.length > 0 ? not.join("; ") : "nothing outstanding"}.`;
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT - 1)}…` : text;
}

type Step = { name: string; result: unknown };

function steps(events: WorkflowEvent[]): Step[] {
  const out: Step[] = [];
  for (const e of events) {
    if (e.type !== "step-completed" || e.name === undefined || e.name === "") continue;
    out.push({ name: e.name, result: (e.data as { result?: unknown } | undefined)?.result });
  }
  return out;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

function testOutcome(v: unknown): TestOutcome | undefined {
  const r = obj(v);
  if (r === undefined || typeof r.kind !== "string") return undefined;
  switch (r.kind) {
    case "passed":
      return { kind: "passed", command: String(r.command ?? ""), durationMs: Number(r.durationMs ?? 0) };
    case "failed":
      return {
        kind: "failed",
        command: String(r.command ?? ""),
        durationMs: Number(r.durationMs ?? 0),
        exitCode: Number(r.exitCode ?? 1),
        output: String(r.output ?? ""),
      };
    case "errored":
      return { kind: "errored", command: String(r.command ?? ""), reason: String(r.reason ?? "") };
    case "disabled":
      return { kind: "disabled", reason: String(r.reason ?? "") };
    default:
      return undefined;
  }
}

/**
 * The ladder steps' outcomes, tolerated field by field like testOutcome:
 * JSON out of a store, where a missing field is a fact about the step's shape
 * and never a reason to drop the whole outcome.
 */
function smokeOutcome(v: unknown): SmokeOutcome | undefined {
  const r = obj(v);
  if (r === undefined || typeof r.kind !== "string") return undefined;
  switch (r.kind) {
    case "passed":
      return { kind: "passed", command: String(r.command ?? ""), durationMs: Number(r.durationMs ?? 0) };
    case "failed":
      return { kind: "failed", command: String(r.command ?? ""), exitCode: Number(r.exitCode ?? 1), output: String(r.output ?? "") };
    case "errored":
      return { kind: "errored", command: String(r.command ?? ""), reason: String(r.reason ?? "") };
    case "skipped":
      return { kind: "skipped", reason: String(r.reason ?? "") };
    default:
      return undefined;
  }
}

function visualOutcome(v: unknown): VisualOutcome | undefined {
  const r = obj(v);
  if (r === undefined || typeof r.kind !== "string") return undefined;
  if (r.kind === "skipped" || r.kind === "failed") return { kind: r.kind, reason: String(r.reason ?? "") };
  if (r.kind !== "captured") return undefined;
  const side = (name: "preview" | "main"): { url: string; sha256: string; bytes: number } => {
    const s = obj(r[name]) ?? {};
    return { url: String(s.url ?? ""), sha256: String(s.sha256 ?? ""), bytes: Number(s.bytes ?? 0) };
  };
  return { kind: "captured", preview: side("preview"), main: side("main"), differs: r.differs === true };
}

function observeOutcome(v: unknown): ObserveOutcome | undefined {
  const r = obj(v);
  if (r === undefined || typeof r.kind !== "string") return undefined;
  const windowMin = Number(r.windowMin ?? 0);
  const reasons = Array.isArray(r.reasons) ? r.reasons.map(String) : [];
  switch (r.kind) {
    case "healthy":
      return { kind: "healthy", windowMin, reasons };
    case "worse":
      return {
        kind: "worse",
        windowMin,
        reasons,
        rollback: {
          kind: (() => {
            const k = obj(r.rollback)?.kind;
            return k === "failed" || k === "skipped" ? k : "rolled-back";
          })(),
          detail: String(obj(r.rollback)?.detail ?? ""),
        },
      };
    case "insufficient":
    case "unavailable":
    case "disabled":
      return { kind: r.kind, windowMin, reason: String(r.reason ?? "") };
    default:
      return undefined;
  }
}

/** The agent's finish message, from the last recorded think step that carried one. */
function agentAccount(all: Step[], output: Record<string, unknown> | undefined): string | undefined {
  if (typeof output?.agentSummary === "string") return output.agentSummary;
  for (let i = all.length - 1; i >= 0; i--) {
    const s = all[i]!;
    if (!/turn-\d+-think$/.test(s.name)) continue;
    const text = obj(s.result)?.text ?? s.result;
    if (typeof text !== "string") continue;
    const m = /```finish\s*\n([\s\S]*?)```/.exec(text);
    if (m !== null) return m[1]!.trim();
  }
  return undefined;
}

/** Extract the facts from a run's event log. Tolerant of every field: this is JSON out of a store. */
export function verificationFactsFromEvents(events: WorkflowEvent[]): VerificationFacts {
  const all = steps(events);
  const started = events.find((e) => e.type === "run-started");
  const input = obj((started?.data as { input?: unknown } | undefined)?.input);
  const done = events.find((e) => e.type === "run-completed");
  const output = obj((done?.data as { output?: unknown } | undefined)?.output);
  const facts: VerificationFacts = {};

  const account = agentAccount(all, output);
  if (account !== undefined) facts.agent = account;
  if (typeof output?.status === "string") facts.status = output.status;
  if (typeof input?.fixRetries === "number") facts.fixRetries = input.fixRetries;

  let attempts = 0;
  for (const s of all) {
    const r = obj(s.result);
    if (s.name === "baseline-tests") {
      const o = testOutcome(s.result);
      if (o !== undefined) facts.baseline = o;
    } else if (s.name === "build") {
      const o = testOutcome(s.result);
      if (o !== undefined) facts.build = o;
    } else if (s.name === "preview-smoke") {
      const o = smokeOutcome(s.result);
      if (o !== undefined) facts.smoke = o;
    } else if (s.name === "visual-diff") {
      const o = visualOutcome(s.result);
      if (o !== undefined) facts.visual = o;
    } else if (s.name === "observe-window") {
      const o = observeOutcome(s.result);
      if (o !== undefined) facts.observeWindow = o;
    } else if (s.name === "tests" || /-tests$/.test(s.name)) {
      const o = testOutcome(s.result);
      if (o === undefined) continue;
      // Every suite run over the agent's tree is a candidate for "the final
      // suite"; the publish gate's `tests` step is the last one recorded, so
      // last-wins gives the outcome the pull request carries.
      facts.tests = o;
      if (/-finish-tests$/.test(s.name) && o.kind === "failed" && !preExisting(facts.baseline, o)) attempts += 1;
    } else if (/-fix-exhausted$/.test(s.name) && r !== undefined) {
      facts.fixExhausted = { attempts: Number(r.attempts ?? 0), exitCode: Number(r.exitCode ?? 1) };
    } else if (/-critic$/.test(s.name) && r !== undefined && r.reviewed === true && typeof r.text === "string") {
      facts.critic = { approved: isApproved(r.text), notes: r.text };
    } else if (s.name === "change-class" && r !== undefined && typeof r.class === "string") {
      facts.changeClass = { class: r.class, files: Array.isArray(r.files) ? r.files.length : 0 };
    } else if (s.name === "repo-push" && r !== undefined) {
      if (r.kind === "pushed") facts.push = { kind: "pushed", sha: String(r.sha ?? "") };
      else if (r.kind === "refused") facts.push = { kind: "refused" };
      else if (r.kind === "empty") facts.push = { kind: "empty" };
    } else if (s.name === "repo-pr" && r !== undefined && typeof r.url === "string") {
      facts.pr = { url: r.url, number: Number(r.number ?? 0) };
    } else if (s.name === "preview-deploy" && r !== undefined) {
      if (r.kind === "deployed") facts.preview = { kind: "deployed", url: String(r.url ?? "") };
      else if (r.kind === "skipped" || r.kind === "failed") facts.preview = { kind: r.kind, reason: String(r.reason ?? "") };
    } else if (s.name === "telemetry-check" && r !== undefined) {
      if (r.kind === "compared") {
        // The same judgement the workflow makes over the same recorded verdict
        // (observe.ts), so the two producers cannot disagree about "worse".
        facts.telemetry = { kind: "compared", worse: telemetryRegression(r as unknown as TelemetryVerdict).worse };
      } else if (r.kind === "disabled" || r.kind === "insufficient" || r.kind === "unavailable") {
        facts.telemetry = { kind: r.kind, reason: String(r.reason ?? "") };
      }
    } else if (s.name === "rollback" && r !== undefined && typeof r.kind === "string") {
      facts.rollback = { kind: r.kind };
    } else if (s.name === "auto-merge" && r !== undefined) {
      const f = mergeFact(s.result, "auto");
      if (f !== undefined) facts.merge = f;
    } else if (s.name === "merge-decision" && r !== undefined) {
      // Last-wins over `auto-merge`: a boundary-parked run records its held
      // auto-merge first and the human's decision after, and the decision is
      // the outcome that stands.
      const f = mergeFact(s.result, "approved");
      if (f !== undefined) facts.merge = f;
    }
  }
  // The exhausted finish's own suite run is the failure that was attached,
  // not an attempt that was sent back to work.
  if (facts.fixExhausted !== undefined) attempts = facts.fixExhausted.attempts;
  if (attempts > 0) facts.fixAttempts = attempts;
  return facts;
}

/**
 * The paragraph for a run, from its event log. What the webhook's
 * `verification.summary` and the run page read.
 */
export function runVerificationSummary(events: WorkflowEvent[]): string {
  return verificationSummary(verificationFactsFromEvents(events));
}
