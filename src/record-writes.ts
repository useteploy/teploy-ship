import { randomBytes } from "node:crypto";
import { access, appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Loud shadow/record writes (S19/S28).
 *
 * 2026-10-16: the production data volume was root-owned while the worker and
 * web ran as uid 1000. Every file-backed shadow (policy, placement, tool
 * manifest, budget ledger) failed every write for 12 days and nothing said so;
 * the shadow reports then read "no record file", which looked like a quiet
 * shadow rather than a broken one.
 *
 * The rules here:
 * - A shadow write failure NEVER throws into the run path (shadows must not
 *   change outcomes).
 * - The first failure per process per file logs ONE loud line naming the path,
 *   the errno, this process's uid and the fix. Every failure is counted, so a
 *   counter can say how much was lost without a log line per write.
 */

export interface WriteFailure {
  label: string;
  path: string;
  code: string;
  count: number;
  firstAt: string;
}

const failures = new Map<string, WriteFailure>();

const PERMISSION_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

export const uidOf = (): string => String(process.getuid?.() ?? "?");

export const gidOf = (): string => String(process.getgid?.() ?? "?");

export function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && code !== "" ? code : "unknown";
}

/**
 * The operator's fix, naming the in-container dir and the teploy host path it
 * is usually bound from. The ids interpolated are THIS process's own — the
 * directory must end up owned by whoever actually writes here. 1000:1000 is
 * the teploy default (web and worker run as `node`), which is what the deploy
 * example names, but a non-default deployment needs the real ids, not the
 * default ones.
 */
export function chownHint(dir: string): string {
  return `chown ${uidOf()}:${gidOf()} <host path bound to ${dir}> (teploy default: 1000:1000 — teploy deploy: chown 1000:1000 /deployments/ship/volumes/ship-data on the server)`;
}

/**
 * Count a failed record write, and log loudly the first time `key` fails in
 * this process. `key` must be stable per file (not a temp-file name).
 */
export function noteWriteFailure(
  label: string,
  key: string,
  error: unknown,
  log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): void {
  const code = errnoOf(error);
  const existing = failures.get(key);
  if (existing !== undefined) {
    existing.count += 1;
    return;
  }
  failures.set(key, { label, path: key, code, count: 1, firstAt: new Date().toISOString() });
  const where = (error as NodeJS.ErrnoException | undefined)?.path ?? key;
  const dir = dirname(where);
  const fix = PERMISSION_CODES.has(code) ? ` Fix: ${chownHint(dir)}.` : "";
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw.startsWith(code) ? raw : `${code}: ${raw}`;
  log(
    `[ship] WARNING: ${label} cannot write ${key} (${message}) as uid ${uidOf()}; ` +
      `this shadow is recording NOTHING until fixed.${fix} Further failures for this file are counted, not logged.`,
  );
}

/** A per-directory key for stores that write through temp files (the errno path changes every write). */
export function dirKeyOf(error: unknown, fallback: string): string {
  const path = (error as NodeJS.ErrnoException | undefined)?.path;
  return typeof path === "string" && path !== "" ? dirname(path) : fallback;
}

/** Append one line to a record file. Never throws; a failure is counted and logged once per file. */
export async function appendRecordLine(label: string, path: string, line: string, log?: (line: string) => void): Promise<boolean> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, line.endsWith("\n") ? line : `${line}\n`, "utf8");
    return true;
  } catch (error) {
    noteWriteFailure(label, path, error, log);
    return false;
  }
}

/** Failed record writes in this process, by file. */
export function writeFailures(): WriteFailure[] {
  return [...failures.values()].map((f) => ({ ...f }));
}

/** Test seam. */
export function resetWriteFailures(): void {
  failures.clear();
}

export type DirWritability = "writable" | "not-writable" | "unknown";

export interface DirProbe {
  dir: string;
  status: DirWritability;
  code?: string;
}

const classify = (error: unknown): DirWritability => (PERMISSION_CODES.has(errnoOf(error)) ? "not-writable" : "unknown");

/** Real probe: create the dir if needed, write and remove a scratch file. */
export async function probeDirWritable(dir: string): Promise<DirProbe> {
  try {
    await mkdir(dir, { recursive: true });
    const f = join(dir, `.ship-write-probe-${process.pid}-${randomBytes(4).toString("hex")}`);
    await writeFile(f, "ok");
    await rm(f, { force: true });
    return { dir, status: "writable" };
  } catch (error) {
    return { dir, status: classify(error), code: errnoOf(error) };
  }
}

/**
 * Read-only probe for reports: never creates anything. Walks up to the first
 * existing ancestor (the writer would mkdir from there) and asks access(W_OK).
 */
export async function dirWritableNoCreate(dir: string): Promise<DirProbe> {
  let at = dir;
  for (;;) {
    try {
      await access(at, constants.F_OK);
      break;
    } catch (error) {
      if (errnoOf(error) !== "ENOENT") return { dir, status: classify(error), code: errnoOf(error) };
      const up = dirname(at);
      if (up === at) return { dir, status: "unknown", code: "ENOENT" };
      at = up;
    }
  }
  try {
    await access(at, constants.W_OK | constants.X_OK);
    return { dir, status: "writable" };
  } catch (error) {
    return { dir, status: classify(error), code: errnoOf(error) };
  }
}

/** One report line for a missing record file whose directory the shadow could not write. */
export function permissionLine(p: DirProbe): string {
  return (
    `the shadow could not write here (permission): ${p.dir} is not writable by uid ${uidOf()} (${p.code ?? "EACCES"}). ` +
    `Nothing was recorded; this is unknown, not zero. Fix: ${chownHint(p.dir)}.`
  );
}
