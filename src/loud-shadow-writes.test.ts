import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, test } from "node:test";

import type { EventStore } from "@neutron-build/workflow";

import { createBudgetGate } from "./budget-gate.js";
import { fileReservationLedger } from "./budget-reservation.js";
import { DEFAULT_AUTHORITY, mayDo } from "./governance.js";
import type { Governance } from "./governance.js";
import { defaultProbes, runDoctor } from "./install-doctor.js";
import { KnowledgeProvenance } from "./knowledge-provenance.js";
import { FileKnowledgeStore } from "./knowledge-store.js";
import { fileSink as placementFileSink, readPlacementSummary, renderPlacementReport } from "./placement-shadow.js";
import type { PlacementRecord } from "./placement-shadow.js";
import { flushShadow, installPolicyShadow, installPolicyShadowFromEnv, fileSink as policyFileSink, readShadowSummary, renderShadowReport } from "./policy-shadow.js";
import type { ShadowRecord } from "./policy-shadow.js";
import { checkRecordDirsAtStartup, recordDirs, resetRecordDirCheck } from "./record-dirs.js";
import { appendRecordLine, resetWriteFailures, writeFailures } from "./record-writes.js";
import { FileRepoMemory } from "./repo-memory.js";
import { ScopedRepoMemory } from "./scoped-repo-memory.js";
import { setShadowObserver } from "./shadow-hook.js";
import { observeToolCall, resetToolManifestShadow } from "./tool-manifest-shadow.js";

/**
 * 2026-10-16: the production data volume was root:root 755 while Ship ran as
 * uid 1000, and every file-backed shadow wrote nothing for 12 days without a
 * single log line. These tests use a REAL read-only directory (chmod 555), so
 * they prove what the kernel refuses, not what a fake throws.
 */

const IS_ROOT = process.getuid?.() === 0;
const SKIP = IS_ROOT ? "running as root: chmod 555 does not stop root writing, so the read-only directory cannot be simulated" : false;

// Wrapped in describe(): the suite runs with --experimental-test-isolation=none, so top-level hooks would fire around every other file's tests too.
describe("loud shadow writes (2026-10-16 root-owned volume)", () => {
let base = "";
let ro = "";
let rw = "";
const logs: string[] = [];
const log = (line: string) => void logs.push(line);
const warnings = () => logs.filter((l) => l.includes("WARNING"));
// The suite shares one process with other files, which can note failures of their own: look only at ours.
const mine = () => writeFailures().filter((f) => f.path.startsWith(base));
const savedState = process.env.TEPLOY_SHIP_STATE;
function restoreState(): void {
  if (savedState === undefined) delete process.env.TEPLOY_SHIP_STATE;
  else process.env.TEPLOY_SHIP_STATE = savedState;
}

before(async () => {
  base = await mkdtemp(join(tmpdir(), "loud-shadow-"));
  ro = join(base, "ro");
  rw = join(base, "rw");
  await mkdir(ro);
  await mkdir(rw);
  await chmod(ro, 0o555);
});

after(async () => {
  await chmod(ro, 0o755).catch(() => {});
  await rm(base, { recursive: true, force: true });
});

afterEach(() => {
  restoreState();
  logs.length = 0;
  resetWriteFailures();
  resetRecordDirCheck();
  installPolicyShadow(null);
  setShadowObserver(null);
});

// ── the shared writer ─────────────────────────────────────────────────────

test("a failed record write warns ONCE per file, counts every failure, never throws", { skip: SKIP }, async () => {
  const file = join(ro, "x.jsonl");
  assert.equal(await appendRecordLine("test shadow", file, "{}", log), false);
  assert.equal(await appendRecordLine("test shadow", file, "{}", log), false);
  assert.equal(await appendRecordLine("test shadow", file, "{}", log), false);
  assert.equal(warnings().length, 1, "one warning, not one per write");
  const w = warnings()[0]!;
  assert.match(w, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(w, /EACCES/);
  assert.match(w, new RegExp(`uid ${process.getuid?.()}`));
  assert.match(w, /chown 1000:1000/);
  const f = mine();
  assert.equal(f.length, 1);
  assert.equal(f[0]!.count, 3);
  assert.equal(f[0]!.code, "EACCES");
  // A second file gets its own single warning.
  await appendRecordLine("test shadow", join(ro, "y.jsonl"), "{}", log);
  assert.equal(warnings().length, 2);
});

test("negative control: a writable dir writes, warns nothing, counts nothing", async () => {
  assert.equal(await appendRecordLine("test shadow", join(rw, "nested", "ok.jsonl"), "{}", log), true);
  assert.equal(logs.length, 0);
  assert.deepEqual(mine(), []);
});

// ── each writer ───────────────────────────────────────────────────────────

const disagreement: ShadowRecord = { v: 1, at: "2026-10-16T00:00:00Z", type: "error", point: "mayDo", dimension: "-", subject: "s", existing: "-", policy: "-", layers: [] };

test("policy shadow: the file sink never rejects on a read-only dir, and the failure is counted", { skip: SKIP }, async () => {
  const sink = policyFileSink(join(ro, "policy-shadow.jsonl"));
  await sink.append(disagreement);
  await sink.append(disagreement);
  const f = mine();
  assert.equal(f.length, 1);
  assert.equal(f[0]!.label, "policy shadow");
  assert.equal(f[0]!.count, 2);
});

test("policy shadow installed on a read-only path: the decision it watches is unchanged", { skip: SKIP }, async () => {
  const governance: Governance = { authority: DEFAULT_AUTHORITY, windows: {}, reviewers: [] };
  const layers = join(rw, "layers.json");
  await writeFile(layers, JSON.stringify({ layers: [{ kind: "org", id: "acme", limits: { actions: { approve: { roles: ["admin"], users: [] } } } }] }));
  const without = mayDo(governance, "approve", { user: "ed", role: "editor" });
  assert.equal(installPolicyShadowFromEnv({ SHIP_POLICY_SHADOW: "on", SHIP_POLICY_SHADOW_FILE: join(ro, "p.jsonl"), SHIP_POLICY_LAYERS_FILE: layers } as NodeJS.ProcessEnv), true);
  const withShadow = mayDo(governance, "approve", { user: "ed", role: "editor" });
  await flushShadow();
  assert.equal(withShadow, without, "the shadow must not change the outcome");
  assert.equal(mine().length, 1, "the disagreement write failed and was counted");
});

const placementRecord: PlacementRecord = { v: 1, at: "2026-10-16T00:00:00Z", point: "create", disagreement: null, requirement: {} as PlacementRecord["requirement"], defaulted: [], host: "h", state: {} };

test("placement shadow: the file sink never rejects on a read-only dir", { skip: SKIP }, async () => {
  const sink = placementFileSink(join(ro, "placement-shadow.jsonl"));
  await sink.append(placementRecord);
  await sink.append(placementRecord);
  assert.equal(mine()[0]!.label, "placement shadow");
  assert.equal(mine()[0]!.count, 2);
});

test("tool-manifest shadow: an unwritable record file is counted, the call resolves", { skip: SKIP }, async () => {
  resetToolManifestShadow();
  await writeFile(join(rw, "bad-manifest.json"), "{ not json");
  await observeToolCall({ kind: "bash", code: "x" }, { SHIP_TOOL_MANIFEST: "shadow", SHIP_TOOL_MANIFEST_FILE: join(rw, "bad-manifest.json"), SHIP_TOOL_MANIFEST_SHADOW_FILE: join(ro, "tm.jsonl") } as NodeJS.ProcessEnv);
  assert.equal(mine()[0]!.label, "tool-manifest shadow");
});

test("budget ledger on a read-only dir: admission unchanged, ONE loud warning, every failure counted", { skip: SKIP }, async () => {
  const path = join(ro, "budget-ledger.json");
  const gate = createBudgetGate({ mode: "shadow", ledger: fileReservationLedger(path), log, ledgerPath: path });
  const args = { source: "forgejo", day: "2026-10-16", budgetUSD: 10, estimateUSD: 0.5, existingAllowed: true, existingCommittedUSD: 0.5 };
  assert.deepEqual(await gate.admit({ ...args, runId: "r1" }), { allow: true });
  assert.deepEqual(await gate.admit({ ...args, runId: "r2" }), { allow: true });
  assert.equal(warnings().length, 1);
  assert.match(warnings()[0]!, /budget reservation ledger/);
  assert.equal(mine()[0]!.count, 2);
  // The existing per-run lines still say what was decided.
  assert.equal(logs.filter((l) => /no ledger verdict/.test(l)).length, 2);
});

test("knowledge provenance on a read-only store: the note still records, the failure is counted", { skip: SKIP }, async () => {
  const memory = new ScopedRepoMemory(
    new FileRepoMemory(join(rw, "repo-memory")),
    {} as EventStore,
    new KnowledgeProvenance({ mode: "shadow", store: new FileKnowledgeStore(join(ro, "knowledge-records")) }),
  );
  const note = await memory.record({ repo: "https://example.test/o/r", note: "n" });
  assert.equal(note.note, "n");
  assert.equal(mine()[0]!.label, "knowledge provenance");
});

// ── startup ───────────────────────────────────────────────────────────────

test("startup: a read-only data dir logs ONE error naming the chown fix, and does not throw", { skip: SKIP }, async () => {
  process.env.TEPLOY_SHIP_STATE = ro;
  const probes = await checkRecordDirsAtStartup({ SHIP_POLICY_SHADOW: "on" } as NodeJS.ProcessEnv, log);
  assert.equal(probes[0]!.status, "not-writable");
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /ERROR: data dir .* is not writable/);
  assert.match(logs[0]!, /chown 1000:1000/);
  await checkRecordDirsAtStartup({} as NodeJS.ProcessEnv, log);
  assert.equal(logs.length, 1, "once per process");
  assert.deepEqual(await readdir(ro), []);
});

test("startup negative control: a writable data dir logs nothing and leaves no probe file", async () => {
  process.env.TEPLOY_SHIP_STATE = rw;
  const probes = await checkRecordDirsAtStartup({} as NodeJS.ProcessEnv, log);
  assert.equal(probes[0]!.status, "writable");
  assert.equal(logs.length, 0);
  assert.ok(!(await readdir(rw)).some((f) => f.startsWith(".ship-write-probe")));
});

test("record dirs: the data dir always, an enabled shadow's override dir too, a disabled one not", () => {
  process.env.TEPLOY_SHIP_STATE = rw;
  assert.deepEqual(recordDirs({} as NodeJS.ProcessEnv), [rw]);
  assert.deepEqual(recordDirs({ SHIP_POLICY_SHADOW: "on", SHIP_POLICY_SHADOW_FILE: "/elsewhere/p.jsonl" } as NodeJS.ProcessEnv), [rw, "/elsewhere"]);
  assert.deepEqual(recordDirs({ SHIP_POLICY_SHADOW: "off", SHIP_POLICY_SHADOW_FILE: "/elsewhere/p.jsonl" } as NodeJS.ProcessEnv), [rw]);
});

// ── doctor ────────────────────────────────────────────────────────────────

const byId = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) => r.checks.find((c) => c.id === id)!;

test("doctor: a read-only data dir fails data-dir-writable with the chown remedy", { skip: SKIP }, async () => {
  const r = await runDoctor(defaultProbes({ env: {}, stateDir: ro, recordDirs: [ro], webPort: 0, nodeVersion: process.version }));
  const c = byId(r, "data-dir-writable");
  assert.equal(c.status, "fail");
  assert.match(c.remedy ?? "", /chown 1000:1000/);
  assert.equal(byId(r, "state-dir-writable").status, "fail");
  assert.equal(r.verdict, "not-ready");
});

test("doctor: one unwritable record dir among writable ones still fails", { skip: SKIP }, async () => {
  const r = await runDoctor(defaultProbes({ env: {}, stateDir: rw, recordDirs: [rw, ro], webPort: 0, nodeVersion: process.version }));
  assert.equal(byId(r, "state-dir-writable").status, "pass");
  assert.equal(byId(r, "data-dir-writable").status, "fail");
});

test("doctor negative controls: writable passes; no write probe is unknown, never pass", async () => {
  const ok = await runDoctor(defaultProbes({ env: {}, stateDir: rw, recordDirs: [rw], webPort: 0, nodeVersion: process.version }));
  assert.equal(byId(ok, "data-dir-writable").status, "pass");
  const none = await runDoctor({ nodeVersion: process.version, env: {}, stateDir: rw, webPort: 0, nowMs: Date.now() });
  assert.equal(byId(none, "data-dir-writable").status, "unknown");
  assert.ok(byId(none, "data-dir-writable").remedy);
});

// ── reports ───────────────────────────────────────────────────────────────

test("policy shadow-report: missing file in an unwritable dir says permission, not 'has not recorded anything'", { skip: SKIP }, async () => {
  const file = join(ro, "policy-shadow.jsonl");
  const out = renderShadowReport(await readShadowSummary(file), file);
  assert.match(out, /could not write here \(permission\)/);
  assert.match(out, /chown 1000:1000/);
  assert.doesNotMatch(out, /has not recorded anything/);
});

test("placement shadow-report: same permission wording", { skip: SKIP }, async () => {
  const file = join(ro, "placement-shadow.jsonl");
  const out = renderPlacementReport(await readPlacementSummary(file), file);
  assert.match(out, /could not write here \(permission\)/);
  assert.doesNotMatch(out, /has not recorded anything/);
});

test("report negative control: a missing file in a writable dir keeps the original wording", async () => {
  const pf = join(rw, "absent-policy.jsonl");
  const policy = renderShadowReport(await readShadowSummary(pf), pf);
  assert.match(policy, /has not recorded anything/);
  assert.doesNotMatch(policy, /permission/);
  const lf = join(rw, "absent-placement.jsonl");
  const placement = renderPlacementReport(await readPlacementSummary(lf), lf);
  assert.match(placement, /has not recorded anything/);
  assert.doesNotMatch(placement, /permission/);
});
});
