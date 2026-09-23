/**
 * Worker-side workspace requests: the read-only inspections and every mediated
 * takeover operation (lease-fenced, renewed on use). The dashboard never
 * receives worker or sandbox credentials — it names WHO asks (`by`), and the
 * lease credential stays in this process.
 */
import { randomUUID } from "node:crypto";
import type { ShipRuntime } from "./runtime.js";
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
  kind?: WorkspaceRequest["kind"];
  path?: string;
  truncated?: boolean;
  /** takeover-console: true while the command still runs (progressive reply writes). */
  running?: boolean;
  /** Takeover ops: the live lease state after the operation. */
  takeover?: { holder: string; generation: number; expiresAt: string };
  /** takeover-browser: the bounded screenshot (base64) and page state for the BROWSER tab's <img>. */
  browser?: { image?: string; url?: string; width?: number; height?: number; format?: string };
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

/** A submitted console command is one line of intent, not a pasted script. */
export const TAKEOVER_CONSOLE_COMMAND_LIMIT = 2000;
/** Console commands are bounded the same way every takeover exec is. */
export const TAKEOVER_CONSOLE_TIMEOUT_MS = 120_000;

export async function requestWorkspace(
  runtime: Pick<ShipRuntime, "config" | "loadMeta">,
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
  await runtime.config.set(requestKey(runId), JSON.stringify(request), by);
  return request;
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
  return `head -c ${TAKEOVER_CONTENT_LIMIT + 1} ${quote("./" + path)} | base64 | tr -d '\\n'`;
}
/** Console scrollback keeps the TAIL — the head of a long run is what a bounded buffer can spare. */
export function tailKeep(text: string, max: number): string {
  return text.length <= max ? text : text.slice(-max);
}
export async function serveWorkspaceRequests(
  runtime: ShipRuntime,
  executor: ExecutorProvider,
  policy: RepoPolicyConfig = policyFromEnv(),
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
  await sweepLapsedTakeovers(runtime, executor).catch(() => {});
  let processed = 0;
  for (const entry of requests) {
    const raw = await runtime.config.get(entry.key);
    if (!raw) continue;
    const req = JSON.parse(raw) as WorkspaceRequest;
    if (TAKEOVER_KINDS.has(req.kind)) {
      if (++processed > 30) break;
      // Same id-dedupe as the read-only path: a request key persists until
      // replaced, so the reply key is what says "already served".
      const prior = await runtime.config.get(takeoverReplyKey(req.runId));
      if (prior !== undefined && prior !== null && prior !== "") {
        try {
          if ((JSON.parse(prior) as WorkspaceReply).id === req.id) continue;
        } catch {
          // unreadable prior reply — serve the request
        }
      }
      await serveTakeoverRequest(runtime, executor, effective, req);
      continue;
    }
    const previous = await workspaceReply(runtime, req.runId);
    if (previous?.id === req.id) continue;
    if (++processed > 30) break;
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
    // The result id binds it to a request; a newer request cannot consume an older response.
    await runtime.config.set(replyKey(req.runId), JSON.stringify(reply));
    if (req.kind !== "forge") await runtime.config.set("SHIP_WORKSPACE_INSPECTION_" + req.runId, JSON.stringify(reply));
    if (req.kind === "forge")
      await runtime.config.set(
        "SHIP_FORGE_STATE_" + req.runId,
        JSON.stringify(reply),
      );
  }
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
): Promise<void> {
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
      await runtime.config.set(takeoverReplyKey(req.runId), JSON.stringify(reply));
      return;
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
      if (req.content === undefined) throw new Error("File content is required.");
      try {
        await renew();
        await lease.writeFileAs(handle, cred, target, Buffer.from(req.content, "utf8"));
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
      reply.output = `Wrote ${target} (${Buffer.byteLength(req.content, "utf8")} bytes). Uncommitted, like every takeover edit.`;
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
        const r = await lease.execAs(handle, cred, takeoverReadCommand(target), { timeoutMs: 15000 });
        if (r.exitCode !== 0 || r.stdout === "")
          throw new Error("Could not read that file — check the path exists in the workspace.");
        const bytes = Buffer.from(r.stdout.replace(/\s+/g, ""), "base64");
        if (bytes.length > TAKEOVER_CONTENT_LIMIT)
          throw new Error(`File is larger than the ${TAKEOVER_CONTENT_LIMIT}-character edit cap.`);
        if (bytes.includes(0))
          throw new Error("That looks like a binary file; the editor opens text only.");
        reply.output = bytes.toString("utf8");
        reply.takeover = { holder: record.holder, generation: record.generation, expiresAt: record.expiresAt };
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
            JSON.stringify({
              ...reply,
              at: new Date().toISOString(),
              running: true,
              output: safeForDisplay(tailKeep(buffered, TAKEOVER_OUTPUT_LIMIT), TAKEOVER_OUTPUT_LIMIT + 200),
              truncated: dropped,
            }),
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
        record.browserOps = [...(record.browserOps ?? []), browserOpSummary(action.action)].slice(
          -TAKEOVER_BROWSER_OPS_LIMIT,
        );
        await saveTakeover(runtime.config, record);
        const summary = browserOpSummary(action.action);
        reply.output = browserReplyOutput(summary, driver.reply);
        if (driver.reply.image !== undefined || driver.reply.url !== undefined) {
          reply.browser = {
            ...(driver.reply.image !== undefined ? { image: driver.reply.image } : {}),
            ...(driver.reply.url !== undefined ? { url: driver.reply.url } : {}),
            ...(driver.reply.width !== undefined ? { width: driver.reply.width } : {}),
            ...(driver.reply.height !== undefined ? { height: driver.reply.height } : {}),
            ...(driver.reply.format !== undefined ? { format: driver.reply.format } : {}),
          };
        }
        reply.takeover = { holder: record.holder, generation: record.generation, expiresAt: record.expiresAt };
      } catch (e) {
        if (lost(e)) {
          await lapseTakeover(runtime, executor, record, e instanceof Error ? e.message : String(e));
          throw new Error("The takeover lease was lost — the browser action did not run under your ownership. Acquire again.");
        }
        throw e;
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
  await runtime.config.set(takeoverReplyKey(req.runId), JSON.stringify(reply));
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
 */
export async function sweepLapsedTakeovers(
  runtime: ShipRuntime,
  executor: ExecutorProvider,
  now = Date.now,
): Promise<void> {
  for (const entry of await runtime.config.list()) {
    if (!entry.key.startsWith("SHIP_TAKEOVER_")) continue;
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
    if (record === null) continue; // reply/history keys live nearby; they are not records
    if (Date.parse(record.expiresAt) > now()) continue;
    const runId = entry.key.slice("SHIP_TAKEOVER_".length);
    await lapseTakeover(runtime, executor, { ...record, runId }, "lease expired");
  }
}
