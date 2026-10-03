import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITY_NAMES, DECLARED_HARNESS_IDS, OPERATION_CAPABILITY, capabilityOf, conformanceCheck, declarationFor, refusalFor,
} from "./harness-capabilities.js";
import type { HarnessDeclaration, HarnessOperation } from "./harness-capabilities.js";
import { HARNESS_IDS } from "./harness.js";

const OPS = Object.keys(OPERATION_CAPABILITY) as HarnessOperation[];

test("S13: every harness Ship can select publishes a complete declaration with reasons", () => {
  assert.deepEqual([...DECLARED_HARNESS_IDS].sort(), [...HARNESS_IDS].sort());
  for (const id of DECLARED_HARNESS_IDS) {
    const d = declarationFor(id)!;
    for (const cap of CAPABILITY_NAMES) assert.ok(d.capabilities[cap].reason.trim() !== "", `${id}.${cap} has a reason`);
  }
});

test("S13: every declared-refused operation has a refusal message; supported and partial have none", () => {
  for (const id of DECLARED_HARNESS_IDS) {
    for (const op of OPS) {
      const status = capabilityOf(id, OPERATION_CAPABILITY[op]).status;
      const msg = refusalFor(id, op);
      if (status === "refused") assert.ok(msg !== undefined && msg.length > 20, `${id}/${op} refusal`);
      else assert.equal(msg, undefined, `${id}/${op} is not refused`);
    }
  }
  assert.match(refusalFor("claude-code", "plan-review")!, /^Plan review requires the native harness/);
  assert.equal(refusalFor("native", "plan-review"), undefined);
  assert.ok(refusalFor("opencode", "steer"));
});

test("S13: an unknown harness id supports nothing and is refused everything", () => {
  for (const op of OPS) assert.match(refusalFor("mystery", op)!, /Unknown harness "mystery"/);
  for (const cap of CAPABILITY_NAMES) assert.equal(capabilityOf("mystery", cap).status, "refused");
  assert.equal(declarationFor("__proto__"), undefined);
  assert.equal(declarationFor("toString"), undefined);
});

test("S13: accounting honesty is declared, and unknown pricing is not priced", () => {
  assert.equal(declarationFor("native")!.accounting, "priced");
  assert.equal(declarationFor("claude-code")!.accounting, "unpriced-under-oauth");
  assert.equal(declarationFor("opencode")!.accounting, "unknown");
});

const native = declarationFor("native")!;
const cc = declarationFor("claude-code")!;

test("S13 conformance: a harness that accepts steer and silently drops the note is flagged", () => {
  const r = conformanceCheck(native, { operation: "steer", accepted: true, sideEffects: true, honoured: false });
  assert.equal(r.ok, false);
  assert.equal(r.mismatches[0]!.kind, "silently-dropped");
  // The behaviour the external adapters had before the route refused.
  const old = conformanceCheck(cc, { operation: "steer", accepted: true, sideEffects: true, honoured: false });
  assert.equal(old.mismatches[0]!.kind, "accepted-unsupported");
});

test("S13 conformance: declared-refused that starts work, or refuses silently, is flagged", () => {
  const started = conformanceCheck(cc, { operation: "plan-review", accepted: false, sideEffects: true, refusalMessage: "no" });
  assert.deepEqual(started.mismatches.map((m) => m.kind), ["refused-with-side-effects"]);
  const mute = conformanceCheck(cc, { operation: "plan-review", accepted: false, sideEffects: false });
  assert.deepEqual(mute.mismatches.map((m) => m.kind), ["refusal-unexplained"]);
});

test("S13 conformance: supported-but-refused and unverified acceptance are flagged", () => {
  assert.deepEqual(
    conformanceCheck(native, { operation: "recovery", accepted: false, sideEffects: false, refusalMessage: "x" }).mismatches.map((m) => m.kind),
    ["refused-supported"],
  );
  assert.deepEqual(
    conformanceCheck(native, { operation: "steer", accepted: true, sideEffects: true }).mismatches.map((m) => m.kind),
    ["accepted-unverified"],
  );
});

test("S13 conformance: honest behaviour passes, including the real refusal text", () => {
  assert.equal(conformanceCheck(native, { operation: "steer", accepted: true, sideEffects: true, honoured: true }).ok, true);
  for (const op of OPS) {
    if (capabilityOf("claude-code", OPERATION_CAPABILITY[op]).status !== "refused") continue;
    const r = conformanceCheck(cc, { operation: op, accepted: false, sideEffects: false, refusalMessage: refusalFor("claude-code", op) });
    assert.equal(r.ok, true, op);
  }
});

test("S13 conformance: a newcomer declaring a refusal cannot pass by accepting it", () => {
  const newcomer: HarnessDeclaration = { ...cc, id: "newcomer" };
  assert.equal(conformanceCheck(newcomer, { operation: "steer", accepted: true, sideEffects: true, honoured: true }).ok, false);
});
