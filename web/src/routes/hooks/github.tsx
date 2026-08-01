import { ciFixTaskFromWorkflowRun } from "teploy-ship/runtime";

import { BodyTooLarge, claimDelivery, firstHeader, json, parseJson, proposeFromWebhook, readCappedBody } from "../../lib/webhook.server.js";

export const config = { mode: "app" };

/**
 * GitHub webhook receiver — the Forgejo receiver's dialect twin. HMAC is
 * X-Hub-Signature-256 ("sha256=<hex>" over the raw body with the same
 * SHIP_WEBHOOK_SECRET); events arrive as X-GitHub-Event. Same rules:
 * issues labeled "ship" become tasks; new comments on PRs become review
 * tasks; Ship's own [teploy-ship] replies are skipped.
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
  const payload = parseJson<{
    action?: string;
    issue?: {
      number?: number;
      title?: string;
      body?: string | null;
      labels?: Array<{ name?: string }>;
      pull_request?: unknown;
    };
    comment?: { id?: number; body?: string };
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
    if (text.includes("[teploy-ship]")) return json(200, { ok: true, skipped: "own comment" });
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
    dedupeKey: `github:${fullName}#${payload.issue.number}`,
  });
}

export default function Never() {
  return null;
}
