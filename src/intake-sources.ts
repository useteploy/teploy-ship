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

/**
 * Spreadable `requestedBy` — present only when the payload actually named
 * someone. An empty string is not an attribution, and writing one would make an
 * unattributable task indistinguishable from an attributed one in the export.
 */
export function requesterOf(handle: string | undefined | null): { requestedBy?: string } {
  const trimmed = (handle ?? "").trim();
  return trimmed === "" ? {} : { requestedBy: trimmed };
}

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
  /** Slack member id of the sender — the requester, for attribution. */
  user?: string;
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
    ...(event.user !== undefined && event.user !== "" ? { requestedBy: event.user } : {}),
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
  /** Linear names the person who triggered the webhook here. */
  actor?: { name?: string; email?: string };
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
    ...(requesterOf(payload.actor?.email ?? payload.actor?.name)),
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
    // Deliberately no requestedBy: a CI failure is a machine event. The person
    // who pushed the branch did not ask Ship to fix it, and naming them as the
    // requester would put a real person's handle on a run they never
    // authorised — a worse lie than an honest blank.
    dedupeKey: `ci:${fullName}#${pr}:${run.head_sha}`,
  };
}

/**
 * C3 — the review loop. A reviewer clicking "Request changes" with five inline
 * notes produces SIX deliveries: one `pull_request_review` (submitted) plus one
 * `pull_request_review_comment` (created) per note. Neither event was handled
 * before this — both fell out of the receivers' catch-all — so the single most
 * common way a human asks for a change produced nothing at all.
 *
 * Forgejo/Gitea speaks a near-twin dialect but not an identical one: it numbers
 * the PR at `payload.number`, puts an inline comment's text on `review.content`
 * rather than `comment.body`, and its ReviewPayload carries no review id. Every
 * field this reads is therefore optional on both sides.
 */
export interface ReviewEventPayload {
  /** github: submitted | edited | dismissed | created. gitea: reviewed. */
  action?: string;
  review?: {
    id?: number;
    body?: string | null;
    /** GitHub: approved | changes_requested | commented. */
    state?: string;
    /** Gitea/Forgejo: pull_request_review_approved | _rejected | _comment. */
    type?: string;
    /** Gitea/Forgejo puts the review (or inline comment) text here. */
    content?: string;
    html_url?: string;
    user?: { login?: string; username?: string };
  };
  comment?: {
    id?: number;
    body?: string;
    /** The file the note is anchored to — the whole point of an inline comment. */
    path?: string;
    line?: number | null;
    original_line?: number | null;
    start_line?: number | null;
    /** LEFT = the pre-change side of the diff, RIGHT = the post-change side. */
    side?: string;
    diff_hunk?: string;
    html_url?: string;
    /** Stable across every comment submitted in one review — the coalescing key. */
    pull_request_review_id?: number;
    user?: { login?: string; username?: string };
  };
  /** Review events carry the PR here. There is no `issue` on these payloads. */
  pull_request?: {
    number?: number;
    title?: string;
    labels?: Array<{ name?: string }>;
    head?: { ref?: string; sha?: string; repo?: { full_name?: string } };
    base?: { repo?: { full_name?: string } };
  };
  /** Gitea numbers the pull request here rather than on `pull_request`. */
  number?: number;
  repository?: { full_name?: string; clone_url?: string };
  sender?: { login?: string; username?: string };
}

/**
 * The marker Ship stamps on every comment it posts. git.ts:575 holds the
 * canonical constant; it is repeated rather than imported because git.ts pulls
 * in the executor, guard and publish-policy graph, and this module is pure —
 * the property that makes it the only tested part of the intake pipeline.
 */
const SHIP_MARKER = "[teploy-ship]";

/** Did Ship write this text? The loop guard: our own replies must not re-trigger us. */
export function shipAuthored(text: string | null | undefined): boolean {
  return (text ?? "").includes(SHIP_MARKER);
}

/**
 * May a review on this pull request drive an agent run?
 *
 * PRE-DECIDED: the gate is satisfied by the `ship` label OR by a head branch
 * named `ship/...` that lives in the BASE repository.
 *
 * Reasoning: nothing in Ship ever applies a label to the PR it opens
 * (openPullRequest at git.ts:316 sends only title/body/head/base, and no other
 * caller writes labels), and the label match is exact, so the follow-up loop
 * was dead on Ship's own PRs until a human labelled them by hand. Applying the
 * label at open time needs a second API call whose Forgejo form takes label IDs
 * rather than names and fails on a repo that has no such label — a per-repo
 * setup step for a fact the payload already states. The branch prefix is the
 * signal ciFixTaskFromWorkflowRun already trusts (intake-sources.ts:127) and
 * costs no network call.
 *
 * The same-repository clause is what stops this from being a weakening: ANYONE
 * can open a pull request from a fork whose head branch is named `ship/x`, and
 * without the clause that would let an outsider self-authorise agent runs
 * carrying the git token, driven by their own comment text. Pushing a `ship/`
 * branch into the base repository already requires write access.
 *
 * Reverses if Ship ever opens PRs from a fork of the target, or from a branch
 * that is not `ship/`-prefixed — then the label has to be applied at open time
 * and this goes back to label-only.
 */
export function reviewGateSatisfied(payload: ReviewEventPayload): boolean {
  const pull = payload.pull_request;
  const labels = pull?.labels?.map((l) => l.name ?? "") ?? [];
  if (labels.includes("ship")) return true;
  const ref = pull?.head?.ref ?? "";
  if (!ref.startsWith("ship/")) return false;
  const headRepo = pull?.head?.repo?.full_name;
  const baseRepo = pull?.base?.repo?.full_name ?? payload.repository?.full_name;
  return headRepo !== undefined && baseRepo !== undefined && headRepo === baseRepo;
}

const DETAIL_BODY_MAX = 4_000;
const DETAIL_HUNK_MAX = 1_500;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n... [${text.length - max} chars truncated]`;
}

/**
 * Flatten a payload field to one printable line. A path or a state string is
 * rendered as a heading in the task detail, so a newline in one would let an
 * attacker-chosen filename forge a section of the text the agent reads.
 */
function oneLine(value: string | undefined | null, max = 300): string {
  return clip((value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").trim(), max);
}

function handleOf(user: { login?: string; username?: string } | undefined): string | undefined {
  const handle = user?.login ?? user?.username;
  return handle !== undefined && handle !== "" ? handle : undefined;
}

/**
 * The location, not just the complaint. A review comment stripped of its file,
 * line and hunk is "this is wrong" with no address — the agent's only recourse
 * is to guess, and it guesses over the whole diff.
 *
 * Emitted as plain text: durable.ts:656 hands this to reviewPrompt, which wraps
 * the whole thing in frameUntrusted (git.ts:601) — do not frame it again here.
 */
function reviewDetail(payload: ReviewEventPayload, pr: number): string {
  const parts: string[] = [`Review feedback on pull request #${pr}.`];
  const state = oneLine(payload.review?.state ?? payload.review?.type, 60);
  if (state !== "") parts.push(`Reviewer state: ${state}.`);

  const summary = payload.review?.body ?? payload.review?.content ?? "";
  const comment = payload.comment;
  const inline = comment?.body ?? "";
  // Gitea puts an inline comment's text on review.content, so one delivery can
  // carry the same string twice; printing it twice reads as two complaints.
  if (summary.trim() !== "" && summary.trim() !== inline.trim()) {
    parts.push(`Reviewer's summary comment:\n${clip(summary, DETAIL_BODY_MAX)}`);
  }

  if (comment !== undefined) {
    const path = oneLine(comment.path);
    const line = comment.line ?? comment.original_line ?? comment.start_line ?? undefined;
    const side = oneLine(comment.side, 16);
    if (path !== "") {
      const where =
        path +
        (line !== undefined && line !== null ? `, line ${line}` : "") +
        (side !== "" ? ` (${side} side of the diff)` : "");
      parts.push(`Inline comment on ${where}:`);
    }
    if (comment.diff_hunk !== undefined && comment.diff_hunk !== "") {
      parts.push(`The diff hunk it is anchored to:\n${clip(comment.diff_hunk, DETAIL_HUNK_MAX)}`);
    }
    const text = inline.trim() !== "" ? inline : summary;
    if (text.trim() !== "") parts.push(`Comment:\n${clip(text, DETAIL_BODY_MAX)}`);
  }

  const link = comment?.html_url ?? payload.review?.html_url;
  if (link !== undefined && link !== "") parts.push(oneLine(link, 500));

  // Honest about the coalescing: intake.propose returns the FIRST task for a
  // dedupe key unchanged (intake.ts:136), so the other deliveries in this
  // review round are not represented above. listPrReviewComments (git.ts) reads
  // the full set back off the forge for the run that addresses this.
  parts.push(
    "This task stands for the whole review round: a batched review is delivered as one event per inline" +
      " comment and those events are coalesced onto this single task, so other comments in the same review" +
      " are not reproduced above.",
  );
  return parts.join("\n\n");
}

/**
 * A `pull_request_review` or `pull_request_review_comment` delivery becomes ONE
 * review task for the whole review round.
 *
 * The dedupe key is the design. A batched review fires N+1 deliveries; keyed
 * per comment that is N+1 tasks, N+1 agent runs and N+1 pushes to the same
 * branch. Keyed on the review, the first delivery creates the task and the rest
 * collapse into it (intake.ts:136 returns the existing task), so three inline
 * comments produce one run and one push.
 *
 * Key selection, in order:
 *  1. `review.id` / `comment.pull_request_review_id` — GitHub's own review
 *     identity, stable across every delivery in the round.
 *  2. the PR head SHA — Forgejo/Gitea send no review id at all. Every delivery
 *     in one round names the same head, and Ship's own push moves it, which is
 *     what makes the NEXT review round a new task rather than a dropped one.
 *  3. the comment id — no stable round identity, so degrade to one task per
 *     comment. Over-collapsing loses a human's request; under-collapsing costs
 *     a duplicate run. The cheaper mistake wins.
 */
export function reviewTaskFromReviewEvent(
  payload: ReviewEventPayload,
  source: "github" | "forgejo",
): ProposeInput | null {
  const pull = payload.pull_request;
  const pr = pull?.number ?? payload.number;
  const fullName = payload.repository?.full_name;
  if (pr === undefined || fullName === undefined) return null;

  // GitHub: submitted (review) / created (review comment). Gitea: reviewed for
  // both. An absent action is accepted — the event header already discriminated
  // and dropping a real review over a missing field is the worse failure — but
  // an explicit edited/dismissed/deleted is not a new request for work.
  const action = payload.action;
  if (action !== undefined && !["submitted", "created", "reviewed"].includes(action)) return null;

  // An approval is not a work request. GitHub says state: "approved"; Gitea
  // says type: "pull_request_review_approved".
  const state = (payload.review?.state ?? payload.review?.type ?? "").toLowerCase();
  if (state.includes("approved")) return null;

  if (
    shipAuthored(payload.review?.body) ||
    shipAuthored(payload.review?.content) ||
    shipAuthored(payload.comment?.body)
  ) {
    return null;
  }
  if (!reviewGateSatisfied(payload)) return null;

  // A review submitted with an EMPTY body and only inline comments is the
  // common case, so empty text alone is not a reason to skip: a
  // changes-requested state is itself the request, and the inline comments
  // arrive as their own deliveries that coalesce onto this task.
  const text = `${payload.review?.body ?? ""}${payload.review?.content ?? ""}${payload.comment?.body ?? ""}`.trim();
  const requestsChanges = state.includes("changes_requested") || state.includes("rejected");
  if (text === "" && !requestsChanges) return null;

  const sha = pull?.head?.sha ?? "";
  const round =
    payload.review?.id ??
    payload.comment?.pull_request_review_id ??
    // A sha reaches no shell from here, but it does become a stored key —
    // refuse anything that is not one.
    (/^[0-9a-f]{7,64}$/i.test(sha) ? `sha-${sha.slice(0, 40)}` : undefined) ??
    (payload.comment?.id !== undefined ? `comment-${payload.comment.id}` : undefined);
  if (round === undefined) return null;

  const repo = payload.repository?.clone_url;
  return {
    source,
    kind: "review",
    ...(repo !== undefined ? { repo } : {}),
    pr,
    title: `PR #${pr} review: ${(pull?.title ?? "").slice(0, 60)}`,
    detail: reviewDetail(payload, pr),
    // The reviewer asked for this, not the PR's author.
    ...requesterOf(handleOf(payload.review?.user) ?? handleOf(payload.comment?.user) ?? handleOf(payload.sender)),
    dedupeKey: `${source}:${fullName}#review-${round}`,
  };
}
