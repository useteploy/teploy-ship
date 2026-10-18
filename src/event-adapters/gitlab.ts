import { createHmac } from "node:crypto";

import { EVENT_DETAIL_MAX, EVENT_TITLE_MAX, oneLine, type ShipEvent } from "../event-rules.js";
import { safeForDisplay } from "../redact.js";
import type { AdapterOptions, HeaderBag, MapOutcome, VendorAdapter, VerifyOutcome } from "./adapter.js";
import { parseJsonBody } from "./adapter.js";
import { constantTimeEqualStrings } from "./verify.js";

/**
 * E7 EV4 — GitLab project webhooks (docs.gitlab.com/user/project/
 * integrations/webhooks, checked 2026-10-17).
 *
 * Two auth classes, selected by the source's `auth` field:
 *
 *   hmac          the webhook's signing token (Standard Webhooks). GitLab
 *                 sends `webhook-id`, `webhook-timestamp` and
 *                 `webhook-signature: v1,<base64>` (a space-separated list;
 *                 one signature today, but the docs say that may change).
 *                 The MAC is HMAC-SHA256 over "<id>.<timestamp>.<body>"
 *                 keyed with the base64-decoded token (`whsec_` prefix
 *                 stripped). The timestamp IS part of the signed message, so
 *                 freshness is a hard window (replayWindowSeconds, default
 *                 300) — a replayed body cannot move the clock without
 *                 breaking the MAC.
 *
 *   shared-secret the webhook's secret token, sent verbatim in
 *                 `X-Gitlab-Token`. Shared-secret class: no auto rules
 *                 (Decision 12), soft freshness only. GitLab's own docs
 *                 call this mode "not recommended"; it is supported because
 *                 it is what every GitLab before 19.0 sends.
 *
 * Delivery ids: `webhook-id` (equal to the legacy `Idempotency-Key`) is
 * unique per delivery and IDENTICAL across retries — exactly the stable id
 * the EV4 contract requires. A delivery without either is refused.
 */

const SIGNATURE_HEADER = "webhook-signature";
const WEBHOOK_ID_HEADER = "webhook-id";
const IDEMPOTENCY_HEADER = "idempotency-key";
const TOKEN_HEADER = "x-gitlab-token";
const DEFAULT_REPLAY_WINDOW_S = 300;

function verifySigningToken(headers: HeaderBag, rawBody: string, opts: AdapterOptions): VerifyOutcome {
  const id = headers.get(WEBHOOK_ID_HEADER) ?? "";
  const ts = headers.get("webhook-timestamp") ?? "";
  const signatureHeader = headers.get(SIGNATURE_HEADER) ?? "";
  if (id === "" || ts === "" || signatureHeader === "") {
    return { ok: false, status: 401, reason: "malformed-signature" };
  }
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, status: 401, reason: "bad-timestamp" };
  // The stored secret is what GitLab shows once: "whsec_" + base64 key.
  const key = Buffer.from(opts.secret.replace(/^whsec_/, ""), "base64");
  const digest = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`, "utf8").digest("base64");
  const expected = `v1,${digest}`;
  const entries = signatureHeader.split(/\s+/).map((e) => e.trim()).filter((e) => e.startsWith("v1,"));
  if (entries.length === 0) return { ok: false, status: 401, reason: "malformed-signature" };
  if (!entries.some((entry) => constantTimeEqualStrings(entry, expected))) {
    return { ok: false, status: 401, reason: "bad-signature" };
  }
  const windowS = opts.replayWindowSeconds ?? DEFAULT_REPLAY_WINDOW_S;
  if (Math.abs(opts.nowMs / 1000 - Number(ts)) > windowS) {
    return { ok: false, status: 401, reason: "expired" };
  }
  return { ok: true };
}

function verifyToken(headers: HeaderBag, _rawBody: string, opts: AdapterOptions): VerifyOutcome {
  const token = headers.get(TOKEN_HEADER) ?? "";
  if (token === "" || !constantTimeEqualStrings(token, opts.secret)) {
    return { ok: false, status: 401, reason: "bad event token" };
  }
  return { ok: true };
}

export function gitlabDeliveryId(headers: HeaderBag): string {
  return oneLine(headers.get(WEBHOOK_ID_HEADER) ?? headers.get(IDEMPOTENCY_HEADER) ?? "", 200);
}

function isoOrProblem(value: unknown, what: string): { ok: true; iso: string } | { ok: false; problem: string } {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return { ok: false, problem: `gitlab webhook carries no parsable ${what}` };
  return { ok: true, iso: new Date(Date.parse(value)).toISOString() };
}

function repoOf(payload: Record<string, unknown>): { repo: string; repoHint: string } | null {
  const project = payload.project as Record<string, unknown> | undefined;
  if (project === null || typeof project !== "object") return null;
  const path = typeof project.path_with_namespace === "string" ? project.path_with_namespace : "";
  if (path === "") return null;
  return { repo: oneLine(path, 200), repoHint: oneLine(path, 200) };
}

/**
 * A failed pipeline on one of Ship's own PR branches. The attrs carry
 * exactly what the CI dedupe key family is built from — repo (`owner/repo`,
 * the same shape as the forges' full_name), pr (the merge request iid,
 * present when the pipeline is an MR pipeline, which every ship/ branch PR
 * run is) and sha — so a rule with dedupeKey
 * "ci:{{attr.repo}}#{{attr.pr}}:{{attr.sha}}" renders the SAME key
 * ciFixTaskFromWorkflowRun writes (src/intake-sources.ts), and the webhook
 * collapses onto the existing CI task instead of opening a second one.
 */
function pipelineEvent(sourceId: string, payload: Record<string, unknown>): { ok: true; event: ShipEvent | null } | { ok: false; problem: string } {
  const object = (payload.object_attributes ?? {}) as Record<string, unknown>;
  if (object.status !== "failed") return { ok: true, event: null };
  const when = isoOrProblem(object.finished_at ?? object.created_at, "pipeline finished_at/created_at");
  if (!when.ok) return { ok: false, problem: when.problem };
  const sha = typeof object.sha === "string" ? object.sha : "";
  if (sha === "") return { ok: false, problem: "failed pipeline webhook carries no sha" };
  const repoInfo = repoOf(payload);
  if (repoInfo === null) return { ok: false, problem: "pipeline webhook carries no project.path_with_namespace" };
  const mergeRequest = payload.merge_request as Record<string, unknown> | undefined;
  const iid = mergeRequest !== null && typeof mergeRequest === "object" && typeof mergeRequest.iid === "number" ? mergeRequest.iid : undefined;
  const pipelineId = typeof object.id === "number" ? object.id : undefined;
  const event: ShipEvent = {
    source: sourceId,
    type: "pipeline.failed",
    eventId: "",
    subject: `gitlab:${repoInfo.repo}/pipeline/${oneLine(sha, 60)}`,
    occurredAt: when.iso,
    // The pipeline id is monotonic per project; it breaks exact-timestamp
    // ties the webhook's second-granular times cannot.
    ...(pipelineId !== undefined ? { seq: pipelineId } : {}),
    ...(repoInfo.repoHint !== "" ? { repoHint: repoInfo.repoHint } : {}),
    title: safeForDisplay(`Pipeline failed on ${oneLine(typeof object.ref === "string" ? object.ref : "?", 80)} (${oneLine(sha, 10)})`, EVENT_TITLE_MAX),
    detail: safeForDisplay(
      [
        `Repository: ${repoInfo.repo}`,
        `Pipeline: ${pipelineId !== undefined ? String(pipelineId) : "?"} Ref: ${oneLine(typeof object.ref === "string" ? object.ref : "?", 120)} SHA: ${sha}`,
        ...(iid !== undefined ? [`Merge request: !${iid}`] : []),
        ...(typeof object.url === "string" ? [oneLine(object.url, 300)] : []),
      ].join("\n"),
      EVENT_DETAIL_MAX,
    ),
    attrs: {
      repo: repoInfo.repo,
      sha,
      status: "failed",
      ...(typeof object.ref === "string" ? { ref: oneLine(object.ref, 120), branch: oneLine(object.ref, 120) } : {}),
      ...(iid !== undefined ? { pr: iid } : {}),
      ...(pipelineId !== undefined ? { pipeline: pipelineId } : {}),
      ...(typeof object.source === "string" ? { source: oneLine(object.source, 60) } : {}),
    },
  };
  return { ok: true, event };
}

function mergeRequestEvent(sourceId: string, payload: Record<string, unknown>): { ok: true; event: ShipEvent | null } | { ok: false; problem: string } {
  const object = (payload.object_attributes ?? {}) as Record<string, unknown>;
  if (object.action !== "merge") return { ok: true, event: null };
  const iid = typeof object.iid === "number" ? object.iid : undefined;
  const repoInfo = repoOf(payload);
  if (iid === undefined || repoInfo === null) return { ok: false, problem: "merge_request webhook carries no iid or project.path_with_namespace" };
  const when = isoOrProblem(object.actioned_at ?? object.merged_at ?? object.updated_at, "merge_request actioned_at/merged_at/updated_at");
  if (!when.ok) return { ok: false, problem: when.problem };
  const event: ShipEvent = {
    source: sourceId,
    type: "pr.merged",
    eventId: "",
    subject: `gitlab:${repoInfo.repo}!${iid}`,
    occurredAt: when.iso,
    ...(repoInfo.repoHint !== "" ? { repoHint: repoInfo.repoHint } : {}),
    title: safeForDisplay(`Merged !${iid}: ${oneLine(typeof object.title === "string" ? object.title : "", 100)}`, EVENT_TITLE_MAX),
    detail: safeForDisplay(
      [`Repository: ${repoInfo.repo}`, ...(typeof object.url === "string" ? [oneLine(object.url, 300)] : [])].join("\n"),
      EVENT_DETAIL_MAX,
    ),
    attrs: { repo: repoInfo.repo, iid, ...(typeof object.source_branch === "string" ? { source_branch: oneLine(object.source_branch, 120) } : {}) },
  };
  return { ok: true, event };
}

function issueEvent(sourceId: string, payload: Record<string, unknown>, label: string): { ok: true; event: ShipEvent | null } | { ok: false; problem: string } {
  const object = (payload.object_attributes ?? {}) as Record<string, unknown>;
  const action = object.action;
  if (action !== "open" && action !== "update") return { ok: true, event: null };
  const labels = Array.isArray(object.labels)
    ? (object.labels as unknown[]).filter((l): l is Record<string, unknown> => l !== null && typeof l === "object")
    : [];
  const titles = labels.map((l) => (typeof l.title === "string" ? l.title : "")).filter((t) => t !== "");
  const hasLabel = label !== "" && titles.includes(label);
  if (!hasLabel) return { ok: true, event: null };
  const repoInfo = repoOf(payload);
  const iid = typeof object.iid === "number" ? object.iid : undefined;
  if (repoInfo === null || iid === undefined) return { ok: false, problem: "issue webhook carries no iid or project.path_with_namespace" };
  const when = isoOrProblem(object.updated_at ?? object.created_at, "issue updated_at/created_at");
  if (!when.ok) return { ok: false, problem: when.problem };
  const event: ShipEvent = {
    source: sourceId,
    type: "ticket.labelled",
    eventId: "",
    subject: `gitlab:${repoInfo.repo}#${iid}`,
    occurredAt: when.iso,
    ...(repoInfo.repoHint !== "" ? { repoHint: repoInfo.repoHint } : {}),
    title: safeForDisplay(`[#${iid}] ${oneLine(typeof object.title === "string" ? object.title : "", 100)}`, EVENT_TITLE_MAX),
    detail: safeForDisplay(`Repository: ${repoInfo.repo}\nLabels: ${titles.map((t) => oneLine(t, 60)).join(", ")}`, EVENT_DETAIL_MAX),
    attrs: { repo: repoInfo.repo, iid, label, labels: oneLine(titles.join(","), 300) },
  };
  return { ok: true, event };
}

/**
 * A note on a Ship merge request: the review-loop signal. Mirrors what
 * reviewTaskFromReviewEvent keys on (the MR, the note's author) but as a
 * typed event; whether it becomes a task is a rule's business.
 */
function noteEvent(sourceId: string, payload: Record<string, unknown>): { ok: true; event: ShipEvent | null } | { ok: false; problem: string } {
  const object = (payload.object_attributes ?? {}) as Record<string, unknown>;
  if (object.noteable_type !== "MergeRequest") return { ok: true, event: null };
  const mergeRequest = (payload.merge_request ?? {}) as Record<string, unknown>;
  const repoInfo = repoOf(payload);
  const iid = typeof mergeRequest.iid === "number" ? mergeRequest.iid : undefined;
  const sourceBranch = typeof mergeRequest.source_branch === "string" ? mergeRequest.source_branch : "";
  // Only notes on Ship's own branches: a note on any other MR is ordinary
  // project chatter, not a review of Ship's work.
  if (!sourceBranch.startsWith("ship/")) return { ok: true, event: null };
  if (repoInfo === null || iid === undefined) return { ok: false, problem: "note webhook carries no merge_request.iid or project.path_with_namespace" };
  const when = isoOrProblem(object.updated_at ?? object.created_at, "note updated_at/created_at");
  if (!when.ok) return { ok: false, problem: when.problem };
  const noteId = typeof object.id === "number" ? object.id : undefined;
  const user = (payload.user ?? {}) as Record<string, unknown>;
  const event: ShipEvent = {
    source: sourceId,
    type: "review.comment",
    eventId: "",
    subject: `gitlab:${repoInfo.repo}!${iid}`,
    occurredAt: when.iso,
    ...(repoInfo.repoHint !== "" ? { repoHint: repoInfo.repoHint } : {}),
    title: safeForDisplay(`Comment on !${iid}: ${oneLine(typeof object.note === "string" ? object.note : "", 100)}`, EVENT_TITLE_MAX),
    detail: safeForDisplay(oneLine(typeof object.note === "string" ? object.note : "", 2_000), 2_000),
    attrs: {
      repo: repoInfo.repo,
      iid,
      ...(noteId !== undefined ? { note_id: noteId } : {}),
      ...(typeof user.username === "string" ? { user: oneLine(user.username, 100) } : {}),
      ...(typeof object.url === "string" ? { url: oneLine(object.url, 300) } : {}),
    },
  };
  return { ok: true, event };
}

export const gitlabAdapter: VendorAdapter = {
  verify(headers, rawBody, opts) {
    return opts.auth === "hmac" ? verifySigningToken(headers, rawBody, opts) : verifyToken(headers, rawBody, opts);
  },
  map(sourceId, headers, rawBody, opts): MapOutcome {
    const payload = parseJsonBody(rawBody);
    if (payload === null) return { ok: false, status: 400, problem: "malformed gitlab webhook body" };
    // webhook-id == Idempotency-Key, stable across retries; without it the
    // delivery cannot be deduped and is refused rather than guessed at.
    const deliveryId = gitlabDeliveryId(headers);
    if (deliveryId === "") {
      return { ok: false, status: 400, problem: "gitlab webhook carries no webhook-id/Idempotency-Key; refusing rather than deduping on nothing" };
    }
    const kind = typeof payload.object_kind === "string" ? payload.object_kind : "";
    let mapped: { ok: true; event: ShipEvent | null } | { ok: false; problem: string };
    if (kind === "pipeline") mapped = pipelineEvent(sourceId, payload);
    else if (kind === "merge_request") mapped = mergeRequestEvent(sourceId, payload);
    else if (kind === "issue") mapped = issueEvent(sourceId, payload, opts.label ?? "");
    else if (kind === "note") mapped = noteEvent(sourceId, payload);
    else mapped = { ok: true, event: null }; // push, tag, wiki, … map to nothing
    if (!mapped.ok) return { ok: false, status: 400, problem: mapped.problem };
    const event = mapped.event === null ? null : { ...mapped.event, eventId: deliveryId };
    return { ok: true, events: event === null ? [] : [event], deliveryId };
  },
};
