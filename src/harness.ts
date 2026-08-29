import type { AgentExecutor } from "@neutron-build/agents";
import type { WorkflowContext } from "@neutron-build/workflow";

import type { DurableAgentInput } from "./durable.js";
import type { RepoCheckout } from "./git.js";
import type { TestOutcome } from "./tests.js";

/**
 * The harness adapter boundary (P5-1, `_internal/P5-1_ADAPTER_DESIGN.md`).
 *
 * Given a task, a workspace and a budget, an adapter produces an edited working
 * tree and a claim about it. Everything Ship sells sits OUTSIDE this interface
 * and is not the adapter's to touch: the event log and step recording, the
 * publish gate, the evidence legs, spend governance, intake/policies/approvals,
 * and the replay contract. An adapter runs all of its I/O inside the executor
 * it is handed, the way the native loop does, and reports coarse progress.
 *
 * The adapter selection is a capability of the run, so it rides in the run
 * INPUT at enqueue (`DurableAgentInput.harness`) like steer/index/critic do:
 * changing the harness under an in-flight run is exactly as impossible as
 * changing its step sequence. A run with no `harness` field is a native run —
 * every log written before this existed replays unchanged.
 */

/** What a run records about the harness that executed it. */
export interface HarnessRef {
  id: string;
  /**
   * The adapter's own contract version. A replay under an adapter whose
   * version differs from the recorded one is refused rather than re-run: the
   * recorded steps were written by a different program.
   */
  version: string;
}

export const NATIVE_HARNESS_ID = "native";

export interface HarnessTask {
  /** The prompt the harness works from — task text already framed with repo context. */
  prompt: string;
  /** The raw task text as the operator wrote it (untrusted when the run is external). */
  task: string;
  repo?: string;
  baseBranch?: string;
  /**
   * The project's suite, run before the agent edited anything (C4).
   *
   * Only the native loop reads it, and only to decide whether a red suite at
   * finish time is this run's doing. Absent means "no baseline was taken", in
   * which case a red suite is treated as the run's problem — the conservative
   * default, and what every run before C4 did.
   */
  testsBaseline?: TestOutcome;
  /**
   * The recorded run input. The native loop's capabilities (plan, steer,
   * critic, recovery, requireEdit, ...) are input-gated for replay safety and
   * it reads them from here; external adapters read nothing but `prompt`.
   */
  input: DurableAgentInput;
}

export interface HarnessBudget {
  maxSteps: number;
  /** 0 = no per-run ceiling. */
  maxRunCostUSD: number;
}

/**
 * Coarse progress. The native loop's fine-grained steps are its own; an
 * external harness reports started / turn / completed and nothing Ship would
 * mistake for evidence.
 */
export type HarnessEvent =
  | { kind: "started"; harness: string }
  | { kind: "turn"; turn: number }
  | { kind: "completed"; status: HarnessStatus };

export type HarnessStatus =
  | "finished"
  | "max-steps"
  | "plan-rejected"
  | "budget-exhausted"
  | "stuck"
  | "settled"
  | "error";

export interface HarnessUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /**
   * False when the work consumed a quota Ship cannot price — a subscription-
   * fed harness, typically. Absent means priced (every log written before this
   * existed is a priced native run). Ship never reports $0 for an unpriced
   * run; it counts the run instead (P5-3).
   */
  priced?: boolean;
  /** The harness's own dollar figure, when it reports one and it is priced. */
  costUSD?: number;
}

export interface HarnessResult {
  status: HarnessStatus;
  summary: string;
  turns: number;
  usage: HarnessUsage;
  /**
   * The work stopped at a limit rather than at a finish, so it publishes as
   * an incomplete (draft/WIP) pull request.
   */
  incomplete: boolean;
  /**
   * A suite result the harness already produced over the tree it is handing
   * back, when nothing touched that tree afterwards — the critic pass runs the
   * suite so the reviewer can see it, and the publish gate reuses the outcome
   * rather than running a minutes-long suite twice over identical bytes.
   *
   * Absent means "no suite result you can trust for this tree", which is the
   * safe default: the publish gate then runs it itself.
   */
  evidence?: TestOutcome;
  /** Red finishes the loop sent back to work with the failure output (input.fixRetries). */
  fixAttempts?: number;
  /** The attempts ran out with the suite still red; the failure is recorded on a step. */
  fixExhausted?: { attempts: number; exitCode: number };
  /** The critic's advisory verdict (input.criticAdvisory), for the PR body and the run output. */
  critic?: { approved: boolean; notes: string };
}

/**
 * The workspace an attempt executes in. `handle` and `executor` are MUTABLE:
 * the native loop replaces them when it restores from a snapshot after an
 * approval park, and the publish gate must then use the restored workspace.
 */
export interface HarnessWorkspace {
  ctx: WorkflowContext;
  handle: string;
  executor: AgentExecutor;
  /** The agent's working directory inside the executor. */
  workdir: string;
  checkout: RepoCheckout | null;
  /** Code-index / memory scope key, or null when the run has none. */
  scopeKey: string | null;
  /**
   * Prefix for every recorded step the attempt writes. Empty for a single
   * attempt — the native loop's step names are then byte-identical to every
   * log written before the adapter existed. Multi-harness attempts (P5-4)
   * get `attempt-N-`.
   */
  stepPrefix: string;
}

export interface HarnessAdapter {
  readonly id: string;
  readonly version: string;
  /**
   * Does every command the adapter runs execute inside the executor it is
   * handed? True for the native loop and for the external adapters, which
   * exec the vendor binary in the sandbox. An adapter that reaches the host
   * must say false — a run whose task came from outside will not execute on
   * it (the same honesty rule as ExecutorProvider.isolated).
   */
  readonly isolated: boolean;
  run(
    task: HarnessTask,
    workspace: HarnessWorkspace,
    budget: HarnessBudget,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<HarnessResult>;
}

/**
 * Known adapters and their contract versions — what `enqueueRun` materialises
 * into a run's input from `SHIP_HARNESS`. The registry a worker actually
 * carries may be narrower (an adapter needs its binary in the sandbox image);
 * a run naming an adapter the executing worker lacks fails with a clear
 * message rather than silently running native.
 */
export const HARNESS_VERSIONS: Record<string, string> = {
  [NATIVE_HARNESS_ID]: "1",
  "claude-code": "1",
  opencode: "1",
};

/** The vendor binary an external adapter drives, at the version Ship bakes. */
export interface HarnessPackage {
  /** npm package name. */
  npm: string;
  /** Exact version baked into the sandbox image. Never a range. */
  version: string;
  /** Executable name on PATH inside the sandbox. */
  binary: string;
}

/**
 * What the sandbox images install, per harness id — the DECLARE half of
 * declare-then-bake (B5).
 *
 * Mirrors `images/versions.json`, which `images/build.sh` reads; a test in
 * harness.test.ts fails if the two drift, so there is one source of truth with
 * a copy the TypeScript can actually reach at run time.
 *
 * BAKED, never installed per run. Two structural reasons:
 *
 *   1. Installing at run time needs the sandbox to reach npm, which is the
 *      egress hole the default-deny sandbox exists to close (docs/DEPLOY.md).
 *   2. `selectAdapter` below refuses to replay a run under a harness version
 *      other than the one its log recorded. A binary resolved at run time
 *      drifts under a running worker; drift breaks replay.
 *
 * NATIVE has no entry: Ship's own loop needs nothing in the image.
 */
export const HARNESS_PACKAGES: Record<string, HarnessPackage> = {
  "claude-code": { npm: "@anthropic-ai/claude-code", version: "2.1.246", binary: "claude" },
  opencode: { npm: "opencode-ai", version: "1.18.23", binary: "opencode" },
};

/**
 * The harness ids an operator may declare on a project record or in
 * SHIP_HARNESS — every adapter id, native included.
 */
export const HARNESS_IDS: readonly string[] = Object.keys(HARNESS_VERSIONS);

/**
 * The npm specs `images/build.sh` installs for a set of declared ids, in the
 * order given. Exported so the docs, the dashboard and the build script cannot
 * disagree about what "declaring claude-code" actually installs.
 */
export function harnessSpecs(ids: readonly string[]): string[] {
  return ids.flatMap((id) => {
    const pkg = HARNESS_PACKAGES[id];
    return pkg === undefined ? [] : [`${pkg.npm}@${pkg.version}`];
  });
}

/** Resolve a harness id (from config) to the ref a run records. */
export function harnessRef(id: string | undefined): HarnessRef {
  const key = (id ?? "").trim() === "" ? NATIVE_HARNESS_ID : id!.trim();
  const version = HARNESS_VERSIONS[key];
  if (version === undefined) {
    throw new Error(`unknown harness "${key}" (SHIP_HARNESS); known: ${Object.keys(HARNESS_VERSIONS).join(", ")}`);
  }
  return { id: key, version };
}

/**
 * Parse `SHIP_HARNESS_ATTEMPTS` — a comma list of adapter ids the run tries
 * in turn, the critic picking the winner (P5-4). Empty or a single id means
 * no multi-attempt run. Duplicates are refused: N copies of one loop is the
 * shape the measurements argue against.
 */
export function harnessAttempts(raw: string | undefined): HarnessRef[] {
  const ids = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (ids.length < 2) return [];
  if (new Set(ids).size !== ids.length) {
    throw new Error(`SHIP_HARNESS_ATTEMPTS lists a harness twice: ${raw}`);
  }
  return ids.map((id) => harnessRef(id));
}

/**
 * Pick the adapter a recorded input asks for. Absent = native. Unknown or a
 * version other than the one the log recorded is refused, never substituted:
 * the recorded steps belong to that program.
 */
export function selectAdapter(adapters: readonly HarnessAdapter[], ref: HarnessRef | undefined): HarnessAdapter {
  const want = ref ?? { id: NATIVE_HARNESS_ID, version: HARNESS_VERSIONS[NATIVE_HARNESS_ID]! };
  const adapter = adapters.find((a) => a.id === want.id);
  if (adapter === undefined) {
    throw new Error(
      `this run was enqueued for harness "${want.id}" but the executing worker has no such adapter (available: ${adapters.map((a) => a.id).join(", ")})`,
    );
  }
  if (adapter.version !== want.version) {
    throw new Error(
      `this run was recorded under harness ${want.id}@${want.version}; the executing worker carries ${adapter.id}@${adapter.version} and refuses to replay under a different program`,
    );
  }
  return adapter;
}
