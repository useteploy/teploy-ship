import type { Project, SkillPin, SkillVersion } from "teploy-ship/runtime";
import { importSkill } from "teploy-ship/runtime";

import { shipRuntime } from "../lib/store.server.js";
import { currentUser } from "../lib/session.server.js";
import { may, deniedMessage } from "../lib/authority.server.js";
import { SubNav } from "../lib/subnav.js";
import { SETTINGS_VIEWS } from "../views/settings-views.js";
import { importNotice, provenanceLine } from "../views/skills-views.js";

export const config = { mode: "app" };

interface SkillRow {
  name: string;
  latest: SkillVersion;
  versions: SkillVersion[];
}

interface ProjectRow {
  repo: string;
  label: string;
  pins: SkillPin[];
}

interface SkillsData {
  skills: SkillRow[];
  projects: ProjectRow[];
  canEdit: boolean;
  me: string;
  /** False only on a runtime without the registry wired; the page says so and refuses writes. */
  registryPresent: boolean;
}

export async function loader({ request }: { request: Request }): Promise<SkillsData> {
  const runtime = await shipRuntime();
  const me = await currentUser(request);
  const canEdit = await may("policies", me);
  const [latest, projects] = await Promise.all([runtime.skills?.list() ?? Promise.resolve([]), runtime.projects.list()]);
  const rows: SkillRow[] = [];
  for (const skill of latest) {
    const versions = (await runtime.skills?.versions(skill.name)) ?? [skill];
    rows.push({ name: skill.name, latest: skill, versions: versions.sort((a, b) => b.version - a.version) });
  }
  return {
    skills: rows,
    projects: projects.map((p: Project) => ({ repo: p.repo, label: p.label ?? p.repo, pins: p.skills ?? [] })),
    canEdit,
    me: me?.user ?? "",
    registryPresent: runtime.skills !== undefined,
  };
}

type ActionResult = { error?: string; ok?: string };

export async function action({ request }: { request: Request }): Promise<ActionResult> {
  const runtime = await shipRuntime();
  const me = await currentUser(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  try {
    if (!(await may("policies", me))) return { error: deniedMessage("policies") };
    if (runtime.skills === undefined) return { error: "This Ship has no skills registry configured." };

    if (intent === "import") {
      const text = String(form.get("text") ?? "");
      const kind = String(form.get("sourceKind") ?? "") === "git" ? "git" : "upload";
      const ref = String(form.get("ref") ?? "").trim();
      if (text.trim() === "") return { error: "Paste a SKILL.md to import." };
      const { record, created } = await importSkill(runtime.skills, text, {
        author: me?.user || "unknown",
        source: { kind, ...(ref !== "" ? { ref } : {}) },
      });
      const note = importNotice(record);
      return {
        ok: `${created ? "Imported" : "Already in the registry (identical content)"}: ${record.name} v${record.version} sha256:${record.digest.slice(0, 12)}.${note !== "" ? ` ${note}.` : ""}`,
      };
    }

    if (intent === "enable") {
      const repo = String(form.get("repo") ?? "").trim();
      const name = String(form.get("name") ?? "").trim();
      const version = Number(form.get("version"));
      if (repo === "" || name === "" || !Number.isInteger(version) || version < 1) {
        return { error: "A repository, a skill name and a positive version are required." };
      }
      if ((await runtime.skills.get(name, version)) === undefined) {
        return { error: `Skill "${name}" version ${version} is not in the registry.` };
      }
      const project = await runtime.projects.forRepo(repo);
      if (project === null) return { error: `No project record for ${repo} — add it on Projects first.` };
      const pins = [...(project.skills ?? []).filter((p) => p.name !== name), { name, version }];
      await runtime.projects.set({ ...project, skills: pins });
      return { ok: `${name} v${version} enabled for ${project.repo}. Runs enqueued after this carry it.` };
    }

    if (intent === "disable") {
      const repo = String(form.get("repo") ?? "").trim();
      const name = String(form.get("name") ?? "").trim();
      const project = await runtime.projects.forRepo(repo);
      if (project === null) return { error: `No project record for ${repo}.` };
      const pins = (project.skills ?? []).filter((p) => p.name !== name);
      await runtime.projects.set({ ...project, skills: pins });
      return { ok: `${name} disabled for ${project.repo}.` };
    }
    return { error: "Unknown action." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed." };
  }
}

const field = "background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font:inherit";

export default function Skills({ data, actionData }: { data: SkillsData; actionData?: ActionResult }) {
  return (
    <>
      <h1 class="page">Settings</h1>
      <SubNav items={SETTINGS_VIEWS} current="skills" />
      <p class="meta">
        A skill is a SKILL.md the operator imports so runs start with the team's own checklists. Versions are immutable
        and content-addressed; a project enables a skill <b>pinned to a version</b>, and a run carries the pinned text in
        its recorded input — editing the registry never changes an in-flight run. Frontmatter outside
        name/description/version (e.g. <code>allowed-tools</code>) is stripped at import and the stripping is recorded.
        A skill is advice, never authority: nothing in it changes permissions, egress, credentials or approvals.
      </p>
      {actionData?.error !== undefined && <p class="card attn" style="margin:12px 0;color:var(--red)">{actionData.error}</p>}
      {actionData?.ok !== undefined && <p class="card" style="margin:12px 0;color:var(--green)">{actionData.ok}</p>}
      {!data.registryPresent && (
        <p class="card attn" style="margin:12px 0;color:var(--red)">This runtime has no skills registry configured; the page is read-only.</p>
      )}
      {!data.canEdit && (
        <p class="card" style="margin:12px 0;color:var(--dim)">
          Read-only: {data.me || "this account"} does not hold the <b>policies</b> grant (see <a href="/policies">Approval rules</a>).
        </p>
      )}

      <h2 class="section">Import a skill</h2>
      <p class="meta">
        Paste the SKILL.md verbatim (Claude Code format: YAML frontmatter with name and description, then the markdown
        body). The source reference is provenance text — a URL@sha or a note — never a token.
      </p>
      <form method="post" class="card" style="display:grid;gap:8px">
        <input type="hidden" name="intent" value="import" />
        <textarea name="text" aria-label="SKILL.md text" rows="10" required placeholder={"---\nname: deploy-checklist\ndescription: What to verify before a deploy\n---\nRun the suite, then..."} style={`${field};font-family:var(--mono,monospace)`} />
        <div class="row-actions" style="gap:10px;align-items:center;flex-wrap:wrap">
          <label class="meta">Source
            <select name="sourceKind" aria-label="Source kind" style={field}>
              <option value="upload">upload</option>
              <option value="git">git</option>
            </select>
          </label>
          <input type="text" name="ref" aria-label="Source reference" placeholder="url@sha or note (no tokens)" style={`${field};width:280px`} />
          <button class="approve sm" type="submit" disabled={!data.canEdit || !data.registryPresent}>Import</button>
        </div>
      </form>

      <h2 class="section">Registry</h2>
      {data.skills.length === 0 && <p class="empty">No skills imported yet.</p>}
      {data.skills.length > 0 && (
        <div class="table-wrap"><table class="runs">
          <thead>
            <tr><th>skill</th><th>versions</th><th>description</th><th>import</th><th>enable for a project</th></tr>
          </thead>
          <tbody>
            {data.skills.map((s) => {
              const note = importNotice(s.latest);
              return (
                <tr key={s.name}>
                  <td><b>{s.name}</b><div class="meta">sha256:{s.latest.digest.slice(0, 12)}</div></td>
                  <td>{s.versions.map((v) => `v${v.version}`).join(", ")}</td>
                  <td>{s.latest.description}{note !== "" && <div class="meta" style="color:var(--yellow)">{note}</div>}</td>
                  <td class="meta">{provenanceLine(s.latest)}</td>
                  <td>
                    {data.projects.length > 0 && (
                      <form method="post" class="row-actions" style="gap:6px;align-items:center;flex-wrap:nowrap">
                        <input type="hidden" name="intent" value="enable" />
                        <input type="hidden" name="name" value={s.name} />
                        <select name="repo" aria-label={`Project for ${s.name}`} style={`${field};max-width:180px`}>
                          {data.projects.map((p) => (
                            <option key={p.repo} value={p.repo}>{p.repo}</option>
                          ))}
                        </select>
                        <select name="version" aria-label={`Version of ${s.name}`} style={field}>
                          {s.versions.map((v) => (
                            <option key={v.version} value={v.version}>v{v.version}</option>
                          ))}
                        </select>
                        <button class="approve sm" type="submit" disabled={!data.canEdit || !data.registryPresent}>Enable</button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      )}

      <h2 class="section">Per-project enablement</h2>
      <p class="meta">
        Enabled skills are materialised into the run input at enqueue (under <code>SHIP_SKILLS</code>), pinned to the
        version named here. A skill enabled in one project never appears in another project's runs.
      </p>
      <div class="table-wrap"><table class="runs">
        <thead>
          <tr><th>project</th><th>enabled skills</th><th><span class="sr-only">actions</span></th></tr>
        </thead>
        <tbody>
          {data.projects.map((p) => (
            <tr key={p.repo}>
              <td><code>{p.repo}</code></td>
              <td>
                {p.pins.length === 0 && <span class="meta">none</span>}
                {p.pins.map((pin) => (
                  <form key={pin.name} method="post" style="display:inline">
                    <input type="hidden" name="intent" value="disable" />
                    <input type="hidden" name="repo" value={p.repo} />
                    <input type="hidden" name="name" value={pin.name} />
                    <span class="chip">{pin.name} v{pin.version}</span>{" "}
                    <button class="deny sm" type="submit" disabled={!data.canEdit || !data.registryPresent}>Remove</button>
                  </form>
                ))}
              </td>
              <td />
            </tr>
          ))}
          {data.projects.length === 0 && (
            <tr><td colSpan={3} class="meta">No project records — add one on Projects first.</td></tr>
          )}
        </tbody>
      </table></div>
    </>
  );
}
