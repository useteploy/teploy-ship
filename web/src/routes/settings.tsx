import {
  AKIROO_ORG_ID_KEY,
  AKIROO_ORG_NAME_KEY,
  AKIROO_TOKEN_KEY,
  AKIROO_URL_KEY,
  akirooSourceLabel,
  normalizeRole,
  resolveAkirooTarget,
  sealingStatus,
} from "../lib/ship.server.js";
import type { AkirooResolution, ResolvedValue, Role, UserView, ShipRuntime } from "teploy-ship/runtime";

import { shipRuntime, defaultModel } from "../lib/store.server.js";
import { SETTINGS_VIEWS, settingsView, groupVisible, settingLabel, groupLabel } from "../views/settings-views.js";
import { currentUser } from "../lib/session.server.js";
import type { Principal } from "../lib/session.server.js";

export const config = { mode: "app" };

// Mirrors HARNESS_PACKAGES (src/harness.ts), which mirrors images/versions.json
// under a test. Named here rather than imported because this route is SSR'd
// from source and the value is display copy, not behaviour.
const BAKED_HARNESSES = "claude-code 2.1.246, opencode 1.18.23 — images/build.sh --harness <id>";

interface Row {
  label: string;
  value: string;
  ok?: boolean; // green when a required/effective thing is present
  hint?: string;
  /** A same-site page that acts on this row. Rendered as a link after the hint. */
  action?: { href: string; label: string };
}

interface Group {
  title: string;
  rows: Row[];
}

interface SettingsData {
  view: import("../views/settings-views.js").SettingsView;
  groups: Group[];
  users: UserView[];
  me: Principal;
  /** Set when the operator has just come back from a completed connect. */
  connected?: string;
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
function safeUrlRow(label: string, raw: string | undefined): Row {
  if (raw === undefined || raw === "") return { label, value: "not set" };
  try {
    const u = new URL(raw);
    if (u.password !== "" || u.username !== "") {
      u.password = "";
      u.username = u.username !== "" ? "***" : "";
      return { label, value: u.toString(), ok: true };
    }
    return { label, value: raw, ok: true };
  } catch {
    return { label, value: "set, but not a valid URL (hidden — it may contain a credential)", ok: false };
  }
}

function safeUrl(name: string): Row {
  return safeUrlRow(name, process.env[name]);
}

/**
 * A URL row for a value that may have come from the runtime config store
 * rather than the environment, saying which.
 *
 * The source is not decoration. A connect handshake overrides AKIROO_URL, and
 * an override nobody can see is the thing that costs an hour: the manifest says
 * one workspace, the worker polls another, and every explanation starts from
 * the wrong file.
 */
function resolvedUrlRow(label: string, resolved: ResolvedValue): Row {
  const row = safeUrlRow(label, resolved.value === "" ? undefined : resolved.value);
  return { ...row, hint: akirooSourceLabel(resolved.source) };
}

/**
 * A secret row for a value that may have come from the store. Still only ever
 * set/not set — the source changes where it was written, not whether it may be
 * printed. Falls back to the env reporter so a worker-scoped secret keeps
 * saying "scoped to the worker" rather than "not set".
 */
function resolvedSecretRow(name: string, resolved: ResolvedValue): Row {
  if (resolved.source === "runtime") {
    return { label: name, value: "set", ok: true, hint: akirooSourceLabel("runtime") };
  }
  return { ...secret(name), hint: akirooSourceLabel(resolved.source) };
}

/** The connector line: what it is doing, or why it is not doing it. */
function akirooConnectorRow(akiroo: AkirooResolution): Row {
  if (akiroo.status === "misconfigured") {
    return { label: "connector", value: `misconfigured — ${akiroo.reason ?? "half-set"}`, ok: false };
  }
  if (akiroo.status === "unset") {
    return {
      label: "connector",
      value: "disabled — no workspace connected",
      ok: false,
      // Ship starts the connect, so the button is here rather than on Akiroo.
      // A connect that begins anywhere else cannot complete: /connect/return
      // refuses anything this Ship has no local row for.
      hint: "Ship starts the connect; a link that arrives by mail cannot",
      action: { href: "/connect", label: "Connect a workspace" },
    };
  }
  return {
    label: "connector",
    value: akiroo.status === "runtime" ? "enabled — connected by handshake" : "enabled — configured by environment",
    ok: true,
    hint: "the worker COLLECTS work from Akiroo — outbound HTTPS only, no open port, no tunnel, no public URL",
    action: { href: "/connect", label: "Connect a different workspace" },
  };
}

/**
 * Whether the stored pull token is encrypted at rest, said out loud.
 *
 * It is NOT by default, and cannot be without an operator setting a key: see
 * the note on sealingKey in runtime-config.ts for why no existing per-install
 * secret reaches both the dashboard and a joined worker. That makes this a
 * standing property of most installs rather than a transient state, which is
 * exactly the kind of thing that must appear on a page someone reads rather
 * than only in a source comment.
 */
function sealingRow(): Row {
  const sealing = sealingStatus();
  return {
    label: "token at rest",
    value: sealing.sealed ? "encrypted (SHIP_CONFIG_KEY)" : "stored in the clear",
    ok: sealing.sealed,
    hint: sealing.detail,
  };
}

export async function loader({ request }: { request: Request }): Promise<SettingsData> {
  const runtime = await shipRuntime();
  const num = (name: string, def: string): Row => value(name, `default (${def})`);
  const me = (await currentUser(request)) ?? { user: "token", role: "admin" as Role };
  const users = await runtime.users.list();
  const params = new URL(request.url).searchParams;
  const view = settingsView(params.get("view"));
  const justConnected = params.get("connected") === "1";

  const sandboxOn = (process.env.SHIP_SANDBOX_URL ?? "") !== "";
  // Resolved before the literal below, because the Akiroo rows report a store
  // value when there is one and the store read is async. Resolved as a PAIR
  // (resolveAkirooTarget), never per value: a runtime URL beside an environment
  // token is a refusal, not a merge.
  const akiroo = await resolveAkirooTarget(runtime.config);
  const workspace =
    (await runtime.config.get(AKIROO_ORG_NAME_KEY)) ?? (await runtime.config.get(AKIROO_ORG_ID_KEY)) ?? "";
  return {
    view,
    me,
    users,
    // Read from the store, never from the redirect: the point of landing here
    // is to see what this Ship is actually bound to now.
    ...(justConnected && akiroo.target !== undefined ? { connected: akiroo.target.url } : {}),
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
        title: "Harness",
        rows: [
          { label: "harness", value: (process.env.SHIP_HARNESS ?? "").trim() || "native", ok: true, hint: "SHIP_HARNESS — the worker-wide DEFAULT: native (Ship's loop) | claude-code | opencode. A project record's harness field wins for that repo. Recorded on each run at enqueue, so a replay runs under the program that wrote its log." },
          {
            label: "baked harnesses",
            value: BAKED_HARNESSES,
            ok: true,
            hint: "what images/build.sh installs into a sandbox image, pinned in images/versions.json. Harnesses are BAKED, never installed per run: a run-time install needs sandbox egress and lets the binary drift under a running worker, which breaks replay. The image a repo boots must already carry the binary its harness names.",
          },
          value("SHIP_HARNESS_ATTEMPTS", "not set — one attempt per run"),
          value("SHIP_HARNESS_MODEL", "not set — the harness's own default"),
          value("SHIP_HARNESS_ENV", "not set — per-adapter default credential names"),
          num("SHIP_HARNESS_TIMEOUT_MS", "1800000"),
          secret("CLAUDE_CODE_OAUTH_TOKEN"),
        ],
      },
      {
        title: "Budget & capacity",
        rows: [
          num("SHIP_DAILY_BUDGET_USD", "$10"),
          num("SHIP_DAILY_AUTO_LIMIT", "10"),
          {
            ...value("SHIP_MAX_CONCURRENT_RUNS", "not set — derived from the box"),
            hint: "an OVERRIDE. Unset, each worker measures its cores, memory and docker-root free space and derives its own ceiling every 15s (Fleet shows the binding constraint). Set, this number wins outright and the measurement is ignored.",
          },
          {
            ...num("SHIP_MIN_FREE_MB", "600"),
            hint: "hold launches below this much MemAvailable; due runs wait, nothing is dropped. 0 disables",
          },
          { ...num("SHIP_MAX_LOAD_PER_CPU", "1.5"), hint: "hold launches above this 1-minute load per core. 0 disables" },
          {
            ...num("SHIP_MIN_FREE_DISK_MB", "2048"),
            hint: "hold launches below this much free space on the docker root — a full disk breaks the daemon for every tenant on the box. 0 disables",
          },
          { ...num("SHIP_MAX_INODE_USED_PCT", "95"), hint: "hold launches above this share of inodes used; caches of tiny files exhaust these before bytes. 0 disables" },
          { ...value("SHIP_DISK_PATH", "not set — /var/lib/docker, then /"), hint: "which mount to measure, when docker's root is not on either" },
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
          // "not set" would read as "no network", which is what it used to
          // mean and no longer does.
          value("SHIP_SANDBOX_NETWORK", "allowlist (default)"),
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
        title: "Akiroo (work in, pulled)",
        rows: [
          akirooConnectorRow(akiroo),
          resolvedUrlRow(AKIROO_URL_KEY, akiroo.url),
          resolvedSecretRow(AKIROO_TOKEN_KEY, akiroo.token),
          sealingRow(),
          ...(workspace !== "" ? [{ label: "workspace", value: workspace, ok: true, hint: "recorded by the connect handshake" }] : []),
          {
            label: "last collected",
            value: "shown on Akiroo's Connections card",
            // Deliberately not mirrored here: Akiroo is the side that observes
            // the poll arriving, so its answer is the true one. A second copy
            // computed from this process could disagree with it and there would
            // be no way to tell which was right.
            hint: "Akiroo records when a Ship last polled; a queue that is not falling means this worker is not running",
          },
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

function ConfigGroup({ group, advanced }: { group: Group; advanced: boolean }) {
  const rows = group.rows.map(row => <div class="config-row" key={row.label}>
    <div class="config-label">{settingLabel(row.label)}{row.label.includes("_") && <code class="config-key">{row.label}</code>}</div>
    <div class="config-value"><span>{row.value}</span>
      {row.hint && <details><summary>Configuration details</summary><p class="meta">{row.hint}</p></details>}
      {row.action && <p class="meta"><a href={row.action.href}>{row.action.label} →</a></p>}
    </div>
  </div>);
  return advanced ? <details class="config-section"><summary>{groupLabel(group.title)} <span class="count">· {group.rows.length} values</span></summary>{rows}</details>
    : <section class="config-section"><h3>{groupLabel(group.title)}</h3>{rows}</section>;
}

export default function Settings({ data, actionData }: { data: SettingsData; actionData?: { error?: string; ok?: string } }) {
  const title = SETTINGS_VIEWS.find(view => view.key === data.view)?.label ?? "Overview";
  const rowValue = (group: string, label: string) => data.groups.find(g => g.title === group)?.rows.find(r => r.label === label)?.value ?? "Not configured";
  return <>
    <div class="page-heading"><div><h1 class="page">Settings</h1><p class="meta">Manage your team, connections, and how Ship runs your work.</p></div><a class="button" href="/account">Your account</a></div>
    {data.connected && <p class="notice" role="status">Connected to <b>{data.connected}</b>. Your worker will pick up the connection on its next poll.</p>}
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Settings navigation">{SETTINGS_VIEWS.map(view => <a key={view.key} href={view.href} class={view.key === data.view ? "active" : undefined} aria-current={view.key === data.view ? "page" : undefined}>{view.label}</a>)}</nav>
      <div class="settings-content">
        {data.view === "overview" && <>
          <h2>Workspace overview</h2><p class="meta">Start with the setting you want to change. Repository-specific choices live in Projects.</p>
          <section class="config-section"><h3>Current defaults</h3>
            <div class="config-row"><span class="config-label">Model</span><span class="config-value">{rowValue("Runtime", "model")}</span></div>
            <div class="config-row"><span class="config-label">Agent harness</span><span class="config-value">{rowValue("Harness", "harness")}</span></div>
            <div class="config-row"><span class="config-label">Daily budget (USD)</span><span class="config-value">{rowValue("Budget & capacity", "SHIP_DAILY_BUDGET_USD")}</span></div>
          </section>
          <div class="settings-cards">
            <a class="card" href="/settings?view=team"><h3>Team & access →</h3><p>Add teammates, assign roles, and reset passwords.</p><span class="chip">{data.users.length} named accounts</span></a>
            <a class="card" href="/settings?view=integrations"><h3>Connections →</h3><p>Connect Akiroo and inspect Git, webhook, and Observe configuration.</p></a>
            <a class="card" href="/projects"><h3>Project configuration →</h3><p>Choose a harness, sandbox, test command, and automation policy for each repository.</p></a>
            <a class="card" href="/policies"><h3>Approval rules →</h3><p>Decide who can launch work and what may run unattended.</p></a>
            <a class="card" href="/fleet?view=spend"><h3>Usage & spending →</h3><p>Review costs, budget limits, and unpriced runs.</p></a>
            <a class="card" href="/settings?view=models"><h3>Models & execution →</h3><p>Inspect worker defaults for model access, capacity, and verification.</p></a>
          </div>
        </>}
        {data.view === "team" && <>
      <h2>Team & access</h2>
      <p class="meta">
        Accounts and roles for this dashboard. <b>Admin</b> manages users, sources, and secrets; <b>editor</b> approves
        runs and launches work; <b>viewer</b> is read-only. Access governs this dashboard — the SHIP_WEB_TOKEN remains an
        admin master credential and API bearer.
      </p>
      {actionData?.error !== undefined && <p style="color:var(--red)">{actionData.error}</p>}
      {actionData?.ok !== undefined && <p style="color:var(--green)">{actionData.ok}</p>}

      <form method="post" class="team-form">
        <input type="hidden" name="intent" value="create" />
        <label class="field">Username<input type="text" name="username" placeholder="e.g. alex" required autoComplete="off" /></label>
        <label class="field">Temporary password<input type="password" name="password" placeholder="At least 8 characters" minLength={8} required autoComplete="new-password" /></label>
        <label class="field">Role<select name="role">
          {ROLE_OPTS.map((r) => (
            <option key={r} value={r} selected={r === "editor"}>{r}</option>
          ))}
        </select></label>
        <button class="primary" type="submit">Add user</button>
      </form>

      <div class="table-wrap"><table class="runs">
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
                  <select name="role" aria-label={`Role for ${u.username}`} style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px">
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
                  <input type="password" name="password" aria-label={`New password for ${u.username}`} placeholder="New password" minLength={8} required style="background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px" />
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
      </table></div>

        </>}
        {data.view !== "overview" && data.view !== "team" && <>
          <h2>{title}</h2>
          <p class="meta">{data.view === "integrations" ? "Services that bring work into Ship and carry results back." : data.view === "models" ? "Worker defaults for new runs. A project's configuration takes precedence." : "Detailed configuration reported by this server. Expand a section to inspect its values."}</p>
          <p class="notice"><b>Configuration reference.</b> These values are read-only here. Change worker defaults through your deployment environment and redeploy. Secrets are never displayed. <a href="/projects">Edit project overrides →</a></p>
          {data.groups.filter(group => groupVisible(data.view, group.title)).map(group => <ConfigGroup key={group.title} group={group} advanced={data.view === "system"} />)}
        </>}
      </div>
    </div>
  </>;
}
