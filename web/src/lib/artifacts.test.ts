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
async function response(
  id: string,
  auth = true,
  range?: string,
): Promise<Response> {
  const request = new Request("http://localhost/api/artifacts/" + id, {
    headers: {
      ...(auth ? { authorization: "Bearer artifact-tests" } : {}),
      ...(range ? { range } : {}),
    },
  });
  try {
    return await loader({ params: { id }, request });
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
