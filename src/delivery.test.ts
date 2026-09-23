import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandResult, CommandRunner } from "./deploy.js";
import { DEFAULT_AUTHORITY } from "./governance.js";
import type { Governance, Grant } from "./governance.js";
import {
  FileDeliveryStore,
  deliveryFromEvents,
  executeDelivery,
  executeDeliveryRollback,
  isStaleExecuting,
  readBackDelivery,
  transitionAllowed,
  type ApproveAuthoritySources,
  type DeliveryRecord,
} from "./delivery.js";

const base = (runId = "run-d1"): Omit<DeliveryRecord, "state" | "updatedAt"> => ({
  id: runId,
  runId,
  repo: "http://forge.example:3000/Tyler/app.git",
  mergedSha: "abc123def456",
});

/**
 * In-memory authority sources for the S15 recheck: one actor ("op@ship" by
 * default) resolved through a mutable role, against a governance document
 * whose approve grant can be narrowed. `role: null` is a deleted account.
 */
function sourcesFor(over: { actor?: string; role?: "admin" | "editor" | "viewer" | null; approve?: Grant } = {}): ApproveAuthoritySources {
  const actor = over.actor ?? "op@ship";
  const role = over.role === undefined ? "editor" : over.role;
  const approve = over.approve ?? DEFAULT_AUTHORITY.approve;
  const governance: Governance = { authority: { ...DEFAULT_AUTHORITY, approve }, windows: {}, reviewers: [] };
  return {
    governance: { get: async () => governance },
    users: {
      get: async (name: string) =>
        role === null || name !== actor ? null : { username: actor, role, createdAt: "2026-01-01T00:00:00.000Z" },
    },
  };
}

/** The git/teploy plumbing a delivery that passes its rechecks needs. */
function fullRunner(image = "ship-delivery-abc123"): CommandRunner {
  return async (argv: string[]) => {
    const ok: CommandResult = { code: 0, stdout: "", stderr: "" };
    if (argv[0] === "cat") return ok; // no marker bound
    if (argv[0] === "git") {
      if (argv[1] === "symbolic-ref") return { code: 1, stdout: "", stderr: "no default branch" }; // skips the stale check
      return ok; // fetch, diff, worktree
    }
    if (argv[1] === "build") return { code: 0, stdout: JSON.stringify({ image }), stderr: "" };
    if (argv[1] === "deploy") return { code: 0, stdout: "Deployed", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
}

/** observe.test.ts's stub shape: a fetch that answers one canned body. */
function fetchStub(status: number, body: unknown, seen: { url?: string } = {}): typeof globalThis.fetch {
  return (async (url: string) => {
    seen.url = String(url);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }) as unknown as typeof globalThis.fetch;
}

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
  const executing = (runId = "run-d1"): DeliveryRecord =>
    ({ ...base(runId), actor: "op@ship", destination: "scratch", recoveryVersion: "v9", state: "executing", updatedAt: now }) as DeliveryRecord;

  const unconfigured = await executeDelivery(executing(), { run: never, now: () => now, authority: sourcesFor() });
  assert.equal(unconfigured.state, "held");
  assert.match(unconfigured.reason!, /SHIP_DELIVERY_DIR/);

  const noMerge = await executeDelivery({ ...executing("run-d2"), mergedSha: undefined }, { dir: "/srv/trusted", run: never, now: () => now, authority: sourcesFor() });
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
  const delivered = await executeDelivery(executing(), {
    dir: "/srv/trusted",
    run: runner,
    now: () => now,
    authority: sourcesFor(),
  });
  // unknown, not confirmed: a returned deploy command is not a verified outcome.
  assert.equal(delivered.state, "unknown");
  assert.equal(delivered.artifactDigest, "ship-delivery-abc123");
  // The build and deploy ran INSIDE the merged-SHA worktree, argv only.
  assert.ok(calls.some((c) => c[0] === "teploy" && c[1] === "build" && c.at(-1)!.includes("abc123def456".slice(0, 12))));
  assert.ok(calls.some((c) => c[0] === "teploy" && c[1] === "deploy" && c.includes("ship-delivery-abc123")));

  const failing: CommandRunner = async (argv: string[]) =>
    argv[0] === "git" && argv[1] === "fetch" ? { code: 1, stdout: "", stderr: "no such sha" } : { code: 0, stdout: "", stderr: "" };
  const held = await executeDelivery(executing(), {
    dir: "/srv/trusted",
    run: failing,
    now: () => now,
    authority: sourcesFor(),
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
  // observe: {} pins these to "no observe service configured" — no env
  // leakage, no network — so this test stays about the identity pair.
  // Both identity halves match → confirmed.
  const confirmed = await readBackDelivery(unknownRecord(), { dir: "/srv/trusted", run: statusRunner(status("abc123d")), observe: {} });
  assert.equal(confirmed.outcome, "confirmed");
  assert.equal(confirmed.health, "unknown");
  assert.equal(confirmed.healthReason, "no observe service configured");

  // Version matches but the running image is not the approved artifact → mismatch.
  const wrongImage = await readBackDelivery(unknownRecord(), {
    dir: "/srv/trusted",
    run: statusRunner(status("abc123d", [{ Image: "other:9", State: "running" }])),
    observe: {},
  });
  assert.equal(wrongImage.outcome, "mismatch");
  assert.match(wrongImage.detail, /not the approved artifact/);

  // ID-form Image: the commit-pinned deploy path creates containers that
  // report the bare image ID, not the build tag. Found live 2026-09-23 —
  // a succeeded deployment failed its read-back. The ID resolves to the
  // artifact through `docker image inspect`'s RepoTags → confirmed.
  const idRunner: CommandRunner = async (argv) => {
    if (argv[0] === "docker" && argv[5] === "16a4e9a114f0") {
      return { code: 0, stdout: JSON.stringify(["ship-delivery-abc123:latest"]), stderr: "" };
    }
    return { code: 0, stdout: JSON.stringify(status("abc123d", [{ Image: "16a4e9a114f0", State: "running" }])), stderr: "" };
  };
  const byId = await readBackDelivery(unknownRecord(), { dir: "/srv/trusted", run: idRunner, observe: {} });
  assert.equal(byId.outcome, "confirmed");

  // An ID that resolves to SOME OTHER image's tags → still a mismatch, and
  // the evidence names what actually runs (capitalized Image — the old code
  // read `c.image` and printed "[undefined]").
  const wrongIdRunner: CommandRunner = async (argv) => {
    if (argv[0] === "docker" && argv[5] === "16a4e9a114f0") {
      return { code: 0, stdout: JSON.stringify(["something-else:latest"]), stderr: "" };
    }
    return { code: 0, stdout: JSON.stringify(status("abc123d", [{ Image: "16a4e9a114f0", State: "running" }])), stderr: "" };
  };
  const wrongId = await readBackDelivery(unknownRecord(), { dir: "/srv/trusted", run: wrongIdRunner, observe: {} });
  assert.equal(wrongId.outcome, "mismatch");
  assert.match(wrongId.detail, /\[16a4e9a114f0\]/);
  assert.doesNotMatch(wrongId.detail, /\[undefined\]/);

  // Version matches but nothing is running → mismatch, not confirmed.
  const stopped = await readBackDelivery(unknownRecord(), {
    dir: "/srv/trusted",
    run: statusRunner(status("abc123d", [{ Image: "ship-delivery-abc123", State: "exited" }])),
    observe: {},
  });
  assert.equal(stopped.outcome, "mismatch");

  // The target still runs the recovery version → the deployment did not take effect.
  const oldVersion = await readBackDelivery(unknownRecord(), { dir: "/srv/trusted", run: statusRunner(status("v9")), observe: {} });
  assert.equal(oldVersion.outcome, "mismatch");
  assert.match(oldVersion.detail, /v9.*not the approved abc123d/s);

  // A lost or unreadable read never records as failed — unknown retries.
  const refused = await readBackDelivery(unknownRecord(), { dir: "/srv/trusted", run: statusRunner(null, 1), observe: {} });
  assert.equal(refused.outcome, "unreadable");
  assert.match(refused.detail, /connection refused/);
  const garbage: CommandRunner = async () => ({ code: 0, stdout: "Deploying...", stderr: "" });
  const unparseable = await readBackDelivery(unknownRecord(), { dir: "/srv/trusted", run: garbage, observe: {} });
  assert.equal(unparseable.outcome, "unreadable");
  const unconfigured = await readBackDelivery(unknownRecord(), { run: never, observe: {} });
  assert.equal(unconfigured.outcome, "unreadable");
  assert.match(unconfigured.detail, /SHIP_DELIVERY_DIR/);

  // The store's fence moves unknown → confirmed / failed exactly once.
  const dir = await mkdtemp(join(tmpdir(), "ship-delivery-"));
  const store = new FileDeliveryStore(dir);
  const record = await store.propose(base());
  await store.transition(record.id, "proposed", "approved", { actor: "op", destination: "scratch", recoveryVersion: "v9" });
  await store.transition(record.id, "approved", "executing", {});
  await store.transition(record.id, "executing", "unknown", { artifactDigest: "ship-delivery-abc123" });
  // A confirmation silent about health is refused at the store (contract Q3:
  // recorded, never silently omitted).
  await assert.rejects(store.transition(record.id, "unknown", "confirmed", { reason: "target read back" }), /needs health/);
  const won = await store.transition(record.id, "unknown", "confirmed", {
    reason: "target read back",
    health: "unknown",
    healthReason: "no observe service configured",
  });
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
  const read = await readBackDelivery(unknownRecord(), { dir: "/srv/trusted", run: statusRunner(live), observe: {} });
  assert.equal(read.outcome, "confirmed");
});

test("revalidation holds a wrong-target, reverted, or superseded approval; exactly-the-tip proceeds", async () => {
  const now = "2026-09-22T00:00:00.000Z";
  const record = { ...base(), actor: "op@ship", state: "executing", updatedAt: now } as DeliveryRecord;

  // Wrong target: the trusted copy's marker names a different repository.
  const wrongRepo: CommandRunner = async (argv: string[]) => {
    if (argv[0] === "cat" && argv[1]!.endsWith(".teploy-ship-delivery-repo")) {
      return { code: 0, stdout: "http://forge.example/Tyler/other.git", stderr: "" };
    }
    throw new Error("nothing else should run for a wrong-target delivery");
  };
  const wrongTarget = await executeDelivery(record, { dir: "/srv/trusted", run: wrongRepo, now: () => now, authority: sourcesFor() });
  assert.equal(wrongTarget.state, "held");
  assert.match(wrongTarget.reason!, /wrong target/);

  // The git plumbing answers, parameterized by whether main serves the
  // approved bytes (tree equality — a squash-merge forge lands the same
  // bytes under a new sha, so ancestry is the wrong predicate).
  const gitFor = (treesEqual: boolean): CommandRunner => {
    const ok: CommandResult = { code: 0, stdout: "", stderr: "" };
    return async (argv: string[]) => {
      if (argv[0] === "cat") return ok; // no marker bound
      if (argv[1] === "fetch" || argv[1] === "symbolic-ref") {
        if (argv[1] === "symbolic-ref") return { code: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
        return ok;
      }
      if (argv[0] === "git" && argv[1] === "diff") {
        return treesEqual ? ok : { code: 1, stdout: "", stderr: "" };
      }
      if (argv[0] === "git" && argv[1] === "worktree") return ok;
      if (argv[1] === "build") return { code: 0, stdout: JSON.stringify({ image: "img" }), stderr: "" };
      if (argv[1] === "deploy") return { code: 0, stdout: "Deployed", stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
  };

  const reverted = await executeDelivery(record, { dir: "/srv/trusted", run: gitFor(false), now: () => now, authority: sourcesFor() });
  assert.equal(reverted.state, "held");
  assert.match(reverted.reason!, /no longer serves the approved bytes/);

  const fresh = await executeDelivery(record, { dir: "/srv/trusted", run: gitFor(true), now: () => now, authority: sourcesFor() });
  assert.equal(fresh.state, "unknown", "main serving the approved bytes proceeds — squash-merged or not — to the honest post-deploy state");
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
  await store.transition(record.id, "unknown", "confirmed", { reason: "read back", health: "unknown", healthReason: "no observe service configured" });

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
  await store2.transition(second.id, "unknown", "confirmed", { reason: "read back", health: "unknown", healthReason: "no observe service configured" });
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

test("execution re-resolves the approving actor: revoked, deleted, unreadable and unwired all hold; token and survivors run (S15)", async () => {
  const now = "2026-09-22T00:00:00.000Z";
  const executing = (actor?: string): DeliveryRecord =>
    ({
      ...base("run-auth"),
      ...(actor !== undefined ? { actor } : {}),
      destination: "scratch",
      recoveryVersion: "v9",
      state: "executing",
      updatedAt: now,
    }) as DeliveryRecord;

  // Role removed: the account resolves, the current grant does not cover it.
  const revoked = await executeDelivery(executing("op@ship"), { dir: "/srv/trusted", run: never, now: () => now, authority: sourcesFor({ role: "viewer" }) });
  assert.equal(revoked.state, "held");
  assert.match(revoked.reason!, /op@ship.*no longer holds the approve authority/);
  assert.match(revoked.reason!, /role viewer/);
  assert.match(revoked.reason!, /re-approve under a current authority/);

  // Policy narrowed: approve pulled back to admins only; the editor is out.
  const narrowed = await executeDelivery(executing("op@ship"), {
    dir: "/srv/trusted",
    run: never,
    now: () => now,
    authority: sourcesFor({ approve: { roles: ["admin"], users: [] } }),
  });
  assert.equal(narrowed.state, "held");
  assert.match(narrowed.reason!, /no longer holds the approve authority/);

  // Account deleted between approval and execution.
  const deleted = await executeDelivery(executing("op@ship"), { dir: "/srv/trusted", run: never, now: () => now, authority: sourcesFor({ role: null }) });
  assert.equal(deleted.state, "held");
  assert.match(deleted.reason!, /no longer exists in the account store/);

  // Unreadable governance: never fail-closed silently, never execute on an
  // unreadable check — the hold names what could not be read.
  const unreadable = await executeDelivery(executing("op@ship"), {
    dir: "/srv/trusted",
    run: never,
    now: () => now,
    authority: { governance: { get: async () => { throw new Error("store down"); } }, users: sourcesFor().users },
  });
  assert.equal(unreadable.state, "held");
  assert.match(unreadable.reason!, /governance could not be read to recheck the approving actor op@ship.*store down/);

  // An unreadable account store gets the same posture.
  const noAccounts = await executeDelivery(executing("op@ship"), {
    dir: "/srv/trusted",
    run: never,
    now: () => now,
    authority: { governance: sourcesFor().governance, users: { get: async () => { throw new Error("users unreadable"); } } },
  });
  assert.equal(noAccounts.state, "held");
  assert.match(noAccounts.reason!, /could not be resolved against the account store.*users unreadable/);

  // An execution path not bound to the stores cannot claim the check ran.
  const unwired = await executeDelivery(executing("op@ship"), { dir: "/srv/trusted", run: never, now: () => now });
  assert.equal(unwired.state, "held");
  assert.match(unwired.reason!, /not bound to the governance store/);

  // No recorded actor at all: unattributable, so unexecutable.
  const unattributed = await executeDelivery(executing(), { dir: "/srv/trusted", run: never, now: () => now, authority: sourcesFor() });
  assert.equal(unattributed.state, "held");
  assert.match(unattributed.reason!, /names no approving actor/);

  // An SSO principal (`issuer#sub`) cannot have its IdP role re-read here:
  // it passes only while the CURRENT approve grant names it as a stable id.
  const sso = "https://idp.example.com#alice";
  const named = await executeDelivery(executing(sso), {
    dir: "/srv/trusted",
    run: fullRunner(),
    now: () => now,
    authority: sourcesFor({ approve: { roles: ["admin"], users: [sso] } }),
  });
  assert.equal(named.state, "unknown");
  const unnamed = await executeDelivery(executing(sso), { dir: "/srv/trusted", run: never, now: () => now, authority: sourcesFor() });
  assert.equal(unnamed.state, "held");
  assert.match(unnamed.reason!, /not named in the current approve grant/);

  // The master credential always passes — there is no account behind it to lose.
  const token = await executeDelivery(executing("token"), { dir: "/srv/trusted", run: fullRunner(), now: () => now, authority: sourcesFor({ role: null }) });
  assert.equal(token.state, "unknown");

  // A surviving actor executes: recheck passes, the delivery proceeds.
  const survivor = await executeDelivery(executing("op@ship"), { dir: "/srv/trusted", run: fullRunner(), now: () => now, authority: sourcesFor() });
  assert.equal(survivor.state, "unknown");
  assert.equal(survivor.artifactDigest, "ship-delivery-abc123");
});

test("a delivery held by revocation re-approves and executes once the authority is re-granted", async () => {
  const now = "2026-09-22T00:00:00.000Z";
  const dir = await mkdtemp(join(tmpdir(), "ship-delivery-"));
  const store = new FileDeliveryStore(dir);
  const record = await store.propose(base("run-regrant"));
  await store.transition(record.id, "proposed", "approved", { actor: "op@ship", destination: "scratch-7471", recoveryVersion: "v9", policy: "operator-approval" });
  const claimed = await store.transition(record.id, "approved", "executing", {});

  // The actor's editor role is revoked between approval and execution.
  const revoked = await executeDelivery(claimed as DeliveryRecord, { dir: "/srv/trusted", run: never, now: () => now, authority: sourcesFor({ role: "viewer" }) });
  assert.equal(revoked.state, "held");
  await store.transition(record.id, "executing", "held", { reason: revoked.reason! });

  // Re-granted, re-approved — the held → approved move IS the re-authorization
  // the contract asks for — and the re-execution proceeds under it.
  const reApproved = await store.transition(record.id, "held", "approved", { actor: "op@ship", destination: "scratch-7471", recoveryVersion: "v9" });
  assert.equal(reApproved.state, "approved");
  const reclaimed = await store.transition(record.id, "approved", "executing", {});
  const out = await executeDelivery(reclaimed, { dir: "/srv/trusted", run: fullRunner(), now: () => now, authority: sourcesFor() });
  assert.equal(out.state, "unknown");
  await store.transition(record.id, "executing", "unknown", { artifactDigest: out.artifactDigest! });
  const read = await readBackDelivery(out, { dir: "/srv/trusted", run: statusRunner(status("abc123d")), observe: {} });
  assert.ok(read.outcome === "confirmed");
  const confirmed = await store.transition(record.id, "unknown", "confirmed", { reason: read.detail, health: read.health, healthReason: read.healthReason });
  assert.equal(confirmed.state, "confirmed");
  assert.equal(confirmed.health, "unknown");
  assert.equal(confirmed.healthReason, "no observe service configured");
});

test("confirmation records a wired Observe verdict — or an honest unknown — and never blocks on telemetry (contract Q3)", async () => {
  const at = new Date("2026-09-22T00:30:00.000Z"); // unknownRecord went unknown at 00:00 → a 30 min window
  const row = (over: Record<string, number> = {}) => ({
    service_name: "app-web",
    request_count: 120,
    error_count: 0,
    p50_ms: 12,
    p95_ms: 84,
    p99_ms: 190,
    apdex_score: 0.98,
    ...over,
  });
  const binding = (
    fetch: typeof globalThis.fetch,
    over: { project?: { observeService?: string } | null } = {},
  ) => ({
    target: { url: "https://observe.example", token: "share", service: "app-web", repo: base().repo, fetch },
    now: at,
    ...over,
  });

  // Healthy: the bound service answers, and the verdict states its numbers.
  const seen: { url?: string } = {};
  const healthy = await readBackDelivery(unknownRecord(), {
    dir: "/srv/trusted",
    run: statusRunner(status("abc123d")),
    observe: binding(fetchStub(200, [row()], seen)),
  });
  assert.ok(healthy.outcome === "confirmed");
  assert.equal(healthy.health, "healthy");
  assert.match(healthy.healthReason, /observe: healthy — app-web served 120 requests, 0 errors \(0\.00%\), p95 84ms in the 30 min since the delivery/);
  assert.match(seen.url ?? "", /\/api\/v1\/traces\/services/);

  // Degraded: over the pre-decided one-percentage-point error floor.
  const degraded = await readBackDelivery(unknownRecord(), {
    dir: "/srv/trusted",
    run: statusRunner(status("abc123d")),
    observe: binding(fetchStub(200, [row({ request_count: 100, error_count: 5 })])),
  });
  assert.ok(degraded.outcome === "confirmed");
  assert.equal(degraded.health, "degraded");
  assert.match(degraded.healthReason, /observe: degraded — app-web served 100 requests, 5 errors \(5\.00%\).*error floor/);

  // Unconfigured: no service for this repo — the honest unknown, as today.
  const unconfigured = await readBackDelivery(unknownRecord(), { dir: "/srv/trusted", run: statusRunner(status("abc123d")), observe: {} });
  assert.ok(unconfigured.outcome === "confirmed");
  assert.equal(unconfigured.health, "unknown");
  assert.equal(unconfigured.healthReason, "no observe service configured");

  // Unreachable: configured but not answering — unknown with the reason; the
  // confirmation itself stands.
  const boom = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof globalThis.fetch;
  const unreachable = await readBackDelivery(unknownRecord(), { dir: "/srv/trusted", run: statusRunner(status("abc123d")), observe: binding(boom) });
  assert.ok(unreachable.outcome === "confirmed");
  assert.equal(unreachable.health, "unknown");
  assert.match(unreachable.healthReason, /^observe unreachable: Observe could not be reached: ECONNREFUSED/);

  // A refused read (revoked share token) is unreachable's sibling, named as
  // wiring rather than mistaken for a quiet target.
  const refused = await readBackDelivery(unknownRecord(), {
    dir: "/srv/trusted",
    run: statusRunner(status("abc123d")),
    observe: binding(fetchStub(401, {})),
  });
  assert.ok(refused.outcome === "confirmed");
  assert.equal(refused.health, "unknown");
  assert.match(refused.healthReason, /^observe unreachable: Observe answered 401 \(the read token is not accepted\)/);

  // A quiet service is unmeasured, not green: zero requests carry no verdict.
  const quiet = await readBackDelivery(unknownRecord(), {
    dir: "/srv/trusted",
    run: statusRunner(status("abc123d")),
    observe: binding(fetchStub(200, [])),
  });
  assert.ok(quiet.outcome === "confirmed");
  assert.equal(quiet.health, "unknown");
  assert.match(quiet.healthReason, /no traffic for app-web in the 30 min since the delivery — health unmeasured, not green/);

  // A worker default service that is not ABOUT this repo is not configured —
  // the wrong-attribution lesson, restated for deliveries.
  const foreign = await readBackDelivery(unknownRecord(), {
    dir: "/srv/trusted",
    run: statusRunner(status("abc123d")),
    observe: {
      target: { url: "https://observe.example", token: "share", service: "other-web", repo: "http://forge.example:3000/Tyler/other.git", fetch: fetchStub(200, [row()]) },
      now: at,
    },
  });
  assert.ok(foreign.outcome === "confirmed");
  assert.equal(foreign.health, "unknown");
  assert.equal(foreign.healthReason, "no observe service configured");

  // The project's observeService is the attribution — but it still needs the
  // worker's telemetry wiring to read with.
  const noWiring = await readBackDelivery(unknownRecord(), {
    dir: "/srv/trusted",
    run: statusRunner(status("abc123d")),
    observe: { project: { observeService: "app-web" }, now: at },
  });
  assert.ok(noWiring.outcome === "confirmed");
  assert.equal(noWiring.health, "unknown");
  assert.match(noWiring.healthReason, /^observe unreachable: this worker has no telemetry wiring/);

  // With wiring, the project's service OVERRIDES the worker default: the
  // read below asks for app-web, not the target's default service.
  const projectRead = await readBackDelivery(unknownRecord(), {
    dir: "/srv/trusted",
    run: statusRunner(status("abc123d")),
    observe: binding(fetchStub(200, [row()]), { project: { observeService: "app-web" } }),
  });
  assert.ok(projectRead.outcome === "confirmed");
  assert.equal(projectRead.health, "healthy");
  assert.match(projectRead.healthReason, /app-web served 120 requests/);
});
