import { normalizeRole } from "../lib/ship.server.js";
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

/**
 * Names of secrets `teploy-ship web` deliberately removed from this process's
 * environment (they belong to the worker). Reported, not read.
 */
const WORKER_ONLY = new Set(
  (process.env.SHIP_WORKER_ONLY_SECRETS ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== ""),
);

/**
 * Present a secret as set/unset without ever revealing it.
 *
 * A secret scoped to the worker is NOT absent — this process cannot see it by
 * design. Reporting that as "not set" would send an operator to re-set a
 * credential that was never wrong.
 */
function secret(name: string): Row {
  if (WORKER_ONLY.has(name)) {
    return { label: name, value: "set — scoped to the worker, not readable here", ok: true };
  }
  const v = process.env[name];
  return { label: name, value: v !== undefined && v !== "" ? "set" : "not set", ok: v !== undefined && v !== "" };
}

/** "1", "true", "yes" — the worker's own reading of an on/off env flag. */
function flagOn(name: string): boolean {
  return ["1", "true", "yes"].includes((process.env[name] ?? "").trim().toLowerCase());
}

function value(name: string, fallback = "not set"): Row {
  const v = process.env[name];
  return { label: name, value: v !== undefined && v !== "" ? v : fallback, ok: v !== undefined && v !== "" };
}

/**
 * A URL with any embedded credentials stripped.
 *
 * A value that does not parse is NOT shown. It used to fall through unchanged,
 * so a malformed connection string — the exact shape that carries a password in
 * the middle of it — was printed verbatim to everyone who can read this page.
 * An unparseable value tells the operator nothing useful anyway; that it is set
 * and malformed is the whole message.
 */
function safeUrl(name: string): Row {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return { label: name, value: "not set" };
  try {
    const u = new URL(raw);
    if (u.password !== "" || u.username !== "") {
      u.password = "";
      u.username = u.username !== "" ? "***" : "";
      return { label: name, value: u.toString(), ok: true };
    }
    return { label: name, value: raw, ok: true };
  } catch {
    return { label: name, value: "set, but not a valid URL (hidden — it may contain a credential)", ok: false };
  }
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
        rows: [safeUrl("AI_GATEWAY_URL"), secret("AI_GATEWAY_KEY"), secret("ANTHROPIC_API_KEY"), secret("OPENAI_API_KEY"), num("SHIP_MAX_STEPS", "40")],
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
        title: "Evidence on the pull request",
        rows: [
          { label: "tests", value: flagOn("SHIP_TESTS") ? "enabled" : "disabled", ok: flagOn("SHIP_TESTS"), hint: "SHIP_TESTS — the suite runs after the agent stops, before the push" },
          value("SHIP_TEST_COMMAND", "not set (worker default)"),
          { label: "telemetry", value: flagOn("SHIP_TELEMETRY") ? "enabled" : "disabled", ok: flagOn("SHIP_TELEMETRY"), hint: "SHIP_TELEMETRY — error rate and latency either side of the change" },
          value("OBSERVE_SERVICE", "not set"),
          { ...value("OBSERVE_REPO", "not set — telemetry leg is off"), hint: "the repo the service belongs to; required, so metrics never land on an unrelated PR" },
          secret("OBSERVE_READ_TOKEN"),
          { label: "preview", value: flagOn("SHIP_PREVIEW") ? "enabled" : "disabled", ok: flagOn("SHIP_PREVIEW"), hint: "SHIP_PREVIEW — deploy the branch with the teploy CLI" },
          value("SHIP_PREVIEW_DIR", "not set — preview leg is off"),
          { label: "per-repo overrides", value: "teploy-ship evidence set <repo> --test-command … --observe-service …", hint: "win over these worker-wide defaults" },
        ],
      },
      {
        title: "Intake",
        rows: [
          secret("SHIP_WEBHOOK_SECRET"),
          value("SHIP_PUBLIC_URL", "not set — webhook URLs on Sources show a placeholder"),
          value("SHIP_INTAKE_POLICIES", "not set — every source proposes; edit on Sources"),
        ],
      },
      {
        title: "Git & access",
        rows: [
          { ...secret("SHIP_GIT_TOKENS"), hint: "per-origin deploy tokens, JSON — the preferred form" },
          { ...secret("SHIP_GIT_TOKEN"), hint: "single deploy token; needs SHIP_REPO_ALLOWLIST to say where it may be sent" },
          { ...secret("SHIP_GITHUB_TOKEN"), hint: "GitHub API token for pull requests and review replies" },
          value("SHIP_REPO_ALLOWLIST", "not set"),
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

/**
 * Re-check the last-admin rule AFTER the change and undo it if it was broken.
 *
 * The check above reads the user list and then acts, so two admins demoting
 * each other at the same moment both saw two admins and both committed,
 * leaving zero. There is no transaction across these stores to lean on, so the
 * rule is enforced by verifying the postcondition and rolling back — which is
 * safe because the only thing being restored is the role we just replaced.
 */
async function ensureAdminRemains(runtime: ShipRuntime, undo: () => Promise<void>): Promise<void> {
  const after = await runtime.users.list();
  if (after.some((u) => u.role === "admin")) return;
  await undo().catch(() => {});
  throw new Error("cannot remove or demote the last admin (another admin was changed at the same time)");
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
      const before = (await runtime.users.get(username))?.role;
      await guardLastAdmin(runtime, username, role);
      await runtime.users.setRole(username, role);
      if (before !== undefined) await ensureAdminRemains(runtime, () => runtime.users.setRole(username, before));
      return { ok: `${username} is now ${role}.` };
    }
    if (intent === "password") {
      await runtime.users.setPassword(username, String(form.get("password") ?? ""));
      return { ok: `Password reset for ${username}.` };
    }
    if (intent === "delete") {
      await guardLastAdmin(runtime, username, null);
      await runtime.users.remove(username);
      // No undo for a deletion (the password hash is gone), so the recovery is
      // to restore SOME admin: the operator still has the master credential.
      const after = await runtime.users.list();
      if (!after.some((u) => u.role === "admin")) {
        return {
          error:
            `Removed ${username}, but that left no admin account — another admin was changed at the same time. ` +
            `Sign in with SHIP_WEB_TOKEN and promote someone.`,
        };
      }
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
