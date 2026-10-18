import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import { MemoryEventStore, executeRun } from "@neutron-build/workflow";
import type { WorkflowEvent } from "@neutron-build/workflow";

import { durableAgent } from "./durable.js";
import type { ExecutorProvider } from "./durable.js";
import { HARNESS_VERSIONS } from "./harness.js";
import { acpAdapters, acpEnqueueRefusal, acpLiveTracker, acpProviderEgressAllow, assertAcpHarnessAdmitted, isAcpHarness, parseAcpStream, withAcpProviderEgress } from "./harness-acp.js";
import type { AcpHarnessRunRecord } from "./harness-acp.js";
import { DEFAULT_FORWARDED_ENV } from "./harness-external.js";
import { shq } from "./harness-external.js";
import { enqueueRun } from "./runtime.js";
import type { ShipRuntime } from "./runtime.js";
import { admittedSteps, fingerprintOf, stepFingerprint } from "./step-fingerprint.js";
import { WORKFLOW_STEPS } from "./step-fingerprint.js";

/**
 * E7 H3 — the generic ACP harness. The driver (images/acp-driver/ship-acp.mjs)
 * and the mock peer (src/fixtures/acp-mock-peer.mjs) are exercised FOR REAL
 * here: the adapter builds the same spec file and command it builds in the
 * sandbox, the LocalExecutor stands in for the sandbox, and the peer is the
 * ACP agent. What is faked is the vendor binary, exactly like the
 * harness-external tests' fake `claude`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PEER = join(HERE, "..", "src", "fixtures", "acp-mock-peer.mjs");
const DRIVER = join(HERE, "..", "images", "acp-driver", "ship-acp.mjs");

const neverModel: ModelAdapter = {
  provider: "never",
  modelId: "never",
  async doGenerate() {
    throw new Error("an external harness run must never call Ship's model");
  },
  async *doStream() {
    throw new Error("unused");
  },
};

const FAKE_KEY = "gemini-fake-key-0123456789";

/** The worker-side env a deployment would carry for a gemini run. */
const workerEnv = (): NodeJS.ProcessEnv => ({
  GEMINI_API_KEY: FAKE_KEY,
  // The adapter runs the repo's driver instead of the image's copy.
  SHIP_ACP_DRIVER: `node ${shq(DRIVER)}`,
});

/**
 * A workspace whose PATH carries a `gemini` that is really the mock peer.
 * ACP_MOCK_* knobs ride the executor env the way the sandbox's env would;
 * the peer's transcript lands in its own recording dir, one per rig.
 */
async function acpRig(opts: { mockEnv?: Record<string, string> } = {}): Promise<{
  provider: ExecutorProvider;
  work: string;
  log: string;
}> {
  const bin = await mkdtemp(join(tmpdir(), "acp-bin-"));
  // Canonical from the start: the driver resolves the workspace through
  // realpath (the containment rule), and on macOS /tmp is /private/tmp —
  // every assertion below should see the same path the agent saw.
  const work = await realpath(await mkdtemp(join(tmpdir(), "acp-work-")));
  const rec = await mkdtemp(join(tmpdir(), "acp-rec-"));
  const log = join(rec, "peer.jsonl");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "gemini"), `#!/bin/sh\nexec node ${shq(PEER)} "$@"\n`);
  await chmod(join(bin, "gemini"), 0o755);
  const executor = new LocalExecutor({
    root: work,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      ACP_MOCK_LOG: log,
      ...(opts.mockEnv ?? {}),
    },
  });
  return { provider: { isolated: true, async create() { return { handle: work }; }, attach: () => executor }, work, log };
}

const stepsOf = (events: readonly WorkflowEvent[]): string[] => events.filter((e) => e.type === "step-completed").map((e) => e.name as string);
const stepResult = <T>(events: readonly WorkflowEvent[], name: string): T =>
  (events.find((e) => e.type === "step-completed" && e.name === name)?.data as { result: T }).result;

async function driveGemini(
  rig: Awaited<ReturnType<typeof acpRig>>,
  env: NodeJS.ProcessEnv = workerEnv(),
): Promise<{ events: WorkflowEvent[]; record: AcpHarnessRunRecord }> {
  const wf = durableAgent({ model: neverModel, executor: rig.provider, workdir: ".", harnesses: acpAdapters({ env }), maxSteps: 7 });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-acp",
    store,
    input: { task: "Write the notes file", harness: { id: "gemini", version: HARNESS_VERSIONS.gemini! } },
  });
  assert.equal(outcome.status, "completed", JSON.stringify(outcome));
  const events = await store.load("run-acp");
  return { events, record: stepResult<AcpHarnessRunRecord>(events, "harness-run") };
}

// ---------------------------------------------------------------------------
// The driver's policy, as a unit
// ---------------------------------------------------------------------------

test("the driver's containment policy admits the workspace and nothing else", async () => {
  const driver = await import(DRIVER);
  const work = await mkdtemp(join(tmpdir(), "acp-policy-"));
  const root = driver.acpCanonicalPathForContainment(work);
  assert.ok(root !== undefined, "the workspace itself canonicalises");
  const p = (path: string) => ({ locations: [{ path }] });
  const decide = (kind: string, locations: unknown[]) => driver.acpPermissionDecision({ workspaceRoot: root, cwd: work, kind, locations });

  // Reads: inside allowed (also a file that does not exist yet), outside denied.
  assert.equal(decide("read", [{ path: join(work, "src", "a.ts") }]).decision, "allow");
  assert.equal(decide("read", [{ path: "/etc/hosts" }]).decision, "deny");
  assert.equal(decide("read", [{ path: join(work, "does", "not", "exist.txt") }]).decision, "allow");
  assert.equal(decide("read", []).decision, "allow", "a read naming nothing targets nothing");

  // Writes: inside allowed, everything else denied.
  assert.equal(decide("edit", [{ path: join(work, "notes.md") }]).decision, "allow");
  assert.equal(decide("edit", [{ path: "/etc/ship-acp-must-not-exist" }]).decision, "deny");
  assert.equal(decide("edit", [{ path: join(work, "..", "escape") }]).decision, "deny");
  assert.equal(decide("delete", []).decision, "deny", "a mutation with no locations is denied");

  // A symlink inside the workspace pointing outside must not smuggle a write:
  // lexical normalisation would turn link/../../x into an in-workspace path.
  await symlink("/", join(work, "link"));
  assert.equal(decide("edit", [{ path: join(work, "link", "..", "..", "pwned") }]).decision, "deny");
  assert.equal(decide("read", [{ path: join(work, "link", "etc", "passwd") }]).decision, "deny");
  // A broken symlink fails closed: lstat sees it, realpath cannot resolve it.
  await symlink(join(work, "nope-target"), join(work, "broken"));
  assert.equal(decide("edit", [{ path: join(work, "broken", "file") }]).decision, "deny");
  // A relative location resolves against the cwd like the agent means it.
  assert.equal(decide("edit", [{ path: "notes.md" }]).decision, "allow");
  assert.equal(decide("edit", [{ path: "../notes.md" }]).decision, "deny");

  // Kinds: the sandbox boundary and the egress allowlist decide elsewhere.
  assert.equal(decide("execute", []).decision, "allow");
  assert.equal(decide("fetch", [{ path: "https://example.test" }]).decision, "allow");
  assert.equal(decide("teleport", [{ path: join(work, "x") }]).decision, "deny", "unknown kinds are denied, even on safe paths");
  assert.equal(decide("", [{ path: join(work, "x") }]).decision, "deny", "an absent kind is denied");

  // The option selection never answers allow_always.
  const options = [
    { optionId: "allow", kind: "allow_once" },
    { optionId: "always", kind: "allow_always" },
    { optionId: "reject", kind: "reject_once" },
  ];
  assert.equal(driver.acpPermissionOptionId(options, "allow"), "allow");
  assert.equal(driver.acpPermissionOptionId(options, "deny"), "reject");
  assert.equal(
    driver.acpPermissionOptionId([{ optionId: "always", kind: "allow_always" }, { optionId: "reject", kind: "reject_once" }], "allow"),
    undefined,
    "an allow that only exists as allow_always is not selected",
  );
});

// ---------------------------------------------------------------------------
// The declared journey
// ---------------------------------------------------------------------------

test("gemini adapter: the declared journey on the mock peer — session, allowed write, diff, capability record, unpriced usage", async () => {
  const rig = await acpRig();
  const { events, record } = await driveGemini(rig);
  assert.deepEqual(stepsOf(events), ["sandbox", "harness-preflight", "harness-run"], "no steer flag: the two-step external sequence");
  assert.equal(record.status, "finished");
  assert.equal(record.summary, "Wrote notes.md.");
  assert.equal(record.exitCode, 0);
  assert.equal(record.sessionId, "mock-session-1");
  assert.deepEqual(record.forwarded, ["GEMINI_API_KEY"], "names only, never values");
  assert.equal(record.turns, 2, "one read tool + one write tool");
  assert.equal(record.usage.priced, false, "no ACP agent reports dollars; counted, not priced");
  assert.equal(record.usage.inputTokens, 10);
  assert.equal(record.usage.totalTokens, 12);
  assert.deepEqual(record.fileChanges, [`edit ${join(rig.work, "notes.md")}`]);
  assert.equal(record.permissions?.allowed, 1);
  assert.equal(record.permissions?.denied, 0);
  // The capability record: what the agent negotiated, durable in the log.
  assert.deepEqual(record.capabilities, {
    offered: 1,
    protocolVersion: 1,
    agentInfo: { name: "mock-acp-peer", version: "0.64.0 (mock acp peer)" },
    loadSession: true,
    sessionCapabilities: null,
    authMethodIds: ["mock-api-key"],
  });
  // The diff is the deliverable: the agent's permitted write is in the tree.
  assert.equal(await readFile(join(rig.work, "notes.md"), "utf8"), "written by the mock agent\n");
  // The peer saw the exact ACP session the record names.
  const log = (await readFile(rig.log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.ok(log.some((e) => e.event === "session-new" && e.cwd === join(rig.work)), "session/new was sent with the workspace as cwd");
  assert.ok(log.some((e) => e.event === "permission" && e.optionId === "allow"), "the in-workspace write was answered allow_once");
  assert.match(JSON.stringify(log.find((e) => e.event === "prompt")), /Write the notes file/, "the prompt reached the agent");
});

// ---------------------------------------------------------------------------
// The negative controls
// ---------------------------------------------------------------------------

test("negative control: every outside-workspace write is denied and nothing outside changed", async () => {
  const rig = await acpRig({ mockEnv: { ACP_MOCK_JOURNEY: "matrix" } });
  const { record } = await driveGemini(rig);
  assert.equal(record.status, "finished");
  assert.equal(record.permissions?.allowed, 1, "exactly the in-workspace write");
  assert.equal(record.permissions?.denied, 6, "etc, dotdot, symlink, broken symlink, no-locations, unknown kind");
  const denials = record.permissions?.denials ?? [];
  assert.ok(denials.some((d) => d.startsWith("edit /etc/ship-acp-must-not-exist:") && /outside the workspace/.test(d)), denials.join("; "));
  assert.ok(denials.some((d) => /outside-dotdot:/.test(d) && /outside the workspace/.test(d)), denials.join("; "));
  assert.ok(denials.some((d) => /outside-symlink:/.test(d) && /outside the workspace/.test(d)), "the symlink pointing at / did not smuggle a write");
  assert.ok(denials.some((d) => /broken-link\//.test(d) && /does not canonicalize/.test(d)), denials.join("; "));
  assert.ok(denials.some((d) => /no locations is denied/.test(d)), denials.join("; "));
  assert.ok(denials.some((d) => /teleport/.test(d) && /unknown or ungated tool kind/.test(d)), denials.join("; "));
  // The peer's own transcript: every denial was answered reject_once.
  const log = (await readFile(rig.log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const answered = log.filter((e) => e.event === "permission");
  assert.equal(answered.filter((e) => e.optionId === "reject").length, 6);
  assert.equal(answered.filter((e) => e.optionId === "allow").length, 1);
  // Nothing outside the workspace exists: /etc untouched, no sibling escapes.
  assert.equal(await readFile("/etc/ship-acp-must-not-exist", "utf8").catch(() => "absent"), "absent");
  assert.equal(await readFile(join(rig.work, "..", "outside-dotdot"), "utf8").catch(() => "absent"), "absent");
  assert.equal(await readFile("/outside-symlink", "utf8").catch(() => "absent"), "absent");
  // The one allowed write went to the (fresh, not-yet-existing) nested path.
  assert.equal(await readFile(join(rig.work, "made", "up", "dir", "inside.txt"), "utf8"), "written by the mock agent\n");
});

test("negative control: allow-always is never granted — an allow that only exists as allow_always is denied", async () => {
  const rig = await acpRig({ mockEnv: { ACP_MOCK_ALLOW_ALWAYS_ONLY: "1" } });
  const { record } = await driveGemini(rig);
  assert.equal(record.status, "finished");
  assert.equal(record.permissions?.denied, 1);
  assert.equal(record.permissions?.allowed, 0);
  assert.match(record.permissions?.denials[0] ?? "", /no allow-once option/);
  const log = (await readFile(rig.log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.equal(log.filter((e) => e.event === "permission").every((e) => e.optionId === "reject"), true, "never allow_always, never allow");
  assert.equal(await readFile(join(rig.work, "notes.md"), "utf8").catch(() => "absent"), "absent", "nothing was written");
});

test("negative control (H1): the token is absent from argv, the recorded events and the live feed", async () => {  const rig = await acpRig({ mockEnv: { ACP_MOCK_ECHO: "1" } });
  // A streamed exec over the same executor (the daemon's shape), with the
  // live store capturing every update the run page would see.
  const phases: Array<{ phase: string; turn?: number; detail?: string }> = [];
  const live = { set: async (_runId: string, u: { phase: string; turn?: number; detail?: string }) => { phases.push(u); } };
  const streaming: ExecutorProvider = {
    ...rig.provider,
    async execStream(handle, command, options, onChunk) {
      const result = await rig.provider.attach(handle).exec(command, options);
      for (let i = 0; i < result.stdout.length; i += 37) {
        onChunk("stdout", result.stdout.slice(i, i + 37));
      }
      return result;
    },
  };
  const wf = durableAgent({ model: neverModel, executor: streaming, workdir: ".", harnesses: acpAdapters({ env: workerEnv() }), maxSteps: 7, live });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-acp-echo",
    store,
    input: { task: "Write the notes file", harness: { id: "gemini", version: HARNESS_VERSIONS.gemini! } },
  });
  assert.equal(outcome.status, "completed");
  const events = await store.load("run-acp-echo");
  const record = stepResult<AcpHarnessRunRecord>(events, "harness-run");
  const base64 = Buffer.from(FAKE_KEY, "utf8").toString("base64");
  const whole = JSON.stringify(events);
  assert.ok(!whole.includes(FAKE_KEY), "the token appears nowhere in the event log");
  assert.ok(!whole.includes(base64), "nor its base64 form");
  assert.ok(!record.summary.includes(FAKE_KEY), "the summary was scrubbed");
  assert.ok(!record.stderrTail.includes(FAKE_KEY), "stderrTail was scrubbed");
  assert.ok(record.summary.includes("[redacted GEMINI_API_KEY]"), `the echo is visibly redacted: ${record.summary.slice(0, 160)}`);
  assert.ok(!JSON.stringify(phases).includes(FAKE_KEY), "the live feed was scrubbed");
  assert.ok(!JSON.stringify(phases).includes(base64), "the live feed never saw the base64 form either");
  assert.ok(phases.some((p) => p.detail?.includes("[redacted GEMINI_API_KEY]")), "the live feed shows the redacted echo");
  // The exec's own environment carried the key (that is the H1 delivery); no
  // file under the workspace ever did.
  const workspaceFiles: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) workspaceFiles.push(path);
    }
  };
  await walk(rig.work);
  for (const path of workspaceFiles) {
    const text = await readFile(path, "utf8").catch(() => "");
    assert.ok(!text.includes(FAKE_KEY), `${path} must not carry the token`);
  }
});

test("negative control (H1, joined): a credential split across stream boundaries never reaches the record", async () => {
  // The peer leaks the key split across (1) two agent_message_chunk events
  // of one message — chunks neither side can recognise, rejoined by
  // parseAcpStream into the summary, (2) a non-JSON stdout line whose secret
  // straddles the driver's 500-char relay cap, and (3) two stderr stream
  // chunks split mid-value. Per-chunk and per-line redaction see only
  // halves; the joins and the caps are where the whole value reappears.
  const rig = await acpRig({ mockEnv: { ACP_MOCK_SPLIT_LEAK: "1" } });
  const { events, record } = await driveGemini(rig);
  assert.equal(record.status, "finished");
  const whole = JSON.stringify(events);
  assert.ok(!whole.includes(FAKE_KEY), "the token appears nowhere in the event log, in any split form rejoined");
  // 1. The joined summary: the value exists whole only after the parser
  // reassembles the chunks, so this is the scrub that must catch it.
  assert.ok(!record.summary.includes(FAKE_KEY), "the joined summary was scrubbed after the join");
  assert.ok(record.summary.includes("[redacted GEMINI_API_KEY]"), `the joined echo is visibly redacted: ${record.summary.slice(0, 160)}`);
  // 2. The relay cap: redaction runs BEFORE truncation, so a secret
  // straddling the cap leaves as a [redacted …] marker, never as a half.
  assert.ok(!record.stderrTail.includes(FAKE_KEY.slice(0, 20)), `no leading half survives the 500-char relay cap: ${record.stderrTail.slice(0, 200)}`);
  assert.ok(record.stderrTail.includes("[redacted GEMINI"), "the capped relay shows the redaction marker");
  // 3. The stderr stream: the driver's carry scrubber joins the chunks
  // before relaying, so the split halves never leave the sandbox either.
  assert.ok(!record.stderrTail.includes(FAKE_KEY.slice(0, 12)), `no stderr half-token leaks: ${record.stderrTail.slice(0, 200)}`);
  assert.ok(record.stderrTail.includes("[redacted GEMINI_API_KEY] tail"), "the split stderr echo is redacted whole");
});

// ---------------------------------------------------------------------------
// The enqueue gate
// ---------------------------------------------------------------------------

function stubRuntime(store: MemoryEventStore): ShipRuntime {
  return {
    kind: "file",
    evidence: { forRepo: async () => null },
    projects: { list: async () => [], forRepo: async () => null },
    governance: { get: async () => ({ authority: {}, windows: {}, reviewers: [] }) },
    store,
    saveMeta: async () => {},
  } as unknown as ShipRuntime;
}

test("negative control: an ACP harness without the flag or the credential is refused at enqueue, with no ghost run", async () => {
  // Flag off: the id does not exist for this deployment.
  assert.match(acpEnqueueRefusal("gemini", { SHIP_ACP_HARNESS: "" })!, /SHIP_ACP_HARNESS off/);
  // Flag on, no key: refused before anything runs.
  assert.match(acpEnqueueRefusal("gemini", { SHIP_ACP_HARNESS: "on" })!, /no credential/);
  // Flag on, key held: admitted.
  assert.equal(acpEnqueueRefusal("gemini", { SHIP_ACP_HARNESS: "on", GEMINI_API_KEY: FAKE_KEY }), undefined);
  // Non-ACP ids are not this gate's business.
  assert.equal(acpEnqueueRefusal("claude-code", {}), undefined);
  assert.throws(() => assertAcpHarnessAdmitted([{ id: "gemini" }, { id: "native" }], {}), /SHIP_ACP_HARNESS off/);

  // End to end: enqueue itself throws and records nothing.
  const savedHarness = process.env.SHIP_HARNESS;
  const savedFlag = process.env.SHIP_ACP_HARNESS;
  const savedKey = process.env.GEMINI_API_KEY;
  process.env.SHIP_HARNESS = "gemini";
  delete process.env.SHIP_ACP_HARNESS;
  delete process.env.GEMINI_API_KEY;
  const store = new MemoryEventStore();
  try {
    await assert.rejects(
      enqueueRun(stubRuntime(store), { runId: "run-acp-refused", task: "Write the notes file", model: "test", source: "manual", trust: "operator" }),
      /SHIP_ACP_HARNESS/,
    );
    assert.deepEqual(await store.load("run-acp-refused"), [], "no ghost run: nothing was appended");

    process.env.SHIP_ACP_HARNESS = "on";
    await assert.rejects(
      enqueueRun(stubRuntime(store), { runId: "run-acp-nokey", task: "Write the notes file", model: "test", source: "manual", trust: "operator" }),
      /no credential/,
    );
    assert.deepEqual(await store.load("run-acp-nokey"), []);

    process.env.GEMINI_API_KEY = FAKE_KEY;
    await enqueueRun(stubRuntime(store), { runId: "run-acp-admitted", task: "Write the notes file", model: "test", source: "manual", trust: "operator" });
    const events = await store.load("run-acp-admitted");
    const input = (events.find((e) => e.type === "run-started")?.data as { input?: Record<string, unknown> }).input;
    assert.deepEqual(input?.harness, { id: "gemini", version: "1" });
    assert.ok(!JSON.stringify(events).includes(FAKE_KEY), "the credential is never recorded");
  } finally {
    if (savedHarness === undefined) delete process.env.SHIP_HARNESS;
    else process.env.SHIP_HARNESS = savedHarness;
    if (savedFlag === undefined) delete process.env.SHIP_ACP_HARNESS;
    else process.env.SHIP_ACP_HARNESS = savedFlag;
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
  }
});

// ---------------------------------------------------------------------------
// Egress derivation and the replay fence
// ---------------------------------------------------------------------------

test("per-profile egress derivation: hosts only when the key is held, byte-identical otherwise", () => {
  assert.deepEqual(acpProviderEgressAllow([{ id: "gemini" }], { GEMINI_API_KEY: "k" }), ["generativelanguage.googleapis.com:443"]);
  assert.deepEqual(acpProviderEgressAllow([{ id: "gemini" }], {}), []);
  // GOOGLE_API_KEY alone (Vertex) derives nothing: the hosts are
  // region-prefixed and belong on the project record, not guessed here.
  assert.deepEqual(acpProviderEgressAllow([{ id: "gemini" }], { GOOGLE_API_KEY: "k" }), []);
  assert.deepEqual(acpProviderEgressAllow([{ id: "grok" }], { XAI_API_KEY: "k" }), ["api.x.ai:443"]);
  assert.deepEqual(acpProviderEgressAllow([{ id: "qwen" }], { OPENAI_API_KEY: "k" })[0], "dashscope.aliyuncs.com:443");
  // The merge discipline: explicit entries survive, nothing changes without an ACP ref.
  const explicit = ["example.com:443"];
  assert.equal(withAcpProviderEgress(explicit, [{ id: "native" }], { GEMINI_API_KEY: "k" }), explicit);
  assert.deepEqual(withAcpProviderEgress(explicit, [{ id: "gemini" }], { GEMINI_API_KEY: "k" }), ["example.com:443", "generativelanguage.googleapis.com:443"]);
  assert.deepEqual(withAcpProviderEgress(["generativelanguage.googleapis.com"], [{ id: "gemini" }], { GEMINI_API_KEY: "k" }), ["generativelanguage.googleapis.com"]);
});

test("replay fence: the ACP step entries move no existing fingerprint, and an ACP run admits them", async () => {
  const native = stepFingerprint({ task: "t" } as Parameters<typeof stepFingerprint>[0]);
  const claude = stepFingerprint({ task: "t", harness: { id: "claude-code", version: "2" } } as Parameters<typeof stepFingerprint>[0]);
  // Pinned literals, recorded when this lane landed: they are the values the
  // PRE-H3 build computed for the same inputs (the new table entries are
  // gated on the ACP ids, which these inputs do not carry). If a future
  // change moves either, this fails — which is the fence holding.
  const pinned = JSON.parse(await readFile(join(HERE, "..", "src", "fixtures", "acp-fingerprint-pins.json"), "utf8")) as Record<string, string>;
  assert.equal(native, pinned.native);
  assert.equal(claude, pinned["claude-code"]);
  // The ACP entries are admitted by an ACP input alone.
  const gemini = admittedSteps({ task: "t", harness: { id: "gemini", version: "1" } } as Parameters<typeof stepFingerprint>[0]);
  assert.equal(gemini.filter((k) => k === "step:*harness-preflight" || k === "step:*harness-run").length, 4, "the external pair and the ACP pair");
  const claudeSteps = admittedSteps({ task: "t", harness: { id: "claude-code", version: "2" } } as Parameters<typeof stepFingerprint>[0]);
  assert.equal(claudeSteps.filter((k) => k === "step:*harness-preflight" || k === "step:*harness-run").length, 2, "an existing external run admits exactly the old pair");
  // And the equivalence the pins rest on: the table WITHOUT the two ACP
  // entries computes the same fingerprints for non-ACP inputs — the entries
  // are inert to every run that predates them.
  const geminiInput = { task: "t", harness: { id: "gemini", version: "1" } } as unknown as Parameters<typeof stepFingerprint>[0];
  const claudeInput = { task: "t", harness: { id: "claude-code", version: "2" } } as unknown as Parameters<typeof stepFingerprint>[0];
  const preAcp = WORKFLOW_STEPS.filter(
    (step) => !((step.key === "step:*harness-preflight" || step.key === "step:*harness-run") && step.admits(geminiInput) && !step.admits(claudeInput)),
  );
  assert.equal(preAcp.length, WORKFLOW_STEPS.length - 2, "exactly the two ACP entries are new");
  for (const input of [{ task: "t" } as unknown as Parameters<typeof stepFingerprint>[0], claudeInput]) {
    assert.equal(fingerprintOf(preAcp, input), stepFingerprint(input));
  }
});

test("the profile forward lists match DEFAULT_FORWARDED_ENV, and the ids are declared harnesses", async () => {
  const { ACP_PROFILES } = await import("./harness-acp.js");
  for (const [id, profile] of Object.entries(ACP_PROFILES)) {
    assert.ok(isAcpHarness(id));
    assert.deepEqual(profile.envNames, DEFAULT_FORWARDED_ENV[id], `${id}'s profile and forward list agree`);
    assert.ok(HARNESS_VERSIONS[id] === "1", `${id} is on ACP contract 1`);
    assert.ok(Array.isArray(profile.args) && profile.args.length > 0, `${id} launches with its measured ACP args`);
    for (const flag of ["--always-approve", "bypassPermissions"]) {
      assert.ok(!profile.args.some((a) => a.includes(flag)), `${id} must launch in its asking mode, never ${flag}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Parser and live tracker units
// ---------------------------------------------------------------------------

test("parseAcpStream maps stop reasons, usage and stop-less streams", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const ok = [
    line({ type: "capabilities", offered: 1, protocolVersion: 1, agentInfo: { name: "a", version: "1" }, agentCapabilities: { loadSession: true }, authMethods: [{ id: "m1" }] }),
    line({ type: "session", sessionId: "s1" }),
    line({ type: "text", messageId: "m", text: "Wrote it." }),
    line({ type: "tool", toolCallId: "t1", kind: "edit", title: "Write", status: "completed", locations: ["/work/a"] }),
    line({ type: "permission", kind: "edit", locations: ["/work/a"], decision: "allow", reason: "edit inside the workspace (symlink-safe)" }),
    line({ type: "usage", usage: { totalTokens: 12, inputTokens: 10, outputTokens: 2, cachedReadTokens: 1, thoughtTokens: 1 } }),
    line({ type: "stop", reason: "end_turn", by: "agent" }),
  ].join("\n");
  const parsed = parseAcpStream(ok);
  assert.equal(parsed.status, "finished");
  assert.equal(parsed.summary, "Wrote it.");
  assert.equal(parsed.turns, 1);
  assert.equal(parsed.usage.totalTokens, 12);
  assert.equal(parsed.usage.outputTokens, 3, "thought tokens count as output");
  assert.equal(parsed.usage.cacheReadTokens, 1);
  assert.equal(parsed.usage.priced, false);
  assert.deepEqual(parsed.fileChanges, ["edit /work/a"]);
  assert.equal(parsed.permissions?.allowed, 1);
  assert.equal(parseAcpStream(line({ type: "stop", reason: "max_turn_requests", by: "driver-budget" })).status, "max-steps");
  assert.equal(parseAcpStream(line({ type: "stop", reason: "refusal", by: "agent" })).status, "error");
  assert.equal(parseAcpStream(line({ type: "stop", reason: "cancelled", by: "agent" })).status, "error");
  const stopped = parseAcpStream(line({ type: "text", text: "half a session" }));
  assert.equal(stopped.status, "error");
  assert.match(stopped.summary, /no stop event/);
  const errored = parseAcpStream(`${line({ type: "error", message: "agent negotiated ACP protocolVersion 3" })}\n${line({ type: "stop", reason: "refusal", by: "driver" })}`);
  assert.equal(errored.status, "error");
  assert.match(errored.summary, /protocolVersion 3/);
});

test("acpLiveTracker reports tool turns, permission decisions and text as one-line details", () => {
  const tracker = acpLiveTracker();
  const feed = (o: unknown) => tracker.feed(`${JSON.stringify(o)}\n`);
  assert.deepEqual(feed({ type: "tool", toolCallId: "t1", kind: "edit", title: "Write notes.md", status: "pending", locations: [] }), { phase: "harness", turn: 1, detail: "edit Write notes.md" });
  assert.equal(feed({ type: "tool", toolCallId: "t1", kind: "edit", title: "Write notes.md", status: "completed", locations: [] })?.turn, 1, "same tool id does not tick twice");
  assert.deepEqual(feed({ type: "permission", kind: "edit", decision: "deny", locations: ["/etc/hosts"] }), { phase: "harness", turn: 1, detail: "permission edit: denied" });
  assert.deepEqual(feed({ type: "text", messageId: null, text: "Working on it." }), { phase: "harness", turn: 1, detail: "Working on it." });
  assert.equal(feed({ type: "usage", usage: {} }), null);
});

test("a missing binary is a recorded error result naming the image, and the driver override reaches the command", async () => {
  const rig = await acpRig();
  // A PATH without the fake gemini: preflight finds nothing, nothing runs.
  const executor = new LocalExecutor({ root: rig.work, env: { PATH: "/usr/bin:/bin" } });
  const provider: ExecutorProvider = { isolated: true, async create() { return { handle: rig.work }; }, attach: () => executor };
  const wf = durableAgent({ model: neverModel, executor: provider, workdir: ".", harnesses: acpAdapters({ env: workerEnv() }), maxSteps: 7 });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-acp-missing",
    store,
    input: { task: "Write the notes file", harness: { id: "gemini", version: HARNESS_VERSIONS.gemini! } },
  });
  assert.equal(outcome.status, "completed");
  const events = await store.load("run-acp-missing");
  // Same shape as the external adapters: a missing binary records the
  // preflight and stops; there is no harness-run step because nothing ran.
  assert.deepEqual(stepsOf(events), ["sandbox", "harness-preflight"]);
  const out = outcome.output as { status: string; summary: string };
  assert.equal(out.status, "error");
  assert.match(out.summary, /gemini is not on PATH in the sandbox image/);
  assert.match(out.summary, /images\/build\.sh --harness gemini/);
  assert.match(out.summary, /@google\/gemini-cli@/);
});

test("cleanup: the spec and prompt files never outlive the run", async () => {
  const rig = await acpRig();
  await driveGemini(rig);
  const agentDir = await readdir(join(rig.work, ".teploy-agent")).catch(() => [] as string[]);
  assert.deepEqual(agentDir, [], ".teploy-agent is empty after the run: no spec, no prompt");
});

test("a driver that fails before initialize is a recorded error, never a thrown step", async () => {
  const bin = await mkdtemp(join(tmpdir(), "acp-dead-"));
  await writeFile(join(bin, "gemini"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"0.64.0 (dead)\"; exit 0; fi\necho 'no ACP here' >&2\nexit 3\n");
  await chmod(join(bin, "gemini"), 0o755);
  const work = await mkdtemp(join(tmpdir(), "acp-dead-work-"));
  const executor = new LocalExecutor({ root: work, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  const provider: ExecutorProvider = { isolated: true, async create() { return { handle: work }; }, attach: () => executor };
  const wf = durableAgent({
    model: neverModel,
    executor: provider,
    workdir: ".",
    harnesses: acpAdapters({ env: { GEMINI_API_KEY: FAKE_KEY, SHIP_ACP_DRIVER: `node ${shq(DRIVER)}` } }),
    maxSteps: 7,
  });
  const store = new MemoryEventStore();
  const outcome = await executeRun({
    workflow: wf,
    runId: "run-acp-dead",
    store,
    input: { task: "Write the notes file", harness: { id: "gemini", version: HARNESS_VERSIONS.gemini! } },
  });
  assert.equal(outcome.status, "completed");
  const record = stepResult<AcpHarnessRunRecord>((await store.load("run-acp-dead")), "harness-run");
  assert.equal(record.status, "error");
  assert.match(record.summary, /no ACP here|exited|initialize/i);
});
