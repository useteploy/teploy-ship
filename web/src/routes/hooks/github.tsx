import { ciFixTaskFromWorkflowRun } from "teploy-ship/runtime";

import { shipRuntime } from "../../lib/store.server.js";

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
  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return json(401, { title: "bad webhook signature" });
  }

  const event = request.headers.get("x-github-event") ?? "";
  // A5: a failed workflow run on one of Ship's own PRs → review task.
  if (event === "workflow_run") {
    const input = ciFixTaskFromWorkflowRun(JSON.parse(body));
    if (input === null) return json(200, { ok: true, skipped: "not a failed run on a ship PR" });
    const runtime = await shipRuntime();
    const { created, task } = await runtime.intake.propose(input);
    return json(200, { ok: true, taskId: task.taskId, created });
  }
  const payload = JSON.parse(body) as {
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
  };
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
    const runtime = await shipRuntime();
    const { created, task } = await runtime.intake.propose({
      source: "github",
      kind: "review",
      ...(repo !== undefined ? { repo } : {}),
      pr: payload.issue.number,
      title: `PR #${payload.issue.number} review: ${(payload.issue.title ?? "").slice(0, 60)}`,
      detail: text,
      dedupeKey: `github:${fullName}#comment-${payload.comment.id}`,
    });
    return json(created ? 201 : 200, { ok: true, taskId: task.taskId, created });
  }

  if (event !== "issues") return json(200, { ok: true, skipped: `event ${event}` });
  const labels = payload.issue?.labels?.map((l) => l.name ?? "") ?? [];
  const relevant = ["opened", "reopened", "labeled", "edited"].includes(payload.action ?? "");
  if (!relevant || !labels.includes("ship")) {
    return json(200, { ok: true, skipped: "not a ship-labeled issue event" });
  }
  if (payload.issue?.number === undefined) return json(400, { title: "payload missing issue" });

  const runtime = await shipRuntime();
  const { created, task } = await runtime.intake.propose({
    source: "github",
    kind: "issue",
    ...(repo !== undefined ? { repo } : {}),
    title: payload.issue.title ?? `issue #${payload.issue.number}`,
    ...(payload.issue.body !== undefined && payload.issue.body !== null && payload.issue.body !== ""
      ? { detail: payload.issue.body }
      : {}),
    dedupeKey: `github:${fullName}#${payload.issue.number}`,
  });
  return json(created ? 201 : 200, { ok: true, taskId: task.taskId, created });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export default function Never() {
  return null;
}
