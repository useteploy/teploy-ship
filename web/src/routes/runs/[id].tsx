import { cancelRun, deliverEvent } from "@neutron-build/workflow";

// PLAN_EVENT comes from the dependency-free plan module: it's used in the
// component (client bundle), where teploy-ship/runtime (node-only) can't go.
import { PLAN_EVENT } from "teploy-ship/plan";
import { costUSD } from "teploy-ship/runtime";
import type { RunMeta } from "teploy-ship/runtime";

import { shipRuntime } from "../../lib/store.server.js";
import { itemClass, runOutcome, toTimeline } from "../../lib/timeline.js";
import type { RunOutcome, TimelineItem } from "../../lib/timeline.js";

export const config = { mode: "app" };

interface RunData {
  meta: RunMeta | null;
  items: TimelineItem[];
  outcome: RunOutcome;
  costUSD: number;
  runId: string;
  eventCount: number;
  /** The agent's proposed plan, when this run is parked on plan approval. */
  plan?: string;
  /** Steerable run (input.steer): show the steer box while active. */
  steerable: boolean;
  /** Steer notes sent but not yet consumed by a turn. */
  steerPending: string[];
}

/** The plan-think step's recorded text ({text, usage} or a bare string). */
function planFrom(events: { type: string; name?: string; data?: unknown }[]): string | undefined {
  const step = events.find((e) => e.type === "step-completed" && e.name === "plan-think");
  if (step === undefined) return undefined;
  const result = (step.data as { result?: unknown } | undefined)?.result;
  if (typeof result === "string") return result;
  const text = (result as { text?: unknown } | undefined)?.text;
  return typeof text === "string" ? text : undefined;
}

export async function loader({ params }: { params: { id: string } }): Promise<RunData> {
  const runtime = await shipRuntime();
  const runId = params.id;
  const [meta, events, ranOn, steerNotes] = await Promise.all([
    runtime.loadMeta(runId),
    runtime.store.load(runId),
    runtime.placement.get(runId),
    runtime.steer.pending(runId).catch(() => []),
  ]);
  if (meta !== null && ranOn !== null) meta.ranOn = ranOn;
  const outcome = runOutcome(events);
  const cost = costUSD(meta?.model ?? "", outcome.usage);
  const started = events.find((e) => e.type === "run-started");
  const steerable =
    (started?.data as { input?: { steer?: boolean } } | undefined)?.input?.steer === true;
  const plan = planFrom(events);
  return {
    meta,
    items: toTimeline(events),
    outcome,
    costUSD: cost,
    runId,
    eventCount: events.length,
    ...(plan !== undefined ? { plan } : {}),
    steerable,
    steerPending: steerNotes.map((n) => n.text),
  };
}

/** A PR reference may be a full URL or a bare number; make it a link when we can. */
function prLink(pr: string, repo?: string): { href?: string; label: string } {
  if (/^https?:\/\//.test(pr)) return { href: pr, label: pr.replace(/^https?:\/\//, "") };
  if (repo !== undefined) {
    const base = repo.replace(/\.git$/, "");
    return { href: `${base}/pulls/${pr}`, label: `PR #${pr}` };
  }
  return { label: `PR #${pr}` };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}): Promise<Response> {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const runtime = await shipRuntime();
  const runId = params.id;
  const meta = await runtime.loadMeta(runId);
  const active = meta !== null && !["completed", "failed", "cancelled"].includes(meta.status);
  if (active && intent === "cancel") {
    await cancelRun(runtime.store, runId, "cancelled from the dashboard").catch(() => {});
    await runtime.markWake?.(runId);
    await runtime.saveMeta({ ...meta, status: "cancelled", updatedAt: new Date().toISOString() });
    return new Response(null, { status: 302, headers: { location: `/runs/${runId}` } });
  }
  // Mid-run steering: queue a note; the run's next turn drains it.
  if (active && intent === "steer") {
    const text = String(form.get("steer") ?? "").trim();
    if (text !== "") await runtime.steer.add(runId, text);
    return new Response(null, { status: 302, headers: { location: `/runs/${runId}` } });
  }
  if (meta?.eventName !== undefined && (intent === "approve" || intent === "deny")) {
    const reason = String(form.get("reason") ?? "").trim();
    // Plan approvals may carry an operator-edited plan (textarea).
    const plan = meta.eventName === PLAN_EVENT ? String(form.get("plan") ?? "").trim() : "";
    await deliverEvent(runtime.store, runId, meta.eventName, {
      approved: intent === "approve",
      ...(reason !== "" ? { reason } : {}),
      ...(plan !== "" ? { plan } : {}),
    });
    // Make the run due; the resident worker carries it from here. The web
    // process never executes the agent.
    await runtime.markWake?.(runId);
    await runtime.saveMeta({ ...meta, status: "wake", updatedAt: new Date().toISOString() });
  }
  return new Response(null, { status: 302, headers: { location: `/runs/${runId}` } });
}

// Poll via the framework's loader-data protocol (X-Neutron-Data): re-runs
// this route's loader and returns its data as JSON. Any change in the
// serialized data (new events, status flip) reloads the page.
// Live updates via the shared SSE helper (scroll preserved). Only mounted for
// an active run — a terminal run's timeline no longer changes.
const POLL = `__shipLive("route:runs/[id].tsx");`;

export default function RunDetail({ data }: { data: RunData }) {
  const active = data.meta !== null && !["completed", "failed", "cancelled"].includes(data.meta.status);
  return (
    <div id="run-root" data-event-count={String(data.eventCount)} data-run-status={data.meta?.status ?? "unknown"}>
      <h1 class="page">
        <a href="/runs">runs</a> / {data.runId}
      </h1>
      {data.meta === null ? (
        <p class="empty">Unknown run.</p>
      ) : (
        <>
          <p class="meta">
            <span class={`status ${data.meta.status}`}>{data.meta.status}</span> · {data.meta.model}
            {data.meta.ranOn !== undefined && <> · ran on {data.meta.ranOn}</>} · updated{" "}
            {data.meta.updatedAt}
          </p>
          {(data.outcome.pr !== undefined || data.outcome.usage !== undefined || data.outcome.repo !== undefined) && (
            <div class="card" style="margin:12px 0">
              <div class="row-actions" style="flex-wrap:wrap;gap:14px">
                {data.outcome.pr !== undefined && (() => {
                  const l = prLink(data.outcome.pr, data.outcome.repo);
                  return <span>→ {l.href !== undefined ? <a href={l.href} target="_blank" rel="noreferrer">{l.label}</a> : l.label}</span>;
                })()}
                {data.outcome.repo !== undefined && (
                  <span class="meta">{data.outcome.repo.replace(/^https?:\/\//, "").replace(/\.git$/, "")}</span>
                )}
                {data.costUSD > 0 && <span class="chip">~${data.costUSD.toFixed(4)}</span>}
                {data.outcome.usage !== undefined && (
                  <span class="meta">
                    {data.outcome.usage.inputTokens} in / {data.outcome.usage.outputTokens} out
                    {data.outcome.usage.cacheReadTokens !== undefined ? ` · ${data.outcome.usage.cacheReadTokens} cache` : ""}
                  </span>
                )}
              </div>
              {data.outcome.summary !== undefined && data.outcome.summary !== "" && (
                <div style="margin-top:8px">{data.outcome.summary}</div>
              )}
            </div>
          )}
          {data.meta.eventName === PLAN_EVENT && (
            <div class="card attn" style="margin:12px 0">
              <div class="kind" style="margin-bottom:8px">Plan review — the run is parked until you decide</div>
              <form method="post">
                <textarea
                  name="plan"
                  rows={Math.min(14, Math.max(4, (data.plan ?? "").split("\n").length + 1))}
                  style="width:100%;box-sizing:border-box;font:inherit"
                >
                  {data.plan ?? ""}
                </textarea>
                <div class="row-actions" style="margin-top:8px">
                  <button class="approve" type="submit" name="intent" value="approve">
                    Approve plan
                  </button>
                  <button class="deny" type="submit" name="intent" value="deny">
                    Deny
                  </button>
                  <span class="meta">edit the text before approving to redirect the plan</span>
                </div>
              </form>
            </div>
          )}
          {(data.meta.eventName !== undefined || active) && (
            <form class="decide" method="post">
              <input type="hidden" name="reason" value="" />
              {data.meta.eventName !== undefined && data.meta.eventName !== PLAN_EVENT && (
                <>
                  <button class="approve" type="submit" name="intent" value="approve">
                    Approve
                  </button>
                  <button class="deny" type="submit" name="intent" value="deny">
                    Deny
                  </button>
                </>
              )}
              {active && (
                <button class="deny" type="submit" name="intent" value="cancel">
                  Cancel run
                </button>
              )}
            </form>
          )}
          {active && data.steerable && (
            <form class="newrun" method="post" style="margin:12px 0">
              <input type="text" name="steer" placeholder='steer the run, e.g. "skip the docs, focus on the parser"' />
              <button type="submit" name="intent" value="steer">
                Steer
              </button>
            </form>
          )}
          {data.steerPending.length > 0 && (
            <p class="meta" style="margin:4px 0 0">
              queued steering (lands on the next turn): {data.steerPending.join(" · ")}
            </p>
          )}
          <ul class="timeline">
            {data.items.map((item, i) => (
              <li key={i} class={itemClass(item.kind)}>
                <div class="kind">
                  {item.title} <span style="float: right">{item.at}</span>
                </div>
                {item.body !== "" && <pre>{item.body}</pre>}
              </li>
            ))}
          </ul>
          {active && <script dangerouslySetInnerHTML={{ __html: POLL }} />}
        </>
      )}
    </div>
  );
}
