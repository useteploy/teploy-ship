import assert from "node:assert/strict";
import { test } from "node:test";
import { refreshForgeIfStale, requestKey, replyKey } from "./workspace-requests.js";
import type { ShipRuntime } from "./runtime.js";
test("automatic PR reads are throttled and do not replace a pending file inspection", async () => {
  const rows = new Map<string,string>(); let writes = 0;
  const runtime = { config: { get: async (key: string) => rows.get(key), set: async (key: string, value: string) => { writes++; rows.set(key,value); } }, loadMeta: async () => ({runId:"run-test"}) } as unknown as ShipRuntime;
  const at = new Date().toISOString();
  rows.set(requestKey("run-test"),JSON.stringify({ id:"files", kind:"files", at }));
  await refreshForgeIfStale(runtime,"run-test","viewer"); assert.equal(writes,0);
  rows.set(replyKey("run-test"),JSON.stringify({ id:"files", at }));
  await refreshForgeIfStale(runtime,"run-test","viewer"); assert.equal(writes,1);
  await refreshForgeIfStale(runtime,"run-test","viewer"); assert.equal(writes,1);
  rows.set("SHIP_FORGE_STATE_run-test",JSON.stringify({id:"forge",at}));
  await refreshForgeIfStale(runtime,"run-test","viewer"); assert.equal(writes,1);
});
