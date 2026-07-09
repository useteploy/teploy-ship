import { randomUUID } from "node:crypto";

import { deliverEvent } from "@neutron-build/workflow";
import { enqueueRun } from "teploy-ship/runtime";
import type { RunMeta } from "teploy-ship/runtime";
import type { IntakeTask } from "teploy-ship/runtime";

import { defaultModel, shipRuntime } from "../lib/store.server.js";

export const config = { mode: "app" };

interface InboxData {
  /** Runs parked on an approval — the top priority. */
  parked: RunMeta[];
  /** Proposed intake tasks awaiting a launch/dismiss decision. */
  proposed: IntakeTask[];
  store: string;
  model: string;
}

const TERMINAL = ["completed", "failed", "cancelled"];

export async function loader(): Promise<InboxData> {
  const runtime = await shipRuntime();
  const [runs, proposed] = await Promise.all([runtime.listMeta(), runtime.intake.list("proposed")]);
  const parked = runs.filter((r) => r.status === "waiting" && r.eventName !== undefined);
  return { parked, proposed, store: runtime.kind, model: defaultModel() };
}

export async function action({ request }: { request: Request }): Promise<Response> {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "new-run");
  const runtime = await shipRuntime();

  // Approve / deny a parked run — deliver the decision event, flag the run
  // due, and let the resident worker carry it. (Mirrors runs/[id].tsx; the
  // web process never executes the agent.)
  if (intent === "approve" || intent === "deny") {
    const runId = String(form.get("runId") ?? "");
    const meta = await runtime.loadMeta(runId);
    if (meta?.eventName !== undefined) {
      await deliverEvent(runtime.store, runId, meta.eventName, { approved: intent === "approve" });
      await runtime.markWake?.(runId);
      await runtime.saveMeta({ ...meta, status: "wake", updatedAt: new Date().toISOString() });
    }
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
  const runId = `run-${randomUUID().slice(0, 8)}`;
  await enqueueRun(runtime, {
    runId,
    task,
    model: defaultModel(),
    ...(form.get("plan") === "on" ? { plan: true } : {}),
  });
  return redirect(`/runs/${runId}`);
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
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
      <h1 class="page">Inbox</h1>
      <p class="meta">
        Everything waiting on you. · store: {data.store} · model: {data.model}
        {data.store === "file" && " · file store has no worker — resume queued runs from the CLI"}
      </p>

      <form class="newrun" method="post">
        <input type="text" name="task" placeholder='new task, e.g. "fix the failing test in api/"' />
        <label class="meta" style="display:flex;align-items:center;gap:6px;white-space:nowrap">
          <input type="checkbox" name="plan" /> plan first
        </label>
        <button type="submit">Queue run</button>
      </form>

      <h2 class="section">
        Needs approval <span class="count">({data.parked.length})</span>
      </h2>
      {data.parked.length === 0 ? (
        <p class="empty">No runs are parked.</p>
      ) : (
        data.parked.map((r) => (
          <div key={r.runId} class="card attn">
            <div class="row-actions">
              <span class={`status ${r.status}`}>waiting</span>
              <a href={`/runs/${r.runId}`}>{r.runId}</a>
              <span class="spacer" style="flex:1" />
              <form method="post" class="row-actions">
                <input type="hidden" name="runId" value={r.runId} />
                <button class="approve sm" type="submit" name="intent" value="approve">Approve</button>
                <button class="deny sm" type="submit" name="intent" value="deny">Deny</button>
              </form>
            </div>
            <div class="meta" style="margin:8px 0 0">{short(r.task, 140)}</div>
          </div>
        ))
      )}

      <h2 class="section">
        Proposed tasks <span class="count">({data.proposed.length})</span>
      </h2>
      {data.proposed.length === 0 ? (
        <p class="empty">No proposed tasks. Label a Forgejo/GitHub issue `ship` to see it here.</p>
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
