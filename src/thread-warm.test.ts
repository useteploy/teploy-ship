import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentExecutor } from "@neutron-build/agents";
import { LocalExecutor } from "@neutron-build/agents";

import type { SandboxOverrides } from "./durable.js";
import { shq } from "./harness-external.js";
import {
  WARM_THREAD_DEFAULT_TTL_SEC,
  WARM_THREAD_PER_PROJECT_HOST,
  sandboxOverridesDigest,
  snapshotScanRoots,
  sweepThreadWarm,
  threadWarmForEnqueue,
  threadWarmStore,
  warmThreadEnabled,
  warmThreadTtlSec,
  workspaceCredentialReason,
  workspaceSecretValueReason,
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

test("workspaceSecretValueReason: exact values and base64 forms refuse by name; tuning values and short ones do not", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-warm-values-"));
  const ex = new LocalExecutor({ root });
  await ex.exec("git init -q -b main . && git config user.email t@t && git config user.name t");
  const key = { name: "ANTHROPIC_API_KEY", value: "sk-ant-api03-SCANTEST-0123456789" };
  assert.equal(await workspaceSecretValueReason(ex, [key], "thread snapshot"), null, "a clean tree passes");

  // The `env > x` shape: the value, verbatim, in a workspace file. The
  // refusal names the credential and a COUNT — never a filename (an agent
  // controls those) and never the value.
  await ex.exec(`printf 'ANTHROPIC_API_KEY=%s\\n' "$V" > dump.txt`, { env: { V: key.value } });
  const hit = await workspaceSecretValueReason(ex, [key], "thread snapshot");
  assert.match(hit ?? "", /credential-material-in-workspace/);
  assert.match(hit ?? "", /ANTHROPIC_API_KEY/);
  assert.ok(!((hit ?? "").includes("dump.txt")), "no filename in the refusal");
  assert.ok(!((hit ?? "").includes(key.value)), "no value in the refusal");

  // The base64 form is the same leak (an agent that encoded it first).
  await ex.exec("rm -f dump.txt && printf '%s' \"$V\" | base64 > encoded.txt", { env: { V: key.value } });
  const encoded = await workspaceSecretValueReason(ex, [key], "push");
  assert.match(encoded ?? "", /ANTHROPIC_API_KEY/);
  assert.ok(!((encoded ?? "").includes("encoded.txt")), "no filename here either");

  // A value shorter than the scrub floor matches ordinary strings; a base URL
  // is not a credential name and can be legitimate repo content.
  await ex.exec("rm -f encoded.txt");
  assert.equal(await workspaceSecretValueReason(ex, [{ name: "ANTHROPIC_API_KEY", value: "short" }], "push"), null, "below the exact-scrub floor");
  await ex.exec("printf 'https://api.z.ai/api/anthropic\\n' > config.txt");
  assert.equal(
    await workspaceSecretValueReason(ex, [{ name: "ANTHROPIC_BASE_URL", value: "https://api.z.ai/api/anthropic" }], "push"),
    null,
    "a tuning variable's value is repo content, not credential material",
  );
  // .git is not scanned: the clone's own objects never refuse a snapshot.
  await ex.exec("git add -A && git commit -qm x");
  assert.equal(await workspaceSecretValueReason(ex, [key], "thread snapshot"), null);
});

test("snapshotScanRoots: the vendor stores of the harnesses the input names, plus /tmp", () => {
  assert.deepEqual(snapshotScanRoots([]), ["/tmp"]);
  assert.deepEqual(snapshotScanRoots(["native"]), ["/tmp"], "the native loop keeps no vendor store");
  assert.deepEqual(snapshotScanRoots(["claude-code"]), ["/tmp", "$HOME/.claude"]);
  assert.deepEqual(snapshotScanRoots(["codex", "opencode"]), ["/tmp", "$HOME/.codex", "$HOME/.config/opencode", "$HOME/.local/share/opencode"]);
});

test("the push scan judges what would leave: history since base, the working diff, untracked files — not gitignored bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-warm-push-"));
  const ex = new LocalExecutor({ root });
  const key = { name: "OPENAI_API_KEY", value: "sk-oai-PUSHSCAN-3344556677" };
  const setup = async (): Promise<void> => {
    // A clone shape with origin/<base> established (setupRepoForPr's contract).
    await ex.exec("git init -q -b main . && git config user.email t@t && git config user.name t && printf 'base\\n' > b.txt && git add -A && git commit -qm base");
    await ex.exec("git update-ref refs/remotes/origin/main HEAD");
  };
  await setup();

  // Gitignored bytes never leave the sandbox and never refuse the push.
  await ex.exec("printf '.env\\nnode_modules/\\n' > .gitignore && printf 'OPENAI_API_KEY=%s\\n' \"$V\" > .env && mkdir -p node_modules/pkg && printf '%s' \"$V\" > node_modules/pkg/key", { env: { V: key.value } });
  assert.equal(await workspaceSecretValueReason(ex, [key], "push", { base: "main" }), null, "gitignored files are not scanned for the push");

  // Untracked, non-ignored files are what `git add -A` is about to commit.
  await ex.exec("printf '%s\\n' \"$V\" > untracked-dump.txt", { env: { V: key.value } });
  assert.match((await workspaceSecretValueReason(ex, [key], "push", { base: "main" })) ?? "", /OPENAI_API_KEY/);
  // The working-tree diff of a TRACKED file is scanned too.
  await ex.exec("rm -f untracked-dump.txt && printf 'base + %s\\n' \"$V\" >> b.txt", { env: { V: key.value } });
  assert.match((await workspaceSecretValueReason(ex, [key], "push", { base: "main" })) ?? "", /OPENAI_API_KEY/);

  // Add-commit-remove: the tree is clean, the HISTORY carries the value — the
  // exact shape a whole-tree scan cannot see.
  await ex.exec("git checkout -q -- .");
  await ex.exec('sh -c \'printf "%s\\n" "$V" > gone.txt && git add -A && git commit -qm add && git rm -q gone.txt && git commit -qm rm\'', { env: { V: key.value } });
  const history = await workspaceSecretValueReason(ex, [key], "push", { base: "main" });
  assert.match(history ?? "", /OPENAI_API_KEY/, "a committed-then-removed value still refuses the push");

  // The snapshot scan (no base) sees the CURRENT tree only — git history is
  // invisible to it, and gitignored bytes are NOT: those freeze into the
  // image too. .env still holds the value, so the snapshot refuses.
  assert.match((await workspaceSecretValueReason(ex, [key], "thread snapshot")) ?? "", /OPENAI_API_KEY/, "a gitignored .env refuses the snapshot: the image freezes it");
  await ex.exec("rm -f .env && rm -rf node_modules");
  assert.equal(await workspaceSecretValueReason(ex, [key], "thread snapshot"), null, "a clean tree is a clean snapshot");
  // A missing origin/<base> is a scan error, never a silent narrowing.
  assert.match((await workspaceSecretValueReason(ex, [key], "push", { base: "nosuchbranch" })) ?? "", /credential-scan-failed/);
});

test("multi-line values and placeholders: needles are the distinctive lines; blank lines never match everything", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-warm-lines-"));
  const ex = new LocalExecutor({ root });
  await ex.exec("git init -q -b main . && git config user.email t@t && git config user.name t");
  // A JSON-shaped credential (the config blob shape) with a trailing newline:
  // the trailing blank line must not become the empty pattern, and the
  // distinctive line still matches a file that carries the value verbatim.
  const multi = { name: "MY_SERVICE_TOKEN", value: '{\n  "token": "tok-multi-line-8899"\n}\n' };
  assert.equal(await workspaceSecretValueReason(ex, [multi], "thread snapshot"), null, "a clean tree with a multi-line needle set passes");
  await ex.exec("cat > note.json <<'EOF'\n{\n  \"token\": \"tok-multi-line-8899\"\n}\nEOF");
  assert.match((await workspaceSecretValueReason(ex, [multi], "thread snapshot")) ?? "", /MY_SERVICE_TOKEN/);
  await ex.exec("rm -f note.json");
  // Lines under the scrub floor are dropped, so a value of only short lines
  // has no needles and nothing to find.
  assert.equal(await workspaceSecretValueReason(ex, [{ name: "MY_SERVICE_TOKEN", value: "{\n\"a\":1\n}\n" }], "push"), null);
  // Documented local-gateway placeholders are not secrets: never needles.
  assert.equal(await workspaceSecretValueReason(ex, [{ name: "OPENAI_API_KEY", value: "sk-no-key-required" }], "push"), null);
  assert.equal(await workspaceSecretValueReason(ex, [{ name: "OPENAI_API_KEY", value: "lm-studio" }], "push"), null);
});

test("NEGATIVE CONTROL — a scan that cannot run refuses, never passes", async () => {
  const root = await mkdtemp(join(tmpdir(), "thread-warm-fail-"));
  const ex = new LocalExecutor({ root });
  const key = { name: "ANTHROPIC_API_KEY", value: "sk-ant-SCANFAIL-0123456789" };
  // Timeout: a scan that never finishes.
  const slow: AgentExecutor = {
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: true, truncated: false }),
    putFile: async () => {},
    getFile: async () => new Uint8Array(),
    destroy: async () => {},
  };
  assert.match((await workspaceSecretValueReason(slow, [key], "push")) ?? "", /credential-scan-failed.*timed out/);
  // A thrown exec (the daemon unreachable) is the same refusal.
  const broken = { exec: async () => { throw new Error("sandbox gone"); } };
  assert.match((await workspaceSecretValueReason(broken as never, [key], "push")) ?? "", /credential-scan-failed.*sandbox gone/);
  // A grep error (exit 2) is a refusal, not "no matches".
  const failing = { exec: async () => ({ exitCode: 2, stdout: "", stderr: "bad", timedOut: false, truncated: false }) };
  assert.match((await workspaceSecretValueReason(failing as never, [key], "push")) ?? "", /credential-scan-failed.*exit 2/);
  // The env carrying the needles was dropped: the shell's own guard fails the
  // scan by name (the integrity marker never arrived).
  const dropping: AgentExecutor = {
    exec: async (command: string) => await ex.exec(command, { env: {} }),
    putFile: async () => {},
    getFile: async () => new Uint8Array(),
    destroy: async () => {},
  };
  const dropped = await workspaceSecretValueReason(dropping, [key], "push");
  assert.match(dropped ?? "", /credential-scan-failed/);
  assert.ok(!(dropped ?? "").includes(key.value), "the scan-failure reason carries no value");
});

test("the snapshot scan reaches the extra roots (vendor stores, /tmp) when the input names their harness", async () => {
  const outside = await mkdtemp(join(tmpdir(), "thread-warm-roots-"));
  const root = await mkdtemp(join(tmpdir(), "thread-warm-roots-ws-"));
  const ex = new LocalExecutor({ root });
  await ex.exec("git init -q -b main . && git config user.email t@t && git config user.name t && git add -A && git commit -qm x --allow-empty");
  const key = { name: "ANTHROPIC_API_KEY", value: "sk-ant-ROOTSCAN-4567890123" };
  // A CLEAN workspace, but the vendor store outside it carries the value —
  // exactly what a whole-container snapshot would freeze.
  await ex.exec(`printf 'ANTHROPIC_API_KEY=%s\\n' "$V" > ${shq(join(outside, "session.jsonl"))}`, { env: { V: key.value } });
  assert.equal(await workspaceSecretValueReason(ex, [key], "thread snapshot"), null, "the workspace alone is clean");
  assert.match((await workspaceSecretValueReason(ex, [key], "thread snapshot", { roots: [outside] })) ?? "", /ANTHROPIC_API_KEY/);
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
