import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileOutbox, MAX_ATTEMPTS, backoffMs, flushOutbox, notificationId } from "./outbox.js";
import type { RunNotification } from "./notify.js";

const parked: RunNotification = { runId: "run-1", status: "waiting", eventName: "turn-3-approval" };

async function outbox(): Promise<FileOutbox> {
  return new FileOutbox(await mkdtemp(join(tmpdir(), "ship-outbox-")));
}

test("TS-025: a notification survives a failed delivery and is retried", async () => {
  const box = await outbox();
  await box.enqueue({ id: notificationId(parked), event: parked });

  // The provider is down: the entry must still be owed afterwards.
  let attempts = 0;
  const failing = async (): Promise<boolean> => {
    attempts += 1;
    return false;
  };
  assert.equal(await flushOutbox(box, failing, 1_000), 0);
  assert.equal(attempts, 1);
  assert.equal((await box.due(1_000)).length, 0, "backed off — not due immediately");
  assert.equal((await box.due(1_000 + backoffMs(1))).length, 1, "and due again after the backoff");

  // Provider recovers.
  assert.equal(await flushOutbox(box, async () => true, 1_000 + backoffMs(1)), 1);
  assert.equal((await box.due(Number.MAX_SAFE_INTEGER)).length, 0, "delivered entries are settled");
});

test("a delivery that throws is treated as a failure, not a loss", async () => {
  const box = await outbox();
  await box.enqueue({ id: "x", event: parked });
  assert.equal(
    await flushOutbox(box, async () => {
      throw new Error("connection reset");
    }, 0),
    0,
  );
  assert.equal((await box.due(backoffMs(1))).length, 1, "still owed");
});

test("enqueue is idempotent, so a handoff does not owe the same notification twice", async () => {
  const box = await outbox();
  await box.enqueue({ id: notificationId(parked), event: parked });
  await box.enqueue({ id: notificationId(parked), event: parked });
  assert.equal((await box.due(0)).length, 1);
});

test("an entry is abandoned rather than retried forever", async () => {
  const box = await outbox();
  await box.enqueue({ id: "y", event: parked });
  let now = 0;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await flushOutbox(box, async () => false, now);
    now += backoffMs(i + 1);
  }
  assert.equal((await box.due(Number.MAX_SAFE_INTEGER)).length, 0, "gives up after the attempt cap");
});

test("the delivery id is stable per run+status so a receiver can dedupe", () => {
  assert.equal(notificationId(parked), "run-1:waiting:turn-3-approval");
  assert.equal(notificationId({ runId: "run-1", status: "completed" }), "run-1:completed:");
  assert.notEqual(notificationId(parked), notificationId({ ...parked, eventName: "turn-4-approval" }));
});

test("backoff grows and is capped", () => {
  assert.ok(backoffMs(1) < backoffMs(3));
  assert.equal(backoffMs(99), 15 * 60_000);
});
