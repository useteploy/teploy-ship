import assert from "node:assert/strict";
import test from "node:test";

import { attachEvidence } from "./fix-evidence.js";
import { parseArgs } from "./args.js";
import type { RepoRef } from "./git.js";
import { VERIFICATION_END, VERIFICATION_START } from "./verification.js";

// `teploy-ship fix` published a pull request whose entire body was
// result.summary — the agent's own account of its own work, which is exactly
// the claim FINISH_NUDGE_VERIFY exists because models get wrong. The durable
// path stopped trusting it; this surface still did. These cover the wiring that
// closed that, and the two rules carried over from the worker: nothing here can
// fail a delivered fix, and a surface wired for nothing says nothing.

const REF: RepoRef = { kind: "forgejo", base: "https://git.example.com", owner: "o", repo: "r", cloneUrl: "https://git.example.com/o/r.git" };

/** Records every request and plays a body back, the way Forgejo would. */
function prStub(body: string, opts: { patchOk?: boolean } = {}) {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fetchImpl = (async (url: unknown, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url: String(url), ...(init?.body !== undefined ? { body: init.body } : {}) });
    if (method === "GET") return { ok: true, status: 200, json: async () => ({ body }) };
    if (method === "PATCH") return { ok: opts.patchOk !== false, status: opts.patchOk === false ? 500 : 200, json: async () => ({}) };
    return { ok: true, status: 201, json: async () => ({}) };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const base = {
  ref: REF,
  token: "t",
  pr: 7,
  branch: "ship/fix-1",
  runId: "run-abc",
  args: parseArgs([]),
};

test("a fix's evidence lands in the pull request body, between the markers", async () => {
  const { fetchImpl, calls } = prStub("The agent's own summary.");
  await attachEvidence({
    ...base,
    evidence: { tests: { kind: "passed", command: "pytest", durationMs: 12 } },
    fetchImpl,
  });

  const patch = calls.find((c) => c.method === "PATCH");
  assert.ok(patch !== undefined, "the body is amended, not commented on — a reviewer reads the body first");
  const body = JSON.parse(patch.body ?? "{}").body as string;
  assert.ok(body.includes(VERIFICATION_START) && body.includes(VERIFICATION_END));
  assert.ok(body.includes("The agent's own summary."), "the agent's account survives; the evidence is added beside it");
  assert.match(body, /pytest/);
});

test("a fix wired for nothing adds nothing to the pull request", async () => {
  // Printing "not deployed, not measured, not tested" on every PR trains a
  // reviewer to skip the section that sometimes carries the real thing.
  const { fetchImpl, calls } = prStub("Body.");
  await attachEvidence({ ...base, evidence: {}, fetchImpl });
  assert.deepEqual(calls, [], "no read, no write, no comment");
});

test("evidence falls back to a comment when the body cannot be written", async () => {
  const { fetchImpl, calls } = prStub("Body.", { patchOk: false });
  await attachEvidence({
    ...base,
    evidence: { tests: { kind: "failed", command: "pytest", durationMs: 12, exitCode: 1, output: "1 failed" } },
    fetchImpl,
  });
  assert.ok(calls.some((c) => c.method === "POST" && c.url.includes("/issues/7/comments")), "worse placement, still delivered");
});

test("a fix never deploys a preview unless it was explicitly asked", async () => {
  // The only piece of evidence that changes the world: it shells the teploy CLI
  // with credentials that reach real servers. Reading telemetry and running a
  // suite are safe to infer from configuration; deploying is not — `fix` runs
  // on an operator's laptop.
  const previousDir = process.env.SHIP_PREVIEW_DIR;
  const previousAsk = process.env.SHIP_PREVIEW;
  process.env.SHIP_PREVIEW_DIR = "/tmp/some-clone";
  delete process.env.SHIP_PREVIEW;
  try {
    let deployed = 0;
    const deploy = (async () => {
      deployed += 1;
      return { kind: "deployed" as const, url: "https://x.example.com", image: "i" };
    }) as never;

    const configuredOnly = prStub("Body.");
    await attachEvidence({ ...base, evidence: {}, fetchImpl: configuredOnly.fetchImpl, deploy });
    assert.equal(deployed, 0, "SHIP_PREVIEW_DIR alone must not trigger a deploy");

    const asked = prStub("Body.");
    await attachEvidence({
      ...base,
      args: parseArgs(["--preview"]),
      evidence: {},
      fetchImpl: asked.fetchImpl,
      deploy,
    });
    assert.equal(deployed, 1, "--preview is the ask, and it reaches deployPreview");
  } finally {
    if (previousDir === undefined) delete process.env.SHIP_PREVIEW_DIR;
    else process.env.SHIP_PREVIEW_DIR = previousDir;
    if (previousAsk !== undefined) process.env.SHIP_PREVIEW = previousAsk;
  }
});

test("a broken evidence step never fails a fix that already delivered", async () => {
  // The work is pushed and the PR is open before any of this runs. Evidence is
  // an improvement on that, never a precondition for it.
  const exploding = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  await attachEvidence({
    ...base,
    evidence: { tests: { kind: "passed", command: "pytest", durationMs: 12 } },
    fetchImpl: exploding,
  });
});
