import { shipRuntime, defaultModel } from "../lib/store.server.js";

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

export async function loader(): Promise<SettingsData> {
  const runtime = await shipRuntime();
  const num = (name: string, def: string): Row => value(name, `default (${def})`);

  const sandboxOn = (process.env.SHIP_SANDBOX_URL ?? "") !== "";
  return {
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
        rows: [
          safeUrl("AI_GATEWAY_URL"),
          secret("ANTHROPIC_API_KEY"),
          secret("OPENAI_API_KEY"),
        ],
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
        title: "Git & access",
        rows: [
          secret("FORGEJO_TOKEN"),
          secret("GITHUB_TOKEN"),
          {
            ...secret("SHIP_WEB_TOKEN"),
            hint: "rotate: teploy secret set SHIP_WEB_TOKEN <new> && redeploy",
          },
        ],
      },
    ],
  };
}

export default function Settings({ data }: { data: SettingsData }) {
  return (
    <>
      <h1 class="page">Settings</h1>
      <p class="meta">
        The effective configuration this server is running. Set via environment on deploy (teploy.yml / secrets);
        secrets show only as set/not set. Policies are edited on <a href="/sources">Sources</a>.
      </p>
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
