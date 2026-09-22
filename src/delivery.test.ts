import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandResult, CommandRunner } from "./deploy.js";
import {
  FileDeliveryStore,
  deliveryFromEvents,
  executeDelivery,
  transitionAllowed,
  type DeliveryRecord,
} from "./delivery.js";

const base = (runId = "run-d1"): Omit<DeliveryRecord, "state" | "updatedAt"> => ({
  id: runId,
  runId,
  repo: "http://forge.example:3000/Tyler/app.git",
  mergedSha: "abc123def456",
});

function step(name: string, result: unknown, seq = 1): { type: string; name?: string; seq: number; data?: unknown } {
  return { type: "step-completed", name, seq, data: { result } };
}

test("delivery records move only through legal, field-complete transitions, fenced by current state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-delivery-"));
  const store = new FileDeliveryStore(dir);
  const record = await store.propose(base());
  assert.equal(record.state, "proposed");
  assert.deepEqual((await store.propose(base())).id, record.id, "propose is idempotent per run");

  // proposed → approved REQUIRES the operator tuple.
  await assert.rejects(store.transition(record.id, "proposed", "approved", { actor: "op" }), /destination/);
  const approved = await store.transition(record.id, "proposed", "approved", {
    actor: "op@ship",
    destination: "scratch-7471",
    recoveryVersion: "v9",
    policy: "operator-approval",
  });
  assert.equal(approved.state, "approved");
  assert.equal(approved.recoveryVersion, "v9");

  // An illegal jump is refused before anything is written.
  await assert.rejects(store.transition(record.id, "approved", "confirmed", { artifactDigest: "x" }), /cannot move/);

  // A fenced transition that lost (state moved elsewhere) returns the winner.
  await store.transition(record.id, "approved", "held", { reason: "operator held it" });
  const winner = await store.transition(record.id, "approved", "executing", {});
  assert.equal(winner.state, "held", "the loser learns what won, silently");

  assert.equal(transitionAllowed("executing", "unknown"), true);
  assert.equal(transitionAllowed("confirmed", "anything" as never) && false, false);
});

test("deliveryFromEvents reads the merge off the recorded steps, never the account", () => {
  const events = [
    { type: "run-started", seq: 0 },
    step("repo-push", { kind: "pushed", sha: "feed0000beef" }, 1),
    step("auto-merge", { kind: "held", reasons: ["serious"] }, 2),
    step("merge-park", { attempt: 1 }, 3),
    step("merge-decision", { kind: "merged", rebase: "up-to-date", sha: "abc123def456" }, 4),
  ];
  const record = deliveryFromEvents("run-x", "http://forge.example/Tyler/app.git", events);
  assert.notEqual(record, null);
  assert.equal(record!.mergedSha, "abc123def456");
  assert.equal(record!.reviewedHead, "feed0000beef");

  // Unmerged and unknown outcomes record NOTHING.
  assert.equal(deliveryFromEvents("run-y", "r", [step("merge-decision", { kind: "merge-failed", status: 405 }, 1)]), null);
  assert.equal(deliveryFromEvents("run-z", "r", [step("merge-decision", { kind: "merge-unknown", status: 0 }, 1)]), null);
  // The boundary decision supersedes an earlier auto-merge on the same PR.
  const both = [step("auto-merge", { kind: "merged", sha: "aaa" }, 1), step("merge-decision", { kind: "merged", sha: "bbb" }, 2)];
  assert.equal(deliveryFromEvents("run-w", "r", both)!.mergedSha, "bbb");
});

test("executeDelivery holds honestly without a trusted copy, a proven merge, or a working build", async () => {
  const now = "2026-09-22T00:00:00.000Z";
  const unconfigured = await executeDelivery({ ...base(), state: "executing", updatedAt: now }, { run: never, now: () => now });
  assert.equal(unconfigured.state, "held");
  assert.match(unconfigured.reason!, /SHIP_DELIVERY_DIR/);

  const noMerge = await executeDelivery(
    { ...base("run-d2"), mergedSha: undefined, state: "executing", updatedAt: now },
    { dir: "/srv/trusted", run: never, now: () => now },
  );
  assert.equal(noMerge.state, "held");
  assert.match(noMerge.reason!, /merged SHA was never proven/);

  const calls: string[][] = [];
  const runner: CommandRunner = async (argv: string[], opts: { cwd: string; timeoutMs: number }) => {
    calls.push([...argv, opts.cwd]);
    const ok: CommandResult = { code: 0, stdout: "", stderr: "" };
    if (argv[0] === "git" && argv[1] === "fetch") return ok;
    if (argv[0] === "git" && argv[1] === "worktree") return ok;
    if (argv[1] === "build") return { code: 0, stdout: JSON.stringify({ image: "ship-delivery-abc123" }), stderr: "" };
    if (argv[1] === "deploy") return { code: 0, stdout: "Deployed", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  const delivered = await executeDelivery({ ...base(), state: "executing", updatedAt: now } as DeliveryRecord, {
    dir: "/srv/trusted",
    run: runner,
    now: () => now,
  });
  // unknown, not confirmed: a returned deploy command is not a verified outcome.
  assert.equal(delivered.state, "unknown");
  assert.equal(delivered.artifactDigest, "ship-delivery-abc123");
  // The build and deploy ran INSIDE the merged-SHA worktree, argv only.
  assert.ok(calls.some((c) => c[0] === "teploy" && c[1] === "build" && c.at(-1)!.includes("abc123def456".slice(0, 12))));
  assert.ok(calls.some((c) => c[0] === "teploy" && c[1] === "deploy" && c.includes("ship-delivery-abc123")));

  const failing: CommandRunner = async (argv: string[]) =>
    argv[0] === "git" && argv[1] === "fetch" ? { code: 1, stdout: "", stderr: "no such sha" } : { code: 0, stdout: "", stderr: "" };
  const held = await executeDelivery({ ...base(), state: "executing", updatedAt: now } as DeliveryRecord, {
    dir: "/srv/trusted",
    run: failing,
    now: () => now,
  });
  assert.equal(held.state, "held");
  assert.match(held.reason!, /no such sha/);
});

async function never(): Promise<{ code: number; stdout: string; stderr: string }> {
  throw new Error("this path must not run commands");
}
