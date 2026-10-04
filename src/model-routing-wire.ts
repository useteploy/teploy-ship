/**
 * Runtime wiring for model-routing.ts: where the pure policy engine meets a
 * real model call. With `SHIP_MODEL_ROUTING` unset the only code that runs is
 * `routedModelId`'s first line, which returns exactly what `resolveModelId`
 * returned before.
 *
 *   off     nothing here has any effect.
 *   shadow  compute what the policy would have chosen (at the start of a run,
 *           and again whenever a model call fails with a trigger-class error),
 *           append it to the segment log, and change NOTHING: the model used
 *           and the error thrown are the ones that would have happened anyway.
 *   on      the policy picks the model (an explicit `--model` flag still wins:
 *           a user-selected deterministic configuration stays available) and a
 *           permitted fallback is actually called. Fail-closed: an unusable
 *           policy or a route with no eligible candidate refuses to start.
 *
 * Placement: `withRoutedFallback` wraps the adapter OUTSIDE `withRetry`. Retry
 * is "the same model again"; a switch is a different decision and must only be
 * considered once retry has given up, never inside its loop.
 *
 * History: the segment log is a NEW append-only table (ship_model_segments),
 * not a workflow step. Adding a durable step would change the fingerprint of
 * every in-flight run (step-fingerprint.ts) and park the queue; a side table
 * cannot. Rows are only ever inserted; a recorded attempt is never edited, and
 * a fallback is a new row that names the model it replaced.
 *
 * Side effects: `ToolCallJournal` supplies `inFlight.sideEffect`. UNKNOWN IS
 * NOT NONE: with no journal supplied, side effects are treated as uncertain and
 * every switch is refused. At the time of writing nothing in durable.ts feeds a
 * journal, so `on` mode cannot yet switch mid-run in a real worker; `shadow`
 * records that fact on every would-be switch.
 */
import type { ModelAdapter } from "@neutron-build/ai";

import { resolveModelId } from "./model-id.js";
import { nextFallback, selectModel } from "./model-routing.js";
import type { DataClass, Retention, RouteTask, RoutingPolicy, Segment } from "./model-routing.js";
import { classifyFailure, loadRoutingPolicy, routingMode, triggerFor } from "./model-routing-policy.js";
import type { FailureClass, RoutingMode } from "./model-routing-policy.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";

// ---------------------------------------------------------------------------
// Tool-call journal
// ---------------------------------------------------------------------------

export type SideEffect = "none" | "idempotent" | "uncertain";

/** Tools known to change nothing. Everything else is `uncertain` until declared. */
const READ_ONLY_TOOLS = new Set(["read", "grep", "glob", "ls", "cat", "search", "think"]);

export function declaredSideEffect(tool: string): SideEffect {
  return READ_ONLY_TOOLS.has(tool.toLowerCase()) ? "none" : "uncertain";
}

/**
 * What the run has asked the world to do, and whether it knows how that ended.
 * A call that was begun and never ended, or ended with an unknown outcome, may
 * or may not have happened. That is what blocks a switch: replaying it on
 * another model could do it twice.
 */
export class MemoryToolCallJournal {
  #calls: Array<{ tool: string; effect: SideEffect; outcome: "pending" | "ok" | "failed" | "unknown" }> = [];

  begin(tool: string, effect: SideEffect = declaredSideEffect(tool)): number {
    this.#calls.push({ tool, effect, outcome: "pending" });
    return this.#calls.length - 1;
  }

  end(id: number, outcome: "ok" | "failed" | "unknown"): void {
    const call = this.#calls[id];
    if (call !== undefined) call.outcome = outcome;
  }

  /** The most recent call whose outcome is not known, if any. */
  inFlight(): { tool: string; sideEffect: SideEffect } | undefined {
    for (let i = this.#calls.length - 1; i >= 0; i--) {
      const c = this.#calls[i]!;
      if (c.outcome === "pending" || c.outcome === "unknown") return { tool: c.tool, sideEffect: c.effect };
    }
    return undefined;
  }

  /** Did any call with a possible effect end without a known outcome? */
  uncertain(): boolean {
    return this.#calls.some((c) => (c.outcome === "pending" || c.outcome === "unknown") && c.effect === "uncertain");
  }
}

export type ToolCallJournal = Pick<MemoryToolCallJournal, "inFlight" | "uncertain">;

// ---------------------------------------------------------------------------
// Segment log
// ---------------------------------------------------------------------------

export interface SegmentRecord {
  id: string;
  at: string;
  scope: string;
  mode: RoutingMode;
  kind: "selection" | "fallback";
  policyVersion: string;
  policyDigest: string;
  /** The model that actually ran / was already running when this was decided. */
  actualModel: string;
  /** Present when the route succeeded: what the policy chose. */
  segment?: Segment;
  /** Present when the route refused: why. */
  refused?: readonly string[];
  /** True only if this record's choice changed what was run. Never true in shadow. */
  enforced: boolean;
  failure?: { class: FailureClass; trigger: string; message: string };
  note?: string;
}

export interface SegmentSink {
  append(record: SegmentRecord): Promise<void>;
}

export class MemorySegmentSink implements SegmentSink {
  readonly records: SegmentRecord[] = [];
  async append(record: SegmentRecord): Promise<void> {
    this.records.push(structuredClone(record));
  }
}

/** INSERT only. There is deliberately no update or delete method. */
export class NucleusSegmentSink implements SegmentSink {
  #db: NucleusPgwire;
  #ready: Promise<void> | undefined;
  constructor(db: NucleusPgwire) {
    this.#db = db;
  }
  async #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query("CREATE TABLE IF NOT EXISTS ship_model_segments (record_id TEXT, scope TEXT, payload TEXT)")
      .then(() => {})
      .catch((error: unknown) => {
        this.#ready = undefined;
        throw error;
      });
    await this.#ready;
  }
  async append(record: SegmentRecord): Promise<void> {
    await this.#ensure();
    await this.#db.query("INSERT INTO ship_model_segments (record_id,scope,payload) VALUES ($1,$2,$3)", [
      record.id,
      record.scope,
      JSON.stringify(record),
    ]);
  }
  async forScope(scope: string): Promise<SegmentRecord[]> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT payload FROM ship_model_segments WHERE scope=$1", [scope]);
    return rows.map((r) => JSON.parse(String(r.payload)) as SegmentRecord).sort((a, b) => a.id.localeCompare(b.id));
  }
}

// ---------------------------------------------------------------------------
// Task facts from the environment
// ---------------------------------------------------------------------------

const DATA_CLASSES: readonly DataClass[] = ["private", "internal", "public"];
const RETENTIONS: readonly Retention[] = ["none", "short", "long", "unknown"];

const num = (raw: string | undefined, dflt: number): number => {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== "" && Number.isFinite(n) && n > 0 ? n : dflt;
};

/**
 * The facts a route is judged against. Defaults are the CAUTIOUS ones: data is
 * `private` and no destination is allowed unless named, so with no
 * configuration only a candidate whose host/class the operator listed can be
 * chosen. No authority is granted, so a candidate that asks for tools or
 * connections is never eligible.
 */
export function routingTaskFromEnv(env: NodeJS.ProcessEnv = process.env): Omit<RouteTask, "uncertainSideEffects"> {
  const dc = env.SHIP_MODEL_ROUTING_DATA_CLASS?.trim().toLowerCase() as DataClass | undefined;
  const dests = env.SHIP_MODEL_ROUTING_DESTINATIONS?.split(",").map((s) => s.trim()).filter((s) => s !== "");
  const ret = env.SHIP_MODEL_ROUTING_MAX_RETENTION?.trim().toLowerCase() as Retention | undefined;
  const cap = Number(env.SHIP_MAX_RUN_COST_USD);
  return {
    needs: ["tools"],
    contextTokens: num(env.SHIP_MODEL_ROUTING_CONTEXT_TOKENS, 32_000),
    maxOutputTokens: num(env.SHIP_MODEL_ROUTING_MAX_OUTPUT_TOKENS, 8_000),
    dataClass: dc !== undefined && DATA_CLASSES.includes(dc) ? dc : "private",
    ...(dests !== undefined && dests.length > 0 ? { allowedDestinations: dests } : {}),
    ...(ret !== undefined && RETENTIONS.includes(ret) ? { maxRetention: ret } : {}),
    // No per-run cap configured = no budget bound to apply; unknown pricing is
    // still priced at the highest rate, it just has nothing to be compared to.
    reservedBudget: Number.isFinite(cap) && cap > 0 ? cap : Number.POSITIVE_INFINITY,
  };
}

// ---------------------------------------------------------------------------
// Routing handle
// ---------------------------------------------------------------------------

export interface Routing {
  mode: RoutingMode;
  policy: RoutingPolicy;
  digest: string;
  role: string;
  scope: string;
  env: NodeJS.ProcessEnv;
  sink: SegmentSink;
  log: (line: string) => void;
  now: () => Date;
  journal?: ToolCallJournal;
  /** Build an adapter (already retry/timeout wrapped) for a fallback model. Needed for `on`. */
  build?: (modelId: string) => ModelAdapter;
}

export interface RoutingOptions {
  env?: NodeJS.ProcessEnv;
  role?: string;
  scope?: string;
  sink?: SegmentSink;
  log?: (line: string) => void;
  now?: () => Date;
  journal?: ToolCallJournal;
  build?: (modelId: string) => ModelAdapter;
}

/**
 * Resolve the routing configuration, or `undefined` when routing is off or
 * (in shadow) the policy is unusable. `on` with a missing or invalid policy
 * throws: a deployment that asked for enforcement must not quietly run
 * without it.
 */
export function routingFromEnv(options: RoutingOptions = {}): Routing | undefined {
  const env = options.env ?? process.env;
  const mode = routingMode(env);
  if (mode === "off") return undefined;
  const log = options.log ?? (() => {});
  const loaded = loadRoutingPolicy(env);
  if (loaded === undefined || !loaded.ok) {
    const why = loaded === undefined ? "SHIP_MODEL_ROUTING_POLICY is not set" : loaded.errors.join("; ");
    if (mode === "on") throw new Error(`SHIP_MODEL_ROUTING=on but no usable policy: ${why}`);
    log(`[routing] shadow: no usable policy (${why}); nothing recorded`);
    return undefined;
  }
  return {
    mode,
    policy: loaded.policy,
    digest: loaded.digest,
    role: options.role ?? "worker",
    scope: options.scope ?? `proc-${process.pid}`,
    env,
    sink: options.sink ?? { append: async () => {} },
    log,
    now: options.now ?? (() => new Date()),
    ...(options.journal !== undefined ? { journal: options.journal } : {}),
    ...(options.build !== undefined ? { build: options.build } : {}),
  };
}

let seq = 0;

function record(r: Routing, partial: Omit<SegmentRecord, "id" | "at" | "scope" | "mode" | "policyVersion" | "policyDigest">): void {
  const full: SegmentRecord = {
    id: `${r.scope}:${String(++seq).padStart(6, "0")}`,
    at: r.now().toISOString(),
    scope: r.scope,
    mode: r.mode,
    policyVersion: r.policy.version,
    policyDigest: r.digest,
    ...partial,
  };
  r.log(`[routing] ${r.mode} ${full.kind} ${JSON.stringify({ actual: full.actualModel, chose: full.segment?.model, refused: full.refused, enforced: full.enforced })}`);
  // Recording must never fail a run: the log is evidence, not a dependency.
  r.sink.append(full).catch((error: unknown) => {
    r.log(`[routing] could not record ${full.id}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/**
 * The model id a surface runs with. Off: `resolveModelId`, byte for byte.
 * Shadow: the same id, plus a record of what the policy would have picked.
 * On: the policy's pick, unless `--model` was given.
 */
export function routedModelId(
  flag: unknown,
  env: NodeJS.ProcessEnv,
  configModel: string | undefined,
  routing: Routing | undefined,
): string {
  const resolved = resolveModelId(flag, env, configModel);
  if (routing === undefined) return resolved;
  const explicit = typeof flag === "string" && flag !== "";
  const route = selectModel(routing.policy, routing.role, { ...routingTaskFromEnv(routing.env), uncertainSideEffects: false }, { env: routing.env });
  if (routing.mode === "shadow") {
    record(routing, {
      kind: "selection",
      actualModel: resolved,
      enforced: false,
      ...(route.ok ? { segment: route.segment } : { refused: route.reasons }),
    });
    return resolved;
  }
  if (explicit) {
    record(routing, {
      kind: "selection",
      actualModel: resolved,
      enforced: false,
      ...(route.ok ? { segment: route.segment } : { refused: route.reasons }),
      note: "explicit --model flag wins over the policy",
    });
    return resolved;
  }
  if (!route.ok) {
    record(routing, { kind: "selection", actualModel: resolved, enforced: false, refused: route.reasons });
    throw new Error(`model routing refused to start role ${routing.role}: ${route.reasons.join("; ")}`);
  }
  record(routing, { kind: "selection", actualModel: route.segment.model, enforced: true, segment: route.segment });
  return route.segment.model;
}

/**
 * Wrap an adapter (place it OUTSIDE withRetry) so that, once retries are spent,
 * a trigger-class failure is routed through `nextFallback`.
 *
 * Not sticky: a worker shares one adapter across runs, so a switch made for one
 * call must not become the model of the next run. Each failed call is judged
 * on its own, starting from the model this adapter was built for.
 */
export function withRoutedFallback(inner: ModelAdapter, routing: Routing | undefined, currentModel: string): ModelAdapter {
  if (routing === undefined) return inner;
  return {
    ...inner,
    provider: inner.provider,
    modelId: inner.modelId,
    doGenerate: async (opts) => {
      try {
        return await inner.doGenerate(opts);
      } catch (error) {
        // A cancelled call is the operator's decision, not a provider failure.
        if (opts.abortSignal?.aborted === true) throw error;
        const cls = classifyFailure(error);
        const trigger = triggerFor(cls);
        if (trigger === undefined) throw error;
        const journal = routing.journal;
        const inFlight = journal?.inFlight();
        const route = nextFallback(
          routing.policy,
          routing.role,
          { ...routingTaskFromEnv(routing.env), uncertainSideEffects: journal === undefined ? true : journal.uncertain() },
          { model: currentModel, failure: trigger, ...(inFlight !== undefined ? { inFlight } : {}) },
          { env: routing.env },
        );
        const failure = { class: cls, trigger, message: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
        const note = journal === undefined ? "no tool-call journal wired: side effects treated as uncertain" : undefined;
        const enforce = routing.mode === "on" && route.ok && routing.build !== undefined;
        record(routing, {
          kind: "fallback",
          actualModel: currentModel,
          enforced: enforce,
          failure,
          ...(route.ok ? { segment: route.segment } : { refused: route.reasons }),
          ...(note !== undefined ? { note } : {}),
        });
        if (!enforce || !route.ok) throw error;
        return await routing.build!(route.segment.model).doGenerate(opts);
      }
    },
    doStream: inner.doStream.bind(inner),
  } as ModelAdapter;
}
