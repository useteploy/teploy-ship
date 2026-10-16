import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createServer } from "node:net";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "ship-backup.sh");

/**
 * ship-backup.sh guards the only copy of Ship's history, so its refusals are
 * as much the product as its happy path: a backup taken over a running store
 * is silently corrupt, and a restore onto the live store is the one mistake
 * there is no undo for. These tests pin both directions against a FAKE ship
 * root — they never touch /deployments, never start docker, and stub docker
 * where a refusal depends on it seeing a running container. The rehearsal's
 * data recovery needs a real engine and belongs to the operator's live pass.
 * A separate fake checks readiness ordering, without claiming a restore proof.
 *
 * The postgres store (A0) is the exception: one real-path test starts a
 * throwaway pgvector container (never anything named like ship's own) when
 * docker is reachable and the image is already local — CI without the image
 * skips it, and the fake-docker tests pin the same commands without it.
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

test("an open Docker proxy port cannot start preflight before SQL is ready", async (t) => {
  const proxy = createServer((socket) => socket.destroy());
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => proxy.close());
  const { dir } = makeFakeRoot();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(run(["backup", "--label", "proof", "--i-stopped-writers"], { SHIP_ROOT: dir }).status, 0);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), `#!/bin/sh
case "$1" in
  ps|rm) exit 0 ;;
  run) echo proof-container ;;
  port) echo 127.0.0.1:${proxy.address().port} ;;
  exec)
    case "$*" in *"SELECT 1"*) ;; *) exit 10 ;; esac
    count=0
    [ ! -f "$SQL_PROBE_COUNT" ] || count=$(cat "$SQL_PROBE_COUNT")
    count=$((count + 1))
    echo "$count" > "$SQL_PROBE_COUNT"
    [ "$count" -ge 2 ] ;;
  *) exit 1 ;;
esac
`);
  writeFileSync(join(bin, "ship-proof"), `#!/bin/sh
count=0
[ ! -f "$SQL_PROBE_COUNT" ] || count=$(cat "$SQL_PROBE_COUNT")
[ "$count" -ge 2 ] || { echo 'preflight ran before SQL readiness' >&2; exit 42; }
echo preflight-after-sql > "$PREFLIGHT_RECEIPT"
`);
  chmodSync(join(bin, "docker"), 0o755);
  chmodSync(join(bin, "ship-proof"), 0o755);
  const receipt = join(dir, "preflight.txt");
  const res = run(["rehearse", onlyArchive(join(dir, "_backups")), "--image", "fixture-engine"], {
    SHIP_ROOT: dir, SHIP_BIN: join(bin, "ship-proof"), PATH: `${bin}:${process.env.PATH}`,
    SQL_PROBE_COUNT: join(dir, "sql-probes"), PREFLIGHT_RECEIPT: receipt, SHIP_REHEARSE_TIMEOUT_S: "5",
  });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(readFileSync(receipt, "utf8").trim(), "preflight-after-sql");
});

// ---------------------------------------------------------------------------
// A0: the postgres store. Production runs `--store postgres` (teploy.yml);
// before this the script died "engine data dir not found" on such an install.
// ---------------------------------------------------------------------------

/**
 * A fake docker that records every invocation and plays a running postgres
 * accessory: pg_dump emits a PGDMP-headed blob, pg_restore --data-only emits
 * COPY blocks (one with an escaped newline row, which must count as one row).
 * It also answers the scratch-rehearse probes (SELECT 1, the pg_class table
 * listing, count queries) so rehearse paths can be pinned without docker,
 * and takes knobs: FAKE_PG_DUMP_FAIL (pg_dump exits 3), RIVAL_DIR (with
 * FAKE_PG_DUMP_FAIL: a rival's finished backup is written there before
 * failing), FAKE_INSPECT_RC (docker inspect "finds" any name), and
 * FAKE_HOST_PG_RESTORE_FAIL (the host pg_restore stub rejects everything).
 */
function fakePgDocker(dir, over = {}) {
  const bin = join(dir, "fakebin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "docker.log");
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  ps)
    if [ "$2" = "-a" ]; then printf '%b' "\${FAKE_PSA:-}"; else printf '%b' "\${FAKE_PS:-}"; fi ;;
  inspect)
    case "$*" in
      *State.Running*) echo "\${FAKE_PG_RUNNING:-true}" ;;
      *Config.Image*) echo "pgvector/pgvector:0.8.0-pg17" ;;
      *Config.Env*) printf 'POSTGRES_DB=ship\\nPOSTGRES_USER=ship\\n' ;;
      *Mounts*) echo "" ;;
      *.Path*) echo "\${FAKE_WRITER_ARGS:-}" ;;
      *) exit "\${FAKE_INSPECT_RC:-1}" ;;
    esac ;;
  image) exit 0 ;;
  run) cat >/dev/null; exit 0 ;;
  port) echo "127.0.0.1:55432" ;;
  exec)
    case "$*" in
      *"printenv POSTGRES_DB"*) echo ship ;;
      *"printenv POSTGRES_USER"*) echo ship ;;
      *pg_dump*)
        if [ -n "\${FAKE_PG_DUMP_FAIL:-}" ]; then
          if [ -n "\${RIVAL_DIR:-}" ] && [ -d "\${RIVAL_DIR}" ]; then
            printf 'ship-backup manifest (rival finished backup)\\n' > "\${RIVAL_DIR}/manifest.txt"
            printf 'rival archive\\n' > "\${RIVAL_DIR}/rival-archive.txt"
          fi
          exit 3
        fi
        printf 'PGDMP\\001\\016\\000fake-custom-format-body' ;;
      *"pg_restore --data-only"*)
        cat >/dev/null
        printf 'SET x = 1;\\nCOPY public.ship_docs (id, body) FROM stdin;\\na\\t{}\\nb\\tline1\\\\nline2\\n\\\\.\\n\\nCOPY public.ship_stream (id) FROM stdin;\\n\\\\.\\n' ;;
      *"pg_restore --list"*) cat >/dev/null; exit 0 ;;
      *"pg_restore --exit-on-error"*) cat >/dev/null; exit 0 ;;
      *"SHOW server_version"*) echo "17.6 (Debian 17.6-1.pgdg120+1)" ;;
      *pg_class*) cat >/dev/null; printf 'public.ship_docs\\n' ;;
      *"SELECT 1"*) exit 0 ;;
      *"SELECT count(*) FROM"*) echo 0 ;;
      *) exit 9 ;;
    esac ;;
  *) exit 1 ;;
esac
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  // Shadow any host pg_restore: the fake dump body is not a real archive.
  writeFileSync(
    join(bin, "pg_restore"),
    `#!/bin/sh\nprintf 'pg_restore %s\\n' "$*" >> "${log}"\n[ -z "\${FAKE_HOST_PG_RESTORE_FAIL:-}" ] || exit 1\n[ "$1" = "--list" ]\n`,
  );
  chmodSync(join(bin, "pg_restore"), 0o755);
  return { env: { PATH: `${bin}:${process.env.PATH}`, ...over }, log };
}

test("postgres (fake docker): online pg_dump inside the accessory, counts read back from the archive, no stop asked", () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-backup-pg-"));
  try {
    writeFileSync(join(dir, "teploy.yml"), "processes:\n  # web: web --store nucleus (old)\n  web: web --store postgres --port 7460\n");
    // A running writer must NOT block an online dump (pg_dump is one snapshot).
    const fake = fakePgDocker(dir, { FAKE_PS: "ship-web-abc\\tship:v1\\tc1\\nship-postgres\\tpgvector/pgvector:0.8.0-pg17\\tc2\\n" });
    const res = run(["backup", "--label", "pg"], { SHIP_ROOT: dir, ...fake.env });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /store: postgres/);
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /^exec ship-postgres pg_dump -Fc -U ship -d ship$/m, "pg_dump runs inside the accessory, custom format");
    assert.doesNotMatch(calls, /\bstop\b|\brm\b/, "an online dump stops and removes nothing");
    const found = readdirSync(join(dir, "_backups"));
    assert.equal(found.length, 1);
    const dest = join(dir, "_backups", found[0]);
    assert.ok(existsSync(join(dest, "ship-pg.dump.sha256")));
    const manifest = readFileSync(join(dest, "manifest.txt"), "utf8");
    assert.match(manifest, /^store: postgres$/m);
    assert.match(manifest, /^pg-image: pgvector\/pgvector:0\.8\.0-pg17$/m);
    assert.match(manifest, /^database: ship$/m);
    assert.match(manifest, /^  public\.ship_docs  2$/m, "an escaped-newline row is still one row");
    assert.match(manifest, /^  public\.ship_stream  0$/m, "empty tables are recorded, not dropped");
    assert.match(manifest, /ship-web-abc\s+ship:v1/, "manifest records the containers docker saw");

    const verified = run(["verify", join(dest, "ship-pg.dump")], { SHIP_ROOT: dir, ...fake.env });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /PGDMP header/);

    // NEGATIVE CONTROL: a flipped byte fails the checksum, PGDMP header or not.
    const bytes = readFileSync(join(dest, "ship-pg.dump"));
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(join(dest, "ship-pg.dump"), bytes);
    const bad = run(["verify", join(dest, "ship-pg.dump")], { SHIP_ROOT: dir, ...fake.env });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /checksum mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postgres (fake docker): a failed pg_dump leaves no backup dir behind and exits non-zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-backup-pg-"));
  try {
    const fake = fakePgDocker(dir, { FAKE_PG_DUMP_FAIL: "1" });
    const res = run(["backup", "--label", "pg", "--store", "postgres"], { SHIP_ROOT: dir, ...fake.env });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /pg_dump failed/);
    assert.deepEqual(readdirSync(join(dir, "_backups")), [], "the failed run's own partial output is removed so the slot is free");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postgres (fake docker): a stopped accessory refuses the online dump and names --cold", () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-backup-pg-"));
  try {
    const fake = fakePgDocker(dir, { FAKE_PG_RUNNING: "false" });
    const res = run(["backup", "--store", "postgres"], { SHIP_ROOT: dir, ...fake.env });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /not running.*--cold/);
    assert.ok(!existsSync(join(dir, "_backups")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("postgres --cold refuses while ship containers (incl. the engine) run, like the nucleus tar", () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-backup-pg-"));
  try {
    mkdirSync(join(dir, "accessories", "postgres", "pgdata"), { recursive: true });
    writeFileSync(join(dir, "accessories", "postgres", "pgdata", "PG_VERSION"), "17\n");
    const fake = fakePgDocker(dir, { FAKE_PS: "ship-postgres\\tpgvector/pgvector:0.8.0-pg17\\tc2\\n" });
    const refused = run(["backup", "--cold"], { SHIP_ROOT: dir, ...fake.env });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /docker stop ship-postgres/);
    assert.ok(!existsSync(join(dir, "_backups")));
    const attested = run(["backup", "--cold", "--label", "cold", "--i-stopped-writers"], { SHIP_ROOT: dir, ...fake.env });
    assert.equal(attested.status, 0, attested.stderr);
    const archive = join(dir, "_backups", readdirSync(join(dir, "_backups"))[0], "pgdata-full.tgz");
    const listing = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" }).stdout;
    assert.match(listing, /^pgdata\/PG_VERSION$/m, "cold archive roots at pgdata/");
    assert.equal(run(["verify", archive], { SHIP_ROOT: dir, ...fake.env }).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store detection: writer args beat leftover accessories; conflicting accessories refuse; nothing found refuses", () => {
  const { dir } = makeFakeRoot(); // has the nucleus data dir
  try {
    // A burn-in box: nucleus data still on disk, but the writers run postgres.
    const fake = fakePgDocker(dir, {
      FAKE_PS: "ship-web-new\\tship:v2\\tc1\\n",
      FAKE_WRITER_ARGS: "teploy-ship web --store postgres --port 7460",
    });
    const dry = run(["backup", "--dry-run"], { SHIP_ROOT: dir, ...fake.env });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stderr, /store: postgres — writer args \(ship-web-new\)/);
    assert.match(dry.stdout, /ship-pg\.dump/);

    mkdirSync(join(dir, "accessories", "postgres", "pgdata"), { recursive: true });
    const noWriters = fakePgDocker(dir, {});
    const ambiguous = run(["backup", "--dry-run"], { SHIP_ROOT: dir, ...noWriters.env });
    assert.notEqual(ambiguous.status, 0);
    assert.match(ambiguous.stderr, /ambiguous store.*--store/);
    const stated = run(["backup", "--dry-run", "--store", "nucleus"], { SHIP_ROOT: dir, ...noWriters.env });
    assert.equal(stated.status, 0, stated.stderr);
    assert.match(stated.stdout, /nucleus-data-full\.tgz/);

    const empty = mkdtempSync(join(tmpdir(), "ship-backup-empty-"));
    try {
      const none = run(["backup", "--dry-run"], { SHIP_ROOT: empty, ...fakePgDocker(empty, {}).env });
      assert.notEqual(none.status, 0);
      assert.match(none.stderr, /could not tell which store/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("NEGATIVE CONTROL: the nucleus path is unchanged under the same fake docker — no pg_dump, same archive and manifest shape", () => {
  const { dir } = makeFakeRoot();
  try {
    const fake = fakePgDocker(dir, {});
    const res = run(["backup", "--label", "proof"], { SHIP_ROOT: dir, ...fake.env });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /store: postgres/);
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /pg_dump|pg_restore/);
    const archive = onlyArchive(join(dir, "_backups"));
    const manifest = readFileSync(join(dirname(archive), "manifest.txt"), "utf8");
    assert.deepEqual(
      manifest.split("\n").map((l) => l.split(":")[0]).filter((k) => /^[a-z0-9-]+$/.test(k)),
      ["date", "hostname", "ship-root", "data-dir", "archive", "bytes", "sha256"],
      "the nucleus manifest keys are exactly the pre-A0 set (no store/method lines added)",
    );
    assert.match(res.stdout, /^backup complete: .*nucleus-data-full\.tgz \(\d+ bytes, sha256 [0-9a-f]{64}\)$/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// PR #91 review findings. Every test in this section was verified to FAIL on
// the pre-fix script (the script stashed, the tests kept) and to pass after
// the fix — they pin the fixes, not the old behaviour.
// ---------------------------------------------------------------------------

test("review 1 (fake docker): a failed same-label run never deletes another backup's finished output at the same dest", () => {
  // The old check-then-create race, reproduced at the moment of its
  // consequence: this run has claimed <label>-<date> and its pg_dump fails
  // while a rival's FINISHED backup sits in the same dir (what a concurrent
  // same-label invocation that also passed the old -e test leaves behind).
  // The failure cleanup may take only this run's own partial archive.
  const dir = mkdtempSync(join(tmpdir(), "ship-backup-pg-"));
  try {
    const today = spawnSync("date", ["+%Y-%m-%d"], { encoding: "utf8" }).stdout.trim();
    const dest = join(dir, "_backups", `pg-${today}`);
    const fake = fakePgDocker(dir, { FAKE_PG_DUMP_FAIL: "1", RIVAL_DIR: dest });
    const res = run(["backup", "--label", "pg", "--store", "postgres"], { SHIP_ROOT: dir, ...fake.env });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /pg_dump failed/);
    assert.match(readFileSync(join(dest, "manifest.txt"), "utf8"), /rival finished backup/, "the rival's manifest must survive");
    assert.ok(existsSync(join(dest, "rival-archive.txt")), "the rival's archive must survive this run's failure");
    assert.ok(!existsSync(join(dest, "ship-pg.dump")), "this run's own partial archive is still removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review 2 (fake docker): verify prefers the live container's pg_restore over an older host client", () => {
  // An older host pg_restore rejects a valid newer server's dump and would
  // fail a backup whose archive is fine; the live container's client matches
  // the server it backs up, so it must be asked first (host last).
  const dir = mkdtempSync(join(tmpdir(), "ship-backup-pg-"));
  try {
    const fake = fakePgDocker(dir, { FAKE_HOST_PG_RESTORE_FAIL: "1" });
    const res = run(["backup", "--label", "pg", "--store", "postgres"], { SHIP_ROOT: dir, ...fake.env });
    assert.equal(res.status, 0, res.stderr);
    const dest = join(dir, "_backups", readdirSync(join(dir, "_backups"))[0]);
    const verified = run(["verify", join(dest, "ship-pg.dump")], { SHIP_ROOT: dir, ...fake.env });
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /docker exec ship-postgres/);
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /-i ship-postgres pg_restore --list/);
    assert.doesNotMatch(calls, /^pg_restore --list$/m, "the host client must not be asked while the container's is available");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review 3 (fake docker): writer args and teploy.yml naming different stores refuses; --store states the answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-backup-pg-"));
  try {
    const fake = fakePgDocker(dir, {
      FAKE_PS: "ship-web-new\\tship:v2\\tc1\\n",
      FAKE_WRITER_ARGS: "teploy-ship web --store postgres --port 7460",
    });
    writeFileSync(join(dir, "teploy.yml"), "processes:\\n  web: web --store nucleus --port 7460\\n");
    const refused = run(["backup", "--dry-run"], { SHIP_ROOT: dir, ...fake.env });
    assert.notEqual(refused.status, 0, "writers and teploy.yml disagreeing must refuse, not let the first source win");
    assert.match(refused.stderr, /store signals disagree: the writers' args say postgres.*says nucleus/);
    assert.ok(!existsSync(join(dir, "_backups")), "the refused backup must have written nothing");

    // Agreement still resolves via writer args.
    writeFileSync(join(dir, "teploy.yml"), "processes:\\n  web: web --store postgres --port 7460\\n");
    const agreed = run(["backup", "--dry-run"], { SHIP_ROOT: dir, ...fake.env });
    assert.equal(agreed.status, 0, agreed.stderr);
    assert.match(agreed.stderr, /store: postgres — writer args \(ship-web-new\)/);

    // A stated --store overrides the disagreement.
    writeFileSync(join(dir, "teploy.yml"), "processes:\\n  web: web --store nucleus --port 7460\\n");
    const stated = run(["backup", "--dry-run", "--store", "postgres"], { SHIP_ROOT: dir, ...fake.env });
    assert.equal(stated.status, 0, stated.stderr);
    assert.match(stated.stdout, /ship-pg\.dump/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review 4: a label containing '/' (path traversal) is refused before it becomes a dest path", () => {
  // The old case glob pinned only the FIRST TWO characters; its `*` matched
  // '/' too, so `ab/../../evil` sailed through and became a traversed dest
  // path — including on the failure rm path.
  const { dir } = makeFakeRoot();
  try {
    const res = run(["backup", "--label", "ab/../../evil", "--dry-run", "--i-stopped-writers"], { SHIP_ROOT: dir });
    assert.notEqual(res.status, 0, "a label with a slash must never become part of the dest path");
    assert.match(res.stderr, /label must start alphanumeric.*ab\/\.\.\/\.\.\/evil/);
    assert.ok(!existsSync(join(dir, "evil-")), "nothing outside _backups may be created");
    assert.ok(!existsSync(join(dir, "_backups")), "nothing is written by a refused dry-run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review 5 (fake docker): the cold manifest records database: and user:, and the cold rehearse uses them", () => {
  const dir = mkdtempSync(join(tmpdir(), "ship-backup-pg-"));
  try {
    mkdirSync(join(dir, "accessories", "postgres", "pgdata"), { recursive: true });
    writeFileSync(join(dir, "accessories", "postgres", "pgdata", "PG_VERSION"), "17\n");
    const fake = fakePgDocker(dir, {});
    const res = run(["backup", "--cold", "--label", "cold", "--i-stopped-writers"], { SHIP_ROOT: dir, ...fake.env });
    assert.equal(res.status, 0, res.stderr);
    const entry = readdirSync(join(dir, "_backups")).find((d) => d.startsWith("cold-"));
    const dest = join(dir, "_backups", entry);
    const manifest = readFileSync(join(dest, "manifest.txt"), "utf8");
    assert.match(manifest, /^database: ship$/m, "the cold manifest must record the database");
    assert.match(manifest, /^user: ship$/m, "the cold manifest must record the user");

    // rehearse_pg_cold must use the recorded identity, not ambient SHIP_PG_*.
    const rehearsed = run(["rehearse", join(dest, "pgdata-full.tgz"), "--image", "fixture-pg"], {
      SHIP_ROOT: dir,
      SHIP_PG_DB: "otherdb",
      SHIP_PG_USER: "otheruser",
      SHIP_BIN: "/nonexistent/teploy-ship",
      ...fake.env,
    });
    assert.equal(rehearsed.status, 0, rehearsed.stdout + rehearsed.stderr);
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, /-U ship -d ship .*SELECT count\(\*\) FROM public\.ship_docs/, "the rehearse connects as the manifest's database/user");
    assert.doesNotMatch(calls, /otherdb|otheruser/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review 6 (fake docker): a manifest table name that is not a plain identifier is refused, never put into SQL", () => {
  // The manifest is data beside the archive; a tampered table name must
  // never reach a psql command line.
  const dir = mkdtempSync(join(tmpdir(), "ship-backup-pg-"));
  try {
    const dest = join(dir, "_backups", "pg-handmade");
    mkdirSync(dest, { recursive: true });
    const dump = join(dest, "ship-pg.dump");
    writeFileSync(dump, "PGDMP-fake-not-a-real-archive");
    const digest = spawnSync("shasum", ["-a", "256", dump], { encoding: "utf8" }).stdout.split(" ")[0];
    writeFileSync(`${dump}.sha256`, `${digest}  ship-pg.dump\n`);
    writeFileSync(
      join(dest, "manifest.txt"),
      [
        "ship-backup manifest (script version 9.9.9)",
        "store: postgres",
        "pg-image: pgvector/pgvector:0.8.0-pg17",
        "database: ship",
        "user: ship",
        "tables (row counts read back from the archive itself — exactly what it holds):",
        "  public.ship_docs; DROP TABLE ship_docs;--  1",
        "",
      ].join("\n"),
    );
    const fake = fakePgDocker(dir, {});
    const res = run(["rehearse", dump, "--image", "fixture-pg"], { SHIP_ROOT: dir, SHIP_BIN: "/nonexistent/teploy-ship", ...fake.env });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /not a plain \(optionally schema-qualified\) identifier/);
    assert.match(res.stderr, /public\.ship_docs; DROP TABLE ship_docs;--/);
    assert.doesNotMatch(readFileSync(fake.log, "utf8"), /DROP TABLE/, "the tampered name must never reach a docker/psql command line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review 7 (fake docker): nucleus rehearse claims its proof container name before arming the cleanup trap", () => {
  const { dir } = makeFakeRoot();
  try {
    const fake = fakePgDocker(dir, {});
    assert.equal(run(["backup", "--label", "proof", "--i-stopped-writers"], { SHIP_ROOT: dir, ...fake.env }).status, 0);
    const archive = onlyArchive(join(dir, "_backups"));
    const shipBin = join(dir, "ship-proof");
    writeFileSync(shipBin, "#!/bin/sh\nexit 0\n");
    chmodSync(shipBin, 0o755);
    // docker inspect "finds" every name: the proof-container slot is taken.
    const taken = fakePgDocker(dir, { FAKE_INSPECT_RC: "0", SHIP_BIN: shipBin });
    const res = run(["rehearse", archive, "--image", "fixture-engine"], { SHIP_ROOT: dir, ...taken.env });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /already exists/);
    assert.ok(!existsSync(join(dir, "_backups", "rehearsals")), "the refusal must come before any rehearsal dir is created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- real path: a throwaway postgres in docker ------------------------------

const PG_IMAGE = "pgvector/pgvector:0.8.0-pg17";

function dockerReady() {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) return "docker not reachable";
  if (process.env.SHIP_BACKUP_PG_IT !== "1" && spawnSync("docker", ["image", "inspect", PG_IMAGE], { stdio: "ignore" }).status !== 0) {
    return `${PG_IMAGE} not present locally (set SHIP_BACKUP_PG_IT=1 to pull it)`;
  }
  return undefined;
}

function docker(args, input) {
  return spawnSync("docker", args, { encoding: "utf8", input });
}

function psql(container, sql) {
  const res = docker(["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-U", "ship", "-d", "ship", "-tA"], sql);
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

function waitForPg(container) {
  for (let i = 0; i < 120; i++) {
    if (docker(["exec", container, "psql", "-h", "127.0.0.1", "-U", "ship", "-d", "ship", "-tAc", "SELECT 1"]).status === 0) return;
    spawnSync("sleep", ["1"]);
  }
  throw new Error(`${container} did not come up`);
}

function proofContainers() {
  return docker(["ps", "-a", "--format", "{{.Names}}"]).stdout.split("\n").filter((n) => n.startsWith("ship-backup-proof-"));
}

test("postgres REAL PATH: dump a live throwaway postgres, verify, rehearse, restore; tampered manifest fails; cold tar boots", (t) => {
  const why = dockerReady();
  if (why !== undefined) {
    t.skip(why);
    return;
  }
  // Bind mounts need a host path the docker VM can see: on macOS the VM
  // (colima, Docker Desktop) shares $HOME, not the /var/folders tmpdir.
  const base = process.env.SHIP_BACKUP_IT_TMP ?? (process.platform === "darwin" ? join(homedir(), ".cache", "ship-backup-it") : tmpdir());
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "ship-backup-pg-it-"));
  const live = `ship-backup-it-pg-${process.pid}`;
  const pgdata = join(dir, "accessories", "postgres", "pgdata");
  mkdirSync(pgdata, { recursive: true });
  const before = new Set(proofContainers());
  let restored;
  try {
    const up = docker(["run", "-d", "--name", live, "-e", "POSTGRES_DB=ship", "-e", "POSTGRES_USER=ship", "-e", "POSTGRES_PASSWORD=pw", "-v", `${pgdata}:/var/lib/postgresql/data`, PG_IMAGE]);
    assert.equal(up.status, 0, up.stderr);
    waitForPg(live);
    psql(
      live,
      `CREATE EXTENSION vector;
       CREATE TABLE ship_docs (id text PRIMARY KEY, body jsonb);
       INSERT INTO ship_docs SELECT 'd' || g, jsonb_build_object('n', g) FROM generate_series(1, 5) g;
       INSERT INTO ship_docs VALUES ('multi', '{"note": "line1\\nline2"}');
       CREATE TABLE ship_kv (k text PRIMARY KEY, v text);
       INSERT INTO ship_kv VALUES ('a', E'has\\nnewline'), ('b', 'tab\there');
       CREATE TABLE ship_stream (id bigserial PRIMARY KEY, payload text);
       CREATE TABLE ship_vec (id int PRIMARY KEY, embedding vector(3));
       INSERT INTO ship_vec VALUES (1, '[1,2,3]'), (2, '[4,5,6]'), (3, '[7,8,9]');`,
    );
    writeFileSync(join(dir, "teploy.yml"), "processes:\n  web: web --store postgres --port 7460\n");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const preflightLog = join(dir, "preflight.log");
    writeFileSync(join(bin, "ship-proof"), `#!/bin/sh\nprintf '%s|%s|%s\\n' "$*" "$NUCLEUS_URL" "\${PGPASSWORD:+set}" > "${preflightLog}"\n`);
    chmodSync(join(bin, "ship-proof"), 0o755);
    const env = { SHIP_ROOT: dir, SHIP_PG_CONTAINER: live, SHIP_BIN: join(bin, "ship-proof"), SHIP_REHEARSE_TIMEOUT_S: "120" };

    const backup = run(["backup", "--label", "pg"], env);
    assert.equal(backup.status, 0, backup.stdout + backup.stderr);
    assert.match(backup.stderr, /store: postgres — teploy\.yml/);
    const dest = join(dir, "_backups", readdirSync(join(dir, "_backups"))[0]);
    const dump = join(dest, "ship-pg.dump");
    const manifest = readFileSync(join(dest, "manifest.txt"), "utf8");
    for (const [table, n] of [["ship_docs", 6], ["ship_kv", 2], ["ship_stream", 0], ["ship_vec", 3]]) {
      assert.match(manifest, new RegExp(`^  public\\.${table}  ${n}$`, "m"), `${table} count ${n} in manifest`);
    }
    assert.match(manifest, /^pg-server-version: 17\./m);

    const verified = run(["verify", dump], env);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /pg_restore --list/, "verify listed the TOC with a real pg_restore");

    const rehearsed = run(["rehearse", dump], env);
    assert.equal(rehearsed.status, 0, rehearsed.stdout + rehearsed.stderr);
    assert.match(rehearsed.stdout, /ok\s+public\.ship_docs\s+6/);
    assert.match(rehearsed.stdout, /ok\s+public\.ship_vec\s+3/);
    assert.match(rehearsed.stdout, /rehearsal passed/);
    const pf = readFileSync(preflightLog, "utf8");
    assert.match(pf, /^preflight --store postgres\|postgres:\/\/ship@127\.0\.0\.1:\d+\/ship\?sslmode=disable\|set$/m, "preflight ran against the scratch copy, password via PGPASSWORD not the URL");
    assert.deepEqual(proofContainers().filter((n) => !before.has(n)), [], "rehearse removed its proof container");

    // NEGATIVE CONTROL: the same dump against a manifest that claims one more row.
    const tampered = join(dir, "tampered");
    mkdirSync(tampered);
    copyFileSync(dump, join(tampered, "ship-pg.dump"));
    copyFileSync(`${dump}.sha256`, join(tampered, "ship-pg.dump.sha256"));
    writeFileSync(join(tampered, "manifest.txt"), manifest.replace(/^  public\.ship_docs  6$/m, "  public.ship_docs  7"));
    const caught = run(["rehearse", join(tampered, "ship-pg.dump")], env);
    assert.notEqual(caught.status, 0, "a count mismatch must fail the rehearsal");
    assert.match(caught.stderr, /MISMATCH\s+public\.ship_docs\s+manifest 7, restored 6/);
    assert.deepEqual(proofContainers().filter((n) => !before.has(n)), [], "a failed rehearsal still removes its proof container");

    // restore: a NEW scratch container, left running, never the live one.
    const refusedLive = run(["restore", dump, "--name", live], env);
    assert.notEqual(refusedLive.status, 0);
    assert.match(refusedLive.stderr, /IS the live postgres accessory/);
    const res = run(["restore", dump], env);
    assert.equal(res.status, 0, res.stdout + res.stderr);
    restored = /NEW scratch container: (\S+)/.exec(res.stdout)?.[1];
    assert.ok(restored, res.stdout);
    assert.equal(psql(restored, "SELECT count(*) FROM ship_kv WHERE v LIKE E'has\\n%'"), "1", "row content survives, not just counts");
    assert.equal(psql(live, "SELECT count(*) FROM ship_docs"), "6", "the live store is untouched");

    // cold: refuse while the engine runs, then tar the stopped pgdata and boot it.
    const coldRefused = run(["backup", "--cold", "--label", "cold"], env);
    assert.notEqual(coldRefused.status, 0);
    assert.match(coldRefused.stderr, new RegExp(`docker stop .*${live}`));
    assert.equal(docker(["stop", live]).status, 0);
    const cold = run(["backup", "--cold", "--label", "cold", "--i-stopped-writers"], env);
    assert.equal(cold.status, 0, cold.stdout + cold.stderr);
    const coldArchive = join(dir, "_backups", `cold-${readdirSync(join(dir, "_backups")).find((d) => d.startsWith("cold-")).slice(5)}`, "pgdata-full.tgz");
    const coldRehearsed = run(["rehearse", coldArchive], env);
    assert.equal(coldRehearsed.status, 0, coldRehearsed.stdout + coldRehearsed.stderr);
    assert.match(coldRehearsed.stdout, /public\.ship_docs\s+6/);
    assert.deepEqual(proofContainers().filter((n) => !before.has(n)), []);
  } finally {
    docker(["rm", "-f", live]);
    if (restored !== undefined) docker(["rm", "-f", restored]);
    // pgdata is owned by the container's uid; remove through a container.
    docker(["run", "--rm", "-v", `${dir}:/w`, "--entrypoint", "sh", PG_IMAGE, "-c", "rm -rf /w/accessories /w/_backups"]);
    rmSync(dir, { recursive: true, force: true });
  }
});
