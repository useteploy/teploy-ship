import { shipRuntime } from "../../lib/store.server.js";

export const config = { mode: "app" };

/**
 * Forgejo/Gitea webhook receiver. Auth is the webhook HMAC (this path is
 * exempt from the bearer middleware): Forgejo signs the raw body with
 * SHA-256 of the configured secret into X-Gitea-Signature. Only issue
 * events labeled "ship" become intake tasks — one label on your own
 * Forgejo IS the v1 kanban.
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
  const body = await request.text();
  const signature = request.headers.get("x-gitea-signature") ?? request.headers.get("x-forgejo-signature") ?? "";
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return json(401, { title: "bad webhook signature" });
  }

  const event = request.headers.get("x-gitea-event") ?? request.headers.get("x-forgejo-event") ?? "";
  if (event === "issue_comment") return handleComment(body);
  if (event !== "issues") return json(200, { ok: true, skipped: `event ${event}` });

  const payload = JSON.parse(body) as {
    action?: string;
    issue?: { number?: number; title?: string; body?: string; labels?: Array<{ name?: string }> };
    repository?: { full_name?: string; clone_url?: string };
  };
  const labels = payload.issue?.labels?.map((l) => l.name ?? "") ?? [];
  const relevant = ["opened", "reopened", "label_updated", "edited"].includes(payload.action ?? "");
  if (!relevant || !labels.includes("ship")) {
    return json(200, { ok: true, skipped: "not a ship-labeled issue event" });
  }
  if (payload.repository?.full_name === undefined || payload.issue?.number === undefined) {
    return json(400, { title: "payload missing repository/issue" });
  }

  const runtime = await shipRuntime();
  const { created, task } = await runtime.intake.propose({
    source: "forgejo",
    kind: "issue",
    ...(payload.repository.clone_url !== undefined ? { repo: payload.repository.clone_url } : {}),
    title: payload.issue.title ?? `issue #${payload.issue.number}`,
    ...(payload.issue.body !== undefined && payload.issue.body !== "" ? { detail: payload.issue.body } : {}),
    dedupeKey: `forgejo:${payload.repository.full_name}#${payload.issue.number}`,
  });
  return json(created ? 201 : 200, { ok: true, taskId: task.taskId, created });
}

/**
 * PR conversation comments become review follow-up tasks: the worker
 * checks out the PR's existing branch, addresses the feedback, pushes,
 * and replies. Ship's own replies carry the [teploy-ship] marker and are
 * skipped here — the loop guard.
 */
async function handleComment(body: string): Promise<Response> {
  const payload = JSON.parse(body) as {
    action?: string;
    comment?: { id?: number; body?: string };
    issue?: { number?: number; title?: string; pull_request?: unknown };
    repository?: { full_name?: string; clone_url?: string };
  };
  if (payload.action !== "created") return json(200, { ok: true, skipped: "not a new comment" });
  if (payload.issue?.pull_request === undefined || payload.issue.pull_request === null) {
    return json(200, { ok: true, skipped: "not a PR comment" });
  }
  const text = payload.comment?.body ?? "";
  if (text.includes("[teploy-ship]")) return json(200, { ok: true, skipped: "own comment" });
  if (payload.repository?.full_name === undefined || payload.issue.number === undefined || payload.comment?.id === undefined) {
    return json(400, { title: "payload missing repository/issue/comment" });
  }

  const runtime = await shipRuntime();
  const { created, task } = await runtime.intake.propose({
    source: "forgejo",
    kind: "review",
    ...(payload.repository.clone_url !== undefined ? { repo: payload.repository.clone_url } : {}),
    pr: payload.issue.number,
    title: `PR #${payload.issue.number} review: ${(payload.issue.title ?? "").slice(0, 60)}`,
    detail: text,
    dedupeKey: `forgejo:${payload.repository.full_name}#comment-${payload.comment.id}`,
  });
  return json(created ? 201 : 200, { ok: true, taskId: task.taskId, created });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export default function Never() {
  return null;
}
