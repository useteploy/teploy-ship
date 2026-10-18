import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.TEPLOY_SHIP_STATE = mkdtempSync(
  join(tmpdir(), "ship-artifact-route-"),
);
process.env.SHIP_STORE = "file";
process.env.SHIP_WEB_TOKEN = "artifact-tests";
const { shipRuntime } = await import("./store.server.js");
const { loader } = await import("../routes/api/artifacts/[id].js");
const { signSession, SESSION_COOKIE } = await import("./session.server.js");
const { mayViewArtifact, mayViewRun } = await import("./run-access.server.js");
type As = boolean | "viewer" | "editor";
async function response(
  id: string,
  auth: As = true,
  range?: string,
  mayView?: (user: { user: string; role: string }, runId: string) => Promise<boolean>,
): Promise<Response> {
  const request = new Request("http://localhost/api/artifacts/" + id, {
    headers: {
      ...(auth === true ? { authorization: "Bearer artifact-tests" } : {}),
      ...(typeof auth === "string"
        ? { cookie: `${SESSION_COOKIE}=${signSession({ user: `sso#${auth}`, role: auth }, "sso")}` }
        : {}),
      ...(range ? { range } : {}),
    },
  });
  try {
    return await loader({ params: { id }, request, ...(mayView ? { mayView } : {}) });
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}
test("artifacts require authentication and support bounded video byte ranges", async () => {
  const runtime = await shipRuntime(),
    bytes = Buffer.from([26, 69, 223, 163, 0, 1, 2, 3, 4, 5]);
  const id = await runtime.artifacts!.put("proof.webm", bytes);
  assert.equal((await response(id, false)).status, 401);
  const partial = await response(id, true, "bytes=2-5");
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), "bytes 2-5/10");
  assert.deepEqual(
    Buffer.from(await partial.arrayBuffer()),
    bytes.subarray(2, 6),
  );
  assert.equal((await response(id, true, "bytes=99-")).status, 416);
  assert.equal((await response("../secret")).status, 404);
});

test("takeover screenshots (PNG or the JPEG fallback) are served through the same authenticated route", async () => {
  const runtime = await shipRuntime();
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);
  const id = await runtime.artifacts!.put("takeover-run-1.jpg", jpeg);
  assert.equal((await response(id, false)).status, 401);
  const ok = await response(id);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), jpeg);
});

const WEBM = Buffer.from([26, 69, 223, 163, 7, 7, 7]);

test("Q3a: a viewer may open an artifact bound to a run they may view; never cached", async () => {
  const runtime = await shipRuntime();
  const id = await runtime.artifacts!.putTemporary!("walk.webm", WEBM, "recording", { runId: "run-q3a", revision: "a".repeat(40) });
  assert.equal((await response(id, false)).status, 401);
  const ok = await response(id, "viewer");
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("cache-control") ?? "", /no-store/);
  assert.match(ok.headers.get("cache-control") ?? "", /private/);
  assert.equal((await response(id, "editor")).status, 200);
  assert.equal((await response(id)).status, 200);
});

test("Q3a: an artifact without a run binding is admin-only, and a non-admin gets 404, not 403", async () => {
  const runtime = await shipRuntime();
  const id = await runtime.artifacts!.put("legacy.png", Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 9]));
  assert.equal((await response(id, "viewer")).status, 404);
  assert.equal((await response(id, "editor")).status, 404);
  const admin = await response(id);
  assert.equal(admin.status, 200);
  assert.match(admin.headers.get("cache-control") ?? "", /no-store/);
});

test("Q3a non-member control: when mayViewRun says no, the bound artifact is a 404", async () => {
  const runtime = await shipRuntime();
  const id = await runtime.artifacts!.putTemporary!("walk.webm", WEBM, "recording", { runId: "run-other" });
  const asked: string[] = [];
  const deny = async (_u: unknown, runId: string) => { asked.push(runId); return false; };
  assert.equal((await response(id, "viewer", undefined, deny)).status, 404);
  assert.equal((await response(id, true, undefined, deny)).status, 404, "admin follows the run check too");
  assert.deepEqual(asked, ["run-other", "run-other"], "the check is asked with the artifact's bound run");
  assert.equal(await mayViewArtifact({ user: "v", role: "viewer" }, { runId: "run-other" }, async () => false), false);
  assert.equal(await mayViewRun({ user: "v", role: "viewer" }, "run-other"), true, "today: every viewer may view every run");
});
