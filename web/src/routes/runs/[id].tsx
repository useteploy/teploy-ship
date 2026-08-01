import { cancelRun, deliverEvent } from "@neutron-build/workflow";

// PLAN_EVENT comes from the dependency-free plan module: it's used in the
// component (client bundle), where teploy-ship/runtime (node-only) can't go.
import { PLAN_EVENT } from "teploy-ship/plan";
import { costUSD, isPricedModel } from "teploy-ship/runtime";
import type { RunMeta } from "teploy-ship/runtime";

import { shipRuntime } from "../../lib/store.server.js";
import { itemClass, runOutcome, since, took, toTimeline } from "../../lib/timeline.js";
import type { RunOutcome, TimelineItem } from "../../lib/timeline.js";
import { startSpan } from "../../lib/observe.server.js";

export const config = { mode: "app" };

interface RunData {
  meta: RunMeta | null;
  items: TimelineItem[];
  outcome: RunOutcome;
  costUSD: number;
  /** False when the model is absent from the pricing table and the cost is a ceiling, not a price. */
  costPriced: boolean;
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

// This is the one route with an open reliability question (b7d5db3: a run
// page occasionally 500'd with the trigger never pinned down), so it gets a
// trace span in addition to the ErrorBoundary every route already has —
// no-op unless OBSERVE_URL/OBSERVE_API_KEY are set.
export async function loader({ params }: { params: { id: string } }): Promise<RunData> {
  const runId = params.id;
  const span = startSpan("GET /runs/:id", { "run.id": runId });
  try {
    const runtime = await shipRuntime();
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
    const data: RunData = {
      meta,
      items: toTimeline(events),
      outcome,
      costUSD: cost,
      costPriced: isPricedModel(meta?.model ?? ""),
      runId,
      eventCount: events.length,
      ...(plan !== undefined ? { plan } : {}),
      steerable,
      steerPending: steerNotes.map((n) => n.text),
    };
    span.end("ok", { "run.status": meta?.status ?? "unknown", "run.event_count": events.length });
    return data;
  } catch (err) {
    span.end("error");
    throw err;
  }
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

/**
 * GitHub uses /pull/<n> for the human-facing PR page; Forgejo and Gitea use
 * /pulls/<n>. The generic shape 404'd for every GitHub PR Ship linked to.
 */
function prPathSegment(base: string): string {
  return /(^|\/\/)([^/]*\.)?github\.com(\/|$)/.test(base) ? "pull" : "pulls";
}

/** A PR reference may be a full URL or a bare number; make it a link when we can. */
function prLink(pr: string, repo?: string): { href?: string; label: string } {
  if (/^https?:\/\//.test(pr)) return { href: pr, label: pr.replace(/^https?:\/\//, "") };
  if (repo !== undefined) {
    const base = repo.replace(/\.git$/, "");
    return { href: `${base}/${prPathSegment(base)}/${pr}`, label: `PR #${pr}` };
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
    return redirectTo(`/runs/${runId}`);
  }
  // Mid-run steering: queue a note; the run's next turn drains it.
  if (active && intent === "steer") {
    const text = String(form.get("steer") ?? "").trim();
    if (text !== "") await runtime.steer.add(runId, text);
    return redirectTo(`/runs/${runId}`);
  }
  if (meta?.eventName !== undefined && (intent === "approve" || intent === "deny")) {
    // The decision is bound to the park the operator actually looked at. Without
    // this, a tab left open while the run advanced to a DIFFERENT parked action
    // would approve that one instead: the action re-read meta at submit time and
    // delivered to whatever was waiting. Approving is remote code execution, so
    // "whatever is waiting" is not an acceptable target.
    const reviewed = String(form.get("eventName") ?? "");
    if (reviewed === "" || reviewed !== meta.eventName) {
      return redirectTo(`/runs/${runId}?decision=stale`);
    }
    // One winner: the claim clears eventName conditionally, so a second admin
    // submitting the opposite decision on the same park loses here rather than
    // both decisions reaching the run.
    if (!(await runtime.claimDecision(runId, reviewed))) {
      return redirectTo(`/runs/${runId}?decision=taken`);
    }
    const reason = String(form.get("reason") ?? "").trim();
    // Plan approvals may carry an operator-edited plan (textarea).
    const plan = reviewed === PLAN_EVENT ? String(form.get("plan") ?? "").trim() : "";
    try {
      await deliverEvent(runtime.store, runId, reviewed, {
        approved: intent === "approve",
        ...(reason !== "" ? { reason } : {}),
        ...(plan !== "" ? { plan } : {}),
      });
    } catch (error) {
      // The claim already moved the run out of "waiting"; put it back so the
      // decision can be retried rather than leaving a park nobody can answer.
      await runtime.releaseDecision(runId, reviewed).catch(() => {});
      throw error;
    }
    // Make the run due; the resident worker carries it from here. The web
    // process never executes the agent. (claimDecision already recorded the
    // status transition, so there is no second, non-atomic saveMeta.)
    await runtime.markWake?.(runId);
  }
  return redirectTo(`/runs/${runId}`);
}

// Poll via the framework's loader-data protocol (X-Neutron-Data): re-runs
// this route's loader and returns its data as JSON. Any change in the
// serialized data (new events, status flip) reloads the page.
// Live updates via the shared SSE helper (scroll preserved). Only mounted for
// an active run — a terminal run's timeline no longer changes.
const POLL = `__shipLive("route:runs/[id].tsx");`;

export default function RunDetail({ data }: { data: RunData }) {
  const active = data.meta !== null && !["completed", "failed", "cancelled"].includes(data.meta.status);
  const decision = typeof location !== "undefined" ? new URLSearchParams(location.search).get("decision") : null;
  return (
    <div id="run-root" data-event-count={String(data.eventCount)} data-run-status={data.meta?.status ?? "unknown"}>
      {decision === "stale" && (
        <p class="card attn" style="margin:12px 0;color:var(--yellow)">
          Not applied — this run moved on to a different decision after the page was loaded. Review the current one below.
        </p>
      )}
      {decision === "taken" && (
        <p class="card attn" style="margin:12px 0;color:var(--yellow)">
          Not applied — someone else decided this one first.
        </p>
      )}
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
                {data.costUSD > 0 && (
                  <span class="chip" title={data.costPriced ? "estimated from list prices" : "this model is not in the pricing table — upper bound at the highest known rate"}>
                    {data.costPriced ? "~" : "≤"}${data.costUSD.toFixed(4)}
                    {!data.costPriced && <span class="meta"> unpriced</span>}
                  </span>
                )}
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
                {/* Binds this decision to the park being displayed — see the action. */}
                <input type="hidden" name="eventName" value={data.meta.eventName} />
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
              {data.meta.eventName !== undefined && (
                <input type="hidden" name="eventName" value={data.meta.eventName} />
              )}
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
            {data.items.map((item, i) => {
              const elapsed = data.items.length > 0 ? since(data.items[0]!.at, item.at) : "";
              // A turn collapses to one line: what it ran, how it exited, how
              // long it took. The reasoning and the output are one click away
              // rather than always on screen.
              if (item.kind === "turn") {
                return (
                  <li key={i} class="turn">
                    <details>
                      <summary>
                        <span class="turn-name">{item.title}</span>
                        <code class="turn-action">{item.summary !== undefined && item.summary !== "" ? item.summary : "(no action)"}</code>
                        <span class="turn-meta">
                          {item.exitCode !== undefined && (
                            <span class={item.exitCode === 0 ? "ok" : "bad"}>exit {item.exitCode}</span>
                          )}
                          {item.durationMs !== undefined && <span> {took(item.durationMs)}</span>}
                          <span> {elapsed}</span>
                        </span>
                      </summary>
                      {item.thought !== undefined && item.thought !== "" && <pre class="turn-thought">{item.thought}</pre>}
                      {item.body !== "" && <pre>{item.body}</pre>}
                    </details>
                  </li>
                );
              }
              // Long context blobs (the repo briefing, mostly) get the same
              // treatment so they stop burying the run.
              if (item.body.length > 600) {
                return (
                  <li key={i} class={itemClass(item.kind)}>
                    <details>
                      <summary>
                        <span class="turn-name">{item.title}</span>
                        <span class="turn-meta">{item.body.length.toLocaleString()} chars · {elapsed}</span>
                      </summary>
                      <pre>{item.body}</pre>
                    </details>
                  </li>
                );
              }
              return (
                <li key={i} class={itemClass(item.kind)}>
                  <div class="kind">
                    {item.title} <span style="float: right">{elapsed}</span>
                  </div>
                  {item.body !== "" && <pre>{item.body}</pre>}
                </li>
              );
            })}
          </ul>
          {active && <script dangerouslySetInnerHTML={{ __html: POLL }} />}
        </>
      )}
    </div>
  );
}
