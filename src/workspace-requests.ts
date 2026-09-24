/**
 * Worker-side workspace requests: the read-only inspections and every mediated
 * takeover operation (lease-fenced, renewed on use). The dashboard never
 * receives worker or sandbox credentials — it names WHO asks (`by`), and the
 * lease credential stays in this process.
 */
import { randomUUID } from "node:crypto";
import type { ShipRuntime } from "./runtime.js";
import { WORKSPACE_CONTENT_BYTES } from "./workspace-content.js";
import type { ExecutorProvider } from "./durable.js";
import {
  assertRepoAllowed,
  credentialFor,
  policyFromEnv,
  type RepoPolicyConfig,
} from "./repo-policy.js";
import { readForgeState, type ForgeState } from "./forge-state.js";
import { safeForDisplay } from "./redact.js";
import { verificationFactsFromEvents } from "./verification-summary.js";
import {
  TAKEOVER_CONTENT_LIMIT,
  TAKEOVER_OUTPUT_LIMIT,
  TAKEOVER_TTL_SEC,
  appendTakeoverHistory,
  diffEvidence,
  handbackNote,
  latestSandboxHandle,
  loadTakeover,
  mayAcquireTakeover,
  saveTakeover,
  takeoverPathValid,
  takeoverKey,
  takeoverReplyKey,
  type TakeoverRecord,
  type TakeoverSession,
} from "./takeover.js";
import {
  TAKEOVER_BROWSER_OPS_LIMIT,
  TAKEOVER_BROWSER_SCREENSHOT_CAP,
  TAKEOVER_BROWSER_TIMEOUT_MS,
  browserOpCommand,
  browserOpSummary,
  browserReplyOutput,
  encodeBrowserAction,
  parseBrowserAction,
  parseDriverReply,
  type BrowserAction,
  type BrowserDriverReply,
} from "./takeover-browser.js";
export type WorkspaceRequest = {
  id: string;
  runId: string;
  kind:
    | "forge"
    | "files"
    | "file"
    | "changes"
    | "takeover-acquire"
    | "takeover-renew"
    | "takeover-write"
    | "takeover-exec"
    | "takeover-read"
    | "takeover-console"
    | "takeover-browser"
    | "takeover-changes"
    | "takeover-release";
  path?: string;
  at: string;
  by: string;
  /** takeover-write: the file's full new content. */
  content?: string;
  contentStored?: boolean;
  /** takeover-release: the holder's handback note, recorded with the session. */
  reason?: string;
  /** takeover-console: the submitted command. */
  command?: string;
  /** takeover-browser: the parsed, validated browser action (takeover-browser.ts). */
  browser?: BrowserAction;
};
export type WorkspaceReply = {
  id: string;
  at: string;
  error?: string;
  forge?: ForgeState;
  output?: string;
  contentStored?: boolean;
  kind?: WorkspaceRequest["kind"];
  path?: string;
  truncated?: boolean;
  /** takeover-console: true while the command still runs (progressive reply writes). */
  running?: boolean;
  /** Takeover ops: the live lease state after the operation. */
  takeover?: { holder: string; generation: number; expiresAt: string };
  /**
   * takeover-browser: page state plus a REFERENCE to the screenshot. The image
   * itself lives in the run's artifact store (served by the authenticated
   * /api/artifacts/<id> route) — never inline here: this reply is a
   * ship_runtime_config row, and Nucleus refuses rows past ~16 KiB.
   */
  browser?: { artifact?: string; url?: string; width?: number; height?: number; format?: string; bytes?: number };
};
const PREFIX = "SHIP_WORKSPACE_REQUEST_";
const TAKEOVER_KINDS = new Set([
  "takeover-acquire",
  "takeover-renew",
  "takeover-write",
  "takeover-exec",
  "takeover-read",
  "takeover-console",
  "takeover-browser",
  "takeover-changes",
  "takeover-release",
]);
export const requestKey = (runId: string) => PREFIX + runId;
export const replyKey = (runId: string) => "SHIP_WORKSPACE_REPLY_" + runId;

/**
 * The largest JSON value (bytes) written to one workspace request or reply
 * row. These rows live in ship_runtime_config, and Nucleus refuses an inline
 * row past ~16 KiB ("row too large for inline storage"); a refused UPDATE of
 * an existing row also leaves that row in a state where the next UPDATE loses
 * it (logged in UPSTREAM_BUGS.md, 2026-09-23). Everything written here is
 * fitted under this bound first, so no reply can poison its own key.
 */
export const WORKSPACE_ROW_BYTES_LIMIT = 14_000;
/** A reply whose store write fails is re-tried this many times (never re-executed), then recorded as a terminal failure. */
export const REPLY_WRITE_ATTEMPTS = 3;

const rowBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * Fit a reply under WORKSPACE_ROW_BYTES_LIMIT. Display output is trimmed
 * (tail for console/exec, head otherwise) and marked truncated; the editor's
 * read is REFUSED instead — its content round-trips into a write, and a
 * shortened file saved back would be silent data loss.
 */
export function fitReply(reply: WorkspaceReply): WorkspaceReply {
  const size = rowBytes(reply);
  if (size <= WORKSPACE_ROW_BYTES_LIMIT) return reply;
  const bare: WorkspaceReply = {
    id: reply.id,
    at: reply.at,
    ...(reply.kind !== undefined ? { kind: reply.kind } : {}),
    ...(reply.path !== undefined ? { path: reply.path } : {}),
    ...(reply.takeover !== undefined ? { takeover: reply.takeover } : {}),
  };
  if (reply.kind === "takeover-read" && reply.error === undefined) {
    return {
      ...bare,
      error: `That file is too large to open in the editor (${size} bytes through the reply store, which carries about ${WORKSPACE_ROW_BYTES_LIMIT}). Nothing was opened; edit it from the console.`,
    };
  }
  if (typeof reply.output === "string" && reply.output !== "") {
    const tail = reply.kind === "takeover-console" || reply.kind === "takeover-exec";
    let output = reply.output;
    for (let i = 0; i < 12 && output !== ""; i++) {
      const over = rowBytes({ ...reply, output, truncated: true });
      if (over <= WORKSPACE_ROW_BYTES_LIMIT) break;
      const keep = Math.floor(output.length * (WORKSPACE_ROW_BYTES_LIMIT / over) * 0.95);
      output = tail ? output.slice(output.length - keep) : output.slice(0, keep);
    }
    const trimmed: WorkspaceReply = { ...reply, output, truncated: true };
    if (rowBytes(trimmed) <= WORKSPACE_ROW_BYTES_LIMIT) return trimmed;
  }
  return { ...bare, error: `The result was too large to store (${size} bytes; the reply store carries about ${WORKSPACE_ROW_BYTES_LIMIT}).` };
}

/**
 * Store a browser screenshot in the run's artifact store and return its id.
 * A missing store or a failed write is an ERROR on the reply — the action
 * ran, only its picture was not kept — never a retry of the action.
 */
async function storeScreenshot(
  runtime: Pick<ShipRuntime, "artifacts">,
  runId: string,
  image: string,
  format: string | undefined,
): Promise<{ id: string; bytes: number }> {
  if (runtime.artifacts === undefined)
    throw new Error("The browser action ran, but this install has no artifact store to keep its screenshot in.");
  const bytes = Buffer.from(image, "base64");
  try {
    const id = await runtime.artifacts.put(`takeover-${runId}-${Date.now()}.${format === "jpeg" ? "jpg" : "png"}`, bytes);
    return { id, bytes: bytes.length };
  } catch (e) {
    throw new Error(
      `The browser action ran, but its screenshot could not be stored (${(e instanceof Error ? e.message : String(e)).slice(0, 200)}). Take another action to refresh it.`,
    );
  }
}

/** A reply computed but not yet stored: re-delivered on later ticks, never re-executed. */
export type PendingReply = {
  id: string;
  runId: string;
  kind: WorkspaceRequest["kind"];
  requestKey: string;
  /** Rows to write, the served-marker LAST (a partial delivery must not read as served). */
  writes: { key: string; reply: WorkspaceReply }[];
  attempts: number;
};
/** Per-worker-process ledger of undelivered replies (a restart forgets it; the 120 s request expiry then bounds the re-serve). */
const undeliveredReplies = new Map<string, PendingReply>();

/** A submitted console command is one line of intent, not a pasted script. */
export const TAKEOVER_CONSOLE_COMMAND_LIMIT = 2000;
/** Console commands are bounded the same way every takeover exec is. */
export const TAKEOVER_CONSOLE_TIMEOUT_MS = 120_000;

export async function requestWorkspace(
  runtime: Pick<ShipRuntime, "config" | "loadMeta" | "workspaceContent">,
  runId: string,
  kind: WorkspaceRequest["kind"],
  by: string,
  path?: string,
  extra?: { content?: string; reason?: string; command?: string; browser?: string },
): Promise<WorkspaceRequest> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId) || !(await runtime.loadMeta(runId)))
    throw new Error("Run not found");
  if (kind === "file" && (!path || path.length > 500 || path.includes("\0")))
    throw new Error("Choose a file");
  const content = extra?.content;
  if (kind === "takeover-write") {
    if (!path || path.length > 500 || path.includes("\0")) throw new Error("Choose a file to write");
    if (content === undefined || content.length > TAKEOVER_CONTENT_LIMIT)
      throw new Error(`File content is required, up to ${TAKEOVER_CONTENT_LIMIT} characters`);
    if (Buffer.byteLength(content, "utf8") > WORKSPACE_CONTENT_BYTES)
      throw new Error(`File content is limited to ${WORKSPACE_CONTENT_BYTES} UTF-8 bytes`);
  }
  if (kind === "takeover-read" && (!path || path.length > 500 || path.includes("\0")))
    throw new Error("Choose a file to open");
  if (kind === "takeover-console") {
    const command = extra?.command;
    if (command === undefined || command.trim() === "")
      throw new Error("Enter a command to run");
    if (command.length > TAKEOVER_CONSOLE_COMMAND_LIMIT || command.includes("\0"))
      throw new Error(`Console commands are limited to ${TAKEOVER_CONSOLE_COMMAND_LIMIT} characters`);
  }
  let browser: BrowserAction | undefined;
  if (kind === "takeover-browser") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(extra?.browser ?? "");
    } catch {
      throw new Error("Invalid browser action.");
    }
    const action = parseBrowserAction(parsed);
    if (!action.ok) throw new Error(action.reason);
    browser = action.action;
  }
  if (kind === "takeover-release" && extra?.reason !== undefined && extra.reason.length > 4000)
    throw new Error("Handback note must be under 4000 characters");
  const request: WorkspaceRequest = {
    id: randomUUID(),
    runId,
    kind,
    at: new Date().toISOString(),
    by,
    ...(path ? { path } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
    ...(extra?.command !== undefined ? { command: extra.command } : {}),
    ...(browser !== undefined ? { browser } : {}),
  };
  if (rowBytes(request) > WORKSPACE_ROW_BYTES_LIMIT && kind === "takeover-write" && runtime.workspaceContent) {
    await runtime.workspaceContent.put(runId, request.id, content!);
    delete request.content;
    request.contentStored = true;
  }
  if (rowBytes(request) > WORKSPACE_ROW_BYTES_LIMIT)
    throw new Error(
      `That is too large to send through the workspace request store (${rowBytes(request)} bytes; it carries about ${WORKSPACE_ROW_BYTES_LIMIT}). Edit large files from the console.`,
    );
  await runtime.config.set(requestKey(runId), JSON.stringify(request), by);
  return request;
}

/** Rehydrate only editor replies, through the same authenticated run surface. */
export async function resolveEditorReply(
  runtime: Pick<ShipRuntime, "workspaceContent">, runId: string, reply: WorkspaceReply,
): Promise<WorkspaceReply> {
  if (reply.kind !== "takeover-read" || !reply.contentStored || reply.error) return reply;
  try {
    if (!runtime.workspaceContent) throw new Error("This install cannot retrieve editor content; open the file from the console");
    return { ...reply, output: await runtime.workspaceContent.get(runId, reply.id) };
  } catch (e) {
    return { ...reply, output: undefined, error: e instanceof Error ? e.message : String(e) };
  }
}
/** Keep inspections visible when background forge refreshes finish. */
export async function workspaceInspection(runtime: Pick<ShipRuntime, "config">, runId: string): Promise<WorkspaceReply | null> {
  const raw = await runtime.config.get("SHIP_WORKSPACE_INSPECTION_" + runId);
  if (raw) return JSON.parse(raw);
  const prior = await workspaceReply(runtime, runId);
  return prior?.output !== undefined ? prior : null;
}
export async function workspaceReply(
  runtime: Pick<ShipRuntime, "config">,
  runId: string,
): Promise<WorkspaceReply | null> {
  const raw = await runtime.config.get(replyKey(runId));
  return raw ? JSON.parse(raw) : null;
}
/** Refresh visible PRs without a manual click. Never displace an in-flight file request. */
export async function refreshForgeIfStale(
  runtime: Pick<ShipRuntime, "config" | "loadMeta">,
  runId: string,
  by: string,
  now = Date.now(),
): Promise<void> {
  const cached = await runtime.config.get("SHIP_FORGE_STATE_" + runId);
  if (cached) {
    const reply = JSON.parse(cached) as WorkspaceReply;
    if (now - Date.parse(reply.at) < (reply.error ? 60000 : 30000)) return;
  }
  const raw = await runtime.config.get(requestKey(runId));
  if (raw) {
    const pending = JSON.parse(raw) as WorkspaceRequest;
    const reply = await workspaceReply(runtime, runId);
    if (reply?.id !== pending.id && now - Date.parse(pending.at) < 120000) return;
  }
  await requestWorkspace(runtime, runId, "forge", by);
}
/** Fixed read-only command: names of untracked files, tracked edits against HEAD.
 * Disable configured external helpers: inspecting must never run repository hooks.
 * Untracked file contents are deliberately not read.
 */
export function changesCommand(): string {
  const git = "git --no-optional-locks --no-pager -c core.fsmonitor=false -c core.untrackedCache=false";
  return `(${git} status --short --untracked-files=normal --ignore-submodules=all && ${git} diff --no-ext-diff --no-textconv --ignore-submodules=all HEAD --) | head -c 10001`;
}
/** Reads tracked files only; git show cannot follow working-tree symlinks or read .env files outside the repository. */
export function fileCommand(path?: string): string {
  if (path === undefined) return "git ls-files | head -200";
  if (
    !path ||
    path.length > 500 ||
    path.startsWith("/") ||
    path.split("/").some((p) => p === ".." || p === ".git") ||
    /[\x00-\x1f]/.test(path)
  )
    throw new Error("Invalid repository path");
  const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  return `git --no-pager show --no-ext-diff --no-textconv ${quote("HEAD:" + path)} | head -c 10000`;
}
/**
 * The editor's bounded read, run under the lease credential (a held workspace
 * refuses unfenced reads, so execAs is the ONLY read surface it has). base64
 * carries the bytes intact through the exec's text frames; one byte past the
 * cap is requested so an over-limit file is detected, not silently shortened.
 * The `./` prefix keeps a dash-leading name an argument, not an option.
 */
export function takeoverReadCommand(path: string): string {
  const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  const command = `head -c ${TAKEOVER_CONTENT_LIMIT + 1} ${quote("./" + path)} | base64 | tr -d '\\n'`;
  return `bash -o pipefail -c ${quote(command)}`;
}
/** Console scrollback keeps the TAIL — the head of a long run is what a bounded buffer can spare. */
export function tailKeep(text: string, max: number): string {
  return text.length <= max ? text : text.slice(-max);
}
const contentPruneAt = new WeakMap<object, number>();
export async function serveWorkspaceRequests(
  runtime: ShipRuntime,
  executor: ExecutorProvider,
  policy: RepoPolicyConfig = policyFromEnv(),
  ledger: Map<string, PendingReply> = undeliveredReplies,
): Promise<void> {
  const requests = (await runtime.config.list()).filter((k) =>
    k.key.startsWith(PREFIX),
  );
  const projects = (await runtime.projects.list()).flatMap((p) =>
    p.url ? [p.url] : [],
  );
  const effective = {
    ...policy,
    projects: [...(policy.projects ?? []), ...projects],
  };
  // Every leg and every request is isolated: one record that cannot be read,
  // served or stored is reported and skipped, never allowed to stop the
  // records after it in the same tick (the 2026-09-23 storm was one
  // unstorable reply re-served every tick). Failures surface as ONE thrown
  // summary at the end, which the worker logs.
  const failures: string[] = [];
  if (runtime.workspaceContent && Date.now() >= (contentPruneAt.get(runtime.workspaceContent) ?? 0)) {
    contentPruneAt.set(runtime.workspaceContent, Date.now() + 60 * 60 * 1000);
    try { await runtime.workspaceContent.prune(); }
    catch (e) { failures.push(`editor content cleanup: ${e instanceof Error ? e.message : String(e)}`); }
  }
  for (const e of await sweepLapsedTakeovers(runtime, executor)) failures.push(e);
  let processed = 0;
  for (const entry of requests) {
    try {
      const raw = await runtime.config.get(entry.key);
      if (!raw) continue;
      let req: WorkspaceRequest;
      try {
        req = JSON.parse(raw) as WorkspaceRequest;
      } catch {
        // An unreadable request can never be served; clearing it is the only
        // way it stops being read every tick.
        await runtime.config.set(entry.key, "");
        failures.push(`${entry.key}: unreadable request cleared`);
        continue;
      }
      const takeover = TAKEOVER_KINDS.has(req.kind);
      // A request key persists until replaced, so the reply key is what says
      // "already served" — the same id-dedupe on both surfaces.
      const markerKey = takeover ? takeoverReplyKey(req.runId) : replyKey(req.runId);
      const prior = await runtime.config.get(markerKey);
      if (prior !== undefined && prior !== null && prior !== "") {
        try {
          if ((JSON.parse(prior) as WorkspaceReply).id === req.id) {
            ledger.delete(req.id);
            continue;
          }
        } catch {
          // unreadable prior reply — serve the request
        }
      }
      if (++processed > 30) break;
      // Served but not yet stored: deliver again, never re-execute. A browser
      // click or console command run twice because its reply write failed is
      // a second action nobody asked for — and each re-run renewed the lease,
      // which is why the stuck takeover never lapsed.
      const pending = ledger.get(req.id);
      if (pending !== undefined) {
        await deliverReply(runtime, pending, ledger);
        continue;
      }
      const writes: PendingReply["writes"] = [];
      if (takeover) {
        writes.push({ key: markerKey, reply: await serveTakeoverRequest(runtime, executor, effective, req) });
      } else {
        const reply = await serveReadOnlyRequest(runtime, executor, effective, req);
        if (req.kind === "forge") writes.push({ key: "SHIP_FORGE_STATE_" + req.runId, reply });
        else writes.push({ key: "SHIP_WORKSPACE_INSPECTION_" + req.runId, reply });
        // The result id binds it to a request; a newer request cannot consume an older response.
        writes.push({ key: markerKey, reply });
      }
      await deliverReply(runtime, { id: req.id, runId: req.runId, kind: req.kind, requestKey: entry.key, writes, attempts: 0 }, ledger);
    } catch (e) {
      failures.push(`${entry.key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("; ").slice(0, 2000));
}

/**
 * Store a computed reply: fitted under the row bound, re-tried on later ticks
 * up to REPLY_WRITE_ATTEMPTS, then TERMINAL — a small failure reply takes the
 * marker key (cleared first, which is what recovers a row a refused write
 * left unwritable), and if even that cannot be stored the request itself is
 * cleared so it is never served again. Bounded either way: one poisoned
 * record can no longer hammer every tick.
 */
async function deliverReply(
  runtime: Pick<ShipRuntime, "config">,
  pending: PendingReply,
  ledger: Map<string, PendingReply>,
): Promise<void> {
  try {
    for (const w of pending.writes) await runtime.config.set(w.key, JSON.stringify(fitReply(w.reply)));
    ledger.delete(pending.id);
    return;
  } catch (e) {
    const reason = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    pending.attempts += 1;
    if (pending.attempts < REPLY_WRITE_ATTEMPTS) {
      ledger.set(pending.id, pending);
      throw new Error(`reply ${pending.id} not stored (attempt ${pending.attempts}/${REPLY_WRITE_ATTEMPTS}): ${reason}`);
    }
    ledger.delete(pending.id);
    const marker = pending.writes.at(-1)!.key;
    const failure: WorkspaceReply = {
      id: pending.id,
      at: new Date().toISOString(),
      kind: pending.kind,
      error: safeForDisplay(
        `This request was served, but its result could not be stored after ${REPLY_WRITE_ATTEMPTS} attempts (${reason}). Check the workspace before repeating it.`,
        600,
      ),
    };
    const recorded = await runtime.config
      .set(marker, "")
      .then(() => runtime.config.set(marker, JSON.stringify(failure)))
      .then(
        () => true,
        () => false,
      );
    if (recorded)
      throw new Error(`reply ${pending.id} abandoned after ${REPLY_WRITE_ATTEMPTS} attempts; failure recorded on ${marker}: ${reason}`);
    await runtime.config.set(pending.requestKey, "").catch(() => {});
    throw new Error(
      `reply ${pending.id} abandoned after ${REPLY_WRITE_ATTEMPTS} attempts and the failure could not be recorded either; request ${pending.requestKey} cleared: ${reason}`,
    );
  }
}

/** The read-only inspections: forge state, file list, one file, changes. */
async function serveReadOnlyRequest(
  runtime: ShipRuntime,
  executor: ExecutorProvider,
  effective: RepoPolicyConfig,
  req: WorkspaceRequest,
): Promise<WorkspaceReply> {
  const reply: WorkspaceReply = { id: req.id, at: new Date().toISOString(), kind: req.kind, ...(req.path ? { path: req.path } : {}) };
  try {
    if (Date.now() - Date.parse(req.at) > 120000)
      throw new Error("Request expired. Refresh to try again.");
    const events = await runtime.store.load(req.runId);
    const input = (events.find((e) => e.type === "run-started")?.data as any)
      ?.input;
    if (!input?.repo) throw new Error("This run has no repository");
    const ref = assertRepoAllowed(input.repo, {
      trust: "external",
      config: effective,
    });
    if (req.kind === "forge") {
      const facts = verificationFactsFromEvents(events);
      const pr = facts.pr?.number ?? input.pr;
      if (!pr) throw new Error("No pull request has been published yet");
      reply.forge = await readForgeState(
        ref,
        credentialFor(ref, effective),
        pr,
      );
    } else {
      if (req.kind !== "files" && req.kind !== "file" && req.kind !== "changes")
        throw new Error("Unknown workspace request");
      // Snapshot/restore can replace the original handle. Use the latest recorded creation.
      const handles = events.filter(
        (e) =>
          e.type === "step-completed" &&
          (e.name === "sandbox" || /-restore$/.test(e.name ?? "")),
      );
      const recorded = (handles.at(-1)?.data as any)?.result;
      const handle = typeof recorded === "string" ? recorded : recorded?.handle;
      if (typeof handle !== "string")
        throw new Error("Workspace is not available yet");
      const r = await executor
        .attach(handle)
        .exec(req.kind === "changes" ? changesCommand() : fileCommand(req.kind === "file" ? req.path : undefined), {
          timeoutMs: 10000,
        });
      if (r.exitCode !== 0 || r.stderr.includes("fatal:"))
        throw new Error(
          "Workspace or file unavailable. The sandbox may have expired.",
        );
      reply.truncated = Buffer.byteLength(r.stdout) > 8000;
      reply.output = Buffer.from(safeForDisplay(r.stdout, 10000))
        .subarray(0, 8000)
        .toString("utf8");
    }
  } catch (e) {
    reply.error = safeForDisplay(
      e instanceof Error ? e.message : String(e),
      600,
    );
  }
  return reply;
}

/**
 * One mediated takeover operation. The dashboard's request names WHO is
 * asking (`by`); the lease credential itself never leaves the worker — the
 * daemon is reached only from here, with the record's holder+generation.
 * Every result lands on the takeover reply key, separate from the read-only
 * inspection replies so one surface cannot overwrite the other's state.
 */
async function serveTakeoverRequest(
  runtime: ShipRuntime,
  executor: ExecutorProvider,
  policy: RepoPolicyConfig,
  req: WorkspaceRequest,
): Promise<WorkspaceReply> {
  const reply: WorkspaceReply = { id: req.id, at: new Date().toISOString(), kind: req.kind, ...(req.path ? { path: req.path } : {}) };
  const lease = (executor as ExecutorProvider).lease;
  try {
    if (Date.now() - Date.parse(req.at) > 120000)
      throw new Error("Request expired. Refresh to try again.");
    if (lease === undefined)
      throw new Error("This sandbox provider does not support workspace takeover.");
    const events = await runtime.store.load(req.runId);
    const input = (events.find((e) => e.type === "run-started")?.data as any)?.input;
    if (!input?.repo) throw new Error("This run has no repository");
    assertRepoAllowed(input.repo, { trust: "external", config: policy });
    const handle = latestSandboxHandle(events);
    if (handle === undefined) throw new Error("Workspace is not available yet");

    if (req.kind === "takeover-acquire") {
      const meta = await runtime.loadMeta(req.runId);
      const gate = mayAcquireTakeover(meta);
      if (!gate.ok) throw new Error(gate.reason);
      const existing = await loadTakeover(runtime, req.runId);
      if (existing !== null) {
        if (existing.holder !== req.by)
          throw new Error(`Workspace is held by ${existing.holder} until ${existing.expiresAt}.`);
        reply.takeover = { holder: existing.holder, generation: existing.generation, expiresAt: existing.expiresAt };
      } else {
        const ttlSec = Number(process.env.SHIP_TAKEOVER_TTL_SEC) || TAKEOVER_TTL_SEC;
        const grant = await lease.acquire(handle, req.by, ttlSec);
        const record: TakeoverRecord = {
          runId: req.runId,
          holder: req.by,
          generation: grant.generation,
          acquiredAt: new Date().toISOString(),
          expiresAt: grant.expiresAt,
          ttlSec,
          pathsWritten: [],
          execsRun: [],
        };
        await saveTakeover(runtime.config, record);
        reply.takeover = { holder: record.holder, generation: record.generation, expiresAt: record.expiresAt };
        reply.output = "Takeover held. Writes are exclusive to you; the run stays parked until handback.";
      }
      return reply;
    }

    // Every operation below is holder-only, on a live record.
    const record = await loadTakeover(runtime, req.runId);
    if (record === null) throw new Error("No active takeover. Acquire first.");
    if (record.holder !== req.by)
      throw new Error(`Workspace is held by ${record.holder} until ${record.expiresAt}.`);
    const cred = { owner: record.holder, generation: record.generation };
    /** Renew before acting, so an active operator keeps the lease; a lost one surfaces immediately. */
    const renew = async (): Promise<void> => {
      const { expiresAt } = await lease.renew(handle, cred.owner, cred.generation, record.ttlSec);
      record.expiresAt = expiresAt;
    };
    /** A lease the daemon no longer honours is not held — record the lapse, honestly. */
    const lost = (e: unknown): boolean => {
      const message = e instanceof Error ? e.message : String(e);
      return /no active generation|lease superseded|lease held|not found|no such run/i.test(message);
    };

    if (req.kind === "takeover-renew") {
      try {
        await renew();
        await saveTakeover(runtime.config, record);
        reply.takeover = { holder: record.holder, generation: record.generation, expiresAt: record.expiresAt };
      } catch (e) {
        await lapseTakeover(runtime, executor, record, e instanceof Error ? e.message : String(e));
        throw new Error("The takeover lease was lost — it expired or was superseded. Acquire again if you still need it.");
      }
    } else if (req.kind === "takeover-write") {
      const path = takeoverPathValid(req.path);
      if (!path.ok) throw new Error(path.reason);
      const target = req.path as string;
      const content = req.contentStored
        ? await runtime.workspaceContent?.get(req.runId, req.id)
        : req.content;
      if (content === undefined) throw new Error("File content is required.");
      if (Buffer.byteLength(content, "utf8") > WORKSPACE_CONTENT_BYTES) throw new Error("File content exceeds the editor limit.");
      try {
        await renew();
        await lease.writeFileAs(handle, cred, target, Buffer.from(content, "utf8"));
      } catch (e) {
        if (lost(e)) {
          await lapseTakeover(runtime, executor, record, e instanceof Error ? e.message : String(e));
          throw new Error("The takeover lease was lost before the write — nothing was written. Acquire again.");
        }
        throw e;
      }
      if (!record.pathsWritten.includes(target)) record.pathsWritten.push(target);
      await saveTakeover(runtime.config, record);
      reply.takeover = { holder: record.holder, generation: record.generation, expiresAt: record.expiresAt };
      reply.output = `Wrote ${target} (${Buffer.byteLength(content, "utf8")} bytes). Uncommitted, like every takeover edit.`;
    } else if (req.kind === "takeover-exec") {
      const project = await runtime.projects.forRepo(input.repo).catch(() => null);
      const cmd = project?.testCommand ?? project?.verification?.tests;
      if (cmd === undefined || cmd === "")
        throw new Error("This project declares no tests command (Project settings). Arbitrary commands are not part of this slice.");
      const timeoutMs = project?.testTimeoutMs ?? 300_000;
      try {
        await renew();
        const r = await lease.execAs(handle, cred, cmd, { timeoutMs, maxOutputBytes: 1 << 20 });
        if (!record.execsRun.includes(cmd)) record.execsRun.push(cmd);
        await saveTakeover(runtime.config, record);
        const out = `${r.stdout}\n${r.stderr}`.trim();
        reply.truncated = out.length > TAKEOVER_OUTPUT_LIMIT;
        reply.output = safeForDisplay(`$ ${cmd}\nexit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}\n${out}`, TAKEOVER_OUTPUT_LIMIT + 2000);
        reply.takeover = { holder: record.holder, generation: record.generation, expiresAt: record.expiresAt };
      } catch (e) {
        if (lost(e)) {
          await lapseTakeover(runtime, executor, record, e instanceof Error ? e.message : String(e));
          throw new Error("The takeover lease was lost — the command did not run under your ownership. Acquire again.");
        }
        throw e;
      }
    } else if (req.kind === "takeover-read") {
      // The editor's read. Bounded to the write cap so whatever opens can
      // save, refused when binary, and carried VERBATIM (no redaction pass —
      // this content round-trips back through takeover-write, and a rewritten
      // secret would be persisted as the file's new content).
      const path = takeoverPathValid(req.path);
      if (!path.ok) throw new Error(path.reason);
      const target = req.path as string;
      try {
        await renew();
        const r = await lease.execAs(handle, cred, takeoverReadCommand(target), { timeoutMs: 15000, maxOutputBytes: 300_000 });
        if (r.exitCode !== 0 || r.timedOut || r.truncated)
          throw new Error("Could not read that file — check the path exists in the workspace.");
        const bytes = Buffer.from(r.stdout.replace(/\s+/g, ""), "base64");
        if (bytes.length > TAKEOVER_CONTENT_LIMIT)
          throw new Error(`File is larger than the ${TAKEOVER_CONTENT_LIMIT}-byte edit cap.`);
        if (bytes.includes(0))
          throw new Error("That looks like a binary file; the editor opens text only.");
        reply.output = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        reply.takeover = { holder: record.holder, generation: record.generation, expiresAt: record.expiresAt };
        if (rowBytes(reply) > WORKSPACE_ROW_BYTES_LIMIT && runtime.workspaceContent) {
          await runtime.workspaceContent.put(req.runId, req.id, reply.output);
          delete reply.output;
          reply.contentStored = true;
        }
      } catch (e) {
        if (lost(e)) {
          await lapseTakeover(runtime, executor, record, e instanceof Error ? e.message : String(e));
          throw new Error("The takeover lease was lost. Acquire again.");
        }
        throw e;
      }
    } else if (req.kind === "takeover-console") {
      // The console: one submitted command at a time, fenced like every
      // takeover exec. Output streams the way the Now card's does — chunks
      // land on the reply key as they arrive, and the dashboard's existing
      // poll picks them up; there is no PTY and no stdin behind this.
      const command = req.command;
      if (command === undefined || command.trim() === "" || command.length > TAKEOVER_CONSOLE_COMMAND_LIMIT)
        throw new Error(`Console command is required, up to ${TAKEOVER_CONSOLE_COMMAND_LIMIT} characters.`);
      let buffered = "";
      let dropped = false;
      let lastFlush = 0;
      const keep = TAKEOVER_OUTPUT_LIMIT + 2000;
      const flush = (force = false): void => {
        const now = Date.now();
        if (!force && now - lastFlush < 1000) return;
        lastFlush = now;
        void runtime.config
          .set(
            takeoverReplyKey(req.runId),
            JSON.stringify(
              fitReply({
                ...reply,
                at: new Date().toISOString(),
                running: true,
                output: safeForDisplay(tailKeep(buffered, TAKEOVER_OUTPUT_LIMIT), TAKEOVER_OUTPUT_LIMIT + 200),
                truncated: dropped,
              }),
            ),
          )
          .catch(() => {});
      };
      try {
        await renew();
        flush(true);
        const r = await lease.execAs(
          handle,
          cred,
          command,
          { timeoutMs: TAKEOVER_CONSOLE_TIMEOUT_MS, maxOutputBytes: 1 << 20 },
          (_stream, chunk) => {
            buffered += chunk;
            if (buffered.length > keep) {
              buffered = buffered.slice(-keep);
              dropped = true;
            }
            flush();
          },
        );
        if (!record.execsRun.includes(command)) record.execsRun.push(command);
        await saveTakeover(runtime.config, record);
        reply.truncated = dropped || r.truncated;
        reply.output = safeForDisplay(
          `$ ${command}\nexit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}\n${tailKeep(buffered, TAKEOVER_OUTPUT_LIMIT)}`,
          TAKEOVER_OUTPUT_LIMIT + 2000,
        );
        reply.takeover = { holder: record.holder, generation: record.generation, expiresAt: record.expiresAt };
      } catch (e) {
        if (lost(e)) {
          await lapseTakeover(runtime, executor, record, e instanceof Error ? e.message : String(e));
          throw new Error("The takeover lease was lost — the command did not run under your ownership. Acquire again.");
        }
        throw e;
      }
    } else if (req.kind === "takeover-browser") {
      // The BROWSER tab: one action per request through the same fenced
      // execAs as the console. The driver runs inside the sandbox; the
      // screenshot comes back bounded, and every op is recorded in the
      // session like a console command. No lease credential leaves this
      // process, and the dashboard only ever names who asked.
      const action = parseBrowserAction(req.browser);
      if (!action.ok) throw new Error(action.reason);
      let driverReply: BrowserDriverReply;
      try {
        await renew();
        const r = await lease.execAs(
          handle,
          cred,
          browserOpCommand(encodeBrowserAction(action.action)),
          { timeoutMs: TAKEOVER_BROWSER_TIMEOUT_MS, maxOutputBytes: TAKEOVER_BROWSER_SCREENSHOT_CAP + 65_536 },
        );
        const driver = parseDriverReply(r);
        if (!driver.ok) throw new Error(driver.reason);
        driverReply = driver.reply;
        record.browserOps = [...(record.browserOps ?? []), browserOpSummary(action.action)].slice(
          -TAKEOVER_BROWSER_OPS_LIMIT,
        );
        await saveTakeover(runtime.config, record);
      } catch (e) {
        if (lost(e)) {
          await lapseTakeover(runtime, executor, record, e instanceof Error ? e.message : String(e));
          throw new Error("The takeover lease was lost — the browser action did not run under your ownership. Acquire again.");
        }
        throw e;
      }
      reply.takeover = { holder: record.holder, generation: record.generation, expiresAt: record.expiresAt };
      // The picture rides the artifact store and the reply carries only its
      // id: this reply is a ship_runtime_config row, and a ~400 KB base64
      // screenshot inline is what Nucleus refused on 2026-09-23. Stored
      // OUTSIDE the lease-loss handling above (a storage error is not a lost
      // lease), after the op is recorded — a failure here is reported as
      // what it is, never a retry of the action.
      const shot =
        driverReply.image !== undefined
          ? await storeScreenshot(runtime, req.runId, driverReply.image, driverReply.format)
          : undefined;
      reply.output = browserReplyOutput(browserOpSummary(action.action), driverReply);
      if (shot !== undefined || driverReply.url !== undefined) {
        reply.browser = {
          ...(shot !== undefined ? { artifact: shot.id, bytes: shot.bytes } : {}),
          ...(driverReply.url !== undefined ? { url: driverReply.url } : {}),
          ...(driverReply.width !== undefined ? { width: driverReply.width } : {}),
          ...(driverReply.height !== undefined ? { height: driverReply.height } : {}),
          ...(driverReply.format !== undefined ? { format: driverReply.format } : {}),
        };
      }
    } else if (req.kind === "takeover-changes") {
      try {
        await renew();
        const r = await lease.execAs(handle, cred, changesCommand(), { timeoutMs: 15000 });
        await saveTakeover(runtime.config, record);
        reply.truncated = Buffer.byteLength(r.stdout) > TAKEOVER_OUTPUT_LIMIT;
        reply.output = safeForDisplay(r.stdout, TAKEOVER_OUTPUT_LIMIT + 2000);
        reply.takeover = { holder: record.holder, generation: record.generation, expiresAt: record.expiresAt };
      } catch (e) {
        if (lost(e)) {
          await lapseTakeover(runtime, executor, record, e instanceof Error ? e.message : String(e));
          throw new Error("The takeover lease was lost. Acquire again.");
        }
        throw e;
      }
    } else if (req.kind === "takeover-release") {
      let diff = "";
      let diffError: string | undefined;
      try {
        const r = await lease.execAs(handle, cred, changesCommand(), { timeoutMs: 15000 });
        diff = r.stdout;
      } catch {
        diffError = "diff unavailable at handback";
      }
      // If the BROWSER tab was used, close it under the still-held lease:
      // the close op wipes the ephemeral profile (cookies, storage) so
      // nothing browser-shaped survives the session. Best-effort with the
      // disposition recorded — a failed close is reported, not hidden.
      let browserNote: string | undefined;
      if ((record.browserOps?.length ?? 0) > 0) {
        try {
          const r = await lease.execAs(
            handle,
            cred,
            browserOpCommand(encodeBrowserAction({ action: "close" })),
            { timeoutMs: 20_000, maxOutputBytes: 65_536 },
          );
          browserNote =
            r.exitCode === 0 ? "browser closed, profile wiped" : `browser close exited ${r.exitCode}`;
        } catch (e) {
          browserNote = `browser close failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`;
        }
      }
      let outcome: "released" | "lapsed" = "released";
      let outcomeReason: string | undefined;
      try {
        await lease.release(handle, cred.owner, cred.generation);
      } catch (e) {
        // A lease the daemon already dropped was not held — say so.
        outcome = "lapsed";
        outcomeReason = e instanceof Error ? e.message : String(e);
      }
      const evidence = diff !== "" ? diffEvidence(diff) : undefined;
      const noteParts = [req.reason, diffError, outcomeReason, browserNote].filter(
        (x): x is string => typeof x === "string" && x !== "",
      );
      const session: TakeoverSession = {
        holder: record.holder,
        acquiredAt: record.acquiredAt,
        releasedAt: new Date().toISOString(),
        outcome,
        pathsWritten: record.pathsWritten,
        execsRun: record.execsRun,
        ...(record.browserOps !== undefined && record.browserOps.length > 0 ? { browserOps: record.browserOps } : {}),
        ...(evidence !== undefined ? { diffDigest: evidence.digest, diffExcerpt: evidence.excerpt } : {}),
        ...(noteParts.length > 0 ? { note: noteParts.join("; ").slice(0, 4000) } : {}),
      };
      await runtime.config.set(takeoverKey(req.runId), "", req.by);
      await appendTakeoverHistory(runtime.config, req.runId, session);
      // The steer note is the handback the resumed agent reads: what changed,
      // where, and that nothing is committed. Without it the next turn builds
      // on top of invisible edits.
      const meta = await runtime.loadMeta(req.runId);
      if (mayAcquireTakeover(meta).ok) {
        await runtime.steer.add(req.runId, handbackNote(session));
      }
      reply.output =
        outcome === "released"
          ? `Handed back. ${record.pathsWritten.length} file(s) written, ${record.execsRun.length} command(s) run. The resumed run will be told about the edits.`
          : `Handback recorded, but the lease had already lapsed (${outcomeReason}). Edits on disk are preserved; the resumed run will be told about them.`;
      if (evidence !== undefined) reply.output += ` Diff digest ${evidence.digest}.`;
    } else {
      throw new Error("Unknown takeover request");
    }
  } catch (e) {
    reply.error = safeForDisplay(e instanceof Error ? e.message : String(e), 600);
  }
  return reply;
}

/** A takeover the daemon no longer honours: clear the live record, keep the evidence. */
async function lapseTakeover(
  runtime: ShipRuntime,
  executor: ExecutorProvider,
  record: TakeoverRecord,
  reason: string,
): Promise<void> {
  const events = await runtime.store.load(record.runId).catch(() => []);
  const handle = latestSandboxHandle(events);
  if (handle !== undefined) await executor.lease?.release(handle, record.holder, record.generation).catch(() => {});
  // Honest browser disposition on lapse: there is no live lease to close the
  // driver under, so the ephemeral profile stays until the container's own
  // teardown — recorded in the note rather than claimed as cleaned.
  const note =
    (record.browserOps?.length ?? 0) > 0
      ? `${reason.slice(0, 300)}; browser profile left in place — no live lease to close it under; it is container-ephemeral and excluded from the repository`
      : reason.slice(0, 300);
  await runtime.config.set(takeoverKey(record.runId), "", record.holder);
  await appendTakeoverHistory(runtime.config, record.runId, {
    holder: record.holder,
    acquiredAt: record.acquiredAt,
    releasedAt: new Date().toISOString(),
    outcome: "lapsed",
    pathsWritten: record.pathsWritten,
    execsRun: record.execsRun,
    ...(record.browserOps !== undefined && record.browserOps.length > 0 ? { browserOps: record.browserOps } : {}),
    note,
  });
}

/**
 * Expired takeovers become history with outcome `lapsed`: the daemon's TTL
 * ended the lease on its own (that is the revocation path for a browser
 * abandoned mid-edit), so the record must stop claiming the workspace is
 * held. Edits on disk are untouched — only the ownership lapsed.
 *
 * Per-record isolation: a record that cannot be read or lapsed is reported
 * (returned) and skipped, never allowed to stop the records after it.
 */
export async function sweepLapsedTakeovers(
  runtime: ShipRuntime,
  executor: ExecutorProvider,
  now = Date.now,
): Promise<string[]> {
  const failures: string[] = [];
  let entries: { key: string }[];
  try {
    entries = await runtime.config.list();
  } catch (e) {
    return [`takeover sweep: ${e instanceof Error ? e.message : String(e)}`];
  }
  for (const entry of entries) {
    // Only live lease records: reply/history keys share the prefix, and
    // reading a (possibly unreadable) reply row here is what let one poisoned
    // reply stall the sweep.
    if (!entry.key.startsWith("SHIP_TAKEOVER_")) continue;
    if (entry.key.startsWith("SHIP_TAKEOVER_REPLY_") || entry.key.startsWith("SHIP_TAKEOVER_HISTORY_")) continue;
    try {
      const raw = await runtime.config.get(entry.key);
      if (raw === undefined || raw === null || raw === "") continue;
      let record: TakeoverRecord | null = null;
      try {
        const parsed = JSON.parse(raw) as TakeoverRecord;
        if (typeof parsed.holder === "string" && typeof parsed.generation === "number" && typeof parsed.expiresAt === "string")
          record = parsed;
      } catch {
        record = null;
      }
      if (record === null) continue;
      if (Date.parse(record.expiresAt) > now()) continue;
      const runId = entry.key.slice("SHIP_TAKEOVER_".length);
      await lapseTakeover(runtime, executor, { ...record, runId }, "lease expired");
    } catch (e) {
      failures.push(`${entry.key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return failures;
}
