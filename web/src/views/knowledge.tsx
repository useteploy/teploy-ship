import type { RepoNote } from "teploy-ship/runtime";

import { SubNav } from "../lib/subnav.js";
import { PROJECT_VIEWS } from "./project-views.js";


export interface KnowledgeData {
  view: "knowledge";
  repos: { repo: string; count: number }[];
  repo: string;
  notes: RepoNote[];
  store: string;
}


export function knowledgeHref(repo = ""): string {
  return repo !== "" ? `/projects?view=knowledge&repo=${encodeURIComponent(repo)}` : "/projects?view=knowledge";
}


function shortRepo(r: string): string {
  return r.replace(/^https?:\/\//, "").replace(/\.git$/, "");
}


export default function Knowledge({ data }: { data: KnowledgeData }) {
  return (
    <>
      <h1 class="page">Projects</h1>
      <SubNav items={PROJECT_VIEWS} current="knowledge" />
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
                  <a href={knowledgeHref(r.repo)}>{shortRepo(r.repo)}</a>
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
            <a href={knowledgeHref()}>repos</a> / {shortRepo(data.repo)} <span class="count">({data.notes.length})</span>
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
              <div key={n.noteId} class="card">
                <div class="row-actions">
                  <span class="chip">{n.runId !== undefined ? "from run" : "manual"}</span>
                  {n.runId !== undefined && <a href={`/runs/${n.runId}`}>{n.runId}</a>}
                  <span class="meta">{n.createdAt}</span>
                  <span style="flex:1" />
                  <form method="post" class="row-actions">
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="repo" value={data.repo} />
                    <input type="hidden" name="noteId" value={n.noteId} />
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

