import type { RepoNote } from "teploy-ship/runtime";

import { shipRuntime } from "../lib/store.server.js";

export const config = { mode: "app" };

interface KnowledgeData {
  repos: { repo: string; count: number }[];
  repo: string;
  notes: RepoNote[];
  store: string;
}

export async function loader({ request }: { request: Request }): Promise<KnowledgeData> {
  const runtime = await shipRuntime();
  const repo = new URL(request.url).searchParams.get("repo") ?? "";
  const [repos, notes] = await Promise.all([
    runtime.memory.repos(),
    repo !== "" ? runtime.memory.recent(repo, 200) : Promise.resolve([]),
  ]);
  repos.sort((a, b) => b.count - a.count);
  return { repos, repo, notes, store: runtime.kind };
}

export async function action({ request }: { request: Request }): Promise<Response> {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const repo = String(form.get("repo") ?? "").trim();
  const runtime = await shipRuntime();
  if (repo !== "" && intent === "add") {
    const note = String(form.get("note") ?? "").trim();
    if (note !== "") await runtime.memory.record({ repo, note });
  } else if (repo !== "" && intent === "delete") {
    const createdAt = String(form.get("createdAt") ?? "");
    if (createdAt !== "") await runtime.memory.remove(repo, createdAt);
  }
  const to = repo !== "" ? `/knowledge?repo=${encodeURIComponent(repo)}` : "/knowledge";
  return new Response(null, { status: 302, headers: { location: to } });
}

function shortRepo(r: string): string {
  return r.replace(/^https?:\/\//, "").replace(/\.git$/, "");
}

export default function Knowledge({ data }: { data: KnowledgeData }) {
  return (
    <>
      <h1 class="page">Repo knowledge</h1>
      <p class="meta">
        What Ship remembers about each repo — notes it records after a run, plus anything you add. Injected as recent
        history into future runs on that repo. · store: {data.store}
      </p>

      {data.repo === "" ? (
        <>
          <h2 class="section">Repos <span class="count">({data.repos.length})</span></h2>
          {data.repos.length === 0 ? (
            <p class="empty">No repo notes yet. Ship records them as it completes runs, or add one from a repo view.</p>
          ) : (
            data.repos.map((r) => (
              <div key={r.repo} class="card">
                <div class="row-actions">
                  <a href={`/knowledge?repo=${encodeURIComponent(r.repo)}`}>{shortRepo(r.repo)}</a>
                  <span style="flex:1" />
                  <span class="count">{r.count} note{r.count === 1 ? "" : "s"}</span>
                </div>
              </div>
            ))
          )}
        </>
      ) : (
        <>
          <h2 class="section">
            <a href="/knowledge">repos</a> / {shortRepo(data.repo)} <span class="count">({data.notes.length})</span>
          </h2>

          <form class="newrun" method="post">
            <input type="hidden" name="intent" value="add" />
            <input type="hidden" name="repo" value={data.repo} />
            <input type="text" name="note" placeholder="add a note — a convention, a gotcha, a no-go zone…" />
            <button type="submit">Add note</button>
          </form>

          {data.notes.length === 0 ? (
            <p class="empty">No notes for this repo yet.</p>
          ) : (
            data.notes.map((n) => (
              <div key={`${n.createdAt}`} class="card">
                <div class="row-actions">
                  <span class="chip">{n.runId !== undefined ? "from run" : "manual"}</span>
                  {n.runId !== undefined && <a href={`/runs/${n.runId}`}>{n.runId}</a>}
                  <span class="meta">{n.createdAt}</span>
                  <span style="flex:1" />
                  <form method="post" class="row-actions">
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="repo" value={data.repo} />
                    <input type="hidden" name="createdAt" value={n.createdAt} />
                    <button class="deny sm" type="submit">Delete</button>
                  </form>
                </div>
                <div style="margin:8px 0 0;white-space:pre-wrap">{n.note}</div>
              </div>
            ))
          )}
        </>
      )}
    </>
  );
}
