import { normalizeRole } from "teploy-ship/runtime";
import type { Role, UserView, ShipRuntime } from "teploy-ship/runtime";

import { shipRuntime, defaultModel } from "../lib/store.server.js";
import { currentUser } from "../lib/session.server.js";
import type { Principal } from "../lib/session.server.js";

export const config = { mode: "app" };

interface Row {
  label: string;
  value: string;
  ok?: boolean; // green when a required/effective thing is present
  hint?: string;
}

interface Group {
  title: string;
  rows: Row[];
}

interface SettingsData {
  groups: Group[];
  users: UserView[];
  me: Principal;
}

/** Present a secret as set/unset without ever revealing it. */
function secret(name: string): Row {
  const v = process.env[name];
  return { label: name, value: v !== undefined && v !== "" ? "set" : "not set", ok: v !== undefined && v !== "" };
}

function value(name: string, fallback = "not set"): Row {
  const v = process.env[name];
  return { label: name, value: v !== undefined && v !== "" ? v : fallback, ok: v !== undefined && v !== "" };
}

/** A URL with any embedded credentials stripped. */
function safeUrl(name: string): Row {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return { label: name, value: "not set" };
  let shown = raw;
  try {
    const u = new URL(raw);
    if (u.password !== "" || u.username !== "") {
      u.password = "";
      u.username = u.username !== "" ? "***" : "";
      shown = u.toString();
    }
  } catch {
    /* leave as-is if unparseable */
  }
  return { label: name, value: shown, ok: true };
}

export async function loader({ request }: { request: Request }): Promise<SettingsData> {
  const runtime = await shipRuntime();
  const num = (name: string, def: string): Row => value(name, `default (${def})`);
  const me = (await currentUser(request)) ?? { user: "token", role: "admin" as Role };
  const users = await runtime.users.list();

  const sandboxOn = (process.env.SHIP_SANDBOX_URL ?? "") !== "";
  return {
    me,
    users,
    groups: [
      {
        title: "Runtime",
        rows: [
          { label: "store", value: runtime.kind, ok: true },
          safeUrl("NUCLEUS_URL"),
          { label: "model", value: defaultModel(), ok: true, hint: "SHIP_MODEL" },
        ],
      },
      {
        title: "Budget & concurrency",
        rows: [
          num("SHIP_DAILY_BUDGET_USD", "$10"),
          num("SHIP_MAX_CONCURRENT_RUNS", "3"),
          num("SHIP_DAILY_AUTO_LIMIT", "10"),
        ],
      },
      {
        title: "AI gateway",
        rows: [safeUrl("AI_GATEWAY_URL"), secret("ANTHROPIC_API_KEY"), secret("OPENAI_API_KEY")],
      },
      {
        title: "Sandbox",
        rows: [
          { label: "sandbox", value: sandboxOn ? "enabled" : "disabled (runs on host)", ok: sandboxOn },
          safeUrl("SHIP_SANDBOX_URL"),
          value("SHIP_SANDBOX_IMAGE", "not set"),
          value("SHIP_SANDBOX_NETWORK", "not set"),
          secret("SHIP_SANDBOX_TOKEN"),
        ],
      },
      {
        title: "Observe (dogfood)",
        rows: [
          {
            label: "emitter",
            value: (process.env.OBSERVE_URL ?? "") !== "" && (process.env.OBSERVE_API_KEY ?? "") !== "" ? "enabled" : "disabled",
            ok: (process.env.OBSERVE_URL ?? "") !== "" && (process.env.OBSERVE_API_KEY ?? "") !== "",
            hint: "each completed run emits an LLM event to Observe",
          },
          safeUrl("OBSERVE_URL"),
          secret("OBSERVE_API_KEY"),
          value("OBSERVE_SITE", "from key"),
        ],
      },
      {
        title: "Git & access",
        rows: [
          secret("FORGEJO_TOKEN"),
          secret("GITHUB_TOKEN"),
          { ...secret("SHIP_WEB_TOKEN"), hint: "admin master credential + API bearer; rotate: teploy secret set SHIP_WEB_TOKEN <new> && redeploy" },
        ],
      },
    ],
  };
}

/** Refuse to remove or demote the last remaining admin — that would leave the
 * dashboard unmanageable. newRole === null means deletion. */
async function guardLastAdmin(runtime: ShipRuntime, username: string, newRole: Role | null): Promise<void> {
  const users = await runtime.users.list();
  const target = users.find((u) => u.username === username);
  if (target === undefined || target.role !== "admin") return;
  if (newRole === "admin") return; // still an admin — fine
  if (users.filter((u) => u.role === "admin").length <= 1) {
    throw new Error("cannot remove or demote the last admin");
  }
}

export async function action({ request }: { request: Request }): Promise<{ error?: string; ok?: string }> {
  const runtime = await shipRuntime();
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const username = String(form.get("username") ?? "");
  try {
    if (intent === "create") {
      await runtime.users.create(username, String(form.get("password") ?? ""), normalizeRole(String(form.get("role") ?? "viewer")));
      return { ok: `Added ${username}.` };
    }
    if (intent === "role") {
      const role = normalizeRole(String(form.get("role") ?? "viewer"));
      await guardLastAdmin(runtime, username, role);
      await runtime.users.setRole(username, role);
      return { ok: `${username} is now ${role}.` };
    }
    if (intent === "password") {
      await runtime.users.setPassword(username, String(form.get("password") ?? ""));
      return { ok: `Password reset for ${username}.` };
    }
    if (intent === "delete") {
      await guardLastAdmin(runtime, username, null);
      await runtime.users.remove(username);
      return { ok: `Removed ${username}.` };
    }
    return { error: "Unknown action." };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed." };
  }
}

const ROLE_OPTS: Role[] = ["viewer", "editor", "admin"];

export default function Settings({ data, actionData }: { data: SettingsData; actionData?: { error?: string; ok?: string } }) {
  return (
    <>
      <h1 class="page">Settings</h1>
      <p class="meta">
        The effective configuration this server is running. Set via environment on deploy (teploy.yml / secrets);
        secrets show only as set/not set. Policies are edited on <a href="/sources">Sources</a>.
      </p>

      <h2 class="section">Team access</h2>
      <p class="meta">
        Accounts and roles for this dashboard. <b>Admin</b> manages users, sources, and secrets; <b>editor</b> approves
        runs and launches work; <b>viewer</b> is read-only. Access governs this dashboard — the SHIP_WEB_TOKEN remains an
        admin master credential and API bearer.
      </p>
      {actionData?.error !== undefined && <p style="color:var(--red)">{actionData.error}</p>}
      {actionData?.ok !== undefined && <p style="color:var(--green)">{actionData.ok}</p>}

      <form method="post" class="row-actions" style="gap:8px;margin:12px 0 16px;flex-wrap:wrap">
        <input type="hidden" name="intent" value="create" />
        <input type="text" name="username" placeholder="username" required style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 10px" />
        <input type="password" name="password" placeholder="password (8+ chars)" required style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 10px" />
        <select name="role" style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 10px">
          {ROLE_OPTS.map((r) => (
            <option key={r} value={r} selected={r === "editor"}>{r}</option>
          ))}
        </select>
        <button type="submit">Add user</button>
      </form>

      <table class="runs">
        <thead>
          <tr><th>Username</th><th>Role</th><th>Reset password</th><th /></tr>
        </thead>
        <tbody>
          {data.users.length === 0 && (
            <tr><td colSpan={4} class="meta">No accounts yet — everyone signs in with the access token until you add one.</td></tr>
          )}
          {data.users.map((u) => (
            <tr key={u.username}>
              <td>{u.username}{u.username === data.me.user && <span class="meta"> · you</span>}</td>
              <td>
                <form method="post" class="row-actions" style="gap:6px">
                  <input type="hidden" name="intent" value="role" />
                  <input type="hidden" name="username" value={u.username} />
                  <select name="role" style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px">
                    {ROLE_OPTS.map((r) => (
                      <option key={r} value={r} selected={r === u.role}>{r}</option>
                    ))}
                  </select>
                  <button class="sm" type="submit">Save</button>
                </form>
              </td>
              <td>
                <form method="post" class="row-actions" style="gap:6px">
                  <input type="hidden" name="intent" value="password" />
                  <input type="hidden" name="username" value={u.username} />
                  <input type="password" name="password" placeholder="new password" style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px" />
                  <button class="sm" type="submit">Reset</button>
                </form>
              </td>
              <td style="text-align:right">
                {u.username !== data.me.user && (
                  <form method="post">
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="username" value={u.username} />
                    <button class="sm deny" type="submit">Remove</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {data.groups.map((g) => (
        <div key={g.title}>
          <h2 class="section">{g.title}</h2>
          <table class="runs">
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.label}>
                  <td class="meta" style="width:34%">{r.label}</td>
                  <td>
                    <span class={r.ok === false ? "meta" : ""} style={r.ok === false ? "color:var(--yellow)" : ""}>
                      {r.value}
                    </span>
                    {r.hint !== undefined && <span class="meta" style="margin-left:10px">· {r.hint}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </>
  );
}
