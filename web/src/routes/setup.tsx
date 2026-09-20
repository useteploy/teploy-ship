import { randomUUID } from "node:crypto";
import { enqueueRun, actorFromPrincipal } from "../lib/ship.server.js";
import { defaultModel } from "../lib/store.server.js";
import type { Project } from "teploy-ship/runtime";
import { currentUser } from "../lib/session.server.js";
import { may } from "../lib/authority.server.js";
import { shipRuntime } from "../lib/store.server.js";
import { readiness } from "../lib/readiness.server.js";
import type { ReadinessCheck } from "../lib/readiness.server.js";
export const config = { mode: "app" };
interface Data {
  selected: Project | null;
  canLaunch: boolean;
  recentRuns: { runId: string; task: string; status: string }[];
  projects: { repo: string; label: string }[];
  repo: string;
  checks: ReadinessCheck[];
  checkedAt: string;
  canEdit: boolean;
  error: string | null;
}
export async function loader({ request }: { request: Request }): Promise<Data> {
  const runtime = await shipRuntime(),
    projects = await runtime.projects.list(),
    repo =
      new URL(request.url).searchParams.get("repo") ?? projects[0]?.repo ?? "";
  const selected = projects.find((p) => p.repo === repo) ?? null;
  const runs = await runtime.listMeta({ limit: 100 });
  const recentRuns: Data["recentRuns"] = [];
  for (const r of runs
    .filter((r) => r.task.startsWith("Verify project environment:"))
    .slice(0, 20)) {
    const events = await runtime.store.load(r.runId);
    const input = (events.find((e) => e.type === "run-started")?.data as any)
      ?.input;
    if (input?.repo === selected?.url)
      recentRuns.push({ runId: r.runId, task: r.task, status: r.status });
  }
  return {
    selected,
    canLaunch: await may("approve", await currentUser(request)),
    recentRuns,
    projects: projects.map((p) => ({ repo: p.repo, label: p.label ?? p.repo })),
    repo,
    checks: await readiness(
      runtime,
      projects.find((p) => p.repo === repo) ?? null,
    ),
    checkedAt: new Date().toISOString(),
    canEdit: await may("policies", await currentUser(request)),
    error: new URL(request.url).searchParams.get("error"),
  };
}
export async function action({
  request,
}: {
  request: Request;
}): Promise<Response> {
  if (!(await may("policies", await currentUser(request))))
    return new Response("Not permitted", { status: 403 });
  const me = await currentUser(request);
  const f = await request.formData(),
    runtime = await shipRuntime(),
    repo = String(f.get("url") ?? "").trim();
  const redirect = (location: string) =>
    new Response(null, { status: 303, headers: { location } });
  try {
    if (f.get("intent") === "verify") {
      if (!(await may("approve", me)))
        return new Response("Not permitted", { status: 403 });
      const project = await runtime.projects.forRepo(
        String(f.get("repo") ?? ""),
      );
      if (!project?.url)
        return redirect("/setup?error=Choose+a+registered+repository");
      const runId = `run-${randomUUID().slice(0, 8)}`;
      await enqueueRun(runtime, {
        runId,
        repo: project.url,
        model: defaultModel(),
        source: "manual",
        actor: actorFromPrincipal(me),
        trust: "operator",
        mode: "scan",
        environmentCheck: true,
        task: `Verify project environment: ${project.label ?? project.repo}. Inspect repository instructions and dependency manifests. Run the configured test command ${project.testCommand ?? "or detect the appropriate test command"}. Confirm required runtimes and services are available. Do not modify tracked files or publish changes. Report exact commands and failures with actionable setup fixes. Finish after verification; do not broaden into a code audit.`,
      });
      return redirect(`/runs/${runId}?view=review`);
    }
    if (f.get("intent") === "environment") {
      const project = await runtime.projects.forRepo(
        String(f.get("repo") ?? ""),
      );
      if (!project) return redirect("/setup?error=Project+not+found");
      const command = String(f.get("prepare") ?? "").trim();
      const tests = String(f.get("tests") ?? "").trim();
      if (tests.length > 2000) throw new Error("Test command is too long");
      await runtime.projects.set({
        ...project,
        preparation: command
          ? { command, timeoutMs: Number(f.get("timeout") || 300) * 1000 }
          : undefined,
        testCommand: tests || undefined,
        verification: project.verification
          ? { ...project.verification, tests: tests || undefined }
          : undefined,
      });
      return redirect(`/setup?repo=${encodeURIComponent(project.repo)}`);
    }
    const url = new URL(repo);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return redirect(
        "/setup?error=Use+an+HTTP+clone+URL+without+embedded+credentials",
      );
    const existing = await runtime.projects.forRepo(repo);
    if (existing)
      return redirect(`/setup?repo=${encodeURIComponent(existing.repo)}`);
    const label = String(f.get("label") ?? "").trim(),
      image = String(f.get("image") ?? "").trim(),
      tests = String(f.get("tests") ?? "").trim();
    if (label.length > 100 || image.length > 300 || tests.length > 2000)
      return redirect("/setup?error=One+of+the+fields+is+too+long");
    await runtime.projects.set({
      repo,
      url: repo,
      label: label || undefined,
      sandboxImage: image || undefined,
      testCommand: tests || undefined,
      autoMerge: false,
      autoDeploy: false,
      neverAuto: true,
      sourcePolicy: "propose",
      authority: "send",
    });
    const saved = await runtime.projects.forRepo(repo);
    return redirect(`/setup?repo=${encodeURIComponent(saved?.repo ?? repo)}`);
  } catch (e) {
    return redirect(
      "/setup?error=" +
        encodeURIComponent(
          e instanceof Error ? e.message : "Could not save project setup",
        ),
    );
  }
}
export default function Setup({ data }: { data: Data }) {
  return (
    <>
      <div class="page-heading">
        <div>
          <h1 class="page">Project setup</h1>
          <p class="meta">
            Connect a repository, configure its environment, then prove the
            first run.
          </p>
        </div>
        <a class="button" href="/projects#add-project">
          Add repository
        </a>
      </div>
      <form method="get" class="row-actions">
        <label class="field">
          Project
          <select name="repo" value={data.repo}>
            {data.projects.map((p) => (
              <option value={p.repo}>{p.label}</option>
            ))}
          </select>
        </label>
        <button type="submit">Check setup</button>
      </form>
      <p class="meta">
        Checked {data.checkedAt.replace("T", " ").slice(0, 19)} UTC.
        Configuration checks do not run the agent or spend model credits.
      </p>
      {data.error && (
        <p class="notice bad" role="alert">
          {data.error}
        </p>
      )}
      {data.canEdit && (
        <details class="disclosure" open={data.projects.length === 0}>
          <summary>Connect a repository</summary>
          <form method="post" class="project-form">
            <label class="field">
              Clone URL
              <input
                name="url"
                type="url"
                required
                placeholder="https://github.com/your-team/your-repo"
              />
            </label>
            <label class="field">
              Project name
              <input
                name="label"
                maxLength={100}
                placeholder="Optional display name"
              />
            </label>
            <label class="field">
              Sandbox image
              <input
                name="image"
                maxLength={300}
                placeholder="Inherit worker default"
              />
            </label>
            <label class="field">
              Test command
              <input
                name="tests"
                maxLength={2000}
                placeholder="Detect from repository"
              />
            </label>
            <p class="meta form-section">
              New projects propose incoming work for review and require a person
              to authorize merges. Existing project settings are preserved.
            </p>
            <button type="submit">Save and check setup</button>
          </form>
        </details>
      )}
      {data.selected && data.canEdit && (
        <section class="setup-environment">
          <h2 class="section">Prepare the environment</h2>
          <p class="meta">
            Configure repeatable setup for this repository. Ship runs it inside
            each task’s sandbox before the agent starts; failures stop the run
            with recorded output.
          </p>
          <form method="post" class="project-form">
            <input type="hidden" name="repo" value={data.selected.repo} />
            <label class="field form-section">
              Preparation command
              <textarea
                name="prepare"
                rows={4}
                maxLength={8000}
                placeholder="pnpm install --frozen-lockfile"
              >
                {data.selected.preparation?.command ?? ""}
              </textarea>
            </label>
            <label class="field">
              Timeout (seconds)
              <input
                name="timeout"
                type="number"
                min="1"
                max="900"
                value={(data.selected.preparation?.timeoutMs ?? 300000) / 1000}
              />
            </label>
            <label class="field">
              Test command
              <input
                name="tests"
                maxLength={2000}
                value={data.selected.testCommand ?? ""}
                placeholder="pnpm test"
              />
            </label>
            <button name="intent" value="environment">
              Save environment
            </button>
          </form>
          {data.canLaunch && (
            <form method="post">
              <input type="hidden" name="repo" value={data.selected.repo} />
              <button name="intent" value="verify">
                Verify environment with a real run
              </button>
              <p class="meta">
                Uses your configured model and budget. Clones the repo, prepares
                the sandbox and checks the environment without publishing
                changes.
              </p>
            </form>
          )}
          {data.recentRuns.length > 0 && (
            <ul>
              {data.recentRuns.map((r) => (
                <li>
                  <a href={`/runs/${r.runId}?view=review`}>{r.runId}</a> ·{" "}
                  {r.status}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <ol class="setup-list">
        {data.checks.map((c, i) => (
          <li class="setup-step" key={c.name}>
            <div>
              <h2>
                {i + 1}. {c.name}
              </h2>
              <span class={c.state === "ready" ? "good" : "meta"}>
                {c.state === "ready"
                  ? "Configured"
                  : c.state === "attention"
                    ? "Action needed"
                    : "Needs verification"}
              </span>
            </div>
            <p>{c.detail}</p>
            {c.href && (
              <a href={c.href}>
                {c.name === "Credentials & first run"
                  ? "Prepare first review →"
                  : "Open configuration →"}
              </a>
            )}
          </li>
        ))}
      </ol>
      <p class="notice">
        Start with a read-only review. When checkout, model access and the
        environment work, use a small change with a test to establish a verified
        baseline.
      </p>
    </>
  );
}
