import type { AgentExecutor } from "@neutron-build/agents";
import type { WorkflowContext } from "@neutron-build/workflow";

import type { DurableAgentInput } from "./durable.js";
import type { RepoCheckout } from "./git.js";

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
