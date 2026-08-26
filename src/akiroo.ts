import { join } from "node:path";

import { deliverEvent } from "@neutron-build/workflow";

import { readJsonFile, updateJsonFile } from "./file-store.js";
import { stateDir } from "./run-store.js";
import { assertRepoAllowed, credentialFor } from "./repo-policy.js";
import type { RepoRef } from "./git.js";
import type { RepoPolicyConfig } from "./repo-policy.js";
import type { DeliveryLog } from "./deliveries.js";
import type { IntakeStore } from "./intake.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";
import type { ShipRuntime } from "./runtime.js";

/**
 * L1 — the Akiroo connector. Ship PULLS work from Akiroo; Akiroo never calls
 * Ship and never holds a forge token.
 *
 * Why this direction, since Ship already receives signed webhooks from forges:
 * Akiroo is hosted as a SaaS while a Ship worker commonly sits on a private VPS
 * behind Tailscale with no public URL and no inbound route at all. Outbound
 * HTTPS from Ship works everywhere; inbound to Ship does not. So the queue
 * lives on Akiroo's side and Ship collects from it — which also means the
 * credential that opens issues stays here, where it already is, instead of
 * being copied into a workspace product.
 *
 * Two row kinds arrive:
 *
 *   decision {run_id, event_name, approved, reason, approval_id?}
 *     — someone approved or denied a parked run in Akiroo's queue. Delivered
 *       through the SAME primitive the dashboard's decide route uses
 *       (claimDecision -> deliverEvent -> markWake), so there is one resume
 *       path rather than two that drift.
 *
 *   task {repo, title, body, labels, work_item_id, work_item_ref}
 *     — someone pressed "Send to Ship" on a work item. Ship opens a
 *       `ship`-labelled issue on the repo and proposes the task under the SAME
 *       dedupe key the forge webhook would use, so the two collapse into one
 *       intake task whether or not the repo has a webhook configured.
 *
 * Every row is claimed in the delivery log before it is handled and acked
 * afterwards, whatever happened. The claim is what makes a re-delivered batch
 * safe (opening an issue is not naturally idempotent); the unconditional ack is
 * what stops one poisonous row wedging the queue forever.
 */

/** Where Akiroo is and what proves we may drain its queue. */
export interface AkirooTarget {
  /** Base URL of the Akiroo installation, no trailing slash. */
  url: string;
  /** The per-connection pull token, minted on Akiroo's Connections page. */
  token: string;
}

/**
 * Both or nothing, the same contract telemetryTargetFromEnv uses (observe.ts).
 * A URL with no token would poll forever and 401 forever, which reads as "the
 * connector is broken" rather than "the connector is not configured".
 */
export function akirooTargetFromEnv(env: NodeJS.ProcessEnv = process.env): AkirooTarget | undefined {
  const url = (env.AKIROO_URL ?? "").trim().replace(/\/+$/, "");
  const token = (env.AKIROO_PULL_TOKEN ?? "").trim();
  if (url === "" || token === "") return undefined;
  return { url, token };
}

export interface AkirooRow {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * The `after` cursor, persisted so a restart does not re-scan the whole queue.
 *
 * Advisory, NOT the delivery guarantee: Akiroo filters on `acked_at IS NULL`,
 * so a lost cursor costs a wider scan and nothing else, and a batch whose ack
 * never landed comes back regardless of what the cursor says. Advancing it only
 * after a successful ack is what keeps those two facts consistent.
 */
export interface AkirooCursorStore {
  get(): Promise<number>;
  set(after: number): Promise<void>;
}

export class FileAkirooCursor implements AkirooCursorStore {
  #path: string;

  constructor(dir = stateDir()) {
    this.#path = join(dir, "akiroo-cursor.json");
  }

  async get(): Promise<number> {
    const state = await readJsonFile<{ after?: number }>(this.#path, {});
    return typeof state.after === "number" && state.after > 0 ? state.after : 0;
  }

  async set(after: number): Promise<void> {
    // Monotonic: an out-of-order write must never move the cursor backwards
    // and re-hand rows to a handler that already ran.
    await updateJsonFile<{ after?: number }>(this.#path, {}, (state) => ({
      after: Math.max(state.after ?? 0, after),
    }));
  }
}

export class NucleusAkirooCursor implements AkirooCursorStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(`CREATE TABLE IF NOT EXISTS ship_akiroo_cursor (source TEXT, after_id TEXT)`)
      .then(() => undefined)
      // A failed ensure must not be cached: one transient store error would
      // otherwise poison every later call for the life of the process.
      .catch((error: unknown) => {
        this.#ready = null;
        throw error;
      });
    return this.#ready;
  }

  async get(): Promise<number> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT after_id FROM ship_akiroo_cursor WHERE source = $1", ["akiroo"]);
    const value = Number(rows[0]?.after_id ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  async set(after: number): Promise<void> {
    await this.#ensure();
    const current = await this.get();
    if (after <= current) return;
    const updated = await this.#db.exec("UPDATE ship_akiroo_cursor SET after_id = $1 WHERE source = $2", [
      String(after),
      "akiroo",
    ]);
    if (updated === 0) {
      await this.#db.query("INSERT INTO ship_akiroo_cursor (source, after_id) VALUES ($1, $2)", [
        "akiroo",
        String(after),
      ]);
    }
  }
}

/** What happened to one decision row, for the log line and for the tests. */
export type DecisionOutcome = "delivered" | "unknown-run" | "event-mismatch" | "already-decided";

/**
 * Deliver an Akiroo decision into a parked run.
 *
 * The same three steps as api/runs/[id]/decide.tsx, in the same order and for
 * the same reasons: claim first so two deciders cannot both deliver, deliver
 * second, wake last. The differences from that route are only that there is no
 * HTTP status to return and that every refusal is a value rather than a throw —
 * a run that has moved on must not wedge the queue.
 */
export function makeAkirooDecider(
  runtime: Pick<ShipRuntime, "store" | "loadMeta" | "claimDecision" | "releaseDecision" | "markWake">,
): (row: { runId: string; eventName: string; approved: boolean; reason?: string }) => Promise<DecisionOutcome> {
  return async ({ runId, eventName, approved, reason }) => {
    const meta = await runtime.loadMeta(runId);
    if (meta === null) return "unknown-run";
    if (meta.eventName === undefined) return "already-decided";
    if (meta.eventName !== eventName) return "event-mismatch";
    if (!(await runtime.claimDecision(runId, eventName))) return "already-decided";
    try {
      await deliverEvent(runtime.store, runId, eventName, {
        approved,
        ...(reason !== undefined && reason !== "" ? { reason } : {}),
      });
    } catch (error) {
      await runtime.releaseDecision(runId, eventName).catch(() => {});
      throw error;
    }
    // Make the run due; the resident worker carries it from here.
    await runtime.markWake?.(runId);
    return "delivered";
  };
}

/** The API base for a repo's forge, which differs between GitHub and Forgejo. */
function apiBase(ref: RepoRef): string {
  return ref.kind === "github"
    ? `https://api.github.com/repos/${ref.owner}/${ref.repo}`
    : `${ref.base}/api/v1/repos/${ref.owner}/${ref.repo}`;
}

function authHeaders(ref: RepoRef, token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: ref.kind === "github" ? `Bearer ${token}` : `token ${token}`,
    ...(ref.kind === "github" ? { accept: "application/vnd.github+json" } : {}),
  };
}

export interface CreatedIssue {
  number: number;
  url: string;
  /** owner/repo, the half of the dedupe key the forge webhook also uses. */
  fullName: string;
}

/**
 * Resolve label names to the ids Forgejo's issue endpoint requires, creating
 * any that do not exist.
 *
 * GitHub takes label NAMES on create and invents missing ones itself, so this
 * is Forgejo-only. It is also the reason the review gate in intake-sources.ts
 * settled on a branch-name signal instead of a label: this is a real per-repo
 * setup cost, paid once here because an unlabelled issue would never reach the
 * webhook path that proposes it.
 *
 * A label the forge refuses (a permissions problem, a race with another
 * creator) is dropped rather than fatal — an issue with fewer labels is still
 * an issue, and the `ship` label is re-read after the create attempt so a
 * concurrent creator's label is used instead of failing.
 */
export async function resolveLabelIds(options: {
  ref: RepoRef;
  token: string;
  names: string[];
  fetchImpl?: typeof fetch;
}): Promise<number[]> {
  const { ref, token } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const existing = new Map<string, number>();
  const response = await doFetch(`${apiBase(ref)}/labels?limit=100`, { headers: authHeaders(ref, token) });
  if (response.ok) {
    const labels = (await response.json()) as Array<{ id?: number; name?: string }>;
    for (const label of labels) {
      if (typeof label.id === "number" && typeof label.name === "string") {
        existing.set(label.name.toLowerCase(), label.id);
      }
    }
  }

  const ids: number[] = [];
  for (const name of options.names) {
    const found = existing.get(name.toLowerCase());
    if (found !== undefined) {
      ids.push(found);
      continue;
    }
    const created = await doFetch(`${apiBase(ref)}/labels`, {
      method: "POST",
      headers: authHeaders(ref, token),
      // A neutral grey: Ship picking a colour would be Ship having an opinion
      // about someone else's label palette.
      body: JSON.stringify({ name, color: "#8a8a8a", description: "Work for Teploy Ship" }),
    });
    if (!created.ok) continue;
    const label = (await created.json()) as { id?: number };
    if (typeof label.id === "number") ids.push(label.id);
  }
  return ids;
}

/**
 * Open the issue. Same endpoint shape on both forges; only the label field
 * differs (ids on Forgejo, names on GitHub).
 */
export async function createLabelledIssue(options: {
  ref: RepoRef;
  token: string;
  title: string;
  body: string;
  labels: string[];
  fetchImpl?: typeof fetch;
}): Promise<CreatedIssue> {
  const { ref, token } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const labels =
    ref.kind === "github"
      ? options.labels
      : await resolveLabelIds({ ref, token, names: options.labels, fetchImpl: doFetch });
  const response = await doFetch(`${apiBase(ref)}/issues`, {
    method: "POST",
    headers: authHeaders(ref, token),
    body: JSON.stringify({ title: options.title, body: options.body, labels }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`issue creation failed (${response.status}): ${detail.slice(0, 500)}`);
  }
  const created = (await response.json()) as { number?: number; html_url?: string; url?: string };
  if (typeof created.number !== "number") {
    throw new Error("the forge accepted the issue but returned no number");
  }
  return {
    number: created.number,
    url: created.html_url ?? created.url ?? "",
    fullName: `${ref.owner}/${ref.repo}`,
  };
}

/**
 * The footer that lets the run's outcome find its way home.
 *
 * Akiroo reads this back off the run event's `task` field, because the issue
 * body becomes the intake task's detail, which becomes the run's task text.
 * That chain carries the ref with nothing along it having to know about it —
 * which is why the marker exists at all rather than relying solely on the
 * structured `origin` field (see notify.ts RunOrigin).
 */
export const AKIROO_REF_MARKER = "Akiroo: ";

export function issueBodyFor(body: string, workItemRef: string): string {
  const base = body.trim();
  const footer = `${AKIROO_REF_MARKER}${workItemRef}`;
  return base === "" ? footer : `${base}\n\n---\n${footer}`;
}

export interface AkirooSweepDeps {
  target: AkirooTarget;
  cursor: AkirooCursorStore;
  /**
   * At-most-once handling per outbox row. Reused from the webhook receivers
   * (deliveries.ts) rather than reinvented: the property needed here is
   * identical — an at-least-once delivery must not act twice — and the ack
   * cannot provide it, because the crash window is between handling and acking.
   */
  deliveries: DeliveryLog;
  intake: Pick<IntakeStore, "propose">;
  decide: (row: { runId: string; eventName: string; approved: boolean; reason?: string }) => Promise<DecisionOutcome>;
  repoPolicy: RepoPolicyConfig;
  fetchImpl?: typeof fetch;
  log: (line: string) => void;
}

export interface AkirooSweepResult {
  pulled: number;
  handled: number;
  acked: number;
}

/** Rows requested per poll; Akiroo caps this at 50 regardless. */
export const AKIROO_PULL_LIMIT = 50;

/**
 * One Akiroo sweep: pull, handle each row, ack the batch, advance the cursor.
 *
 * The ordering is the whole design. Rows are acked whatever their handler did,
 * including throwing — a row Ship cannot process (a repo it is not allowed to
 * clone, a run that no longer exists) must not be re-delivered every five
 * seconds for the rest of the deployment's life. The at-most-once claim above
 * is what makes acking-regardless safe.
 *
 * The cursor advances only after the ack succeeds, so a failed ack re-delivers
 * the batch and the claim short-circuits the handlers.
 */
export async function sweepAkiroo(deps: AkirooSweepDeps): Promise<AkirooSweepResult> {
  const doFetch = deps.fetchImpl ?? fetch;
  const after = await deps.cursor.get();
  const response = await doFetch(
    `${deps.target.url}/api/connections/teploy_ship/outbox?after=${after}&limit=${AKIROO_PULL_LIMIT}`,
    { headers: { authorization: `Bearer ${deps.target.token}` } },
  );
  if (!response.ok) {
    // 401 is the one worth naming: it is a token problem, not a queue problem,
    // and the fix is on the Connections page rather than in any log here.
    const hint = response.status === 401 ? " — AKIROO_PULL_TOKEN was rejected; rotate it on Akiroo's Connections page" : "";
    throw new Error(`akiroo outbox poll failed (${response.status})${hint}`);
  }
  const body = (await response.json()) as { items?: AkirooRow[] };
  const rows = body.items ?? [];
  if (rows.length === 0) return { pulled: 0, handled: 0, acked: 0 };

  let handled = 0;
  const ids: number[] = [];
  for (const row of rows) {
    ids.push(row.id);
    // Claim before acting. A batch that was handled but not acked comes back;
    // this is what stops the second pass opening a second issue.
    if (!(await deps.deliveries.claim("akiroo", String(row.id)))) {
      deps.log(`[worker] akiroo: row ${row.id} was already handled; acking again`);
      continue;
    }
    try {
      await handleAkirooRow(row, deps);
      handled += 1;
    } catch (error) {
      // Logged with the row id so the operator can find it in Akiroo's outbox,
      // then acked with everything else. Wedging the queue on one bad row is
      // the failure mode this connector must not have.
      deps.log(
        `[worker] akiroo: row ${row.id} (${row.kind}) failed and is being dropped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const ack = await doFetch(`${deps.target.url}/api/connections/teploy_ship/outbox/ack`, {
    method: "POST",
    headers: { authorization: `Bearer ${deps.target.token}`, "content-type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!ack.ok) {
    // The cursor stays put: the batch will be re-delivered and short-circuit on
    // the claims above, which is exactly the behaviour we want.
    throw new Error(`akiroo outbox ack failed (${ack.status}) for ${ids.length} row(s)`);
  }
  const acked = ((await ack.json().catch(() => ({}))) as { acked?: number }).acked ?? ids.length;
  await deps.cursor.set(Math.max(...ids));
  return { pulled: rows.length, handled, acked };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export async function handleAkirooRow(row: AkirooRow, deps: AkirooSweepDeps): Promise<void> {
  if (row.kind === "decision") {
    const runId = str(row.payload.run_id);
    const eventName = str(row.payload.event_name);
    if (runId === "" || eventName === "") throw new Error("decision row names no run or no event");
    const outcome = await deps.decide({
      runId,
      eventName,
      approved: row.payload.approved === true,
      reason: str(row.payload.reason),
    });
    deps.log(`[worker] akiroo: decision for ${runId} (${eventName}): ${outcome}`);
    return;
  }
  if (row.kind === "task") {
    await handleAkirooTask(row, deps);
    return;
  }
  // Not an error worth throwing over: a newer Akiroo may emit a kind this build
  // does not know, and the correct answer is to ack it and carry on rather than
  // to stop collecting everything behind it.
  deps.log(`[worker] akiroo: row ${row.id} has unknown kind ${JSON.stringify(row.kind)}; ignored`);
}

async function handleAkirooTask(row: AkirooRow, deps: AkirooSweepDeps): Promise<void> {
  const repo = str(row.payload.repo);
  const title = str(row.payload.title);
  const workItemRef = str(row.payload.work_item_ref);
  if (repo === "" || title === "") throw new Error("task row names no repo or no title");

  // The allowlist is re-checked here, before a credential is chosen, because a
  // task row is externally authored: it arrives from a workspace product, and
  // "someone in Akiroo typed a clone URL" is exactly the trust level
  // assertRepoAllowed's "external" mode exists for.
  const ref = assertRepoAllowed(repo, { trust: "external", config: deps.repoPolicy });
  const token = credentialFor(ref, deps.repoPolicy);

  const labels = Array.isArray(row.payload.labels)
    ? [...new Set(["ship", ...(row.payload.labels as unknown[]).filter((l): l is string => typeof l === "string")])]
    : ["ship"];
  const body = workItemRef === "" ? str(row.payload.body) : issueBodyFor(str(row.payload.body), workItemRef);

  const issue = await createLabelledIssue({
    ref,
    token,
    title,
    body,
    labels,
    ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
  });

  // PRE-DECIDED: propose here AND let the forge webhook propose, rather than
  // detecting which repos have a webhook. Reasoning: the dedupe key is
  // identical to the one web/src/routes/hooks/forgejo.tsx uses, and
  // intake.propose returns the existing task for a key it already holds — so
  // the two collapse into one task, one run and one pull request whether the
  // repo has a webhook, has none, or gains one later. Detecting the webhook
  // would be an extra forge call whose answer can be stale by the time it is
  // used. Reverses if the dedupe key on the forge path ever stops being
  // `forgejo:<owner/repo>#<n>`, at which point this would create a duplicate
  // task rather than collapse.
  const dedupeKey = `${ref.kind}:${issue.fullName}#${issue.number}`;
  const detail = body === "" ? `${issue.url}` : `${body}\n\n${issue.url}`;
  const { created, task } = await deps.intake.propose({
    source: ref.kind,
    kind: "issue",
    repo: ref.cloneUrl,
    title,
    detail,
    dedupeKey,
  });
  deps.log(
    `[worker] akiroo: opened ${issue.fullName}#${issue.number} for ${workItemRef === "" ? "an untracked item" : workItemRef}` +
      ` (${created ? "proposed" : "already proposed"} as ${task.taskId})`,
  );
}

/** What the Settings page shows about the connector. */
export interface AkirooConnectorState {
  configured: boolean;
  url: string;
  lastPullAt?: string;
  lastError?: string;
  lastPulled?: number;
}

/**
 * Live state for the Settings page, held in the worker process.
 *
 * Deliberately in memory rather than in the store: it describes THIS worker's
 * connector, it is meaningless once the process is gone, and persisting it
 * would create a second place a stale "last pull" could be read from.
 */
export function makeAkirooState(target: AkirooTarget | undefined): {
  read: () => AkirooConnectorState;
  recordPull: (result: AkirooSweepResult) => void;
  recordError: (error: unknown) => void;
} {
  const state: AkirooConnectorState = { configured: target !== undefined, url: target?.url ?? "" };
  return {
    read: () => ({ ...state }),
    recordPull: (result) => {
      state.lastPullAt = new Date().toISOString();
      state.lastPulled = result.pulled;
      delete state.lastError;
    },
    recordError: (error) => {
      state.lastError = error instanceof Error ? error.message : String(error);
    },
  };
}
