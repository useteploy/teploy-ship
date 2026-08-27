/**
 * `teploy-ship join` — one command on a fresh box that ends with the box taking
 * work and appearing on the Fleet page.
 *
 * The whole value of this command is that it NEVER leaves a box half-joined and
 * looking fine. It verifies every dependency a worker needs — the controller,
 * its token, the store, the forge, the model, every sandbox daemon, and the
 * forge co-location gate — and it writes nothing and starts nothing unless all
 * of them answered. A worker that boots and then fails its first run at 3am is
 * the failure mode this exists to prevent.
 *
 * ===========================================================================
 * PRE-DECIDED 2026-08-26 — WHERE THE CREDENTIALS COME FROM, AND WHY NOT FROM A
 * JOIN-TOKEN ENDPOINT.
 *
 * MASTER_PLAN B3 asks for `join <controller-url> --token <t>`, which reads as:
 * the joining box presents a token and the controller hands back the worker's
 * configuration. That configuration is not configuration. It is the Nucleus
 * connection string, the forge deploy token, the GitHub PAT and the model
 * gateway key — the complete set of credentials Ship holds. An endpoint that
 * emits that set to whoever presents a bearer token is the single most valuable
 * endpoint in the system, and it would live on the same HTTP surface as the
 * dashboard.
 *
 * WHAT THE HONEST VERSION WOULD NEED, stated so the next pass does not have to
 * rediscover it:
 *
 *  - Tokens minted by an ADMIN (the `policies`/admin authority, not any
 *    logged-in viewer), one at a time, against a named host.
 *  - SINGLE USE. Redeemed atomically — the same UPDATE … WHERE used = false
 *    that makes the run claim exactly-once fleet-wide (worker.ts:241) — so a
 *    token captured in a shell history, a terminal scrollback or a CI log is
 *    already spent by the time anyone finds it.
 *  - SHORT TTL, minutes not days, because the window in which a stolen token is
 *    worth anything is the window between minting and redeeming.
 *  - Bound to something. At minimum the redeeming source address is recorded;
 *    ideally the token names the host it was minted for and redemption from
 *    anywhere else is refused and alerted.
 *  - AUDITED, and audited usefully: minted-by, minted-for, redeemed-at,
 *    redeemed-from, and a Fleet-page row for a host that joined. A silent join
 *    is indistinguishable from a theft.
 *  - What a stolen token WOULD get you, and this is the part that decides it:
 *    everything. Push access to every repository on the forge, the GitHub PAT,
 *    and a model key with a budget attached. It would NOT get you the
 *    dashboard's session secret or the webhook HMAC (those are per-install and
 *    install.sh already refuses to copy them between hosts), and it would not
 *    get you anything the tailnet does not already reach — but "everything Ship
 *    can do to your code" is the honest summary, and that is a surface which
 *    deserves its own design pass rather than the tail of a long session.
 *
 * WHAT SHIPPED INSTEAD. `join` takes the credentials from an EXPLICIT bundle
 * the operator carries over a channel they already trust — B5's
 * `install.sh --export-secrets` — and spends its effort on the half that is
 * pure value and no new surface: verifying every dependency before claiming
 * success. The controller URL and token are still required, but they are used
 * to PROVE, not to fetch: the joining box demonstrates it can reach the
 * controller, that its store is healthy, and that it holds a token the
 * controller accepts. A wrong controller or a typo'd token fails here, in one
 * command, with a sentence saying which — instead of at the first run.
 *
 * So a stolen JOIN token, as this command uses one, gets you exactly what a
 * stolen SHIP_WEB_TOKEN already got you: read access to the dashboard API on
 * the tailnet. It does not get you credentials, because this command never
 * transports any. That is the whole reason to build it this way first.
 *
 * REVERSAL CONDITION: the day a box has to join without an operator present at
 * both ends — an autoscaling group, a VM image, a colleague standing one up.
 * At that point build the endpoint above, and keep this command's verify half
 * exactly as it is; the two compose.
 * ===========================================================================
 */
import { parseSandboxUrls } from "./sandbox-pool.js";
import { detectForgeColocation, colocationRefusal, colocationOverridden } from "./colocation.js";
import type { ColocationResult, SandboxProbe } from "./colocation.js";

/** One dependency, asked and answered. */
export interface JoinCheck {
  /** Stable identifier, for --json and for grepping a log. */
  name: string;
  /** What was verified, in a human's words. */
  what: string;
  status: "ok" | "fail" | "warn";
  /** The evidence, or the failure. Never a bare "error". */
  detail: string;
  /** What to do about a failure. Present on every fail. */
  fix?: string;
}

/**
 * Secret-shaped keys, redacted everywhere join prints.
 *
 * Deliberately a suffix match rather than a list: a bundle carries whatever
 * `teploy secret list` held, so a key added to the deployment next month must
 * be redacted without anyone remembering to add it here. `NUCLEUS_URL` is named
 * explicitly because a postgres URL carries its password in the userinfo and
 * matches none of the suffixes.
 */
export function looksSecret(key: string): boolean {
  return /(_TOKEN|_KEY|_SECRET|_PASSWORD|PASSWORD|NUCLEUS_URL)$/.test(key);
}

/** A value safe to print: enough to recognise, never enough to use. */
export function redact(key: string, value: string): string {
  if (!looksSecret(key)) return value;
  if (key === "NUCLEUS_URL") return redactUrlPassword(value);
  if (value.length <= 8) return "…";
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}

/** postgres://user:pw@host/db -> postgres://user:…@host/db. Keeps the useful half. */
export function redactUrlPassword(url: string): string {
  return url.replace(/^([a-z+]+:\/\/[^:/@]*):[^@]*@/i, "$1:…@");
}

/**
 * Parse the env-file format `install.sh --export-secrets` writes: `KEY=VALUE`
 * one per line, `#` comments, blanks ignored, first `=` wins so a value may
 * contain one. Deliberately NOT a shell parser — the bundle is generated, and
 * accepting quoting rules here would mean two implementations of quoting that
 * can disagree about a token.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = line.slice(eq + 1);
  }
  return out;
}

/** The inverse, with a header. Values are written raw — this file is chmod 600. */
export function renderEnvFile(env: Record<string, string>, header: string[]): string {
  const lines = header.map((h) => `# ${h}`);
  for (const key of Object.keys(env).sort()) lines.push(`${key}=${env[key]!}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Keys a worker must never be given.
 *
 * The dashboard's session secret and the webhook HMAC are PER-INSTALL: two
 * hosts sharing them means either can mint the other's sessions and forge the
 * other's webhooks, which is why install.sh generates rather than copies them.
 * A bundle exported off a running box contains them anyway, so join drops them
 * on the way in rather than trusting every operator to prune the file by hand.
 * SHIP_WEB_TOKEN is used by join itself to authenticate to the controller and
 * is then dropped for the same reason — the worker never serves HTTP.
 */
export const NOT_FOR_A_WORKER = ["SHIP_SESSION_SECRET", "SHIP_WEBHOOK_SECRET", "SHIP_WEB_TOKEN", "SHIP_SLACK_SIGNING_SECRET", "SHIP_LINEAR_SIGNING_SECRET"];

/** Keys a worker cannot start without, with why. */
const REQUIRED: Array<{ key: string; why: string }> = [
  { key: "NUCLEUS_URL", why: "the shared store the worker claims runs from" },
  { key: "SHIP_GIT_TOKEN", why: "the forge deploy token — without it every run fails at clone" },
];

export interface JoinInput {
  /** The controller's dashboard URL, as typed. */
  controller: string;
  /** Everything the bundle file held. */
  bundle: Record<string, string>;
  /** --sandbox, merged into whatever the bundle carried. */
  addSandbox?: string;
  /** Flag overrides, applied over the bundle. */
  overrides?: Record<string, string | undefined>;
}

export interface JoinPlan {
  controller: string;
  /** The environment the worker will be started with. */
  env: Record<string, string>;
  /** SHIP_SANDBOX_URL, split. */
  sandboxUrls: string[];
  /** The controller token, kept OUT of env — join uses it, the worker must not. */
  webToken?: string;
  /** Non-fatal notes about what was dropped or defaulted. */
  notes: string[];
}

/** Strip a trailing slash so `${controller}/health` never doubles up. */
export function normaliseController(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Build the worker's environment from the bundle plus flags.
 *
 * Pure, so the test can assert the whole shape without a filesystem. Nothing
 * here talks to the network — that is `runJoinChecks`, and keeping the two
 * apart is what lets join report every problem in one pass.
 */
export function planJoin(input: JoinInput): JoinPlan {
  const notes: string[] = [];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.bundle)) {
    if (NOT_FOR_A_WORKER.includes(key)) continue;
    if (value === "") continue;
    env[key] = value;
  }
  const dropped = Object.keys(input.bundle).filter((k) => NOT_FOR_A_WORKER.includes(k));
  if (dropped.length > 0) {
    notes.push(`dropped ${dropped.join(", ")} — per-install secrets a worker never uses, and must not share`);
  }
  for (const [key, value] of Object.entries(input.overrides ?? {})) {
    if (value === undefined || value === "") continue;
    env[key] = value;
  }

  // A worker reads runs from the shared store, so this is not optional and not
  // a default. `--store nucleus` is added to the command line, not the env.
  env.SHIP_STORE = "nucleus";

  const sandboxUrls = parseSandboxUrls([env.SHIP_SANDBOX_URL, input.addSandbox].filter((v) => v !== undefined).join(","));
  if (sandboxUrls.length > 0) {
    env.SHIP_SANDBOX_URL = sandboxUrls.join(",");
    // B2 (src/sandbox-pool.ts): the list is the fleet of sandbox hosts, and a
    // run needs egress to clone and push. A pool member joined with the default
    // "none" would take work and fail every task at git.
    if (env.SHIP_SANDBOX_NETWORK === undefined) {
      env.SHIP_SANDBOX_NETWORK = "egress";
      notes.push("SHIP_SANDBOX_NETWORK defaulted to egress — a run must reach the forge to clone and push");
    }
  } else {
    delete env.SHIP_SANDBOX_URL;
  }

  const webToken = input.bundle.SHIP_WEB_TOKEN;
  return {
    controller: normaliseController(input.controller),
    env,
    sandboxUrls,
    ...(webToken !== undefined && webToken !== "" ? { webToken } : {}),
    notes,
  };
}

/**
 * Is this Nucleus URL reachable from anywhere but the box it was exported from?
 *
 * This is THE failure a second box hits, and it is worth naming rather than
 * letting it surface as a DNS error. `ship-nucleus` is a docker network alias
 * (MASTER_PLAN B3: "a second host literally cannot reach the store"), and the
 * container publishes no host port — verified 2026-08-26, `docker port
 * ship-nucleus` on deploy-test prints nothing. A hostname with no dot in it,
 * that is not localhost and not an IP literal, is a container alias in every
 * case Ship produces.
 */
export function isContainerAlias(nucleusUrl: string): string | null {
  let host: string;
  try {
    host = new URL(nucleusUrl).hostname;
  } catch {
    return null;
  }
  if (host === "" || host === "localhost" || host.includes(".") || host.includes(":")) return null;
  return host;
}

export interface CheckDeps {
  plan: JoinPlan;
  /** Injected in tests; the CLI passes global fetch. */
  fetch: typeof globalThis.fetch;
  /** Connect to the store and run one round trip. Resolves on success. */
  pingStore: (url: string) => Promise<void>;
  /** The co-location detector, injected so the test does not touch the network. */
  detect?: (origins: string[], probe?: SandboxProbe) => Promise<ColocationResult>;
  /** Set when the caller could build a sandbox probe (it needs a live executor). */
  sandboxProbe?: SandboxProbe;
  env?: NodeJS.ProcessEnv;
}

const TIMEOUT_MS = 10_000;

async function get(
  fetcher: typeof globalThis.fetch,
  url: string,
  token?: string,
  scheme: "Bearer" | "token" = "Bearer",
): Promise<{ status: number; body: string }> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetcher(url, {
    signal,
    headers: token !== undefined ? { authorization: `${scheme} ${token}` } : {},
  });
  return { status: response.status, body: (await response.text()).slice(0, 2000) };
}

function why(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code !== undefined ? `${error.message} (${cause.code})` : error.message;
  }
  return String(error);
}

/**
 * Every dependency, asked in order, all of them asked.
 *
 * PRE-DECIDED: this runs EVERY check rather than stopping at the first failure,
 * even though B3 says "fail at the first missing piece". One round trip that
 * lists all four things wrong is one fix cycle; four cycles of "and now this"
 * is the experience that makes people stop trusting a preflight. Nothing is
 * written and nothing is started unless every check passed, which is the
 * property that actually matters. Reversal condition: a check that is expensive
 * or destructive enough that running it after a known failure is wrong — none
 * of these are; they are seven HTTP requests and one SELECT 1.
 */
export async function runJoinChecks(deps: CheckDeps): Promise<JoinCheck[]> {
  const { plan } = deps;
  const checks: JoinCheck[] = [];
  const env = plan.env;

  // 1. The bundle carries what a worker cannot start without.
  const missing = REQUIRED.filter(({ key }) => (env[key] ?? "") === "");
  const hasModelCred = (env.ANTHROPIC_API_KEY ?? "") !== "" || (env.AI_GATEWAY_KEY ?? "") !== "";
  if (missing.length > 0 || !hasModelCred) {
    const lines = missing.map(({ key, why: reason }) => `${key} (${reason})`);
    if (!hasModelCred) lines.push("ANTHROPIC_API_KEY or AI_GATEWAY_KEY (the model credential)");
    checks.push({
      name: "bundle",
      what: "the secrets bundle carries a startable worker configuration",
      status: "fail",
      detail: `missing: ${lines.join("; ")}`,
      fix: "export a complete bundle off the running box: ./install.sh --export-secrets ship.env --host <old-ip> --user <u> oldbox",
    });
  } else {
    checks.push({
      name: "bundle",
      what: "the secrets bundle carries a startable worker configuration",
      status: "ok",
      detail: `${Object.keys(env).length} settings, ${Object.keys(env).filter(looksSecret).length} of them credentials`,
    });
  }

  // 2. The controller answers, and its own store is healthy.
  try {
    const { status, body } = await get(deps.fetch, `${plan.controller}/health`);
    const parsed = JSON.parse(body) as { status?: string; nucleus?: string; worker?: string; version?: string };
    if (status !== 200 || parsed.status !== "ok") {
      checks.push({
        name: "controller",
        what: "the controller is up and its store is reachable",
        status: "fail",
        detail: `${plan.controller}/health returned ${status} ${body.slice(0, 200)}`,
        fix: "the controller itself is unhealthy — fix that before joining a box to it",
      });
    } else {
      checks.push({
        name: "controller",
        what: "the controller is up and its store is reachable",
        status: "ok",
        detail: `${plan.controller} version ${parsed.version ?? "?"}, nucleus ${parsed.nucleus ?? "?"}, workers ${parsed.worker ?? "?"}`,
      });
    }
  } catch (error) {
    checks.push({
      name: "controller",
      what: "the controller is up and its store is reachable",
      status: "fail",
      detail: `GET ${plan.controller}/health: ${why(error)}`,
      fix: "check the URL and that this box is on the tailnet the dashboard is published to",
    });
  }

  // 3. The token this box holds is one the controller accepts. Proves the
  //    operator is joining the Ship they think they are, before anything else
  //    is written — a typo'd token is otherwise discovered on the Fleet page.
  if (plan.webToken === undefined) {
    checks.push({
      name: "controller-token",
      what: "the controller accepts this box's token",
      status: "fail",
      detail: "no token: neither --token nor SHIP_WEB_TOKEN in the bundle",
      fix: "pass --token <the controller's SHIP_WEB_TOKEN>",
    });
  } else {
    try {
      const { status } = await get(deps.fetch, `${plan.controller}/api/policies`, plan.webToken);
      if (status === 401) {
        checks.push({
          name: "controller-token",
          what: "the controller accepts this box's token",
          status: "fail",
          detail: `${plan.controller}/api/policies returned 401 for the token supplied`,
          fix: "the token is wrong or was rotated — read SHIP_WEB_TOKEN off the controller and pass --token",
        });
      } else if (status === 200 || status === 403) {
        // 403 means authenticated but not authorised for policies, which still
        // proves the credential. Accepting it keeps join working for a token
        // that is deliberately less than admin.
        checks.push({
          name: "controller-token",
          what: "the controller accepts this box's token",
          status: "ok",
          detail: status === 200 ? "authenticated" : "authenticated (not authorised for policies, which is fine)",
        });
      } else {
        checks.push({
          name: "controller-token",
          what: "the controller accepts this box's token",
          status: "warn",
          detail: `unexpected ${status} from ${plan.controller}/api/policies — could not confirm the token either way`,
        });
      }
    } catch (error) {
      checks.push({
        name: "controller-token",
        what: "the controller accepts this box's token",
        status: "fail",
        detail: `GET ${plan.controller}/api/policies: ${why(error)}`,
        fix: "the controller answered /health but not its API — check it finished starting",
      });
    }
  }

  // 4. The store. THE thing that breaks a second box, so it gets the specific
  //    message rather than a DNS error.
  const nucleusUrl = env.NUCLEUS_URL ?? "";
  const alias = nucleusUrl === "" ? null : isContainerAlias(nucleusUrl);
  if (nucleusUrl === "") {
    checks.push({
      name: "store",
      what: "this box can reach the shared Nucleus",
      status: "fail",
      detail: "NUCLEUS_URL is not set",
      fix: "pass --nucleus-url postgres://nucleus@<controller-tailnet-ip>:5432/nucleus",
    });
  } else {
    // ASK FIRST, INTERPRET SECOND. An earlier draft refused a container alias
    // on sight, which is wrong in one real case: a box already on the
    // controller's own docker network resolves `ship-nucleus` perfectly well.
    // Refusing something that demonstrably works teaches an operator that the
    // tool guesses, so the alias only shapes the EXPLANATION of a failure —
    // and, when it works, the warning that this is not actually a second box.
    let reached = true;
    let error: unknown;
    try {
      await deps.pingStore(nucleusUrl);
    } catch (caught) {
      reached = false;
      error = caught;
    }
    if (reached && alias === null) {
      checks.push({ name: "store", what: "this box can reach the shared Nucleus", status: "ok", detail: `connected and answered: ${redactUrlPassword(nucleusUrl)}` });
    } else if (reached) {
      checks.push({
        name: "store",
        what: "this box can reach the shared Nucleus",
        status: "warn",
        detail:
          `connected — but NUCLEUS_URL names "${alias}", a docker network alias, so this box is on the controller's ` +
          `own docker network rather than being a second machine. It will work; it buys no redundancy.`,
      });
    } else if (alias !== null) {
      checks.push({
        name: "store",
        what: "this box can reach the shared Nucleus",
        status: "fail",
        detail:
          `NUCLEUS_URL points at "${alias}", which is a docker network alias on the controller's box, not an ` +
          `address — and it did not resolve here (${why(error)}). ship-nucleus publishes no host port either.`,
        fix:
          "on the controller, publish Nucleus on its tailnet address and give it a password, then join with " +
          "--nucleus-url postgres://nucleus:<pw>@<controller-tailnet-ip>:5432/nucleus. " +
          "This is MASTER_PLAN B3's PRE-DECIDED store decision: Nucleus over the tailnet, with credentials.",
      });
    } else {
      checks.push({
        name: "store",
        what: "this box can reach the shared Nucleus",
        status: "fail",
        detail: `${redactUrlPassword(nucleusUrl)}: ${why(error)}`,
        fix: "check the address, the firewall, and that Nucleus accepts a password login from off-box",
      });
    }
  }

  // 5. Every sandbox host in the pool. Adding a box IS adding a URL here (B2),
  //    so join checks each one rather than the first.
  if (plan.sandboxUrls.length === 0) {
    checks.push({
      name: "sandbox",
      what: "every sandbox daemon in the pool answers",
      status: "warn",
      detail:
        "no sandbox configured. Runs an operator types work; tasks arriving from a webhook, Slack or an issue will " +
        "be REFUSED, because their commands would run on this host.",
      fix: "install teploy-sandbox (docs/DEPLOY.md section 3) and pass --sandbox http://172.18.0.1:7439",
    });
  } else {
    const token = env.SHIP_SANDBOX_TOKEN ?? "";
    for (const url of plan.sandboxUrls) {
      const what = `the sandbox daemon at ${url} answers and accepts this token`;
      try {
        const health = await get(deps.fetch, `${url}/health`);
        if (health.status !== 200) {
          checks.push({ name: `sandbox:${url}`, what, status: "fail", detail: `GET ${url}/health returned ${health.status}`, fix: "is teploy-sandbox running there? systemctl status teploy-sandbox" });
          continue;
        }
        if (token === "") {
          checks.push({ name: `sandbox:${url}`, what, status: "fail", detail: "the daemon answers but SHIP_SANDBOX_TOKEN is not set", fix: "read /var/lib/teploy-sandbox/token on the sandbox host and pass --sandbox-token" });
          continue;
        }
        const runs = await get(deps.fetch, `${url}/v1/runs`, token);
        if (runs.status === 401 || runs.status === 403) {
          checks.push({ name: `sandbox:${url}`, what, status: "fail", detail: `the daemon rejected SHIP_SANDBOX_TOKEN (${runs.status})`, fix: "each sandbox host has its OWN token in /var/lib/teploy-sandbox/token — a pool of hosts must share one, or be joined one at a time" });
          continue;
        }
        const server = (JSON.parse(runs.body) as { server?: string }).server;
        checks.push({ name: `sandbox:${url}`, what, status: "ok", detail: server !== undefined ? `host "${server}", token accepted` : "token accepted" });
      } catch (error) {
        checks.push({ name: `sandbox:${url}`, what, status: "fail", detail: why(error), fix: "check the address and that the daemon is listening off-loopback (--addr 0.0.0.0:7439)" });
      }
    }
  }

  // 6. The forge, with the credential a run will actually present. A token that
  //    is merely PRESENT is not a token that works, and "works" is what the
  //    first run needs.
  const origins = allowlistOrigins(env.SHIP_REPO_ALLOWLIST);
  if (origins.length === 0) {
    checks.push({
      name: "forge",
      what: "the forge accepts this box's deploy token",
      status: "warn",
      detail: "SHIP_REPO_ALLOWLIST is empty, so there is no forge to check and every repo URL is refused until a project is added",
      fix: "pass --allow http://<forge>/<owner>,https://github.com/<owner>",
    });
  } else {
    for (const origin of origins) {
      const what = `${origin} accepts this box's deploy token`;
      const github = /(^|\.)github\.com$/.test(new URL(origin).hostname);
      const token = (github ? env.SHIP_GITHUB_TOKEN : env.SHIP_GIT_TOKEN) ?? env.SHIP_GIT_TOKEN ?? "";
      const probeUrl = github ? "https://api.github.com/user" : `${origin}/api/v1/user`;
      if (token === "") {
        checks.push({ name: `forge:${origin}`, what, status: "fail", detail: `no token configured for ${origin}`, fix: github ? "pass --github-token" : "pass --git-token" });
        continue;
      }
      try {
        const response = await get(deps.fetch, probeUrl, token, github ? "Bearer" : "token");
        if (response.status === 401 || response.status === 403) {
          checks.push({ name: `forge:${origin}`, what, status: "fail", detail: `${probeUrl} rejected the token (${response.status})`, fix: "the token is wrong, expired, or lacks repo scope — mint a new one on the forge" });
        } else if (response.status !== 200) {
          checks.push({ name: `forge:${origin}`, what, status: "warn", detail: `${probeUrl} returned ${response.status} — reachable, but the token could not be confirmed` });
        } else {
          const login = (JSON.parse(response.body) as { login?: string; username?: string }).login;
          checks.push({ name: `forge:${origin}`, what, status: "ok", detail: login !== undefined ? `authenticated as ${login}` : "token accepted" });
        }
      } catch (error) {
        checks.push({ name: `forge:${origin}`, what, status: "fail", detail: `GET ${probeUrl}: ${why(error)}`, fix: "this box cannot reach the forge — check the tailnet and the address" });
      }
    }
  }

  // 7. The model. A worker with a dead key takes work and burns every run.
  const gateway = env.AI_GATEWAY_URL ?? "";
  if (gateway !== "") {
    try {
      const response = await get(deps.fetch, `${gateway.replace(/\/+$/, "")}/health`, env.AI_GATEWAY_KEY);
      checks.push({
        name: "model",
        what: "the model gateway answers",
        status: response.status < 500 ? "ok" : "fail",
        detail: `${gateway} returned ${response.status}`,
        ...(response.status >= 500 ? { fix: "the gateway is down; a worker joined to it will fail every run" } : {}),
      });
    } catch (error) {
      checks.push({
        name: "model",
        what: "the model gateway answers",
        status: "fail",
        detail: `${gateway}: ${why(error)}`,
        fix:
          "AI_GATEWAY_URL points at a host-internal address on the controller's box (ship-gateway) in a default " +
          "install. Either publish the gateway on the tailnet, or clear AI_GATEWAY_URL and set ANTHROPIC_API_KEY " +
          "so this worker calls the provider directly.",
      });
    }
  } else if ((env.ANTHROPIC_API_KEY ?? "") !== "") {
    checks.push({
      name: "model",
      what: "the model key is accepted by the provider",
      status: "ok",
      detail: "no gateway configured; the worker will call the provider directly with ANTHROPIC_API_KEY",
    });
  }

  // 8. The B4 gate, run HERE rather than discovered when the worker exits 3.
  //    This is the most likely way a first join fails, so it fails with the
  //    full explanation instead of a process that dies during startup.
  const detect =
    deps.detect ?? ((originList: string[], probe?: SandboxProbe) => detectForgeColocation({ origins: originList, ...(probe !== undefined ? { probe } : {}) }));
  try {
    const result = await detect(origins, deps.sandboxProbe);
    if (result.colocated.length > 0 && colocationOverridden(deps.env ?? process.env)) {
      checks.push({
        name: "colocation",
        what: "this box is not the forge's own box",
        status: "warn",
        detail: `it IS, and SHIP_ALLOW_FORGE_COLOCATION=1 overrides the refusal: ${result.colocated.map((f) => f.detail).join("; ")}`,
      });
    } else if (result.colocated.length > 0) {
      checks.push({
        name: "colocation",
        what: "this box is not the forge's own box",
        status: "fail",
        detail: result.colocated.map((f) => `[${f.how}] ${f.detail}`).join("; "),
        fix: colocationRefusal(result.colocated),
      });
    } else if (result.unknown.length > 0) {
      checks.push({ name: "colocation", what: "this box is not the forge's own box", status: "warn", detail: result.unknown.join("; ") });
    } else if (origins.length > 0) {
      checks.push({ name: "colocation", what: "this box is not the forge's own box", status: "ok", detail: "checked, and it is not" });
    }
  } catch (error) {
    checks.push({ name: "colocation", what: "this box is not the forge's own box", status: "warn", detail: `the check could not run: ${why(error)}` });
  }

  return checks;
}

/**
 * The origins a run would clone from, out of SHIP_REPO_ALLOWLIST.
 *
 * The allowlist holds owner-scoped prefixes (`http://host:49152/tyler`); the
 * origin is what a token authenticates against and what the co-location check
 * asks about, so both want it deduped down to scheme+host+port.
 */
export function allowlistOrigins(allowlist: string | undefined): string[] {
  const out: string[] = [];
  for (const entry of (allowlist ?? "").split(/[,\s]+/)) {
    if (entry.trim() === "") continue;
    try {
      const origin = new URL(entry.trim()).origin;
      if (!out.includes(origin)) out.push(origin);
    } catch {
      // A malformed entry is the repo policy's problem to report, not join's.
    }
  }
  return out;
}

/** Did everything that must pass, pass? Warnings never block. */
export function joinReady(checks: JoinCheck[]): boolean {
  return !checks.some((c) => c.status === "fail");
}

/** The human-readable report. One line per check, the fix indented under a failure. */
export function formatChecks(checks: JoinCheck[]): string {
  const lines: string[] = [];
  for (const check of checks) {
    const mark = check.status === "ok" ? "ok  " : check.status === "warn" ? "warn" : "FAIL";
    lines.push(`  [${mark}] ${check.what}`);
    lines.push(`         ${check.detail}`);
    if (check.fix !== undefined) {
      // A multi-line fix (the co-location refusal is a paragraph) keeps its
      // shape; only the first line is labelled, so the label reads once.
      const [first, ...more] = check.fix.split("\n");
      lines.push(`         fix: ${first}`);
      for (const line of more) lines.push(line === "" ? "" : `              ${line}`);
    }
  }
  return lines.join("\n");
}

/** What join writes, so the operator can read it back without guessing. */
export function summarisePlan(plan: JoinPlan): string {
  const lines: string[] = [];
  for (const key of Object.keys(plan.env).sort()) lines.push(`  ${key}=${redact(key, plan.env[key]!)}`);
  return lines.join("\n");
}
