// S12 — the ```look perception action's driver. The browser lives in the
// run's own sandbox container (the plan's D1): a background Playwright-owned
// chromium started on first use, driven over CDP, dying with the container.
// The observation is TEXT FIRST — the page's accessibility tree with
// [ref=eN] labels — and image mode (`image=on`, the gated slice) adds a PNG
// screenshot of the same render IN ADDITION to the text, never instead of
// it (pixels supplementary, D2's convention).
//
// Everything here runs through the executor, so the observation arrives as an
// ordinary ExecResult and flows through the same scrub()/truncate() as a bash
// observation, and the durable loop records it as a step a replay returns
// without launching anything. The screenshot of an image look is the one
// addition: it lands in the run's artifact store (artifacts.ts — mime
// allowlist, sha256, retention) tagged with the look-image data class, and
// the durable step records the digest so replay can rebuild the ImagePart
// from the store without re-screenshotting.

import { createHash } from "node:crypto";

import type { AgentExecutor, ExecResult } from "@neutron-build/agents";

import { LOOK_IMAGE_DATA_CLASS, RECORDING_DATA_CLASS, type ArtifactBinding, type ArtifactStore } from "./artifacts.js";
import type { Action } from "./actions.js";
import { firstSecretIn, withheldRecordingReason, type KnownSecret } from "./redact.js";

export type LookAction = Extract<Action, { kind: "look" }>;

/** What one image look records: the text ExecResult plus its screenshot artifact. */
export interface LookImageResult extends ExecResult {
  /**
   * Present when the driver captured and stored the screenshot. The durable
   * step result carries it, so a replay re-reads the artifact by id instead
   * of re-running the browser. `digest` is the sha256 of the PNG bytes —
   * for a temporary artifact the store's own id is random, so this is the
   * stable name the transcript's placeholders quote.
   */
  image?: { artifact: string; digest: string; bytes: number };
}

/** Harness scratch the scripts live in — the same convention as kernel cells. */
const LOOK_DIR = ".teploy-agent";
/**
 * The session's CDP endpoint. Loopback inside the container's own network
 * namespace, which the sandbox's NO_PROXY already covers — and which a
 * per-run container can never collide on, unlike a host port.
 */
const LOOK_CDP_PORT = 9222;
/** Where the driver writes an image look's PNG, inside the same scratch dir. */
export function lookShotPath(scriptSuffix: string): string {
  return `${LOOK_DIR}/look-shot-${scriptSuffix}.png`;
}

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
 * What an image look is told when no vision model is admitted for the run
 * (input.lookImage absent — i.e. SHIP_LOOK_IMAGE_MODEL was not set at
 * enqueue, even under SHIP_LOOK=on). Refusing beats a blind call: sending
 * pixels to a model that cannot see them would return a confident
 * hallucination about the page, which is worse than no screenshot. The
 * refusal names the env var because only an operator can set it.
 */
export const LOOK_IMAGE_NO_MODEL =
  "REFUSED: an image look attaches a PNG screenshot, and this run has no vision-capable model configured to receive one (set SHIP_LOOK_IMAGE_MODEL on the deployment — the operator's decision, nothing inside the run changes it). " +
  "The text snapshot works exactly as before: re-run the ```look without image= and read the accessibility tree.";

/**
 * What an image look is told once the run's per-run image budget is spent
 * (SHIP_LOOK_IMAGE_MAX, materialised as input.lookImage.max). Loud on
 * purpose: a silent downgrade to text would read as "the screenshot
 * feature is flaky" and invite retries that spend turns.
 */
export function lookImageCap(max: number): string {
  return `REFUSED: this run's image-look budget is spent (${max} screenshot${max === 1 ? "" : "s"} per run, SHIP_LOOK_IMAGE_MAX). ` +
    "The text snapshot works exactly as before: re-run the ```look without image=. If the task needs more pixels, say so in a ```finish block — the cap is an operator decision.";
}

/**
 * What an image look is told when the run input admits image mode but the
 * EXECUTING worker cannot honour it — no artifact store configured, so the
 * screenshot would have nowhere honest to land. The look slice's hard rule
 * is that pixels are artifacts (mime-allowed, hashed, retained, tagged) or
 * they are nothing; an in-message screenshot with no artifact behind it
 * would be unauditable page content in the transcript.
 */
export const LOOK_IMAGE_NO_STORE =
  "REFUSED: this worker has no artifact store configured, so an image look has nowhere to record its screenshot (a pixels-as-artifacts rule — see the run's operator). " +
  "The text snapshot works exactly as before: re-run the ```look without image=.";

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
 * 407 with a silent empty response (receipt §4, measured live). Loopback
 * bypasses the proxy so `look` can see a dev server the agent started in its
 * own container; nothing beyond the container's loopback is reachable that way. The open tier
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
    // The agent's own dev server runs on this container's loopback; the
    // egress proxy refuses every local address, so loopback must not go
    // through it (found live 2026-10-18: look could not see :8000).
    bypass: "localhost,127.0.0.1,[::1]",
  };
  // Playwright otherwise appends <-loopback>, forcing loopback THROUGH the
  // proxy and overriding the bypass above.
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = "1";
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
 * Q3b (SHIP_LOOK_RECORD): the session's screencast recorder, appended to
 * LOOK_SESSION only when the run input admitted recording (input.lookRecord,
 * materialised from SHIP_LOOK_RECORD at enqueue). Off runs spawn the exact
 * LOOK_SESSION bytes above — pinned by tests, the lookImage convention.
 *
 * A CDP session per page runs `Page.startScreencast`, which emits a frame
 * ONLY on repaint: an idle page costs nothing, which is what keeps a session
 * that lives for the whole run inside the 4 MiB store ceiling. Frame and byte
 * caps stop capture loudly (`rec/stopped.txt` names which cap), and the page's
 * DOM text is captured beside the frames — deduped per page, capped — because
 * pixels cannot be scrubbed; the text is the proxy the secret check (Q3c)
 * reads before anything is stored. The recorder never starts or stops on the
 * agent's word: capture is Ship-owned and input-gated, so replay stays
 * deterministic.
 */
const LOOK_RECORDER = `
// --- look recording (Q3b): screencast to .teploy-agent/rec -----------------
const fs = await import("node:fs");
const REC = "${LOOK_DIR}/rec";
const MAX_FRAMES = 600, MAX_BYTES = ${4 * 1024 * 1024}, MAX_TEXT = ${512 * 1024};
fs.mkdirSync(REC, { recursive: true });
fs.writeFileSync(REC + "/text.txt", "");
let frames = 0, bytes = 0, frameSeq = 0, capped = "";
const watched = new WeakSet(), lastText = new WeakMap();
function stopCapture(why) {
  if (capped) return;
  capped = why;
  fs.writeFileSync(REC + "/stopped.txt", "rec: cap reached (" + why + ")\\n");
}
async function captureText(page) {
  // The DOM text is the secret check's proxy (Q3c); it stays in the sandbox
  // and never reaches the model.
  try {
    const text = await page.evaluate(() => (document.body ? document.body.innerText : ""));
    if (text !== "" && text !== lastText.get(page)) {
      lastText.set(page, text);
      if (fs.statSync(REC + "/text.txt").size < MAX_TEXT) {
        fs.appendFileSync(REC + "/text.txt", "\\n--page-- " + page.url() + "\\n" + text);
      } else stopCapture("text");
    }
  } catch { /* a page mid-navigation answers nothing */ }
}
async function watch(page) {
  if (watched.has(page) || capped) return;
  watched.add(page);
  try {
    const cdp = await page.context().newCDPSession(page);
    cdp.on("Page.screencastFrame", async (frame) => {
      try { await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }); } catch {}
      if (capped) { try { await cdp.send("Page.stopScreencast"); } catch {} return; }
      const jpg = Buffer.from(frame.data, "base64");
      if (frames >= MAX_FRAMES || bytes + jpg.length > MAX_BYTES) {
        stopCapture(frames >= MAX_FRAMES ? "frame" : "byte");
        try { await cdp.send("Page.stopScreencast"); } catch {}
        return;
      }
      fs.writeFileSync(REC + "/f" + String(frameSeq++).padStart(5, "0") + ".jpg", jpg);
      frames += 1; bytes += jpg.length;
      await captureText(page);
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 960, maxHeight: 600, everyNthFrame: 2 });
    await captureText(page);
  } catch { /* a closing page is not a failure of the session */ }
}
for (const context of browser.contexts()) for (const page of context.pages()) await watch(page);
// New pages and tabs join on the next tick; the same tick is the finaliser's
// stop signal, so capture ends when the recording is assembled.
setInterval(() => {
  if (fs.existsSync(REC + "/stop")) {
    if (!capped) { capped = "finalised"; try { fs.unlinkSync(REC + "/stop"); } catch {} }
    return;
  }
  for (const context of browser.contexts()) for (const page of context.pages()) void watch(page);
}, 1000);
`;

/** The session script: LOOK_SESSION verbatim, plus the recorder when the run input admitted recording. */
export function lookSessionScript(record: boolean): string {
  return record ? LOOK_SESSION + LOOK_RECORDER : LOOK_SESSION;
}

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
function lookDriverScript(action: LookAction, shotPath?: string): string {
  // image rides only when true, so a text look's script bytes are exactly
  // what they were before image mode existed (the ACTION literal is pinned
  // by tests on both sides).
  const params = {
    url: action.url,
    ref: action.ref,
    find: action.find,
    depth: action.depth,
    ...(action.image === true ? { image: true } : {}),
  };
  // The screenshot is taken AFTER the a11y snapshot of the SAME settled
  // render, so text and pixels describe one page state — never a second
  // navigation or a fresh settle between them.
  const shot = shotPath !== undefined
    ? `  if (ACTION.image === true) {\n    await page.screenshot({ path: ${JSON.stringify(shotPath)} }); // viewport-sized PNG, same render as the text\n  }\n`
    : "";
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
${shot}  const out = renderLook(ACTION, { url: page.url(), title: await page.title() }, snapshot);
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
export async function runLook(executor: AgentExecutor, scriptSuffix: string, action: LookAction, timeoutMs?: number, record = false): Promise<ExecResult> {
  await executor.putFile(`${LOOK_DIR}/look-session.mjs`, lookSessionScript(record));
  await executor.putFile(`${LOOK_DIR}/look-${scriptSuffix}.mjs`, lookDriverScript(action, action.image === true ? lookShotPath(scriptSuffix) : undefined));
  return executor.exec(lookCommand(scriptSuffix), timeoutMs !== undefined ? { timeoutMs } : {});
}

/**
 * Run one IMAGE look: the same driver turn (text snapshot PLUS a viewport
 * PNG of the same render), then pull the screenshot out of the sandbox and
 * store it as a look-image artifact — temporary, so the store's screenshot
 * retention applies, and tagged, so every PR-attachment boundary refuses it
 * (git.ts uploadPrAsset; the public-mirror hard rule).
 *
 * The step's recorded result carries the artifact id and digest; the bytes
 * stay in the store. On replay the step returns without running this body,
 * and the caller rebuilds the ImagePart from the store — or, if retention
 * has taken the artifact, degrades to text plus the digest pointer.
 *
 * A failed driver turn returns the ExecResult WITHOUT an image field: the
 * observation (exit code, stderr) is the honest failure the agent reads,
 * same as a text look.
 */
export async function runLookImage(executor: AgentExecutor, scriptSuffix: string, action: LookAction, artifacts: ArtifactStore, timeoutMs?: number, binding?: ArtifactBinding, record = false): Promise<LookImageResult> {
  const result = await runLook(executor, scriptSuffix, { ...action, image: true }, timeoutMs, record);
  if (result.exitCode !== 0 || result.truncated) return result;
  let bytes: Uint8Array;
  try {
    bytes = await executor.getFile(lookShotPath(scriptSuffix));
  } catch {
    // The text observation succeeded but the screenshot never came back —
    // report that as part of the observation rather than failing the turn.
    return { ...result, stderr: result.stderr === "" ? "look: the screenshot capture failed (no PNG came back from the sandbox)" : `${result.stderr}\nlook: the screenshot capture failed (no PNG came back from the sandbox)` };
  }
  const put =
    artifacts.putTemporary !== undefined
      ? artifacts.putTemporary.bind(artifacts)
      : (name: string, b: Uint8Array, dataClass?: string, bound?: ArtifactBinding) => artifacts.put(name, b, dataClass, bound);
  const artifact = await put(`look-${scriptSuffix}.png`, bytes, LOOK_IMAGE_DATA_CLASS, binding);
  return { ...result, image: { artifact, digest: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length } };
}

// --- look recording (Q3b) ------------------------------------------------------

/** Where the session recorder writes frames and the captured page text. */
export const LOOK_REC_DIR = `${LOOK_DIR}/rec`;
/** The artifact store's hard ceiling (artifacts.ts), stated here so the drop reason can name it. */
export const LOOK_RECORD_MAX_BYTES = 4 * 1024 * 1024;

/**
 * What the `look-record` step recorded. Every branch is run-page context:
 * NONE of it reaches a pull request — `look` runs on the unpushed tree before
 * the commit, so a look recording can never be verification of a revision
 * (the perception design's false-proof rule; the artifact carries the tree
 * digest and no revision, and `recording` is the data class every
 * PR-attachment boundary refuses).
 */
export type LookRecordOutcome =
  | {
      kind: "stored";
      /** The temporary artifact id — 7-day screenshot retention, like a look-image. */
      artifact: string;
      digest: string;
      bytes: number;
      frames: number;
      /** How the frames were assembled: VP8 WebM when the image carries ffmpeg, a JPEG strip when it does not. */
      format: "webm" | "strip";
      /** The recorder's own stop reason, when a cap ended capture before the session did. */
      capped?: string;
      /** `git write-tree` over the working tree at finalisation, when the run had one. */
      treeDigest?: string;
    }
  | { kind: "withheld"; reason: string }
  | { kind: "dropped"; reason: string }
  | { kind: "none"; reason: string }
  | { kind: "failed"; reason: string };

/**
 * The finaliser, run inside the sandbox ONCE after the agent loop ends: stop
 * capture, then assemble the frames. VP8 WebM at one frame per second (gaps
 * collapsed) when the image carries ffmpeg; the sandbox images bake none
 * (images/sandbox-*), so the ordinary path is a compact JPEG strip drawn by
 * the session's own browser — a canvas is the only image tool guaranteed
 * present — and the step result SAYS it is a strip, never passing one off as
 * video.
 */
function lookRecordScript(): string {
  return `import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
const run = promisify(execFile);
const REC = "${LOOK_REC_DIR}";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Ask the recorder to stop, then let one tick pass so frames in flight land
// and the strip page below is never itself captured.
if (!existsSync(REC + "/stop")) writeFileSync(REC + "/stop", "");
await sleep(1300);
const frames = readdirSync(REC).filter((f) => /^f\\d{5}\\.jpg$/.test(f)).sort();
if (frames.length === 0) {
  console.log(JSON.stringify({ kind: "none", reason: "the look session captured no frames — a page that never repainted records nothing" }));
  process.exit(0);
}
const capped = existsSync(REC + "/stopped.txt") ? readFileSync(REC + "/stopped.txt", "utf8").trim() : "";
const tree = existsSync(REC + "/tree.txt") ? readFileSync(REC + "/tree.txt", "utf8").trim() : "";
const common = { frames: frames.length, ...(capped !== "" ? { capped } : {}), ...( /^[a-f0-9]{40,64}$/.test(tree) ? { treeDigest: tree } : {}) };
if (existsSync(REC + "/ffmpeg")) {
  try {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "1", "-i", REC + "/f%05d.jpg", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libvpx", "-b:v", "0", "-crf", "35", REC + "/look-record.webm"], { timeout: 120000 });
    console.log(JSON.stringify({ kind: "webm", file: REC + "/look-record.webm", ...common }));
    process.exit(0);
  } catch (error) {
    console.error("look-record: ffmpeg failed (" + String((error && error.message) || error) + "), falling back to the strip");
  }
}
// No ffmpeg in this image: assemble the frames into one compact JPEG strip
// through the session's own browser.
const browser = await chromium.connectOverCDP("http://127.0.0.1:${LOOK_CDP_PORT}");
const context = browser.contexts()[0];
const page = await context.newPage();
try {
  await page.setContent("<!doctype html><canvas id='c'></canvas>");
  const cols = Math.max(4, Math.ceil(frames.length / 80)); // keep the canvas inside Chromium's limits
  const tileW = 240, tileH = 150;
  await page.evaluate((w, h) => { const c = document.getElementById("c"); c.width = w; c.height = h; }, cols * tileW, Math.ceil(frames.length / cols) * tileH);
  for (let i = 0; i < frames.length; i++) {
    const b64 = readFileSync(REC + "/" + frames[i]).toString("base64");
    await page.evaluate((i, b64, cols, tileW, tileH) => new Promise((resolve, reject) => {
      const ctx = document.getElementById("c").getContext("2d");
      const img = new Image();
      img.onload = () => {
        const x = (i % cols) * tileW, y = Math.floor(i / cols) * tileH;
        const s = Math.min(tileW / img.width, tileH / img.height);
        ctx.drawImage(img, x + (tileW - img.width * s) / 2, y + (tileH - img.height * s) / 2, img.width * s, img.height * s);
        resolve();
      };
      img.onerror = () => reject(new Error("frame " + i + " did not decode"));
      img.src = "data:image/jpeg;base64," + b64;
    }), i, b64, cols, tileW, tileH);
  }
  const data = await page.evaluate(() => document.getElementById("c").toDataURL("image/jpeg", 0.55));
  writeFileSync(REC + "/look-record.jpg", Buffer.from(data.slice(data.indexOf(",") + 1), "base64"));
  console.log(JSON.stringify({ kind: "strip", file: REC + "/look-record.jpg", ...common }));
} finally {
  await page.close().catch(() => {});
}
`;
}

/**
 * The shell that runs the finaliser: the look command's node/playwright
 * prelude, an honest "nothing was captured" for a run whose look never
 * spawned a session, an ffmpeg probe the script reads, and the tree digest —
 * `git write-tree` over a THROWAWAY index so the working tree is captured
 * without touching the real one (.teploy-agent is excludeCommand's, so the
 * scratch never lands in the tree).
 */
export function lookRecordCommand(): string {
  return [
    'command -v node >/dev/null 2>&1 || { echo "look: this sandbox has no node to drive a browser session with" >&2; exit 4; }',
    'pw="$(npm root -g 2>/dev/null)/playwright"; test -d "$pw" || { echo "look: this sandbox image has no playwright (npm root -g)/playwright" >&2; exit 5; }',
    `mkdir -p ${LOOK_DIR}/node_modules && ln -sfn "$pw" ${LOOK_DIR}/node_modules/playwright`,
    `if [ ! -d ${LOOK_REC_DIR} ]; then echo '{"kind":"none","reason":"no look session ran, so nothing was captured"}'; exit 0; fi`,
    `if command -v ffmpeg >/dev/null 2>&1; then : > ${LOOK_REC_DIR}/ffmpeg; fi`,
    `if git rev-parse --verify -q HEAD >/dev/null 2>&1; then ( export GIT_INDEX_FILE="$PWD/${LOOK_REC_DIR}/index"; git read-tree HEAD && git add -A . && git write-tree ) > ${LOOK_REC_DIR}/tree.txt 2>/dev/null || rm -f ${LOOK_REC_DIR}/tree.txt; fi`,
    `node ${LOOK_DIR}/look-record.mjs`,
  ].join("\n");
}

interface FinaliserReport {
  kind: "webm" | "strip";
  file: string;
  frames: number;
  capped?: string;
  treeDigest?: string;
}

/** The finaliser's stdout report: the last JSON line it printed, or null. */
function parseReport(stdout: string): FinaliserReport | { kind: "none"; reason: string } | null {
  for (const line of stdout.split("\n").reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { kind?: string; reason?: string; file?: string; frames?: number; capped?: string; treeDigest?: string };
      if (parsed.kind === "none") return { kind: "none", reason: parsed.reason ?? "the session captured no frames" };
      if (parsed.kind !== "webm" && parsed.kind !== "strip") continue;
      if (typeof parsed.file !== "string" || typeof parsed.frames !== "number") continue;
      return { kind: parsed.kind, file: parsed.file, frames: parsed.frames, ...(parsed.capped !== undefined ? { capped: parsed.capped } : {}), ...(parsed.treeDigest !== undefined ? { treeDigest: parsed.treeDigest } : {}) };
    } catch {
      // not the report line
    }
  }
  return null;
}

/**
 * Finalise the look session's recording (Q3b): run the in-sandbox finaliser,
 * then decide — on the HOST, where the secret set lives — whether anything is
 * stored. The order is the redaction policy (Q3c): the captured page TEXT is
 * pulled first and checked against the run's exact-value secret set; on a hit
 * the recording bytes are never even transferred out of the sandbox, the rec
 * directory is deleted in the sandbox, nothing is stored, and the refusal
 * names the secret's NAME and never its value. Past the check, over-cap
 * recordings are DROPPED with the reason recorded — never silently truncated
 * — and a stored recording is a temporary `recording`-class artifact bound to
 * the run and the tree it observed, so 7-day retention and every
 * PR-attachment refusal apply to it unchanged.
 */
export async function runLookRecordFinalise(
  executor: AgentExecutor,
  artifacts: ArtifactStore | undefined,
  binding: { runId: string },
  secrets: readonly KnownSecret[] = [],
  timeoutMs?: number,
): Promise<LookRecordOutcome> {
  await executor.putFile(`${LOOK_DIR}/look-record.mjs`, lookRecordScript());
  const cleanup = () => executor.exec(`rm -rf ${LOOK_REC_DIR}`, { timeoutMs: 15_000 }).catch(() => {});
  const run = await executor.exec(lookRecordCommand(), timeoutMs !== undefined ? { timeoutMs } : {});
  if (run.exitCode !== 0) {
    await cleanup();
    return { kind: "failed", reason: run.stderr.trim() !== "" ? run.stderr.trim() : `the finaliser exited ${run.exitCode}` };
  }
  const report = parseReport(run.stdout);
  if (report === null) {
    await cleanup();
    return { kind: "failed", reason: "the finaliser printed no report" };
  }
  if (report.kind === "none") {
    await cleanup();
    return { kind: "none", reason: report.reason };
  }
  // Q3c: the DOM text captured during the session is the proxy for what the
  // pixels show. It is checked on the host and recorded NOWHERE — only the
  // verdict rides the step result.
  let text = "";
  try {
    text = new TextDecoder().decode(await executor.getFile(`${LOOK_REC_DIR}/text.txt`));
  } catch {
    // No text file (a session whose pages never yielded text) is not a
    // failure; there is simply nothing to match beyond what exists.
  }
  const hit = firstSecretIn(text, secrets);
  if (hit !== undefined) {
    await cleanup();
    return { kind: "withheld", reason: withheldRecordingReason(hit) };
  }
  let bytes: Uint8Array;
  try {
    bytes = await executor.getFile(report.file);
  } catch (error) {
    await cleanup();
    return { kind: "failed", reason: `the assembled recording never came back from the sandbox: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (artifacts?.putTemporary === undefined) {
    await cleanup();
    return { kind: "dropped", reason: "this worker has no artifact store configured, so the look recording has nowhere honest to live" };
  }
  if (bytes.length > LOOK_RECORD_MAX_BYTES) {
    await cleanup();
    return { kind: "dropped", reason: `the assembled recording is ${bytes.length} bytes, over the ${LOOK_RECORD_MAX_BYTES} byte cap: dropped rather than truncated` };
  }
  try {
    const artifact = await artifacts.putTemporary(`look-recording.${report.kind === "webm" ? "webm" : "jpg"}`, bytes, RECORDING_DATA_CLASS, { runId: binding.runId, ...(report.treeDigest !== undefined ? { treeDigest: report.treeDigest } : {}) });
    await cleanup();
    return { kind: "stored", artifact, digest: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, frames: report.frames, format: report.kind, ...(report.capped !== undefined ? { capped: report.capped } : {}), ...(report.treeDigest !== undefined ? { treeDigest: report.treeDigest } : {}) };
  } catch (error) {
    await cleanup();
    return { kind: "dropped", reason: `the artifact store refused the recording: ${error instanceof Error ? error.message : String(error)}` };
  }
}
