import { createHash } from "node:crypto";
import { join } from "node:path";

import { deliverEvent } from "@neutron-build/workflow";

import { readJsonFile, updateJsonFile } from "./file-store.js";
import { stateDir } from "./run-store.js";
import { assertRepoAllowed, credentialFor } from "./repo-policy.js";
import type { RepoRef } from "./git.js";
import type { RepoPolicyConfig } from "./repo-policy.js";
import type { DeliveryLog } from "./deliveries.js";
import type { IntakeStore } from "./intake.js";
import { resolveConfigValue } from "./runtime-config.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";
import type { ConfigSource, ResolvedValue, RuntimeConfigStore } from "./runtime-config.js";
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

/** The two config keys, named identically in the store and in the environment. */
export const AKIROO_URL_KEY = "AKIROO_URL";
export const AKIROO_TOKEN_KEY = "AKIROO_PULL_TOKEN";

/**
 * Normalise and VALIDATE an Akiroo base URL, or null if it is not one.
 *
 * Two jobs. The trailing-slash strip is cosmetic — every caller builds
 * `${base}/api/...`. The scheme and userinfo checks are not: this value decides
 * where a live org pull token is sent on a five-second loop, and it now arrives
 * from a handshake rather than only from a manifest an operator wrote by hand.
 * Re-validated on EVERY resolve rather than only at the moment it is stored,
 * because "it was checked when it was written" stops being true the first time
 * anything else can write the row.
 *
 * Private and CGNAT addresses are deliberately allowed: Ship's supported
 * topology is a tailnet, a self-hosted Akiroo on 100.64.0.0/10 is a first-class
 * deployment, and a blocklist here would refuse the main legitimate case.
 * Mirrors the http/https test in colocation.ts originParts.
 */
export function normalizeAkirooBase(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === "") return null;
  // user:pass@host — an origin that displays as one host and authenticates as
  // something else. settings.tsx strips these before display for the same reason.
  if (url.username !== "" || url.password !== "") return null;
  return trimmed;
}

/**
 * ONE representation of a workspace address, used on every leg.
 *
 * Scheme, host, port and path prefix, with trailing slashes gone. This is the
 * string the approve link is built on, the string the exchange POSTs to, the
 * string the outbox poll uses, and the string the return leg compares against —
 * and Akiroo's `akirooHandshakeBase` is the same shape on its side, which is
 * what makes the comparison meaningful rather than approximate.
 *
 * It used to be the ORIGIN here and the full base everywhere else. That was not
 * merely inconsistent: it meant a path-prefixed install was addressed one way
 * to get approved and another way to be polled, so the two legs of a single
 * connect were talking about different URLs while claiming to agree.
 */
export function workspaceIdentity(raw: string): string | null {
  const base = normalizeAkirooBase(raw);
  if (base === null) return null;
  try {
    const url = new URL(base);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * What the connector resolved to, and why — the Settings page's whole story.
 *
 * "misconfigured" is a real outcome and not a variant of "unset": a half-set
 * connector polls nothing, and an operator who has just completed a handshake
 * needs to be told that rather than shown "disabled".
 */
export type AkirooConfigStatus = "runtime" | "env" | "unset" | "misconfigured";

export interface AkirooResolution {
  /** Present exactly when status is "runtime" or "env". */
  target?: AkirooTarget;
  status: AkirooConfigStatus;
  /** Per-value provenance, for the Settings rows. Never carries the token itself. */
  url: ResolvedValue;
  token: ResolvedValue;
  /** Operator-facing explanation, set exactly when status is "misconfigured". */
  reason?: string;
}

/**
 * Resolve the Akiroo connector: runtime config first, environment second.
 *
 * Resolved as a PAIR, which is the one thing that must not be got wrong here.
 * Applying the precedence per value independently means a runtime AKIROO_URL
 * with no runtime token pairs the new host with the OLD environment token — and
 * Ship then posts one org's live pull token to another org's server every five
 * seconds. So: both from the store, or both from the environment, or nothing.
 * A mixed or half-filled pair refuses to poll and says so.
 *
 * This is the same both-or-nothing contract akirooTargetFromEnv has always
 * had, extended to the second source rather than duplicated for it.
 */
export async function resolveAkirooTarget(
  store: Pick<RuntimeConfigStore, "get">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AkirooResolution> {
  const url = await resolveConfigValue(store, AKIROO_URL_KEY, env);
  const token = await resolveConfigValue(store, AKIROO_TOKEN_KEY, env);

  if (url.source === "unset" && token.source === "unset") {
    return { status: "unset", url, token };
  }
  if (url.source === "unset" || token.source === "unset") {
    const missing = url.source === "unset" ? AKIROO_URL_KEY : AKIROO_TOKEN_KEY;
    return {
      status: "misconfigured",
      url,
      token,
      reason: `${missing} is not set — the Akiroo connector needs both a base URL and a pull token`,
    };
  }
  if (url.source !== token.source) {
    // The dangerous case, spelled out: never silently pair them.
    return {
      status: "misconfigured",
      url,
      token,
      reason:
        `${AKIROO_URL_KEY} comes from the ${url.source === "runtime" ? "connect handshake" : "environment"} but ` +
        `${AKIROO_TOKEN_KEY} comes from the ${token.source === "runtime" ? "connect handshake" : "environment"} — ` +
        "a token minted for one workspace must not be sent to another; re-run the connect, or clear the override",
    };
  }
  const base = normalizeAkirooBase(url.value);
  if (base === null) {
    return {
      status: "misconfigured",
      url,
      token,
      reason: `${AKIROO_URL_KEY} is not a plain http(s) URL (no scheme other than http/https, no user:pass@)`,
    };
  }
  return { status: url.source, target: { url: base, token: token.value }, url, token };
}

/** Which source won, for a Settings row. Exported so the web half need not re-derive it. */
export function akirooSourceLabel(source: ConfigSource): string {
  if (source === "runtime") return "from the Akiroo connect handshake (overrides the environment variable)";
  if (source === "env") return "from the environment variable";
  return "not set";
}

export interface AkirooRow {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * A pull token reduced to something comparable and safe to hold.
 *
 * Eight hex characters of sha256 — enough to tell one token from another, not
 * enough to be worth anything on its own. Every place that needs to answer "is
 * this still the same credential?" uses this rather than the token, so no
 * comparison ever puts the token itself in a variable that something might log.
 */
export function akirooTokenPrint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}

/**
 * Identity of the workspace a cursor and a delivery claim belong to.
 *
 * The full workspace identity, not the base as typed: a workspace reached as
 * `https://a.example` and as `https://a.example/` is one workspace and must not
 * get two cursors, while two different installations must never share one.
 *
 * This exists because the queue position was previously stored under the
 * constant "akiroo". Reconnecting a Ship to a DIFFERENT workspace left the old
 * workspace's high-water mark in place, so Ship polled `?after=<a number from
 * someone else's queue>`, received nothing forever, and reported itself
 * connected and healthy. The same constant was used for the at-most-once
 * delivery claims, so row 1 of the new workspace read as already handled. Both
 * are keyed by this now.
 */
export function akirooWorkspaceKey(url: string): string {
  // The full identity, path prefix included — the same representation the
  // approve link, the exchange and the poll all use. Keying on the bare origin
  // gave two path-prefixed installs on one host a shared cursor and a shared
  // set of delivery claims, which is the exact confusion this function was
  // added to prevent, one level down.
  const identity = workspaceIdentity(url);
  return identity === null ? "akiroo:invalid" : `akiroo:${identity}`;
}

/**
 * The `after` cursor, persisted so a restart does not re-scan the whole queue.
 *
 * Advisory, NOT the delivery guarantee: Akiroo filters on `acked_at IS NULL`,
 * so a lost cursor costs a wider scan and nothing else, and a batch whose ack
 * never landed comes back regardless of what the cursor says. Advancing it only
 * after a successful ack is what keeps those two facts consistent.
 *
 * Keyed by workspace (see akirooWorkspaceKey). No migration was needed to make
 * it so: the Nucleus column was already TEXT and already called `source`, it
 * was simply always written with a constant. A row left behind under the old
 * "akiroo" key stops matching, which costs one wider scan — the exact thing the
 * paragraph above says is safe.
 */
export interface AkirooCursorStore {
  get(source: string): Promise<number>;
  set(source: string, after: number): Promise<void>;
  /**
   * Forget a workspace's position, so the next sweep re-scans from the start.
   *
   * Called when a connect completes. Re-scanning is cheap and safe (the
   * delivery claims short-circuit anything already handled), while a stale
   * position after a reconnect is a Ship that silently collects nothing.
   */
  reset(source: string): Promise<void>;
}

/** source -> highest acked row id. */
type CursorFile = { sources?: Record<string, number> };

export class FileAkirooCursor implements AkirooCursorStore {
  #path: string;

  constructor(dir = stateDir()) {
    this.#path = join(dir, "akiroo-cursor.json");
  }

  async get(source: string): Promise<number> {
    const state = await readJsonFile<CursorFile>(this.#path, {});
    const value = state.sources?.[source];
    return typeof value === "number" && value > 0 ? value : 0;
  }

  async set(source: string, after: number): Promise<void> {
    // Monotonic: an out-of-order write must never move the cursor backwards
    // and re-hand rows to a handler that already ran.
    await updateJsonFile<CursorFile>(this.#path, {}, (state) => ({
      sources: { ...state.sources, [source]: Math.max(state.sources?.[source] ?? 0, after) },
    }));
  }

  async reset(source: string): Promise<void> {
    await updateJsonFile<CursorFile>(this.#path, {}, (state) => {
      const sources = { ...state.sources };
      delete sources[source];
      return { sources };
    });
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

  async get(source: string): Promise<number> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT after_id FROM ship_akiroo_cursor WHERE source = $1", [source]);
    const value = Number(rows[0]?.after_id ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  async set(source: string, after: number): Promise<void> {
    await this.#ensure();
    const current = await this.get(source);
    if (after <= current) return;
    const updated = await this.#db.exec("UPDATE ship_akiroo_cursor SET after_id = $1 WHERE source = $2", [
      String(after),
      source,
    ]);
    if (updated === 0) {
      await this.#db.query("INSERT INTO ship_akiroo_cursor (source, after_id) VALUES ($1, $2)", [
        source,
        String(after),
      ]);
    }
  }

  async reset(source: string): Promise<void> {
    await this.#ensure();
    await this.#db.query("DELETE FROM ship_akiroo_cursor WHERE source = $1", [source]);
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
  // Both the queue position and the at-most-once claims below are namespaced by
  // the workspace, not by the connector as a whole. Reconnecting this Ship to a
  // different workspace therefore starts from a clean position AND a clean
  // claim namespace; sharing either across workspaces is what made a reconnect
  // look healthy while collecting nothing.
  const source = akirooWorkspaceKey(deps.target.url);
  const after = await deps.cursor.get(source);
  const response = await doFetch(
    `${deps.target.url}/api/connections/teploy_ship/outbox?after=${after}&limit=${AKIROO_PULL_LIMIT}`,
    // Redirects are refused rather than followed. These requests carry the pull
    // token, and a base that reads as an ordinary workspace on the approval page
    // could otherwise bounce them at an internal host. undici already strips
    // Authorization across a cross-origin redirect, so this is one option that
    // removes a dependency on that behaviour rather than a live leak.
    { headers: { authorization: `Bearer ${deps.target.token}` }, redirect: "error" },
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
    if (!(await deps.deliveries.claim(source, String(row.id)))) {
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
    redirect: "error",
  });
  if (!ack.ok) {
    // The cursor stays put: the batch will be re-delivered and short-circuit on
    // the claims above, which is exactly the behaviour we want.
    throw new Error(`akiroo outbox ack failed (${ack.status}) for ${ids.length} row(s)`);
  }
  const acked = ((await ack.json().catch(() => ({}))) as { acked?: number }).acked ?? ids.length;
  await deps.cursor.set(source, Math.max(...ids));
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
  /** Which side of the precedence rule supplied the pair. See AkirooResolution. */
  status: AkirooConfigStatus;
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
  retarget: (resolution: AkirooResolution) => void;
  recordPull: (result: AkirooSweepResult) => void;
  recordError: (error: unknown) => void;
} {
  const state: AkirooConnectorState = {
    configured: target !== undefined,
    url: target?.url ?? "",
    status: target === undefined ? "unset" : "env",
  };
  // The token's IDENTITY, never the token: a short digest, kept out of
  // AkirooConnectorState so no Settings row can ever render it.
  let tokenPrint = target === undefined ? "" : akirooTokenPrint(target.token);
  return {
    read: () => ({ ...state }),
    // The connector can now change under a running worker (the connect
    // handshake writes the runtime config while this process polls), so the
    // last pull of the PREVIOUS target must not be reported as this one's.
    //
    // The token is part of "changed". A rotation that keeps the same URL and
    // the same source is still a different credential, and returning early on
    // it left the dashboard showing the OLD token's last-pull time as if it
    // were the new one's — which reads as "the new token is working" before it
    // has been used once.
    retarget: (resolution) => {
      const url = resolution.target?.url ?? "";
      const print = resolution.target === undefined ? "" : akirooTokenPrint(resolution.target.token);
      if (state.url === url && state.status === resolution.status && tokenPrint === print) return;
      tokenPrint = print;
      state.configured = resolution.target !== undefined;
      state.url = url;
      state.status = resolution.status;
      delete state.lastPullAt;
      delete state.lastPulled;
      if (resolution.reason !== undefined) state.lastError = resolution.reason;
      else delete state.lastError;
    },
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
