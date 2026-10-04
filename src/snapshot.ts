/**
 * S19 tail: the snapshot producer (`teploy-ship snapshot`) and the
 * restore-check command — the CLI half of the practiced procedure in
 * scripts/ship-backup.sh, whose invariants are load-bearing here too:
 *
 *  - A consistent snapshot needs the COORDINATED STOP (ship web + worker +
 *    the nucleus engine). The producer refuses while any ship-* container it
 *    can see is running and prints the exact stop it expects;
 *    `--i-stopped-writers` is the operator's attestation that the stop
 *    happened (joined workers are systemd units this box's docker cannot
 *    see). A tar of a live store is a corrupt archive with a backup's name.
 *  - Backups are never overwritten, and nothing in this module ever deletes
 *    a backup. The only removal is this run's OWN partial output after a
 *    failed production — otherwise a failed tar would occupy the label+date
 *    slot forever, because the never-overwrite rule would refuse every retry.
 *    Retention is the operator's alone.
 *  - restore-check verifies WITHOUT unpacking over anything. The unpack
 *    itself stays in the script (`restore --into` an empty isolated dir);
 *    the proof an archive restores into a working store is the rehearsal.
 *
 * Every dependency (docker, tar, clock) is injected, so the refusals are
 * unit-tested against fake fixtures — never a live engine or docker socket.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

import { RedactionGate } from "./support.js";

export const SNAPSHOT_VERSION = "1.0.0";
export const DEFAULT_SHIP_ROOT = "/deployments/ship";
export const NUCLEUS_DATA_REL = "accessories/nucleus/nucleus-data";
export const ARCHIVE_NAME = "nucleus-data-full.tgz";
/** A manifest bigger than this is not a manifest this command ever wrote. */
export const RECEIPT_MAX_BYTES = 64 * 1024;

/** A refusal is the product: it says what to stop, never what to ignore. */
export class SnapshotRefusal extends Error {}

function refuse(message: string): never {
  throw new SnapshotRefusal(message);
}

function capture(bin: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(stderr !== "" && stderr !== undefined ? `${bin}: ${String(stderr).trim()}` : error.message));
        return;
      }
      resolve(String(stdout));
    });
  });
}

// ---------------------------------------------------------------------------
// docker: which writers are still alive
// ---------------------------------------------------------------------------

export interface ShipContainerLine {
  name: string;
  image: string;
  id: string;
}

export interface SnapshotDocker {
  /**
   * Running ship-* containers. `undefined` means docker is absent or
   * unreachable: a box without docker must still be able to take a snapshot,
   * so that state is advisory, never a refusal.
   */
  running(): Promise<ShipContainerLine[] | undefined>;
  /** Every ship-* container docker knows about (`docker ps -a`) — the manifest
   * records the engine image because a Nucleus rollback is
   * restore-archive-with-matching-image, not an image swap. */
  known(): Promise<ShipContainerLine[] | undefined>;
}

function ps(bin: string, all: boolean, prefix: string): Promise<ShipContainerLine[] | undefined> {
  const args = ["ps", ...(all ? ["-a"] : []), "--format", "{{.Names}}\t{{.Image}}\t{{.ID}}"];
  return capture(bin, args, 30_000).then(
    (out) =>
      out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [name, image, id] = l.split("\t");
          return { name: name ?? "", image: image ?? "", id: id ?? "" };
        })
        .filter((c) => c.name.startsWith(prefix)),
    () => undefined,
  );
}

export function defaultSnapshotDocker(bin = "docker", prefix = "ship-"): SnapshotDocker {
  return {
    running: () => ps(bin, false, prefix),
    known: () => ps(bin, true, prefix),
  };
}

// ---------------------------------------------------------------------------
// checksum + gzip integrity
// ---------------------------------------------------------------------------

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}

/** Decompress the whole stream and discard it — the honest `gzip -t`. */
async function gzipIntact(path: string): Promise<void> {
  await pipeline(
    createReadStream(path),
    createGunzip(),
    async function* consume(source) {
      for await (const _chunk of source) yield _chunk;
    },
  );
}

export interface VerifyResult {
  ok: boolean;
  /** Which stage failed. A gzip failure means the checksum itself DID match. */
  stage?: "checksum" | "gzip";
  reason?: string;
  /** The recorded digest, present whenever the sidecar parsed and matched. */
  sha256?: string;
}

/** Sidecar + checksum + gzip integrity, in the script's order, without unpacking. */
export async function verifyArchive(archive: string): Promise<VerifyResult> {
  if (!existsSync(archive)) return { ok: false, stage: "checksum", reason: `no such archive: ${archive}` };
  const sidecar = `${archive}.sha256`;
  if (!existsSync(sidecar)) {
    return { ok: false, stage: "checksum", reason: `missing checksum sidecar: ${sidecar} (an archive without its recorded sha256 cannot be verified)` };
  }
  let sidecarText: string;
  try {
    sidecarText = await readFile(sidecar, "utf8");
  } catch (error) {
    return { ok: false, stage: "checksum", reason: `cannot read checksum sidecar: ${sidecar} (${error instanceof Error ? error.message : String(error)})` };
  }
  const m = /^([0-9a-f]{64})\s+(\S+)\s*$/.exec(sidecarText.trim());
  if (m === null) {
    return { ok: false, stage: "checksum", reason: `checksum sidecar is malformed: ${sidecar} (expected "<sha256>  ${basename(archive)}")` };
  }
  if (m[2] !== basename(archive)) {
    return { ok: false, stage: "checksum", reason: `checksum sidecar names "${m[2]}", not "${basename(archive)}" — the sidecar must travel with its archive` };
  }
  const actual = await sha256File(archive);
  if (actual !== m[1]) return { ok: false, stage: "checksum", reason: `checksum mismatch: ${archive}` };
  try {
    await gzipIntact(archive);
  } catch (error) {
    return { ok: false, stage: "gzip", reason: `gzip integrity failure: ${archive} (${error instanceof Error ? error.message.split("\n")[0] : String(error)})` };
  }
  return { ok: true, sha256: m[1] };
}

// ---------------------------------------------------------------------------
// the producer
// ---------------------------------------------------------------------------

export interface ProduceDeps {
  shipRoot: string;
  /** Default: $SHIP_ROOT/_backups (env override happens in the CLI). */
  backupDir?: string;
  label?: string;
  dryRun?: boolean;
  /** --i-stopped-writers: the operator's attestation of the coordinated stop. */
  attested?: boolean;
  now?: () => Date;
  /** Undefined docker means: no writer check possible (advisory, not a refusal). */
  docker?: SnapshotDocker;
  /** Archive creation seam. Default: tar czf of the data dir, rooted at its basename. */
  runTar?: (archive: string, dataDir: string) => Promise<void>;
  log?: (line: string) => void;
}

export interface SnapshotOutcome {
  status: "produced" | "dry-run";
  dir: string;
  archive: string;
  /** 0 on a dry-run. */
  bytes: number;
  /** "" on a dry-run. */
  sha256: string;
  /** Advisory notes (e.g. docker unavailable — writer check skipped). */
  advisory: string[];
}

function localDateStamp(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function containerLines(lines: ShipContainerLine[]): string {
  return lines.map((c) => `  ${c.name}  ${c.image}  ${c.id}`).join("\n");
}

async function manifestText(opts: {
  now: Date;
  shipRoot: string;
  bytes: number;
  digest: string;
  running: ShipContainerLine[] | undefined;
  known: ShipContainerLine[] | undefined;
}): Promise<string> {
  const lines = [
    `ship-backup manifest (teploy-ship snapshot version ${SNAPSHOT_VERSION})`,
    `date: ${opts.now.toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    `hostname: ${hostname()}`,
    `ship-root: ${opts.shipRoot}`,
    `data-dir: ${NUCLEUS_DATA_REL}`,
    `archive: ${ARCHIVE_NAME}`,
    `bytes: ${opts.bytes}`,
    `sha256: ${opts.digest}`,
    "containers-running (advisory):",
  ];
  if (opts.running === undefined) lines.push("  docker unavailable — not checked (advisory)");
  else if (opts.running.length === 0) lines.push("  none found");
  else lines.push(containerLines(opts.running));
  lines.push("containers-known (docker ps -a, ship-* — rollback wants the matching engine image):");
  if (opts.known === undefined || opts.known.length === 0) lines.push("  docker unavailable or no ship-* containers (advisory)");
  else lines.push(containerLines(opts.known));
  return `${lines.join("\n")}\n`;
}

export async function produceSnapshot(deps: ProduceDeps): Promise<SnapshotOutcome> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const backupDir = deps.backupDir ?? join(deps.shipRoot, "_backups");
  const label = deps.label ?? "manual";
  const dataDir = join(deps.shipRoot, NUCLEUS_DATA_REL);
  if (!existsSync(dataDir)) {
    refuse(`engine data dir not found: ${dataDir} (set --ship-root or SHIP_ROOT)`);
  }

  const advisory: string[] = [];
  let running: ShipContainerLine[] | undefined;
  if (deps.attested !== true) {
    if (deps.docker === undefined) {
      advisory.push("docker unavailable — writer check skipped (advisory)");
    } else {
      running = await deps.docker.running();
      if (running === undefined) {
        advisory.push("docker present but unreachable — writer check skipped (advisory)");
      } else if (running.length > 0) {
        const stop = running.map((c) => c.name).join(" ");
        refuse(
          [
            "refusing: ship containers are still running — a tar of a live store is not a consistent backup:",
            ...running.map((c) => `  ${c.name}  ${c.image}`),
            "the coordinated stop this command expects:",
            `  docker stop ${stop}`,
            "then re-run with --i-stopped-writers",
          ].join("\n"),
        );
      }
    }
  } else if (deps.docker !== undefined) {
    // Even attested, the manifest should record what docker could see.
    running = await deps.docker.running();
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) {
    refuse(`label must start alphanumeric and contain only [A-Za-z0-9._-]: ${label}`);
  }
  const dest = join(backupDir, `${label}-${localDateStamp(now())}`);

  if (deps.dryRun === true) {
    for (const a of advisory) log(`# ${a}`);
    return { status: "dry-run", dir: dest, archive: join(dest, ARCHIVE_NAME), bytes: 0, sha256: "", advisory };
  }

  if (existsSync(dest)) refuse(`refusing to overwrite existing backup dir: ${dest} (backups are never overwritten)`);

  const known = deps.docker === undefined ? undefined : await deps.docker.known();
  const runTar =
    deps.runTar ??
    (async (archive: string, dir: string) => {
      await capture("tar", ["-czf", archive, "-C", dirname(dir), basename(dir)]);
    });

  await mkdir(dest, { recursive: true });
  try {
    const archive = join(dest, ARCHIVE_NAME);
    await runTar(archive, dataDir);
    const digest = await sha256File(archive);
    const bytes = (await stat(archive)).size;
    await writeFile(`${archive}.sha256`, `${digest}  ${ARCHIVE_NAME}\n`, "utf8");
    await writeFile(join(dest, "manifest.txt"), await manifestText({ now: now(), shipRoot: deps.shipRoot, bytes, digest, running, known }), "utf8");
    const verified = await verifyArchive(archive);
    if (!verified.ok) refuse(`produced archive failed its own verification: ${verified.reason}`);
    return { status: "produced", dir: dest, archive, bytes, sha256: digest, advisory };
  } catch (error) {
    // Only this run's OWN partial output is removed, and only because this
    // run created the directory a few lines above (a pre-existing dir would
    // have been refused before anything was written). A completed backup is
    // never the thing deleted.
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

// ---------------------------------------------------------------------------
// restore-check
// ---------------------------------------------------------------------------

export interface RestoreCheckSection {
  status: "pass" | "fail" | "unknown";
  detail: string;
}

export interface RestoreCheckReport {
  version: 1;
  archive: string;
  verdict: "verified" | "not-verified";
  sha256: RestoreCheckSection;
  gzip: RestoreCheckSection;
  contents: RestoreCheckSection & { entries: number; roots: string[] };
  /** What verification did NOT establish — the rehearsal is the restore proof. */
  notProven: string;
}

export const NOT_PROVEN =
  "integrity only: the archive was not unpacked and no engine has booted on it. The proof an " +
  "archive restores into a working store is the rehearsal — scripts/ship-backup.sh rehearse <archive> — " +
  "which unpacks into an isolated directory, starts an isolated nucleus against the copy and reads run " +
  "counts and step fingerprints (doctor's store-connectivity question, answered against the restored copy).";

function unsafeEntries(entries: string[]): string[] {
  return entries.filter((e) => e.startsWith("/") || e.split("/").includes(".."));
}

export interface RestoreCheckDeps {
  /** Listing seam: the tar member names, in order. Default: `tar -tzf`. */
  listArchive?: (archive: string) => Promise<string[]>;
}

export async function runRestoreCheck(archive: string, deps: RestoreCheckDeps = {}): Promise<RestoreCheckReport> {
  const verified = await verifyArchive(archive);
  // Attribute the failure to the stage that failed: a gzip failure happens
  // only after the checksum MATCHED, so the checksum section still passes.
  const sha256: RestoreCheckSection =
    verified.ok || verified.stage === "gzip"
      ? { status: "pass", detail: `sha256 ${verified.sha256} matches the sidecar` }
      : { status: "fail", detail: verified.reason ?? "verification failed" };

  let gzip: RestoreCheckSection;
  if (verified.ok) {
    gzip = { status: "pass", detail: "full-stream decompression clean (gzip -t equivalent)" };
  } else if (verified.stage === "gzip") {
    gzip = { status: "fail", detail: verified.reason ?? "gzip integrity failure" };
  } else {
    gzip = { status: "unknown", detail: "not checked — the checksum already failed" };
  }

  const base = { entries: 0, roots: [] as string[] };
  let contents: RestoreCheckReport["contents"];
  if (sha256.status !== "pass" || gzip.status !== "pass") {
    contents = { status: "unknown", detail: "not checked — integrity already failed", ...base };
  } else {
    let listed: string[];
    let listError: string | undefined;
    try {
      listed =
        deps.listArchive !== undefined
          ? await deps.listArchive(archive)
          : (await capture("tar", ["-tzf", archive])).split("\n").map((l) => l.trim()).filter(Boolean);
    } catch (error) {
      listed = [];
      listError = error instanceof Error ? error.message.split("\n")[0] : String(error);
    }
    if (listError !== undefined) {
      contents = { status: "unknown", detail: `could not list the archive (tar unavailable or failed): ${listError}`, ...base };
    } else {
      const roots = [...new Set(listed.map((e) => e.replace(/\/$/, "").split("/")[0]!))].sort();
      const unsafe = unsafeEntries(listed);
      contents = {
        status: unsafe.length > 0 ? "fail" : "pass",
        detail:
          unsafe.length > 0
            ? `listing contains paths that would escape the unpack target: ${unsafe.slice(0, 5).join(", ")}${unsafe.length > 5 ? ` (+${unsafe.length - 5} more)` : ""}`
            : `${listed.length} entries under ${roots.join(", ")} — all relative, no parent traversal`,
        entries: listed.length,
        roots,
      };
    }
  }

  return {
    version: 1,
    archive,
    verdict: sha256.status === "pass" && gzip.status === "pass" && contents.status === "pass" ? "verified" : "not-verified",
    sha256,
    gzip,
    contents,
    notProven: NOT_PROVEN,
  };
}

export function formatRestoreCheck(report: RestoreCheckReport): string {
  const gate = new RedactionGate();
  const mark: Record<RestoreCheckSection["status"], string> = { pass: "PASS   ", fail: "FAIL   ", unknown: "UNKNOWN" };
  const lines = [
    `${mark[report.sha256.status]} checksum: ${gate.redact(report.sha256.detail)}`,
    `${mark[report.gzip.status]} gzip:     ${gate.redact(report.gzip.detail)}`,
    `${mark[report.contents.status]} contents: ${gate.redact(report.contents.detail)}`,
    `verdict: ${report.verdict}`,
    "",
    gate.redact(report.notProven),
  ];
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// the receipt the support bundle carries
// ---------------------------------------------------------------------------

export interface BackupReceipt {
  backupDir: string;
  name: string;
  text: string;
}

/**
 * The manifest of the newest backup — the receipt, never the archive. A
 * support bundle must not carry the store itself.
 */
export async function latestBackupReceipt(backupDir: string): Promise<BackupReceipt | undefined> {
  let entries;
  try {
    entries = await readdir(backupDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let best: { name: string; mtimeMs: number } | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "rehearsals") continue;
    const manifest = join(backupDir, entry.name, "manifest.txt");
    try {
      const s = await stat(manifest);
      if (best === undefined || s.mtimeMs > best.mtimeMs) best = { name: entry.name, mtimeMs: s.mtimeMs };
    } catch {
      // not a backup dir; skip
    }
  }
  if (best === undefined) return undefined;
  let text = await readFile(join(backupDir, best.name, "manifest.txt"), "utf8");
  if (text.length > RECEIPT_MAX_BYTES) text = `${text.slice(0, RECEIPT_MAX_BYTES)}\n[truncated at ${RECEIPT_MAX_BYTES} bytes]\n`;
  return { backupDir, name: best.name, text };
}
