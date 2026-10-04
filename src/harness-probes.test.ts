import assert from "node:assert/strict";
import { test } from "node:test";

import { LocalExecutor } from "@neutron-build/agents";
import { MemoryEventStore, executeRun } from "@neutron-build/workflow";

import { durableAgent } from "./durable.js";
import type { DurableAgentOutput } from "./durable.js";
import { HARNESS_PACKAGES } from "./harness.js";
import { STEER_UNSUPPORTED_MESSAGE, declarationFor } from "./harness-capabilities.js";
import type { HarnessDeclaration } from "./harness-capabilities.js";
import { externalAdapters } from "./harness-external.js";
import { PROBED_OPERATIONS, credentialResidue, fakeExternalHarness, probeHarness, probeOperation } from "./harness-probes.js";

const IDS = ["native", "claude-code", "opencode"] as const;

test("S13 probes: every declared harness conforms to its own declaration under real adapter probes", async () => {
  for (const id of IDS) {
    const report = await probeHarness(id);
    assert.deepEqual(report.results.map((r) => r.operation), [...PROBED_OPERATIONS]);
    assert.equal(report.ok, true, `${id}: ${JSON.stringify(report.results.flatMap((r) => r.mismatches))}`);
    // The rest were not driven. That must be visible, not folded into "ok".
    assert.deepEqual([...report.unprobed].sort(), ["approval-park", "browser", "interrupt", "recovery", "use-tools"]);
  }
});

test("S13 probes: observations are what the adapters really did, not what the table says", async () => {
  // Native honours all three: parks on the plan, reads the note, frames the scan.
  const n = (op: Parameters<typeof probeOperation>[1]) => probeOperation("native", op);
  assert.deepEqual(await n("plan-review"), { operation: "plan-review", accepted: true, sideEffects: true, honoured: true });
  assert.equal((await n("steer")).honoured, true);
  assert.equal((await n("investigate")).honoured, true);

  for (const id of ["claude-code", "opencode"] as const) {
    // Plan review: the adapter throws before putFile/exec, so no agent starts and nothing is edited.
    const plan = await probeOperation(id, "plan-review");
    assert.equal(plan.accepted, false);
    assert.equal(plan.sideEffects, false, "a refused plan review must not have launched the agent");
    assert.match(plan.refusalMessage ?? "", /Plan review requires the native harness\. No external agent was started/);
    // Steer: refused at the gate with the real message, nothing stored.
    assert.deepEqual(await probeOperation(id, "steer"), { operation: "steer", accepted: false, sideEffects: false, refusalMessage: STEER_UNSUPPORTED_MESSAGE });
    // Scan: the vendor agent really got the read-only framing.
    assert.deepEqual(await probeOperation(id, "investigate"), { operation: "investigate", accepted: true, sideEffects: true, honoured: true });
  }
});

test("S13 probes: an adapter that accepts a steering note and drops it is caught, whichever way the table is wrong", async () => {
  // The gate lets the note through (a table that claims support). The external
  // adapter reads only its starting prompt, so the note never reaches the binary.
  const dropped = await probeOperation("claude-code", "steer", { admitSteer: () => true });
  assert.equal(dropped.accepted, true);
  assert.equal(dropped.honoured, false, "the note text must not appear in what the harness received");

  // Against the published declaration (steering refused): accepted a refused op.
  const real = await probeHarness("claude-code", { admitSteer: () => true });
  assert.deepEqual(real.results.find((r) => r.operation === "steer")!.mismatches.map((m) => m.kind), ["accepted-unsupported"]);

  // Against a declaration that CLAIMS steering is supported: the silent drop.
  const claim: HarnessDeclaration = structuredClone(declarationFor("claude-code")!);
  claim.capabilities.steering = { status: "supported", reason: "claimed, not true" };
  const lying = await probeHarness("claude-code", { declaration: claim, admitSteer: () => true });
  assert.equal(lying.ok, false);
  assert.deepEqual(lying.results.find((r) => r.operation === "steer")!.mismatches.map((m) => m.kind), ["silently-dropped"]);

  // Negative control: the same override on the harness that DOES read notes is clean.
  assert.equal((await probeHarness("native", { admitSteer: () => true })).ok, true);

  // And the same for opencode, so the finding is not specific to one adapter.
  const oc: HarnessDeclaration = structuredClone(declarationFor("opencode")!);
  oc.capabilities.steering = { status: "supported", reason: "claimed, not true" };
  const ocReport = await probeHarness("opencode", { declaration: oc, admitSteer: () => true });
  assert.deepEqual(ocReport.results.find((r) => r.operation === "steer")!.mismatches.map((m) => m.kind), ["silently-dropped"]);
});

test("S13 probes: a table that claims plan review for an external harness is caught as a refusal of a supported op", async () => {
  const claim: HarnessDeclaration = structuredClone(declarationFor("opencode")!);
  claim.capabilities.planning = { status: "supported", reason: "claimed, not true" };
  const report = await probeHarness("opencode", { declaration: claim });
  assert.deepEqual(report.results.find((r) => r.operation === "plan-review")!.mismatches.map((m) => m.kind), ["refused-supported"]);
});

// --- credential lifecycle -------------------------------------------------

const SECRET = "sk-ant-oat-probe-SECRET-1234567890";

async function runWithCredential(opts: { extraScript?: string[]; exitCode?: number }) {
  const rig = await fakeExternalHarness("claude-code", opts);
  const wf = durableAgent({
    model: { provider: "never", modelId: "never", async doGenerate() { throw new Error("no model"); }, async *doStream() { throw new Error("unused"); } },
    executor: rig.provider,
    workdir: ".",
    harnesses: externalAdapters({ env: { CLAUDE_CODE_OAUTH_TOKEN: SECRET } }),
  });
  const store = new MemoryEventStore();
  const outcome = await executeRun({ workflow: wf, runId: "cred", store, input: { task: "t", harness: { id: "claude-code", version: "1" } } });
  return { rig, out: outcome.output as DurableAgentOutput, events: await store.load("cred") };
}

test("credential lifecycle: a credential reaches the harness for the run and is gone from the sandbox after exit", async () => {
  const { rig, out, events } = await runWithCredential({});
  assert.equal(out.status, "finished");
  // It was delivered: the binary saw it in its environment...
  assert.match(await rig.seenEnv(), new RegExp(`CLAUDE_CODE_OAUTH_TOKEN=${SECRET}`));
  // ...but the file it travelled in was already removed before the binary started,
  // so the agent could not read it back off disk.
  assert.doesNotMatch(await rig.seenAgentDir(), /harness\.env/);
  // After exit: no file in the sandbox holds it, and the executor's own env never did.
  assert.deepEqual(await credentialResidue(rig.root, rig.executor, [SECRET]), []);
  // The scan does look at files the run wrote: the prompt file is removed too.
  assert.deepEqual(await credentialResidue(rig.root, rig.executor, ["unattended inside a sandbox"]), []);
  // And the durable log carries names, never the value.
  assert.ok(!JSON.stringify(events).includes(SECRET));
});

test("credential lifecycle: a harness that crashes still leaves no credential file behind", async () => {
  const { rig, out } = await runWithCredential({ exitCode: 9 });
  assert.equal(out.status, "error");
  assert.deepEqual(await credentialResidue(rig.root, rig.executor, [SECRET]), []);
});

test("credential lifecycle negative control: the residue scan finds a credential a misbehaving harness persists", async () => {
  // A harness that writes its environment into the tree is a leak the adapter
  // cannot prevent; the check must be able to see it or its clean result means nothing.
  const { rig } = await runWithCredential({ extraScript: [`env > leaked-env.txt`] });
  assert.deepEqual(await credentialResidue(rig.root, rig.executor, [SECRET]), ["leaked-env.txt"]);
});

test("credential lifecycle negative control: a credential in the executor's own environment is reported", async () => {
  const rig = await fakeExternalHarness("claude-code");
  const leaky = new LocalExecutor({ root: rig.root, env: { PATH: process.env.PATH ?? "", CLAUDE_CODE_OAUTH_TOKEN: SECRET } });
  assert.deepEqual(await credentialResidue(rig.root, leaky, [SECRET]), ["(executor environment)"]);
});

test("declared harness packages exist for every external probe id", () => {
  for (const id of ["claude-code", "opencode"]) assert.ok(HARNESS_PACKAGES[id]);
});
