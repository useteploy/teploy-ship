import {
  ciFixTaskFromWorkflowRun,
  requesterOf,
  reviewGateSatisfied,
  reviewTaskFromReviewEvent,
  shipAuthored,
} from "../../lib/ship.server.js";

import { BodyTooLarge, claimDelivery, firstHeader, json, parseJson, proposeFromWebhook, readCappedBody } from "../../lib/webhook.server.js";
import { applyPullRequestEvent, applyPushEvent } from "../../lib/revert.server.js";

export const config = { mode: "app" };

/**
 * Forgejo/Gitea webhook receiver. Auth is the webhook HMAC (this path is
 * exempt from the bearer middleware): Forgejo signs the raw body with
 * SHA-256 of the configured secret into X-Gitea-Signature. Only issue
 * events labeled "ship" become intake tasks — one label on your own
 * Forgejo IS the v1 kanban.
 *
 * REGISTRATION GOTCHA (cost a live debugging session): register the hook
 * with events ["issues", "issue_comment", "pull_request_comment"].
 * Forgejo routes comments on PULL REQUESTS through the
 * pull_request_comment trigger even though the delivery still arrives
 * with the X-Gitea-Event: issue_comment header — without that trigger,
 * PR-review comments are silently never queued (no hook_task row, no
 * log line). Same for labels on PRs (pull_request_label).
 *
 * Add the review triggers too ("pull_request_review",
 * "pull_request_review_comment", and Forgejo's outcome-split
 * "pull_request_review_approved" / "_rejected"): an inline note left in a
 * review does NOT arrive as issue_comment on either forge.
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const secret = process.env.SHIP_WEBHOOK_SECRET;
  if (secret === undefined || secret === "") {
    return json(503, { title: "webhook disabled: SHIP_WEBHOOK_SECRET is not set" });
  }
  // node:crypto is imported lazily: this action only ever runs server-side,
  // and a top-level node: import in a route module breaks the client bundle
  // (framework-excellence finding: no server/client route splitting).
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  // Capped BEFORE the HMAC: this route is unauthenticated until the signature
  // verifies, so an unbounded read lets any caller pick how much memory and
  // hashing work Ship does for a request it is going to reject.
  let body: string;
  try {
    body = await readCappedBody(request);
  } catch (error) {
    if (error instanceof BodyTooLarge) return json(413, { title: "payload too large" });
    throw error;
  }
  const signature = request.headers.get("x-gitea-signature") ?? request.headers.get("x-forgejo-signature") ?? "";
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return json(401, { title: "bad webhook signature" });
  }

  // Signed but not necessarily fresh: a captured delivery replays forever.
  if (!(await claimDelivery("forgejo", firstHeader(request, "x-forgejo-delivery", "x-gitea-delivery")))) {
    return json(200, { ok: true, skipped: "duplicate delivery" });
  }

  const event = request.headers.get("x-gitea-event") ?? request.headers.get("x-forgejo-event") ?? "";
  // A5: a failed workflow run on one of Ship's own PRs → review task
  // (Forgejo's workflow_run payload mirrors GitHub's).
  if (event === "workflow_run") {
    const payload = parseJson<Parameters<typeof ciFixTaskFromWorkflowRun>[0]>(body);
    if (payload === null) return json(400, { title: "malformed JSON body" });
    const input = ciFixTaskFromWorkflowRun(payload);
    if (input === null) return json(200, { ok: true, skipped: "not a failed run on a ship PR" });
    return proposeFromWebhook(input);
  }
  if (event === "issue_comment") return handleComment(body);
  // L8 contracts 4 + D4: merged-PR and push events feed the per-repo numbers
  // and revert detection. Handled before the issues fallthrough so they are
  // reached at all; everything not a revert or a Ship merge is filtered
  // inside (revert.server.ts) and answered 200 without touching the store.
  if (event === "pull_request") {
    const payload = parseJson<Record<string, unknown>>(body);
    if (payload === null) return json(400, { title: "malformed JSON body" });
    return json(200, await applyPullRequestEvent(payload));
  }
  if (event === "push") {
    const payload = parseJson<Record<string, unknown>>(body);
    if (payload === null) return json(400, { title: "malformed JSON body" });
    return json(200, await applyPushEvent(payload));
  }
  // C3: review events. Gitea/Forgejo splits by outcome in the event NAME
  // (pull_request_review_approved / _rejected / _comment) where GitHub sends
  // one pull_request_review and puts the outcome in review.state; both
  // spellings are accepted because the builder filters approvals either way.
  if (event.startsWith("pull_request_review")) return handleReview(body, "forgejo");

  if (event !== "issues") return json(200, { ok: true, skipped: `event ${event}` });

  const payload = parseJson<{
    action?: string;
    issue?: {
      number?: number;
      title?: string;
      body?: string;
      labels?: Array<{ name?: string }>;
      user?: { login?: string };
    };
    repository?: { full_name?: string; clone_url?: string };
  }>(body);
  if (payload === null) return json(400, { title: "malformed JSON body" });
  const labels = payload.issue?.labels?.map((l) => l.name ?? "") ?? [];
  const relevant = ["opened", "reopened", "label_updated", "edited"].includes(payload.action ?? "");
  if (!relevant || !labels.includes("ship")) {
    return json(200, { ok: true, skipped: "not a ship-labeled issue event" });
  }
  if (payload.repository?.full_name === undefined || payload.issue?.number === undefined) {
    return json(400, { title: "payload missing repository/issue" });
  }

  return proposeFromWebhook({
    source: "forgejo",
    kind: "issue",
    ...(payload.repository.clone_url !== undefined ? { repo: payload.repository.clone_url } : {}),
    title: payload.issue.title ?? `issue #${payload.issue.number}`,
    ...(payload.issue.body !== undefined && payload.issue.body !== "" ? { detail: payload.issue.body } : {}),
    ...requesterOf(payload.issue.user?.login),
    dedupeKey: `forgejo:${payload.repository.full_name}#${payload.issue.number}`,
  });
}

/**
 * PR conversation comments become review follow-up tasks: the worker
 * checks out the PR's existing branch, addresses the feedback, pushes,
 * and replies. Ship's own replies carry the [teploy-ship] marker and are
 * skipped here — the loop guard.
 */
async function handleComment(body: string): Promise<Response> {
  const payload = parseJson<{
    action?: string;
    comment?: { id?: number; body?: string; user?: { login?: string } };
    issue?: { number?: number; title?: string; pull_request?: unknown; labels?: Array<{ name?: string }> };
    repository?: { full_name?: string; clone_url?: string };
  }>(body);
  if (payload === null) return json(400, { title: "malformed JSON body" });
  if (payload.action !== "created") return json(200, { ok: true, skipped: "not a new comment" });
  if (payload.issue?.pull_request === undefined || payload.issue.pull_request === null) {
    return json(200, { ok: true, skipped: "not a PR comment" });
  }
  const text = payload.comment?.body ?? "";
  if (shipAuthored(text)) return json(200, { ok: true, skipped: "own comment" });
  // Gate on the `ship` label, same as issues — otherwise ANY commenter on ANY
  // PR drives an agent run (with the git token) from their raw comment text.
  const labels = payload.issue.labels?.map((l) => l.name ?? "") ?? [];
  if (!labels.includes("ship")) {
    return json(200, { ok: true, skipped: "PR not labeled ship" });
  }
  if (payload.repository?.full_name === undefined || payload.issue.number === undefined || payload.comment?.id === undefined) {
    return json(400, { title: "payload missing repository/issue/comment" });
  }

  return proposeFromWebhook({
    source: "forgejo",
    kind: "review",
    ...(payload.repository.clone_url !== undefined ? { repo: payload.repository.clone_url } : {}),
    pr: payload.issue.number,
    title: `PR #${payload.issue.number} review: ${(payload.issue.title ?? "").slice(0, 60)}`,
    detail: text,
    // The commenter asked for this, not the issue's original author.
    ...requesterOf(payload.comment.user?.login),
    dedupeKey: `forgejo:${payload.repository.full_name}#comment-${payload.comment.id}`,
  });
}

/**
 * C3 — `pull_request_review` and `pull_request_review_comment`. "Request
 * changes" with five inline notes is SIX deliveries (one review + one per
 * note); until this existed all six fell out of the catch-all below and the
 * most common way a human asks for a change produced nothing at all.
 *
 * Placed below claimDelivery so replay protection still covers these, and
 * above the catch-all so they are reached at all. The presence checks differ
 * from the issue_comment path on purpose: a review event carries the PR at
 * payload.pull_request, and has no `issue` at all, so `issue.pull_request` is
 * not the "is this a PR?" test here.
 */
async function handleReview(body: string, source: "forgejo"): Promise<Response> {
  const payload = parseJson<Parameters<typeof reviewTaskFromReviewEvent>[0]>(body);
  if (payload === null) return json(400, { title: "malformed JSON body" });
  const pr = payload.pull_request?.number ?? payload.number;
  if (payload.repository?.full_name === undefined || pr === undefined) {
    return json(400, { title: "payload missing repository/pull_request" });
  }
  // The loop guard, applied to REVIEW text too: the marker was only ever
  // checked against issue comments, so a Ship reply posted as a review comment
  // would have re-triggered Ship.
  if (
    shipAuthored(payload.review?.body) ||
    shipAuthored(payload.review?.content) ||
    shipAuthored(payload.comment?.body)
  ) {
    return json(200, { ok: true, skipped: "own comment" });
  }
  if (!reviewGateSatisfied(payload)) {
    return json(200, { ok: true, skipped: "PR is not ship-labeled and is not a ship/ branch on this repo" });
  }
  const input = reviewTaskFromReviewEvent(payload, source);
  if (input === null) return json(200, { ok: true, skipped: "not an actionable review event" });
  return proposeFromWebhook(input);
}

export default function Never() {
  return null;
}
