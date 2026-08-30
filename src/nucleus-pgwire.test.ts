import assert from "node:assert/strict";
import { test } from "node:test";

import { NucleusPgwire, isTransientPoolFailure, type PoolLike, type SoloClientLike } from "./nucleus-pgwire.js";

const MASKED = new TypeError("Cannot read properties of undefined (reading 'name')");

/**
 * A pool that can be told to reject, plus the solo connection the retry path
 * opens. The distinction is the whole point of the fixture: `pool.connect()`
 * hands back a POOLED client — very often the one that just failed — which is
 * why the retry has to go somewhere else entirely.
 */
function fakePool(plan: { poolRejections: unknown[]; soloFails?: boolean; clientFails?: boolean }) {
  const log: string[] = [];
  let released: boolean | undefined;
  let soloEnded = 0;
  const pool: PoolLike = {
    async query(sql) {
      log.push(`pool:${sql}`);
      if (plan.poolRejections.length > 0) throw plan.poolRejections.shift();
      return { rows: [{ v: "pooled" }], rowCount: 1 };
    },
    async connect() {
      log.push("pool-connect");
      return {
        async query(sql) {
          log.push(`pool-client:${sql}`);
          if (plan.clientFails) throw MASKED;
          return { rows: [{ v: "checked-out" }], rowCount: 1 };
        },
        release(destroy?: boolean) {
          released = destroy === true;
        },
      };
    },
    on() {
      return undefined;
    },
    async end() {},
  };
  const solo = (): SoloClientLike => ({
    async connect() {
      log.push("solo-connect");
      return undefined;
    },
    async query(sql) {
      log.push(`solo:${sql}`);
      if (plan.soloFails) throw MASKED;
      return { rows: [{ v: "solo" }], rowCount: 1 };
    },
    async end() {
      soloEnded += 1;
      log.push("solo-end");
    },
  });
  return { pool, solo, log, destroyed: () => released, soloEnded: () => soloEnded };
}

test("a masked pool rejection is retried on a connection of its own, never back into the pool", async () => {
  const { pool, solo, log } = fakePool({ poolRejections: [MASKED] });
  const db = new NucleusPgwire("postgres://x", "test", { pool, solo });
  assert.deepEqual(await db.query("SELECT 1"), [{ v: "solo" }]);
  // No `pool-connect`: the measured failure survives a checkout from the same
  // pool, so retrying there is retrying the thing that failed.
  assert.deepEqual(log, ["pool:SELECT 1", "solo-connect", "solo:SELECT 1", "solo-end"]);
});

test("the throwaway connection is closed whether the retry succeeds or fails", async () => {
  const ok = fakePool({ poolRejections: [MASKED] });
  await new NucleusPgwire("postgres://x", "test", { pool: ok.pool, solo: ok.solo }).query("SELECT 1");
  assert.equal(ok.soloEnded(), 1);

  const bad = fakePool({ poolRejections: [MASKED], soloFails: true });
  await assert.rejects(new NucleusPgwire("postgres://x", "test", { pool: bad.pool, solo: bad.solo }).query("SELECT 1"), /reading 'name'/);
  assert.equal(bad.soloEnded(), 1, "a leaked connection per failure would be worse than the failure");
});

test("a rejection with no error object at all is also retried", async () => {
  const { pool, solo } = fakePool({ poolRejections: [undefined] });
  const db = new NucleusPgwire("postgres://x", "test", { pool, solo });
  assert.equal(await db.exec("UPDATE t SET c = c WHERE 1=0"), 1);
});

test("with no way to open a connection of its own, the retry still falls back to a checkout", async () => {
  const { pool, log, destroyed } = fakePool({ poolRejections: [undefined], clientFails: true });
  // An injected pool with no solo seam — the shape a test or an embedder uses.
  const db = new NucleusPgwire("", "test", { pool });
  await assert.rejects(db.query("SELECT 1"), /reading 'name'/);
  assert.deepEqual(log, ["pool:SELECT 1", "pool-connect", "pool-client:SELECT 1"]);
  assert.equal(destroyed(), true, "release(true) so the poisoned connection is not handed back out");
});

test("a genuine database error is not retried", async () => {
  const dbError = Object.assign(new Error("syntax error at or near \"SELEC\""), { code: "42601" });
  const { pool, solo, log } = fakePool({ poolRejections: [dbError] });
  const db = new NucleusPgwire("postgres://x", "test", { pool, solo });
  await assert.rejects(db.query("SELEC 1"), /syntax error/);
  assert.deepEqual(log, ["pool:SELEC 1"], "no second attempt of any kind");
});

test("isTransientPoolFailure: the shapes seen live are transient; SQLSTATE errors are not", () => {
  assert.equal(isTransientPoolFailure(MASKED), true);
  assert.equal(isTransientPoolFailure(undefined), true);
  assert.equal(isTransientPoolFailure(new Error("timeout exceeded when trying to connect")), true);
  assert.equal(isTransientPoolFailure(new Error("Connection terminated unexpectedly")), true);
  assert.equal(isTransientPoolFailure(Object.assign(new Error("dup"), { code: "23505" })), false);
  assert.equal(isTransientPoolFailure(new Error("some application error")), false);
});
