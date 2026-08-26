import assert from "node:assert/strict";
import { test } from "node:test";

import { NucleusPgwire, isTransientPoolFailure, type PoolLike } from "./nucleus-pgwire.js";

const MASKED = new TypeError("Cannot read properties of undefined (reading 'name')");

function fakePool(plan: { poolRejections: unknown[]; clientFails?: boolean }) {
  const log: string[] = [];
  let released: boolean | undefined;
  const pool: PoolLike = {
    async query(sql) {
      log.push(`pool:${sql}`);
      if (plan.poolRejections.length > 0) throw plan.poolRejections.shift();
      return { rows: [{ v: "pooled" }], rowCount: 1 };
    },
    async connect() {
      log.push("connect");
      return {
        async query(sql) {
          log.push(`client:${sql}`);
          if (plan.clientFails) throw MASKED;
          return { rows: [{ v: "fresh" }], rowCount: 1 };
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
  return { pool, log, destroyed: () => released };
}

test("a masked pg-pool rejection is retried once on a fresh client and the caller sees rows", async () => {
  const { pool, log } = fakePool({ poolRejections: [MASKED] });
  const db = new NucleusPgwire("postgres://x", "test", { pool });
  const rows = await db.query("SELECT 1");
  assert.deepEqual(rows, [{ v: "fresh" }]);
  assert.deepEqual(log, ["pool:SELECT 1", "connect", "client:SELECT 1"]);
});

test("a rejection with no error object at all is also retried", async () => {
  const { pool } = fakePool({ poolRejections: [undefined] });
  const db = new NucleusPgwire("postgres://x", "test", { pool });
  assert.equal(await db.exec("UPDATE t SET c = c WHERE 1=0"), 1);
});

test("when the fresh client fails too, it is destroyed and a real Error surfaces", async () => {
  const { pool, destroyed } = fakePool({ poolRejections: [undefined], clientFails: true });
  const db = new NucleusPgwire("postgres://x", "test", { pool });
  await assert.rejects(db.query("SELECT 1"), /reading 'name'/);
  assert.equal(destroyed(), true, "release(true) so the poisoned connection is not handed back out");
});

test("a genuine database error is not retried", async () => {
  const dbError = Object.assign(new Error("syntax error at or near \"SELEC\""), { code: "42601" });
  const { pool, log } = fakePool({ poolRejections: [dbError] });
  const db = new NucleusPgwire("postgres://x", "test", { pool });
  await assert.rejects(db.query("SELEC 1"), /syntax error/);
  assert.deepEqual(log, ["pool:SELEC 1"], "no connect, no second attempt");
});

test("isTransientPoolFailure: the shapes seen live are transient; SQLSTATE errors are not", () => {
  assert.equal(isTransientPoolFailure(MASKED), true);
  assert.equal(isTransientPoolFailure(undefined), true);
  assert.equal(isTransientPoolFailure(new Error("timeout exceeded when trying to connect")), true);
  assert.equal(isTransientPoolFailure(new Error("Connection terminated unexpectedly")), true);
  assert.equal(isTransientPoolFailure(Object.assign(new Error("dup"), { code: "23505" })), false);
  assert.equal(isTransientPoolFailure(new Error("some application error")), false);
});
