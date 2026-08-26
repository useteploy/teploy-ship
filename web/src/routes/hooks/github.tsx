import {
  ciFixTaskFromWorkflowRun,
  requesterOf,
  reviewGateSatisfied,
  reviewTaskFromReviewEvent,
  shipAuthored,
} from "../../lib/ship.server.js";

import { BodyTooLarge, claimDelivery, firstHeader, json, parseJson, proposeFromWebhook, readCappedBody } from "../../lib/webhook.server.js";

export const config = { mode: "app" };

/**
 * GitHub webhook receiver — the Forgejo receiver's dialect twin. HMAC is
 * X-Hub-Signature-256 ("sha256=<hex>" over the raw body with the same
 * SHIP_WEBHOOK_SECRET); events arrive as X-GitHub-Event. Same rules:
 * issues labeled "ship" become tasks; comments, reviews and inline review
 * comments on a followable PR become review tasks; Ship's own
 * [teploy-ship] replies are skipped.
 *
 * Subscribe the hook to issues, issue_comment, pull_request_review and
 * pull_request_review_comment. Without the last two, "Request changes"
 * with inline notes is delivered and discarded.
 */
export async function action({ request }: { request: Request }): Promise<Response> {
  const secret = process.env.SHIP_WEBHOOK_SECRET;
  if (secret === undefined || secret === "") {
    return json(503, { title: "webhook disabled: SHIP_WEBHOOK_SECRET is not set" });
  }
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  // Capped before the HMAC — see the note in the Forgejo receiver.
  let body: string;
  try {
    body = await readCappedBody(request);
  } catch (error) {
    if (error instanceof BodyTooLarge) return json(413, { title: "payload too large" });
    throw error;
  }
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return json(401, { title: "bad webhook signature" });
  }

  if (!(await claimDelivery("github", firstHeader(request, "x-github-delivery")))) {
    return json(200, { ok: true, skipped: "duplicate delivery" });
  }

  const event = request.headers.get("x-github-event") ?? "";
  // A5: a failed workflow run on one of Ship's own PRs → review task.
  if (event === "workflow_run") {
    const runPayload = parseJson<Parameters<typeof ciFixTaskFromWorkflowRun>[0]>(body);
    if (runPayload === null) return json(400, { title: "malformed JSON body" });
    const input = ciFixTaskFromWorkflowRun(runPayload);
    if (input === null) return json(200, { ok: true, skipped: "not a failed run on a ship PR" });
    return proposeFromWebhook(input);
  }
  // C3: review events. Their payload shape has no `issue`, so they are
  // handled before the issue-shaped parse below.
  if (event === "pull_request_review" || event === "pull_request_review_comment") {
    return handleReview(body, "github");
  }
  const payload = parseJson<{
    action?: string;
    issue?: {
      number?: number;
      title?: string;
      body?: string | null;
      labels?: Array<{ name?: string }>;
      pull_request?: unknown;
      user?: { login?: string };
    };
    comment?: { id?: number; body?: string; user?: { login?: string } };
    repository?: { full_name?: string; clone_url?: string };
  }>(body);
  if (payload === null) return json(400, { title: "malformed JSON body" });
  if (payload.repository?.full_name === undefined) return json(400, { title: "payload missing repository" });
  const repo = payload.repository.clone_url;
  const fullName = payload.repository.full_name;

  if (event === "issue_comment") {
    if (payload.action !== "created") return json(200, { ok: true, skipped: "not a new comment" });
    if (payload.issue?.pull_request === undefined || payload.issue.pull_request === null) {
      return json(200, { ok: true, skipped: "not a PR comment" });
    }
    const text = payload.comment?.body ?? "";
    if (shipAuthored(text)) return json(200, { ok: true, skipped: "own comment" });
    // Gate on the `ship` label, same as issues — otherwise any commenter on any
    // PR drives an agent run (with the git token) from their raw comment text.
    const prLabels = payload.issue.labels?.map((l) => l.name ?? "") ?? [];
    if (!prLabels.includes("ship")) {
      return json(200, { ok: true, skipped: "PR not labeled ship" });
    }
    if (payload.issue.number === undefined || payload.comment?.id === undefined) {
      return json(400, { title: "payload missing issue/comment" });
    }
    return proposeFromWebhook({
      source: "github",
      kind: "review",
      ...(repo !== undefined ? { repo } : {}),
      pr: payload.issue.number,
      title: `PR #${payload.issue.number} review: ${(payload.issue.title ?? "").slice(0, 60)}`,
      detail: text,
      // The commenter asked for this, not the issue's original author.
      ...requesterOf(payload.comment.user?.login),
      dedupeKey: `github:${fullName}#comment-${payload.comment.id}`,
    });
  }

  if (event !== "issues") return json(200, { ok: true, skipped: `event ${event}` });
  const labels = payload.issue?.labels?.map((l) => l.name ?? "") ?? [];
  const relevant = ["opened", "reopened", "labeled", "edited"].includes(payload.action ?? "");
  if (!relevant || !labels.includes("ship")) {
    return json(200, { ok: true, skipped: "not a ship-labeled issue event" });
  }
  if (payload.issue?.number === undefined) return json(400, { title: "payload missing issue" });

  return proposeFromWebhook({
    source: "github",
    kind: "issue",
    ...(repo !== undefined ? { repo } : {}),
    title: payload.issue.title ?? `issue #${payload.issue.number}`,
    ...(payload.issue.body !== undefined && payload.issue.body !== null && payload.issue.body !== ""
      ? { detail: payload.issue.body }
      : {}),
    ...requesterOf(payload.issue.user?.login),
    dedupeKey: `github:${fullName}#${payload.issue.number}`,
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
async function handleReview(body: string, source: "github"): Promise<Response> {
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
