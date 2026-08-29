import type { Project } from "teploy-ship/runtime";

import { shipRuntime, effectiveAuthority } from "../lib/store.server.js";
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
// The two ship-sandbox-* tags are what `images/build.sh` produces (B5) — the
// only images in this list that carry a harness binary.
const IMAGES = ["ship-sandbox-go:dev", "ship-sandbox-node:dev", "golang:1.25", "node:22", "python:3.12-slim", "rust:1"];
const NETWORKS = ["", "none", "egress"] as const;
const POLICIES = ["", "ignore", "propose", "auto"] as const;
// The ladder caps authority (C4): the rungs a project declares are the most
// it may ever do unattended. The select shows the four contract-1 values plus
// "legacy", which reads the autoMerge checkbox below — the same default
// effectiveAuthority computes (ladder.ts).
const AUTHORITIES = ["", "legacy", "propose", "send", "auto_trivial", "auto_normal"] as const;
// Mirrors HARNESS_VERSIONS (src/harness.ts) the way NETWORKS/POLICIES mirror
// their unions: this route is SSR'd from source and importing a value out of
// the runtime package for a four-entry list is not worth the coupling.
// normalizeProject refuses an id this list does not contain, so a drift here
// surfaces as a rejected save rather than a broken run.
const HARNESSES = ["", "native", "claude-code", "opencode"] as const;

interface ProjectsData {
  view: "repos";
  projects: Project[];
  /** The record ?repo= names, if any. */
  selected: Project | null;
  /** repo slug -> its ladder-capped authority (computed server-side, C4). */
  effective: Record<string, string>;
  hookBase: string;
  envAllowlist: string;
  workerImage: string;
  workerHarness: string;
  workerTestCommand: string;
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
    effective: Object.fromEntries(
      projects.map((p) => [
        p.repo,
        p.authority !== undefined || p.verification !== undefined || p.neverAuto === true
          ? effectiveAuthority(p)
          : p.autoMerge === true
            ? "legacy"
            : "send",
      ]),
    ),
    selected,
    hookBase: (process.env.SHIP_PUBLIC_URL ?? "").replace(/\/+$/, ""),
    envAllowlist: process.env.SHIP_REPO_ALLOWLIST ?? "",
    workerImage: process.env.SHIP_SANDBOX_IMAGE ?? "",
    workerHarness: (process.env.SHIP_HARNESS ?? "").trim(),
    workerTestCommand: (process.env.SHIP_TEST_COMMAND ?? "").trim(),
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
  const canAuto = await may("auto", me);
  if (policy === "auto" && existing.sourcePolicy !== "auto" && !canAuto) {
    return redirect(`/projects?denied=auto`);
  }
  // Asking to turn either unattended flag ON without the grant is a refusal,
  // not a silent downgrade: an operator who ticked the box and got a saved
  // record with it clear would reasonably believe auto-merge was on.
  const wantsAuto = form.get("autoMerge") !== null || form.get("autoDeploy") !== null;
  if (wantsAuto && !canAuto) return redirect(`/projects?denied=auto`);
  const network = str("network");
  const harness = str("harness");
  const memoryMb = num("memoryMb");
  const cpus = num("cpus");
  // The verification ladder (C4 / contract 1). Same merge shape as the rest
  // of this form: an empty field clears, a filled one sets — the inputs are
  // seeded with the stored values, so an unchanged save preserves them. The
  // preview rung needs both halves; clearing either drops it, because a smoke
  // with no app (or the reverse) is a rung that can never run. normalizeProject
  // refuses anything half-shaped anyway, and the error comes back through the
  // redirect below.
  const build = str("build");
  const previewApp = str("previewApp");
  const previewSmoke = str("previewSmoke");
  const observeWindow = num("observeWindow");
  const { preview: _pv, visual: _vi, ...storedRungs } = existing.verification ?? {};
  const verification = {
    ...storedRungs,
    ...(build !== undefined ? { build } : {}),
    ...(previewApp !== undefined && previewApp !== "" && previewSmoke !== undefined && previewSmoke !== ""
      ? { preview: { app: previewApp, smoke: previewSmoke } }
      : {}),
    ...(form.get("visual") === "on" ? { visual: true } : {}),
    ...(observeWindow !== undefined ? { observeWindowMin: observeWindow } : {}),
  };
  // The select submits "" (legacy). A DISABLED select submits nothing, and a
  // user without the grant sees it disabled — reading that as "clear it"
  // would let an ordinary save by an editor strip an authority an admin set,
  // the same trap the autoMerge checkboxes below guard against. Their save
  // preserves what is set.
  const authority = canAuto ? str("authority") : undefined;
  if (authority !== undefined && !["", "legacy", "propose", "send", "auto_trivial", "auto_normal"].includes(authority)) {
    return redirect(`/projects?error=${encodeURIComponent(`authority must be legacy, propose, send, auto_trivial or auto_normal, got: ${authority}`)}`);
  }
  // An authority at or above an auto rung is the same grant as the autoMerge
  // box: unattended action, gated on `auto`.
  if ((authority === "auto_trivial" || authority === "auto_normal") && !canAuto) return redirect(`/projects?denied=auto`);
  const neverAuto = form.get("neverAuto") === "on";
  const next: Project = {
    ...existing,
    url: str("url") ?? existing.url,
    label: str("label"),
    sandboxImage: str("image"),
    sandboxNetwork: network === "none" || network === "egress" ? network : undefined,
    sandboxLimits: memoryMb !== undefined || cpus !== undefined ? { ...(memoryMb !== undefined ? { memoryMb } : {}), ...(cpus !== undefined ? { cpus } : {}) } : undefined,
    sourcePolicy: policy === "ignore" || policy === "propose" || policy === "auto" ? policy : undefined,
    // Declare-then-bake: this says WHICH program edits the tree. The binary has
    // to be in the sandbox image already (`images/build.sh --harness <id>`);
    // nothing installs it per run. normalizeProject rejects an unknown id, and
    // the redirect below shows the message.
    harness,
    dailyBudgetUSD: num("budget"),
    testCommand: str("testCommand"),
    testTimeoutMs: num("testTimeoutMs"),
    observeService: str("observeService"),
    // The two unattended-action flags (L5 / L4). Guarded by the same `auto`
    // grant as setting an intake policy to `auto` — merging without a human is
    // a stronger form of the same authority, not a different one — and a
    // checkbox that is absent from the form body reads as false, which is the
    // safe direction for both.
    // A user without the grant sees both boxes disabled, so their form body
    // carries neither — reading that as "off" would let an ordinary save by an
    // editor silently switch auto-merge off. Their save preserves what is set.
    autoMerge: canAuto ? form.get("autoMerge") !== null : existing.autoMerge === true,
    autoDeploy: canAuto ? form.get("autoDeploy") !== null : existing.autoDeploy === true,
    deployApp: str("deployApp"),
    ...(verification !== undefined && Object.keys(verification).length > 0 ? { verification } : {}),
    ...(authority !== undefined
      ? authority !== "" && authority !== "legacy"
        ? { authority: authority as Project["authority"] }
        : {}
      : existing.authority !== undefined
        ? { authority: existing.authority }
        : {}),
    ...(neverAuto ? { neverAuto: true } : {}),
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
        harness{data.workerHarness !== "" ? ` (worker default ${data.workerHarness})` : ""}
        <select name="harness" style={INPUT}>
          {HARNESSES.map((h) => (
            <option key={h} value={h} selected={(p?.harness ?? "") === h}>{h === "" ? "worker default" : h}</option>
          ))}
        </select>
      </label>
      <label class="meta" style="display:flex;flex-direction:column;gap:4px">
        intake policy
        <select name="policy" style={INPUT}>
          {POLICIES.map((n) => (
            <option key={n} value={n} selected={(p?.sourcePolicy ?? "") === n}>{n === "" ? "inherit from source" : n}</option>
          ))}
        </select>
      </label>
      <Field label="daily budget $" name="budget" value={p?.dailyBudgetUSD !== undefined ? String(p.dailyBudgetUSD) : undefined} placeholder="source default" type="number" />
      <Field label="test command" name="testCommand" value={p?.testCommand ?? p?.verification?.tests} placeholder="detected from the repo" />
      <Field label="test timeout ms" name="testTimeoutMs" value={p?.testTimeoutMs !== undefined ? String(p.testTimeoutMs) : undefined} placeholder="default" type="number" />
      <Field label="Observe service" name="observeService" value={p?.observeService} placeholder="none" />
      <Field label="deploy app" name="deployApp" value={p?.deployApp} placeholder="teploy.yml default" />
      <Field label="build command (ladder)" name="build" value={p?.verification?.build} placeholder="none declared" />
      <Field label="preview app (ladder)" name="previewApp" value={p?.verification?.preview?.app} placeholder="none declared" />
      <Field label="preview smoke command" name="previewSmoke" value={p?.verification?.preview?.smoke} placeholder={`run against PREVIEW_URL`} />
      <Field label="observe window minutes" name="observeWindow" value={p?.verification?.observeWindowMin !== undefined ? String(p.verification.observeWindowMin) : undefined} placeholder="none" type="number" />
      <label class="meta" style="display:flex;gap:6px;align-items:center">
        <input type="hidden" name="visual" value="off" />
        <input type="checkbox" name="visual" checked={p?.verification?.visual === true} />
        visual diff rung
      </label>
      <label class="meta" style="display:flex;flex-direction:column;gap:4px">
        authority (ladder caps it)
        <select name="authority" style={INPUT} disabled={!data.canAuto}>
          {AUTHORITIES.map((a) => (
            <option key={a} value={a} selected={(p?.authority ?? "legacy") === a}>{a === "" ? "legacy" : a}</option>
          ))}
        </select>
      </label>
      <label class="meta" style="display:flex;gap:6px;align-items:center">
        <input type="hidden" name="neverAuto" value="off" />
        <input type="checkbox" name="neverAuto" checked={p?.neverAuto === true} />
        never auto (policy floor)
      </label>
      <label class="meta" style="display:flex;gap:6px;align-items:center">
        <input type="checkbox" name="autoMerge" checked={p?.autoMerge === true} disabled={!data.canAuto} />
        auto-merge trivial changes
      </label>
      <label class="meta" style="display:flex;gap:6px;align-items:center">
        <input type="checkbox" name="autoDeploy" checked={p?.autoDeploy === true} disabled={!data.canAuto} />
        auto-rollback a bad deploy
      </label>
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
        which harness edits its tree, and the test command the pull request reports. · store: {data.store}
      </p>
      <p class="meta">
        Leave <b>test command</b> empty and Ship reads the repo's own tree at enqueue — package.json scripts.test, a Makefile{" "}
        <code>test:</code> target, go.mod, Cargo.toml, pytest — and uses that
        {data.workerTestCommand !== "" ? <> instead of <code>SHIP_TEST_COMMAND</code> = <code>{data.workerTestCommand}</code></> : null}.
        A command typed here always wins. Leave <b>harness</b> at the worker default unless the sandbox image
        actually carries that binary: harnesses are baked in by <code>images/build.sh --harness &lt;id&gt;</code>, never installed per run.
      </p>
      <p class="meta">
        <b>auto-merge</b> squash-merges this repo's pull request with no human when the change classifies <code>trivial</code>,
        the suite <i>passed</i>, the pull request opened non-draft and telemetry did not get worse — all four, every time, and the
        run records which of them held. It needs the change-class gate on (<code>SHIP_CHANGE_CLASS</code>);
        <code>SHIP_AUTO_MERGE=0</code> disables it everywhere at once. <b>auto-rollback</b> lets a run actually run
        <code>teploy rollback</code> when the service got worse after it deployed; with it off, the run still records what it
        would have done and why. Turn either on only after the <code>change-class</code> steps for this repo have been read for
        a while — the whole point of the classifier is that its verdict has to earn trust before it is spent.
      </p>
      <p class="meta">
        <b>The ladder caps authority</b> (C4): the rungs declared above — build, tests, preview+smoke, visual diff, observe
        window — set the most this repo may ever do unattended. No tests rung means never past <code>send</code>; preview +
        visual reaches <code>auto_trivial</code>; every rung reaches <code>auto_normal</code>. The authority select asks for
        at most that, and the unattended column shows the effective value. Declaring a preview app also means the smoke and
        visual rungs need sandbox egress to reach the preview URL — set the sandbox network to <code>egress</code> for repos
        with a ladder.
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
                  <tr><th>repo</th><th>image</th><th>harness</th><th>policy</th><th>tests</th><th>observe</th><th>unattended</th></tr>
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
                      <td class="meta">{r.harness ?? "worker default"}</td>
                      <td class="meta">{r.sourcePolicy ?? "inherit"}{r.dailyBudgetUSD !== undefined ? ` · $${r.dailyBudgetUSD}/day` : ""}</td>
                      <td class="meta">{r.testCommand ?? r.verification?.tests ?? "detected"}</td>
                      <td class="meta">{r.observeService ?? "—"}</td>
                      <td class="meta">
                        {(data as ProjectsData).effective[r.repo] ?? "send"}
                        {r.neverAuto === true ? " (never-auto)" : ""}
                      </td>
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
