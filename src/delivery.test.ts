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
  executeDeliveryRollback,
  isStaleExecuting,
  readBackDelivery,
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
  // executeDelivery holds from executing whenever a precondition failed
  // before touching the target — the store must be able to record that
  // (found live 2026-09-22: the refused transition stuck the record).
  assert.equal(transitionAllowed("executing", "held"), true);
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

  // The boundary path: the sha lives on merge-rebase, the decision says only `merged`.
  const boundary = [
    step("repo-push", { kind: "pushed", sha: "feed0000beef" }, 1),
    step("merge-rebase", { kind: "up-to-date", sha: "feed0000beef" }, 2),
    step("merge-decision", { kind: "merged", rebase: "up-to-date" }, 3),
  ];
  assert.equal(deliveryFromEvents("run-b", "r", boundary)!.mergedSha, "feed0000beef");
  // An explicit decision sha still wins over the rebase sha.
  const bothShas = [
    step("merge-rebase", { kind: "rebased", sha: "ccc" }, 1),
    step("merge-decision", { kind: "merged", sha: "ddd" }, 2),
  ];
  assert.equal(deliveryFromEvents("run-c", "r", bothShas)!.mergedSha, "ddd");

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

const unknownRecord = (over: Partial<DeliveryRecord> = {}): DeliveryRecord =>
  ({
    ...base(),
    state: "unknown",
    updatedAt: "2026-09-22T00:00:00.000Z",
    artifactDigest: "ship-delivery-abc123",
    destination: "scratch-7471",
    recoveryVersion: "v9",
    actor: "op@ship",
    ...over,
  }) as DeliveryRecord;

const statusRunner = (body: unknown, code = 0): CommandRunner => async () => ({
  code,
  stdout: code === 0 ? JSON.stringify(body) : "",
  stderr: code === 0 ? "" : "ssh: connection refused",
});

const status = (
  currentHash: string,
  containers: Array<{ Image: string; State: string }> = [{ Image: "ship-delivery-abc123", State: "running" }],
) => ({
  app: "scratch",
  server: "infra-home",
  state: { current_hash: currentHash },
  containers,
});

test("readBackDelivery confirms only on the version AND the artifact, and never fails on a lost read", async () => {
  // Both identity halves match → confirmed.
  const confirmed = await readBackDelivery(unknownRecord(), { dir: "/srv/trusted", run: statusRunner(status("abc123d")) });
  assert.equal(confirmed.outcome, "confirmed");

  // Version matches but the running image is not the approved artifact → mismatch.
  const wrongImage = await readBackDelivery(unknownRecord(), {
    dir: "/srv/trusted",
    run: statusRunner(status("abc123d", [{ Image: "other:9", State: "running" }])),
  });
  assert.equal(wrongImage.outcome, "mismatch");
  assert.match(wrongImage.detail, /not the approved artifact/);

  // Version matches but nothing is running → mismatch, not confirmed.
  const stopped = await readBackDelivery(unknownRecord(), {
    dir: "/srv/trusted",
    run: statusRunner(status("abc123d", [{ Image: "ship-delivery-abc123", State: "exited" }])),
  });
  assert.equal(stopped.outcome, "mismatch");

  // The target still runs the recovery version → the deployment did not take effect.
  const oldVersion = await readBackDelivery(unknownRecord(), { dir: "/srv/trusted", run: statusRunner(status("v9")) });
  assert.equal(oldVersion.outcome, "mismatch");
  assert.match(oldVersion.detail, /v9.*not the approved abc123d/s);

  // A lost or unreadable read never records as failed — unknown retries.
  const refused = await readBackDelivery(unknownRecord(), { dir: "/srv/trusted", run: statusRunner(null, 1) });
  assert.equal(refused.outcome, "unreadable");
  assert.match(refused.detail, /connection refused/);
  const garbage: CommandRunner = async () => ({ code: 0, stdout: "Deploying...", stderr: "" });
  const unparseable = await readBackDelivery(unknownRecord(), { dir: "/srv/trusted", run: garbage });
  assert.equal(unparseable.outcome, "unreadable");
  const unconfigured = await readBackDelivery(unknownRecord(), { run: never });
  assert.equal(unconfigured.outcome, "unreadable");
  assert.match(unconfigured.detail, /SHIP_DELIVERY_DIR/);

  // The store's fence moves unknown → confirmed / failed exactly once.
  const dir = await mkdtemp(join(tmpdir(), "ship-delivery-"));
  const store = new FileDeliveryStore(dir);
  const record = await store.propose(base());
  await store.transition(record.id, "proposed", "approved", { actor: "op", destination: "scratch", recoveryVersion: "v9" });
  await store.transition(record.id, "approved", "executing", {});
  await store.transition(record.id, "executing", "unknown", { artifactDigest: "ship-delivery-abc123" });
  const won = await store.transition(record.id, "unknown", "confirmed", { reason: "target read back" });
  assert.equal(won.state, "confirmed");
  const lost = await store.transition(record.id, "unknown", "failed", { reason: "late reader" });
  assert.equal(lost.state, "confirmed", "the late reconciler learns it lost");

  // A failed delivery can be re-approved (the recovery path this slice
  // itself exercised live), and confirmed is terminal — an illegal move out
  // of it is refused outright, not soft-lost.
  await assert.rejects(store.transition(record.id, "confirmed", "held", {}), /cannot move/);
});

test("readBackDelivery parses the CLI's real status shape, captured live", async () => {
  // Byte-for-byte the shape `teploy status --json` emitted against the live
  // scratch target on 2026-09-22 (fields trimmed to the ones read). The
  // capitalized Image/State are the CLI's Go struct fields; a parser written
  // from assumption instead of this shape failed a succeeded deployment.
  const live = {
    app: "ship-delivery-proof",
    server: "100.108.123.49",
    state: { current_hash: "abc123d", schema_version: 2 },
    containers: [
      {
        ID: "b2906f37bdd8",
        Name: "ship-delivery-proof-web-abc123d",
        Image: "ship-delivery-abc123",
        State: "running",
        Status: "Up 5 seconds",
        Labels: { "teploy.app": "ship-delivery-proof", "teploy.version": "abc123d" },
      },
    ],
  };
  const read = await readBackDelivery(unknownRecord(), { dir: "/srv/trusted", run: statusRunner(live) });
  assert.equal(read.outcome, "confirmed");
});

test("revalidation holds a wrong-target, reverted, or superseded approval; exactly-the-tip proceeds", async () => {
  const now = "2026-09-22T00:00:00.000Z";
  const record = { ...base(), state: "executing", updatedAt: now } as DeliveryRecord;

  // Wrong target: the trusted copy's marker names a different repository.
  const wrongRepo: CommandRunner = async (argv: string[]) => {
    if (argv[0] === "cat" && argv[1]!.endsWith(".teploy-ship-delivery-repo")) {
      return { code: 0, stdout: "http://forge.example/Tyler/other.git", stderr: "" };
    }
    throw new Error("nothing else should run for a wrong-target delivery");
  };
  const wrongTarget = await executeDelivery(record, { dir: "/srv/trusted", run: wrongRepo, now: () => now });
  assert.equal(wrongTarget.state, "held");
  assert.match(wrongTarget.reason!, /wrong target/);

  // The git plumbing answers, parameterized by ancestry and tip.
  const gitFor = (ancestorOk: boolean, tip: string): CommandRunner => {
    const ok: CommandResult = { code: 0, stdout: "", stderr: "" };
    return async (argv: string[]) => {
      if (argv[0] === "cat") return ok; // no marker bound
      if (argv[1] === "fetch" || argv[1] === "symbolic-ref") {
        if (argv[1] === "symbolic-ref") return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
        return ok;
      }
      if (argv[0] === "git" && argv[1] === "rev-parse") return { code: 0, stdout: `${tip}\n`, stderr: "" };
      if (argv[0] === "git" && argv[1] === "merge-base") {
        return ancestorOk ? ok : { code: 1, stdout: "", stderr: "" };
      }
      if (argv[0] === "git" && argv[1] === "worktree") return ok;
      if (argv[1] === "build") return { code: 0, stdout: JSON.stringify({ image: "img" }), stderr: "" };
      if (argv[1] === "deploy") return { code: 0, stdout: "Deployed", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
  };

  const reverted = await executeDelivery(record, { dir: "/srv/trusted", run: gitFor(false, "abc123def456"), now: () => now });
  assert.equal(reverted.state, "held");
  assert.match(reverted.reason!, /no longer on the default branch/);

  const superseded = await executeDelivery(record, { dir: "/srv/trusted", run: gitFor(true, "fff000fff000"), now: () => now });
  assert.equal(superseded.state, "held");
  assert.match(superseded.reason!, /moved past the approved merge/);

  const exact = await executeDelivery(record, { dir: "/srv/trusted", run: gitFor(true, "abc123def456"), now: () => now });
  assert.equal(exact.state, "unknown", "approval of exactly the tip proceeds to the honest post-deploy state");
});

test("the rollback executor refuses honestly and verifies by read-back", async () => {
  const confirmed = { ...unknownRecord(), state: "confirmed" } as DeliveryRecord;

  const unconfigured = await executeDeliveryRollback(confirmed, { run: never });
  assert.equal(unconfigured.state, "failed");
  assert.match(unconfigured.evidence!, /SHIP_DELIVERY_DIR/);

  const noRetained = await executeDeliveryRollback({ ...confirmed, recoveryVersion: undefined }, { dir: "/srv/trusted", run: never });
  assert.equal(noRetained.state, "failed");
  assert.match(noRetained.evidence!, /no retained recovery version/);

  const refused: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "no such version" });
  const refusedOut = await executeDeliveryRollback(confirmed, { dir: "/srv/trusted", run: refused });
  assert.equal(refusedOut.state, "failed");
  assert.match(refusedOut.evidence!, /no such version/);

  const rollbackOk = (currentHash: string, running = true): CommandRunner => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (argv: string[]) => {
      calls.push(argv);
      if (argv[1] === "rollback") return { code: 0, stdout: "Rolled back", stderr: "" };
      if (argv[1] === "status") {
        return {
          code: 0,
          stdout: JSON.stringify({
            state: { current_hash: currentHash },
            containers: running ? [{ Name: "app", Image: "old", State: "running" }] : [],
          }),
          stderr: "",
        };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    return runner;
  };

  const done = await executeDeliveryRollback({ ...confirmed, recoveryVersion: "v9" }, { dir: "/srv/trusted", run: rollbackOk("v9") });
  assert.equal(done.state, "done");
  assert.match(done.evidence!, /retained version v9 serving/);

  const wrongVersion = await executeDeliveryRollback({ ...confirmed, recoveryVersion: "v9" }, { dir: "/srv/trusted", run: rollbackOk("v8") });
  assert.equal(wrongVersion.state, "failed");
  assert.match(wrongVersion.evidence!, /target runs v8/);
});

test("rollback requests are refused, claimed, and finished through the fence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-delivery-"));
  const store = new FileDeliveryStore(dir);
  const record = await store.propose(base());

  await assert.rejects(store.requestRollback(record.id, "op", "why"), /only a confirmed delivery/);

  await store.transition(record.id, "proposed", "approved", { actor: "op", destination: "scratch", recoveryVersion: "v9" });
  await store.transition(record.id, "approved", "executing", {});
  await store.transition(record.id, "executing", "unknown", { artifactDigest: "img" });
  await store.transition(record.id, "unknown", "confirmed", { reason: "read back" });

  // A record confirmed WITHOUT a retained version (operator hand-surgery or
  // an older record) refuses the rollback — the missing-retained-version
  // negative the contract demands. Hand-written to the store's file, the
  // only way such a record can exist.
  const orphan: DeliveryRecord = {
    ...base("run-orphan"),
    destination: "scratch",
    state: "confirmed",
    updatedAt: new Date().toISOString(),
  } as DeliveryRecord;
  const storeFile = join(dir, "deliveries.json");
  const existing = JSON.parse(await (await import("node:fs/promises")).readFile(storeFile, "utf8")) as Record<string, DeliveryRecord>;
  await (await import("node:fs/promises")).writeFile(storeFile, JSON.stringify({ ...existing, [orphan.id]: orphan }));
  await assert.rejects(store.requestRollback(orphan.id, "op", "why"), /no retained recovery version/);

  const requested = await store.requestRollback(record.id, "op@ship", "regression detected in production");
  assert.equal(requested.rollback?.state, "requested");
  assert.equal(requested.rollback?.actor, "op@ship");
  assert.equal(requested.state, "confirmed", "rollback never changes the delivery state");

  await assert.rejects(store.requestRollback(record.id, "op", "again"), /already/);

  const claimed = await store.claimRollback(record.id);
  assert.equal(claimed.rollback?.state, "executing");
  const lostClaim = await store.claimRollback(record.id);
  assert.equal(lostClaim.rollback?.state, "executing", "the second claimer learns it lost");

  const finished = await store.finishRollback(record.id, {
    state: "done",
    actor: "op@ship",
    reason: "regression detected in production",
    requestedAt: claimed.rollback!.requestedAt,
    finishedAt: new Date().toISOString(),
    evidence: "target read back: retained version v9 serving",
  });
  assert.equal(finished.rollback?.state, "done");
  await assert.rejects(store.requestRollback(record.id, "op", "re-roll"), /already done/);

  // A FAILED rollback can be re-requested.
  const dir2 = await mkdtemp(join(tmpdir(), "ship-delivery-"));
  const store2 = new FileDeliveryStore(dir2);
  const second = await store2.propose(base("run-d3"));
  await store2.transition(second.id, "proposed", "approved", { actor: "op", destination: "d", recoveryVersion: "v1" });
  await store2.transition(second.id, "approved", "executing", {});
  await store2.transition(second.id, "executing", "unknown", { artifactDigest: "img" });
  await store2.transition(second.id, "unknown", "confirmed", { reason: "read back" });
  await store2.requestRollback(second.id, "op", "first attempt");
  await store2.claimRollback(second.id);
  await store2.finishRollback(second.id, {
    state: "failed",
    actor: "op",
    reason: "first attempt",
    requestedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    evidence: "rollback refused",
  });
  const retried = await store2.requestRollback(second.id, "op", "second attempt after fixing the target");
  assert.equal(retried.rollback?.state, "requested");
});

test("isStaleExecuting keys on state and age, above the execution ceiling", () => {
  const now = Date.parse("2026-09-22T01:00:00.000Z");
  const fresh = new Date(now - 60_000).toISOString();
  const executing = { ...unknownRecord(), state: "executing", updatedAt: fresh } as DeliveryRecord;
  assert.equal(isStaleExecuting(executing, now), false, "fresh executions are left alone");
  assert.equal(isStaleExecuting({ ...executing, updatedAt: new Date(now - 36 * 60_000).toISOString() }, now), true);
  assert.equal(isStaleExecuting({ ...unknownRecord(), updatedAt: new Date(now - 36 * 60_000).toISOString() }, now), false, "only executing records");
  assert.equal(isStaleExecuting({ ...executing, updatedAt: new Date(now - 2 * 60_000).toISOString() }, now, 60_000), true, "the window is configurable for the live proof");
});
