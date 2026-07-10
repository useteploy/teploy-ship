import type { ProposeInput } from "./intake.js";

/**
 * A4 — task mapping for the chat/PM intake sources. Pure functions (the
 * web hook routes stay thin dialect adapters): given a verified payload,
 * produce the ONE task shape intake.propose() takes, or null when the
 * event isn't for us. Repo binding: chat messages and issue bodies carry
 * no repository, so both sources support an explicit `repo:<clone-url>`
 * token anywhere in the text.
 */

const REPO_TOKEN = /(?:^|\s)repo:(https?:\/\/\S+)/i;

/** Extract a `repo:<url>` binding from free text. */
export function parseRepoToken(text: string): string | undefined {
  const match = REPO_TOKEN.exec(text);
  // URLs contain dots; trailing sentence punctuation does not belong.
  return match?.[1]?.replace(/[),.;:!?\]]+$/, "");
}

/**
 * A Slack app_mention → task. Strips the bot mention, binds an optional
 * repo token, dedupes on the message's channel+ts (Slack retries deliver
 * the same ts).
 */
export function slackTaskFromMention(event: {
  text?: string;
  channel?: string;
  ts?: string;
}): ProposeInput | null {
  const raw = (event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
  if (raw === "" || event.channel === undefined || event.ts === undefined) return null;
  const repo = parseRepoToken(raw);
  const cleaned = repo !== undefined ? raw.replace(REPO_TOKEN, " ").replace(/\s+/g, " ").trim() : raw;
  if (cleaned === "") return null;
  return {
    source: "slack",
    kind: "mention",
    title: cleaned.length > 140 ? `${cleaned.slice(0, 140)}…` : cleaned,
    ...(cleaned.length > 140 ? { detail: cleaned } : {}),
    ...(repo !== undefined ? { repo } : {}),
    dedupeKey: `slack:${event.channel}:${event.ts}`,
  };
}

/**
 * A Linear Issue webhook → task, gated on a `ship` label (same opt-in
 * contract as the git forges). Linear sends label names on the issue
 * data for create/update events.
 */
export function linearTaskFromIssue(payload: {
  action?: string;
  type?: string;
  data?: {
    id?: string;
    identifier?: string;
    title?: string;
    description?: string | null;
    labels?: Array<{ name?: string }>;
  };
  url?: string;
}): ProposeInput | null {
  if (payload.type !== "Issue") return null;
  if (payload.action !== "create" && payload.action !== "update") return null;
  const data = payload.data;
  if (data?.id === undefined || data.title === undefined) return null;
  const labels = data.labels?.map((l) => (l.name ?? "").toLowerCase()) ?? [];
  if (!labels.includes("ship")) return null;

  const text = `${data.title}\n${data.description ?? ""}`;
  const repo = parseRepoToken(text);
  const identifier = data.identifier !== undefined ? `[${data.identifier}] ` : "";
  return {
    source: "linear",
    kind: "issue",
    title: `${identifier}${data.title}`,
    ...(data.description !== undefined && data.description !== null && data.description !== ""
      ? { detail: `${data.description}${payload.url !== undefined ? `\n\n${payload.url}` : ""}` }
      : payload.url !== undefined
        ? { detail: payload.url }
        : {}),
    ...(repo !== undefined ? { repo } : {}),
    dedupeKey: `linear:${data.id}`,
  };
}

/**
 * A5 — a failed CI run on one of Ship's own PRs (head branch `ship/…`)
 * becomes a review task on that PR: the run gets the failure context,
 * fixes on the PR branch, and pushes — closing the red-check loop.
 * Deduped per failing head SHA, so one failure = one fix attempt even
 * across retried deliveries; a NEW failing sha (the fix itself failed)
 * proposes a fresh task.
 */
export function ciFixTaskFromWorkflowRun(payload: {
  action?: string;
  workflow_run?: {
    name?: string;
    conclusion?: string | null;
    head_branch?: string;
    head_sha?: string;
    html_url?: string;
    pull_requests?: Array<{ number?: number }>;
  };
  repository?: { full_name?: string; clone_url?: string };
}): ProposeInput | null {
  if (payload.action !== "completed") return null;
  const run = payload.workflow_run;
  if (run?.conclusion !== "failure") return null;
  const branch = run.head_branch ?? "";
  if (!branch.startsWith("ship/")) return null; // only Ship's own PRs
  const pr = run.pull_requests?.[0]?.number;
  const repo = payload.repository?.clone_url;
  const fullName = payload.repository?.full_name;
  if (pr === undefined || repo === undefined || fullName === undefined || run.head_sha === undefined) return null;
  return {
    source: "ci",
    kind: "ci",
    repo,
    pr,
    title: `CI failed on PR #${pr}: ${run.name ?? "workflow"}`,
    detail:
      `The CI workflow "${run.name ?? "workflow"}" FAILED on this pull request's branch (${branch} @ ${run.head_sha.slice(0, 10)}).` +
      ` Reproduce the failure locally (run the repository's tests), fix it, and verify the tests pass.` +
      (run.html_url !== undefined ? `\n\nFailed run: ${run.html_url}` : ""),
    dedupeKey: `ci:${fullName}#${pr}:${run.head_sha}`,
  };
}
