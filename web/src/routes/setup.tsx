import { currentUser } from "../lib/session.server.js";
import { may } from "../lib/authority.server.js";
import { shipRuntime } from "../lib/store.server.js";
import { readiness } from "../lib/readiness.server.js";
import type { ReadinessCheck } from "../lib/readiness.server.js";
export const config = { mode: "app" };
interface Data {
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
  return {
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
  const f = await request.formData(),
    runtime = await shipRuntime(),
    repo = String(f.get("url") ?? "").trim();
  const redirect = (location: string) =>
    new Response(null, { status: 303, headers: { location } });
  try {
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
  } catch {
    return redirect(
      "/setup?error=Could+not+register+this+repository.+Check+the+clone+URL+and+try+again",
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
