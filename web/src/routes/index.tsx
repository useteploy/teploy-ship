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
  /** Runs parked on an approval — the top priority. */
  parked: RunMeta[];
  /** Proposed intake tasks awaiting a launch/dismiss decision. */
  proposed: IntakeTask[];
  store: string;
  model: string;
  projects: Array<{ url: string; label: string }>;
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
  const parked = runs.filter((r) => r.status === "waiting" && r.eventName !== undefined);
  return { projects: projects.map(p => ({ url: p.url ?? p.repo, label: p.label ?? p.repo })), parked, proposed, store: runtime.kind, model: defaultModel(), decisionTaken, denied };
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
  if ((intent === "approve" || intent === "deny" || intent === "launch-task" || intent === "new-run") && !(await may("approve", me))) {
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
  if (intent === "launch-task" || intent === "dismiss-task") {
    const taskId = String(form.get("taskId") ?? "");
    const task = await runtime.intake.get(taskId);
    if (task === null || task.state !== "proposed") return redirect("/");
    if (intent === "dismiss-task") {
      await runtime.intake.setState(taskId, "dismissed");
      return redirect("/");
    }
    // Claim first: a worker's auto-sweep may race this click; the claim's
    // conditional update decides who launches (the loser is a no-op).
    if (!(await runtime.intake.claim(taskId))) return redirect("/");
    const runId = `run-${randomUUID().slice(0, 8)}`;
    try {
      await enqueueRun(runtime, {
        runId,
        task: task.pr !== undefined ? (task.detail ?? task.title) : task.detail !== undefined ? `${task.title}\n\n${task.detail}` : task.title,
        model: defaultModel(),
        source: task.source,
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
      await runtime.intake.setState(taskId, "proposed");
      throw error;
    }
    await runtime.intake.setState(taskId, "launched", runId);
    return redirect(`/runs/${runId}`);
  }

  // Quick new run.
  const task = String(form.get("task") ?? "").trim();
  if (task === "") return redirect("/");
  const repo = String(form.get("repo") ?? "").trim();
  const runId = `run-${randomUUID().slice(0, 8)}`;
  await enqueueRun(runtime, {
    runId,
    task,
    model: defaultModel(),
    source: "manual",
    actor: actorFromPrincipal(me),
    // An authenticated editor typed this URL into the form.
    trust: "operator",
    ...(repo !== "" ? { repo } : {}),
    ...(form.get("plan") === "on" ? { plan: true } : {}),
  });
  return redirect(`/runs/${runId}`);
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
      <div class="page-heading"><div><div class="eyebrow">Your workspace</div><h1 class="page">What should we ship next?</h1><p class="meta">Start a task, review a plan, or pick up work that needs your decision.</p></div><a class="button" href="/runs">View all runs →</a></div>
      <div class="summary-grid">
        <a class="summary-card" href="#approvals"><strong>{data.parked.length}</strong><span>Awaiting your decision</span></a>
        <a class="summary-card" href="#proposals"><strong>{data.proposed.length}</strong><span>Proposed tasks</span></a>
        <a class="summary-card" href="/projects"><strong>{data.projects.length}</strong><span>Configured projects</span></a>
      </div>
      <form class="composer" method="post" id="new-task">
        <label htmlFor="task-prompt">Give Ship a task</label>
        <textarea id="task-prompt" name="task" rows={3} required placeholder="Describe the change you want, the problem to investigate, or the test to fix…" />
        <div class="composer-footer">
          <label class="field">Repository<input type="text" name="repo" list="task-projects" placeholder="Choose a project or paste a clone URL" /></label>
          <datalist id="task-projects">{data.projects.map(p => <option key={p.url} value={p.url}>{p.label}</option>)}</datalist>
          <label class="check-field"><input type="checkbox" name="plan" /> Review a plan first</label>
          <button class="primary" type="submit">Queue task →</button>
        </div>
        <p class="meta" style="margin:12px 0 0">{data.store === "file" ? "File storage: queue here, then resume the run from the CLI." : "Your worker picks up queued tasks. A task without a repository runs in an empty workspace."}</p>
      </form>

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
                <button class="approve sm" type="submit" name="intent" value="approve">Approve</button>
                <button class="deny sm" type="submit" name="intent" value="deny">Deny</button>
              </form>
            </div>
            <div class="meta" style="margin:8px 0 0">{short(r.task, 140)}</div>
          </div>
        ))
      )}

      <h2 class="section" id="proposals">
        Proposed tasks <span class="count">({data.proposed.length})</span>
      </h2>
      {data.proposed.length === 0 ? (
        <p class="empty">No proposed tasks. Label a Forgejo/GitHub issue <code>ship</code> to see it here.</p>
      ) : (
        data.proposed.map((t) => (
          <div key={t.taskId} class="card">
            <div class="row-actions">
              <span class="chip">{t.source}/{t.kind}</span>
              {t.repo !== undefined && <span class="meta">{t.repo.replace(/^https?:\/\//, "").slice(0, 44)}</span>}
              <span style="flex:1" />
              <form method="post" class="row-actions">
                <input type="hidden" name="taskId" value={t.taskId} />
                <button class="approve sm" type="submit" name="intent" value="launch-task">Launch</button>
                <button class="sm" type="submit" name="intent" value="dismiss-task">Dismiss</button>
              </form>
            </div>
            <div class="meta" style="margin:8px 0 0">{short(t.title, 140)}</div>
          </div>
        ))
      )}

      {nothing && <p class="empty" style="margin-top:28px">Inbox zero. <a href="/runs">See all runs →</a></p>}
      <script dangerouslySetInnerHTML={{ __html: POLL }} />
    </>
  );
}
