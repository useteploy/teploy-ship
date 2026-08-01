import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Shared file-store plumbing, because the same three bugs were reimplemented
 * in every file-backed store:
 *
 * 1. `mkdir(stateDir())` instead of the directory the path is actually in, so a
 *    store constructed with a custom nested directory failed on first write.
 * 2. Whole-file read-modify-write with no locking, so two overlapping calls
 *    silently lost one of the updates.
 * 3. `catch { return {} }` on read, so a truncated or unreadable file was
 *    indistinguishable from "nothing here yet" — the fleet page would show no
 *    workers, the policy store would show no policies, and Ship would carry on.
 *
 * The functions below fix (1) and (3) outright and reduce (2) to a
 * within-process mutex, which is the honest ceiling for file mode: it is the
 * single-process path by construction, and multi-process deployments run on
 * Nucleus.
 */

/** Per-path promise chain: serializes read-modify-write within this process. */
const locks = new Map<string, Promise<unknown>>();

/** Run `fn` with exclusive access to `path` (within this process). */
export function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(path) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  // Keep the chain alive but never let a rejection poison the next waiter.
  locks.set(
    path,
    next.catch(() => undefined),
  );
  return next;
}

export class CorruptStateFile extends Error {
  constructor(path: string, cause: unknown) {
    super(`state file ${path} is unreadable: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "CorruptStateFile";
  }
}

/**
 * Read and parse a JSON state file.
 *
 * A MISSING file is the empty value — that is a real, expected state. Anything
 * else (unparseable, permission denied, truncated) throws: silently returning
 * "empty" for a corrupt file turns a storage fault into a wrong answer, and the
 * callers of these stores make admission and display decisions on the result.
 */
export async function readJsonFile<T>(path: string, empty: T): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw new CorruptStateFile(path, error);
  }
  if (raw.trim() === "") return empty;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new CorruptStateFile(path, error);
  }
}

/**
 * Write a JSON state file atomically: unique temp file in the SAME directory,
 * fsync, then rename. The temp name is unique because a shared `${path}.tmp`
 * means two overlapping writers clobber each other's staging file and one
 * rename lands a half-written document.
 */
export async function writeJsonFile(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    const handle = await open(tmp, "w", mode ?? 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}

/** Read, transform, write — serialized against other callers in this process. */
export async function updateJsonFile<T>(path: string, empty: T, fn: (current: T) => T | Promise<T>): Promise<void> {
  await withFileLock(path, async () => {
    const current = await readJsonFile<T>(path, empty);
    await writeJsonFile(path, await fn(current));
  });
}

/**
 * Append a line durably: the data is on disk before the call resolves.
 *
 * Without the fsync an appended event is only in the page cache, so the crash
 * these logs exist to survive can lose the last writes — which for the run
 * event log means replaying a step whose external side effect already happened.
 */
export async function appendLineSync(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a");
  try {
    await handle.writeFile(line.endsWith("\n") ? line : `${line}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Ids that get interpolated into file paths (run ids, task ids) must not be
 * able to escape the state directory. Generated ids are always safe; ids that
 * arrive from a URL path segment are not, and `join(dir, `${id}.json`)` with
 * `id = "../../x"` reads outside the store.
 */
export function assertSafeId(kind: string, id: string): string {
  if (id === "" || id.length > 128 || !/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith(".")) {
    throw new Error(`refusing unsafe ${kind} ${JSON.stringify(id)} — letters, digits and . _ - only`);
  }
  return id;
}
