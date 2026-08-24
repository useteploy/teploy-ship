import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { LocalExecutor } from "@neutron-build/agents";

import { defaultPublishLimits, publishLimitsFromEnv, screenPublication } from "./publish-policy.js";

const run = promisify(execFile);

/** A real git repo with a staged change — the screen reads git, so fake it at that level. */
async function stagedRepo(build: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "ship-publish-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "t@t.test"], { cwd: dir });
  await run("git", ["config", "user.name", "t"], { cwd: dir });
  await writeFile(join(dir, "seed.txt"), "seed\n");
  await run("git", ["add", "-A"], { cwd: dir });
  await run("git", ["commit", "-qm", "seed"], { cwd: dir });
  await build(dir);
  await run("git", ["add", "-A"], { cwd: dir });
  return { dir, executor: new LocalExecutor({ root: dir }), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("an ordinary change passes the screen", async () => {
  const repo = await stagedRepo(async (dir) => {
    await writeFile(join(dir, "fix.js"), "export const x = 1;\n");
  });
  try {
    const screen = await screenPublication(repo.executor);
    assert.equal(screen.ok, true, screen.reasons.join("; "));
    assert.equal(screen.files, 1);
  } finally {
    await repo.cleanup();
  }
});

test("TS-043: a diff that adds a private key is refused", async () => {
  const repo = await stagedRepo(async (dir) => {
    await writeFile(
      join(dir, "fixtures.pem.txt"),
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n",
    );
  });
  try {
    const screen = await screenPublication(repo.executor);
    // A published credential cannot be un-published, so this is never a warning.
    assert.ok(screen.blocking.some((r) => /private key/.test(r)), screen.blocking.join("; "));
  } finally {
    await repo.cleanup();
  }
});

test("TS-043: forbidden paths are refused even when small", async () => {
  // Deliberately NOT .env: a global gitignore commonly excludes it, so it never
  // reaches the diff and the test would pass for the wrong reason on some
  // machines and fail on others. A key file inside the repo always stages.
  const repo = await stagedRepo(async (dir) => {
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(join(dir, "config", "id_rsa"), "not really a key\n");
  });
  try {
    const screen = await screenPublication(repo.executor);
    assert.ok(screen.blocking.some((r) => /must never be committed/.test(r)), screen.blocking.join("; "));
  } finally {
    await repo.cleanup();
  }
});

test("the forbidden list covers the paths that must never be committed", () => {
  const shouldBlock = [
    ".env",
    "app/.env.production",
    ".ssh/config",
    "deploy/keys/server.pem",
    "config/id_ed25519",
    ".aws/credentials",
    ".npmrc",
    ".teploy-agent/kernel/cell-s0.py",
    ".git/config",
  ];
  for (const path of shouldBlock) {
    assert.ok(
      defaultPublishLimits.forbidden.some((p) => p.test(path)),
      `${path} should be forbidden`,
    );
  }
  const shouldPass = ["src/env.ts", "docs/ssh.md", "lib/id_rsa_helper.ts", ".github/workflows/ci.yml"];
  for (const path of shouldPass) {
    assert.ok(
      !defaultPublishLimits.forbidden.some((p) => p.test(path)),
      `${path} should NOT be forbidden`,
    );
  }
});

test("TS-043: an oversized file-count becomes a draft, with the numbers in the reason", async () => {
  const repo = await stagedRepo(async (dir) => {
    await mkdir(join(dir, "vendor"), { recursive: true });
    for (let i = 0; i < 12; i++) await writeFile(join(dir, "vendor", `f${i}.js`), `export const a${i} = ${i};\n`);
  });
  try {
    const screen = await screenPublication(repo.executor, { ...defaultPublishLimits, maxFiles: 5 });
    // A big diff is a question for a human, not a refusal: this publishes as a
    // draft that says why. Refusing would just train the operator to raise the
    // limit until it never fires.
    assert.deepEqual(screen.blocking, [], "size alone never blocks");
    assert.ok(screen.warnings.some((r) => /touches 12 files \(usual limit 5\)/.test(r)), screen.warnings.join("; "));
  } finally {
    await repo.cleanup();
  }
});

test("TS-043: a symlink is refused — it can point outside what a reviewer reads", async () => {
  const repo = await stagedRepo(async (dir) => {
    const { symlink } = await import("node:fs/promises");
    await symlink("/etc/passwd", join(dir, "link"));
  });
  try {
    const screen = await screenPublication(repo.executor);
    assert.ok(screen.blocking.some((r) => /symlink/.test(r)), screen.blocking.join("; "));
  } finally {
    await repo.cleanup();
  }
});

test("TS-043: a binary blob is flagged for review, not refused", async () => {
  const repo = await stagedRepo(async (dir) => {
    await writeFile(join(dir, "blob.dat"), Buffer.from([0, 1, 2, 3, 0, 255, 7]));
  });
  try {
    const screen = await screenPublication(repo.executor);
    assert.deepEqual(screen.blocking, []);
    assert.ok(screen.warnings.some((r) => /binary/.test(r)), screen.warnings.join("; "));
  } finally {
    await repo.cleanup();
  }
});

test("a pre-existing secret already in the repo does not block an unrelated change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-publish-"));
  try {
    await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await run("git", ["config", "user.email", "t@t.test"], { cwd: dir });
    await run("git", ["config", "user.name", "t"], { cwd: dir });
    await writeFile(join(dir, "old.txt"), "AKIAIOSFODNN7EXAMPLE\n");
    await run("git", ["add", "-A"], { cwd: dir });
    await run("git", ["commit", "-qm", "seed"], { cwd: dir });
    await writeFile(join(dir, "new.js"), "export const ok = true;\n");
    await run("git", ["add", "-A"], { cwd: dir });

    const screen = await screenPublication(new LocalExecutor({ root: dir }));
    assert.equal(screen.ok, true, "only ADDED lines are scanned; history is not this run's doing");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("limits come from the environment with sane fallbacks", () => {
  assert.equal(publishLimitsFromEnv({ SHIP_PUBLISH_MAX_FILES: "7" }).maxFiles, 7);
  assert.equal(publishLimitsFromEnv({ SHIP_PUBLISH_MAX_FILES: "junk" }).maxFiles, defaultPublishLimits.maxFiles);
  assert.equal(publishLimitsFromEnv({ SHIP_PUBLISH_MAX_FILES: "-3" }).maxFiles, defaultPublishLimits.maxFiles);
});

test("P2-3: a diff over the HARD file cap is refused, not drafted", async () => {
  const repo = await stagedRepo(async (dir) => {
    await mkdir(join(dir, "vendor"), { recursive: true });
    for (let i = 0; i < 12; i++) await writeFile(join(dir, "vendor", `f${i}.js`), `export const a${i} = ${i};\n`);
  });
  try {
    // Soft limit 5 (draft territory), hard limit 9 (refuse): 12 files trips both.
    const screen = await screenPublication(repo.executor, { ...defaultPublishLimits, maxFiles: 5, hardMaxFiles: 9 });
    assert.ok(screen.blocking.some((r) => /touches 12 files \(hard cap 9\)/.test(r)), screen.blocking.join("; "));
    // The soft-limit warning is still there: the reviewer who raises the hard
    // cap back to nothing should still see the draft-level question.
    assert.ok(screen.warnings.some((r) => /usual limit 5/.test(r)), screen.warnings.join("; "));
  } finally {
    await repo.cleanup();
  }
});

test("P2-3: under the hard cap, size stays a question for a human", async () => {
  const repo = await stagedRepo(async (dir) => {
    await mkdir(join(dir, "vendor"), { recursive: true });
    for (let i = 0; i < 8; i++) await writeFile(join(dir, "vendor", `f${i}.js`), `export const a${i} = ${i};\n`);
  });
  try {
    // Over the soft limit (5), under the hard cap (9): draft, never refuse.
    const screen = await screenPublication(repo.executor, { ...defaultPublishLimits, maxFiles: 5, hardMaxFiles: 9 });
    assert.deepEqual(screen.blocking, [], "under the hard cap, size never blocks");
    assert.ok(screen.warnings.length > 0);
  } finally {
    await repo.cleanup();
  }
});

test("P2-3: the hard cap is opt-in — unset or junk env means no cap", () => {
  assert.equal(publishLimitsFromEnv({ SHIP_PUBLISH_HARD_MAX_FILES: "20" }).hardMaxFiles, 20);
  assert.equal(publishLimitsFromEnv({}).hardMaxFiles, undefined, "today's behaviour is unchanged until the operator opts in");
  assert.equal(publishLimitsFromEnv({ SHIP_PUBLISH_HARD_MAX_FILES: "junk" }).hardMaxFiles, undefined);
  assert.equal(publishLimitsFromEnv({ SHIP_PUBLISH_HARD_MAX_FILES: "0" }).hardMaxFiles, undefined);
});
