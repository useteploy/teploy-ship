import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
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
  workspaceSecretValueScan,
  snapshotScanCommand,
  credentialScanMode,
  snapshotCredentialGate,
  type ThreadWarmRecord,
} from "./thread-warm.js";
import { MemoryRuntimeConfig } from "./runtime-config.js";
import { baseRevision, commitAndPush, recordBaseSha, setupRepo } from "./git.js";

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
  assert.equal(warmThreadEnabled({ SHIP_WARM_THREAD: "off" } as NodeJS.ProcessEnv), false, "the feature's off value disarms it");
  assert.equal(warmThreadEnabled({ SHIP_WARM_PARKS: "off" } as NodeJS.ProcessEnv), false, "the capability's off value disarms it");
  assert.equal(warmThreadEnabled({ SHIP_WARM_THREAD: "1", SHIP_WARM_PARKS: "1" } as NodeJS.ProcessEnv), true);
  assert.equal(warmThreadEnabled({} as NodeJS.ProcessEnv), true, "both default on");
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
  assert.notEqual(sandboxOverridesDigest({ user: "root" }), sandboxOverridesDigest(undefined), "the user is part of the shape");
  // Pinned: the digest of an empty shape as recorded before `user` existed.
  // An absent user must not change it, or every stored thread-warm record
  // would stop matching its follow-ups.
  assert.equal(sandboxOverridesDigest(undefined), "0a7658429a034b7e");
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

test("snapshotScanRoots: /tmp, /var/tmp, the vendor stores of the harnesses the input names, then the bounded home leak sites", () => {
  const plain = (roots: ReturnType<typeof snapshotScanRoots>) => roots.filter((r): r is string => typeof r === "string");
  const bounded = snapshotScanRoots([]).filter((r) => typeof r !== "string").map((r) => (typeof r === "string" ? r : r.path));
  assert.deepEqual(bounded, ["$HOME", "$HOME/.config", "$HOME/.cache"]);
  assert.deepEqual(plain(snapshotScanRoots([])), ["/tmp", "/var/tmp"]);
  assert.deepEqual(plain(snapshotScanRoots(["native"])), ["/tmp", "/var/tmp"], "the native loop keeps no vendor store");
  assert.deepEqual(plain(snapshotScanRoots(["claude-code"])), ["/tmp", "/var/tmp", "$HOME/.claude"]);
  assert.deepEqual(plain(snapshotScanRoots(["codex", "opencode"])), ["/tmp", "/var/tmp", "$HOME/.codex", "$HOME/.config/opencode", "$HOME/.local/share/opencode"]);
});

test("the snapshot scan reaches $HOME dotfiles, ~/.config and ~/.cache within their bounds", async () => {
  const key = { name: "ANTHROPIC_API_KEY", value: "sk-ant-HOMEDOT-0123456789" };
  const base = await mkdtemp(join(tmpdir(), "tw-scan-tmp-"));
  const root = await mkdtemp(join(tmpdir(), "tw-homedot-ws-"));
  const home = await mkdtemp(join(tmpdir(), "tw-homedot-"));
  // The bounded home roots alone: /tmp on a dev machine holds this file.
  const roots = snapshotScanRoots([]).filter((r) => typeof r !== "string");
  const scan = async () => await workspaceSecretValueScan(scanExec(root, base, { env: { HOME: home } }), [key], "thread snapshot", { roots });
  assert.equal((await scan()).kind, "clean", "an empty home is clean");
  const sites = [
    ".npmrc",
    ".git-credentials",
    ".gitconfig",
    ".netrc",
    ".bash_history",
    ".docker/config.json",
    ".config/gh/hosts.yml",
    ".config/a/b/c/settings.json",
    ".cache/tool/run.log",
    ".cache/a/b/c.log",
  ];
  for (const site of sites) {
    await mkdir(join(home, site, ".."), { recursive: true });
    await writeFile(join(home, site), `token=${key.value}\n`);
    const out = await scan();
    assert.equal(out.kind, "material", `~/${site} is scanned`);
    await new LocalExecutor({ root: home }).exec(`rm -f ${shq(site)}`);
  }
  // Outside the bounds: too deep, too large, or a pruned bulk cache.
  const skipped = [".cache/a/b/c/deep.log", ".config/a/b/c/d/deep.json", ".cache/go-build/ab/entry", "projects/repo/src/deep.txt"];
  for (const site of skipped) {
    await mkdir(join(home, site, ".."), { recursive: true });
    await writeFile(join(home, site), `token=${key.value}\n`);
  }
  await writeFile(join(home, ".cache", "tool", "big.bin"), `${"x".repeat(300 * 1024)}${key.value}\n`);
  assert.equal((await scan()).kind, "clean", "bounded roots stop at their depth, size and prunes");
});

test("the push scan counts from the recorded base sha: moving origin/<base> (git update-ref) no longer hides a commit the push carries", async () => {
  const key = { name: "OPENAI_API_KEY", value: "sk-oai-UPDATEREF-0123456789" };
  const bare = await mkdtemp(join(tmpdir(), "tw-updref-bare-"));
  const seed = await mkdtemp(join(tmpdir(), "tw-updref-seed-"));
  await new LocalExecutor({ root: seed }).exec(
    `git init -q -b main . && git config user.email t@t && git config user.name t && echo hello > readme.md && git add -A && git commit -qm seed && git clone -q --bare . ${shq(join(bare, "repo.git"))}`,
  );
  const ref = { kind: "forgejo" as const, base: "file://", owner: "local", repo: "repo", cloneUrl: join(bare, "repo.git") };
  const work = await mkdtemp(join(tmpdir(), "tw-updref-work-"));
  const ex = new LocalExecutor({ root: work });
  const remoteMain = (await new LocalExecutor({ root: seed }).exec("git rev-parse HEAD")).stdout.trim();
  // A tampered remote-tracking ref before the checkout records its base (a
  // warm volume's .git came from an earlier agent): the sha is re-read from
  // the real remote, never trusted from the ref.
  const plain = await setupRepo(ex, { ref, token: "", runId: "run-updref" });
  await ex.exec("git commit -q --allow-empty -m tamper && git update-ref refs/remotes/origin/main HEAD && git reset -q --hard HEAD~1");
  const checkout = await recordBaseSha(ex, ref, "", plain);
  assert.equal(checkout.baseSha, remoteMain, "the recorded base is the remote's main");

  // The agent commits the value, moves origin/main onto that commit, and
  // leaves an innocuous change so the push has something to carry.
  await ex.exec(`printf '%s\\n' "$V" > leak.txt && git add -A && git commit -qm leak && git update-ref refs/remotes/origin/main HEAD && echo ok >> readme.md`, { env: { V: key.value } });
  assert.equal(await workspaceSecretValueReason(ex, [key], "push", { base: "main" }), null, "the bypass, reproduced: the ref-based range is empty of the leak");
  const trusted = await workspaceSecretValueScan(ex, [key], "push", { base: "main", ...(checkout.baseSha !== undefined ? { baseSha: checkout.baseSha } : {}) });
  assert.equal(trusted.kind, "material", "the recorded-sha range carries the leaking commit");

  // commitAndPush counts from the same sha: the push carries both commits.
  assert.equal(baseRevision(checkout), remoteMain);
  const pushed = await commitAndPush(ex, { ref, token: "", checkout, message: "x" });
  assert.equal(pushed.kind, "pushed");
  const count = await new LocalExecutor({ root: bare }).exec(`cd repo.git && git rev-list --count ${remoteMain}..ship/run-updref`);
  assert.equal(count.stdout.trim(), "2", "what the scan judged is what the push carried");
  // A malformed recorded sha is a scan failure, never a fallback.
  const bad = await workspaceSecretValueScan(ex, [key], "push", { base: "main", baseSha: "origin/main" });
  assert.equal(bad.kind, "failed");
});

test("the push scan reads past replacement refs: git replace cannot show it a clean commit in place of the one the push carries", async () => {
  const key = { name: "OPENAI_API_KEY", value: "sk-oai-REPLACEREF-0123456789" };
  const ex = new LocalExecutor({ root: await pushRepo("tw-replace-") });
  await ex.exec(
    'printf "%s\\n" "$V" > leak.txt && git add -A && git commit -qm leak && ' +
      'c=$(git commit-tree -p HEAD~1 -m clean "$(git rev-parse "HEAD~1^{tree}")") && git replace HEAD "$c"',
    { env: { V: key.value } },
  );
  assert.equal((await ex.exec("git log -p origin/main..HEAD")).stdout.includes(key.value), false, "the replacement hides the leak from a plain git log");
  assert.equal((await workspaceSecretValueScan(ex, [key], "push", { base: "main" })).kind, "material");
});

test("base64 needles match at every byte offset and with a trailing newline", async () => {
  const key = { name: "ANTHROPIC_API_KEY", value: "sk-ant-B64OFFSET-0123456789" };
  const root = await mkdtemp(join(tmpdir(), "tw-b64-"));
  const ex = new LocalExecutor({ root });
  const encodings = [
    Buffer.from(`${key.value}\n`).toString("base64"),
    Buffer.from(`A${key.value}`).toString("base64"),
    Buffer.from(`AB${key.value}`).toString("base64"),
    Buffer.from(`{"env":{"ANTHROPIC_API_KEY":"${key.value}"},"x":1}`).toString("base64"),
  ];
  for (const encoded of encodings) {
    await writeFile(join(root, "blob.txt"), `${encoded}\n`);
    assert.equal((await workspaceSecretValueScan(ex, [key], "thread snapshot")).kind, "material", encoded);
  }
  await writeFile(join(root, "blob.txt"), `${Buffer.from("sk-ant-B64OFFSET-9999999999").toString("base64")}\n`);
  assert.equal((await workspaceSecretValueScan(ex, [key], "thread snapshot")).kind, "clean", "a different value does not match");
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
  await ex.exec("git reset -q --hard HEAD");
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

// ------------------------------------------------ scan shell, executed for real

/** The literal the scan's shell walks to pick a temp base; tests swap it for a private dir. */
const SCAN_TMP_LOOP = "for t in /var/tmp /tmp;";

/**
 * A LocalExecutor that runs the REAL scan command in /bin/sh, with the scan's
 * temp base (/var/tmp, /tmp) moved to a private dir so a test can list what
 * the scan left behind, plus env overrides layered over the scan's own env.
 */
function scanExec(root: string, base: string, extra: { env?: Record<string, string>; timeoutMs?: number } = {}): AgentExecutor {
  const ex = new LocalExecutor({ root });
  return {
    exec: async (command, options = {}) => {
      if (command.includes("ship-scan.") && !command.includes(SCAN_TMP_LOOP)) throw new Error("scan temp loop not found: the test would be vacuous");
      return await ex.exec(command.split(SCAN_TMP_LOOP).join(`for t in ${shq(base)};`), {
        ...options,
        env: { ...(options.env ?? {}), ...(extra.env ?? {}) },
        ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
      });
    },
    putFile: async () => {},
    getFile: async () => new Uint8Array(),
    destroy: async () => {},
  };
}

/** A PATH dir whose `git` fails (or sleeps on) `git log` and delegates everything else to the real git. */
async function fakeGit(mode: "fail-log" | "sleep-log"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tw-fakegit-"));
  const real = (await new LocalExecutor({ root: dir }).exec("command -v git")).stdout.trim();
  const body = mode === "fail-log" ? "echo boom >&2; exit 128" : "sleep 3";
  await writeFile(join(dir, "git"), `#!/bin/sh\nif [ "$1" = log ]; then ${body}; fi\nexec ${shq(real)} "$@"\n`, { mode: 0o755 });
  return dir;
}

/** A clone shape with origin/main established (setupRepoForPr's contract). */
async function pushRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await new LocalExecutor({ root }).exec(
    "git init -q -b main . && git config user.email t@t && git config user.name t && printf 'base\\n' > b.txt && git add -A && git commit -qm base && git update-ref refs/remotes/origin/main HEAD",
  );
  return root;
}

test("B1: every scan exit path removes its decoded needle file", async () => {
  const key = { name: "ANTHROPIC_API_KEY", value: "sk-ant-NEEDLEFILE-0123456789" };
  const base = await mkdtemp(join(tmpdir(), "tw-scan-tmp-"));
  const root = await pushRepo("tw-exitpaths-");
  const left = async (label: string): Promise<void> => assert.deepEqual(await readdir(base), [], `${label}: no needle file left`);

  assert.equal((await workspaceSecretValueScan(scanExec(root, base), [key], "push", { base: "main" })).kind, "clean");
  await left("clean push");

  await writeFile(join(root, "dump.txt"), `${key.value}\n`);
  assert.equal((await workspaceSecretValueScan(scanExec(root, base), [key], "push", { base: "main" })).kind, "material");
  await left("material push");
  await new LocalExecutor({ root }).exec("git reset -q --hard HEAD && rm -f dump.txt");

  const noBase = await workspaceSecretValueScan(scanExec(root, base), [key], "push", { base: "nosuchbranch" });
  assert.equal(noBase.kind === "failed" && noBase.noBase, true, "exit 8 is the no-base failure");
  await left("exit 8 (no base)");

  const cases: Array<[string, Record<string, string>, RegExp]> = [
    ["exit 9 (needles empty)", { SHIP_NEEDLES_B64: "" }, /scan-needles-empty/],
    ["exit 10 (needles corrupt)", { SHIP_NEEDLES_B64: Buffer.from("some-other-needle-line\n").toString("base64") }, /scan-needles-corrupt/],
    ["exit 3 (needles undecodable)", { SHIP_NEEDLES_B64: "!!!" }, /scan-needles-undecodable/],
  ];
  for (const [label, env, why] of cases) {
    const out = await workspaceSecretValueScan(scanExec(root, base, { env }), [key], "push", { base: "main" });
    assert.equal(out.kind, "failed", label);
    assert.match(out.kind === "failed" ? out.reason : "", why, label);
    await left(label);
  }

  // S2 as well: a producer that fails is a scan error, not an empty stream.
  const failing = await fakeGit("fail-log");
  const producer = await workspaceSecretValueScan(scanExec(root, base, { env: { PATH: `${failing}:${process.env.PATH ?? ""}` } }), [key], "push", { base: "main" });
  assert.equal(producer.kind, "failed");
  assert.match(producer.kind === "failed" ? producer.reason : "", /exit 6: scan-producer-failed: git log/);
  await left("exit 6 (producer failed)");

  const locked = await mkdtemp(join(tmpdir(), "tw-locked-"));
  await chmod(locked, 0o000);
  try {
    const out = await workspaceSecretValueScan(scanExec(root, base), [key], "thread snapshot", { roots: [locked] });
    assert.match(out.kind === "failed" ? out.reason : "", /scan-root-unreadable/);
    await left("exit 7 (root unreadable)");
  } finally {
    await chmod(locked, 0o755);
  }

  await writeFile(join(root, "dump.txt"), `${key.value}\n`);
  assert.equal((await workspaceSecretValueScan(scanExec(root, base), [key], "thread snapshot")).kind, "material");
  await left("material snapshot");
});

test("B1: TERM runs the cleanup; a SIGKILLed scan's leftover is swept by the next scan, never frozen or matched", async () => {
  const key = { name: "ANTHROPIC_API_KEY", value: "sk-ant-KILLSWEEP-0123456789" };
  const base = await mkdtemp(join(tmpdir(), "tw-scan-tmp-"));
  const root = await pushRepo("tw-signals-");
  const sleepy = await fakeGit("sleep-log");
  const path = `${sleepy}:${process.env.PATH ?? ""}`;

  // TERM mid-scan (git log sleeping): the trap removes the dir.
  let captured = "";
  let capturedEnv: Record<string, string> = {};
  const capture: AgentExecutor = {
    exec: async (command, options = {}) => {
      captured = command.split(SCAN_TMP_LOOP).join(`for t in ${shq(base)};`);
      capturedEnv = { ...(options.env ?? {}) };
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
    },
    putFile: async () => {},
    getFile: async () => new Uint8Array(),
    destroy: async () => {},
  };
  await workspaceSecretValueScan(capture, [key], "push", { base: "main" });
  const child = spawn("/bin/sh", ["-c", captured], { cwd: root, env: { ...process.env, ...capturedEnv, PATH: path }, stdio: "ignore" });
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal((await readdir(base)).length, 1, "the scan dir exists while the scan runs");
  child.kill("SIGTERM");
  await closed;
  assert.deepEqual(await readdir(base), [], "TERM removed the needle file");

  // SIGKILL (an executor timeout) cannot be trapped: the dir is left ...
  const killed = await workspaceSecretValueScan(scanExec(root, base, { env: { PATH: path }, timeoutMs: 700 }), [key], "push", { base: "main" });
  assert.match(killed.kind === "failed" ? killed.reason : "", /timed out/);
  assert.equal((await readdir(base)).length, 1, "a SIGKILLed scan leaves its dir (the scenario under test)");
  // ... and the next scan sweeps it before scanning: with the temp base as a
  // snapshot root, the leftover needles are neither matched nor frozen.
  const next = await workspaceSecretValueScan(scanExec(root, base), [key], "thread snapshot", { roots: [base] });
  assert.equal(next.kind, "clean", JSON.stringify(next));
  assert.deepEqual(await readdir(base), [], "swept");
});

test("B2: a vendor store under the container's own $HOME is scanned; unreadable or homeless is a scan error", async () => {
  const key = { name: "ANTHROPIC_API_KEY", value: "sk-ant-HOMESTORE-0123456789" };
  const base = await mkdtemp(join(tmpdir(), "tw-scan-tmp-"));
  const root = await mkdtemp(join(tmpdir(), "tw-home-ws-"));
  const home = join(await mkdtemp(join(tmpdir(), "tw-home-")), "a home with spaces");
  await mkdir(join(home, ".claude", "projects"), { recursive: true });
  const env = { HOME: home };
  assert.equal((await workspaceSecretValueScan(scanExec(root, base, { env }), [key], "thread snapshot", { roots: ["$HOME/.claude"] })).kind, "clean");
  await writeFile(join(home, ".claude", "projects", "session.jsonl"), `{"env":"ANTHROPIC_API_KEY=${key.value}"}\n`);
  const hit = await workspaceSecretValueScan(scanExec(root, base, { env }), [key], "thread snapshot", { roots: ["$HOME/.claude"] });
  assert.equal(hit.kind, "material", "the store under the exec's own HOME refuses the snapshot");
  assert.match(hit.kind === "material" ? hit.reason : "", /ANTHROPIC_API_KEY/);

  await chmod(join(home, ".claude"), 0o000);
  try {
    const locked = await workspaceSecretValueScan(scanExec(root, base, { env }), [key], "thread snapshot", { roots: ["$HOME/.claude"] });
    assert.match(locked.kind === "failed" ? locked.reason : "", /scan-root-unreadable/, "an existing-but-unreadable store is a scan error");
  } finally {
    await chmod(join(home, ".claude"), 0o755);
  }
  const homeless = await workspaceSecretValueScan(scanExec(root, base, { env: { HOME: "" } }), [key], "thread snapshot", { roots: ["$HOME/.claude"] });
  assert.match(homeless.kind === "failed" ? homeless.reason : "", /scan-no-home/);
  // Only a plain suffix may ride after the unquoted "$HOME".
  assert.throws(() => snapshotScanCommand(["$HOME/$(id)"]), /invalid scan root suffix/);
});

test("S4: the snapshot scan reads regular files only — a FIFO cannot hang it, links below the root are not followed — and an unreadable subtree fails it", async () => {
  const key = { name: "OPENAI_API_KEY", value: "sk-oai-FIFOSCAN-0123456789" };
  const base = await mkdtemp(join(tmpdir(), "tw-scan-tmp-"));
  const root = await mkdtemp(join(tmpdir(), "tw-fifo-ws-"));
  const outside = await mkdtemp(join(tmpdir(), "tw-fifo-out-"));
  await writeFile(join(outside, "elsewhere.txt"), `${key.value}\n`);
  await new LocalExecutor({ root }).exec(`mkfifo pipe && ln -s ${shq(join(outside, "elsewhere.txt"))} link`);
  const deadline = new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 20_000).unref());
  const out = await Promise.race([workspaceSecretValueScan(scanExec(root, base), [key], "thread snapshot"), deadline]);
  assert.notEqual(out, "hung", "a FIFO in the tree must not hang the scan");
  assert.equal(out !== "hung" && out.kind, "clean", "the FIFO is skipped and the symlink is not followed");
  assert.ok(!snapshotScanCommand([]).includes("--exclude"), "no GNU-only grep flags (BusyBox images run this)");

  await mkdir(join(root, "sub"));
  await chmod(join(root, "sub"), 0o000);
  try {
    const failed = await workspaceSecretValueScan(scanExec(root, base), [key], "thread snapshot");
    assert.match(failed.kind === "failed" ? failed.reason : "", /scan-walk-failed/, "an unreadable subtree is a scan error, not a clean tree");
  } finally {
    await chmod(join(root, "sub"), 0o755);
  }
});

test("S3: the push scan judges the staged tree — links ship as links, FIFOs are not read, filenames are in scope", async () => {
  const key = { name: "OPENAI_API_KEY", value: "sk-oai-STAGEDSCAN-0123456789" };
  const base = await mkdtemp(join(tmpdir(), "tw-scan-tmp-"));
  const root = await pushRepo("tw-staged-");
  const outside = await mkdtemp(join(tmpdir(), "tw-staged-out-"));
  await writeFile(join(outside, "elsewhere.txt"), `${key.value}\n`);
  const ex = new LocalExecutor({ root });
  await ex.exec(`mkfifo pipe && ln -s ${shq(join(outside, "elsewhere.txt"))} link`);
  const deadline = new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 20_000).unref());
  const out = await Promise.race([workspaceSecretValueScan(scanExec(root, base), [key], "push", { base: "main" }), deadline]);
  assert.notEqual(out, "hung", "an untracked FIFO must not hang the push scan");
  assert.equal(out !== "hung" && out.kind, "clean", "a symlink ships as its target PATH, so the bytes behind it are not what ships");
  // A filename is part of what ships: the diff header carries it.
  await ex.exec("rm -f pipe link && git reset -q --hard HEAD");
  await writeFile(join(root, `${key.value}.txt`), "innocent\n");
  const named = await workspaceSecretValueScan(scanExec(root, base), [key], "push", { base: "main" });
  assert.equal(named.kind, "material", "a value in a filename refuses the push");
});

test("SHIP_CREDENTIAL_SCAN: on by default and for junk; warn proceeds with the finding recorded; off skips the scan", async () => {
  assert.equal(credentialScanMode({}), "on");
  assert.equal(credentialScanMode({ SHIP_CREDENTIAL_SCAN: "of" }), "on", "a typo never switches the gate off");
  assert.equal(credentialScanMode({ SHIP_CREDENTIAL_SCAN: " WARN " }), "warn");
  assert.equal(credentialScanMode({ SHIP_CREDENTIAL_SCAN: "off" }), "off");
  const key = { name: "ANTHROPIC_API_KEY", value: "sk-ant-KILLSWITCH-0123456789" };
  const base = await mkdtemp(join(tmpdir(), "tw-scan-tmp-"));
  const root = await mkdtemp(join(tmpdir(), "tw-switch-"));
  await writeFile(join(root, "dump.txt"), `${key.value}\n`);
  const ex = scanExec(root, base);
  const logged: string[] = [];
  const on = await snapshotCredentialGate(ex, [key], "thread snapshot", [], (l) => logged.push(l), "on");
  assert.match("refuse" in on ? on.refuse : "", /credential-material-in-workspace/);
  const warn = await snapshotCredentialGate(ex, [key], "thread snapshot", [], (l) => logged.push(l), "warn");
  assert.ok(!("refuse" in warn), "warn proceeds");
  assert.match("warning" in warn ? (warn.warning ?? "") : "", /credential-material-in-workspace/, "the would-be refusal is returned for the step to record");
  assert.equal(logged.length, 1);
  assert.ok(!logged[0]!.includes(key.value));
  let calls = 0;
  const counting: AgentExecutor = { ...ex, exec: async (c, o) => { calls++; return await ex.exec(c, o); } };
  assert.deepEqual(await snapshotCredentialGate(counting, [key], "thread snapshot", [], () => {}, "off"), {});
  assert.equal(calls, 0, "off never runs the scan");
});

test("a failed snapshot scan sweeps the needle files before any image; an unconfirmed sweep refuses even in warn mode", async () => {
  const key = { name: "ANTHROPIC_API_KEY", value: "sk-ant-WARNSWEEP-0123456789" };
  const base = await mkdtemp(join(tmpdir(), "tw-scan-tmp-"));
  const root = await mkdtemp(join(tmpdir(), "tw-warnsweep-"));
  const real = scanExec(root, base);
  // The scan "times out" after leaving its needle dir behind (a SIGKILL
  // skips the EXIT trap); every other exec runs for real.
  const commands: string[] = [];
  const killedScan = (sweep: "real" | "fails"): AgentExecutor => ({
    ...real,
    exec: async (command, options) => {
      commands.push(command);
      if (command.includes("SHIP_NEEDLES_B64")) {
        await mkdir(join(base, "ship-scan.KILLED"), { recursive: true });
        await writeFile(join(base, "ship-scan.KILLED", "needles"), `${key.value}\n`);
        return { exitCode: 0, stdout: "", stderr: "", timedOut: true, truncated: false };
      }
      if (sweep === "fails") return { exitCode: 1, stdout: "", stderr: "", timedOut: false, truncated: false };
      return await real.exec(command, options);
    },
  });
  const warn = await snapshotCredentialGate(killedScan("real"), [key], "thread snapshot", [], () => {}, "warn");
  assert.ok(!("refuse" in warn), "a confirmed sweep lets warn proceed");
  assert.match("warning" in warn ? (warn.warning ?? "") : "", /credential-scan-failed.*timed out/);
  assert.deepEqual(await readdir(base), [], "the needle dir was swept before the gate returned");
  assert.equal(commands.length, 2, "the sweep is its own exec");

  const unconfirmed = await snapshotCredentialGate(killedScan("fails"), [key], "thread snapshot", [], () => {}, "warn");
  assert.match("refuse" in unconfirmed ? unconfirmed.refuse : "", /could not be confirmed removed/, "warn refuses when the sweep is unconfirmed");
  const thrown: AgentExecutor = { ...real, exec: async (command) => { if (command.includes("SHIP_NEEDLES_B64")) return { exitCode: 0, stdout: "", stderr: "", timedOut: true, truncated: false }; throw new Error("gone"); } };
  assert.ok("refuse" in (await snapshotCredentialGate(thrown, [key], "thread snapshot", [], () => {}, "warn")), "a thrown sweep is unconfirmed");
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
