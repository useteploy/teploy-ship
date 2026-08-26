import type { AuthorityAction, Governance, Role } from "teploy-ship/runtime";

import { shipRuntime } from "../lib/store.server.js";
import { currentUser } from "../lib/session.server.js";
import { may, deniedMessage } from "../lib/authority.server.js";
import { AUTHORITY_ACTIONS, GLOBAL_WINDOW, autoAllowedNow, formatWindow } from "../lib/ship.server.js";
import { SubNav } from "../lib/subnav.js";
import { SETTINGS_VIEWS } from "../views/settings-views.js";

export const config = { mode: "app" };

const ROLES: Role[] = ["admin", "editor", "viewer"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ACTION_HELP: Record<AuthorityAction, string> = {
  approve: "approve or deny a parked run, launch a proposed task (code execution + spend)",
  auto: "set a source to auto (unattended execution)",
  steer: "steer or cancel a running run",
  policies: "change sources, windows, reviewers and these grants",
};

interface WindowRow {
  source: string;
  label: string;
  days: number[];
  start: string;
  end: string;
  tz: string;
  text: string;
  openNow: boolean;
}

interface PoliciesData {
  governance: Governance;
  windows: WindowRow[];
  actions: AuthorityAction[];
  canEdit: boolean;
  me: string;
  sources: string[];
}

export async function loader({ request }: { request: Request }): Promise<PoliciesData> {
  const runtime = await shipRuntime();
  const me = await currentUser(request);
  const [governance, canEdit, policies] = await Promise.all([runtime.governance.get(), may("policies", me), runtime.policies.list()]);
  const now = new Date();
  const windows: WindowRow[] = Object.entries(governance.windows)
    .sort(([a], [b]) => (a === GLOBAL_WINDOW ? -1 : b === GLOBAL_WINDOW ? 1 : a < b ? -1 : 1))
    .map(([source, w]) => ({
      source,
      label: source === GLOBAL_WINDOW ? "all sources" : source,
      days: w.days,
      start: w.start,
      end: w.end,
      tz: w.tz,
      text: formatWindow(w),
      openNow: autoAllowedNow(governance.windows, source, now),
    }));
  return {
    governance,
    windows,
    actions: [...AUTHORITY_ACTIONS],
    canEdit,
    me: me?.user ?? "",
    sources: policies.map((p) => p.source).sort(),
  };
}

type ActionResult = { error?: string; ok?: string };

export async function action({ request }: { request: Request }): Promise<ActionResult> {
  const runtime = await shipRuntime();
  const me = await currentUser(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const list = (name: string): string[] =>
    String(form.get(name) ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== "");
  try {
    if (!(await may("policies", me))) return { error: deniedMessage("policies") };

    if (intent === "authority") {
      const actionName = String(form.get("action") ?? "");
      if (!(AUTHORITY_ACTIONS as readonly string[]).includes(actionName)) return { error: "Unknown authority action." };
      const roles = form.getAll("roles").map(String).filter((r): r is Role => (ROLES as string[]).includes(r));
      const users = list("users");
      // The person editing must not lock everyone out of editing: the grant
      // for `policies` has to keep at least one role or user.
      if (actionName === "policies" && roles.length === 0 && users.length === 0) {
        return { error: "The policies grant needs at least one role or user, or nobody could change it again." };
      }
      await runtime.governance.setAuthority(actionName as AuthorityAction, { roles, users });
      return { ok: `${actionName}: roles ${roles.join(", ") || "none"}; users ${users.join(", ") || "none"}.` };
    }

    if (intent === "window") {
      const source = String(form.get("source") ?? "").trim();
      const days = form.getAll("days").map((d) => Number(d));
      await runtime.governance.setWindow(source, {
        days,
        start: String(form.get("start") ?? ""),
        end: String(form.get("end") ?? ""),
        tz: String(form.get("tz") ?? "").trim(),
      });
      return { ok: `Window saved for ${source === "" || source === GLOBAL_WINDOW ? "all sources" : source}.` };
    }
    if (intent === "window-remove") {
      const source = String(form.get("source") ?? "").trim();
      await runtime.governance.setWindow(source, null);
      return { ok: `Window removed for ${source === "" || source === GLOBAL_WINDOW ? "all sources" : source}.` };
    }

    if (intent === "reviewers") {
      const repo = String(form.get("repo") ?? "").trim();
      if (repo === "") return { error: "A repository (owner/name or URL) is required." };
      const users = list("users");
      const teams = list("teams");
      await runtime.governance.setReviewers({ repo, users, teams });
      return { ok: users.length === 0 && teams.length === 0 ? `Reviewer rule removed for ${repo}.` : `Reviewers saved for ${repo}.` };
    }
    if (intent === "reviewers-remove") {
      const repo = String(form.get("repo") ?? "").trim();
      await runtime.governance.setReviewers({ repo, users: [], teams: [] });
      return { ok: `Reviewer rule removed for ${repo}.` };
    }
    return { error: "Unknown action." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed." };
  }
}

const field = "background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 8px;font:inherit";

function WindowForm({ row, sources, canEdit }: { row?: WindowRow; sources: string[]; canEdit: boolean }) {
  const days = row?.days ?? [1, 2, 3, 4, 5];
  return (
    <form method="post" class="row-actions" style="flex-wrap:wrap;gap:10px;align-items:center">
      <input type="hidden" name="intent" value="window" />
      {row !== undefined ? (
        <>
          <input type="hidden" name="source" value={row.source === GLOBAL_WINDOW ? "" : row.source} />
          <span class="chip" style="min-width:90px">{row.label}</span>
        </>
      ) : (
        <>
          <input type="text" name="source" list="policy-sources" placeholder="source (blank = all)" style={`${field};width:170px`} />
          <datalist id="policy-sources">
            {sources.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </>
      )}
      <span class="row-actions" style="gap:4px;flex-wrap:wrap">
        {DAYS.map((d, i) => (
          <label key={d} class="meta" style="display:inline-flex;align-items:center;gap:3px">
            <input type="checkbox" name="days" value={String(i)} checked={days.includes(i)} />
            {d}
          </label>
        ))}
      </span>
      <input type="time" name="start" value={row?.start ?? "09:00"} required style={field} />
      <span class="meta">to</span>
      <input type="time" name="end" value={row?.end ?? "18:00"} required style={field} />
      <input type="text" name="tz" value={row?.tz ?? ""} placeholder="IANA zone, e.g. Europe/Berlin" required style={`${field};width:190px`} />
      <button class="approve sm" type="submit" disabled={!canEdit}>{row !== undefined ? "Save" : "Add window"}</button>
    </form>
  );
}

export default function Policies({ data, actionData }: { data: PoliciesData; actionData?: ActionResult }) {
  const g = data.governance;
  return (
    <>
      <h1 class="page">Settings</h1>
      <SubNav items={SETTINGS_VIEWS} current="governance" />
      <p class="meta">
        Who may do what, when auto sources may run unattended, and who reviews what Ship opens. Per-source
        ignore / propose / auto and budgets are on <a href="/projects?view=sources">Sources</a>. The CLI edits the same store:{" "}
        <code>teploy-ship policy</code>.
      </p>
      {actionData?.error !== undefined && <p class="card attn" style="margin:12px 0;color:var(--red)">{actionData.error}</p>}
      {actionData?.ok !== undefined && <p class="card" style="margin:12px 0;color:var(--green)">{actionData.ok}</p>}
      {!data.canEdit && (
        <p class="card" style="margin:12px 0;color:var(--dim)">
          Read-only: {data.me || "this account"} does not hold the <b>policies</b> grant below. An admin can add a role or a
          named user to it.
        </p>
      )}

      <h2 class="section">Authority</h2>
      <p class="meta">
        A grant names the roles and, optionally, individual users allowed to act. Anyone not named is refused,
        whatever their role. Users are the stable ids from Settings (or <code>issuer#sub</code> for SSO).
      </p>
      <table class="runs">
        <thead>
          <tr><th>action</th><th>roles</th><th>named users</th><th /></tr>
        </thead>
        <tbody>
          {data.actions.map((a) => {
            const grant = g.authority[a];
            return (
              <tr key={a}>
                <td>
                  <form method="post" id={`authority-${a}`}>
                    <input type="hidden" name="intent" value="authority" />
                    <input type="hidden" name="action" value={a} />
                  </form>
                  <b>{a}</b>
                  <div class="meta">{ACTION_HELP[a]}</div>
                </td>
                <td>
                  {ROLES.map((r) => (
                    <label key={r} class="meta" style="display:inline-flex;align-items:center;gap:4px;margin-right:10px">
                      <input type="checkbox" name="roles" value={r} form={`authority-${a}`} checked={grant.roles.includes(r)} />
                      {r}
                    </label>
                  ))}
                </td>
                <td>
                  <input
                    type="text"
                    name="users"
                    form={`authority-${a}`}
                    value={grant.users.join(", ")}
                    placeholder="none — comma-separated"
                    style={`${field};width:100%;min-width:160px`}
                  />
                </td>
                <td style="text-align:right">
                  <button class="approve sm" type="submit" form={`authority-${a}`} disabled={!data.canEdit}>Save</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h2 class="section">Auto windows</h2>
      <p class="meta">
        Outside its window an <b>auto</b> source behaves as <b>propose</b>: the task waits in the Inbox for a person
        instead of launching unattended. A source's own window overrides the one for all sources. Times are wall clock
        in the zone given; a window ending before it starts runs overnight.
      </p>
      {data.windows.length === 0 && (
        <p class="empty">No windows — auto sources may launch at any hour.</p>
      )}
      {data.windows.map((w) => (
        <div key={w.source} class={`card${w.openNow ? "" : " attn"}`}>
          <div class="meta" style="margin-bottom:6px">
            {w.text} · {w.openNow ? <span style="color:var(--green)">open now</span> : <span style="color:var(--yellow)">closed now — auto tasks park as propose</span>}
          </div>
          <div class="row-actions" style="flex-wrap:wrap;gap:10px;align-items:flex-start">
            <WindowForm row={w} sources={data.sources} canEdit={data.canEdit} />
            <form method="post">
              <input type="hidden" name="intent" value="window-remove" />
              <input type="hidden" name="source" value={w.source === GLOBAL_WINDOW ? "" : w.source} />
              <button class="deny sm" type="submit" disabled={!data.canEdit}>Remove</button>
            </form>
          </div>
        </div>
      ))}
      <div class="card">
        <WindowForm sources={data.sources} canEdit={data.canEdit} />
      </div>

      <h2 class="section">Required reviewers</h2>
      <p class="meta">
        Per repository (owner/name), the reviewers and teams every pull request Ship opens there must request. Applied
        to runs enqueued after the rule is saved; the request is a recorded step on the run, and a request the forge
        refuses is recorded as such — the pull request still opens.
      </p>
      <table class="runs">
        <thead>
          <tr><th>repository</th><th>users</th><th>teams</th><th /></tr>
        </thead>
        <tbody>
          {g.reviewers.length === 0 && (
            <tr><td colSpan={4} class="meta">No reviewer rules — pull requests open without a requested reviewer.</td></tr>
          )}
          {g.reviewers.map((r) => (
            <tr key={r.repo}>
              <td>
                <form method="post" id={`reviewers-${r.repo}`}>
                  <input type="hidden" name="intent" value="reviewers" />
                  <input type="hidden" name="repo" value={r.repo} />
                </form>
                <code>{r.repo}</code>
              </td>
              <td><input type="text" name="users" form={`reviewers-${r.repo}`} value={r.users.join(", ")} placeholder="none" style={`${field};width:100%;min-width:140px`} /></td>
              <td><input type="text" name="teams" form={`reviewers-${r.repo}`} value={r.teams.join(", ")} placeholder="none" style={`${field};width:100%;min-width:120px`} /></td>
              <td style="text-align:right;white-space:nowrap">
                <button class="approve sm" type="submit" form={`reviewers-${r.repo}`} disabled={!data.canEdit}>Save</button>{" "}
                <form method="post" style="display:inline">
                  <input type="hidden" name="intent" value="reviewers-remove" />
                  <input type="hidden" name="repo" value={r.repo} />
                  <button class="deny sm" type="submit" disabled={!data.canEdit}>Remove</button>
                </form>
              </td>
            </tr>
          ))}
          <tr>
            <td>
              <form method="post" id="reviewers-new">
                <input type="hidden" name="intent" value="reviewers" />
              </form>
              <input type="text" name="repo" form="reviewers-new" placeholder="owner/name or clone URL" required style={`${field};width:100%;min-width:180px`} />
            </td>
            <td><input type="text" name="users" form="reviewers-new" placeholder="alice, bob" style={`${field};width:100%;min-width:140px`} /></td>
            <td><input type="text" name="teams" form="reviewers-new" placeholder="core" style={`${field};width:100%;min-width:120px`} /></td>
            <td style="text-align:right"><button class="approve sm" type="submit" form="reviewers-new" disabled={!data.canEdit}>Add</button></td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
