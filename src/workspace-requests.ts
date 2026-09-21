/** Worker-side, read-only requests. Dashboard never receives worker credentials. */
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
export type WorkspaceRequest = {
  id: string;
  runId: string;
  kind: "forge" | "files" | "file";
  path?: string;
  at: string;
  by: string;
};
export type WorkspaceReply = {
  id: string;
  at: string;
  error?: string;
  forge?: ForgeState;
  output?: string;
};
const PREFIX = "SHIP_WORKSPACE_REQUEST_";
export const requestKey = (runId: string) => PREFIX + runId;
export const replyKey = (runId: string) => "SHIP_WORKSPACE_REPLY_" + runId;
export async function requestWorkspace(
  runtime: Pick<ShipRuntime, "config" | "loadMeta">,
  runId: string,
  kind: WorkspaceRequest["kind"],
  by: string,
  path?: string,
): Promise<WorkspaceRequest> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(runId) || !(await runtime.loadMeta(runId)))
    throw new Error("Run not found");
  if (kind === "file" && (!path || path.length > 500 || path.includes("\0")))
    throw new Error("Choose a file");
  const request: WorkspaceRequest = {
    id: randomUUID(),
    runId,
    kind,
    at: new Date().toISOString(),
    by,
    ...(path ? { path } : {}),
  };
  await runtime.config.set(requestKey(runId), JSON.stringify(request), by);
  return request;
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
  let processed = 0;
  for (const entry of requests) {
    const raw = await runtime.config.get(entry.key);
    if (!raw) continue;
    const req = JSON.parse(raw) as WorkspaceRequest;
    const previous = await workspaceReply(runtime, req.runId);
    if (previous?.id === req.id) continue;
    if (++processed > 30) break;
    const reply: WorkspaceReply = { id: req.id, at: new Date().toISOString() };
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
        if (req.kind !== "files" && req.kind !== "file")
          throw new Error("Unknown workspace request");
        // Snapshot/restore can replace the original handle. Use the latest recorded creation.
        const handles = events.filter(
          (e) =>
            e.type === "step-completed" &&
            (e.name === "sandbox" || /-restore$/.test(e.name ?? "")),
        );
        const handle = (handles.at(-1)?.data as any)?.result;
        if (typeof handle !== "string")
          throw new Error("Workspace is not available yet");
        const r = await executor
          .attach(handle)
          .exec(fileCommand(req.kind === "file" ? req.path : undefined), {
            timeoutMs: 10000,
          });
        if (r.exitCode !== 0 || r.stderr.includes("fatal:"))
          throw new Error(
            "Workspace or file unavailable. The sandbox may have expired.",
          );
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
    if (req.kind === "forge")
      await runtime.config.set(
        "SHIP_FORGE_STATE_" + req.runId,
        JSON.stringify(reply),
      );
  }
}
