import { ciFixTaskFromWorkflowRun } from "teploy-ship/runtime";

import { BodyTooLarge, claimDelivery, firstHeader, json, parseJson, proposeFromWebhook, readCappedBody } from "../../lib/webhook.server.js";

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
  if (event !== "issues") return json(200, { ok: true, skipped: `event ${event}` });

  const payload = parseJson<{
    action?: string;
    issue?: { number?: number; title?: string; body?: string; labels?: Array<{ name?: string }> };
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
    comment?: { id?: number; body?: string };
    issue?: { number?: number; title?: string; pull_request?: unknown; labels?: Array<{ name?: string }> };
    repository?: { full_name?: string; clone_url?: string };
  }>(body);
  if (payload === null) return json(400, { title: "malformed JSON body" });
  if (payload.action !== "created") return json(200, { ok: true, skipped: "not a new comment" });
  if (payload.issue?.pull_request === undefined || payload.issue.pull_request === null) {
    return json(200, { ok: true, skipped: "not a PR comment" });
  }
  const text = payload.comment?.body ?? "";
  if (text.includes("[teploy-ship]")) return json(200, { ok: true, skipped: "own comment" });
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
    dedupeKey: `forgejo:${payload.repository.full_name}#comment-${payload.comment.id}`,
  });
}

export default function Never() {
  return null;
}
