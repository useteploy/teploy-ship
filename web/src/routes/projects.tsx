import type { Project } from "teploy-ship/runtime";

import { shipRuntime } from "../lib/store.server.js";
import { currentUser } from "../lib/session.server.js";
import { may } from "../lib/authority.server.js";
import { redirect } from "../lib/http.server.js";
import { SubNav } from "../lib/subnav.js";
import { PROJECT_VIEWS } from "../views/project-views.js";
import Sources from "../views/sources.js";
import { loader as sourcesLoader, action as sourcesAction } from "../views/sources.server.js";
import type { SourcesData } from "../views/sources.js";
import Knowledge from "../views/knowledge.js";
import { loader as knowledgeLoader, action as knowledgeAction } from "../views/knowledge.server.js";
import type { KnowledgeData } from "../views/knowledge.js";

export const config = { mode: "app" };

// Images an operator is likely to want; the field is free text, this only
// seeds the browser's suggestions. Empty = the worker's SHIP_SANDBOX_IMAGE.
const IMAGES = ["golang:1.24", "node:22", "python:3.12-slim", "rust:1", "ruby:3.3"];
const NETWORKS = ["", "none", "egress"] as const;
const POLICIES = ["", "ignore", "propose", "auto"] as const;

interface ProjectsData {
  view: "repos";
  projects: Project[];
  /** The record ?repo= names, if any. */
  selected: Project | null;
  hookBase: string;
  envAllowlist: string;
  workerImage: string;
  canEdit: boolean;
  canAuto: boolean;
  denied: string | null;
  error: string | null;
  store: string;
}

function viewOf(request: Request): string {
  return new URL(request.url).searchParams.get("view") ?? "";
}

export async function loader({ request }: { request: Request }): Promise<ProjectsData | SourcesData | KnowledgeData> {
  const view = viewOf(request);
  if (view === "sources") return sourcesLoader({ request });
  if (view === "knowledge") return knowledgeLoader({ request });
  const runtime = await shipRuntime();
  const me = await currentUser(request);
  const url = new URL(request.url);
  const [projects, canEdit, canAuto] = await Promise.all([runtime.projects.list(), may("policies", me), may("auto", me)]);
  const repo = url.searchParams.get("repo") ?? "";
  const selected = repo !== "" ? (await runtime.projects.forRepo(repo)) : null;
  return {
    view: "repos",
    projects,
    selected,
    hookBase: (process.env.SHIP_PUBLIC_URL ?? "").replace(/\/+$/, ""),
    envAllowlist: process.env.SHIP_REPO_ALLOWLIST ?? "",
    workerImage: process.env.SHIP_SANDBOX_IMAGE ?? "",
    canEdit,
    canAuto,
    denied: url.searchParams.get("denied"),
    error: url.searchParams.get("error"),
    store: runtime.kind,
  };
}

export async function action({ request }: { request: Request }): Promise<Response> {
  const view = viewOf(request);
  if (view === "sources") return sourcesAction({ request });
  if (view === "knowledge") return knowledgeAction({ request });
  const form = await request.formData();
  const runtime = await shipRuntime();
  const me = await currentUser(request);
  const str = (name: string): string | undefined => {
    const v = String(form.get(name) ?? "").trim();
    return v === "" ? undefined : v;
  };
  const num = (name: string): number | undefined => {
    const v = str(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const intent = str("intent") ?? "save";
  const target = str("repo") ?? str("url");
  if (target === undefined) return redirect("/projects");

  // Same two grants as Sources (governance.ts): a project is a repo's intake
  // policy plus the allowlist entry that lets the token reach it.
  if (!(await may("policies", me))) return redirect("/projects?denied=policies");

  if (intent === "remove") {
    await runtime.projects.remove(target);
    return redirect("/projects");
  }

  const policy = str("policy");
  const existing = (await runtime.projects.forRepo(target)) ?? { repo: target, autoMerge: false, autoDeploy: false };
  if (policy === "auto" && existing.sourcePolicy !== "auto" && !(await may("auto", me))) {
    return redirect(`/projects?denied=auto`);
  }
  const network = str("network");
  const memoryMb = num("memoryMb");
  const cpus = num("cpus");
  const next: Project = {
    ...existing,
    url: str("url") ?? existing.url,
    label: str("label"),
    sandboxImage: str("image"),
    sandboxNetwork: network === "none" || network === "egress" ? network : undefined,
    sandboxLimits: memoryMb !== undefined || cpus !== undefined ? { ...(memoryMb !== undefined ? { memoryMb } : {}), ...(cpus !== undefined ? { cpus } : {}) } : undefined,
    sourcePolicy: policy === "ignore" || policy === "propose" || policy === "auto" ? policy : undefined,
    dailyBudgetUSD: num("budget"),
    testCommand: str("testCommand"),
    testTimeoutMs: num("testTimeoutMs"),
    observeService: str("observeService"),
  };
  try {
    await runtime.projects.set(next);
  } catch (e) {
    return redirect(`/projects?error=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`);
  }
  const saved = await runtime.projects.forRepo(next.url ?? next.repo);
  return redirect(saved !== null ? `/projects?repo=${encodeURIComponent(saved.repo)}` : "/projects");
}

function deniedText(denied: string): string {
  if (denied === "auto") return "your account may not set a project to auto. An admin can grant it on Policies.";
  return "your account may not change projects. An admin can grant it on Policies.";
}

const INPUT = "background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 8px";

function Field({ label, name, value, placeholder, type, list, width }: { label: string; name: string; value?: string; placeholder?: string; type?: string; list?: string; width?: string }) {
  return (
    <label class="meta" style="display:flex;flex-direction:column;gap:4px">
      {label}
      <input type={type ?? "text"} name={name} value={value ?? ""} placeholder={placeholder} list={list} style={`${INPUT};width:${width ?? "100%"}`} />
    </label>
  );
}

function ProjectForm({ p, data }: { p: Project | null; data: ProjectsData }) {
  return (
    <form method="post" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;align-items:end">
      {p !== null && <input type="hidden" name="repo" value={p.repo} />}
      <Field label="clone URL" name="url" value={p?.url} placeholder="https://forge.example/owner/repo" />
      <Field label="label" name="label" value={p?.label} placeholder="optional" />
      <Field label={`sandbox image${data.workerImage !== "" ? ` (worker default ${data.workerImage})` : ""}`} name="image" value={p?.sandboxImage} placeholder="worker default" list="ship-images" />
      <datalist id="ship-images">
        {IMAGES.map((i) => (
          <option key={i} value={i} />
        ))}
      </datalist>
      <label class="meta" style="display:flex;flex-direction:column;gap:4px">
        sandbox network
        <select name="network" style={INPUT}>
          {NETWORKS.map((n) => (
            <option key={n} value={n} selected={(p?.sandboxNetwork ?? "") === n}>{n === "" ? "worker default" : n}</option>
          ))}
        </select>
      </label>
      <Field label="memory MB" name="memoryMb" value={p?.sandboxLimits?.memoryMb !== undefined ? String(p.sandboxLimits.memoryMb) : undefined} placeholder="1024" type="number" />
      <Field label="cpus" name="cpus" value={p?.sandboxLimits?.cpus !== undefined ? String(p.sandboxLimits.cpus) : undefined} placeholder="1" type="number" />
      <label class="meta" style="display:flex;flex-direction:column;gap:4px">
        intake policy
        <select name="policy" style={INPUT}>
          {POLICIES.map((n) => (
            <option key={n} value={n} selected={(p?.sourcePolicy ?? "") === n}>{n === "" ? "inherit from source" : n}</option>
          ))}
        </select>
      </label>
      <Field label="daily budget $" name="budget" value={p?.dailyBudgetUSD !== undefined ? String(p.dailyBudgetUSD) : undefined} placeholder="source default" type="number" />
      <Field label="test command" name="testCommand" value={p?.testCommand} placeholder="go test ./..." />
      <Field label="test timeout ms" name="testTimeoutMs" value={p?.testTimeoutMs !== undefined ? String(p.testTimeoutMs) : undefined} placeholder="default" type="number" />
      <Field label="Observe service" name="observeService" value={p?.observeService} placeholder="none" />
      <div class="row-actions" style="gap:8px">
        <button class="approve sm" type="submit" name="intent" value="save" disabled={!data.canEdit}>{p === null ? "Add project" : "Save"}</button>
        {p !== null && (
          <button class="sm" type="submit" name="intent" value="remove" disabled={!data.canEdit}>Remove</button>
        )}
      </div>
    </form>
  );
}

export default function Projects({ data }: { data: ProjectsData | SourcesData | KnowledgeData }) {
  if (data.view === "sources") return <Sources data={data} />;
  if (data.view === "knowledge") return <Knowledge data={data} />;
  const p = data.selected;
  return (
    <>
      <h1 class="page">Projects</h1>
      <SubNav items={PROJECT_VIEWS} current="repos" />
      {data.denied !== null && (
        <p class="card attn" style="margin:12px 0;color:var(--red)">Not applied — {deniedText(data.denied)}</p>
      )}
      {data.error !== null && (
        <p class="card attn" style="margin:12px 0;color:var(--red)">Not saved — {data.error}</p>
      )}
      {!data.canEdit && (
        <p class="card" style="margin:12px 0;color:var(--dim)">
          Read-only: your account may not change projects. An admin can grant it on <a href="/policies">Policies</a>.
        </p>
      )}
      <p class="meta">
        One record per repository. Adding a project allows its repo (the allowlist is this list plus{" "}
        <code>SHIP_REPO_ALLOWLIST</code>{data.envAllowlist !== "" ? ` = ${data.envAllowlist}` : ", unset"}), picks the sandbox image its runs boot,
        and sets the test command the pull request reports. · store: {data.store}
      </p>

      {p !== null ? (
        <>
          <p class="meta"><a href="/projects">projects</a> / {p.repo}{p.label !== undefined ? ` · ${p.label}` : ""}</p>
          <div class="card">
            <ProjectForm p={p} data={data} />
          </div>
          <h2 class="section">Webhook</h2>
          <p class="meta">
            Point the repo's webhook at{" "}
            <code>{data.hookBase || "<server-url>"}/hooks/forgejo</code> or <code>{data.hookBase || "<server-url>"}/hooks/github</code>{" "}
            with the secret from <code>SHIP_WEBHOOK_SECRET</code>, then label an issue or PR <code>ship</code>. Policy for the
            source overall is on <a href="/projects?view=sources">Sources</a>; this project's own policy above wins for its tasks.
          </p>
        </>
      ) : (
        <>
          {data.projects.length === 0 ? (
            <p class="empty">No projects yet.</p>
          ) : (
            <div class="table-wrap">
              <table class="runs">
                <thead>
                  <tr><th>repo</th><th>image</th><th>policy</th><th>tests</th><th>observe</th></tr>
                </thead>
                <tbody>
                  {data.projects.map((r) => (
                    <tr key={r.repo}>
                      <td>
                        <a href={`/projects?repo=${encodeURIComponent(r.repo)}`}>{r.repo}</a>
                        {r.label !== undefined && <span class="meta"> · {r.label}</span>}
                        {r.url === undefined && <span class="meta"> · no clone URL — not allowlisted</span>}
                      </td>
                      <td class="meta">{r.sandboxImage ?? "worker default"}{r.sandboxNetwork !== undefined ? ` · ${r.sandboxNetwork}` : ""}</td>
                      <td class="meta">{r.sourcePolicy ?? "inherit"}{r.dailyBudgetUSD !== undefined ? ` · $${r.dailyBudgetUSD}/day` : ""}</td>
                      <td class="meta">{r.testCommand ?? "—"}</td>
                      <td class="meta">{r.observeService ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h2 class="section">Add a project</h2>
          <div class="card">
            <ProjectForm p={null} data={data} />
          </div>
        </>
      )}
    </>
  );
}
