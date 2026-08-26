import { SubNav } from "../lib/subnav.js";
import { PROJECT_VIEWS } from "./project-views.js";
import type { SourcePolicy } from "teploy-ship/runtime";


// Sources Ship knows how to receive from, even before one has fired — so the
// operator can set a policy ahead of the first webhook.
export const KNOWN_SOURCES = ["forgejo", "github", "manual"];

export const POLICIES = ["ignore", "propose", "auto"] as const;


export interface SourceRow extends SourcePolicy {
  seen: boolean; // has a task actually arrived from this source?
  proposed: number;
  /** The auto window governing this source, if any, and whether it is open now. */
  window?: string;
  windowOpen?: boolean;
}


export interface SourcesData {
  view: "sources";
  rows: SourceRow[];
  store: string;
  hookBase: string;
  /** May this account change policies at all / set auto (governance.ts)? */
  canEdit: boolean;
  canAuto: boolean;
  denied: string | null;
}


function deniedText(denied: string): string {
  if (denied === "auto") return "your account may not set a source to auto. An admin can grant it on Policies.";
  return "your account may not change policies. An admin can grant it on Policies.";
}


function badge(policy: string): { cls: string; text: string } {
  if (policy === "auto") return { cls: "status", text: "auto" };
  if (policy === "ignore") return { cls: "meta", text: "ignore" };
  return { cls: "chip", text: "propose" };
}


export default function Sources({ data }: { data: SourcesData }) {
  return (
    <>
      <h1 class="page">Projects</h1>
      <SubNav items={PROJECT_VIEWS} current="sources" />
      {data.denied !== null && (
        <p class="card attn" style="margin:12px 0;color:var(--red)">
          Not applied — {deniedText(data.denied)}
        </p>
      )}
      {!data.canEdit && (
        <p class="card" style="margin:12px 0;color:var(--dim)">
          Read-only: your account may not change policies. An admin can grant it on <a href="/policies">Policies</a>.
        </p>
      )}
      <p class="meta">
        What happens to an incoming task, per source. <b>ignore</b> drops it · <b>propose</b> queues it for your
        approval in the Inbox · <b>auto</b> launches it immediately (bounded by the source's daily budget). · store: {data.store}
        {data.store === "file" && " · file store has no worker — auto has no effect here"}
      </p>

      {data.rows.map((r) => {
        const b = badge(r.policy);
        return (
          <div key={r.source} class={`card${r.policy === "auto" ? " attn" : ""}`}>
            <form method="post" class="row-actions" style="flex-wrap:wrap;gap:12px;align-items:center">
              <input type="hidden" name="source" value={r.source} />
              <span class="chip" style="min-width:72px">{r.source}</span>
              <span class={b.cls}>{b.text}</span>
              {r.proposed > 0 && <span class="count">{r.proposed} proposed</span>}
              {!r.seen && <span class="meta">no tasks yet</span>}
              {r.policy === "auto" && r.window !== undefined && (
                <span class="meta" style={r.windowOpen ? "" : "color:var(--yellow)"}>
                  window {r.window} · {r.windowOpen ? "open now" : "closed now — tasks park as propose"}
                </span>
              )}
              <span style="flex:1" />
              <label class="meta">
                policy{" "}
                <select name="policy" style="margin-left:4px">
                  {POLICIES.map((p) => (
                    <option key={p} value={p} selected={p === r.policy}>{p}</option>
                  ))}
                </select>
              </label>
              <label class="meta">
                daily $
                <input
                  type="number"
                  name="budget"
                  min="0"
                  step="0.5"
                  placeholder="default"
                  value={r.dailyBudgetUSD !== undefined ? String(r.dailyBudgetUSD) : ""}
                  style="width:88px;margin-left:4px"
                />
              </label>
              <button class="approve sm" type="submit">Save</button>
            </form>
          </div>
        );
      })}

      <h2 class="section">Add a source</h2>
      <div class="card">
        <form method="post" class="row-actions" style="flex-wrap:wrap;gap:12px;align-items:center">
          <input type="text" name="source" placeholder="source name, e.g. gitlab" style="min-width:180px" />
          <label class="meta">
            policy{" "}
            <select name="policy" style="margin-left:4px">
              {POLICIES.map((p) => (
                <option key={p} value={p} selected={p === "propose"}>{p}</option>
              ))}
            </select>
          </label>
          <label class="meta">
            daily $<input type="number" name="budget" min="0" step="0.5" placeholder="default" style="width:88px;margin-left:4px" />
          </label>
          <button class="approve sm" type="submit">Add</button>
        </form>
      </div>

      <h2 class="section">Webhook endpoints</h2>
      <p class="meta">
        Point your git host's webhook here and label an issue/PR <code>ship</code>. The label is the trigger; this
        page decides what the labeled task becomes.
      </p>
      <table class="runs">
        <thead>
          <tr><th>source</th><th>webhook path</th></tr>
        </thead>
        <tbody>
          <tr><td class="chip">forgejo</td><td class="meta">{data.hookBase || "<server-url>"}/hooks/forgejo</td></tr>
          <tr><td class="chip">github</td><td class="meta">{data.hookBase || "<server-url>"}/hooks/github</td></tr>
        </tbody>
      </table>
      {data.hookBase === "" && (
        <p class="meta" style="margin-top:8px">Set <code>SHIP_PUBLIC_URL</code> to show the full webhook URLs here.</p>
      )}
    </>
  );
}

