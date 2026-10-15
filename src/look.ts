// S12 — the ```look perception action's driver. The browser lives in the
// run's own sandbox container (the plan's D1): a background Playwright-owned
// chromium started on first use, driven over CDP, dying with the container.
// The observation is TEXT — the page's accessibility tree with [ref=eN]
// labels — never pixels in this slice (image mode is a future gated slice).
//
// Everything here runs through the executor, so the observation arrives as an
// ordinary ExecResult and flows through the same scrub()/truncate() as a bash
// observation, and the durable loop records it as a step a replay returns
// without launching anything.

import type { AgentExecutor, ExecResult } from "@neutron-build/agents";

import type { Action } from "./actions.js";

export type LookAction = Extract<Action, { kind: "look" }>;

/** Harness scratch the scripts live in — the same convention as kernel cells. */
const LOOK_DIR = ".teploy-agent";
/**
 * The session's CDP endpoint. Loopback inside the container's own network
 * namespace, which the sandbox's NO_PROXY already covers — and which a
 * per-run container can never collide on, unlike a host port.
 */
const LOOK_CDP_PORT = 9222;

/**
 * What a sealed run is told. The egress gate that emits it reads the tier
 * from the recorded run input (durable.ts); the browser cannot even start
 * there, so refusing before the step is both honest and cheap.
 */
export const LOOK_SEALED =
  "REFUSED: this run's sandbox network tier is sealed (none), so there is no browser egress a look could observe. " +
  "Nothing you do inside the run changes that. If the task genuinely needs to see a web page, say so in a ```finish block, naming the page — the run's network tier is an operator decision.";

/**
 * What a run on the OPEN tier is told when it looks without plan review —
 * the perception input's D3 rule ("open tier plus a browser requires plan
 * review"), wired at the same seam as LOOK_SEALED. "Plan review" means the
 * run was enqueued with `input.plan` and therefore parked on PLAN_EVENT
 * before its first turn: a run that reaches a look action with that flag
 * has, in its own log, an approved plan behind it (a denied one ended the
 * run at `plan-rejected` before any turn ran). Reading the flag rather
 * than a fresh approval record keeps the gate a pure function of the
 * recorded input, so a replay refuses identically and no step is added.
 */
export const LOOK_OPEN_PLAN =
  "REFUSED: this run's sandbox network tier is open, and a browser with unrestricted egress is only permitted on a run whose plan an operator reviewed. " +
  "This run was not enqueued with plan review, so ```look does not execute here. Nothing you do inside the run changes that. If the task genuinely needs to see a web page, say so in a ```finish block, naming the page — an operator can re-enqueue the run with plan review, or on the allowlist tier with the page's host added.";

/**
 * The loud stale-ref failure (the addendum's error shape, verbatim in spirit).
 * Refs are minted per snapshot render and die with the page they came from;
 * there is no fuzzy matching, ever.
 */
export function lookStaleRef(ref: string): string {
  return `Ref ${ref} not found in the current page snapshot. Take a new one (\`\`\`look on its own, or with url= to navigate first) and use refs from that snapshot.`;
}

/**
 * Lines of an ai snapshot that match a `find=` needle.
 *
 * Shared verbatim with the in-sandbox driver (its source is embedded into the
 * script look.ts writes), so a fake-driver test and a real page produce the
 * same bytes. Self-contained on purpose — no imports, no closure over module
 * scope — because toString() must be the whole function.
 *
 * A `/pattern/flags` needle is a regex (compile-checked at parse time);
 * anything else is a case-insensitive substring. Snapshot lines already carry
 * their [ref=eN] labels, so a match is a ref the next action can name.
 */
export function findMatches(snapshot: string, find: string): string[] {
  const regex = /^\/(.+)\/([a-z]*)$/s.exec(find.trim());
  if (regex !== null) return snapshot.split("\n").filter((line) => new RegExp(regex[1]!, regex[2]).test(line));
  const needle = find.trim().toLowerCase();
  return snapshot.split("\n").filter((line) => line.toLowerCase().includes(needle));
}

/** How a needle is quoted back in the observation: regexes raw, text in quotes. */
export function describeNeedle(find: string): string {
  const trimmed = find.trim();
  return /^\/.+\/[a-z]*$/s.test(trimmed) ? trimmed : `"${trimmed}"`;
}

/**
 * The observation text for one look, from the pieces a page supplies. Shared
 * with the driver the same way findMatches is; the driver supplies the live
 * snapshot, a fake driver a fixture one.
 */
export function renderLook(action: { find?: string | null; ref?: string | null }, page: { url: string; title: string }, snapshot: string): string {
  const head = `[page] ${page.url}${page.title === "" ? "" : ` — ${page.title}`}`;
  if (action.find != null) {
    const lines = findMatches(snapshot, action.find);
    if (lines.length === 0) {
      return `${head}\n0 matches for ${describeNeedle(action.find)} — the page may have changed since your last look; a bare \`\`\`look re-observes it.`;
    }
    return `${head}\n${lines.length} match${lines.length === 1 ? "" : "es"} for ${describeNeedle(action.find)}:\n${lines.join("\n")}`;
  }
  if (action.ref != null) return `${head}\nsubtree under ${action.ref}:\n${snapshot}`;
  return `${head}\n${snapshot}`;
}

/**
 * The per-run browser session, run as a BACKGROUND process inside the sandbox
 * container (the driver spawns it detached when the CDP endpoint is not up).
 *
 * This is the receipt's verified launch —
 * evals/receipts/2026-10-14-egress-proxy-browser-proof.txt §7 — plus the
 * flags this slice fixes: --headless=new, --disable-background-networking,
 * and a fixed --remote-debugging-port so every later turn connectOverCDPs to
 * the SAME session (page state and refs from a previous snapshot stay
 * usable). Chromium on Linux reads the proxy env vars but STRIPS the URL
 * userinfo, so the per-run credential must arrive as an explicit
 * proxy:{server,username,password} — an env-only launch dies at the daemon's
 * 407 with a silent empty response (receipt §4, measured live). The open tier
 * injects no proxy env, and `proxy` stays undefined there on purpose.
 *
 * Exported only so the test suite can pin the launch contract — the receipt's
 * decomposition, the flags, the fixed port; nothing else should import it.
 */
export const LOOK_SESSION = `import { chromium } from "playwright";
// allowlist tier: HTTPS_PROXY carries run:<credential>@ — decompose it,
// never pass it through as a URL with userinfo.
const raw = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "";
let proxy;
if (raw) {
  const u = new URL(raw);                    // raw: host 172.31.99.1, userinfo run:<cred>
  proxy = {
    server: \`\${u.protocol}//\${u.host}\`,    // NO userinfo
    username: decodeURIComponent(u.username),// "run"
    password: decodeURIComponent(u.password),// per-run credential
  };
}
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_BIN ?? "/usr/bin/chromium",
  args: ["--no-sandbox", "--disable-gpu", "--disable-background-networking", "--headless=new", "--remote-debugging-port=${LOOK_CDP_PORT}"],
  proxy,                                     // undefined on the open tier —
});                                          // no proxy env is injected there
// Hold the session open for the life of the run: Playwright owns the
// chromium process, so this process must outlive every driver turn.
setInterval(() => {}, 1 << 30);
`;

/**
 * The per-turn driver: connect to the session (starting it if needed),
 * navigate if asked, observe, print the observation as text. Ref resolution
 * goes through the aria-ref selector engine — playwright 1.63 has no
 * getByRef, and that engine IS the resolution its own tool backend uses,
 * with the same (f\\d+)?e\\d+ grammar (a pre-flight deviation, documented in
 * the PR). The engine resolves a ref against the last ai snapshot rendered
 * in THIS connection, so a ref look snapshots the page first and then takes
 * the subtree — which is also the honest semantics: the ref names an element
 * of the page as it is NOW, and fails loudly when that element is gone.
 */
function lookDriverScript(action: LookAction): string {
  const params = { url: action.url, ref: action.ref, find: action.find, depth: action.depth };
  return `import { chromium } from "playwright";
const ACTION = ${JSON.stringify(params)};
${describeNeedle}
${findMatches}
${renderLook}
const CDP = "http://127.0.0.1:${LOOK_CDP_PORT}";
async function up() {
  try {
    return (await fetch(CDP + "/json/version")).ok;
  } catch {
    return false;
  }
}
try {
  if (!(await up())) {
    const fs = await import("node:fs");
    const log = fs.openSync("/tmp/ship-look-session.log", "a");
    const child = (await import("node:child_process")).spawn(
      process.execPath,
      ["${LOOK_DIR}/look-session.mjs"],
      { detached: true, stdio: ["ignore", log, log] },
    );
    child.unref();
  }
  const deadline = Date.now() + 20000;
  while (!(await up())) {
    if (Date.now() > deadline) {
      console.error("look: the browser session did not come up within 20s — /tmp/ship-look-session.log has its output.");
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const browser = await chromium.connectOverCDP(CDP);
  // No browser.close() anywhere: a CDP connection's close would tear down the
  // context it created, and the SESSION must outlive this turn. The explicit
  // exits below drop the socket; chromium keeps running detached.
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  if (ACTION.url != null) {
    // goto IS the error surface — the receipt's rule. A 407 from the egress
    // proxy, a refused host and a dead URL all throw here, catchably; never
    // trust a raw chromium exit code.
    await page.goto(ACTION.url, { waitUntil: "load", timeout: 30000 });
    await page.waitForTimeout(500); // settle: the waitForCompletion recipe's first stage
  }
  const depth = ACTION.depth != null ? { depth: ACTION.depth } : {};
  let snapshot;
  if (ACTION.ref != null) {
    await page.ariaSnapshot({ mode: "ai" }); // mint this connection's refs before resolving one
    try {
      snapshot = await page.locator("aria-ref=" + ACTION.ref).ariaSnapshot({ mode: "ai", ...depth });
    } catch {
      console.error(${JSON.stringify(action.ref !== undefined ? lookStaleRef(action.ref) : "")});
      process.exit(1);
    }
  } else {
    snapshot = await page.ariaSnapshot({ mode: "ai", ...depth });
  }
  const out = renderLook(ACTION, { url: page.url(), title: await page.title() }, snapshot);
  // Exit explicitly — the CDP socket would otherwise hold the process open —
  // but only once stdout has flushed: a pipe cut mid-observation loses the
  // tail of the tree, which is the part a depth-capped look kept.
  process.stdout.write(out, () => process.exit(0));
} catch (error) {
  console.error(String((error && error.message) || error));
  process.exit(1);
}
`;
}

/**
 * The shell that runs one driver script. The symlink is the flow rung's
 * trick (ladder-steps.ts): an ESM import ignores NODE_PATH, so the global
 * playwright becomes resolvable by linking it into a node_modules beside the
 * script. Missing node or playwright is named in words on stderr — the agent
 * cannot fix either and should stop, not retry.
 */
export function lookCommand(scriptSuffix: string): string {
  return [
    'command -v node >/dev/null 2>&1 || { echo "look: this sandbox has no node to drive a browser session with" >&2; exit 4; }',
    'pw="$(npm root -g 2>/dev/null)/playwright"; test -d "$pw" || { echo "look: this sandbox image has no playwright (npm root -g)/playwright" >&2; exit 5; }',
    `mkdir -p ${LOOK_DIR}/node_modules && ln -sfn "$pw" ${LOOK_DIR}/node_modules/playwright`,
    `node ${LOOK_DIR}/look-${scriptSuffix}.mjs`,
  ].join("\n");
}

/**
 * Run one look action against the run's sandbox: write the session and the
 * per-turn driver, exec the driver. The ExecResult is the seam the loops and
 * the tests pin — stdout is the observation text, a non-zero exit with stderr
 * is a loud failure the agent can act on.
 */
export async function runLook(executor: AgentExecutor, scriptSuffix: string, action: LookAction, timeoutMs?: number): Promise<ExecResult> {
  await executor.putFile(`${LOOK_DIR}/look-session.mjs`, LOOK_SESSION);
  await executor.putFile(`${LOOK_DIR}/look-${scriptSuffix}.mjs`, lookDriverScript(action));
  return executor.exec(lookCommand(scriptSuffix), timeoutMs !== undefined ? { timeoutMs } : {});
}
