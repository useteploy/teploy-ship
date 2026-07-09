import { costUSD } from "./pricing.js";
import type { RunUsage } from "./durable.js";

/**
 * Ship dogfooding into Observe: each completed run is emitted as an LLM event
 * so its model, tokens, cost, and outcome show up in Observe's dashboards
 * alongside everything else you run. Opt-in — a no-op unless OBSERVE_URL and
 * OBSERVE_API_KEY are set — and always fire-and-forget so telemetry never
 * blocks or fails a run.
 *
 *   OBSERVE_URL      https://observe.example.com
 *   OBSERVE_API_KEY  ingest key (maps to a site)
 *   OBSERVE_SITE     optional explicit site id (X-Observe-Site)
 */
export interface ObserveRunEvent {
  runId: string;
  model: string;
  /** Terminal run status: completed | failed | cancelled. */
  status: string;
  usage?: RunUsage;
  repo?: string;
  pr?: number;
  latencyMs?: number;
}

export interface ObserveEmitter {
  emitRun(event: ObserveRunEvent): void;
  readonly enabled: boolean;
}

const NOOP: ObserveEmitter = { emitRun: () => {}, enabled: false };

export function makeObserveEmitter(log: (line: string) => void = () => {}): ObserveEmitter {
  const base = (process.env.OBSERVE_URL ?? "").replace(/\/+$/, "");
  const key = process.env.OBSERVE_API_KEY ?? "";
  if (base === "" || key === "") return NOOP;
  const site = process.env.OBSERVE_SITE ?? "";

  return {
    enabled: true,
    emitRun(event) {
      const provider = event.model.includes("/") ? event.model.split("/")[0]! : "unknown";
      const body = {
        session_id: event.runId,
        span_id: event.runId,
        model: event.model,
        provider,
        operation: "ship.run",
        prompt_tokens: event.usage?.inputTokens ?? 0,
        completion_tokens: event.usage?.outputTokens ?? 0,
        cost_usd: costUSD(event.model, event.usage),
        latency_ms: event.latencyMs ?? 0,
        status: event.status === "completed" ? "ok" : "error",
        error_message: event.status === "completed" ? "" : event.status,
        metadata: {
          source: "teploy-ship",
          ...(event.repo !== undefined ? { repo: event.repo } : {}),
          ...(event.pr !== undefined ? { pr: event.pr } : {}),
        },
      };
      const headers: Record<string, string> = { "content-type": "application/json", "x-api-key": key };
      if (site !== "") headers["x-observe-site"] = site;
      void fetch(`${base}/api/v1/llm/ingest`, { method: "POST", headers, body: JSON.stringify(body) }).catch((err) =>
        log(`[observe] emit ${event.runId} failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    },
  };
}
