import { nextRequestId } from "../../views/task-composer.js";
import { taskStatus, taskTitle } from "../../lib/task-status.js";
import { JOURNEYS, parseJourney, journeyOptions } from "teploy-ship/journeys";
import { RichText } from "../../views/rich-text.js";
import { runData } from "../../lib/run-data.server.js";
import type { RunData } from "../../lib/run-data.server.js";
import { useEffect, useState } from "preact/hooks";
import { freshForge, requestWorkspace, threadHistory } from "../../lib/workspace.server.js";
import { submissionIdentity } from "../../lib/submission.server.js";
import { Conversation, Changes, Verification } from "../../views/workspace.js";
import { cancelRun, deliverEvent, actorFromPrincipal, verificationFactsFromEvents, enqueueRun } from "../../lib/ship.server.js";
import { roughDuration } from "../../lib/expect.js";

// PLAN_EVENT comes from the dependency-free plan module: it's used in the
// component (client bundle), where teploy-ship/runtime (node-only) can't go.
import { PLAN_EVENT, MERGE_EVENT } from "teploy-ship/plan";
// Same reason: the ask module is dependency-free, so the component may test
// the park's event name without reaching runtime.ts.
import { isAskEvent } from "teploy-ship/ask";
import { UPGRADE_HOLD_EVENT } from "teploy-ship/fence";


import { shipRuntime } from "../../lib/store.server.js";
import { currentUser } from "../../lib/session.server.js";
import { may } from "../../lib/authority.server.js";
import { itemClass, since, took } from "../../lib/timeline.js";

export const config = { mode: "app" };

// Shared server data must not import a route module: production route transforms
// own its loader export and cannot be used as a resource-handler dependency.
export async function loader(args: { params: { id: string }; request: Request }): Promise<RunData> {
  return runData(args);
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
  // _layout.tsx already gated this by role; this only names who it let through.
  const me = await currentUser(request);
  const runId = params.id;
  const meta = await runtime.loadMeta(runId);
  if (["forge-refresh", "files", "file", "changes"].includes(intent)) {
    if (me === null) return new Response("Not permitted", { status: 403 });
    try {
      await requestWorkspace(runtime, runId, intent === "forge-refresh" ? "forge" : intent === "files" ? "files" : intent === "changes" ? "changes" : "file", me.user, String(form.get("path") ?? "") || undefined);
      return redirectTo(`/runs/${runId}?view=${intent === "forge-refresh" ? "review" : "files"}&pending=1`);
    } catch (e) { return redirectTo(`/runs/${runId}?messageError=${encodeURIComponent(e instanceof Error ? e.message : "Request failed")}`); }
  }
  if (intent === "follow-up") {
    if (!(await may("approve", me))) return redirectTo(`/runs/${runId}?denied=approve`);
    const message = String(form.get("message") ?? "").trim();
    let identity;
    try {
      identity = submissionIdentity(me!.user, `follow-up:${runId}`, form.get("requestId"), {
        message, journey: form.get("journey"), mode: form.get("mode"),
        target: form.get("target"), plan: form.get("plan"), eventName: form.get("eventName"),
      });
      const accepted = await runtime.launches?.get(identity.runId);
      if (accepted) {
        if (accepted.requestHash !== identity.requestIdentity) throw new Error("This request ID already belongs to a different follow-up");
        // Retrying accepted work must not re-resolve mutable project defaults,
        // re-check an already changed forge head, or create another child.
        if (accepted.reviewParent && !(await may("steer", me))) return redirectTo(`/runs/${runId}?denied=steer`);
        await runtime.launches!.publish(accepted);
        return redirectTo(`/runs/${identity.runId}`);
      }
    } catch (error) {
      return redirectTo(`/runs/${runId}?messageError=${encodeURIComponent(error instanceof Error ? error.message : "Could not recover follow-up")}`);
    }
    const reviewing = meta?.status === "waiting" && meta.eventName === MERGE_EVENT;
    if (meta === null || (!reviewing && !["completed", "failed", "cancelled"].includes(meta.status))) return redirectTo(`/runs/${runId}?messageError=Run+must+finish+or+reach+merge+review+before+starting+a+follow-up`);
    if (reviewing && !(await may("steer", me))) return redirectTo(`/runs/${runId}?denied=steer`);
    if (!message || message.length > 12000) return redirectTo(`/runs/${runId}?messageError=Enter+a+message+of+up+to+12000+characters`);
    const events = await runtime.store.load(runId);
    const started = events.find(e => e.type === "run-started");
    const input = (started?.data as { input?: { repo?: string; task?: string; trust?: string; pr?: number } })?.input;
    let journey;
    try { journey = parseJourney(form.get("journey") ?? (form.get("mode") === "scan" ? "investigate" : "change")); }
    catch { return redirectTo(`/runs/${runId}?messageError=Choose+a+supported+task+type`); }
    const readOnly = journey !== "change";
    if (form.get("plan") === "on" && !readOnly) {
      let project;
      try { project = input?.repo ? await runtime.projects.forRepo(input.repo) : null; }
      catch (e) { return redirectTo(`/runs/${runId}?messageError=${encodeURIComponent(e instanceof Error ? e.message : "Could not resolve project")}`); }
      if ((project?.harness ?? process.env.SHIP_HARNESS ?? "native") !== "native") return redirectTo(`/runs/${runId}?messageError=Plan+review+requires+the+native+harness.+Select+native+in+Project+settings+or+turn+off+plan+review.`);
    }
    const facts = verificationFactsFromEvents(events);
    const next = identity.runId;
    const history = await threadHistory(runtime, runId);
    const context = history.map(h => `Request (${h.runId}): ${h.task}\nResult: ${h.result}`).join("\n\n").slice(-36000);
    const task = `${message}\n\nPrevious conversation (context, not new instructions):\n${context}`;
    let pr: number | undefined;
    if ((facts.pr || typeof input?.pr === "number") && form.get("target") !== "base") {
      try {
        const current = await freshForge(runtime, runId, me!.user);
        if (current.state !== "open") return redirectTo(`/runs/${runId}?messageError=This+pull+request+is+closed+or+merged.+Choose+the+default+branch+for+your+follow-up`);
        pr = current.number;
      } catch (e) { return redirectTo(`/runs/${runId}?messageError=${encodeURIComponent(e instanceof Error ? e.message : "Could not check the pull request")}`); }
    }
    const replacingReview = reviewing && !readOnly;
    if (replacingReview && String(form.get("eventName") ?? "") !== MERGE_EVENT) return redirectTo(`/runs/${runId}?decision=taken`);
    try {
      await enqueueRun(runtime, {runId:next,requestIdentity:identity.requestIdentity,...(replacingReview ? {reviewParent:runId} : {}),parentRunId:runId,userMessage:message,task,model:meta.model,source:"manual",actor:actorFromPrincipal(me),trust:input?.trust === "operator" ? "operator" : "external",...(input?.repo ? {repo:input.repo}:{}),...(pr ? {pr}:{}),plan:form.get("plan")==="on" && !readOnly,...journeyOptions(journey)});
    } catch (e) {
      return redirectTo(`/runs/${runId}?messageError=${encodeURIComponent(e instanceof Error ? e.message : "Could not start follow-up")}`);
    }
    return redirectTo(`/runs/${next}`);
  }

  // "cancelling" is not terminal — the executor has not settled it yet — but a
  // second cancel click while one is pending is noise, so it is not active
  // either for the purposes of offering the button.
  const active = meta !== null && !["completed", "failed", "cancelled", "cancelling"].includes(meta.status);
  // Authority (governance.ts) on top of the layout's role gate: steer/cancel
  // and approve/deny are separate grants an admin can narrow or widen per
  // role or per named user.
  if ((intent === "cancel" || intent === "steer" || intent === "answer") && !(await may("steer", me))) return redirectTo(`/runs/${runId}?denied=steer`);
  if ((intent === "approve" || intent === "deny") && !(await may("approve", me))) return redirectTo(`/runs/${runId}?denied=approve`);
  if (active && intent === "cancel") {
    // Only claim what actually happened. The old code swallowed a failed
    // cancelRun and then wrote terminal "cancelled" metadata anyway, so the UI
    // reported a stopped run while the worker kept executing it — and
    // publication could still be in progress.
    try {
      await cancelRun(runtime.store, runId, "cancelled from the dashboard");
    } catch {
      return redirectTo(`/runs/${runId}?cancel=failed`);
    }
    await runtime.markWake?.(runId);
    // "cancelling", not "cancelled": the request is recorded, and the executor
    // settles it at its next checkpoint. The run page shows the difference.
    await runtime.saveMeta({ ...meta, status: "cancelling", updatedAt: new Date().toISOString() });
    return redirectTo(`/runs/${runId}`);
  }
  // Mid-run steering: queue a note; the run's next turn drains it.
  if (active && intent === "steer") {
    const text = String(form.get("steer") ?? "").trim();
    if (text.length > 12000) return redirectTo(`/runs/${runId}?messageError=Message+must+be+under+12000+characters`);
    if (text !== "") await runtime.steer.add(runId, text);
    return redirectTo(`/runs/${runId}?sent=1`);
  }
  // The agent's question (an ```ask park). Answering is steering, not
  // approving: the text becomes the agent's next observation and authorises
  // nothing, so it takes the steer grant. An empty answer is "decide for
  // yourself", delivered as a denial so the transcript says so.
  if (meta?.eventName !== undefined && intent === "answer" && isAskEvent(meta.eventName)) {
    const reviewed = String(form.get("eventName") ?? "");
    if (reviewed === "" || reviewed !== meta.eventName) return redirectTo(`/runs/${runId}?decision=stale`);
    if (!(await runtime.claimDecision(runId, reviewed))) return redirectTo(`/runs/${runId}?decision=taken`);
    const answer = String(form.get("answer") ?? "").trim();
    try {
      await deliverEvent(runtime.store, runId, reviewed, {
        approved: answer !== "",
        ...(answer !== "" ? { answer } : {}),
        ...(me !== null ? { by: actorFromPrincipal(me).id } : {}),
      });
    } catch (error) {
      await runtime.releaseDecision(runId, reviewed).catch(() => {});
      throw error;
    }
    await runtime.markWake?.(runId);
    return redirectTo(`/runs/${runId}`);
  }
  if (meta?.eventName !== undefined && (intent === "approve" || intent === "deny")) {
    if (meta.eventName === UPGRADE_HOLD_EVENT) {
      // The hold reuses the park state, so the stale-check below would MATCH
      // it and the claim+deliver would erase the marker rollback-release
      // reads and append into the log the hold protects. Nothing was decided.
      return redirectTo(`/runs/${runId}?decision=held`);
    }
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
        // Who unblocked it. _layout.tsx already proved they may.
        ...(me !== null ? { by: actorFromPrincipal(me).id } : {}),
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

/** The "Now" line: phase and detail as one sentence a person can scan. */
function nowLine(live: { phase: string; turn?: number; detail?: string }): string {
  const turn = live.turn !== undefined ? `turn ${live.turn}` : "";
  const detail = live.detail ?? "";
  switch (live.phase) {
    case "thinking":
      return `${turn} · the model is deciding the next action`;
    case "running":
      return `${turn} · running ${detail}`.trim();
    case "harness":
      return `external harness · ${turn}${detail !== "" ? ` · ${detail}` : ""}`;
    case "asking":
      return `${turn} · waiting for your answer`;
    case "verifying":
      return `verifying · ${detail}`;
    default:
      return `${live.phase} ${detail}`.trim();
  }
}

// Elapsed counters for the Now card: "for 1m20s" since the phase started and
// the run's total elapsed. Client-side so the loader data — which the live
// reload diffs — does not change every second.
const NOW_TICK = `(function(){
  var el=document.getElementById('now'), out=document.getElementById('now-elapsed'); if(!el||!out) return;
  var since=Date.parse(el.getAttribute('data-updated-at')||''), from=Date.parse(el.getAttribute('data-created-at')||'');
  function fmt(ms){ var s=Math.max(0,Math.floor(ms/1000)); var m=Math.floor(s/60), h=Math.floor(m/60); return h>0 ? h+'h '+(m%60)+'m' : m>0 ? m+'m '+(s%60)+'s' : s+'s'; }
  function tick(){ var now=Date.now(); var a=isNaN(since)?'':'for '+fmt(now-since); var b=isNaN(from)?'':'run elapsed '+fmt(now-from); out.textContent=[a,b].filter(Boolean).join(' · '); }
  tick(); var t=setInterval(tick,1000); if(t.unref) t.unref();
})();`;

/** Severity -> the palette variable already used elsewhere in the dashboard. */
const SEVERITY_COLOR: Record<string, string> = { high: "var(--red)", med: "var(--yellow)", low: "var(--fg-dim, inherit)" };

export default function RunDetail({ data: initialData }: { data: RunData }) {
  const [data, setData] = useState(initialData);
  const [connection, setConnection] = useState("Live updates connected");
  useEffect(() => { setData(initialData); }, [initialData]);
  useEffect(() => {
    let stopped = false, busy = false;
    const controller = new AbortController();
    async function refresh() {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const response = await fetch(`/api/runs/${initialData.runId}/workspace${location.search}`, { signal: controller.signal });
        if (!response.ok) throw new Error("refresh failed");
        const next = await response.json();
        if (!stopped) { setData(next); setConnection("Live updates connected"); }
      } catch { if (!stopped) setConnection("Updates interrupted · retrying"); }
      finally { busy = false; }
    }
    const timer = setInterval(refresh, 4000);
    return () => { stopped = true; controller.abort(); clearInterval(timer); };
  }, [initialData.runId, initialData.view]);
  const [followJourney, setFollowJourney] = useState(data.journey === "plan" ? "plan" : data.isScan ? "investigate" : "change");
 const active = data.meta !== null && !["completed", "failed", "cancelled", "cancelling"].includes(data.meta.status);
  const decision = data.decision;
  return (
    <div id="run-root" data-event-count={String(data.eventCount)} data-run-status={data.meta?.status ?? "unknown"}>
      {decision === "stale" && (
        <p class="card attn" style="margin:12px 0;color:var(--yellow)">
          Not applied — this run moved on to a different decision after the page was loaded. Review the current one below.
        </p>
      )}
      {data.denied !== null && (
        <p class="card attn" style="margin:12px 0;color:var(--red)">
          Not applied — your account may not {data.denied === "steer" ? "steer or cancel runs" : "approve or deny runs"}. An admin can grant it on <a href="/policies">Policies</a>.
        </p>
      )}
      {data.meta?.status === "cancelling" && (
        <p class="card attn" style="margin:12px 0;color:var(--yellow)">
          Cancellation requested — the executor settles it at its next checkpoint.
        </p>
      )}
      {data.cancelFailed && (
        <p class="card attn" style="margin:12px 0;color:var(--red)">
          Cancellation was not recorded — the store rejected it. The run is still going; try again.
        </p>
      )}
      {decision === "taken" && (
        <p class="card attn" style="margin:12px 0;color:var(--yellow)">
          Not applied — someone else decided this one first.
        </p>
      )}
      {decision === "held" && (
        <p class="card attn" style="margin:12px 0;color:var(--yellow)">
          Not applied — this run is held by the upgrade fence, not waiting for a decision. Roll the deployment back
          (the hold releases itself) or cancel the run.
        </p>
      )}
      <p class="meta" role="status">{connection}</p>
      <div class="eyebrow"><a href="/runs">All runs</a> / {data.runId}</div>
      {data.parentRunId && <p class="meta">Continues <a href={`/runs/${encodeURIComponent(data.parentRunId)}`}>{data.parentRunId}</a></p>}
      {data.taskRootRunId && data.taskRootRunId !== data.runId && <p class="meta">Original request: <a href={`/runs/${encodeURIComponent(data.taskRootRunId)}`}>{data.taskRootRunId}</a></p>}
      {data.messageError && <p class="notice bad" role="alert">{data.messageError}</p>}
      <h1 class="page">{data.meta ? taskTitle(data.userMessage ?? data.meta.task) : "Run details"}</h1>
      {data.meta && data.meta.task.length > 110 && <details class="disclosure"><summary>Read the full task</summary><p style="white-space:pre-wrap">{data.userMessage ?? data.meta.task}</p></details>}
      {data.meta === null ? (
        <p class="empty">Unknown run — it may have been removed, or the id is mistyped. <a href="/runs">All runs</a></p>
      ) : (
        <>
          <section class="task-status" aria-label="Task status"><b>{taskStatus(data.meta.status, data.meta.eventName, data.hasPr, data.journey).label}</b><p>{taskStatus(data.meta.status, data.meta.eventName, data.hasPr, data.journey).next}</p><a href="#reply">Continue the conversation</a></section>
          <details class="disclosure"><summary>Execution details</summary><p class="meta">
            <span class={`status ${data.meta.status}`}>{data.meta.status}</span> · {data.meta.model}
            {data.meta.ranOn !== undefined && <> · ran on {data.meta.ranOn}</>} · updated{" "}
            {data.meta.updatedAt}
            {data.typical !== null && (
              <>
                {" "}· typically {roughDuration(data.typical.medianMs)} on this repo
                <span title={`median of ${data.typical.n} completed runs`}> ({data.typical.n} runs)</span>
              </>
            )}
          </p>
          </details>
          {active && data.live !== null && (
            <div class="card" style="margin:12px 0" id="now" data-updated-at={data.live.updatedAt} data-created-at={data.createdAt ?? ""}>
              <div class="kind" style="margin-bottom:6px">
                Now <span class="meta" id="now-elapsed"></span>
              </div>
              <div>{nowLine(data.live)}</div>
              <script dangerouslySetInnerHTML={{ __html: NOW_TICK }} />
            </div>
          )}
          {data.question !== undefined && data.meta.eventName !== undefined && isAskEvent(data.meta.eventName) && (
            <div class="card attn" style="margin:12px 0">
              <div class="kind" style="margin-bottom:8px">The agent has a question — the run is parked until you answer</div>
              <pre style="white-space:pre-wrap;margin:0 0 8px">{data.question}</pre>
              <form method="post">
                <input type="hidden" name="eventName" value={data.meta.eventName} />
                <textarea name="answer" rows={3} style="width:100%;box-sizing:border-box;font:inherit" placeholder="your answer becomes the agent's next observation"></textarea>
                <div class="row-actions" style="margin-top:8px">
                  <button class="approve" type="submit" name="intent" value="answer">
                    Answer
                  </button>
                  <span class="meta">leave it empty and submit to tell the agent to decide for itself</span>
                </div>
              </form>
            </div>
          )}
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
                {data.costUnpriced && (
                  <span class="chip" title="this run consumed a quota Ship cannot price (a subscription login or a cost-less harness); it is counted on the Spend page, not billed as $0">
                    unpriced run
                  </span>
                )}
                {!data.costUnpriced && data.costUSD > 0 && (
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
                <details class="disclosure" style="margin-top:8px"><summary>Run summary</summary><RichText text={data.outcome.summary} /></details>
              )}
            </div>
          )}
          {data.isScan && (!data.journey || data.journey === 'review') && (
            <div class="card" style="margin:12px 0">
              <div class="kind" style="margin-bottom:8px">
                Scan findings{data.findings.length > 0 ? ` (${data.findings.length})` : ""}
              </div>
              {data.findings.length === 0 ? (
                <p class="meta" style="margin:0">
                  {data.findingsNotes.length > 0
                    ? "This scan produced no usable findings."
                    : "No findings reported. A scan publishes nothing, so this is its whole result."}
                </p>
              ) : (
                <ul style="margin:0;padding-left:0;list-style:none">
                  {data.findings.map((f, i) => (
                    <li key={i} style={i === 0 ? "padding:8px 0" : "padding:8px 0;border-top:1px solid var(--line)"}>
                      <div class="row-actions" style="gap:8px;align-items:baseline;flex-wrap:wrap">
                        {/* Colour carries the severity, and the word carries it
                            too — colour alone is not a label. No new CSS class:
                            the stylesheet is not this change's to edit. */}
                        <span class="chip" style={`color:${SEVERITY_COLOR[f.severity]}`}>{f.severity}</span>
                        <strong>{f.title}</strong>
                        <span class="meta">
                          {f.file}
                          {f.line !== undefined ? `:${f.line}` : ""}
                        </span>
                      </div>
                      <div style="margin-top:4px">{f.detail}</div>
                      {f.fix !== undefined && <div class="meta" style="margin-top:4px">Fix: {f.fix}</div>}
                    </li>
                  ))}
                </ul>
              )}
              {data.findingsNotes.length > 0 && (
                <p class="meta" style="margin:8px 0 0">
                  {/* Why entries were dropped. Visible on purpose: a silently
                      shortened findings list is how a scan lies by omission. */}
                  {data.findingsNotes.join(" · ")}
                </p>
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
              {data.meta.eventName === UPGRADE_HOLD_EVENT && (
                <p class="card attn" style="margin:12px 0;color:var(--yellow)">
                  Held by the upgrade fence — this run was enqueued by a build whose workflow step sequence differs
                  from the one now deployed, and replaying it here would break its log. Approving it cannot help: roll
                  the deployment back (the hold releases itself, then <code>teploy-ship resume {data.runId}</code>) or
                  cancel the run.
                </p>
              )}
              {data.meta.eventName !== undefined &&
                data.meta.eventName !== PLAN_EVENT &&
                data.meta.eventName !== UPGRADE_HOLD_EVENT &&
                !isAskEvent(data.meta.eventName) && (
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
          <nav class="settings-nav" aria-label="Run workspace">{['conversation','review','changes','verification','files','activity'].map(view=><a key={view} href={`/runs/${data.runId}?view=${view}`} class={data.view===view?'active':undefined} aria-current={data.view===view?'page':undefined}>{view.charAt(0).toUpperCase()+view.slice(1)}</a>)}</nav>
          {['conversation','review'].includes(data.view) && <div class={data.view === 'review' ? 'run-review-grid' : ''}><div>
            {data.ancestors.map(h => <details class="disclosure"><summary>Earlier: {h.task.slice(0,100)} · {h.runId}</summary><a href={`/runs/${h.runId}`}>Open run</a><Conversation messages={h.messages}/></details>)}
            <div class="conversation-scroll" tabIndex={0} aria-label="Conversation history"><Conversation messages={data.messages} /></div><div id="reply"><RunComposer data={data}/></div>
          </div>{data.view === 'review' && <aside class="review-evidence"><ForgePanel data={data}/><Changes snapshots={data.snapshots} pr={data.evidence.pr} sha={data.evidence.sha}/><Verification data={data.evidence}/></aside>}</div>}
          {data.view === 'files' && <section><h2 class="section">Repository files</h2><details class="disclosure"><summary>Workspace recovery</summary><p class="meta">{data.recovery?.snapshotAt ? `Last recorded snapshot: ${data.recovery.snapshotAt}. Retention has not been checked.` : "No workspace snapshot is recorded."}</p><p class="meta">{data.recovery?.restoredAt ? `Last restored: ${data.recovery.restoredAt}. ${data.recovery.checked ? "Repository validation passed." : "Repository validation was not recorded for this run."}` : "No workspace restore is recorded."}</p>{data.recovery?.warm && <p class="meta">This run uses a warm volume. Container snapshots do not establish recovery of that volume.</p>}</details><p class="meta">Inspect up to 200 tracked file names and the first 10,000 characters of a file at the workspace’s current HEAD. Inspect live changes to see tracked edits and untracked file names. This is a read-only observation while the agent may still be working. Availability depends on sandbox retention.</p><form method="post" class="row-actions"><button name="intent" value="changes">Inspect live changes</button><button name="intent" value="files">List files</button><input name="path" placeholder="src/example.ts" aria-label="Repository file path"/><button name="intent" value="file">Read file</button></form>{data.workspace && <p class="meta">Last inspection: {data.workspace.kind ?? "file"}{data.workspace.path ? ` · ${data.workspace.path}` : ""} · {data.workspace.at}{data.workspace.truncated ? " · partial output" : ""}</p>}{data.workspace?.error && <p class="notice bad">{data.workspace.error}</p>}{data.workspace?.output !== undefined && <pre class="workspace-file">{data.workspace.output}</pre>}<p class="meta">Requests are handled by the worker; refresh to see the result.</p><a href={`/runs/${data.runId}?view=files`}>Refresh files</a></section>}

          {data.view === 'changes' && <ForgePanel data={data}/>}
          {data.view === 'changes' && <Changes snapshots={data.snapshots} pr={data.evidence.pr} sha={data.evidence.sha} />}
          {data.view === 'verification' && <Verification data={data.evidence} />}
          {data.view === 'activity' && <>
          <h2 class="section">Run activity</h2>
          <ul class="timeline" aria-label="Run activity">
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
                          {/* A blocked host is not "exit 128": the operator
                              needs to see WHY on the collapsed row, because
                              this is the run they are scanning for a reason. */}
                          {item.blockedHost !== undefined && <span class="bad">network blocked: {item.blockedHost}</span>}
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
          {data.steps.length > 0 && (() => {
            // The log's index: one row per recorded step, grouped by turn
            // where the steps are turn-scoped. Collapsed by default so it
            // complements the timeline above rather than burying it.
            const firstAt = data.items[0]?.at ?? data.steps[0]!.at;
            return (
              <details class="card" style="margin:12px 0">
                <summary style="cursor:pointer">
                  Recorded steps <span class="count">({data.steps.length})</span>
                </summary>
                <div class="table-wrap"><table class="runs" style="margin-top:8px">
                  <thead>
                    <tr><th>step</th><th>result</th><th style="text-align:right">at</th></tr>
                  </thead>
                  <tbody>
                    {data.steps.flatMap((s, i) => {
                      const group = s.turn !== undefined && s.turn !== data.steps[i - 1]?.turn;
                      return [
                        ...(group
                          ? [
                              <tr key={`turn-${s.turn}`}>
                                <td colSpan={3} class="meta" style="color:var(--dim)">turn {s.turn}</td>
                              </tr>,
                            ]
                          : []),
                        <tr key={`${s.at}-${i}`}>
                          <td class="meta"><code>{s.name}</code></td>
                          <td style={s.failed ? "color:var(--red)" : ""}>{s.summary !== "" ? s.summary : "—"}</td>
                          <td class="meta" style="text-align:right">{since(firstAt, s.at)}</td>
                        </tr>,
                      ];
                    })}
                  </tbody>
                </table></div>
              </details>
            );
          })()}
          </>}

        </>
      )}
    </div>
  );
}

function ForgePanel({ data }: { data: RunData }) {
  const f = data.forge?.forge;
  return <section class="forge-panel"><div class="row-actions"><h2 class="section">Pull request status</h2><form method="post"><button name="intent" value="forge-refresh">Refresh from forge</button></form></div>
    {data.forge?.error && <p class="notice bad">{data.forge.error}</p>}
    {!f ? <p class="meta">The worker checks PR status automatically while this page is open. You can also refresh now. No model credits are used.</p> : <>
      <p><b>#{f.number} · {f.state}{f.draft ? ' · draft' : ''}</b> · {f.title}</p><p class="meta">Checked {f.checkedAt.replace('T',' ').slice(0,19)} UTC · head {f.head.slice(0,12)}</p>
      {data.evidence.sha && f.head !== data.evidence.sha && <p class="notice">The PR has changed since this run’s recorded revision. Recorded results apply to {data.evidence.sha.slice(0,12)}, not the current head.</p>}
      {f.checks.length === 0 && <p class="meta">No CI checks reported.</p>}{f.checks.map(c => <p><b>{c.name}</b> · {c.state}</p>)}
      {f.reviews.map(r => <details class="disclosure"><summary>{r.author} · {r.state}</summary><p>{r.body}</p></details>)}
      {f.warnings.map(w => <p class="meta">{w}</p>)}
    </>}
  </section>;
}

function RunComposer({data}: {data: RunData}) {
 const [followRequestId, setFollowRequestId] = useState(data.followUpRequestId);
 const [followEvent, setFollowEvent] = useState(data.meta?.eventName ?? "");
 const [followPlan, setFollowPlan] = useState(true);

 useEffect(() => {
   const form = document.querySelector<HTMLFormElement>('.message-composer');
   const input = form?.querySelector<HTMLTextAreaElement>('textarea');
   if (!form || !input) return;
   const key = `ship-draft:${data.runId}:${input.name}`;
   try {
     if (new URLSearchParams(location.search).get("created") === "1") sessionStorage.removeItem("ship-new-request");
     if (data.parentRunId) { sessionStorage.removeItem(`ship-draft:${data.parentRunId}:message`); sessionStorage.removeItem(`ship-draft:${data.parentRunId}:message:intent`); }
     if (input.name === "steer" && new URLSearchParams(location.search).get("sent") === "1") sessionStorage.removeItem(key);
     const draft = sessionStorage.getItem(key); if (draft !== null) input.value = draft;
     if (input.name === "message") {
       const raw = sessionStorage.getItem(key + ":intent");
       if (raw) {
         const saved = JSON.parse(raw);
         if (typeof saved.requestId === "string") setFollowRequestId(saved.requestId);
         if (typeof saved.eventName === "string") setFollowEvent(saved.eventName);
         setFollowPlan(saved.plan === "on");
         for (const name of ["target", "journey", "plan"]) {
           const control = form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | null;
           if (!control) continue;
           if (name === "plan") (control as HTMLInputElement).checked = saved.plan === "on";
           else if (typeof saved[name] === "string") control.value = saved[name];
         }
         if (JOURNEYS.some(j => j.id === saved.journey)) setFollowJourney(saved.journey);
       }
     }
   } catch {}
   const save = () => {
     try {
       sessionStorage.setItem(key, input.value);
       if (input.name === "message") {
         const requestId = nextRequestId();
         setFollowRequestId(requestId);
         const fields = new FormData(form);
         sessionStorage.setItem(key + ":intent", JSON.stringify({requestId, eventName:fields.get("eventName"), target:fields.get("target"), journey:fields.get("journey"), plan:fields.get("plan")}));
       }
     } catch {}
   };
   form.addEventListener('input', save);
   form.addEventListener('change', save);
   // Preserve drafts across errors/tab changes; successful sends clear them.
   return () => { form.removeEventListener('input', save); form.removeEventListener('change', save); };
 }, [data.runId, data.meta?.status]);
 const [followJourney, setFollowJourney] = useState(data.journey === "plan" ? "plan" : data.isScan ? "investigate" : "change");
 const active = data.meta !== null && !["completed", "failed", "cancelled", "cancelling"].includes(data.meta.status);
 const reviewing = data.meta?.status === "waiting" && data.meta.eventName === MERGE_EVENT;
 if (!data.meta) return null;
 return <>
          {active && !reviewing && data.steerable && data.canSteer && (
            <form class="message-composer" method="post" style="margin:12px 0">
              <label class="field">Message the agent<textarea name="steer" rows={3} maxLength={12000} required placeholder="Add context, ask a question, or redirect the work." /></label>
              <button type="submit" name="intent" value="steer">
                Send message
              </button>
            </form>
          )}
          {data.steerPending.length > 0 && (
            <p class="meta" style="margin:4px 0 0">
              Messages queued for the next turn: {data.steerPending.join(" · ")}
            </p>
          )}
          {(!active || reviewing && data.canSteer) && data.meta.status !== 'cancelling' && data.canLaunch && <form method="post" class="message-composer"><input type="hidden" name="requestId" value={followRequestId}/><input type="hidden" name="eventName" value={followEvent}/>{reviewing && <p class="notice">Request changes on this PR before merging. A change request cancels this run’s pending merge decision and starts a linked run; the PR stays open. Read-only investigations leave the merge decision pending.</p>}<label class="field">Continue this work<textarea name="message" rows={3} required maxLength={12000} placeholder="What should Ship change or investigate next?" /></label>{data.hasPr && <label class="field">Start from<select name="target"><option value="pr">Existing pull request (checked before launch)</option><option value="base">Current default branch</option></select></label>}<label class="field">What should happen next?<select name="journey" value={followJourney} onChange={e => setFollowJourney(e.currentTarget.value)}>{JOURNEYS.map(j => <option value={j.id}>{j.label}</option>)}</select></label>{followJourney === "change" && data.requirePlanReview && <p class="notice">This project requires plan approval before code changes. The native harness is required; merge and deployment permissions remain separate.</p>}{followJourney === "change" && !data.requirePlanReview && (data.planSupported ? <label class="check-field"><input type="checkbox" name="plan" checked={followPlan} onInput={e => setFollowPlan(e.currentTarget.checked)} />Review the plan before code changes</label> : <p class="meta">This project uses an external harness, which starts work immediately. For plan review, select the native harness in Project settings before launching.</p>)}<button type="submit" name="intent" value="follow-up">Start follow-up</button><p class="meta">Keeps the conversation history and starts a fresh sandbox. The existing pull request is checked with the forge before launch. Current project approvals and budgets apply.</p></form>}

 </>;
}
