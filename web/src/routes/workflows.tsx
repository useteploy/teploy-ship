import {
  workflowSchedules,
  scheduleKey,
  validSchedule,
} from "../lib/schedules.server.js";
import type { WorkflowSchedule } from "../../../dist/workflow-schedules.js";
import { randomUUID } from "node:crypto";
import {
  workflows,
  validTemplate,
  workflowKey,
} from "../lib/workflows.server.js";
import type { WorkflowTemplate } from "../lib/workflows.server.js";
import { shipRuntime } from "../lib/store.server.js";
import { currentUser } from "../lib/session.server.js";
import { may } from "../lib/authority.server.js";
export const config = { mode: "app" };
interface Data {
  schedules: WorkflowSchedule[];
  projects: { repo: string; label: string }[];
  history: { title: string; state: string; runId?: string }[];
  templates: WorkflowTemplate[];
  canEdit: boolean;
  selected?: WorkflowTemplate;
  error: string | null;
}
export async function loader({ request }: { request: Request }): Promise<Data> {
  const templates = await workflows(await shipRuntime()),
    q = new URL(request.url).searchParams;
  const runtime = await shipRuntime();
  return {
    schedules: await workflowSchedules(runtime),
    projects: (await runtime.projects.list()).map((p) => ({
      repo: p.repo,
      label: p.label ?? p.repo,
    })),
    history: (await runtime.intake.list())
      .filter((t) => t.source === "workflow")
      .slice(-30)
      .reverse()
      .map((t) => ({ title: t.title, state: t.state, runId: t.runId })),
    templates,
    canEdit: await may("policies", await currentUser(request)),
    selected: templates.find((t) => t.id === q.get("edit")),
    error: q.get("error"),
  };
}
export async function action({
  request,
}: {
  request: Request;
}): Promise<Response> {
  const me = await currentUser(request);
  if (!(await may("policies", me)))
    return new Response("Not permitted", { status: 403 });
  const f = await request.formData(),
    runtime = await shipRuntime(),
    id = String(f.get("id") || `custom-${randomUUID()}`);
  if (f.get("intent") === "schedule" || f.get("intent") === "toggle-schedule") {
    const stored = await workflowSchedules(runtime);
    if (f.get("intent") === "toggle-schedule") {
      const schedule = stored.find((s) => s.id === f.get("scheduleId"));
      if (!schedule) return new Response("Schedule not found", { status: 404 });
      const project = await runtime.projects.forRepo(schedule.repo);
      const auto =
        project?.sourcePolicy === "auto" ||
        (await runtime.policies.list()).some(
          (p) => p.source === "workflow" && p.policy === "auto",
        );
      if (!schedule.enabled && auto && !(await may("auto", me)))
        return new Response("Auto authority required", { status: 403 });
      await runtime.config.set(
        scheduleKey(schedule.id),
        JSON.stringify({ ...schedule, enabled: !schedule.enabled }),
        me?.user,
      );
    } else {
      const template = (await workflows(runtime)).find(
        (t) => t.id === f.get("template"),
      );
      const project = await runtime.projects.forRepo(
        String(f.get("repo") ?? ""),
      );
      if (!template || !project?.url)
        return new Response("Choose a workflow and registered repository", {
          status: 400,
        });
      const auto =
        project.sourcePolicy === "auto" ||
        (await runtime.policies.list()).some(
          (p) => p.source === "workflow" && p.policy === "auto",
        );
      if (auto && !(await may("auto", me)))
        return new Response("Auto authority required", { status: 403 });
      const schedule = {
        id: randomUUID(),
        name: template.name,
        task: template.task,
        repo: project.repo,
        mode: template.mode,
        plan: template.plan,
        everyMinutes: Number(f.get("every")),
        enabled: true,
        createdAt: new Date().toISOString(),
        by: me!.user,
      };
      if (!validSchedule(schedule))
        return new Response("Choose an interval between one hour and 31 days", {
          status: 400,
        });
      await runtime.config.set(
        scheduleKey(schedule.id),
        JSON.stringify(schedule),
        me?.user,
      );
    }
    return new Response(null, {
      status: 303,
      headers: { location: "/workflows#schedules" },
    });
  }
  if (!/^custom-[a-z0-9-]{1,60}$/.test(id))
    return new Response("Invalid workflow", { status: 400 });
  if (f.get("intent") === "delete")
    await runtime.config.remove(workflowKey(id));
  else {
    const t = {
      id,
      name: String(f.get("name") ?? "").trim(),
      description: String(f.get("description") ?? "").trim(),
      task: String(f.get("task") ?? "").trim(),
      mode: String(f.get("mode") ?? "fix"),
      plan: f.get("plan") === "on" && f.get("mode") !== "scan",
    };
    if (!validTemplate(t))
      return new Response(null, {
        status: 303,
        headers: {
          location:
            "/workflows?error=Provide+a+name+and+instructions+within+the+length+limits",
        },
      });
    await runtime.config.set(workflowKey(id), JSON.stringify(t), me?.user);
  }
  return new Response(null, {
    status: 303,
    headers: { location: "/workflows" },
  });
}
export default function Workflows({ data }: { data: Data }) {
  const t = data.selected;
  return (
    <>
      <div class="page-heading">
        <div>
          <h1 class="page">Workflows</h1>
          <p class="meta">
            Reusable instructions for work your team does often.
          </p>
        </div>
        <a class="button" href="/projects">
          Projects
        </a>
      </div>
      <p class="meta">
        Choose a workflow, select a repository, and review the instructions
        before launching. Project permissions, verification and budgets still
        apply.
      </p>
      {data.error && (
        <p class="notice bad" role="alert">
          {data.error}
        </p>
      )}
      <section id="schedules">
        <h2 class="section">Scheduled work</h2>
        <p class="meta">
          Schedules copy the workflow’s current instructions. Each occurrence
          enters the Inbox; existing source and project policies decide whether
          it waits for review or launches automatically. Missed intervals are
          combined into one occurrence.
        </p>
        {data.schedules.map((s) => (
          <article class="workflow-row">
            <div>
              <b>{s.name}</b>
              <p class="meta">
                {s.repo} · every {s.everyMinutes / 60} hours ·{" "}
                {s.enabled ? "enabled" : "paused"}
              </p>
            </div>
            {data.canEdit && (
              <form method="post">
                <input type="hidden" name="scheduleId" value={s.id} />
                <button name="intent" value="toggle-schedule">
                  {s.enabled ? "Pause" : "Resume"}
                </button>
              </form>
            )}
          </article>
        ))}
        {data.canEdit && (
          <details class="disclosure">
            <summary>Add a schedule</summary>
            <form method="post" class="project-form">
              <label class="field">
                Workflow
                <select name="template">
                  {data.templates.map((t) => (
                    <option value={t.id}>{t.name}</option>
                  ))}
                </select>
              </label>
              <label class="field">
                Project
                <select name="repo">
                  {data.projects.map((p) => (
                    <option value={p.repo}>{p.label}</option>
                  ))}
                </select>
              </label>
              <label class="field">
                Frequency
                <select name="every">
                  <option value="1440">Daily</option>
                  <option value="10080">Weekly</option>
                  <option value="60">Hourly</option>
                </select>
              </label>
              <button name="intent" value="schedule">
                Create schedule
              </button>
            </form>
          </details>
        )}
        {data.history.length > 0 && (
          <details class="disclosure">
            <summary>Recent scheduled work</summary>
            <ul>
              {data.history.map((h) => (
                <li>
                  {h.runId ? (
                    <a href={`/runs/${h.runId}`}>{h.title}</a>
                  ) : (
                    h.title
                  )}{" "}
                  · {h.state}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
      <div class="workflow-list">
        {data.templates.map((t) => (
          <article class="workflow-row" key={t.id}>
            <div>
              <h2>{t.name}</h2>
              <p class="meta">{t.description}</p>
              <span class="chip">
                {t.mode === "scan" ? "Read-only review" : "Code changes"}
              </span>{" "}
              <span class="meta">
                {t.plan ? "Plan review first" : "Direct start"}
              </span>
            </div>
            <div class="row-actions">
              <a
                class="button"
                href={`/?workflow=${encodeURIComponent(t.id)}#new-task`}
              >
                Use workflow
              </a>
              {t.custom && data.canEdit && (
                <a href={`/workflows?edit=${t.id}#workflow-editor`}>Edit</a>
              )}
            </div>
          </article>
        ))}
      </div>
      {data.canEdit && (
        <section id="workflow-editor">
          <h2 class="section">
            {t?.custom ? "Edit workflow" : "Create workflow"}
          </h2>
          <form method="post" class="project-form">
            <input type="hidden" name="id" value={t?.custom ? t.id : ""} />
            <label class="field">
              Name
              <input
                name="name"
                maxLength={100}
                required
                value={t?.custom ? t.name : ""}
              />
            </label>
            <label class="field">
              Description
              <input
                name="description"
                maxLength={300}
                value={t?.custom ? t.description : ""}
              />
            </label>
            <label class="field form-section">
              Instructions
              <textarea name="task" rows={8} maxLength={12000} required>
                {t?.custom ? t.task : ""}
              </textarea>
            </label>
            <label class="field">
              Type
              <select name="mode" value={t?.mode ?? "fix"}>
                <option value="fix">Code changes</option>
                <option value="scan">Read-only review</option>
              </select>
            </label>
            <label class="check-field">
              <input type="checkbox" name="plan" checked={t?.plan ?? true} />
              Review plan before code changes
            </label>
            <div class="row-actions">
              <button type="submit" name="intent" value="save">
                Save workflow
              </button>
              {t?.custom && (
                <button
                  type="submit"
                  name="intent"
                  value="delete"
                  formNoValidate
                >
                  Delete workflow
                </button>
              )}
            </div>
          </form>
        </section>
      )}
    </>
  );
}
