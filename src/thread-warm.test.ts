import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalExecutor } from "@neutron-build/agents";

import type { SandboxOverrides } from "./durable.js";
import {
  WARM_THREAD_DEFAULT_TTL_SEC,
  WARM_THREAD_PER_PROJECT_HOST,
  sandboxOverridesDigest,
  sweepThreadWarm,
  threadWarmForEnqueue,
  threadWarmStore,
  warmThreadEnabled,
  warmThreadTtlSec,
  workspaceCredentialReason,
  type ThreadWarmRecord,
} from "./thread-warm.js";
import { MemoryRuntimeConfig } from "./runtime-config.js";

/** A memory config store, the shape the runtime hands the enqueue path. */
const config = () => new MemoryRuntimeConfig();

const record = (over: Partial<ThreadWarmRecord> = {}): ThreadWarmRecord => ({
  taskRootRunId: "run-root",
  repo: "https://forge.example.com/owner/repo",
  image: "0@teploy-sbx-snap:1",
  hostIndex: 0,
  head: "a".repeat(40),
  overridesDigest: sandboxOverridesDigest({ network: "allowlist" }),
  createdAt: new Date().toISOString(),
  ...over,
});

test("warmThreadEnabled needs SHIP_WARM_THREAD AND the SHIP_WARM_PARKS capability", () => {
  assert.equal(warmThreadEnabled({ SHIP_WARM_THREAD: "1" } as NodeJS.ProcessEnv), false, "the capability flag is load-bearing");
  assert.equal(warmThreadEnabled({ SHIP_WARM_PARKS: "1" } as NodeJS.ProcessEnv), false, "the feature flag alone is nothing");
  assert.equal(warmThreadEnabled({ SHIP_WARM_THREAD: "1", SHIP_WARM_PARKS: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(warmThreadEnabled({} as NodeJS.ProcessEnv), false, "off is the default");
});

test("the TTL defaults to Decision 16's 7200s and only a positive number overrides it", () => {
  assert.equal(warmThreadTtlSec({} as NodeJS.ProcessEnv), WARM_THREAD_DEFAULT_TTL_SEC);
  assert.equal(WARM_THREAD_DEFAULT_TTL_SEC, 7200);
  assert.equal(warmThreadTtlSec({ SHIP_WARM_THREAD_TTL_SEC: "600" } as NodeJS.ProcessEnv), 600);
  assert.equal(warmThreadTtlSec({ SHIP_WARM_THREAD_TTL_SEC: "junk" } as NodeJS.ProcessEnv), 7200);
  assert.equal(warmThreadTtlSec({ SHIP_WARM_THREAD_TTL_SEC: "-5" } as NodeJS.ProcessEnv), 7200);
});

test("the overrides digest is stable, order-insensitive, and BLIND to the warm volume", () => {
  const parent: SandboxOverrides = { warm: { repo: "owner/repo" }, network: "allowlist", egressAllow: ["a.example", "b.example"], limits: { memoryMb: 1024 } };
  const followUp: SandboxOverrides = { network: "allowlist", egressAllow: ["b.example", "a.example"], limits: { memoryMb: 1024 } };
  // The first turn of a thread runs on a warm volume; its PR follow-up does
  // not. If the digest saw `warm`, every follow-up would mismatch and the
  // feature could never fire (thread-warm.ts header).
  assert.equal(sandboxOverridesDigest(parent), sandboxOverridesDigest(followUp));
  assert.equal(sandboxOverridesDigest(undefined), sandboxOverridesDigest(undefined));
  assert.notEqual(sandboxOverridesDigest({ network: "allowlist" }), sandboxOverridesDigest({ network: "open" }), "the tier is part of the shape");
  assert.notEqual(sandboxOverridesDigest({ network: "allowlist" }), sandboxOverridesDigest({ network: "allowlist", egressAllow: ["api.example"] }), "egress is part of the shape");
  assert.notEqual(
    sandboxOverridesDigest({ network: "allowlist", limits: { memoryMb: 1024 } }),
    sandboxOverridesDigest({ network: "allowlist", limits: { memoryMb: 2048 } }),
    "limits are part of the shape",
  );
  assert.notEqual(sandboxOverridesDigest({ image: "a:1" }), sandboxOverridesDigest({ image: "a:2" }), "the image is part of the shape");
});

test("a clean workspace snapshots; credential material refuses", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-warm-clean-"));
  const ex = new LocalExecutor({ root });
  await ex.exec("git init -q -b main . && git config user.email t@t && git config user.name t");
  assert.equal(await workspaceCredentialReason(ex), null, "a plain clone-sized workspace is clean");

  const dirty = new LocalExecutor({ root: await mkdtemp(join(tmpdir(), "thread-warm-env-")) });
  await dirty.exec("mkdir -p .teploy-agent && printf 'KEY=x\n' > .teploy-agent/harness.env");
  assert.match((await workspaceCredentialReason(dirty)) ?? "", /harness scratch/, "a leftover harness.env refuses the snapshot");

  const helper = new LocalExecutor({ root: await mkdtemp(join(tmpdir(), "thread-warm-helper-")) });
  await helper.exec("git init -q -b main . && git config credential.helper store");
  assert.match((await workspaceCredentialReason(helper)) ?? "", /\.git config/, "a credential helper refuses the snapshot");

  const embedded = new LocalExecutor({ root: await mkdtemp(join(tmpdir(), "thread-warm-url-")) });
  await embedded.exec("git init -q -b main . && git remote add origin https://secret-token@forge.example.com/owner/repo.git");
  assert.match((await workspaceCredentialReason(embedded)) ?? "", /\.git config/, "a token-bearing remote URL refuses the snapshot");
});

test("the store replaces a thread's prior image and evicts oldest-first per project per host", async () => {
  const store = threadWarmStore(config());
  const discarded: string[] = [];
  const capped = threadWarmStore(config(), { cap: 2, discard: async (image) => { discarded.push(image); } });

  await store.record(record({ image: "0@snap-a" }));
  await store.record(record({ image: "0@snap-b" }));
  const got = await store.get("run-root");
  assert.equal(got?.image, "0@snap-b", "one snapshot per thread root: the newest");
  assert.deepEqual((await store.list()).map((r) => r.image), ["0@snap-b"]);

  // Same project, same host: the oldest records beyond the cap go, with
  // their images, and the caller sees who was evicted.
  const a = await capped.record(record({ taskRootRunId: "run-a", image: "0@s1", createdAt: "2026-10-17T01:00:00Z" }));
  assert.deepEqual(a, []);
  await capped.record(record({ taskRootRunId: "run-b", image: "0@s2", createdAt: "2026-10-17T02:00:00Z" }));
  const evicted = await capped.record(record({ taskRootRunId: "run-c", image: "0@s3", createdAt: "2026-10-17T03:00:00Z" }));
  assert.deepEqual(evicted.map((r) => r.image), ["0@s1"], "oldest first");
  assert.deepEqual(discarded, ["0@s1"]);
  assert.equal(WARM_THREAD_PER_PROJECT_HOST, 5, "Decision 16's default cap");

  // Another host (or project) is a DIFFERENT budget: nothing crosses over.
  const cross = await capped.record(record({ taskRootRunId: "run-d", image: "1@s4", hostIndex: 1, createdAt: "2026-10-17T04:00:00Z" }));
  assert.deepEqual(cross, [], "host 1 has its own budget");
});

test("threadWarmForEnqueue refuses with a reason for every mismatch, and hands back the ref when valid", async () => {
  const cfg = config();
  const overrides: SandboxOverrides = { network: "allowlist" };
  const now = new Date("2026-10-17T12:00:00Z");

  assert.match(((await threadWarmForEnqueue(cfg, "run-root", "https://forge.example.com/owner/repo", overrides, now)) as { reason: string }).reason, /no snapshot/);

  await cfg.set("thread-warm:run-root", JSON.stringify(record({ createdAt: "2026-10-17T11:30:00Z" })), "thread-warm");
  assert.match(((await threadWarmForEnqueue(cfg, "run-root", "https://forge.example.com/owner/repo", overrides, new Date("2026-10-17T20:00:00Z"))) as { reason: string }).reason, /expired/);

  assert.match(
    ((await threadWarmForEnqueue(cfg, "run-root", "https://forge.example.com/owner/other", overrides, now)) as { reason: string }).reason,
    /different repository/,
  );

  assert.match(
    ((await threadWarmForEnqueue(cfg, "run-root", "https://forge.example.com/owner/repo", { network: "open" }, now)) as { reason: string }).reason,
    /sandbox shape changed/,
  );

  const ok = await threadWarmForEnqueue(cfg, "run-root", "https://forge.example.com/owner/repo.git", overrides, now);
  assert.ok("ref" in ok, "a .git suffix and a bare URL are the same repository");
  assert.deepEqual(ok.ref, { image: "0@teploy-sbx-snap:1", head: "a".repeat(40) });
});

test("the sweeper deletes expired snapshots and re-asserts the cap", async () => {
  const cfg = config();
  const store = threadWarmStore(cfg);
  await store.record(record({ taskRootRunId: "run-live", image: "0@live", createdAt: new Date().toISOString() }));
  await store.record(record({ taskRootRunId: "run-dead", image: "0@dead", createdAt: "2026-10-16T00:00:00Z" }));
  const deleted: string[] = [];
  const removed = await sweepThreadWarm(store, {
    now: () => new Date("2026-10-17T12:00:00Z"),
    ttlSec: 7200,
    discard: async (image) => { deleted.push(image); },
  });
  assert.equal(removed, 1);
  assert.deepEqual(deleted, ["0@dead"]);
  assert.deepEqual((await store.list()).map((r) => r.image), ["0@live"]);

  // Cap re-assertion (a cap lowered in config, records from older code).
  for (let i = 0; i < 3; i++) {
    await store.record(record({ taskRootRunId: `run-cap-${i}`, image: `0@cap-${i}`, createdAt: new Date(Date.now() - i * 1000).toISOString() }));
  }
  const trimmed = await sweepThreadWarm(store, { ttlSec: 3600, cap: 2, discard: async () => {} });
  assert.ok(trimmed >= 2, `the cap trims back to 2 (${trimmed} removed)`);
  assert.ok((await store.list()).length <= 3, "the live record plus the cap");
});
