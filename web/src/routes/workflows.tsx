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
  templates: WorkflowTemplate[];
  canEdit: boolean;
  selected?: WorkflowTemplate;
  error: string | null;
}
export async function loader({ request }: { request: Request }): Promise<Data> {
  const templates = await workflows(await shipRuntime()),
    q = new URL(request.url).searchParams;
  return {
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
