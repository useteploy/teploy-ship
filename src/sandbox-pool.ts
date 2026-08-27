/**
 * One worker, N sandbox hosts.
 *
 * WHY THIS SHAPE, AND WHY BEFORE MULTI-WORKER. `docs/capacity.md` measured
 * execution time not moving at all between 2 and 4 runs in flight (57 s median
 * both): runs are bound by model latency, not by the box. So the thing that
 * buys throughput is more places to put a container, not more processes to
 * drive them — and one worker driving N sandbox daemons opens no new network
 * surface, needs no second Nucleus route, and keeps the exactly-once claim
 * exactly where it already is.
 *
 * `SHIP_SANDBOX_URL` was a single URL. It is now a list, and adding a host to
 * it is the whole of "add a box".
 *
 * PLACEMENT. Least-loaded healthy host, where "load" is this pool's own count
 * of live handles per host — not a number read back from the daemon, which has
 * no such endpoint and would cost a round trip per placement anyway. Ties break
 * by declaration order, so a one-host list behaves exactly as before.
 *
 * FAILURE. A host that refuses a create is marked unhealthy and skipped for a
 * cooldown, and the create is retried on the next healthy host. A run already
 * placed on a host that dies cannot be moved — its container is gone and the
 * workspace with it — so that run fails with a reason naming the host, which is
 * what the C5 rescue path is for. Draining means "stop placing NEW runs here";
 * it can never mean "silently move a running one".
 *
 * HANDLES. A handle has to say which host it is on, or `attach` cannot find it
 * after a restart or a replay. The pool prefixes the daemon's own run id with
 * the host index and a separator the daemon never emits, so an old bare handle
 * still resolves — to host 0, which is the only host a single-URL deployment
 * ever had.
 */
import type { AgentExecutor } from "@neutron-build/agents";

import type { ExecutorProvider, SandboxOverrides } from "./durable.js";

/** Separator between the host tag and the daemon's own run id. */
const HANDLE_SEP = "@";

/** How long a host stays out after refusing work, before it is tried again. */
export const UNHEALTHY_COOLDOWN_MS = 30_000;

export interface PoolHost {
  /** The daemon's base URL, as configured. */
  url: string;
  provider: ExecutorProvider;
}

export interface PoolHostState {
  url: string;
  /** Handles this pool believes are live on that host. */
  live: number;
  healthy: boolean;
  /** Why it was last marked unhealthy, for the Fleet page and the log. */
  lastError?: string;
}

/**
 * Split a `SHIP_SANDBOX_URL` value into hosts.
 *
 * Comma- or whitespace-separated, empties dropped, order preserved and
 * duplicates removed — a list with one entry is the old behaviour exactly, so
 * every existing deployment is unaffected.
 */
export function parseSandboxUrls(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const url = part.trim().replace(/\/+$/, "");
    if (url === "" || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** `<index>@<daemon run id>`. */
export function poolHandle(index: number, handle: string): string {
  return `${index}${HANDLE_SEP}${handle}`;
}

/**
 * Which host a handle belongs to, and the daemon's own id.
 *
 * A handle with no tag is from a single-URL deployment written before pools
 * existed, and belongs to host 0 — the only host it could have been on. That
 * fallback is what lets an in-flight run replay across this change instead of
 * failing to attach.
 */
export function parsePoolHandle(handle: string): { index: number; handle: string } {
  const at = handle.indexOf(HANDLE_SEP);
  if (at <= 0) return { index: 0, handle };
  const index = Number(handle.slice(0, at));
  if (!Number.isInteger(index) || index < 0) return { index: 0, handle };
  return { index, handle: handle.slice(at + 1) };
}

export interface SandboxPoolOptions {
  hosts: PoolHost[];
  log?: (line: string) => void;
  now?: () => number;
  cooldownMs?: number;
}

/**
 * An ExecutorProvider over several sandbox daemons.
 *
 * Deliberately an ExecutorProvider rather than a new abstraction: everything
 * downstream — durable.ts, the worker, the harness adapters — keeps talking to
 * the interface it already talks to, and a pool of one is indistinguishable
 * from the single provider it replaces.
 */
export class SandboxPool implements ExecutorProvider {
  readonly isolated: boolean;
  #hosts: PoolHost[];
  #live: number[];
  #downUntil: number[];
  #lastError: Array<string | undefined>;
  #log: (line: string) => void;
  #now: () => number;
  #cooldownMs: number;

  constructor(options: SandboxPoolOptions) {
    if (options.hosts.length === 0) throw new Error("a sandbox pool needs at least one host");
    this.#hosts = options.hosts;
    this.#live = options.hosts.map(() => 0);
    this.#downUntil = options.hosts.map(() => 0);
    this.#lastError = options.hosts.map(() => undefined);
    this.#log = options.log ?? (() => {});
    this.#now = options.now ?? Date.now;
    this.#cooldownMs = options.cooldownMs ?? UNHEALTHY_COOLDOWN_MS;
    // Every host must isolate, or the pool does not. A run whose task came from
    // outside refuses to execute on a non-isolating provider, and that check
    // reads ONE boolean — so the honest answer for a mixed pool is false.
    this.isolated = options.hosts.every((h) => h.provider.isolated === true);

    if (this.#everyHostSnapshots()) {
      this.snapshot = async (handle: string): Promise<string> => {
        const { index, handle: inner } = parsePoolHandle(handle);
        const host = this.#hosts[index];
        if (host?.provider.snapshot === undefined) throw new Error(`host #${index} cannot snapshot`);
        return poolHandle(index, await host.provider.snapshot(inner));
      };
      this.createFrom = async (image: string, overrides?: SandboxOverrides): Promise<{ handle: string }> => {
        const { index, handle: inner } = parsePoolHandle(image);
        const host = this.#hosts[index];
        if (host?.provider.createFrom === undefined) {
          throw new Error(`this run's snapshot is on host #${index}, which is no longer configured`);
        }
        const created = await host.provider.createFrom(inner, overrides);
        this.#live[index] += 1;
        return { handle: poolHandle(index, created.handle) };
      };
    }
  }

  /** What the Fleet page and the log want to know. */
  state(): PoolHostState[] {
    const now = this.#now();
    return this.#hosts.map((host, i) => ({
      url: host.url,
      live: this.#live[i]!,
      healthy: this.#downUntil[i]! <= now,
      ...(this.#lastError[i] !== undefined ? { lastError: this.#lastError[i]! } : {}),
    }));
  }

  #order(): number[] {
    const now = this.#now();
    return this.#hosts
      .map((_, i) => i)
      .filter((i) => this.#downUntil[i]! <= now)
      .sort((a, b) => this.#live[a]! - this.#live[b]! || a - b);
  }

  #markDown(index: number, error: unknown): void {
    this.#downUntil[index] = this.#now() + this.#cooldownMs;
    this.#lastError[index] = error instanceof Error ? error.message : String(error);
    this.#log(
      `[sandbox-pool] ${this.#hosts[index]!.url} is not taking work (${this.#lastError[index]}); ` +
        `skipping it for ${Math.round(this.#cooldownMs / 1000)}s`,
    );
  }

  /**
   * Try each healthy host in placement order, then — only if every one of them
   * refused — try the ones in cooldown.
   *
   * The second pass matters: a cooldown is a guess about a host, and a pool
   * that refuses to place anything because every host is briefly in cooldown
   * has turned a transient blip into an outage.
   */
  async #place<T>(what: string, attempt: (host: PoolHost, index: number) => Promise<T>): Promise<T> {
    const errors: string[] = [];
    const healthy = this.#order();
    const cooling = this.#hosts.map((_, i) => i).filter((i) => !healthy.includes(i));
    for (const index of [...healthy, ...cooling]) {
      try {
        const result = await attempt(this.#hosts[index]!, index);
        this.#downUntil[index] = 0;
        return result;
      } catch (error) {
        this.#markDown(index, error);
        errors.push(`${this.#hosts[index]!.url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`no sandbox host could ${what} (${errors.join("; ")})`);
  }

  async create(overrides?: SandboxOverrides): Promise<{ handle: string }> {
    return this.#place("start a sandbox", async (host, index) => {
      const created = await host.provider.create(overrides);
      this.#live[index] += 1;
      return { handle: poolHandle(index, created.handle) };
    });
  }

  attach(handle: string): AgentExecutor {
    const { index, handle: inner } = parsePoolHandle(handle);
    const host = this.#hosts[index];
    if (host === undefined) {
      // A recorded run naming a host that is no longer configured. Fail with
      // the reason rather than a confusing error from whichever daemon happens
      // to be at index 0 now — moving a run between hosts is impossible, its
      // workspace only exists on the original.
      throw new Error(
        `this run's sandbox was on host #${index}, which is no longer in SHIP_SANDBOX_URL ` +
          `(${this.#hosts.length} host(s) configured). Its workspace only ever existed there; re-enqueue the task.`,
      );
    }
    return host.provider.attach(inner);
  }

  async destroy(handle: string): Promise<void> {
    const { index, handle: inner } = parsePoolHandle(handle);
    const host = this.#hosts[index];
    if (host?.provider.destroy === undefined) return;
    await host.provider.destroy(inner);
    this.#live[index] = Math.max(0, this.#live[index]! - 1);
  }

  /**
   * Snapshot and restore, both host-aware.
   *
   * A snapshot is an image ref on ONE daemon, so a restore has to go back to
   * the host that took it — the tag rides on the ref for the same reason it
   * rides on a handle. Present only when every host supports snapshots: the
   * durable loop treats snapshot support as all-or-nothing (it snapshots before
   * parking and expects to restore afterwards), and a pool that sometimes could
   * would park runs it cannot resume.
   *
   * Assigned in the CONSTRUCTOR BODY, not as a class-field initialiser: field
   * initialisers run before the constructor body, so `this.#hosts` is still
   * undefined there. The first version of this crashed on every placement.
   */
  snapshot?: (handle: string) => Promise<string>;
  createFrom?: (image: string, overrides?: SandboxOverrides) => Promise<{ handle: string }>;

  #everyHostSnapshots(): boolean {
    return this.#hosts.every((h) => h.provider.snapshot !== undefined && h.provider.createFrom !== undefined);
  }
}
