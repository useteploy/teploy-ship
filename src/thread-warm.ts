/**
 * D4-c — a warm workspace per conversation thread.
 *
 * A follow-up starts a fresh sandbox today, and the warm cache is OFF for PR
 * runs (the runs follow-ups are), so the second turn of a thread pays a full
 * clone and install every time. The fix is a SNAPSHOT, not a held container:
 * the daemon cannot extend a TTL, a held container costs host RAM for idle
 * minutes, and a snapshot can always be evicted without losing anything.
 *
 * At the end of a run that belongs to a thread (the `thread-snapshot` step,
 * admitted by `warmThread` in the recorded input), Ship checks the workspace
 * holds no credential material, snapshots it through the daemon's
 * volume-aware path (teploy-sandbox 2a89f72 — the image carries the warm
 * volume's bytes, including `.git` and uncommitted files), and records the
 * result here keyed by the THREAD ROOT run id. A follow-up looks the record
 * up at ENQUEUE and materialises `threadWarm` into its input; the run loop
 * then boots from the snapshot on the same host and fetches instead of
 * cloning. Any mismatch falls back to the cold path, which always completes.
 *
 * REPLAY. Same rule as the warm cache (warm.ts): the record is live host
 * state, so nothing here may decide a step's presence. `warmThread` and
 * `threadWarm` are materialised at enqueue; every daemon-facing call lives
 * inside recorded steps; every failure degrades to cold rather than failing
 * the run.
 *
 * AUTHORITY. A warm thread carries BYTES, never approval: the record holds an
 * image ref and a head sha, no plan decision, and every follow-up decides its
 * own plan park at enqueue exactly as a cold run would.
 */
import { createHash } from "node:crypto";

import type { AgentExecutor } from "@neutron-build/agents";

import type { SandboxOverrides } from "./durable.js";
import { canonicalRepositoryURL } from "./repository-reference.js";

/** Decision 16: the deployment default for SHIP_WARM_THREAD_TTL_SEC. */
export const WARM_THREAD_DEFAULT_TTL_SEC = 7200;
/** Decision 16: at most this many thread snapshots per project per host. */
export const WARM_THREAD_PER_PROJECT_HOST = 5;

/** The run-input half a follow-up boots from (durable.ts `sandbox` step). */
export interface ThreadWarmRef {
  /** The snapshot ref, host-tagged exactly as `executor.snapshot` returned it. */
  image: string;
  /** The head the snapshot's workspace stood on; "" when none was recorded. */
  head: string;
}

/** The stored record behind one thread's snapshot. */
export interface ThreadWarmRecord {
  /** The thread anchor (task-session.ts) the follow-up will look up. */
  taskRootRunId: string;
  /** Canonical clone URL of the repository the snapshot holds. */
  repo: string;
  image: string;
  /** Which sandbox host holds the image (the tag half of a pool handle). */
  hostIndex: number;
  /** HEAD at snapshot time; "" when the workspace held no commit. */
  head: string;
  /** Sandbox-shape digest (see sandboxOverridesDigest). */
  overridesDigest: string;
  createdAt: string;
}

const KEY_PREFIX = "thread-warm:";
const INDEX_KEY = `${KEY_PREFIX}index`;

function threadWarmKey(taskRootRunId: string): string {
  return `${KEY_PREFIX}${taskRootRunId}`;
}

function parseRecord(raw: string | undefined, taskRootRunId: string): ThreadWarmRecord | null {
  if (raw === undefined || raw === "") return null;
  try {
    const r = JSON.parse(raw) as Partial<ThreadWarmRecord>;
    if (typeof r.image !== "string" || r.image === "") return null;
    return {
      taskRootRunId,
      repo: typeof r.repo === "string" ? r.repo : "",
      image: r.image,
      hostIndex: typeof r.hostIndex === "number" && Number.isInteger(r.hostIndex) && r.hostIndex >= 0 ? r.hostIndex : 0,
      head: typeof r.head === "string" ? r.head : "",
      overridesDigest: typeof r.overridesDigest === "string" ? r.overridesDigest : "",
      createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
    };
  } catch {
    return null;
  }
}

function readIndex(raw: string | undefined): string[] {
  if (raw === undefined || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9._-]+$/.test(id));
  } catch {
    return [];
  }
}

/**
 * Is the warm-thread feature armed? `SHIP_WARM_THREAD` alone is not enough:
 * a snapshot of a warm run is only self-contained when the daemon bakes the
 * warm volume's bytes into the image (teploy-sandbox 2a89f72), which Ship
 * asserts with the existing `SHIP_WARM_PARKS=1` capability flag. Reusing it
 * keeps one operator assertion for "the daemon snapshots volumes" rather
 * than two that could drift.
 */
export function warmThreadEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env.SHIP_WARM_THREAD) && flagOn(env.SHIP_WARM_PARKS);
}

function flagOn(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function warmThreadTtlSec(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.SHIP_WARM_THREAD_TTL_SEC);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : WARM_THREAD_DEFAULT_TTL_SEC;
}

export function threadWarmExpired(record: ThreadWarmRecord, now: Date, ttlSec: number): boolean {
  const at = Date.parse(record.createdAt);
  return !Number.isFinite(at) || at + ttlSec * 1000 <= now.getTime();
}

/**
 * The sandbox shape a snapshot's restore depends on: the fields `createFrom`
 * sends to the daemon (image, network tier, egress allowlist, limits).
 *
 * `warm` is EXCLUDED on purpose: the snapshot already carries the volume's
 * bytes, a restore boots no warm volume, and the first turn of a thread is a
 * warm run while its PR follow-up is not — including `warm` would make every
 * follow-up's digest differ from its parent's and the feature a no-op.
 * `resourceClass` is placement-side only (definedOverrides drops it before
 * the wire) so it is excluded the same way. Sorted and key-ordered so an
 * unchanged shape always digests identically on both ends.
 */
export function sandboxOverridesDigest(overrides?: SandboxOverrides): string {
  const canonical = {
    image: overrides?.image ?? "",
    network: overrides?.network ?? "",
    egressAllow: [...(overrides?.egressAllow ?? [])].sort(),
    limits: {
      cpus: overrides?.limits?.cpus ?? 0,
      memoryMb: overrides?.limits?.memoryMb ?? 0,
      pids: overrides?.limits?.pids ?? 0,
    },
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

/**
 * Does the workspace hold credential material? The gate the snapshot step
 * refuses at: a snapshot that survives its container's TTL must never
 * outlive a credential that was supposed to die with it.
 *
 * Checks what Ship knows can be left behind. H1 moved harness credentials
 * into the exec environment and the prompt/steer files are removed per exec,
 * but cleanup errors are swallowed — so a `.teploy-agent/` file shaped like
 * a credential still refuses the snapshot. The clone is written
 * credential-free in one shell (`cloneCredentialFree`), so `.git/config`
 * carrying an embedded user:token or a credential helper refuses too.
 * Returns the reason, or null when the workspace is clean.
 */
export async function workspaceCredentialReason(executor: AgentExecutor): Promise<string | null> {
  const config = await executor.exec(
    "git config --local --list 2>/dev/null | grep -Eq 'https?://[^/@[:space:]]+@|^credential\\.|^http\\.[^=]*\\.extraheader=' && printf cred-config || true",
    { timeoutMs: 30_000 },
  );
  if (config.exitCode === 0 && config.stdout.includes("cred-config")) {
    return ".git config carries a credential (embedded token URL, credential helper or extraheader)";
  }
  const scratch = await executor.exec(
    "find .teploy-agent -maxdepth 3 -type f \\( -name '*.env' -o -iname '*token*' -o -iname '*credential*' -o -iname '*secret*' \\) -print -quit 2>/dev/null || true",
    { timeoutMs: 30_000 },
  );
  const file = scratch.stdout.split("\n").map((l) => l.trim()).find((l) => l !== "");
  if (scratch.exitCode === 0 && file !== undefined) {
    return `harness scratch holds a credential-shaped file (${file})`;
  }
  return null;
}

/** What the enqueue side needs to decide a follow-up's boot. */
export type ThreadWarmDecision = { ref: ThreadWarmRef } | { reason: string };

/**
 * May a follow-up boot from its thread's snapshot? Decided at ENQUEUE, never
 * inside a step: the record is live state, and the same reasoning that keeps
 * `warm` out of the steps keeps this out of them (warm.ts REPLAY note).
 *
 * Every refusal names itself so the enqueue report can say why the run will
 * be cold — a silent cold boot is indistinguishable from a broken feature.
 */
export async function threadWarmForEnqueue(
  config: Pick<RuntimeConfigStoreLike, "get">,
  taskRootRunId: string,
  repo: string,
  overrides: SandboxOverrides | undefined,
  now: Date = new Date(),
  ttlSec: number = warmThreadTtlSec(),
): Promise<ThreadWarmDecision> {
  const record = parseRecord(await config.get(threadWarmKey(taskRootRunId)), taskRootRunId);
  if (record === null) return { reason: "the thread has no snapshot recorded" };
  const want = canonicalRepositoryURL(repo);
  const have = canonicalRepositoryURL(record.repo);
  if (want !== have) return { reason: "the thread's snapshot holds a different repository" };
  if (threadWarmExpired(record, now, ttlSec)) {
    return { reason: `the thread's snapshot expired (recorded ${record.createdAt}, TTL ${ttlSec}s)` };
  }
  const digest = sandboxOverridesDigest(overrides);
  if (record.overridesDigest !== digest) {
    return { reason: "the sandbox shape changed since the snapshot (image, network, egress or limits); booting cold" };
  }
  return { ref: { image: record.image, head: record.head } };
}

interface RuntimeConfigStoreLike {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, updatedBy?: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ThreadWarmStore {
  /** The thread's current record, if any. */
  get(taskRootRunId: string): Promise<ThreadWarmRecord | null>;
  /**
   * Record a fresh snapshot, REPLACING the thread's previous one (its image
   * is discarded), then enforce the per-project-per-host cap oldest-first.
   * Returns the records evicted beyond the cap, if any, for the timeline.
   */
  record(rec: ThreadWarmRecord): Promise<ThreadWarmRecord[]>;
  /** Drop a record without touching its image (the sweeper owns deletion). */
  remove(taskRootRunId: string): Promise<void>;
  /** Every live record (index order). */
  list(): Promise<ThreadWarmRecord[]>;
}

/**
 * The store, over the runtime config table (the delegation precedent: JSON
 * rows plus an index key, because the config store has no scan). `discard`
 * is what actually deletes a snapshot image; it is optional because a worker
 * whose provider cannot delete (a mixed pool) still records honestly and the
 * sweeper retries — a leaked image is a disk problem, never a run problem.
 */
export function threadWarmStore(
  config: RuntimeConfigStoreLike,
  options: { cap?: number; discard?: (image: string) => Promise<void>; log?: (line: string) => void } = {},
): ThreadWarmStore {
  const cap = options.cap ?? WARM_THREAD_PER_PROJECT_HOST;
  const log = options.log ?? (() => {});
  const discard = async (image: string): Promise<void> => {
    if (options.discard === undefined) return;
    try {
      await options.discard(image);
    } catch (error) {
      log(`[thread-warm] snapshot ${image} could not be deleted: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const ids = async (): Promise<string[]> => readIndex(await config.get(INDEX_KEY));
  const evict = async (records: ThreadWarmRecord[]): Promise<ThreadWarmRecord[]> => {
    for (const old of records) {
      await config.remove(threadWarmKey(old.taskRootRunId));
      await discard(old.image);
    }
    return records;
  };
  return {
    async get(taskRootRunId) {
      return parseRecord(await config.get(threadWarmKey(taskRootRunId)), taskRootRunId);
    },
    async record(rec) {
      const index = await ids();
      // One snapshot per thread root: the previous turn's image is replaced,
      // or every follow-up on a long thread would strand its parent's image.
      const prior = parseRecord(await config.get(threadWarmKey(rec.taskRootRunId)), rec.taskRootRunId);
      if (prior !== null && prior.image !== rec.image) await discard(prior.image);
      await config.set(threadWarmKey(rec.taskRootRunId), JSON.stringify(rec), "thread-warm");
      if (!index.includes(rec.taskRootRunId)) {
        await config.set(INDEX_KEY, JSON.stringify([...index, rec.taskRootRunId]), "thread-warm");
      }
      // The cap (Decision 16) is a DISK budget on the sandbox hosts, counted
      // per project (canonical repo) per host — the box the image sits on.
      const live = (await this.list()).filter(
        (r) => canonicalRepositoryURL(r.repo) === canonicalRepositoryURL(rec.repo) && r.hostIndex === rec.hostIndex,
      );
      const overflow = live
        .filter((r) => r.taskRootRunId !== rec.taskRootRunId)
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .slice(0, Math.max(0, live.length - cap));
      return await evict(overflow);
    },
    async remove(taskRootRunId) {
      await config.remove(threadWarmKey(taskRootRunId));
      const index = await ids();
      if (index.includes(taskRootRunId)) {
        await config.set(INDEX_KEY, JSON.stringify(index.filter((id) => id !== taskRootRunId)), "thread-warm");
      }
    },
    async list() {
      const out: ThreadWarmRecord[] = [];
      for (const id of await ids()) {
        const record = parseRecord(await config.get(threadWarmKey(id)), id);
        if (record !== null) out.push(record);
      }
      return out;
    },
  };
}

/**
 * The sweeper: delete expired snapshots, then re-assert the cap (belt for
 * records older than the eviction path, or a cap lowered in config). Runs on
 * the worker's own cadence; every failure is logged and retried next pass —
 * a sweeper that threw would take the intake sweep down with it.
 */
export async function sweepThreadWarm(
  store: ThreadWarmStore,
  options: { now?: () => Date; ttlSec?: number; cap?: number; discard?: (image: string) => Promise<void>; log?: (line: string) => void } = {},
): Promise<number> {
  const now = options.now ?? (() => new Date());
  const ttlSec = options.ttlSec ?? warmThreadTtlSec();
  const cap = options.cap ?? WARM_THREAD_PER_PROJECT_HOST;
  const log = options.log ?? (() => {});
  const discard = options.discard;
  const records = await store.list();
  let removed = 0;
  const live: ThreadWarmRecord[] = [];
  for (const record of records) {
    if (threadWarmExpired(record, now(), ttlSec)) {
      await store.remove(record.taskRootRunId);
      if (discard !== undefined) {
        try {
          await discard(record.image);
        } catch (error) {
          log(`[thread-warm] expired snapshot ${record.image} could not be deleted: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      removed++;
      continue;
    }
    live.push(record);
  }
  const groups = new Map<string, ThreadWarmRecord[]>();
  for (const record of live) {
    const key = `${canonicalRepositoryURL(record.repo)}#${record.hostIndex}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  for (const group of groups.values()) {
    const overflow = group
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(0, Math.max(0, group.length - cap));
    for (const old of overflow) {
      await store.remove(old.taskRootRunId);
      if (discard !== undefined) {
        try {
          await discard(old.image);
        } catch (error) {
          log(`[thread-warm] capped snapshot ${old.image} could not be deleted: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      removed++;
    }
  }
  return removed;
}
