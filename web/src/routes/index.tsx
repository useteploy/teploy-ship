import { submissionIdentity } from "../lib/submission.server.js";
import { TaskComposer, type TaskProject } from "../views/task-composer.js";
import { JOURNEYS, intakeJourney, parseJourney, journeyOptions, type Journey } from "teploy-ship/journeys";
import { workflows } from "../lib/workflows.server.js";
import type { WorkflowTemplate } from "../lib/workflows.server.js";
import { randomUUID } from "node:crypto";

import { deliverEvent, enqueueRun, actorFromPrincipal, intakeActor } from "../lib/ship.server.js";
import type { RunMeta } from "teploy-ship/runtime";
import type { IntakeTask } from "teploy-ship/runtime";

import { defaultModel, shipRuntime } from "../lib/store.server.js";
import { redirect } from "../lib/http.server.js";
import { currentUser } from "../lib/session.server.js";
import { may } from "../lib/authority.server.js";

export const config = { mode: "app" };

interface InboxData {
  template?: WorkflowTemplate;
  selectedRepo: string;
  /** Runs parked on an approval — the top priority. */
  parked: RunMeta[];
  recentRequests: Array<IntakeTask & { runVisible: boolean }>;
  pendingLaunches: IntakeTask[];
  /** Proposed intake tasks awaiting a launch/dismiss decision. */
  proposed: IntakeTask[];
  store: string;
  model: string;
  projects: TaskProject[];
  canLaunch: boolean;
  canRequest: boolean;
  requestId: string;
  submitted: string | null;
  error: string | null;
  /** ?decision=taken — the operator's approve/deny lost the race to another one. */
  decisionTaken: boolean;
  /** ?denied=approve — this account lacks the approve authority. */
  denied: boolean;
}

// "cancelling" is a request in flight, not an outcome.
const TERMINAL = ["completed", "failed", "cancelled"];

export async function loader({ request }: { request: Request }): Promise<InboxData> {
  const runtime = await shipRuntime();
  const query = new URL(request.url).searchParams;
  const decisionTaken = query.get("decision") === "taken";
  const denied = query.get("denied") === "approve";
  const [runs, proposed, projects] = await Promise.all([runtime.listMeta(), runtime.intake.list("proposed"), runtime.projects.list()]);
  const me = await currentUser(request);
  const canLaunch = await may("approve", me);
  const allTasks = await runtime.intake.list();
  const runPresence = new Map(runs.map(run => [run.runId,true]));
  const launched = allTasks.filter(t => t.state === "launched" && t.runId && (canLaunch || t.requestedBy === me?.user));
  const unknown = [...new Set(launched.map(t => t.runId!))].filter(id => !runPresence.has(id));
  // Bound concurrent reads, not which requests are eligible for recovery.
  // A first-100 cutoff could hide an older interrupted launch forever.
  for (let i=0;i<unknown.length;i+=4) await Promise.all(unknown.slice(i,i+4).map(async id => {
    runPresence.set(id, await runtime.loadMeta(id) !== null);
  }));
  const pendingLaunches = canLaunch ? launched.filter(t => runPresence.get(t.runId!) === false) : [];
  const recentRequests = allTasks.filter(t => t.source === "team-request" && t.state !== "proposed" && (canLaunch || t.requestedBy === me?.user)).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12).map(t => ({...t,runVisible: !!t.runId && runPresence.get(t.runId) === true}));
  const parked = runs.filter((r) => r.status === "waiting" && r.eventName !== undefined);
  return { template: (await workflows(runtime)).find(t=>t.id===query.get("workflow")), selectedRepo: query.get("repo") ?? "", canLaunch, canRequest: me?.role === "admin" || me?.role === "editor", requestId: randomUUID(), submitted: query.get("submitted"), error: query.get("error"), projects: projects.filter(p => !!p.url).map(p => ({ url: p.url ?? p.repo, label: p.label ?? p.repo, requirePlanReview: p.requirePlanReview === true, planSupported: (p.harness ?? process.env.SHIP_HARNESS ?? "native") === "native" })), parked, recentRequests, pendingLaunches, proposed, store: runtime.kind, model: defaultModel(), decisionTaken, denied };
}

export async function action({ request }: { request: Request }): Promise<Response> {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "new-run");
  const runtime = await shipRuntime();
  // _layout.tsx has already gated the request by role; this only names the
  // person it let through. Never null in practice for a mutation, but an
  // unattributable run is legal (see actor.ts) rather than a 500.
  const me = await currentUser(request);

  // Deciding a park and launching a proposed task both authorise code
  // execution and spend: the `approve` grant (governance.ts), deny by default.
  if ((intent === "approve" || intent === "deny" || intent === "launch-task" || intent === "retry-task" || intent === "dismiss-task" || intent === "new-run") && !(await may("approve", me))) {
    return redirect("/?denied=approve");
  }

  // Approve / deny a parked run — deliver the decision event, flag the run
  // due, and let the resident worker carry it. (Mirrors runs/[id].tsx; the
  // web process never executes the agent.)
  if (intent === "approve" || intent === "deny") {
    const runId = String(form.get("runId") ?? "");
    // Same binding rule as the run page: the decision names the park the
    // operator saw, and the claim decides a single winner. A stale inbox card
    // must never approve a park that appeared after it was rendered.
    const reviewed = String(form.get("eventName") ?? "");
    if (reviewed === "") return redirect("/");
    if (!(await runtime.claimDecision(runId, reviewed))) return redirect("/?decision=taken");
    try {
      await deliverEvent(runtime.store, runId, reviewed, {
        approved: intent === "approve",
        ...(me !== null ? { by: actorFromPrincipal(me).id } : {}),
      });
    } catch (error) {
      await runtime.releaseDecision(runId, reviewed).catch(() => {});
      throw error;
    }
    await runtime.markWake?.(runId);
    return redirect("/");
  }

  // Launch / dismiss a proposed intake task.
  if (intent === "launch-task" || intent === "retry-task" || intent === "dismiss-task") {
    const taskId = String(form.get("taskId") ?? "");
    const task = await runtime.intake.get(taskId);
    if (task === null) return redirect("/");
    const retry = intent === "retry-task" && task.state === "launched" && task.runId !== undefined;
    if (!retry && task.state !== "proposed") return redirect("/");
    if (retry && await runtime.loadMeta(task.runId!) !== null) return redirect(`/runs/${task.runId}`);
    if (intent === "dismiss-task") {
      await runtime.intake.setState(taskId, "dismissed");
      return redirect("/");
    }
    // Claim first: a worker's auto-sweep may race this click; the claim's
    // conditional update decides who launches (the loser is a no-op).
    const runId = task.runId ?? `run-${randomUUID()}`;
    if (!retry && !(await runtime.intake.claim(taskId, runId))) return redirect("/");
    try {
      // An accepted intent already records who authorized it and its config.
      // Repair that exact intent instead of resolving today's defaults again.
      const accepted = await runtime.launches?.get(runId);
      if (accepted) {
        await runtime.launches!.publish(accepted);
        return redirect(`/runs/${runId}`);
      }
      await enqueueRun(runtime, {
        runId,
        task: task.pr !== undefined ? (task.detail ?? task.title) : task.detail !== undefined ? `${task.title}\n\n${task.detail}` : task.title,
        model: defaultModel(),
        source: task.source,
        ...intakeJourney(task.kind),
        // Whoever the payload named, not whoever clicked launch. The clicker
        // authorised it; the requester asked for it, and an audit reader wants
        // the second. A manual task nobody signed falls back to the operator.
        actor:
          task.requestedBy !== undefined
            ? intakeActor(task.requestedBy, task.source)
            : actorFromPrincipal(me),
        // A launch click approves running the task, not the origin it names:
        // the repo came from a webhook or chat payload either way.
        trust: task.source === "manual" ? "operator" : "external",
        ...(task.repo !== undefined ? { repo: task.repo } : {}),
        ...(task.pr !== undefined ? { pr: task.pr } : {}),
      });
    } catch (error) {
      // It may have been accepted before the response failed. Retain the
      // claim and identity so a retry cannot create another run.
      return redirect("/?error=" + encodeURIComponent(error instanceof Error ? error.message : "Launch needs recovery. Retry the same request."));
    }
    await runtime.intake.setState(taskId, "launched", runId);
    return redirect(`/runs/${runId}`);
  }

  if (intent !== "new-run" && intent !== "submit-request") return new Response("Unknown action", { status: 400 });
  if (intent === "submit-request" && me?.role !== "editor" && me?.role !== "admin") return new Response("Not permitted", { status: 403 });
  try {
    const task = String(form.get("task") ?? "").trim();
    if (!task || task.length > 20000) throw new Error("Describe your request in 20,000 characters or fewer.");
    const repo = String(form.get("repo") ?? "").trim();
    const project = await runtime.projects.forRepo(repo);
    if (!project?.url) throw new Error("Choose a connected project. An administrator can add one in Project setup.");
    const journey = parseJourney(form.get("journey") ?? (form.get("mode") === "scan" ? "review" : "change"));
    const rawPr = String(form.get("pr") ?? "").trim();
    const pr = rawPr ? Number(rawPr) : undefined;
    if (pr !== undefined && (journey !== "review" || !Number.isSafeInteger(pr) || pr < 1)) throw new Error("Enter a valid pull request number for a review.");
    if (intent === "submit-request") {
      const id = String(form.get("requestId") ?? "");
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Refresh the page before sending your request.");
      const proposed = await runtime.intake.propose({
        source: "team-request", kind: `request-${journey}`, repo: project.url,
        title: task, dedupeKey: `team-request:${me!.user}:${id}`,
        requestedBy: me!.user, ...(pr ? { pr } : {}),
      });
      if (proposed.task.title !== task || proposed.task.repo !== project.url || proposed.task.kind !== `request-${journey}` || proposed.task.pr !== pr) {
        throw new Error("This request ID already belongs to different content. Edit your draft before sending it as a new request.");
      }
      return redirect(`/?submitted=${encodeURIComponent(proposed.task.taskId)}`);
    }
    const submission = submissionIdentity(actorFromPrincipal(me).id, "new-run", form.get("requestId"), {
      task, repo: project.url, journey, pr: pr ?? null, plan: form.get("plan") === "on" && journey === "change",
    });
    const runId = submission.runId;
    await enqueueRun(runtime, {
      ...submission, task, ...journeyOptions(journey), model: defaultModel(), source: "manual",
      actor: actorFromPrincipal(me), trust: "operator", repo: project.url,
      ...(pr ? { pr } : {}), ...(form.get("plan") === "on" && journey === "change" ? { plan: true } : {}),
    });
    return redirect(`/runs/${runId}?created=1`);
  } catch (error) {
    return redirect("/?error=" + encodeURIComponent(error instanceof Error ? error.message : "Could not submit your request"));
  }
}


function short(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Live updates via the shared SSE helper (see _layout __shipLive): the server
// pushes on any state change and this re-checks the inbox's own loader data.
const POLL = `__shipLive("route:index.tsx");`;

export default function Inbox({ data }: { data: InboxData }) {
  const nothing = data.parked.length === 0 && data.proposed.length === 0;
  return (
    <>
      {data.decisionTaken && (
        <p class="card attn notice" style="color:var(--yellow)">
          Not applied — someone else decided that run first.
        </p>
      )}
      {data.denied && (
        <p class="card attn notice" style="color:var(--red)">
          Not applied — your account may not approve, deny or launch runs. An admin can grant it on <a href="/policies">Policies</a>.
        </p>
      )}
      <div class="page-heading"><div><h1 class="page">Inbox</h1><p class="meta">Tasks and runs waiting for your decision.</p></div><a class="button" href="/runs">View all runs →</a></div>
      <div class="summary-grid">
        <a class="summary-card" href="#approvals"><strong>{data.parked.length}</strong><span>Awaiting your decision</span></a>
        <a class="summary-card" href="#proposals"><strong>{data.proposed.length}</strong><span>Proposed tasks</span></a>
        <a class="summary-card" href="/projects"><strong>{data.projects.length}</strong><span>Configured projects</span></a>
      </div>
      <p class="row-actions" style="display:flex;gap:16px"><a href="/workflows">Choose a workflow</a><a href="/setup">Set up a project</a></p>
      {data.template && <p class="notice">Workflow: <b>{data.template.name}</b>. Fill in the details below before starting.</p>}
      {data.submitted && <p class="notice good" role="status">Your request was sent for approval. It has not started yet. Find it in Proposed tasks below.</p>}
      {data.error && <p class="notice bad" role="alert">{data.error} Your draft is preserved in this browser.</p>}
      <TaskComposer projects={data.projects} selectedRepo={data.selectedRepo} initialTask={data.template?.task} initialJourney={data.template?.journey ?? (data.template?.mode === "scan" ? "review" : "change")} initialPlan={data.template?.plan} canLaunch={data.canLaunch} canRequest={data.canRequest} requestId={data.requestId} clearDraft={!!data.submitted} />

      <h2 class="section" id="approvals">
        Needs your decision <span class="count">({data.parked.length})</span>
      </h2>
      {data.parked.length === 0 ? (
        <div class="empty"><h3>You’re caught up</h3><p>Plans, approval requests, and agent questions will appear here.</p></div>
      ) : (
        data.parked.map((r) => (
          <div key={r.runId} class="card attn">
            <div class="row-actions">
              <span class={`status ${r.status}`}>waiting</span>
              <a href={`/runs/${r.runId}`}>{r.runId}</a>
              <span class="spacer" style="flex:1" />
              <form method="post" class="row-actions">
                <input type="hidden" name="runId" value={r.runId} />
                {/* Binds the decision to the park this card was rendered from. */}
                <input type="hidden" name="eventName" value={r.eventName ?? ""} />
                <a class="button sm" href={`/runs/${r.runId}`}>Review and respond</a>
              </form>
            </div>
            <div class="meta" style="margin:8px 0 0">{short(r.task, 140)}</div>
          </div>
        ))
      )}

      {data.pendingLaunches.length > 0 && <section><h2 class="section">Starting or awaiting recovery</h2>
        <p class="meta">These requests have a reserved task identity but no visible run yet. Retrying resumes the same request.</p>
        {data.pendingLaunches.map(t => <article class="card" key={t.taskId}><b>{t.title}</b><form method="post"><input type="hidden" name="taskId" value={t.taskId} /><button type="submit" name="intent" value="retry-task">Retry launch</button></form></article>)}
      </section>}
      <h2 class="section" id="proposals">
        Proposed tasks <span class="count">({data.proposed.length})</span>
      </h2>
      {data.proposed.length === 0 ? (
        <p class="empty">No proposed tasks. Label a Forgejo/GitHub issue <code>ship</code> to see it here.</p>
      ) : (
        data.proposed.map((t) => (
          <div key={t.taskId} class="card">
            <div class="row-actions">
              <span class="chip">{t.source === "team-request" ? JOURNEYS.find(j => `request-${j.id}` === t.kind)?.label ?? "Team request" : `${t.source}/${t.kind}`}</span>
              {t.repo !== undefined && <span class="meta">{t.repo.replace(/^https?:\/\//, "").slice(0, 44)}</span>}
              <span style="flex:1" />
              <form method="post" class="row-actions">
                <input type="hidden" name="taskId" value={t.taskId} />
                {data.canLaunch && <><button class="approve sm" type="submit" name="intent" value="launch-task">Approve and start</button><button class="sm" type="submit" name="intent" value="dismiss-task">Dismiss</button></>}
              </form>
            </div>
            <div class="meta" style="margin:8px 0 0">{t.title}<p class="meta">Requested by {t.requestedBy ?? "an integration"}</p></div>
          </div>
        ))
      )}

      {data.recentRequests.length > 0 && <section><h2 class="section">Recent requests</h2>{data.recentRequests.map(t => <article class="card" key={t.taskId}><b>{t.title}</b><p class="meta">{t.state === "launched" ? "Approved for launch" : "Dismissed"} · {t.requestedBy}</p>{t.runVisible && t.runId && <a href={`/runs/${t.runId}`}>Follow the task and its result →</a>}</article>)}</section>}
      {nothing && data.pendingLaunches.length === 0 && <p class="empty" style="margin-top:28px">Inbox zero. <a href="/runs">See all runs →</a></p>}
      <script dangerouslySetInnerHTML={{ __html: POLL }} />
    </>
  );
}
