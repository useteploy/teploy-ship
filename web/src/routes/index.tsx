import { randomUUID } from "node:crypto";

import { enqueueRun } from "teploy-ship/runtime";
import type { RunMeta } from "teploy-ship/runtime";

import { defaultModel, shipRuntime } from "../lib/store.js";

export const config = { mode: "app" };

export async function loader(): Promise<{ runs: RunMeta[]; store: string; model: string }> {
  const runtime = await shipRuntime();
  return { runs: await runtime.listMeta(), store: runtime.kind, model: defaultModel() };
}

export async function action({ request }: { request: Request }): Promise<Response> {
  const form = await request.formData();
  const task = String(form.get("task") ?? "").trim();
  if (task === "") return new Response(null, { status: 302, headers: { location: "/" } });
  const runtime = await shipRuntime();
  const runId = `run-${randomUUID().slice(0, 8)}`;
  await enqueueRun(runtime, { runId, task, model: defaultModel() });
  return new Response(null, { status: 302, headers: { location: `/runs/${runId}` } });
}

export default function Runs({ data }: { data: { runs: RunMeta[]; store: string; model: string } }) {
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
