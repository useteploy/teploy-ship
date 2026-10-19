import type { AgentExecutor } from "@neutron-build/agents";

import type { DurableAgentInput } from "./durable.js";
import { sandboxOverridesOf } from "./durable.js";
import { lookSessionScript } from "./look.js";

/**
 * A browser for the EXTERNAL harnesses (claude-code, opencode, codex and the
 * ACP agents), behind SHIP_HARNESS_BROWSER (default off).
 *
 * Until this slice only the native loop had one: ```look drives a persistent
 * headless Chromium per run sandbox (src/look.ts), and the capability table
 * refused `browser` for every external id ("no browser wiring in the
 * adapter"). What an external harness actually needs is not Ship's own look
 * action but an MCP server the VENDOR agent can call — so this module wires
 * ONE Ship-baked server, @playwright/mcp, into each harness's own MCP
 * plumbing:
 *
 *   claude-code  --mcp-config <file written by the adapter>
 *   opencode     the `mcp` section of OPENCODE_CONFIG_CONTENT (merged, with
 *                the destination derivation taught to read the entry)
 *   codex        --config mcp_servers.browser.* TOML overrides
 *   ACP agents   session/new `mcpServers` (images/acp-driver/ship-acp.mjs)
 *
 * The server never launches a browser of its own: it attaches with
 * `--cdp-endpoint http://127.0.0.1:9222` to the SAME per-run Chromium session
 * the look path drives — the session script bytes are literally
 * lookSessionScript(false) — started detached inside the run's sandbox before
 * the harness exec, dying with the container. Native and external paths
 * therefore behave alike: one Chromium, one CDP port, one session per run,
 * proxy env decomposed the way LOOK_SESSION does on the allowlist tier.
 *
 * Safety mirrors src/look.ts exactly, at the same seam the look gate reads:
 * a sealed tier (network "none") gets NO browser (there is no egress a
 * browser could observe — LOOK_SEALED), and the open tier gets one only on a
 * run whose plan an operator reviewed (input.plan, LOOK_OPEN_PLAN's rule).
 * Both refusals are pure functions of the recorded input + worker env, so a
 * replay reaches the identical answer and no step is added.
 *
 * Off (the default) every adapter builds byte-identical commands, env and
 * spec files — the fence every other flag-gated behaviour keeps.
 */

/** The deployment switch. On only for an explicit on/1/true, like SHIP_ACP_HARNESS. */
export const HARNESS_BROWSER_FLAG = "SHIP_HARNESS_BROWSER";

export function harnessBrowserEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(on|1|true)$/i.test((env[HARNESS_BROWSER_FLAG] ?? "").trim());
}

/**
 * The browser MCP server the images bake — mirrors `browserMcp` in
 * images/versions.json (a test fails when the two drift, the
 * HARNESS_PACKAGES rule). NEVER installed at run time: a run-time install
 * needs the egress the sandbox exists to close and drifts under a running
 * worker.
 */
export const BROWSER_MCP_PACKAGE = { npm: "@playwright/mcp", version: "0.0.83", binary: "playwright-mcp" };

/**
 * The CDP endpoint of the run's browser session — look.ts's LOOK_CDP_PORT
 * (9222), loopback inside the container's own network namespace, which the
 * sandbox's NO_PROXY already covers.
 */
export const BROWSER_MCP_CDP_ENDPOINT = "http://127.0.0.1:9222";

/** The exact server argv every harness config carries (the strict shape the destination derivation admits). */
export const BROWSER_MCP_ARGV: readonly string[] = [BROWSER_MCP_PACKAGE.binary, "--cdp-endpoint", BROWSER_MCP_CDP_ENDPOINT];

/**
 * What one run's browser wiring decided. `off` = flag unset (or a spelling
 * that is not on): nothing changes anywhere. `refused` = flag on but the
 * tier/plan gates said no; the adapter runs WITHOUT a browser and appends
 * `reason` to the prompt so the agent is told, not left to discover a missing
 * tool. `wired` = the server is configured and the shared session started.
 */
export type HarnessBrowserWiring =
  | { kind: "off" }
  | { kind: "refused"; reason: string }
  | { kind: "wired" };

/**
 * What a sealed run is told, in look.ts's words (LOOK_SEALED): the browser
 * cannot even start there, so refusing before the harness runs is both
 * honest and cheap.
 */
export const HARNESS_BROWSER_SEALED =
  "No browser is available in this run: this deployment turns one on for external harnesses (SHIP_HARNESS_BROWSER=on), " +
  "but this run's sandbox network tier is sealed (none), so there is no browser egress a browser could observe. " +
  "Nothing you do inside the run changes that. If the task genuinely needs to see a web page, say so in your final message, naming the page — the run's network tier is an operator decision.";

/** The open-tier rule, LOOK_OPEN_PLAN's words: unrestricted egress needs a reviewed plan. */
export const HARNESS_BROWSER_OPEN_PLAN =
  "No browser is available in this run: this deployment turns one on for external harnesses (SHIP_HARNESS_BROWSER=on), " +
  "but this run's sandbox network tier is open, and a browser with unrestricted egress is only permitted on a run whose plan an operator reviewed. " +
  "This run was not enqueued with plan review. Nothing you do inside the run changes that. If the task genuinely needs to see a web page, say so in your final message — an operator can re-enqueue the run with plan review, or on the allowlist tier with the page's host added.";

/**
 * The gate, read exactly the way the native look gate reads it
 * (durable.ts): the EFFECTIVE tier through sandboxOverridesOf — the recorded
 * tier with the external-task downgrade applied — and input.plan as the
 * recorded marker of the plan park. Pure function of the recorded input and
 * the worker's env; records no step, so replay reaches the same verdict.
 */
export function harnessBrowserWiring(input: DurableAgentInput | undefined, env: NodeJS.ProcessEnv = process.env): HarnessBrowserWiring {
  if (!harnessBrowserEnabled(env)) return { kind: "off" };
  const network = sandboxOverridesOf(input ?? ({} as DurableAgentInput))?.network;
  if (network === "none") return { kind: "refused", reason: HARNESS_BROWSER_SEALED };
  if (network === "open" && input?.plan !== true) return { kind: "refused", reason: HARNESS_BROWSER_OPEN_PLAN };
  return { kind: "wired" };
}

/** The paragraph appended to the harness prompt when the browser was refused. Empty when wired or off. */
export function harnessBrowserPromptNote(wiring: HarnessBrowserWiring): string {
  return wiring.kind === "refused" ? `\n\n${wiring.reason}` : "";
}

// ---------------------------------------------------------------------------
// Per-harness server configuration
// ---------------------------------------------------------------------------

/** Where the claude adapter writes its MCP config (git-excluded scratch, like the prompt). */
export const CLAUDE_MCP_CONFIG_PATH = ".teploy-agent/claude-mcp.json";

/**
 * The `--mcp-config` file for claude: one stdio server named "browser", the
 * baked binary, the CDP attach argv. claude's schema is the standard
 * mcpServers shape; `--bare` (SHIP_CLAUDE_BARE=1) skips host context
 * including MCP, so a bare run ignores this file — recorded in
 * docs/adapters.md, not silently dropped.
 */
export function claudeMcpConfig(): string {
  return JSON.stringify({
    mcpServers: {
      browser: { type: "stdio", command: BROWSER_MCP_PACKAGE.binary, args: [...BROWSER_MCP_ARGV].slice(1) },
    },
  });
}

/**
 * The `--config` TOML overrides that give codex the same server
 * (codex-rs config overrides are dotted paths with TOML values — the same
 * surface codexGatewayConfigFlags uses). `args` is a TOML array; the URL
 * rides in single quotes inside the shq'd literal so nothing expands.
 */
export function codexMcpConfigFlags(): string {
  return (
    ` --config ${shqToml("mcp_servers.browser.command", `"${BROWSER_MCP_PACKAGE.binary}"`)}` +
    ` --config ${shqToml("mcp_servers.browser.args", JSON.stringify([...BROWSER_MCP_ARGV].slice(1)))}`
  );
}

/** shq for a `--config key=value` literal whose value is already TOML. */
function shqToml(key: string, tomlValue: string): string {
  return `'${`${key}=${tomlValue}`.replace(/'/g, `'\\''`)}'`;
}

/**
 * Merge the browser server into an opencode config blob
 * (OPENCODE_CONFIG_CONTENT). Returns the merged blob — COMPACT JSON, no line
 * breaks, so the exec env file the daemon builds can carry it verbatim — or
 * a refusal when the blob exists and is not a JSON object: the blob is
 * delivered as-is in that case (flag-off behaviour) and the browser is not
 * wired, loudly, in the prompt note. An absent blob becomes the minimal
 * config carrying the server.
 */
export function opencodeConfigWithBrowser(raw: string | undefined): { content: string } | { refusal: string } {
  const server = { type: "local", command: [...BROWSER_MCP_ARGV], enabled: true };
  if (raw === undefined || raw.trim() === "") return { content: JSON.stringify({ mcp: { browser: server } }) };
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return {
      refusal:
        "No browser is available in this run: SHIP_HARNESS_BROWSER=on, but the OPENCODE_CONFIG_CONTENT blob is not JSON, so the browser MCP server could not be added to it. " +
        "Fix the blob on the worker (or in the sealed credential store) and run again.",
    };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return {
      refusal:
        "No browser is available in this run: SHIP_HARNESS_BROWSER=on, but the OPENCODE_CONFIG_CONTENT blob is not a JSON object, so the browser MCP server could not be added to it.",
    };
  }
  const record = doc as Record<string, unknown>;
  const mcp = record.mcp !== undefined && record.mcp !== null && typeof record.mcp === "object" && !Array.isArray(record.mcp) ? { ...(record.mcp as Record<string, unknown>) } : {};
  if (typeof record.mcp === "string" || Array.isArray(record.mcp)) {
    return {
      refusal:
        "No browser is available in this run: SHIP_HARNESS_BROWSER=on, but the OPENCODE_CONFIG_CONTENT blob's mcp section is not a JSON object, so the browser MCP server could not be added to it.",
    };
  }
  mcp.browser = server;
  return { content: JSON.stringify({ ...record, mcp }) };
}

/**
 * The strict shape of the ONE local MCP server entry Ship itself injects into
 * an opencode config — what opencodeConfigDestinations (harness-external.ts)
 * admits without deriving a host: the entry dials the run's own loopback CDP
 * endpoint only, so there is no data destination in it to judge. Anything
 * else in a `mcp` table stays exactly the refusal it is today (a local
 * command server's egress no derivation can read).
 */
export function isHarnessBrowserMcpServer(name: string, server: Record<string, unknown>): boolean {
  if (name !== "browser") return false;
  if (typeof server.type === "string" ? server.type !== "local" : server.type !== undefined) return false;
  if (server.command === undefined || Array.isArray(server.command) === false) return false;
  const command = server.command as unknown[];
  return command.length === BROWSER_MCP_ARGV.length && BROWSER_MCP_ARGV.every((part, i) => command[i] === part);
}

/** The session/new mcpServers array for the ACP driver: stdio shape, every required field present (schema v1). */
export function acpBrowserMcpServers(): Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> {
  return [{ name: "browser", command: BROWSER_MCP_PACKAGE.binary, args: [...BROWSER_MCP_ARGV].slice(1), env: [] }];
}

// ---------------------------------------------------------------------------
// The shared Chromium session
// ---------------------------------------------------------------------------

/** Where the session starter lives, beside look's own scratch (same convention). */
const BROWSER_DIR = ".teploy-agent";
const SESSION_START_PATH = `${BROWSER_DIR}/harness-browser-start.mjs`;
/** look's session path: the SAME file the look driver spawns, so both paths share one session contract. */
const LOOK_SESSION_PATH = `${BROWSER_DIR}/look-session.mjs`;

/**
 * The session starter: the look driver's spawn logic without the page turn —
 * probe the CDP endpoint, start look's session script detached when it is
 * down, wait. Bytes pinned by tests the way LOOK_SESSION is.
 */
export function browserSessionStartScript(): string {
  return `const CDP = ${JSON.stringify(BROWSER_MCP_CDP_ENDPOINT)};
async function up() {
  try {
    return (await fetch(CDP + "/json/version")).ok;
  } catch {
    return false;
  }
}
if (!(await up())) {
  const fs = await import("node:fs");
  const log = fs.openSync("/tmp/ship-look-session.log", "a");
  const child = (await import("node:child_process")).spawn(
    process.execPath,
    [${JSON.stringify(LOOK_SESSION_PATH)}],
    { detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
}
const deadline = Date.now() + 20000;
while (!(await up())) {
  if (Date.now() > deadline) {
    console.error("harness browser: the browser session did not come up within 20s — /tmp/ship-look-session.log has its output.");
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
`;
}

/**
 * The shell that runs the starter: look's own prelude (node, the global
 * playwright the session script imports, the node_modules symlink an ESM
 * import needs) plus a loud check for the baked MCP server itself — the
 * vendor harness would only log a spawn failure, so the run record says it
 * in words instead.
 */
export function browserSessionShell(): string {
  return [
    'command -v node >/dev/null 2>&1 || { echo "harness browser: this sandbox has no node to drive a browser session with" >&2; exit 4; }',
    'pw="$(npm root -g 2>/dev/null)/playwright"; test -d "$pw" || { echo "harness browser: this sandbox image has no playwright (npm root -g)/playwright" >&2; exit 5; }',
    `command -v ${BROWSER_MCP_PACKAGE.binary} >/dev/null 2>&1 || { echo "harness browser: this sandbox image has no ${BROWSER_MCP_PACKAGE.binary} — rebuild it with images/build.sh, which bakes ${BROWSER_MCP_PACKAGE.npm}@${BROWSER_MCP_PACKAGE.version}" >&2; exit 6; }`,
    `mkdir -p ${BROWSER_DIR}/node_modules && ln -sfn "$pw" ${BROWSER_DIR}/node_modules/playwright`,
    `node ${SESSION_START_PATH}`,
  ].join("\n");
}

/**
 * Ensure the run's browser session is up before a wired harness exec: write
 * look's session script (verbatim — the same bytes the native look path
 * writes, so one session serves either path), write the starter, exec the
 * shell. Never throws: a failure is a named reason the adapter records.
 */
export async function ensureRunBrowserSession(executor: AgentExecutor): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await executor.putFile(LOOK_SESSION_PATH, lookSessionScript(false));
    await executor.putFile(SESSION_START_PATH, browserSessionStartScript());
    const run = await executor.exec(browserSessionShell(), { timeoutMs: 45_000 });
    if (run.exitCode === 0) return { ok: true };
    return { ok: false, reason: run.stderr.trim() !== "" ? run.stderr.trim() : `the browser session start exited ${run.exitCode}` };
  } catch (error) {
    return { ok: false, reason: `the browser session could not be started: ${error instanceof Error ? error.message : String(error)}` };
  }
}
