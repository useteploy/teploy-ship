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

/**
 * P1-5 — an Observe alert becomes an incident proposal.
 *
 * THE PAYLOAD IS REAL AND IT IS THIN. Observe already POSTs alerts:
 * `platform.AlertPayload` is marshalled whole and is the entire request body
 * (teploy-observe/internal/platform/webhooks.go:99-108, fired from
 * internal/platform/alerts.go:260-270). Seven fields, and the two numeric ones
 * disagree with each other on purpose — `value` is a JSON number while
 * `threshold` arrives as a string (webhooks.go formats one with
 * strconv.FormatFloat and leaves the other alone), so both are accepted here as
 * `string | number` rather than trusting either spelling.
 *
 * What the payload does NOT carry is everything the incident detail was
 * specified to carry: there is no error fingerprint, no first/last seen, no
 * sample stack and no service name anywhere on Observe's alerting path.
 * `AlertRule` and `AlertHistoryEntry` (internal/platform/alerts.go:29-55) are
 * scoped to a SITE and to four aggregate metrics (pageviews, visitors,
 * error_count, error_rate); the fingerprint/first_seen/last_seen/stack fields
 * live on a different subsystem entirely — the error `Issue`
 * (internal/errors/issues.go:55-69, grouped by `GroupHash`,
 * internal/errors/grouping.go:26) — which nothing in alert evaluation reads.
 *
 * So the enrichment fields below are declared OPTIONAL and rendered only when
 * present. Inventing a payload Observe does not send would have produced a
 * builder that is green in tests and dead in production; accepting a superset
 * means Ship works against today's alert body and gets strictly better the day
 * Observe grows an issue-backed alert without a second change here.
 */
export interface ObserveAlertPayload {
  /** webhooks.go:100. The dedupe identity — no alert_id, no task. */
  alert_id?: string;
  /**
   * The RULE, where alert_id is one firing of it. Added to Observe's payload
   * alongside this receiver (webhooks.go AlertPayload) because a rule that
   * keeps breaching fires once per cooldown with a FRESH alert_id, so the
   * `observe:<alert_id>` key below opens one incident per cooldown for a
   * single ongoing outage. Rendered into the detail today; see the note on
   * incidentTaskFromObserveAlert for why the key has not moved yet.
   */
  rule_id?: string;
  rule_name?: string;
  metric?: string;
  value?: number | string;
  threshold?: number | string;
  site_id?: string;
  /** RFC3339, stamped at fire time (not the alert's own triggered_at). */
  timestamp?: string;

  // --- Not sent by Observe today. See the note above. ---
  /** The Observe service this alert belongs to; the key the repo lookup uses. */
  service?: string;
  service_name?: string;
  /** internal/errors/grouping.go:26 — the MD5 group hash, or a custom fingerprint. */
  fingerprint?: string;
  group_hash?: string;
  issue_id?: string;
  title?: string;
  /** "funcName in basename.js" of the topmost in-app frame (grouping.go:140). */
  culprit?: string;
  severity?: string;
  level?: string;
  first_seen?: string;
  last_seen?: string;
  event_count?: number;
  url?: string;
  sample_stack?: string;
  stack_trace?: string;
}

/** How much of a sample stack reaches the task detail. */
const DETAIL_STACK_MAX = 2_000;

/**
 * The Observe identifier this alert belongs to, in the order a repo binding
 * should be attempted. Exported because the receiver resolves the repo (an I/O
 * step) before calling the builder, and both must agree on the key.
 */
export function observeAlertKey(payload: Pick<ObserveAlertPayload, "service" | "service_name" | "site_id">): string {
  return (payload.service ?? payload.service_name ?? payload.site_id ?? "").trim();
}

function observeIncidentDetail(payload: ObserveAlertPayload, repo: string | undefined): string {
  const key = oneLine(observeAlertKey(payload), 200);
  const parts: string[] = [
    `Observe raised an alert${key === "" ? "" : ` on ${key}`}. This is a production incident, not a feature request:` +
      ` find the cause and propose the smallest fix that addresses it.`,
  ];

  const facts: string[] = [];
  const push = (label: string, value: string | number | undefined | null, max = 300): void => {
    const text = oneLine(value === undefined || value === null ? "" : String(value), max);
    if (text !== "") facts.push(`${label}: ${text}`);
  };
  push("Alert id", payload.alert_id, 200);
  push("Rule", payload.rule_name);
  push("Rule id", payload.rule_id, 200);
  push("Metric", payload.metric, 120);
  push("Observed value", payload.value, 120);
  push("Threshold", payload.threshold, 120);
  push("Severity", payload.severity ?? payload.level, 60);
  push("Site", payload.site_id, 200);
  push("Triggered at", payload.timestamp, 60);
  // The fingerprint is what makes two incidents the same incident; it is worth
  // printing even though nothing in Observe fills it yet.
  push("Error fingerprint", payload.fingerprint ?? payload.group_hash, 200);
  push("Issue", payload.issue_id, 200);
  push("Culprit", payload.culprit);
  push("First seen", payload.first_seen, 60);
  push("Last seen", payload.last_seen, 60);
  push("Events", payload.event_count, 40);
  push("Link", payload.url, 500);
  if (facts.length > 0) parts.push(facts.join("\n"));

  const stack = payload.sample_stack ?? payload.stack_trace ?? "";
  if (stack.trim() !== "") {
    parts.push(`Sample stack from Observe:\n${clip(stack, DETAIL_STACK_MAX)}`);
  } else {
    // Say what is missing rather than let the agent assume it was given a
    // stack and go looking for one in the payload it cannot see.
    parts.push(
      "Observe's alert webhook carries no error fingerprint, no first/last-seen window and no sample stack" +
        " (its alert payload is a threshold breach on a site-wide metric, teploy-observe" +
        " internal/platform/webhooks.go:99-108). Read the failing code path from the repository and, if the" +
        " metric is error_count or error_rate, from the errors the service is emitting.",
    );
  }

  if (repo === undefined) {
    parts.push(
      "No repository is bound to this alert: no project record names this Observe service. Set one with" +
        " `teploy-ship evidence set --repo <url> --observe-service <name>` and this alert will bind next time.",
    );
  }
  return parts.join("\n\n");
}

/**
 * An Observe alert → an `incident` intake task.
 *
 * `repo` is resolved by the CALLER, not here: the binding is a reverse lookup
 * over the evidence store (repoForObserveService, evidence.ts) which is I/O,
 * and this module's only real property is that it is pure — it is the one part
 * of the intake pipeline with test coverage precisely because of that.
 *
 * No `requestedBy`, for the same reason ciFixTaskFromWorkflowRun has none: an
 * alert is a machine event. Nobody asked Ship to do this, and naming whoever
 * created the alert rule as the requester would put a real person on a run they
 * never authorised.
 *
 * Deduped on `observe:<alert_id>`, which is also what stands in for delivery
 * replay protection on this path: a replayed body re-proposes the same key and
 * intake.propose returns the existing task (intake.ts:136) instead of opening a
 * second incident.
 *
 * PRE-DECIDED: the key stays `observe:<alert_id>` rather than moving to
 * `observe:rule:<rule_id>`, even though rule_id is the better key and now
 * arrives in the payload. Reasoning: alert_id is the contract P1-5 specifies,
 * and it is the only identity every Observe deployment sends today — a receiver
 * that keys on a field older Observe builds omit would fall back to alert_id
 * anyway, so both keys would be live at once and the SAME outage could hold two
 * open incidents across an Observe upgrade. Reverses the moment every Observe
 * in the fleet sends rule_id: the key becomes `observe:rule:<rule_id>` and one
 * ongoing outage stops opening a fresh incident every cooldown period.
 */
export function incidentTaskFromObserveAlert(
  payload: ObserveAlertPayload,
  options: { repo?: string } = {},
): ProposeInput | null {
  const alertId = oneLine(payload.alert_id, 200);
  // Without an alert id there is no dedupe key, and an alert storm on one rule
  // would open one task per evaluation tick (every 60s, main.go:463).
  if (alertId === "") return null;

  const rule = oneLine(payload.rule_name, 80);
  const metric = oneLine(payload.metric, 60);
  const value = oneLine(payload.value === undefined ? "" : String(payload.value), 40);
  const threshold = oneLine(payload.threshold === undefined ? "" : String(payload.threshold), 40);
  const measured = metric === "" ? "" : ` (${metric}${value === "" ? "" : ` ${value}`}${threshold === "" ? "" : ` vs ${threshold}`})`;
  const subject = rule !== "" ? rule : oneLine(payload.title, 80) !== "" ? oneLine(payload.title, 80) : `alert ${alertId}`;

  return {
    source: "observe",
    kind: "incident",
    ...(options.repo !== undefined && options.repo !== "" ? { repo: options.repo } : {}),
    title: clip(`Incident: ${subject}${measured}`, 140),
    detail: observeIncidentDetail(payload, options.repo === "" ? undefined : options.repo),
    dedupeKey: `observe:${alertId}`,
  };
}
