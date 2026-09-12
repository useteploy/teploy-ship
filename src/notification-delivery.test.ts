import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runWebhookPayload } from "./notify.js";

test("worker notification sends only leave through the durable outbox flush", async () => {
  const source = await readFile(new URL("./worker.js", import.meta.url), "utf8");
  assert.equal([...source.matchAll(/\bnotify\.runEvent\(/g)].length, 1);
  assert.match(source, /flushOutbox\(outbox, \(event, id\) => notify\.runEvent\(event, id\)/);
  assert.equal([...source.matchAll(/await owe\(/g)].length, 3, "fallback, park and terminal all persist before sending");
});

test("wire chronology is copied from the event, not generated per delivery", () => {
  const payload = runWebhookPayload({ runId: "run-chronology", status: "completed", eventSeq: 25, eventAt: "2026-09-12T12:00:00Z" });
  assert.equal(payload.event_seq,25);
  assert.equal(payload.event_at,"2026-09-12T12:00:00Z");
  assert.equal(runWebhookPayload({ runId: "legacy", status: "waiting" }).event_seq,undefined);
});
