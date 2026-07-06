import { randomUUID } from "node:crypto";

import { enqueueRun } from "teploy-ship/runtime";
import type { RunMeta } from "teploy-ship/runtime";
import type { IntakeTask } from "teploy-ship/runtime";

import { defaultModel, shipRuntime } from "../lib/store.server.js";

export const config = { mode: "app" };

interface HomeData {
  runs: RunMeta[];
  proposed: IntakeTask[];
  store: string;
  model: string;
}

export async function loader(): Promise<HomeData> {
  const runtime = await shipRuntime();
  const [runs, proposed] = await Promise.all([runtime.listMeta(), runtime.intake.list("proposed")]);
  return { runs, proposed, store: runtime.kind, model: defaultModel() };
}

export async function action({ request }: { request: Request }): Promise<Response> {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "new-run");
  const runtime = await shipRuntime();

  if (intent === "launch-task" || intent === "dismiss-task") {
    const taskId = String(form.get("taskId") ?? "");
    const task = await runtime.intake.get(taskId);
    if (task === null || task.state !== "proposed") {
      return new Response(null, { status: 302, headers: { location: "/" } });
    }
    if (intent === "dismiss-task") {
      await runtime.intake.setState(taskId, "dismissed");
      return new Response(null, { status: 302, headers: { location: "/" } });
    }
    const runId = `run-${randomUUID().slice(0, 8)}`;
    await enqueueRun(runtime, {
      runId,
      // review follow-ups carry the feedback itself as the task
      task: task.pr !== undefined ? (task.detail ?? task.title) : task.detail !== undefined ? `${task.title}\n\n${task.detail}` : task.title,
      model: defaultModel(),
      ...(task.repo !== undefined ? { repo: task.repo } : {}),
      ...(task.pr !== undefined ? { pr: task.pr } : {}),
    });
    await runtime.intake.setState(taskId, "launched", runId);
    return new Response(null, { status: 302, headers: { location: `/runs/${runId}` } });
  }

  const task = String(form.get("task") ?? "").trim();
  if (task === "") return new Response(null, { status: 302, headers: { location: "/" } });
  const runId = `run-${randomUUID().slice(0, 8)}`;
  await enqueueRun(runtime, { runId, task, model: defaultModel() });
  return new Response(null, { status: 302, headers: { location: `/runs/${runId}` } });
}

export default function Runs({ data }: { data: HomeData }) {
  return (
    <>
      <h1 style="font-size: 18px">Runs</h1>
      <p class="meta">
        store: {data.store} · model: {data.model}
        {data.store === "file" && " · no worker executes file-store runs — resume queued runs from the CLI"}
      </p>
      <form class="newrun" method="post">
        <input type="text" name="task" placeholder='new task, e.g. "fix the failing test in api/"' />
        <button type="submit">Queue run</button>
      </form>
      {data.proposed.length > 0 && (
        <>
          <h2 style="font-size: 15px; margin-top: 24px">Inbox — proposed tasks</h2>
          <table class="runs">
            <thead>
              <tr>
                <th>source</th>
                <th>task</th>
                <th>repo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.proposed.map((t) => (
                <tr key={t.taskId}>
                  <td>{t.source}/{t.kind}</td>
                  <td>{t.title.length > 70 ? `${t.title.slice(0, 70)}…` : t.title}</td>
                  <td>{t.repo !== undefined ? t.repo.replace(/^https?:\/\//, "").slice(0, 40) : "—"}</td>
                  <td style="white-space: nowrap">
                    <form method="post" style="display: inline">
                      <input type="hidden" name="taskId" value={t.taskId} />
                      <button class="approve" type="submit" name="intent" value="launch-task">Launch</button>{" "}
                      <button type="submit" name="intent" value="dismiss-task">Dismiss</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {data.runs.length === 0 ? (
        <p class="empty">No runs yet.</p>
      ) : (
        <table class="runs">
          <thead>
            <tr>
              <th>run</th>
              <th>status</th>
              <th>task</th>
              <th>updated</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((run) => (
              <tr key={run.runId}>
                <td>
                  <a href={`/runs/${run.runId}`}>{run.runId}</a>
                </td>
                <td>
                  <span class={`status ${run.status}`}>{run.status}</span>
                </td>
                <td>{run.task.length > 80 ? `${run.task.slice(0, 80)}…` : run.task}</td>
                <td>{run.updatedAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
