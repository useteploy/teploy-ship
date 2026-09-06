/**
 * The verification ladder (C4 / D3): what a project declares it can verify,
 * how far that lets a machine act without a person, and the recorded rungs an
 * unattended merge is judged on.
 *
 * Rungs, in order: baseline -> build -> tests -> preview (deploy + smoke) ->
 * visual (screenshot diff vs main) -> flow (the agent's own browser flow
 * against the preview) -> observe (error-rate window after the preview). A project declares which of them it HAS; the run records which of
 * them RAN and how each ended. Two different facts, and both are kept:
 *
 *   - The declaration caps authority (`authorityCap`). No tests means Ship
 *     can never merge this repo unattended, however trivial the change.
 *   - The recorded rungs gate the merge (`ladderGate`). A declared rung that
 *     was skipped on the day — no preview target on this worker, no browser in
 *     the image — is not evidence, and the gate holds on it.
 *
 * Everything in this file is PURE. The step functions that produce the
 * outcomes live in ladder-steps.ts; this file turns their recorded results
 * into rungs and a verdict, so the same code answers the auto-merge gate
 * inside the run and the webhook builder reading the log afterwards.
 */
import type { ChangeClass } from "./change-class.js";
import type { TestOutcome } from "./tests.js";
import type { WorkflowEvent } from "@neutron-build/workflow";
import { verificationFactsFromEvents } from "./verification-summary.js";

/** Contract 1's `verification` block, camel-cased for the project record. */
export interface ProjectVerification {
  build?: string;
  tests?: string;
  preview?: { app: string; smoke: string };
  visual?: boolean;
  observeWindowMin?: number;
}

/** Contract 1's `authority`, lowest to highest. */
export const AUTHORITIES = ["propose", "send", "auto_trivial", "auto_normal"] as const;
export type Authority = (typeof AUTHORITIES)[number];

export function isAuthority(v: unknown): v is Authority {
  return typeof v === "string" && (AUTHORITIES as readonly string[]).includes(v);
}

/** Trim strings, drop empties, validate the shape. Throws on a half-declared preview. */
export function normalizeVerification(input: ProjectVerification | undefined): ProjectVerification | undefined {
  if (input === undefined || input === null) return undefined;
  const str = (v: unknown): string | undefined => {
    const t = typeof v === "string" ? v.trim() : "";
    return t === "" ? undefined : t;
  };
  const build = str(input.build);
  const tests = str(input.tests);
  const app = str(input.preview?.app);
  const smoke = str(input.preview?.smoke);
  if ((app === undefined) !== (smoke === undefined)) {
    throw new Error("verification.preview needs both app and smoke");
  }
  const window = input.observeWindowMin;
  if (window !== undefined && (!Number.isFinite(window) || window < 0 || !Number.isInteger(window))) {
    throw new Error(`verification.observeWindowMin must be a whole number of minutes, got: ${String(window)}`);
  }
  const out: ProjectVerification = {
    ...(build !== undefined ? { build } : {}),
    ...(tests !== undefined ? { tests } : {}),
    ...(app !== undefined && smoke !== undefined ? { preview: { app, smoke } } : {}),
    ...(input.visual === true ? { visual: true } : {}),
    ...(window !== undefined && window > 0 ? { observeWindowMin: window } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The ladder rule: the rungs a project declares set the highest authority it
 * can hold. No tests -> never past `send`; tests + preview + visual ->
 * `auto_trivial`; every rung -> `auto_normal`. Build is optional at every
 * level (a static site has nothing to build); when declared it must pass.
 */
export function authorityCap(verification: ProjectVerification | undefined): "send" | "auto_trivial" | "auto_normal" {
  if (verification?.tests === undefined) return "send";
  if (verification.preview === undefined || verification.visual !== true) return "send";
  if (verification.observeWindowMin === undefined || verification.observeWindowMin <= 0) return "auto_trivial";
  return "auto_normal";
}

/** The lower of two authorities. */
export function minAuthority(a: Authority, b: Authority): Authority {
  return AUTHORITIES.indexOf(a) <= AUTHORITIES.indexOf(b) ? a : b;
}

/**
 * What a DECLARED project may actually do: its setting, capped by its ladder,
 * floored by `never_auto`. Deliberately does not read the legacy `autoMerge`
 * boolean: a record with nothing authority-shaped declared is on the legacy
 * merge gate (runtime.ts materialises no authority for it), and folding the
 * flag in here would make the cap silently freeze repos whose flag still says
 * on — the behaviour change no record edit asked for.
 */
export function effectiveAuthority(project: {
  authority?: Authority;
  neverAuto?: boolean;
  verification?: ProjectVerification;
}): Authority {
  const asked = project.authority ?? "send";
  const capped = minAuthority(asked, authorityCap(project.verification));
  return project.neverAuto === true ? minAuthority(capped, "send") : capped;
}

export type RungName = "baseline" | "build" | "tests" | "preview" | "visual" | "flow" | "observe";
export type RungStatus = "passed" | "failed" | "skipped";

/** Contract 2's rung: what ran, how it ended, and why in one line. */
export interface Rung {
  name: RungName;
  status: RungStatus;
  detail?: string;
}

export const RUNG_ORDER: readonly RungName[] = ["baseline", "build", "tests", "preview", "visual", "flow", "observe"];

/** What the smoke step recorded. */
export type SmokeOutcome =
  | { kind: "passed"; command: string; durationMs: number }
  | { kind: "failed"; command: string; exitCode: number; output: string }
  | { kind: "errored"; command: string; reason: string }
  | { kind: "skipped"; reason: string };

/**
 * One screenshot the run captured. `url` is the page it shows; `asset`, when
 * present, is where the PNG itself was attached on the pull request, so a
 * reader opens the picture rather than trusting a hash.
 */
export interface Screenshot {
  url: string;
  sha256: string;
  bytes: number;
  asset?: string;
}

/**
 * What the visual step recorded. `pixels` is present when both PNGs decoded
 * at the same size and were compared pixel by pixel (ladder-steps.ts); then
 * `differs` means "more than an anti-aliasing flicker moved". Without it,
 * `differs` is the byte comparison.
 */
export type VisualOutcome =
  | { kind: "captured"; preview: Screenshot; main: Screenshot; differs: boolean; pixels?: { differing: number; total: number } }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

/** One PNG a flow script wrote, named as the script named it (read in order). */
export interface FlowShot {
  name: string;
  sha256: string;
  bytes: number;
  asset?: string;
}

/**
 * What the flow step recorded: the agent-written `.ship/flow.mjs` run
 * against the preview (ladder-steps.ts flowIfPresent). The script is the
 * agent's own claim about the change turned into something a machine ran
 * and a person can look at.
 */
export type FlowOutcome =
  | { kind: "passed"; script: string; durationMs: number; shots: FlowShot[] }
  | { kind: "failed"; script: string; exitCode: number; output: string; shots: FlowShot[] }
  | { kind: "errored"; script: string; reason: string }
  | { kind: "skipped"; reason: string };

/** What the observe window recorded. `rollback` is present whenever the window judged the preview worse. */
export type ObserveOutcome =
  | { kind: "healthy"; windowMin: number; reasons: string[] }
  | { kind: "worse"; windowMin: number; reasons: string[]; rollback: { kind: "rolled-back" | "failed" | "skipped"; detail: string } }
  | { kind: "insufficient"; windowMin: number; reason: string }
  | { kind: "unavailable"; windowMin: number; reason: string }
  | { kind: "disabled"; reason: string };

/** Everything the rungs are derived from: the declaration and the recorded outcomes. */
export interface LadderFacts {
  verification?: ProjectVerification;
  /** True when a test command was available to this run from any source. */
  testsDeclared: boolean;
  baseline?: TestOutcome;
  build?: TestOutcome;
  tests?: TestOutcome;
  /** Structural, not PreviewOutcome: the rungs read kind/url/reason and no more, and the event-log producer holds the narrow shape. Split into three members so narrowing on `kind` works. */
  preview?: { kind: "deployed"; url: string } | { kind: "skipped"; reason: string } | { kind: "failed"; reason: string };
  smoke?: SmokeOutcome;
  visual?: VisualOutcome;
  flow?: FlowOutcome;
  observe?: ObserveOutcome;
}

const DETAIL_LIMIT = 600;

function clip(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= DETAIL_LIMIT ? one : `${one.slice(0, DETAIL_LIMIT - 1)}…`;
}

function suiteRung(name: RungName, outcome: TestOutcome | undefined, undeclared: string): Rung {
  if (outcome === undefined) return { name, status: "skipped", detail: undeclared };
  switch (outcome.kind) {
    case "passed":
      return { name, status: "passed", detail: clip(`${outcome.command} passed in ${Math.round(outcome.durationMs / 1000)}s`) };
    case "failed":
      return { name, status: "failed", detail: clip(`${outcome.command} exited ${outcome.exitCode}: ${outcome.output}`) };
    case "errored":
      return { name, status: "failed", detail: clip(`${outcome.command} could not run: ${outcome.reason}`) };
    case "disabled":
      return { name, status: "skipped", detail: clip(outcome.reason) };
  }
}

/**
 * The rungs, every one of them, in ladder order. A rung that did not run is
 * `skipped` with the reason — never omitted, so a card reading the list can
 * tell "not declared" from "declared and could not run" from "ran and failed".
 */
export function ladderRungs(facts: LadderFacts): Rung[] {
  const v = facts.verification;
  const rungs: Rung[] = [];

  // Baseline: the suite BEFORE the agent edited. It is evidence when it ran at
  // all — a red baseline is what tells inherited breakage from a regression.
  const b = facts.baseline;
  rungs.push(
    b === undefined
      ? { name: "baseline", status: "skipped", detail: "no baseline suite was taken before the agent edited" }
      : b.kind === "passed" || b.kind === "failed"
        ? { name: "baseline", status: "passed", detail: clip(`baseline suite ${b.kind} before the agent edited`) }
        : b.kind === "errored"
          ? { name: "baseline", status: "failed", detail: clip(`baseline suite could not run: ${b.reason}`) }
          : { name: "baseline", status: "skipped", detail: clip(b.reason) },
  );

  rungs.push(suiteRung("build", facts.build, "no build command declared on the project"));
  rungs.push(
    facts.testsDeclared
      ? suiteRung("tests", facts.tests, "the suite did not run for this run")
      : { name: "tests", status: "skipped", detail: "no test command declared on the project" },
  );

  // Preview: the deploy AND the smoke, as one rung. A deployed preview whose
  // smoke failed is a failed preview; a deploy that never happened is skipped
  // with the reason the deploy step recorded.
  if (v?.preview === undefined) {
    rungs.push({ name: "preview", status: "skipped", detail: "no preview app declared on the project" });
  } else if (facts.preview === undefined) {
    rungs.push({ name: "preview", status: "skipped", detail: "the preview step did not run for this run" });
  } else if (facts.preview.kind === "skipped") {
    rungs.push({ name: "preview", status: "skipped", detail: clip(facts.preview.reason) });
  } else if (facts.preview.kind === "failed") {
    rungs.push({ name: "preview", status: "failed", detail: clip(`deploy failed: ${facts.preview.reason}`) });
  } else {
    const s = facts.smoke;
    const url = facts.preview.url;
    rungs.push(
      s === undefined
        ? { name: "preview", status: "skipped", detail: clip(`deployed ${url}; the smoke step did not run`) }
        : s.kind === "passed"
          ? { name: "preview", status: "passed", detail: clip(`deployed ${url}; smoke passed in ${Math.round(s.durationMs / 1000)}s`) }
          : s.kind === "failed"
            ? { name: "preview", status: "failed", detail: clip(`deployed ${url}; smoke exited ${s.exitCode}: ${s.output}`) }
            : s.kind === "errored"
              ? { name: "preview", status: "failed", detail: clip(`deployed ${url}; smoke could not run: ${s.reason}`) }
              : { name: "preview", status: "skipped", detail: clip(`deployed ${url}; smoke skipped: ${s.reason}`) },
    );
  }

  if (v?.visual !== true) {
    rungs.push({ name: "visual", status: "skipped", detail: "visual diff not declared on the project" });
  } else if (facts.visual === undefined) {
    rungs.push({ name: "visual", status: "skipped", detail: "the visual step did not run for this run" });
  } else if (facts.visual.kind === "captured") {
    const c = facts.visual;
    const verdict =
      c.pixels !== undefined
        ? c.differs
          ? `${c.pixels.differing} of ${c.pixels.total} pixels differ`
          : "no pixel differs beyond anti-aliasing"
        : c.differs
          ? "they differ"
          : "identical";
    rungs.push({
      name: "visual",
      status: "passed",
      detail: clip(
        `screenshots captured: preview ${c.preview.url} (${c.preview.bytes} bytes) vs main ${c.main.url} (${c.main.bytes} bytes), ${verdict}` +
          (c.preview.asset !== undefined ? "; attached to the pull request" : ""),
      ),
    });
  } else {
    rungs.push({ name: "visual", status: facts.visual.kind === "failed" ? "failed" : "skipped", detail: clip(facts.visual.reason) });
  }

  // Flow: the agent-written browser flow against the preview. Not declared on
  // the project — the agent writes one when the change has a face — so it
  // never holds a merge by its absence, only by failing.
  if (v?.preview === undefined) {
    rungs.push({ name: "flow", status: "skipped", detail: "no preview app declared on the project, so a flow has nowhere to run" });
  } else if (facts.flow === undefined) {
    rungs.push({ name: "flow", status: "skipped", detail: "the flow step did not run for this run" });
  } else {
    const f = facts.flow;
    rungs.push(
      f.kind === "passed"
        ? {
            name: "flow",
            status: "passed",
            detail: clip(
              `${f.script} passed in ${Math.round(f.durationMs / 1000)}s with ${f.shots.length} screenshot${f.shots.length === 1 ? "" : "s"}` +
                (f.shots.some((sh) => sh.asset !== undefined) ? " attached to the pull request" : ""),
            ),
          }
        : f.kind === "failed"
          ? { name: "flow", status: "failed", detail: clip(`${f.script} exited ${f.exitCode}: ${f.output}`) }
          : f.kind === "errored"
            ? { name: "flow", status: "failed", detail: clip(`${f.script} could not run: ${f.reason}`) }
            : { name: "flow", status: "skipped", detail: clip(f.reason) },
    );
  }

  if (v?.observeWindowMin === undefined || v.observeWindowMin <= 0) {
    rungs.push({ name: "observe", status: "skipped", detail: "no observe window declared on the project" });
  } else if (facts.observe === undefined) {
    rungs.push({ name: "observe", status: "skipped", detail: "the observe step did not run for this run" });
  } else {
    const o = facts.observe;
    rungs.push(
      o.kind === "healthy"
        ? { name: "observe", status: "passed", detail: clip(`${o.windowMin}m window: ${o.reasons.join("; ")}`) }
        : o.kind === "worse"
          ? {
              name: "observe",
              status: "failed",
              detail: clip(`${o.windowMin}m window: ${o.reasons.join("; ")}; preview rollback ${o.rollback.kind}: ${o.rollback.detail}`),
            }
          : o.kind === "disabled"
            ? { name: "observe", status: "skipped", detail: clip(o.reason) }
            : { name: "observe", status: "skipped", detail: clip(`${o.windowMin}m window ${o.kind}: ${o.reason}`) },
    );
  }
  return rungs;
}

/**
 * The pictures a run attached to its pull request, in reading order: the
 * visual pair first, then the flow's screenshots as the script named them.
 * Pure, so the pull request body and the run page list the same links.
 */
export function proofLinks(facts: { visual?: VisualOutcome; flow?: FlowOutcome }): Array<{ name: string; url: string }> {
  const out: Array<{ name: string; url: string }> = [];
  if (facts.visual?.kind === "captured") {
    if (facts.visual.preview.asset !== undefined) out.push({ name: "preview", url: facts.visual.preview.asset });
    if (facts.visual.main.asset !== undefined) out.push({ name: "main", url: facts.visual.main.asset });
  }
  if (facts.flow?.kind === "passed" || facts.flow?.kind === "failed") {
    for (const s of facts.flow.shots) if (s.asset !== undefined) out.push({ name: s.name, url: s.asset });
  }
  return out;
}

/** The rungs a given authority needs to see `passed` before it merges. */
export function requiredRungs(authority: Authority): RungName[] {
  if (authority === "auto_normal") return ["tests", "preview", "visual", "observe"];
  if (authority === "auto_trivial") return ["tests", "preview", "visual"];
  return [];
}

/**
 * May this change merge without a person? Reads ONLY the recorded rungs, the
 * effective authority and the recorded change class — never the critic, never
 * a live re-check. `reasons` says why not, one line per hold, so the
 * `auto-merge` step on the timeline answers "why was this held" in full.
 */
export function ladderGate(facts: {
  rungs: Rung[];
  authority: Authority;
  changeClass?: ChangeClass;
  draft: boolean;
}): { allowed: boolean; reasons: string[] } {
  const held: string[] = [];
  const { authority } = facts;
  if (facts.rungs.length === 0) held.push("no rungs were recorded on this run, so nothing was verified");
  if (authority === "propose" || authority === "send") {
    held.push(`this project's effective authority is ${authority}, which never merges unattended`);
  }
  if (facts.changeClass === undefined) {
    held.push("the change was never classified, so nothing authorises merging it");
  } else if (facts.changeClass === "serious") {
    held.push("the change classified serious, which always waits for a person");
  } else if (facts.changeClass === "normal" && authority !== "auto_normal") {
    held.push(`the change classified normal, and ${authority} merges only trivial changes`);
  }
  if (facts.draft) held.push("the pull request opened as a draft, so a person is expected to read it");
  const byName = new Map(facts.rungs.map((r) => [r.name, r]));
  for (const r of facts.rungs) {
    if (r.status === "failed") held.push(`${r.name} failed: ${r.detail ?? "no detail"}`);
  }
  for (const name of requiredRungs(authority)) {
    const r = byName.get(name);
    if (r === undefined) held.push(`${name} was not recorded on this run`);
    else if (r.status === "skipped") held.push(`${name} did not run: ${r.detail ?? "no detail"}`);
  }
  return held.length > 0 ? { allowed: false, reasons: held } : { allowed: true, reasons: [] };
}

/** Wire form of a rung list, bounded so the whole webhook stays under its cap. */
export function rungsForWire(rungs: Rung[]): Rung[] {
  return rungs.map((r) => ({ name: r.name, status: r.status, ...(r.detail !== undefined ? { detail: clip(r.detail) } : {}) }));
}

/**
 * The rungs of a FINISHED run, from its event log — the producer the webhook
 * and the run page use when there is no workflow object to ask. The twin
 * producer is the recorded `ladder` step (ladder-steps.ts recordLadder),
 * built from the same renderer over the same outcomes; a run that has both
 * must show the same list twice, which is exactly what the test asserts.
 *
 * The observe rung prefers the `observe-window` step (the ladder's own); a
 * run without one that still recorded a `telemetry-check` gets that verdict
 * MAPPED onto the rung — it is the recorded observation the run made, and a
 * card that lists "observe: skipped" beside a real telemetry comparison
 * would understate what happened.
 */
export function ladderRungsFromEvents(events: WorkflowEvent[]): Rung[] {
  const started = events.find((e) => e.type === "run-started");
  const input = (started as { data?: { input?: Record<string, unknown> } } | undefined)?.data?.input;
  const v = normalizeVerification(
    input !== undefined && input.verification !== null && typeof input.verification === "object"
      ? (input.verification as ProjectVerification)
      : undefined,
  );
  const facts = verificationFactsFromEvents(events);
  const testsDeclared =
    (typeof input?.testCommand === "string" && input.testCommand !== "") || v?.tests !== undefined || facts.tests !== undefined;
  return ladderRungs({
    ...(v !== undefined ? { verification: v } : {}),
    testsDeclared,
    ...(facts.baseline !== undefined ? { baseline: facts.baseline } : {}),
    ...(facts.build !== undefined ? { build: facts.build } : {}),
    ...(facts.tests !== undefined ? { tests: facts.tests } : {}),
    ...(facts.preview !== undefined ? { preview: facts.preview } : {}),
    ...(facts.smoke !== undefined ? { smoke: facts.smoke } : {}),
    ...(facts.visual !== undefined ? { visual: facts.visual } : {}),
    ...(facts.flow !== undefined ? { flow: facts.flow } : {}),
    ...(facts.observeWindow !== undefined
      ? { observe: facts.observeWindow }
      : facts.telemetry !== undefined
        ? { observe: observeFromTelemetry(facts.telemetry) }
        : {}),
  });
}

/** The observe rung's outcome, derived from a recorded telemetry verdict. */
function observeFromTelemetry(t: {
  kind: "compared";
  worse: boolean;
} | { kind: "disabled" | "insufficient" | "unavailable"; reason: string }): ObserveOutcome {
  if (t.kind === "compared") {
    return t.worse
      ? { kind: "worse", windowMin: 0, reasons: ["telemetry got worse after the change"], rollback: { kind: "skipped", detail: "the telemetry-check leg judges; it does not act" } }
      : { kind: "healthy", windowMin: 0, reasons: ["telemetry before and after showed no regression"] };
  }
  return { kind: t.kind === "disabled" ? "disabled" : t.kind === "insufficient" ? "insufficient" : "unavailable", windowMin: 0, reason: t.reason };
}
