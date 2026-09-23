// Wave-8 orchestrator history digest: hash ordered run histories read-only.
// SHA-256 over every run's id + status + ordered event stream, so a rollout
// that preserves history produces the identical digest before and after.
// Read-only; run with the worker env (NUCLEUS_URL), cwd = a teploy-ship
// checkout (imports ./dist and the workflow package).
import { createHash } from "node:crypto";
import { NucleusPgwire } from "./dist/nucleus-pgwire.js";
import { NucleusEventStore } from "@neutron-build/workflow";

const db = new NucleusPgwire(process.env.NUCLEUS_URL, "history-digest");
const store = new NucleusEventStore(db.streams, { prefix: "ship" });
const rows = await db.query("SELECT run_id, status FROM ship_docs WHERE collection IN ('ship_runs','ship_meta') ORDER BY run_id");
const byId = new Map();
for (const r of rows) byId.set(r.run_id, r.status ?? "");
const ids = [...byId.keys()].sort();
let events = 0;
const h = createHash("sha256");
const waiting = [];
for (const id of ids) {
  const status = String(byId.get(id) ?? "");
  h.update(id);
  h.update(status);
  if (status === "waiting") waiting.push(id);
  let log = [];
  try { log = await store.load(id); } catch { log = []; }
  for (const e of log) { events++; h.update(JSON.stringify(e)); }
}
console.log(JSON.stringify({ runs: ids.length, events, historySHA256: h.digest("hex"), waiting: waiting.sort() }));
