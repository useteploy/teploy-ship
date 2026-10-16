/**
 * Live view (D5 — S12, S10): a read-only terminal stream and a running diff
 * on the run page while a run is active. `SHIP_LIVE_VIEW=on` (only `on`;
 * default off) on BOTH containers: the worker records and serves, the web
 * shows.
 *
 * Two side channels, both in the runtime config KV store (the transport the
 * takeover console and the read-only inspections already use; the page
 * polls, there is no persistent connection):
 *
 * - TERMINAL. While the native loop runs a bash action, the command's output
 *   streams (the sandbox daemon's exec is SSE) into one bounded, redacted
 *   tail row per run, flushed at most once per LIVE_FLUSH_MS with a trailing
 *   flush so a burst followed by silence still lands. Like live.ts it is
 *   written from inside a recorded step while the step executes live: a
 *   replay never writes it, and a lost row changes nothing about the run.
 *   The streamed exec returns the same ExecResult the plain exec would
 *   (identical SSE parsing and caps), so the recorded step is unchanged.
 *
 * - DIFF. The page writes a watch heartbeat; the worker, on its intake tick,
 *   computes the workspace diff against the run's base for watched active
 *   runs only — at most once per LIVE_DIFF_MIN_INTERVAL_MS per run and
 *   LIVE_DIFF_MAX_PER_SWEEP runs per tick. Nobody watching costs zero sandbox
 *   execs. The diff is ONE read-only shell invocation that records its own
 *   instant (sandbox clock), HEAD and resolved base alongside the diff, plus
 *   a digest of the exact bytes, so the page can say which tree it shows.
 *
 * Observers cannot write: the web surface is a GET with no action; the only
 * write an observer causes is the watch heartbeat (a Ship-store row, never
 * the workspace), the same shape as the forge-refresh request a viewer's
 * page load already causes.
 */
import { createHash } from "node:crypto";

import type { AgentExecutor, ExecResult } from "@neutron-build/agents";

import type { ExecutorProvider } from "./durable.js";
import type { StreamExec } from "./harness.js";
import { safeForDisplay } from "./redact.js";
import type { RuntimeConfigStore } from "./runtime-config.js";
import { latestSandboxHandle, loadTakeover } from "./takeover.js";

export const LIVE_OUTPUT_PREFIX = "SHIP_LIVE_OUTPUT_";
export const LIVE_DIFF_PREFIX = "SHIP_LIVE_DIFF_";
export const LIVE_WATCH_PREFIX = "SHIP_LIVE_WATCH_";

/** Characters of output tail kept per run. */
export const LIVE_OUTPUT_LIMIT = 8_000;
/** Bytes of diff kept per snapshot. */
export const LIVE_DIFF_LIMIT = 9_000;
/** Flush cadence for the terminal row. With the page's 2 s poll the worst case is ~3 s plus store latency. */
export const LIVE_FLUSH_MS = 1_000;
/** The page polls the live endpoint this often while the run is active. */
export const LIVE_POLL_MS = 2_000;
/** A watch older than this is abandoned (the tab closed) and stops diff work. */
export const LIVE_WATCH_TTL_MS = 15_000;
/** The web re-writes the heartbeat no more often than this. */
export const LIVE_WATCH_REFRESH_MS = 5_000;
export const LIVE_DIFF_MIN_INTERVAL_MS = 3_000;
export const LIVE_DIFF_MAX_PER_SWEEP = 5;
/** Same bound as every workspace reply row (workspace-requests.ts WORKSPACE_ROW_BYTES_LIMIT). */
const ROW_BYTES_LIMIT = 14_000;

const RUN_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function liveViewEnabled(env: { SHIP_LIVE_VIEW?: string } = process.env): boolean {
  return (env.SHIP_LIVE_VIEW ?? "").trim().toLowerCase() === "on";
}

export const liveOutputKey = (runId: string): string => LIVE_OUTPUT_PREFIX + runId;
export const liveDiffKey = (runId: string): string => LIVE_DIFF_PREFIX + runId;
export const liveWatchKey = (runId: string): string => LIVE_WATCH_PREFIX + runId;

const rowBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

// ── Terminal ────────────────────────────────────────────────────────────

export interface LiveOutputRecord {
  runId: string;
  /** The command, clipped and redacted. */
  command: string;
  turn?: number;
  startedAt: string;
  /** Worker time of the most recent output chunk (or of the start). The page's "updated" age. */
  lastChunkAt: string;
  /** Worker time this row was written. */
  at: string;
  running: boolean;
  exitCode?: number;
  timedOut?: boolean;
  /** Redacted tail of stdout+stderr in arrival order. */
  output: string;
  /** True when the head of the output was dropped to keep the tail. */
  truncated: boolean;
}

export interface LiveOutputRecorder {
  chunk(text: string): void;
  end(result: Pick<ExecResult, "exitCode" | "timedOut">): Promise<void>;
}

/**
 * Keep the tail, cut at a line boundary so a secret straddling the cut is
 * dropped whole rather than left half-visible to a pattern redactor.
 */
function keepTail(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const tail = text.slice(-max);
  const nl = tail.indexOf("\n");
  return { text: nl >= 0 && nl < tail.length - 1 ? tail.slice(nl + 1) : tail, cut: true };
}

/**
 * One command's live output, written to its run's row. Writes are chained so
 * a slow store can never land an older flush over a newer one; every write is
 * advisory (failures swallowed) — a live hint must not fail a turn.
 */
export function liveOutputRecorder(
  config: Pick<RuntimeConfigStore, "set">,
  runId: string,
  command: string,
  options: { turn?: number; flushMs?: number; now?: () => number } = {},
): LiveOutputRecorder {
  const now = options.now ?? Date.now;
  const flushMs = options.flushMs ?? LIVE_FLUSH_MS;
  const iso = (ms: number) => new Date(ms).toISOString();
  const startedAt = iso(now());
  let buffer = "";
  let dropped = false;
  let lastChunkAt = startedAt;
  let lastFlush = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let ended = false;
  const shownCommand = safeForDisplay(command.split("\n", 1)[0] ?? "", 300);

  const write = (record: Partial<LiveOutputRecord>): void => {
    const tail = keepTail(buffer, LIVE_OUTPUT_LIMIT);
    const full: LiveOutputRecord = {
      runId,
      command: shownCommand,
      ...(options.turn !== undefined ? { turn: options.turn } : {}),
      startedAt,
      lastChunkAt,
      at: iso(now()),
      running: true,
      output: safeForDisplay(tail.text, LIVE_OUTPUT_LIMIT + 500),
      truncated: dropped || tail.cut,
      ...record,
    };
    chain = chain.then(() => config.set(liveOutputKey(runId), JSON.stringify(fitOutput(full)))).catch(() => {});
  };
  const flush = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    lastFlush = now();
    write({});
  };
  write({});
  return {
    chunk(text: string) {
      if (ended || text === "") return;
      buffer += text;
      if (buffer.length > LIVE_OUTPUT_LIMIT * 2) {
        buffer = buffer.slice(-LIVE_OUTPUT_LIMIT * 2);
        dropped = true;
      }
      lastChunkAt = iso(now());
      const wait = flushMs - (now() - lastFlush);
      if (wait <= 0) flush();
      else if (timer === undefined) {
        timer = setTimeout(flush, wait);
        timer.unref?.();
      }
    },
    async end(result) {
      if (ended) return chain;
      ended = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      write({ running: false, exitCode: result.exitCode, ...(result.timedOut ? { timedOut: true } : {}) });
      return chain;
    },
  };
}

function fitOutput(record: LiveOutputRecord): LiveOutputRecord {
  let out = record;
  for (let i = 0; i < 12 && rowBytes(out) > ROW_BYTES_LIMIT && out.output !== ""; i++) {
    const keep = Math.floor(out.output.length * (ROW_BYTES_LIMIT / rowBytes(out)) * 0.9);
    out = { ...out, output: out.output.slice(-keep), truncated: true };
  }
  return out;
}

/**
 * The executor a bash action runs through when the live view records output.
 * `exec` streams through the provider when it can (same result as the plain
 * exec: identical SSE parsing and caps); otherwise it runs plainly and the
 * output lands at exit. Only `exec` is intercepted, and only when the call
 * carries no cwd/env the streamed path would not forward.
 */
export function liveOutputExecutor(
  executor: AgentExecutor,
  execStream: StreamExec | undefined,
  start: (command: string) => LiveOutputRecorder,
): AgentExecutor {
  return {
    async exec(command, options) {
      const recorder = start(command);
      let result: ExecResult;
      try {
        if (execStream !== undefined && options?.cwd === undefined && options?.env === undefined) {
          const streamOptions = {
            ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
            ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
          };
          result = await execStream(command, streamOptions, (_stream, chunk) => recorder.chunk(chunk));
        } else {
          result = await executor.exec(command, options);
          recorder.chunk(result.stdout + (result.stderr !== "" ? (result.stdout.endsWith("\n") || result.stdout === "" ? "" : "\n") + result.stderr : ""));
        }
      } catch (error) {
        void recorder.end({ exitCode: -1, timedOut: false });
        throw error;
      }
      void recorder.end(result);
      return result;
    },
    putFile: (path, data) => executor.putFile(path, data),
    getFile: (path) => executor.getFile(path),
    destroy: () => executor.destroy(),
  };
}

// ── Diff ────────────────────────────────────────────────────────────────

export interface LiveDiffRecord {
  runId: string;
  /** Worker time the snapshot was stored. */
  at: string;
  /** Sandbox clock at the start of the one shell invocation that produced the diff — the instant it describes. */
  sandboxAt?: string;
  /** HEAD at that instant. */
  head?: string;
  /** The resolved base commit the diff is against. */
  base?: string;
  /** How the base was chosen, in words for the page. */
  baseLabel?: string;
  /** sha256 of the exact diff bytes the sandbox produced (before redaction), first 16 hex. */
  digest?: string;
  /** Redacted, bounded diff: tracked changes vs base, then untracked non-ignored files as new files. */
  output?: string;
  truncated?: boolean;
  error?: string;
}

export interface LiveWatch {
  at: string;
  by: string;
}

const quote = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

/**
 * The one read-only command behind the running diff. Optional locks,
 * fsmonitor, the untracked cache, external diff drivers and textconv are
 * disabled: observing must never run repository hooks or helpers, nor take
 * the index lock the agent's own git needs. Untracked files are read with
 * `git diff --no-index` against /dev/null, which touches no repository state;
 * ignored files (`.env`, dependency trees) are excluded by --exclude-standard,
 * so the diff shows what `git add -A` at publish would commit.
 *
 * `base` is either an exact commit (a PR run's recorded head at checkout) or
 * a branch name whose merge-base with HEAD is resolved at the same instant.
 */
export function liveDiffCommand(base: { sha: string } | { branch: string }, limit = LIVE_DIFF_LIMIT): string {
  const git = "git --no-optional-locks --no-pager -c core.fsmonitor=false -c core.untrackedCache=false -c core.quotepath=false";
  let resolve: string;
  if ("sha" in base) {
    if (!/^[0-9a-f]{7,64}$/.test(base.sha)) throw new Error("Invalid base commit");
    resolve = `base=$(${git} rev-parse --verify --quiet ${quote(base.sha + "^{commit}")})`;
  } else {
    if (base.branch === "" || base.branch.length > 255 || !/^[A-Za-z0-9._/-]+$/.test(base.branch) || base.branch.includes("..") || base.branch.startsWith("-"))
      throw new Error("Invalid base branch");
    const ref = quote(`refs/remotes/origin/${base.branch}`);
    resolve = `base=$(${git} merge-base HEAD ${ref} 2>/dev/null || ${git} rev-parse --verify --quiet ${ref})`;
  }
  const diff = `${git} diff --no-ext-diff --no-textconv --ignore-submodules=all "$base" --`;
  const untracked = `${git} ls-files -z --others --exclude-standard | xargs -0 -I{} ${git} diff --no-index --no-ext-diff --no-textconv -- /dev/null {}`;
  const script = [
    `printf 'at=%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"`,
    `head=$(${git} rev-parse HEAD 2>/dev/null) || { echo 'error=not a git work tree'; exit 0; }`,
    `printf 'head=%s\\n' "$head"`,
    resolve,
    `[ -n "$base" ] || { echo 'error=base not resolvable'; exit 0; }`,
    `printf 'base=%s\\n' "$base"`,
    `echo '--- diff'`,
    `{ ${diff}; ${untracked}; } 2>/dev/null | head -c ${limit + 1}`,
    `exit 0`,
  ].join("\n");
  return `bash -c ${quote(script)}`;
}

/** Parse the command's framed output. The diff body is everything after the marker line. */
export function parseLiveDiff(stdout: string, limit = LIVE_DIFF_LIMIT): Omit<LiveDiffRecord, "runId" | "at" | "baseLabel"> {
  const marker = stdout.indexOf("--- diff\n");
  const header = marker >= 0 ? stdout.slice(0, marker) : stdout;
  const fields: Record<string, string> = {};
  for (const line of header.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  const out: Omit<LiveDiffRecord, "runId" | "at" | "baseLabel"> = {
    ...(fields.at ? { sandboxAt: fields.at } : {}),
    ...(fields.head && /^[0-9a-f]{40,64}$/.test(fields.head) ? { head: fields.head } : {}),
    ...(fields.base && /^[0-9a-f]{40,64}$/.test(fields.base) ? { base: fields.base } : {}),
  };
  if (fields.error) return { ...out, error: fields.error };
  if (marker < 0) return { ...out, error: "The workspace did not answer the diff request." };
  const raw = stdout.slice(marker + "--- diff\n".length);
  const bytes = Buffer.from(raw, "utf8");
  const truncated = bytes.length > limit;
  const body = truncated ? bytes.subarray(0, limit).toString("utf8") : raw;
  return {
    ...out,
    digest: createHash("sha256").update(bytes.subarray(0, limit)).digest("hex").slice(0, 16),
    output: safeForDisplay(body, limit + 500),
    truncated,
  };
}

function fitDiff(record: LiveDiffRecord): LiveDiffRecord {
  let out = record;
  for (let i = 0; i < 12 && rowBytes(out) > ROW_BYTES_LIMIT && out.output !== undefined && out.output !== ""; i++) {
    const keep = Math.floor(out.output.length * (ROW_BYTES_LIMIT / rowBytes(out)) * 0.9);
    out = { ...out, output: out.output.slice(0, keep), truncated: true };
  }
  return out;
}

/** The run's base, from its recorded repo-setup step. */
export function liveDiffBase(events: { type: string; name?: string; data?: unknown }[]): { spec: { sha: string } | { branch: string }; label: string } | null {
  const setup = events.find((e) => e.type === "step-completed" && e.name === "repo-setup");
  const result = (setup?.data as { result?: { base?: unknown; headSha?: unknown } } | undefined)?.result;
  if (result === undefined || result === null) return null;
  if (typeof result.headSha === "string" && /^[0-9a-f]{7,64}$/.test(result.headSha))
    return { spec: { sha: result.headSha }, label: "the pull request head this run checked out" };
  if (typeof result.base === "string" && result.base !== "")
    return { spec: { branch: result.base }, label: `the merge-base of HEAD with origin/${result.base}` };
  return null;
}

type LiveDiffRuntime = {
  config: Pick<RuntimeConfigStore, "get" | "set" | "remove" | "list">;
  loadMeta: (runId: string) => Promise<{ status: string } | null>;
  store: { load: (runId: string) => Promise<{ type: string; name?: string; data?: unknown }[]> };
};

/**
 * Worker side of the running diff: for every watched, active run, refresh its
 * diff snapshot. Bounded per sweep and per run; abandoned watches and settled
 * runs are cleaned up. Callers invoke it only when the flag is on.
 */
export async function serveLiveDiffs(
  runtime: LiveDiffRuntime,
  executor: Pick<ExecutorProvider, "attach">,
  options: { now?: () => number; minIntervalMs?: number; watchTtlMs?: number; maxPerSweep?: number } = {},
): Promise<{ served: string[]; errors: string[] }> {
  const now = options.now ?? Date.now;
  const minInterval = options.minIntervalMs ?? LIVE_DIFF_MIN_INTERVAL_MS;
  const ttl = options.watchTtlMs ?? LIVE_WATCH_TTL_MS;
  const cap = options.maxPerSweep ?? LIVE_DIFF_MAX_PER_SWEEP;
  const served: string[] = [];
  const errors: string[] = [];
  const watches = (await runtime.config.list()).filter((e) => e.key.startsWith(LIVE_WATCH_PREFIX) && e.set);
  for (const entry of watches) {
    if (served.length >= cap) break;
    const runId = entry.key.slice(LIVE_WATCH_PREFIX.length);
    try {
      if (!RUN_ID.test(runId)) {
        await runtime.config.remove(entry.key);
        continue;
      }
      const raw = await runtime.config.get(entry.key);
      let watch: LiveWatch | null = null;
      try {
        watch = raw ? (JSON.parse(raw) as LiveWatch) : null;
      } catch {
        watch = null;
      }
      if (watch === null || !(now() - Date.parse(watch.at) <= ttl)) {
        await runtime.config.remove(entry.key);
        continue;
      }
      const meta = await runtime.loadMeta(runId);
      if (meta === null || TERMINAL.has(meta.status) || meta.status === "cancelling") {
        await runtime.config.remove(entry.key);
        continue;
      }
      const priorRaw = await runtime.config.get(liveDiffKey(runId));
      if (priorRaw) {
        try {
          const prior = JSON.parse(priorRaw) as LiveDiffRecord;
          if (now() - Date.parse(prior.at) < minInterval) continue;
        } catch {
          // unreadable prior — recompute
        }
      }
      served.push(runId);
      const record = await computeLiveDiff(runtime, executor, runId, now);
      await runtime.config.set(liveDiffKey(runId), JSON.stringify(fitDiff(record)));
    } catch (e) {
      errors.push(`${runId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { served, errors };
}

async function computeLiveDiff(
  runtime: LiveDiffRuntime,
  executor: Pick<ExecutorProvider, "attach">,
  runId: string,
  now: () => number,
): Promise<LiveDiffRecord> {
  const record: LiveDiffRecord = { runId, at: new Date(now()).toISOString() };
  const events = await runtime.store.load(runId);
  const handle = latestSandboxHandle(events);
  const base = liveDiffBase(events);
  if (handle === undefined || base === null) return { ...record, error: "The workspace is not checked out yet." };
  // A held workspace refuses unfenced execs; the takeover panel has its own diff.
  const takeover = await loadTakeover(runtime.config, runId).catch(() => null);
  if (takeover !== null) return { ...record, baseLabel: base.label, error: "A person holds this workspace; the running diff resumes after handback." };
  try {
    const r = await executor.attach(handle).exec(liveDiffCommand(base.spec), { timeoutMs: 10_000, maxOutputBytes: LIVE_DIFF_LIMIT * 2 });
    if (r.exitCode !== 0) return { ...record, baseLabel: base.label, error: "The workspace is unavailable. The sandbox may have expired." };
    return { ...record, baseLabel: base.label, ...parseLiveDiff(r.stdout) };
  } catch (e) {
    return { ...record, baseLabel: base.label, error: safeForDisplay(`The workspace could not be read: ${e instanceof Error ? e.message : String(e)}`, 300) };
  }
}

// ── Read side (web) ─────────────────────────────────────────────────────

export interface LiveViewState {
  output: LiveOutputRecord | null;
  diff: LiveDiffRecord | null;
}

/**
 * What the run page shows. Re-redacted on read with the reader's own
 * environment (the web container holds secrets the worker does not, and the
 * reverse), and the heartbeat is refreshed for an active run so the worker
 * keeps its diff current while somebody is looking.
 */
export async function readLiveView(
  config: Pick<RuntimeConfigStore, "get" | "set">,
  runId: string,
  options: { active: boolean; by: string; now?: () => number },
): Promise<LiveViewState> {
  if (!RUN_ID.test(runId)) throw new Error("Run not found");
  const now = options.now ?? Date.now;
  const parse = <T>(raw: string | undefined): T | null => {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };
  const [outputRaw, diffRaw, watchRaw] = await Promise.all([
    config.get(liveOutputKey(runId)),
    config.get(liveDiffKey(runId)),
    options.active ? config.get(liveWatchKey(runId)) : Promise.resolve(undefined),
  ]);
  if (options.active) {
    const watch = parse<LiveWatch>(watchRaw);
    if (watch === null || !(now() - Date.parse(watch.at) < LIVE_WATCH_REFRESH_MS)) {
      const next: LiveWatch = { at: new Date(now()).toISOString(), by: options.by };
      await config.set(liveWatchKey(runId), JSON.stringify(next)).catch(() => {});
    }
  }
  const output = parse<LiveOutputRecord>(outputRaw);
  const diff = parse<LiveDiffRecord>(diffRaw);
  return {
    output:
      output === null
        ? null
        : { ...output, command: safeForDisplay(String(output.command ?? ""), 300), output: safeForDisplay(String(output.output ?? ""), LIVE_OUTPUT_LIMIT + 500) },
    diff:
      diff === null
        ? null
        : {
            ...diff,
            ...(diff.output !== undefined ? { output: safeForDisplay(String(diff.output), LIVE_DIFF_LIMIT + 500) } : {}),
            ...(diff.error !== undefined ? { error: safeForDisplay(String(diff.error), 300) } : {}),
          },
  };
}

/** Drop a run's live rows (it settled). Best-effort. */
export async function clearLiveView(config: Pick<RuntimeConfigStore, "remove">, runId: string): Promise<void> {
  await Promise.all([
    config.remove(liveOutputKey(runId)).catch(() => {}),
    config.remove(liveDiffKey(runId)).catch(() => {}),
    config.remove(liveWatchKey(runId)).catch(() => {}),
  ]);
}
