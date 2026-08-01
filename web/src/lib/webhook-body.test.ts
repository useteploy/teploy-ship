import assert from "node:assert/strict";
import test from "node:test";

import { BodyTooLarge, readCappedBody } from "./webhook.server.js";

function request(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://ship.test/hooks/github", { method: "POST", body, headers });
}

/** A body delivered in chunks, with no Content-Length to short-circuit on. */
function chunked(total: number, chunk = 1024): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let sent = 0;
      while (sent < total) {
        const size = Math.min(chunk, total - sent);
        controller.enqueue(new Uint8Array(size).fill(0x61));
        sent += size;
      }
      controller.close();
    },
  });
  return new Request("https://ship.test/hooks/github", {
    method: "POST",
    body: stream,
    // @ts-expect-error duplex is required by undici for a streaming body
    duplex: "half",
  });
}

test("a normal webhook body reads through unchanged", async () => {
  const payload = JSON.stringify({ action: "opened", issue: { number: 1 } });
  assert.equal(await readCappedBody(request(payload)), payload);
});

test("TS-030: an oversized Content-Length is rejected before any body is read", async () => {
  const req = request("x", { "content-length": String(50 * 1024 * 1024) });
  await assert.rejects(() => readCappedBody(req, 1024), BodyTooLarge);
});

test("TS-030: a chunked body is abandoned the moment it crosses the cap", async () => {
  await assert.rejects(() => readCappedBody(chunked(64 * 1024), 8 * 1024), BodyTooLarge);
});

test("a body exactly at the cap is allowed", async () => {
  const body = await readCappedBody(chunked(4096, 512), 4096);
  assert.equal(body.length, 4096);
});

test("an empty body is not an error", async () => {
  const req = new Request("https://ship.test/hooks/github", { method: "POST" });
  assert.equal(await readCappedBody(req), "");
});
