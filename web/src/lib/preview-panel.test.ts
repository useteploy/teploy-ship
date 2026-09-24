import assert from "node:assert/strict";
import { test } from "node:test";
import { previewPanel, type LogEvent } from "./workspace.js";
import { dashboardCsp, frameAllowed } from "./csp.js";
import { previewFrameBase } from "./preview-frame.server.js";

const at = "2026-09-24T10:00:00Z";
const NOW = Date.parse("2026-09-24T12:00:00Z");
const DASH = "http://100.70.0.5:7460";
const started = (input: Record<string, unknown>): LogEvent[] => [{ type: "run-started", at, data: { input: { task: "t", ...input } } }];
const DECLARED = started({ verification: { preview: { app: "site", smoke: "true" } } });
const URL_ = "http://preview-ship-abc-1a2b3c4d.100.101.102.103.sslip.io/";
const BASE = "100.101.102.103.sslip.io";
const opts = (o: Partial<{ executing: boolean; now: number; dashboardOrigin: string; frameBase: string | undefined }> = {}) => ({ executing: false, now: NOW, dashboardOrigin: DASH, frameBase: BASE, ...o });

test("preview panel: nothing declared is its own state, not a failure", () => {
  assert.deepEqual(previewPanel(started({}), {}, opts()), { state: "none" });
  assert.deepEqual(previewPanel(started({}), {}, opts({ executing: true })), { state: "none" });
});

test("preview panel: declared and not yet recorded is deploying while the run is active, and said plainly once it is not", () => {
  assert.deepEqual(previewPanel(DECLARED, {}, opts({ executing: true })), { state: "deploying" });
  assert.deepEqual(previewPanel(started({ preview: true }), {}, opts({ executing: true })), { state: "deploying" }, "the legacy SHIP_PREVIEW flag declares one too");
  const ended = previewPanel(DECLARED, {}, opts());
  assert.equal(ended.state, "not-deployed");
});

test("preview panel: failed and skipped carry the recorded reason", () => {
  assert.deepEqual(previewPanel(DECLARED, { preview: { kind: "failed", reason: "teploy build failed (exit 1)" } }, opts()), {
    state: "failed",
    reason: "teploy build failed (exit 1)",
  });
  assert.deepEqual(previewPanel(DECLARED, { preview: { kind: "skipped", reason: "no preview target configured on this worker" } }, opts()), {
    state: "not-deployed",
    reason: "no preview target configured on this worker",
  });
});

test("preview panel: deployed frames the preview's own URL with its expiry", () => {
  const panel = previewPanel(DECLARED, { preview: { kind: "deployed", url: URL_, expiresAt: "2026-09-25T10:00:00Z" } }, opts());
  assert.deepEqual(panel, { state: "deployed", url: URL_, expiresAt: "2026-09-25T10:00:00Z" });
  assert.deepEqual(previewPanel(DECLARED, { preview: { kind: "deployed", url: URL_ } }, opts()), { state: "deployed", url: URL_ }, "no expiry recorded is not an invented one");
});

test("preview panel: past its TTL it is expired, and no frame is offered", () => {
  assert.deepEqual(previewPanel(DECLARED, { preview: { kind: "deployed", url: URL_, expiresAt: "2026-09-24T11:59:59Z" } }, opts()), {
    state: "expired",
    url: URL_,
    expiresAt: "2026-09-24T11:59:59Z",
  });
});

test("preview panel: a preview the observe window or recovery tore down is removed, not framed", () => {
  const preview = { kind: "deployed", url: URL_, expiresAt: "2026-09-25T10:00:00Z" };
  assert.equal(previewPanel(DECLARED, { preview, observeWindow: { kind: "worse", rollback: { kind: "rolled-back" } } }, opts()).state, "removed");
  assert.equal(previewPanel(DECLARED, { preview, rollback: { kind: "rolled-back", scope: "preview" } }, opts()).state, "removed");
  assert.equal(previewPanel(DECLARED, { preview, observeWindow: { kind: "worse", rollback: { kind: "failed" } } }, opts()).state, "deployed", "a failed teardown leaves it up");
});

test("preview panel: frames only the configured tailnet base, never the dashboard's own origin, and says why otherwise", () => {
  const same = previewPanel(DECLARED, { preview: { kind: "deployed", url: `${DASH}/preview/x` } }, opts());
  assert.equal(same.state, "deployed");
  if (same.state === "deployed") assert.match(same.blocked ?? "", /run with your session/);
  const unconfigured = previewPanel(DECLARED, { preview: { kind: "deployed", url: URL_ } }, opts({ frameBase: undefined }));
  if (unconfigured.state === "deployed") assert.match(unconfigured.blocked ?? "", /SHIP_PREVIEW_TAILNET_IP is not set on its web process/);
  const elsewhere = previewPanel(DECLARED, { preview: { kind: "deployed", url: "https://preview-x.example.com/" } }, opts());
  if (elsewhere.state === "deployed") assert.match(elsewhere.blocked ?? "", /frames only previews under 100\.101\.102\.103\.sslip\.io/);
  const mixed = previewPanel(DECLARED, { preview: { kind: "deployed", url: URL_ } }, opts({ dashboardOrigin: "https://ship.example.com" }));
  if (mixed.state === "deployed") assert.match(mixed.blocked ?? "", /mixed content/);
  assert.deepEqual(previewPanel(DECLARED, { preview: { kind: "deployed", url: URL_ } }, opts()), { state: "deployed", url: URL_ });
});

test("preview panel: a recorded URL that is not http(s) is never opened or framed", () => {
  for (const url of ["javascript:alert(1)", "/api/decide", "http://user:pw@preview.example.com/", ""]) {
    assert.equal(previewPanel(DECLARED, { preview: { kind: "deployed", url } }, opts()).state, "failed", url);
  }
});

const directives = (csp: string) => new Map(csp.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1).join(" ")]));

test("dashboard CSP: frames exactly the configured preview base, nothing without one, and the dashboard stays unframeable", () => {
  const narrow = directives(dashboardCsp(BASE));
  assert.equal(narrow.get("frame-src"), "http://*.100.101.102.103.sslip.io", "one origin pattern, never a scheme-wide wildcard");
  assert.equal(narrow.get("frame-ancestors"), "'none'");
  assert.equal(narrow.get("default-src"), "'self'");
  assert.equal(narrow.get("script-src"), "'self' 'unsafe-inline'", "framing must not widen script sources");
  assert.equal(narrow.get("connect-src"), "'self'");
  const none = directives(dashboardCsp(undefined));
  assert.equal(none.has("frame-src"), false, "unconfigured: default-src 'self' blocks every foreign frame, as before");
  assert.equal(none.get("default-src"), "'self'");
});

test("frameAllowed mirrors the CSP host-source: http, default port, a host under the base", () => {
  assert.equal(frameAllowed(URL_, BASE), true);
  assert.equal(frameAllowed("http://preview-x.100.101.102.103.sslip.io:8080/", BASE), false, "a host-source without a port matches only the default port");
  assert.equal(frameAllowed("https://preview-x.100.101.102.103.sslip.io/", BASE), false);
  assert.equal(frameAllowed("http://100.101.102.103.sslip.io/", BASE), false, "the base itself is not a preview");
  assert.equal(frameAllowed("http://preview-x.evil100.101.102.103.sslip.io.example.com/", BASE), false);
  assert.equal(frameAllowed(URL_, undefined), false);
});

test("the web process derives the frame base from the same SHIP_PREVIEW_TAILNET_IP the worker deploys under", () => {
  assert.equal(previewFrameBase({ SHIP_PREVIEW_TAILNET_IP: "100.101.102.103" }), BASE);
  assert.equal(previewFrameBase({}), undefined);
  assert.equal(previewFrameBase({ SHIP_PREVIEW_TAILNET_IP: "192.168.1.5" }), undefined, "not a tailnet address: frame nothing");
});
