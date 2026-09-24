import { nextRequestId } from "../../views/task-composer.js";
import { taskStatus, taskTitle } from "../../lib/task-status.js";
import { JOURNEYS, parseJourney, journeyOptions } from "teploy-ship/journeys";
import { RichText } from "../../views/rich-text.js";
import { runData } from "../../lib/run-data.server.js";
import type { RunData } from "../../lib/run-data.server.js";
import { useEffect, useRef, useState } from "preact/hooks";
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
import { resolveNavUrl, clickPoint } from "../../lib/browser-tab.js";

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
  // Package C: workspace takeover. Intervening in a parked run's workspace is
  // steering-grade authority — it changes what the resumed agent builds on.
  // The worker mediates every operation against the sandbox's lease; this
  // route only records who is asking. Re-checked on every POST, never cached.
  if (
    ["takeover-acquire", "takeover-renew", "takeover-write", "takeover-exec", "takeover-read", "takeover-console", "takeover-browser", "takeover-changes", "takeover-release"].includes(intent)
  ) {
    if (!(await may("steer", me))) return redirectTo(`/runs/${runId}?denied=steer`);
    const tab = String(form.get("tab") ?? "");
    const back = (query: string): Response =>
      redirectTo(`/runs/${runId}?takeover=pending${["console", "editor", "browser", "changes", "handback"].includes(tab) ? `&tab=${tab}` : ""}${query}`);
    try {
      const extra =
        intent === "takeover-write"
          ? { content: String(form.get("content") ?? "") }
          : intent === "takeover-release"
            ? { reason: String(form.get("reason") ?? "").trim() || undefined }
            : intent === "takeover-console"
              ? { command: String(form.get("command") ?? "") }
              : intent === "takeover-browser"
                ? { browser: String(form.get("browser") ?? "") }
                : undefined;
      await requestWorkspace(
        runtime,
        runId,
        intent as "takeover-acquire",
        me!.user,
        intent === "takeover-write" || intent === "takeover-read" ? String(form.get("path") ?? "") || undefined : undefined,
        extra,
      );
      return back("");
    } catch (e) {
      return redirectTo(`/runs/${runId}?messageError=${encodeURIComponent(e instanceof Error ? e.message : "Takeover request failed")}`);
    }
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
              {data.takeover.record !== undefined && <TakeoverDecisionWarning record={data.takeover.record} />}
              <form method="post">
                <input type="hidden" name="eventName" value={data.meta.eventName} />
                <textarea name="answer" rows={3} style="width:100%;box-sizing:border-box;font:inherit" placeholder="your answer becomes the agent's next observation" aria-label="Your answer to the agent's question"></textarea>
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
              {data.takeover.record !== undefined && <TakeoverDecisionWarning record={data.takeover.record} />}
              <form method="post">
                {/* Binds this decision to the park being displayed — see the action. */}
                <input type="hidden" name="eventName" value={data.meta.eventName} />
                <textarea
                  name="plan"
                  aria-label="Plan text — edit before approving to redirect the plan"
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
          <TakeoverCard data={data} />
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
              {data.meta.eventName !== undefined && data.takeover.record !== undefined && (
                <TakeoverDecisionWarning record={data.takeover.record} />
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
            <div class="conversation-scroll" role="region" tabIndex={0} aria-label="Conversation history"><Conversation messages={data.messages} /></div><div id="reply"><RunComposer data={data}/></div>
          </div>{data.view === 'review' && <aside class="review-evidence"><ForgePanel data={data}/><Changes snapshots={data.snapshots} pr={data.evidence.pr} sha={data.evidence.sha}/><Verification data={data.evidence} preview={data.previewPanel}/></aside>}</div>}
          {data.view === 'files' && <section><h2 class="section">Repository files</h2><details class="disclosure"><summary>Workspace recovery</summary><p class="meta">{data.recovery?.snapshotAt ? `Last recorded snapshot: ${data.recovery.snapshotAt}. Retention has not been checked.` : "No workspace snapshot is recorded."}</p><p class="meta">{data.recovery?.restoredAt ? `Last restored: ${data.recovery.restoredAt}. ${data.recovery.checked ? "Repository validation passed." : "Repository validation was not recorded for this run."}` : "No workspace restore is recorded."}</p>{data.recovery?.warm && <p class="meta">This run uses a warm volume. Container snapshots do not establish recovery of that volume.</p>}</details><p class="meta">Inspect up to 200 tracked file names and the first 10,000 characters of a file at the workspace’s current HEAD. Inspect live changes to see tracked edits and untracked file names. This is a read-only observation while the agent may still be working. Availability depends on sandbox retention.</p><form method="post" class="row-actions"><button name="intent" value="changes">Inspect live changes</button><button name="intent" value="files">List files</button><input name="path" placeholder="src/example.ts" aria-label="Repository file path"/><button name="intent" value="file">Read file</button></form>{data.workspace && <p class="meta">Last inspection: {data.workspace.kind ?? "file"}{data.workspace.path ? ` · ${data.workspace.path}` : ""} · {data.workspace.at}{data.workspace.truncated ? " · partial output" : ""}</p>}{data.workspace?.error && <p class="notice bad">{data.workspace.error}</p>}{data.workspace?.output !== undefined && <pre class="workspace-file">{data.workspace.output}</pre>}<p class="meta">Requests are handled by the worker; refresh to see the result.</p><a href={`/runs/${data.runId}?view=files`}>Refresh files</a></section>}

          {data.view === 'changes' && <ForgePanel data={data}/>}
          {data.view === 'changes' && <Changes snapshots={data.snapshots} pr={data.evidence.pr} sha={data.evidence.sha} />}
          {data.view === 'verification' && <Verification data={data.evidence} preview={data.previewPanel} />}
          {data.delivery && data.view === 'verification' && <DeliveryCard data={data} />}
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

/**
 * S12 residual: a held workspace changes what a decision means. Deciding is
 * safe — driveOne holds execution until handback — but the resumed agent
 * builds on the holder's edits, not the tree the decision was reviewed
 * against. Rendered on every decision surface while a lease is live.
 */
function TakeoverDecisionWarning({ record }: { record: NonNullable<RunData["takeover"]["record"]> }) {
  return (
    <p class="notice warn" role="note">
      This run's workspace is currently held by {record.holder} until{" "}
      {record.expiresAt.replace("T", " ").slice(0, 19)} UTC. Deciding now is safe — execution waits
      for handback — but the agent will resume with the holder's edits in the workspace.
    </p>
  );
}

/**
 * Package C: the workspace takeover card. Pause is the run's own park —
 * takeover is offered exactly there, at a decision boundary the resumed
 * agent consumes. The card renders four states and refuses to guess: an
 * offer (parked, unheld, and you may steer), held-by-you (the workspace
 * panel: console, editor, changes, handback), held-by-someone-else, and
 * past sessions. Every button is a worker-mediated lease operation; this
 * page never touches the sandbox.
 */
function TakeoverCard({ data }: { data: RunData }) {
  const t = data.takeover;
  const record = t.record;
  if (record === undefined && !t.available && t.history.length === 0) return null;
  const mine = record !== undefined && record.holder === data.viewer;
  // S12 residual: reconnect honesty. An abandoned lease expires on its own and
  // the sweep moves it to history (outcome "lapsed") with the edits preserved
  // on disk. When the VIEWER's own session lapsed within the last hour, say so
  // instead of silently offering a cold re-acquire. Client-side by design: the
  // 4s refresh re-renders this as the hour window closes.
  const lapsed =
    record === undefined && data.viewer !== null
      ? t.history.filter(
          (s) => s.holder === data.viewer && s.outcome === "lapsed" && Date.now() - Date.parse(s.releasedAt) < 3_600_000,
        ).at(-1)
      : undefined;
  return <section class="card" style="margin:12px 0">
    <div class="row-actions" style="gap:12px;align-items:center">
      <h2 class="section" style="margin:0">Workspace takeover</h2>
      {record !== undefined && (
        <span class="status waiting">{mine ? "held by you" : `held by ${record.holder}`}</span>
      )}
      {record !== undefined && <span class="meta">until {record.expiresAt.replace("T", " ").slice(0, 19)} UTC — every action renews; an abandoned lease expires on its own</span>}
    </div>
    {lapsed !== undefined && (
      <p class="notice warn" role="note">
        Your last takeover lapsed at {lapsed.releasedAt.replace("T", " ").slice(0, 19)} UTC — edits on disk were preserved; take over again to continue.
      </p>
    )}
    {data.takeoverPending && <p class="meta" role="status">Requested — the worker answers within a few seconds. This card refreshes automatically.</p>}
    {!mine && t.reply?.error && <p class="notice bad" role="alert">{t.reply.error}</p>}
    {!mine && t.reply && t.reply.output !== undefined && (
      <details class="disclosure" style="margin-top:8px" open={t.reply.output.startsWith("Wrote ") || t.reply.output.startsWith("Handed")}>
        <summary>Last operation ({t.reply.kind.replace("takeover-", "")}) · {t.reply.at.replace("T", " ").slice(11, 19)} UTC{t.reply.truncated ? " · partial output" : ""}</summary>
        <pre style="white-space:pre-wrap">{t.reply.output}</pre>
      </details>
    )}
    {record === undefined && t.available && (
      <form method="post" style="margin-top:8px">
        <p class="meta" style="margin:0 0 8px">
          The run is parked. Take exclusive writable ownership of its workspace: edit files, run commands,
          then hand back — the resumed agent is told exactly what you changed. Nobody
          else can write while you hold it, and the run waits for your handback.
        </p>
        <button type="submit" name="intent" value="takeover-acquire">Take over the workspace</button>
      </form>
    )}
    {record === undefined && !t.available && t.reason && data.canSteer && (
      <p class="meta" style="margin:8px 0 0">Takeover unavailable: {t.reason}</p>
    )}
    {record !== undefined && mine && <TakeoverPanel data={data} record={record} />}
    {t.history.length > 0 && (
      <details class="disclosure" style="margin-top:10px">
        <summary>Past takeovers ({t.history.length})</summary>
        {t.history.slice().reverse().map((s, i) => (
          <p class="meta" style="margin:6px 0" key={i}>
            {s.holder} · {s.acquiredAt.replace("T", " ").slice(0, 16)} → {s.releasedAt.replace("T", " ").slice(11, 16)} UTC ·{" "}
            <span class={s.outcome === "released" ? "ok" : "bad"}>{s.outcome}</span> ·{" "}
            {s.pathsWritten.length} file(s){s.diffDigest !== undefined ? ` · diff ${s.diffDigest}` : ""}
            {s.note !== undefined && s.note !== "" ? ` · ${s.note}` : ""}
          </p>
        ))}
      </details>
    )}
  </section>;
}

/** Paths out of a `git status --short` listing (the CHANGES tab's output), for the editor's picker. */
function changedPaths(changesOutput: string | undefined): string[] {
  if (changesOutput === undefined) return [];
  const paths: string[] = [];
  for (const line of changesOutput.split("\n")) {
    if (line.startsWith("diff --git ")) break; // the diff body is not a listing
    if (line.length <= 3 || line[2] !== " " || !/[MADRCU?]/.test(line.slice(0, 2))) continue;
    let p = line.slice(3);
    const arrow = p.indexOf(" -> ");
    if (arrow !== -1) p = p.slice(arrow + 4); // renames: the destination is what exists to edit
    if (p !== "" && !paths.includes(p)) paths.push(p);
  }
  return paths.slice(0, 50);
}

/** What the panel renders client-side is bounded too — the server caps output, this caps the DOM. */
const PANEL_OUTPUT_LIMIT = 60_000;

/**
 * The holder's workspace panel (S12): CONSOLE / EDITOR / BROWSER / CHANGES /
 * HANDBACK. Pure reorganization of the card's held-by-you surface onto the
 * same mediated ops — every button still POSTs one workspace request the
 * worker fences. The tab rides the URL (?tab=) so a full-page POST lands the
 * operator back where they were; the 4s poll streams console output and
 * browser screenshots by re-reading the reply.
 */
function TakeoverPanel({ data, record }: { data: RunData; record: NonNullable<RunData["takeover"]["record"]> }) {
  const t = data.takeover;
  const [tab, setTab] = useState<"console" | "editor" | "browser" | "changes" | "handback">(data.takeoverTab);
  const reply = t.reply;
  // ---- Editor state: one file at a time, seeded from takeover-read replies.
  const [editorPath, setEditorPath] = useState("");
  const [editorContent, setEditorContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const seededRef = useRef("");
  const readReply = reply?.kind === "takeover-read" ? reply : undefined;
  useEffect(() => {
    if (readReply !== undefined && readReply.id !== seededRef.current) {
      seededRef.current = readReply.id;
      if (readReply.path !== undefined && readReply.output !== undefined) {
        setEditorPath(readReply.path);
        setEditorContent(readReply.output);
        setSavedContent(readReply.output);
      }
    }
  }, [readReply?.id]);
  const dirty = editorContent !== savedContent;
  const guardUnsaved = (e: { preventDefault: () => void }): void => {
    if (dirty && !window.confirm(`Discard unsaved changes to ${editorPath}?`)) e.preventDefault();
  };
  // ---- After a save lands: re-open the file (editor continuity, verifies the
  // write), and once the content is back, refresh the diff. Sequential on
  // purpose — one request key, one op in flight at a time.
  const postOp = (fields: Record<string, string>): void => {
    void fetch(location.pathname, {
      method: "POST",
      redirect: "manual",
      body: new URLSearchParams(fields),
    }).catch(() => {});
  };
  const afterWriteRef = useRef("");
  const afterReadRef = useRef("");
  useEffect(() => {
    if (reply?.kind === "takeover-write" && reply.id !== afterWriteRef.current) {
      afterWriteRef.current = reply.id;
      if (!dirty && reply.path !== undefined) postOp({ intent: "takeover-read", tab: "editor", path: reply.path });
    }
    if (reply?.kind === "takeover-read" && reply.id !== afterReadRef.current) {
      afterReadRef.current = reply.id;
      if (reply.error === undefined) postOp({ intent: "takeover-changes", tab });
    }
  }, [reply?.id, reply?.kind]);
  const consoleRunning = reply?.kind === "takeover-console" && reply.running === true;
  const consoleOut = reply?.kind === "takeover-console" && reply.output !== undefined
    ? reply.output.slice(-PANEL_OUTPUT_LIMIT)
    : undefined;
  const openForm = useRef<HTMLFormElement>(null);
  const openFile = (path: string): void => {
    if (dirty && !window.confirm(`Discard unsaved changes to ${editorPath}?`)) return;
    const field = openForm.current?.querySelector<HTMLInputElement>('input[name="path"]');
    if (field) field.value = path;
    openForm.current?.requestSubmit();
  };
  const pickerPaths = [...new Set([...record.pathsWritten, ...changedPaths(reply?.kind === "takeover-changes" ? reply.output : undefined)])];
  return <>
    <div class="row-actions" role="tablist" aria-label="Workspace panel" style="margin-top:10px;gap:6px;flex-wrap:wrap">
      {(["console", "editor", "browser", "changes", "handback"] as const).map((k) => (
        <button
          type="button"
          key={k}
          role="tab"
          aria-selected={tab === k ? "true" : "false"}
          onClick={() => setTab(k)}
          style={tab === k ? { fontWeight: "bold" } : undefined}
        >
          {k.toUpperCase()}
        </button>
      ))}
      <form method="post" style="margin-left:auto">
        <input type="hidden" name="tab" value={tab} />
        <button type="submit" name="intent" value="takeover-renew" class="sm">Keep holding</button>
      </form>
    </div>

    {tab === "console" && (
      <div style="margin-top:10px">
        <p class="meta" style="margin:0 0 8px">
          A submitted-command console — one command at a time, output streamed as it runs, bounded. No
          interactive stdin, no TTY: commands that read input cannot be answered here.
        </p>
        {t.testsCommand !== undefined && (
          <form method="post">
            <input type="hidden" name="tab" value="console" />
            <p class="meta" style="margin:0 0 6px">Declared tests command: <code>{t.testsCommand}</code></p>
            <button type="submit" name="intent" value="takeover-exec" disabled={consoleRunning}>Run tests</button>
          </form>
        )}
        <form method="post" class="row-actions" style="margin-top:8px;gap:8px">
          <input type="hidden" name="tab" value="console" />
          <input
            name="command"
            placeholder="pnpm test -- src/foo"
            maxLength={2000}
            required
            style="flex:1;min-width:240px"
            aria-label="Console command"
            disabled={consoleRunning}
          />
          <button type="submit" name="intent" value="takeover-console" disabled={consoleRunning}>Run</button>
        </form>
        {reply?.kind === "takeover-console" && reply.error && <p class="notice bad" role="alert">{reply.error}</p>}
        {consoleOut !== undefined && (
          <pre aria-label="Console output" style="white-space:pre-wrap;margin:8px 0 0;max-height:340px;overflow:auto">{consoleOut}{consoleRunning ? "\n…" : ""}</pre>
        )}
        {reply?.kind === "takeover-console" && reply.truncated && !reply.running && <p class="meta">Output truncated — only the tail is kept.</p>}
        {record.execsRun.length > 0 && (
          <details class="disclosure" style="margin-top:8px">
            <summary>Commands run this session ({record.execsRun.length})</summary>
            {record.execsRun.map((c, i) => <p class="meta" style="margin:4px 0" key={i}><code>{c}</code></p>)}
          </details>
        )}
      </div>
    )}

    {tab === "browser" && <BrowserTab data={data} record={record} />}

    {tab === "editor" && (
      <div style="margin-top:10px">
        <p class="meta" style="margin:0 0 8px">
          Whole-file editor: opens one text file (bounded, no syntax highlighting), saves replace the
          entire file — the same fenced write as before, uncommitted like every takeover edit.
        </p>
        <form method="post" class="row-actions" style="gap:8px;flex-wrap:wrap" ref={openForm} onSubmit={guardUnsaved}>
          <input type="hidden" name="tab" value="editor" />
          <input name="path" placeholder="src/example.ts" required aria-label="Repository file path" style="min-width:220px" />
          <button type="submit" name="intent" value="takeover-read">Open</button>
          {pickerPaths.length > 0 && (
            <span class="row-actions" style="gap:6px;flex-wrap:wrap">
              {pickerPaths.map((p) => (
                <button type="button" class="sm" key={p} title="Open this file" onClick={() => openFile(p)}>{p}</button>
              ))}
            </span>
          )}
        </form>
        {readReply?.error && <p class="notice bad" role="alert">{readReply.error}</p>}
        {editorPath !== "" && (
          <form method="post" style="margin-top:8px" onSubmit={(e) => { if (editorContent.trim() === "") e.preventDefault(); }}>
            <input type="hidden" name="tab" value="editor" />
            <input type="hidden" name="path" value={editorPath} />
            <div class="row-actions" style="gap:8px;align-items:baseline">
              <code>{editorPath}</code>
              {dirty && <span class="meta">unsaved changes</span>}
              {reply?.kind === "takeover-write" && reply.path === editorPath && !dirty && <span class="ok">saved</span>}
            </div>
            <textarea
              name="content"
              value={editorContent}
              onInput={(e) => setEditorContent((e.currentTarget as HTMLTextAreaElement).value)}
              rows={Math.min(24, Math.max(6, editorContent.split("\n").length + 1))}
              maxLength={200000}
              spellcheck={false}
              aria-label={`Content of ${editorPath}`}
              style="width:100%;box-sizing:border-box;margin-top:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:inherit"
            />
            <div class="row-actions" style="margin-top:8px">
              <button type="submit" name="intent" value="takeover-write">Save file</button>
              <span class="meta">replaces the whole file — keep it whole; this slice has no partial edits</span>
            </div>
          </form>
        )}
      </div>
    )}

    {tab === "changes" && (
      <div style="margin-top:10px">
        <form method="post">
          <input type="hidden" name="tab" value="changes" />
          <button type="submit" name="intent" value="takeover-changes">Show my changes</button>
        </form>
        {reply?.kind === "takeover-changes" && reply.error && <p class="notice bad" role="alert">{reply.error}</p>}
        {reply?.kind === "takeover-changes" && reply.output !== undefined && (
          <details class="disclosure" style="margin-top:8px" open>
            <summary>Working-tree changes · {reply.at.replace("T", " ").slice(11, 19)} UTC{reply.truncated ? " · partial output" : ""}</summary>
            <pre style="white-space:pre-wrap">{reply.output.slice(-PANEL_OUTPUT_LIMIT)}</pre>
          </details>
        )}
      </div>
    )}

    {tab === "handback" && (
      <div style="margin-top:10px">
        {record.pathsWritten.length > 0 && (
          <p class="meta" style="margin:0 0 8px">Files written this session: {record.pathsWritten.join(", ")}</p>
        )}
        <form method="post" onSubmit={guardUnsaved}>
          <input type="hidden" name="tab" value="handback" />
          <label class="field">Handback note (given to the agent with your diff)
            <input name="reason" placeholder="what you changed and why — optional" aria-label="Handback note" />
          </label>
          <div class="row-actions" style="margin-top:8px">
            <button type="submit" name="intent" value="takeover-release" class="approve">Hand back to the agent</button>
            <span class="meta">records your diff, releases ownership, and the parked run can proceed</span>
          </div>
        </form>
      </div>
    )}
  </>;
}

/**
 * The BROWSER tab (S12's last surface): a real headless Chromium running in
 * the sandbox, rendered here as a screenshot per action. Plain about what it
 * is — screenshot-driven, not video, not a live stream: every action
 * re-loads the page at the recorded URL and returns one bounded image,
 * picked up by the existing 4s reply poll. The image renders at natural
 * size inside a scrollable box (no CSS scaling), so img-relative click
 * coordinates ARE viewport coordinates; clickPoint guards the degenerate
 * sizes anyway. The nav bar resolves /path against the current page
 * client-side (the worker never guesses a base URL) and refuses non-http(s)
 * schemes with a reason, mirroring the server's guard.
 */
function BrowserTab({ data, record }: { data: RunData; record: NonNullable<RunData["takeover"]["record"]> }) {
  const t = data.takeover;
  const reply = t.reply?.kind === "takeover-browser" ? t.reply : undefined;
  const browser = reply?.browser;
  const lastUrl = browser?.url;
  const [nav, setNav] = useState("");
  const [navError, setNavError] = useState<string | null>(null);
  const [typeText, setTypeText] = useState("");
  const [keyName, setKeyName] = useState("Enter");
  const [vpW, setVpW] = useState(1280);
  const [vpH, setVpH] = useState(800);
  const carrier = useRef<HTMLFormElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const send = (action: Record<string, unknown>): void => {
    const field = carrier.current?.querySelector<HTMLInputElement>('input[name="browser"]');
    if (field) field.value = JSON.stringify(action);
    // Native submit, not requestSubmit: the submit handler resolves the NAV
    // URL and would overwrite the action field this just set.
    carrier.current?.submit();
  };
  const go = (e: { preventDefault: () => void }): void => {
    const resolved = resolveNavUrl(nav, lastUrl);
    if (!resolved.ok) {
      e.preventDefault();
      setNavError(resolved.reason);
      return;
    }
    setNavError(null);
    const field = carrier.current?.querySelector<HTMLInputElement>('input[name="browser"]');
    if (field) field.value = JSON.stringify({ action: "navigate", url: resolved.url });
  };
  const onImageClick = (e: MouseEvent & { currentTarget: HTMLImageElement }): void => {
    const img = imgRef.current;
    if (img === null) return;
    const p = clickPoint(e.offsetX, e.offsetY, img.clientWidth, img.naturalWidth, img.clientHeight, img.naturalHeight);
    if (p !== null) send({ action: "click", x: p.x, y: p.y });
  };
  const close = (): void => {
    if (window.confirm("Close the browser session and wipe its profile (cookies, storage)?"))
      send({ action: "close" });
  };
  return <div style="margin-top:10px">
    <p class="meta" style="margin:0 0 8px">
      A screenshot-driven view of a real headless Chromium running inside this sandbox — not video, not a
      live stream. Each action re-loads the page and returns one bounded image. It reaches only what this
      sandbox's network allows (on a none-tier network: in-sandbox services only — the app under test).
      No credentials persist: the profile is wiped on close and handback.
    </p>
    {/* One form carries every action: hidden intent/tab/browser fields plus the
        visible controls. Go submits through onSubmit (which resolves the URL);
        every other control is type=button and submits programmatically via
        send(), so each action POSTs exactly one mediated takeover-browser
        request with the action JSON in the hidden field. */}
    <form method="post" ref={carrier} onSubmit={go}>
      <input type="hidden" name="intent" value="takeover-browser" />
      <input type="hidden" name="tab" value="browser" />
      <input type="hidden" name="browser" value="" />
      <div class="row-actions" style="gap:8px;flex-wrap:wrap">
        <input
          name="browser-nav"
          value={nav}
          onInput={(e) => setNav((e.currentTarget as HTMLInputElement).value)}
          placeholder="http://localhost:3000 or /path"
          maxLength={2000}
          aria-label="Browser URL"
          style="flex:1;min-width:240px"
        />
        <button type="submit">Go</button>
        {lastUrl !== undefined && (
          <button type="button" class="sm" onClick={() => send({ action: "navigate", url: lastUrl })}>Reload</button>
        )}
      </div>
      <div class="row-actions" style="gap:6px;flex-wrap:wrap;margin-top:8px">
        <input
          name="browser-type"
          value={typeText}
          onInput={(e) => setTypeText((e.currentTarget as HTMLInputElement).value)}
          placeholder="text to type at the page"
          maxLength={2000}
          aria-label="Text to type"
          style="min-width:180px"
        />
        <button type="button" class="sm" onClick={() => { if (typeText !== "") send({ action: "type", text: typeText }); }}>Type</button>
        <input
          name="browser-key"
          value={keyName}
          onInput={(e) => setKeyName((e.currentTarget as HTMLInputElement).value)}
          placeholder="Enter"
          maxLength={24}
          aria-label="Key to press"
          style="width:100px"
        />
        <button type="button" class="sm" onClick={() => { const k = keyName.trim(); if (k !== "") send({ action: "key", key: k }); }}>Press key</button>
        <button type="button" class="sm" onClick={() => send({ action: "scroll", dy: -600 })}>Scroll up</button>
        <button type="button" class="sm" onClick={() => send({ action: "scroll", dy: 600 })}>Scroll down</button>
      </div>
      <div class="row-actions" style="gap:6px;flex-wrap:wrap;margin-top:6px;align-items:baseline">
        <span class="meta">viewport</span>
        <input
          name="browser-vw" type="number" min={240} max={3840} value={vpW}
          onInput={(e) => setVpW(Number((e.currentTarget as HTMLInputElement).value))}
          aria-label="Viewport width" style="width:80px"
        />
        <span class="meta">x</span>
        <input
          name="browser-vh" type="number" min={240} max={4320} value={vpH}
          onInput={(e) => setVpH(Number((e.currentTarget as HTMLInputElement).value))}
          aria-label="Viewport height" style="width:80px"
        />
        <button type="button" class="sm" onClick={() => send({ action: "viewport", w: vpW, h: vpH })}>Set</button>
        <button type="button" class="sm" onClick={close}>Close browser</button>
      </div>
    </form>
    {navError !== null && <p class="notice bad" role="alert">{navError}</p>}
    {reply?.error && <p class="notice bad" role="alert">{reply.error}</p>}
    {browser?.artifact !== undefined && (
      <div style="margin-top:8px;overflow:auto;max-height:520px;border:1px solid var(--line)">
        <img
          ref={imgRef}
          src={`/api/artifacts/${browser.artifact}`}
          width={browser.width}
          height={browser.height}
          alt="Screenshot of the in-sandbox browser"
          style="display:block;cursor:crosshair"
          onClick={onImageClick}
        />
      </div>
    )}
    {reply?.output !== undefined && (
      <p class="meta" style="margin:6px 0 0">{reply.output}{browser?.artifact === undefined && " — navigate to a page to see it."}</p>
    )}
    {(record.browserOps?.length ?? 0) > 0 && (
      <details class="disclosure" style="margin-top:8px">
        <summary>Browser actions this session ({record.browserOps!.length})</summary>
        {record.browserOps!.map((c, i) => <p class="meta" style="margin:4px 0" key={i}><code>{c}</code></p>)}
      </details>
    )}
  </div>;
}

/**
 * The merged change's delivery card (Package B, S14): what merged, from the
 * recorded steps, and — for an operator with the approve authority — the
 * explicit promotion approval: a destination and the retained recovery
 * version, both required, both recorded. Approving deploys nothing by
 * itself; the worker's delivery sweep executes approved records, and only
 * against a configured trusted working copy.
 */
function DeliveryCard({ data }: { data: RunData }) {
  const d = data.delivery!;
  return <section class="card" style="margin-top:18px">
    <div class="row-actions" style="gap:12px;align-items:center">
      <h2 class="section" style="margin:0">Delivery</h2>
      <span class={`status ${d.state === "confirmed" ? "completed" : d.state === "proposed" ? "waiting" : d.state === "approved" || d.state === "executing" || d.state === "unknown" ? "held" : "failed"}`}>{d.state}</span>
      <span class="meta">merged change</span>
    </div>
    <table style="margin-top:10px">
      <tbody>
        {d.repo && <tr><td class="meta">repository</td><td><code>{d.repo}</code></td></tr>}
        {d.mergedSha && <tr><td class="meta">merged SHA</td><td><code>{d.mergedSha.slice(0, 12)}</code></td></tr>}
        {d.reviewedHead && <tr><td class="meta">reviewed head</td><td><code>{d.reviewedHead.slice(0, 12)}</code></td></tr>}
        {d.destination && <tr><td class="meta">destination</td><td><code>{d.destination}</code></td></tr>}
        {d.recoveryVersion && <tr><td class="meta">recovery version</td><td><code>{d.recoveryVersion}</code></td></tr>}
        {d.artifactDigest && <tr><td class="meta">artifact</td><td><code>{d.artifactDigest}</code></td></tr>}
        {d.actor && <tr><td class="meta">approved by</td><td>{d.actor}</td></tr>}
        {d.health && <tr><td class="meta">health</td><td><span>{d.health}</span>{d.healthReason ? <span class="meta"> — {d.healthReason}</span> : null}</td></tr>}
        {d.rollback && <tr><td class="meta">rollback</td><td><code>{d.rollback.state}</code> by {d.rollback.actor}{d.rollback.evidence ? <span class="meta"> — {d.rollback.evidence}</span> : null}</td></tr>}
      </tbody>
    </table>
    {d.reason && <p class="meta" style="margin-top:8px">{d.reason}</p>}
    {data.deliveryError && <p class="notice bad" role="alert">{data.deliveryError}</p>}
    {(d.state === "proposed" || d.state === "held" || d.state === "failed") && data.canLaunch && (
      <form method="post" action={`/api/runs/${data.runId}/promote`} style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;margin-top:12px">
        <label class="meta" for="delivery-destination">Destination</label>
        <input id="delivery-destination" name="destination" required placeholder="e.g. scratch-infra-home-7471" style="min-width:220px"/>
        <label class="meta" for="delivery-recovery">Retained recovery version</label>
        <input id="delivery-recovery" name="recoveryVersion" required placeholder="current version to roll back to" style="min-width:220px"/>
        <label class="meta" for="delivery-reason">Reason</label>
        <input id="delivery-reason" name="reason" placeholder="why this promotion" style="min-width:220px"/>
        <button type="submit" class="sm">{d.state === "proposed" ? "Approve promotion" : "Re-approve promotion"}</button>
      </form>
    )}
    {(d.state === "proposed" || d.state === "held" || d.state === "failed") && !data.canLaunch && <p class="meta">Approving a promotion needs the approve authority.</p>}
    {d.state === "confirmed" && d.recoveryVersion && (!d.rollback || d.rollback.state === "failed") && data.canLaunch && (
      <form method="post" action={`/api/runs/${data.runId}/rollback-delivery`} style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;margin-top:12px">
        <label class="meta" for="rollback-reason">Rollback reason</label>
        <input id="rollback-reason" name="rollbackReason" required placeholder="the recovery plan being followed" style="min-width:260px"/>
        <button type="submit" class="sm">Roll back to {d.recoveryVersion}</button>
        {d.rollback?.state === "failed" && <p class="meta" style="width:100%">Previous rollback attempt failed: {d.rollback.evidence}</p>}
      </form>
    )}
    <p class="meta" style="margin-top:8px">Approval records intent against this exact tuple; deployment happens from the worker's trusted working copy and rolls back only to the retained version.</p>
  </section>;
}
