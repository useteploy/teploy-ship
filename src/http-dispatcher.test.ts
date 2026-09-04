import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Agent, fetch as undiciFetch } from "undici";
import { longRequestFetch } from "./http-dispatcher.js";

// A response whose next byte arrives later than the transport's idle limit
// (undici's timers tick at one-second resolution, so the gap is seconds, not
// milliseconds).
// The control half shows the limit is real for a fetch from the same
// package; the second half shows the worker's fetch is not cut by it. A
// previous version of this test installed a global dispatcher and asserted
// that Node's global fetch obeyed it; it did not, which is why the fix is a
// fetch handed to the client rather than a process-wide setting.
test("sandbox fetch: a streamed response that goes quiet is not cut by the transport", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("started\n");
    setTimeout(() => res.end("done\n"), 2500);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/`;
  try {
    const impatient = new Agent({ headersTimeout: 0, bodyTimeout: 1000 });
    await assert.rejects(
      async () => (await undiciFetch(url, { dispatcher: impatient })).text(),
      /terminated|fetch failed|Body Timeout/,
    );
    const body = await (await longRequestFetch(url)).text();
    assert.equal(body, "started\ndone\n");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
