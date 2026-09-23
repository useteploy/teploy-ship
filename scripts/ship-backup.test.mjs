import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "ship-backup.sh");

/**
 * ship-backup.sh guards the only copy of Ship's history, so its refusals are
 * as much the product as its happy path: a backup taken over a running store
 * is silently corrupt, and a restore onto the live store is the one mistake
 * there is no undo for. These tests pin both directions against a FAKE ship
 * root — they never touch /deployments, never start docker, and stub docker
 * where a refusal depends on it seeing a running container. The rehearsal's
 * docker path needs a real engine and belongs to the operator's live pass,
 * not to CI: it is only asserted to refuse cleanly when docker is absent.
 */
function run(args, env = {}) {
  return spawnSync("bash", [script, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
}

function makeFakeRoot() {
  const dir = mkdtempSync(join(tmpdir(), "ship-backup-test-"));
  const data = join(dir, "accessories", "nucleus", "nucleus-data");
  mkdirSync(join(data, "deep"), { recursive: true });
  writeFileSync(join(data, "runs.log"), "run-1 completed\nrun-2 failed\n");
  writeFileSync(join(data, "deep", "wal.json"), '{"wal":"v2"}');
  return { dir, data };
}

function onlyArchive(backupDir) {
  const found = readdirSync(backupDir).filter((d) => !d.startsWith("rehearsals"));
  assert.equal(found.length, 1, `expected exactly one backup dir, saw ${found.join(",")}`);
  return join(backupDir, found[0], "nucleus-data-full.tgz");
}

test("backup produces archive, sha256 sidecar and manifest", () => {
  const { dir } = makeFakeRoot();
  try {
    const res = run(["backup", "--label", "proof"], { SHIP_ROOT: dir });
    assert.equal(res.status, 0, res.stderr);
    const archive = onlyArchive(join(dir, "_backups"));
    assert.ok(existsSync(`${archive}.sha256`), "no .sha256 sidecar next to the archive");
    const manifestPath = join(dirname(archive), "manifest.txt");
    assert.ok(existsSync(manifestPath), "no manifest next to the archive");
    const manifest = readFileSync(manifestPath, "utf8");
    assert.match(manifest, /script version \d+\.\d+\.\d+/);
    assert.match(manifest, /^date: \S+/m);
    assert.match(manifest, /^hostname: \S+/m);
    assert.match(manifest, /^bytes: \d+/m);
    assert.match(manifest, /^sha256: [0-9a-f]{64}/m);
    const digest = spawnSync("shasum", ["-a", "256", archive], { encoding: "utf8" }).stdout.split(" ")[0];
    assert.match(manifest, new RegExp(`^sha256: ${digest}$`, "m"), "manifest sha256 must be the archive's actual digest");
    const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" }).stdout;
    assert.match(listing, /^nucleus-data\/runs\.log$/m, "archive must root at nucleus-data/, not tar-bomb its target");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify passes a good archive and fails a corrupted one", () => {
  const { dir } = makeFakeRoot();
  try {
    assert.equal(run(["backup", "--label", "proof"], { SHIP_ROOT: dir }).status, 0);
    const archive = onlyArchive(join(dir, "_backups"));
    assert.equal(run(["verify", archive], { SHIP_ROOT: dir }).status, 0, "good archive must verify");

    // A copy with one flipped byte: the sidecar travels with it (it names the
    // basename), so the checksum — not just gzip -t — is what must catch this.
    const corruptedDir = join(dir, "corrupted");
    mkdirSync(corruptedDir);
    const corrupted = join(corruptedDir, "nucleus-data-full.tgz");
    copyFileSync(archive, corrupted);
    copyFileSync(`${archive}.sha256`, `${corrupted}.sha256`);
    const bytes = readFileSync(corrupted);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(corrupted, bytes);
    const bad = run(["verify", corrupted], { SHIP_ROOT: dir });
    assert.notEqual(bad.status, 0, "a corrupted archive must fail verify");
    assert.match(bad.stderr, /checksum mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore round-trips sentinels into an empty isolated dir", () => {
  const { dir } = makeFakeRoot();
  try {
    assert.equal(run(["backup", "--label", "proof"], { SHIP_ROOT: dir }).status, 0);
    const archive = onlyArchive(join(dir, "_backups"));
    const into = join(dir, "isolated-restore");
    const res = run(["restore", archive, "--into", into], { SHIP_ROOT: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(join(into, "nucleus-data", "runs.log"), "utf8"), "run-1 completed\nrun-2 failed\n");
    assert.equal(readFileSync(join(into, "nucleus-data", "deep", "wal.json"), "utf8"), '{"wal":"v2"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore refuses a non-empty target", () => {
  const { dir } = makeFakeRoot();
  try {
    assert.equal(run(["backup", "--label", "proof"], { SHIP_ROOT: dir }).status, 0);
    const archive = onlyArchive(join(dir, "_backups"));
    const into = join(dir, "not-empty");
    mkdirSync(into);
    writeFileSync(join(into, "keepme"), "pre-existing");
    const res = run(["restore", archive, "--into", into], { SHIP_ROOT: dir });
    assert.notEqual(res.status, 0, "restore into a non-empty dir must refuse");
    assert.match(res.stderr, /not empty/);
    assert.deepEqual(readdirSync(into), ["keepme"], "the refused restore must have written nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore refuses the live store directory even when it is empty", () => {
  // The live guard has to fire BEFORE the non-empty check can mask it, so the
  // live dir here is empty — exactly the shape a half-finished recovery or a
  // wiped volume would present.
  const { dir } = makeFakeRoot();
  try {
    assert.equal(run(["backup", "--label", "proof"], { SHIP_ROOT: dir }).status, 0);
    const archive = onlyArchive(join(dir, "_backups"));
    const emptyLive = mkdtempSync(join(tmpdir(), "ship-backup-live-"));
    mkdirSync(join(emptyLive, "accessories", "nucleus", "nucleus-data"), { recursive: true });
    try {
      const res = run(["restore", archive, "--into", join(emptyLive, "accessories", "nucleus", "nucleus-data")], { SHIP_ROOT: emptyLive });
      assert.notEqual(res.status, 0, "restore onto the live store must refuse");
      assert.match(res.stderr, /live store/);
      assert.deepEqual(readdirSync(join(emptyLive, "accessories", "nucleus", "nucleus-data")), [], "the live dir must be untouched");
    } finally {
      rmSync(emptyLive, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backup --dry-run prints the plan and touches nothing", () => {
  const { dir } = makeFakeRoot();
  try {
    const res = run(["backup", "--label", "proof", "--dry-run"], { SHIP_ROOT: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /dry-run: would create/);
    assert.match(res.stdout, /nucleus-data-full\.tgz/);
    assert.ok(!existsSync(join(dir, "_backups")), "dry-run must not create the backup dir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backup refuses while ship containers run, and --i-stopped-writers is the attestation", () => {
  // docker is stubbed: the refusal must not depend on a real engine being up
  // in CI, and neither must the manifest's advisory container record.
  const { dir } = makeFakeRoot();
  const binDir = mkdtempSync(join(tmpdir(), "ship-backup-bin-"));
  try {
    const stub = join(binDir, "docker");
    writeFileSync(
      stub,
      '#!/bin/sh\nprintf "ship-web-1a2b3c\\tnexus/ship:v9\\tcid1\\nship-worker-4d5e6f\\tnexus/ship:v9\\tcid2\\nship-nucleus-7g8h9i\\tneutron-build/nucleus:v1.1.1\\tcid3\\n"\n',
    );
    chmodSync(stub, 0o755);
    const env = { SHIP_ROOT: dir, PATH: `${binDir}:${process.env.PATH}` };

    const refused = run(["backup", "--label", "proof"], env);
    assert.notEqual(refused.status, 0, "backup with running writers must refuse");
    assert.match(refused.stderr, /docker stop ship-web-1a2b3c ship-worker-4d5e6f ship-nucleus-7g8h9i/, "must print the exact coordinated stop it expects");
    assert.ok(!existsSync(join(dir, "_backups")), "the refused backup must have written nothing");

    const attested = run(["backup", "--label", "proof", "--i-stopped-writers"], env);
    assert.equal(attested.status, 0, attested.stderr);
    const archive = onlyArchive(join(dir, "_backups"));
    const manifest = readFileSync(join(dirname(archive), "manifest.txt"), "utf8");
    assert.match(manifest, /ship-worker-4d5e6f\s+nexus\/ship:v9\s+cid2/, "manifest records the containers docker saw");
    assert.match(manifest, /ship-nucleus-7g8h9i\s+neutron-build\/nucleus:v1\.1\.1/, "manifest records the engine image rollback needs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("rehearse refuses cleanly when docker is absent (docker-dependent paths are skipped, not faked)", (t) => {
  if (spawnSync("bash", ["-c", "command -v docker"]).status === 0) {
    t.skip("docker present on this machine — the live rehearsal belongs to the operator's proof pass");
    return;
  }
  const { dir } = makeFakeRoot();
  try {
    assert.equal(run(["backup", "--label", "proof"], { SHIP_ROOT: dir }).status, 0);
    const archive = onlyArchive(join(dir, "_backups"));
    const res = run(["rehearse", archive], { SHIP_ROOT: dir });
    assert.notEqual(res.status, 0, "rehearse without docker must refuse rather than fake a proof");
    assert.match(res.stderr, /docker/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
