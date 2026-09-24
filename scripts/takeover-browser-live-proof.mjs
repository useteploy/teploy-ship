#!/usr/bin/env node
/**
 * LIVE proof for the takeover BROWSER tab (S12's last surface).
 *
 * The unit suites assert against a FAKE driver speaking the same JSON-over-
 * stdio protocol (src/takeover.test.ts); live-Chromium proof is deliberately
 * NOT CI's to give — this script is the orchestrator's to run, on a box with
 * a REAL teploy-sandbox daemon and a REAL sandbox image (the node or go
 * image: they ship Debian chromium + global playwright; the rust image does
 * not, and the tab must say so honestly there).
 *
 * What it proves, through the REAL serveWorkspaceRequests path (the same
 * code the worker's sweep runs — no reimplementation):
 *
 *   1. a sandbox is created through the daemon and serves a fixture HTML
 *      site from inside itself (python3 http.server on :8000),
 *   2. a run parked at PLAN approval whose latest sandbox handle is that
 *      container — the exact state the takeover card requires,
 *   3. the lease is acquired, and the browser op chain works end to end:
 *        navigate  -> a real screenshot comes back (PNG magic bytes asserted)
 *        click     -> the page-2 link moves the URL to /page2.html
 *        viewport  -> the reply reports the new size
 *        scroll    -> succeeds without moving the URL
 *        type+key  -> the fixture echoes them into the page (URL query)
 *   4. handback closes the driver under the still-held lease (disposition
 *      recorded in the session), and the session/history/handback records
 *      carry the browser ops.
 *
 * Usage (worker host, real daemon):
 *   SHIP_SANDBOX_URL=... SHIP_SANDBOX_TOKEN=... \
 *   SHIP_SANDBOX_IMAGE=ship-sandbox-node:dev \
 *   node scripts/takeover-browser-live-proof.mjs [--keep]
 *
 * --keep leaves the sandbox and the scratch state dir behind for inspection.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const keep = process.argv.includes("--keep");
const scratch = mkdtempSync(join(tmpdir(), "ship-browser-proof-"));
process.env.TEPLOY_SHIP_STATE = join(scratch, "state");
process.env.SHIP_STORE = "file";

const { sandboxProvider } = await import("../dist/durable.js");
const { fileRuntime } = await import("../dist/runtime.js");
const { PLAN_EVENT } = await import("../dist/plan.js");
const { requestWorkspace, serveWorkspaceRequests } = await import("../dist/workspace-requests.js");
const { takeoverHistoryKey, takeoverReplyKey } = await import("../dist/takeover.js");

const url = process.env.SHIP_SANDBOX_URL;
const token = process.env.SHIP_SANDBOX_TOKEN;
if (url === undefined || token === undefined) {
  console.error("SHIP_SANDBOX_URL and SHIP_SANDBOX_TOKEN are required (the real teploy-sandbox daemon).");
  process.exit(2);
}
const image = process.env.SHIP_SANDBOX_IMAGE ?? "ship-sandbox-node:dev";
const PROOF_REPO = "https://github.com/teploy/browser-live-proof";

const runtime = fileRuntime();
const executor = sandboxProvider({
  baseURL: url,
  token,
  image, network: "none", ttlSec: 900, // the app-under-test case: in-sandbox only
});
const runId = `browser-proof-${Date.now().toString(36)}`;
const assert = (claim, what) => {
  if (!claim) {
    console.error(`FAIL: ${what}`);
    process.exitCode = 1;
  } else {
    console.log(`ok - ${what}`);
  }
};
const replyOf = async () => JSON.parse((await runtime.config.get(takeoverReplyKey(runId))) ?? "null");
async function op(kind, extra) {
  await requestWorkspace(runtime, runId, kind, "orchestrator", undefined, extra);
  await serveWorkspaceRequests(runtime, executor, { allowlist: PROOF_REPO });
  const reply = await replyOf();
  if (reply.error !== undefined) console.error(`     (reply error: ${reply.error})`);
  return reply;
}
const browser = (action) => op("takeover-browser", { browser: JSON.stringify(action) });

let handle;
try {
  ({ handle } = await executor.create({}));
  console.log(`sandbox ${handle} on image ${image}`);
  const site = await executor.attach(handle).exec(
    [
      "set -e; cd /work; mkdir -p site",
      "cat > site/index.html <<'HTML_EOF'",
      "<!doctype html><html><body style='margin:0'>",
      "<a id='next' href='/page2.html' style='position:absolute;left:24px;top:24px;font-size:18px'>page 2</a>",
      "<form action='/echo.html' method='get' style='position:absolute;left:24px;top:80px'>",
      "<input name='q' value='' style='width:300px;height:24px'></form>",
      "</body></html>",
      "HTML_EOF",
      "cat > site/page2.html <<'HTML_EOF'",
      "<!doctype html><html><body><h1>page two</h1></body></html>",
      "HTML_EOF",
      "cat > site/echo.html <<'HTML_EOF'",
      "<!doctype html><html><body>",
      "<form action='/echo.html' method='get' style='position:absolute;left:24px;top:80px'>",
      "<input id='q' name='q' value='' style='width:300px;height:24px'></form>",
      "<h1 id='out' style='position:absolute;left:24px;top:140px'></h1>",
      "<script>",
      "const q=document.getElementById('q'),out=document.getElementById('out');",
      // Every action re-loads the page (restart-per-op driver); the profile's
      // localStorage is what carries state across that boundary.
      "q.value=localStorage.getItem('q')??'';",
      "q.addEventListener('input',()=>localStorage.setItem('q',q.value));",
      "out.textContent=new URLSearchParams(location.search).get('q')??'';",
      "</script></body></html>",
      "HTML_EOF",
      "(cd site && setsid nohup python3 -m http.server 8000 >/dev/null 2>&1 &)",
      "sleep 1; curl -sf http://localhost:8000/ | grep -q 'page 2'",
    ].join("\n"),
    { timeoutMs: 60_000 },
  );
  assert(site.exitCode === 0, "fixture site written and serving inside the sandbox");

  const now = new Date().toISOString();
  await runtime.store.append(runId, { v: 1, seq: 1, at: now, type: "run-started", data: { input: { repo: PROOF_REPO, task: "browser live proof", plan: true, trust: "operator" } } });
  await runtime.store.append(runId, { v: 1, seq: 2, at: now, type: "step-completed", name: "sandbox", data: { result: { handle } } });
  await runtime.saveMeta({ runId, task: "browser live proof", status: "waiting", eventName: PLAN_EVENT, model: "proof", source: "manual", createdAt: now, updatedAt: now });
  console.log(`run ${runId} parked at plan approval`);

  const acquired = await op("takeover-acquire");
  assert(acquired.takeover?.holder === "orchestrator", "lease acquired through the mediated path");

  const page1 = await browser({ action: "navigate", url: "http://localhost:8000/" });
  assert(page1.browser?.url === "http://localhost:8000/", "navigate returns the page URL");
  const capture = page1.browser?.artifact ? await runtime.artifacts.get(page1.browser.artifact) : null;
  const png = Buffer.from(capture?.data ?? "", "base64");
  assert(typeof capture?.expiresAt === "string", "new screenshot carries its retention deadline");
  assert(png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47, `a real PNG screenshot came back (${png.length} bytes)`);
  assert((page1.browser?.width ?? 0) === 1280 && (page1.browser?.height ?? 0) === 800, "default viewport is 1280x800");

  // the link sits at 24,24 with 18px text — click the middle of it
  const clicked = await browser({ action: "click", x: 40, y: 32 });
  assert((clicked.browser?.url ?? "").endsWith("/page2.html"), `click on the link moved the URL (${clicked.browser?.url})`);

  const typed = await browser({ action: "navigate", url: "http://localhost:8000/echo.html" });
  assert((typed.browser?.url ?? "").includes("echo.html"), "the form page loads");
  await browser({ action: "click", x: 60, y: 92 }); // focus the input
  await browser({ action: "type", text: "hello proof" });
  // The typed text survived the action boundary ONLY through the profile's
  // localStorage (each action re-loads the page) — Enter submits the restored
  // value as a GET, which the reply URL proves end to end.
  const submitted = await browser({ action: "key", key: "Enter" });
  assert((submitted.browser?.url ?? "").includes("q=hello"), `typed text persisted via the profile and submitted (${submitted.browser?.url})`);
  const scrolled = await browser({ action: "scroll", dy: 400 });
  assert(scrolled.browser?.artifact !== undefined, "scroll still returns a screenshot");
  const resized = await browser({ action: "viewport", w: 800, h: 600 });
  assert(resized.browser?.width === 800 && resized.browser?.height === 600, "viewport change applied");

  const released = await op("takeover-release", { reason: "live proof complete" });
  assert(/Handed back/.test(released.output ?? ""), "handback recorded");
  const history = JSON.parse((await runtime.config.get(takeoverHistoryKey(runId))) ?? "[]");
  const session = history.at(-1) ?? {};
  assert(session.outcome === "released", "session outcome released");
  assert((session.browserOps ?? []).length >= 7, `browser ops recorded in the session (${(session.browserOps ?? []).length})`);
  assert((session.note ?? "").includes("browser closed, profile wiped"), "close disposition recorded at handback");
  const post = await executor.attach(handle).exec("ls /work/.ship/ 2>/dev/null; test ! -d /work/.ship/browser-profile && echo PROFILE_GONE", { timeoutMs: 15_000 });
  assert(post.stdout.includes("PROFILE_GONE"), "profile wiped on close");

  console.log(process.exitCode === 1 ? "LIVE PROOF FAILED" : "LIVE PROOF PASSED");
} finally {
  if (!keep && handle) await executor.destroy?.(handle).catch(() => {});
  await runtime.close().catch(() => {});
  if (!keep) rmSync(scratch, { recursive: true, force: true });
  else console.log(`kept: sandbox + state under ${scratch}`);
}
