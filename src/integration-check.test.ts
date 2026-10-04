import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { LocalExecutor } from "@neutron-build/agents";

import { coordinationComplete, coordinationKey, createCoordination, integrationGate, loadCoordination } from "./coordination.js";
import type { CoordinationRecord } from "./coordination.js";
import { currentPairRevisions, integrationCheckEnabled, runCoordinationIntegrationCheck, runIntegrationCheck } from "./integration-check.js";
import type { ShipRuntime } from "./runtime.js";

// The REAL standalone fixture (evals/coordination-fixtures): two dependency
// free repos and the independent verify-pair.mjs. Nothing here is mocked: the
// declared command starts the producer's HTTP server and drives the consumer
// against it through the executor.
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "evals", "coordination-fixtures");
const VERIFY = join(FIXTURES, "verify-pair.mjs");
const COMMAND = `node ${VERIFY} {producer} {consumer} /sum`;
const ON = { SHIP_INTEGRATION_CHECK: "on" } as NodeJS.ProcessEnv;

let work: string;
const sha = { apiAdd: "", apiSum: "", clientAdd: "", clientSum: "" };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
}

/** A repo with two commits: the /add original and the /sum rename. */
async function makeRepo(name: "api" | "client"): Promise<{ dir: string; add: string; sum: string }> {
  const dir = join(work, `${name}-origin`);
  await cp(join(FIXTURES, name), dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "original /add");
  const add = git(dir, "rev-parse", "HEAD");
  const file = join(dir, name === "api" ? "server.mjs" : "client.mjs");
  await writeFile(file, (await readFile(file, "utf8")).replaceAll("/add", "/sum"));
  git(dir, "commit", "-aq", "-m", "rename to /sum");
  return { dir, add, sum: git(dir, "rev-parse", "HEAD") };
}

const origins: { api?: string; client?: string } = {};
before(async () => {
  work = await mkdtemp(join(tmpdir(), "integration-check-"));
  const api = await makeRepo("api");
  const client = await makeRepo("client");
  origins.api = api.dir;
  origins.client = client.dir;
  Object.assign(sha, { apiAdd: api.add, apiSum: api.sum, clientAdd: client.add, clientSum: client.sum });
});
after(async () => {
  await rm(work, { recursive: true, force: true });
});

/** A checkout of `origin` at exactly `rev` under the executor root. */
function checkout(label: string, origin: string, rev: string): string {
  const dir = join(work, label);
  git(work, "clone", "-q", origin, dir);
  git(dir, "checkout", "-q", "--detach", rev);
  return dir;
}

function memoryRuntime(): { runtime: ShipRuntime; config: Map<string, string> } {
  const config = new Map<string, string>();
  const runtime = {
    config: {
      get: async (k: string) => config.get(k),
      set: async (k: string, v: string) => void config.set(k, v),
      remove: async (k: string) => void config.delete(k),
      list: async () => [],
    },
    projects: { list: async () => [], forRepo: async () => null },
  } as unknown as ShipRuntime;
  return { runtime, config };
}

const API_REPO = "https://forge.example/team/api.git";
const CLIENT_REPO = "https://forge.example/team/client.git";

/** A coordination whose children both merged at the given revisions. */
function landed(apiSha: string, clientSha: string, declared: boolean): CoordinationRecord {
  const now = "2026-10-04T00:00:00.000Z";
  return {
    id: "coord-s18",
    parentIntent: "rename /add to /sum",
    model: "test/model",
    api: { repo: API_REPO, state: "merged", attempts: 1, anchorSha: apiSha },
    client: { repo: CLIENT_REPO, state: "merged", attempts: 1, anchorSha: apiSha, mergedSha: clientSha, clientCheck: "compatible" },
    ...(declared ? { integrationCheck: { command: COMMAND, evidence: [] } } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

async function runPair(apiRev: string, clientRev: string, record: CoordinationRecord, label: string) {
  const producerDir = checkout(`${label}-p`, origins.api!, apiRev);
  const consumerDir = checkout(`${label}-c`, origins.client!, clientRev);
  return runIntegrationCheck({ executor: new LocalExecutor({ root: work }), record, trees: { producerDir, consumerDir } });
}

test("real run: compatible API and client pass, recorded as executed-pair with both revisions, and complete the pair", async () => {
  const record = landed(sha.apiSum, sha.clientSum, true);
  const evidence = await runPair(sha.apiSum, sha.clientSum, record, "ok");
  assert.equal(evidence.result, "passed", evidence.source);
  assert.equal(evidence.class, "executed-pair");
  assert.equal(evidence.producer.sha, sha.apiSum);
  assert.equal(evidence.consumer.sha, sha.clientSum);
  assert.equal(evidence.command, COMMAND);
  assert.match(evidence.source ?? "", /"verified":true/, "the fixture's own output is kept as the audit trail");

  assert.equal(coordinationComplete(record, { env: ON }), false, "declared + flag on + no evidence blocks");
  record.integrationCheck!.evidence.push(evidence);
  assert.equal(integrationGate(record, { env: ON })?.state, "satisfied");
  assert.equal(coordinationComplete(record, { env: ON }), true);
});

test("real run, negative: an incompatible consumer fails and blocks completion", async () => {
  // API renamed to /sum, client still calls /add: the compatible-looking
  // revisions (both merged, check "compatible") are not enough.
  const record = landed(sha.apiSum, sha.clientAdd, true);
  const evidence = await runPair(sha.apiSum, sha.clientAdd, record, "bad");
  assert.equal(evidence.result, "failed");
  assert.match(evidence.source ?? "", /exit [1-9]/);
  record.integrationCheck!.evidence.push(evidence);
  assert.equal(integrationGate(record, { env: ON })?.state, "failed");
  assert.equal(coordinationComplete(record, { env: ON }), false);
});

test("real run, sensitivity control: the original /add pair passes its own contract", async () => {
  const record = landed(sha.apiAdd, sha.clientAdd, true);
  record.integrationCheck!.command = `node ${VERIFY} {producer} {consumer} /add`;
  const evidence = await runPair(sha.apiAdd, sha.clientAdd, record, "orig");
  assert.equal(evidence.result, "passed", evidence.source);
});

test("static compatibility never satisfies the executed check", () => {
  const record = landed(sha.apiSum, sha.clientSum, true);
  assert.equal(record.client.clientCheck, "compatible");
  record.integrationCheck!.evidence.push({
    class: "static",
    producer: { repo: API_REPO, sha: sha.apiSum },
    consumer: { repo: CLIENT_REPO, sha: sha.clientSum },
    command: "scan",
    result: "passed",
    at: "2026-10-04T00:00:01.000Z",
  });
  const gate = integrationGate(record, { env: ON })!;
  assert.equal(gate.state, "missing");
  assert.equal(gate.ignored.length, 1);
  assert.equal(coordinationComplete(record, { env: ON }), false);
});

test("an upstream move makes passed evidence stale, and names the side that moved", async () => {
  const record = landed(sha.apiSum, sha.clientSum, true);
  record.integrationCheck!.evidence.push(await runPair(sha.apiSum, sha.clientSum, record, "stale"));
  assert.equal(coordinationComplete(record, { env: ON }), true);
  const moved = { producer: { repo: API_REPO, sha: "f".repeat(40) }, consumer: currentPairRevisions(record).consumer };
  const gate = integrationGate(record, { env: ON, current: moved })!;
  assert.equal(gate.state, "stale");
  assert.match(gate.reason, /producer/);
  assert.equal(coordinationComplete(record, { env: ON, current: moved }), false);
  // The record itself moving (API re-merged) is equally stale.
  const remerged = { ...record, api: { ...record.api, anchorSha: "e".repeat(40) } };
  assert.equal(integrationGate(remerged, { env: ON })?.state, "stale");
});

test("a tree at the wrong revision, or dirty, records not-run and never executes the command", async () => {
  const marker = join(work, "ran-marker");
  const record = landed(sha.apiSum, sha.clientSum, true);
  record.integrationCheck!.command = `touch ${marker}`;
  const wrong = await runPair(sha.apiAdd, sha.clientSum, record, "wrong");
  assert.equal(wrong.result, "not-run");
  assert.match(wrong.source ?? "", /producer tree is at/);
  const producerDir = checkout("dirty-p", origins.api!, sha.apiSum);
  const consumerDir = checkout("dirty-c", origins.client!, sha.clientSum);
  await writeFile(join(consumerDir, "client.mjs"), "// local edit\n");
  const dirty = await runIntegrationCheck({ executor: new LocalExecutor({ root: work }), record, trees: { producerDir, consumerDir } });
  assert.equal(dirty.result, "not-run");
  assert.match(dirty.source ?? "", /uncommitted/);
  assert.equal(existsSync(marker), false, "nothing ran");
  record.integrationCheck!.evidence.push(dirty);
  assert.equal(integrationGate(record, { env: ON })?.state, "unresolved");
  assert.equal(coordinationComplete(record, { env: ON }), false);
});

test("a timeout is unknown, not failed and not passed", async () => {
  const record = landed(sha.apiSum, sha.clientSum, true);
  record.integrationCheck!.command = "sleep 5";
  const producerDir = checkout("to-p", origins.api!, sha.apiSum);
  const consumerDir = checkout("to-c", origins.client!, sha.clientSum);
  const evidence = await runIntegrationCheck({ executor: new LocalExecutor({ root: work }), record, trees: { producerDir, consumerDir }, timeoutMs: 200 });
  assert.equal(evidence.result, "unknown");
});

test("default off: not declared, or flag off, leaves completion exactly as before", async () => {
  const undeclared = landed(sha.apiSum, sha.clientSum, false);
  assert.equal(integrationGate(undeclared, { env: ON }), null);
  assert.equal(coordinationComplete(undeclared, { env: ON }), true, "flag on but not declared: unchanged");
  const declared = landed(sha.apiSum, sha.clientSum, true);
  assert.equal(coordinationComplete(declared, { env: {} }), true, "declared but flag off: unchanged");
  assert.equal(coordinationComplete(declared, { env: { SHIP_INTEGRATION_CHECK: "off" } }), true);
  assert.equal(integrationCheckEnabled({}), false);
  assert.equal(integrationCheckEnabled(ON), true);
});

test("createCoordination: no declaration leaves the stored record without the field; a declaration is stored", async () => {
  const { runtime, config } = memoryRuntime();
  const base = { parentIntent: "x", apiRepo: API_REPO, clientRepo: CLIENT_REPO, model: "m" };
  const plain = await createCoordination(runtime, base);
  assert.equal("integrationCheck" in JSON.parse(config.get(coordinationKey(plain.id))!), false);
  const declared = await createCoordination(runtime, { ...base, integrationCheckCommand: "  npm run pair  " });
  assert.deepEqual((await loadCoordination(runtime, declared.id))!.integrationCheck, { command: "npm run pair", evidence: [] });
});

test("runCoordinationIntegrationCheck: refuses when off, records evidence on the record when on", async () => {
  const { runtime, config } = memoryRuntime();
  const record = landed(sha.apiSum, sha.clientSum, true);
  config.set(coordinationKey(record.id), JSON.stringify(record));
  const trees = { producerDir: checkout("rec-p", origins.api!, sha.apiSum), consumerDir: checkout("rec-c", origins.client!, sha.clientSum) };
  const executor = new LocalExecutor({ root: work });
  await assert.rejects(runCoordinationIntegrationCheck(runtime, record.id, { executor, trees, env: {} }), /off/);
  assert.equal(JSON.parse(config.get(coordinationKey(record.id))!).integrationCheck.evidence.length, 0);
  const out = await runCoordinationIntegrationCheck(runtime, record.id, { executor, trees, env: ON });
  assert.equal(out.evidence.result, "passed");
  const stored = (await loadCoordination(runtime, record.id))!;
  assert.equal(stored.integrationCheck!.evidence.length, 1);
  assert.equal(coordinationComplete(stored, { env: ON }), true);
});
