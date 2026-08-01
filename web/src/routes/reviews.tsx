import type { IntakeTask } from "teploy-ship/runtime";

import { shipRuntime } from "../lib/store.server.js";

export const config = { mode: "app" };

interface Thread {
  key: string;
  repo?: string;
  pr: number;
  items: IntakeTask[];
  lastAt: string;
}

interface ReviewsData {
  threads: Thread[];
  store: string;
}

export async function loader(): Promise<ReviewsData> {
  const runtime = await shipRuntime();
  const all = await runtime.intake.list();
  const reviews = all.filter((t) => t.kind === "review" && t.pr !== undefined);

  const byPr = new Map<string, Thread>();
  for (const t of reviews) {
    const key = `${t.repo ?? ""}#${t.pr}`;
    let th = byPr.get(key);
    if (th === undefined) {
      th = { key, pr: t.pr as number, ...(t.repo !== undefined ? { repo: t.repo } : {}), items: [], lastAt: t.createdAt };
      byPr.set(key, th);
    }
    th.items.push(t);
    if (t.createdAt > th.lastAt) th.lastAt = t.createdAt;
  }

  const threads = [...byPr.values()]
    .map((th) => ({ ...th, items: th.items.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)) }))
    .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));

  return { threads, store: runtime.kind };
}

/**
 * GitHub uses /pull/<n> for the human-facing PR page; Forgejo and Gitea use
 * /pulls/<n>. The generic shape 404'd for every GitHub PR Ship linked to.
 */
function prPathSegment(base: string): string {
  return /(^|\/\/)([^/]*\.)?github\.com(\/|$)/.test(base) ? "pull" : "pulls";
}

/** Link to the PR when we can build one from the clone URL. */
function prLink(repo: string | undefined, pr: number): { href?: string; label: string } {
  if (repo === undefined) return { label: `PR #${pr}` };
  const base = repo.replace(/^https?:\/\//, "https://").replace(/\.git$/, "");
  return { href: `${base}/${prPathSegment(base)}/${pr}`, label: `PR #${pr}` };
}

function shortRepo(r: string | undefined): string {
  return r === undefined ? "" : r.replace(/^https?:\/\//, "").replace(/\.git$/, "");
}

export default function Reviews({ data }: { data: ReviewsData }) {
  return (
    <>
      <h1 class="page">Reviews</h1>
      <p class="meta">
        PR review loops. Each comment on a Ship pull request becomes a follow-up run that addresses the feedback,
        pushes, and replies — this is the back-and-forth per PR. · store: {data.store}
      </p>

      {data.threads.length === 0 ? (
        <p class="empty">No review activity yet. Comment on a Ship PR (not a <code>[teploy-ship]</code> reply) to start a loop.</p>
      ) : (
        data.threads.map((th) => {
          const l = prLink(th.repo, th.pr);
          return (
            <div key={th.key} class="card">
              <div class="row-actions" style="flex-wrap:wrap;gap:10px">
                {l.href !== undefined ? (
                  <a href={l.href} target="_blank" rel="noreferrer" style="font-weight:600">{l.label}</a>
                ) : (
                  <span style="font-weight:600">{l.label}</span>
                )}
                {th.repo !== undefined && <span class="meta">{shortRepo(th.repo)}</span>}
                <span style="flex:1" />
                <span class="count">{th.items.length} round{th.items.length === 1 ? "" : "s"}</span>
              </div>
              <ul class="timeline" style="margin-top:10px">
                {th.items.map((t) => (
                  <li key={t.taskId} class="event">
                    <div class="kind">
                      <span class={`chip`}>{t.state}</span>{" "}
                      {t.runId !== undefined && <a href={`/runs/${t.runId}`}>{t.runId}</a>}
                      <span style="float:right" class="meta">{t.createdAt}</span>
                    </div>
                    {t.detail !== undefined && t.detail !== "" && <pre>{t.detail.slice(0, 600)}</pre>}
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
    </>
  );
}
