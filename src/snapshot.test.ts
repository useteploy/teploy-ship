import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ARCHIVE_NAME,
  NUCLEUS_DATA_REL,
  SnapshotRefusal,
  latestBackupReceipt,
  produceSnapshot,
  runRestoreCheck,
  verifyArchive,
} from "./snapshot.js";
import type { ShipContainerLine, SnapshotDocker } from "./snapshot.js";

/**
 * The snapshot producer guards the only copy of Ship's history, so its
 * refusals are the product. Every test runs against a FAKE ship root in a
 * temp dir and an injected docker — nothing here needs a live engine, a real
 * docker socket, or /deployments. tar itself is real (the same binary the
 * script and the producer shell out to).
 */

const NOW = new Date(2026, 9, 4, 12, 0, 0);
const STAMP = "2026-10-04";

const RUNNING: ShipContainerLine[] = [
  { name: "ship-web-1a2b3c", image: "nexus/ship:v9", id: "cid1" },
  { name: "ship-worker-4d5e6f", image: "nexus/ship:v9", id: "cid2" },
  { name: "ship-nucleus-7g8h9i", image: "neutron-build/nucleus:v1.1.1", id: "cid3" },
];

function docker(over: { running?: ShipContainerLine[] | undefined; known?: ShipContainerLine[] | undefined } = {}): SnapshotDocker {
  return {
    running: async () => ("running" in over ? over.running : []),
    known: async () => ("known" in over ? over.known : []),
  };
}

function fakeShipRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "ship-snapshot-test-"));
  const data = join(dir, NUCLEUS_DATA_REL);
  mkdirSync(join(data, "deep"), { recursive: true });
  writeFileSync(join(data, "runs.log"), "run-1 completed\nrun-2 failed\n");
  writeFileSync(join(data, "deep", "wal.json"), '{"wal":"v2"}');
  return dir;
}

const digestOf = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

function onlyArchiveDir(backupDir: string): string {
  const found = readdirSync(backupDir).filter((d) => d !== "rehearsals");
  assert.equal(found.length, 1, `expected exactly one backup dir, saw ${found.join(",")}`);
  return join(backupDir, found[0]!);
}

async function produce(root: string, over: Omit<Partial<Parameters<typeof produceSnapshot>[0]>, "shipRoot"> = {}) {
  return produceSnapshot({ shipRoot: root, label: "proof", now: () => NOW, docker: docker(), ...over });
}

test("produces the script's archive shape: tar + sha256 sidecar + manifest", async () => {
  const root = fakeShipRoot();
  try {
    const result = await produce(root);
    assert.equal(result.status, "produced");
    const dest = join(root, "_backups", `proof-${STAMP}`);
    assert.equal(result.dir, dest);
    const archive = join(dest, ARCHIVE_NAME);
    assert.ok(existsSync(archive), "no archive");
    assert.equal(result.sha256, digestOf(archive), "reported digest is the archive's actual digest");
    assert.equal(readFileSync(`${archive}.sha256`, "utf8"), `${digestOf(archive)}  ${ARCHIVE_NAME}\n`, "sidecar is sha256sum format");
    const manifest = readFileSync(join(dest, "manifest.txt"), "utf8");
    assert.match(manifest, /^ship-backup manifest \(teploy-ship snapshot version \d+\.\d+\.\d+\)/m);
    assert.match(manifest, /^date: \S+/m);
    assert.match(manifest, /^hostname: \S+/m);
    assert.match(manifest, /^bytes: \d+/m);
    assert.match(manifest, new RegExp(`^sha256: ${digestOf(archive)}$`, "m"), "manifest sha256 is the archive's actual digest");
    assert.match(manifest, /none found/, "writer check answered and found none");
    // Roots at nucleus-data/, exactly like the script — a restore must not
    // tar-bomb its target.
    const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" }).stdout;
    assert.match(listing, /^nucleus-data\/runs\.log$/m);
    assert.match(listing, /^nucleus-data\/deep\/wal\.json$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NEGATIVE CONTROL: refuses while ship containers run, names the exact stop, writes nothing", async () => {
  const root = fakeShipRoot();
  try {
    await assert.rejects(
      produce(root, { docker: docker({ running: RUNNING, known: RUNNING }) }),
      (error: unknown) => {
        assert.ok(error instanceof SnapshotRefusal);
        assert.match(error.message, /ship containers are still running/);
        assert.match(error.message, /docker stop ship-web-1a2b3c ship-worker-4d5e6f ship-nucleus-7g8h9i/, "must print the exact coordinated stop");
        assert.match(error.message, /--i-stopped-writers/);
        return true;
      },
    );
    assert.ok(!existsSync(join(root, "_backups")), "the refused snapshot must have written nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--i-stopped-writers attests past the refusal and the manifest records what docker knew", async () => {
  const root = fakeShipRoot();
  try {
    const result = await produce(root, { attested: true, docker: docker({ running: RUNNING, known: RUNNING }) });
    assert.equal(result.status, "produced");
    const manifest = readFileSync(join(result.dir, "manifest.txt"), "utf8");
    assert.match(manifest, /ship-worker-4d5e6f\s+nexus\/ship:v9\s+cid2/, "manifest records the running containers");
    assert.match(manifest, /ship-nucleus-7g8h9i\s+neutron-build\/nucleus:v1\.1\.1/, "manifest records the engine image rollback needs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docker unavailable is advisory, not a refusal — a box without docker can still snapshot", async () => {
  const root = fakeShipRoot();
  try {
    const result = await produce(root, { docker: { running: async () => undefined, known: async () => undefined } });
    assert.equal(result.status, "produced");
    assert.ok(result.advisory.some((a) => /writer check skipped \(advisory\)/.test(a)), "the advisory is reported");
    const manifest = readFileSync(join(result.dir, "manifest.txt"), "utf8");
    assert.match(manifest, /docker unavailable — not checked \(advisory\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NEGATIVE CONTROL: never overwrites — a second snapshot of the same label+date refuses, original untouched", async () => {
  const root = fakeShipRoot();
  try {
    const first = await produce(root);
    const before = readFileSync(first.archive);
    await assert.rejects(produce(root), (error: unknown) => {
      assert.ok(error instanceof SnapshotRefusal);
      assert.match(error.message, /refusing to overwrite existing backup dir/);
      return true;
    });
    assert.deepEqual(readFileSync(first.archive), before, "the existing backup's bytes are unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dry-run prints a plan and writes nothing", async () => {
  const root = fakeShipRoot();
  try {
    const result = await produce(root, { dryRun: true });
    assert.equal(result.status, "dry-run");
    assert.equal(result.dir, join(root, "_backups", `proof-${STAMP}`));
    assert.ok(!existsSync(join(root, "_backups")), "dry-run must not create the backup dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing engine data dir and a bad label are refusals", async () => {
  const empty = mkdtempSync(join(tmpdir(), "ship-snapshot-empty-"));
  try {
    await assert.rejects(produce(empty), /engine data dir not found/);
    const root = fakeShipRoot();
    try {
      await assert.rejects(produce(root, { label: "../evil" }), /label must start alphanumeric/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("a failed production removes only its own partial output, never the source store", async () => {
  const root = fakeShipRoot();
  try {
    await assert.rejects(
      produce(root, {
        runTar: async () => {
          throw new Error("tar exploded");
        },
      }),
      /tar exploded/,
    );
    assert.ok(!existsSync(join(root, "_backups", `proof-${STAMP}`)), "the failed run's partial dir is gone");
    assert.ok(existsSync(join(root, NUCLEUS_DATA_REL, "runs.log")), "the live store is untouched");
    // The slot is free again after the failure — the never-overwrite rule must
    // not be wedged by output nobody completed.
    const retry = await produce(root);
    assert.equal(retry.status, "produced");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// verifyArchive / restore-check
// ---------------------------------------------------------------------------

test("verifyArchive passes a produced archive; tampered sidecar, wrong-name sidecar and missing sidecar each fail", async () => {
  const root = fakeShipRoot();
  try {
    const result = await produce(root);
    const archive = result.archive;
    assert.deepEqual(await verifyArchive(archive), { ok: true, sha256: result.sha256 });

    // Copies keep the canonical basename (a sidecar must travel with its
    // archive under the name it records), so each lives in its own subdir.
    const tamperedDir = join(root, "tampered");
    mkdirSync(tamperedDir);
    const tampered = join(tamperedDir, ARCHIVE_NAME);
    copyFileSync(archive, tampered);
    writeFileSync(`${tampered}.sha256`, `0000000000000000000000000000000000000000000000000000000000000000  ${ARCHIVE_NAME}\n`);
    const bad = await verifyArchive(tampered);
    assert.ok(!bad.ok && /checksum mismatch/.test(bad.reason ?? ""), bad.ok ? "" : (bad.reason ?? ""));

    const renamed = join(root, "renamed.tgz");
    copyFileSync(archive, renamed);
    copyFileSync(`${archive}.sha256`, `${renamed}.sha256`);
    const wrongName = await verifyArchive(renamed);
    assert.ok(!wrongName.ok && /sidecar names/.test(wrongName.reason ?? ""));

    const naked = join(root, "naked.tgz");
    copyFileSync(archive, naked);
    const noSidecar = await verifyArchive(naked);
    assert.ok(!noSidecar.ok && /missing checksum sidecar/.test(noSidecar.reason ?? ""));

    const ghost = await verifyArchive(join(root, "ghost.tgz"));
    assert.ok(!ghost.ok && /no such archive/.test(ghost.reason ?? ""));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NEGATIVE CONTROL: a truncated archive with a re-computed sidecar fails gzip integrity — the checksum alone cannot catch it", async () => {
  const root = fakeShipRoot();
  try {
    const result = await produce(root);
    const truncatedDir = join(root, "truncated");
    mkdirSync(truncatedDir);
    const truncated = join(truncatedDir, ARCHIVE_NAME);
    copyFileSync(result.archive, truncated);
    truncateSync(truncated, Math.floor(statSync(truncated).size / 2));
    const digest = digestOf(truncated);
    writeFileSync(`${truncated}.sha256`, `${digest}  ${ARCHIVE_NAME}\n`);

    const verified = await verifyArchive(truncated);
    assert.ok(!verified.ok && /gzip integrity failure/.test(verified.reason ?? ""), "gzip must catch what the checksum cannot");

    const report = await runRestoreCheck(truncated);
    assert.equal(report.verdict, "not-verified");
    assert.equal(report.sha256.status, "pass", "the re-computed sidecar does its job");
    assert.equal(report.gzip.status, "fail");
    assert.equal(report.contents.status, "unknown", "contents are not checked past a failed integrity check");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore-check verifies a produced archive without unpacking and names what it does not prove", async () => {
  const root = fakeShipRoot();
  try {
    const result = await produce(root);
    const report = await runRestoreCheck(result.archive);
    assert.equal(report.verdict, "verified");
    assert.equal(report.sha256.status, "pass");
    assert.equal(report.gzip.status, "pass");
    assert.equal(report.contents.status, "pass");
    assert.ok(report.contents.entries >= 2);
    assert.deepEqual(report.contents.roots, ["nucleus-data"]);
    assert.match(report.notProven, /rehearse/, "the rehearsal is named as the restore proof");
    // Nothing was unpacked: only the backup dir exists under the root.
    assert.deepEqual(readdirSync(join(root, "_backups")).filter((d) => d !== "rehearsals"), [`proof-${STAMP}`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NEGATIVE CONTROL: listing entries that would escape the unpack target fail the contents check", async () => {
  const root = fakeShipRoot();
  try {
    const result = await produce(root);
    const report = await runRestoreCheck(result.archive, {
      listArchive: async () => ["nucleus-data/runs.log", "../evil.sh", "/etc/passwd"],
    });
    assert.equal(report.verdict, "not-verified");
    assert.equal(report.sha256.status, "pass");
    assert.equal(report.gzip.status, "pass");
    assert.equal(report.contents.status, "fail");
    assert.match(report.contents.detail, /\.\.\/evil\.sh/);
    assert.match(report.contents.detail, /\/etc\/passwd/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// the support-bundle receipt
// ---------------------------------------------------------------------------

test("latestBackupReceipt picks the newest manifest, skips rehearsals, and is bounded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-receipt-test-"));
  try {
    assert.equal(await latestBackupReceipt(dir), undefined, "empty backup dir has no receipt");

    mkdirSync(join(dir, "older-2026-10-01"));
    writeFileSync(join(dir, "older-2026-10-01", "manifest.txt"), "ship-backup manifest (script version 1.0.0)\ndate: older\n");
    mkdirSync(join(dir, "newer-2026-10-04"));
    writeFileSync(join(dir, "newer-2026-10-04", "manifest.txt"), "ship-backup manifest (script version 1.0.0)\ndate: newer\n");
    mkdirSync(join(dir, "rehearsals", "rehearse-1"), { recursive: true });
    writeFileSync(join(dir, "rehearsals", "rehearse-1", "manifest.txt"), "not a backup\n");
    mkdirSync(join(dir, "not-a-backup"));
    const t0 = new Date(2026, 9, 1);
    utimesSync(join(dir, "older-2026-10-01", "manifest.txt"), t0, t0);

    const receipt = await latestBackupReceipt(dir);
    assert.ok(receipt !== undefined);
    assert.equal(receipt.name, "newer-2026-10-04");
    assert.equal(receipt.backupDir, dir);
    assert.match(receipt.text, /date: newer/);
    assert.ok(!receipt.text.includes("rehearse"), "the rehearsal dir is not the receipt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
