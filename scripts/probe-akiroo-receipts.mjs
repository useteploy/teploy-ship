// Run only against a disposable Nucleus after pnpm build. No models or forges.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NucleusPgwire } from "../dist/nucleus-pgwire.js";
import { NucleusAkirooReceipts } from "../dist/akiroo-receipts.js";
import { NucleusDeliveryLog } from "../dist/deliveries.js";
import { NucleusOutbox, flushOutbox } from "../dist/outbox.js";
import { sweepAkiroo } from "../dist/akiroo.js";

const url = process.env.SHIP_TEST_NUCLEUS_URL;
if (!url || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
  throw new Error("Set SHIP_TEST_NUCLEUS_URL to an isolated loopback test database");
}
const db = new NucleusPgwire(url, "akiroo-receipt-probe");
try {
  const key = `probe-${randomUUID()}`;
  const first = new NucleusAkirooReceipts(db);
  assert.equal(await first.get(key), undefined);
  await first.put(key, { status: "processing", detail: "", startedAt: 1 });
  const restarted = new NucleusAkirooReceipts(db);
  assert.equal((await restarted.get(key)).status, "processing");
  await restarted.put(key, { status: "succeeded", detail: "saved", startedAt: 1 });
  assert.equal((await first.get(key)).status, "succeeded");
  assert.equal((await db.query("SELECT payload FROM ship_akiroo_receipts WHERE receipt_key=$1", [key])).length, 1);

  const receipts = [];
  let calls = 0;
  const deps = {
    target: { url: `https://${key}.example.com`, token: "synthetic" },
    cursor: { get: async () => 0, set: async () => {}, reset: async () => {} },
    receipts: first, deliveries: new NucleusDeliveryLog(db),
    intake: { propose: async () => { throw new Error("unexpected intake"); } },
    enqueueScan: async () => { throw new Error("unexpected scan"); },
    registerProject: async () => {}, repoPolicy: {}, log: () => {},
    decide: async () => { calls++; throw new Error("synthetic uncertain response"); },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/ack")) {
        receipts.push(JSON.parse(String(init.body)).receipts);
        return new Response(JSON.stringify({ acked: 1 }));
      }
      return new Response(JSON.stringify({ items: [{ id: 1, kind: "decision", payload: { run_id: key, event_name: "approve-merge" } }] }));
    },
  };
  await sweepAkiroo(deps);
  deps.receipts = restarted;
  await sweepAkiroo(deps);
  assert.equal(calls, 1);
  assert.deepEqual(receipts.map((r) => r[0].status), ["unknown", "unknown"]);

  const box = new NucleusOutbox(db);
  const event = { runId: key, status: "completed", eventSeq: 20, eventAt: "2026-09-12T12:00:00Z" };
  await box.enqueue({ id: key, event });
  for (let i = 0; i < 8; i++) await flushOutbox(box, async () => false, (i+1)*1_000_000);
  const pending = await box.due(Number.MAX_SAFE_INTEGER);
  assert.ok(pending.some((e) => e.id === key), "failed delivery was discarded");
  assert.equal(await flushOutbox(box, async (actual) => { assert.deepEqual(actual,event); return true; }, Number.MAX_SAFE_INTEGER), 1);
  console.log("PASS: Nucleus receipt persistence, failed-action containment, and notification retry retention");
} finally {
  await db.close();
}
