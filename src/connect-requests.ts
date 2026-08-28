import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

import { readJsonFile, updateJsonFile } from "./file-store.js";
import { normalizeAkirooBase, workspaceIdentity } from "./akiroo.js";
import { stateDir } from "./run-store.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";

/**
 * Handshakes THIS Ship started, and the PKCE verifier for each.
 *
 * This store is the whole reason the connect flow was turned around. In the
 * first version Akiroo started the handshake and Ship approved it, which meant
 * an unsolicited link was enough to make a Ship accept a stranger's workspace:
 * whoever started the flow held the code, so whoever started the flow could
 * satisfy every check the approval page knew how to make. Nothing derived from
 * the link can fix that, because the attacker owns the link.
 *
 * So the side that RECEIVES the credential now starts the flow, and this table
 * is the local state that makes "I started this" checkable. A browser arriving
 * at /connect/return names a request_id; if there is no row here for it — or it
 * has expired, or it has already been spent — Ship refuses and nothing is
 * exchanged. A link alone can no longer cause a connect, because a link cannot
 * put a row in here.
 *
 * The verifier NEVER leaves this process except in the server-to-server POST
 * that redeems it. Only its sha256 (the challenge) travels through the browser,
 * so a fully observed browser leg still cannot be turned into a pull token.
 */

/**
 * Ten minutes, matching the contract. Long enough to read an approval page
 * carefully and short enough that an abandoned handshake is not a credential
 * waiting to be picked up.
 */
export const CONNECT_REQUEST_TTL_MS = 10 * 60_000;

export interface ConnectRequest {
  /** Public: travels to Akiroo and comes back in the return URL. */
  requestId: string;
  /**
   * SECRET. Never rendered, never logged, never put in a redirect, and
   * BLANKED in the store the moment the request is claimed — see claim().
   */
  verifier: string;
  /** The Akiroo base the operator typed, already validated and normalised. */
  akirooUrl: string;
  /** ISO. */
  expiresAt: string;
  /** ISO once claimed; "" while the request is still live. */
  usedAt: string;
}

/**
 * Why a return could not be honoured. Distinguished because the operator's next
 * move differs: an unknown request means the link did not come from a connect
 * this Ship started, which is the case worth reading twice.
 */
export type ClaimFailure = "unknown" | "expired" | "already-used";

export type ClaimOutcome = { ok: true; request: ConnectRequest } | { ok: false; failure: ClaimFailure };

export const CLAIM_MESSAGES: Record<ClaimFailure, string> = {
  unknown:
    "This Ship did not start that connect. Nothing was stored and no credential was requested. " +
    "If you reached this page from a link someone sent you, close it — a connect can only be started here, " +
    "on Settings, by an admin typing a workspace address.",
  expired:
    "That connect took longer than ten minutes and has expired. Nothing was stored. " +
    "Start it again from Settings.",
  "already-used":
    "That connect has already been completed once. Nothing further was stored. " +
    "If this Ship is not bound to the workspace you expected, start the connect again from Settings.",
};

export interface ConnectRequestStore {
  /** Record a handshake this Ship is starting. */
  create(request: ConnectRequest): Promise<void>;
  /**
   * Spend a request, exactly once.
   *
   * Single-use is enforced by the write itself rather than by a read followed
   * by a write: two browser tabs returning at the same moment must produce one
   * exchange and one refusal, not two exchanges against a workspace that only
   * expects one.
   *
   * A won claim also ERASES the verifier from the store. The row stays — it is
   * what makes a second return read as "already completed" rather than as a
   * handshake this Ship never started — but the secret in it does not, because
   * a spent request kept its verifier until the next create pruned it by
   * expiry, which on a Ship that connects once is never. The claim hands the
   * verifier back to the caller and leaves nothing behind to hand to anyone
   * else.
   */
  claim(requestId: string, now?: Date): Promise<ClaimOutcome>;
}

/** 128 bits, base64url. Public, so this only has to be unguessable-enough to not collide. */
export function newRequestId(): string {
  return randomBytes(16).toString("base64url");
}

/** 256 bits, base64url. The secret half of the PKCE pair. */
export function newVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * base64url(sha256(verifier)) — the only half of the pair the browser sees.
 *
 * Named to match the contract Akiroo verifies against; both sides compute this
 * identically or the exchange fails, which is the intended failure.
 */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

/**
 * The query parameter Akiroo's approval redirect carries the delivery code in.
 *
 * Named here rather than spelled in the route so the wire name has one
 * definition on this side. Akiroo sets it; Ship reads it and puts it straight
 * into the exchange body as `delivery_code`.
 *
 * It must match `q.Set("delivery", ...)` in akiroo/connections_handshake.go.
 * This read `"code"` until 2026-08-27, against Akiroo's `"delivery"`, so every
 * connect refused at the return leg before the exchange was ever attempted —
 * while both repos' suites stayed green, because each pinned its own spelling.
 * A cross-repo conformance check caught it; neither unit suite could.
 */
export const DELIVERY_CODE_PARAM = "delivery";

/**
 * The delivery code: the half of the approval that can only arrive by browser.
 *
 * PKCE alone proved that whoever redeems is whoever STARTED — it does not prove
 * the approval was for the Ship the owner was looking at. An attacker can mint
 * their own request id and verifier, send an owner a /connect/approve link that
 * DISPLAYS the owner's own familiar Ship, and then redeem the approval from
 * their own server: the browser leg lands harmlessly on the real Ship, which
 * has no local row and refuses, while the attacker walks off with the
 * workspace's pull token.
 *
 * The delivery code closes that by making the approval's other half travel only
 * to the address the approval page displayed. Akiroo mints it, stores its
 * sha256, and puts the plaintext in the redirect to the DISPLAYED ship_url; the
 * exchange requires request id, verifier AND delivery code in one atomic claim.
 * So the attacker must choose: name the victim's real Ship and the code goes to
 * a server they do not control, or name their own address and the owner is
 * looking at an unfamiliar host instead of a reassuring one.
 *
 * It is a bearer credential for the seconds it is in flight, so it is treated
 * like the verifier on this side: never rendered, never logged, and carried no
 * further than the exchange body.
 */
export function validDeliveryCode(raw: string): boolean {
  // 32 bytes base64url is 43 characters; the bound is generous on the top end
  // so a longer code from a future Akiroo is not refused by Ship, and tight
  // enough that a query string full of junk is not sent on to the workspace.
  return /^[A-Za-z0-9_-]{22,128}$/.test(raw);
}

/**
 * Where Ship sends the browser to get the handshake approved.
 *
 * Built here rather than in the route so the one rule that matters is in one
 * place and testable: the verifier is not a parameter of this function, so it
 * cannot end up in the URL by an edit that looked harmless.
 *
 * Built on the FULL base the operator typed, path prefix and all — see
 * workspaceIdentity. An Akiroo served at https://host/akiroo has its approval
 * page at https://host/akiroo/connect/approve, and addressing it at the origin
 * would send the operator to a 404 on exactly the deployment Akiroo documents
 * as supported.
 */
export function approveUrl(options: {
  akirooUrl: string;
  requestId: string;
  challenge: string;
  shipUrl: string;
}): string | null {
  const base = normalizeAkirooBase(options.akirooUrl);
  if (base === null) return null;
  const url = new URL(`${base}/connect/approve`);
  url.searchParams.set("request", options.requestId);
  url.searchParams.set("challenge", options.challenge);
  url.searchParams.set("ship", options.shipUrl);
  return url.toString();
}

/**
 * The one representation of a workspace address, defined in akiroo.ts next to
 * the validator it builds on. Re-exported here because every leg of the connect
 * reaches for it through this module.
 */
export { workspaceIdentity };

/**
 * Does the `akiroo` parameter on the return leg name the workspace this request
 * was started against?
 *
 * Compared as full workspace identities, not as origins. Akiroo describes
 * itself with its configured PUBLIC_BASE_URL, which is the same value Ship was
 * told to poll, so a difference in the path prefix is a real disagreement about
 * which installation this is and not decoration to be forgiven. Only a trailing
 * slash is cosmetic, and normalizeAkirooBase has already removed it.
 */
export function sameWorkspace(a: string, b: string): boolean {
  const left = workspaceIdentity(a);
  const right = workspaceIdentity(b);
  return left !== null && right !== null && left === right;
}

/**
 * A workspace address reduced to something safe to put in a refusal an operator
 * reads.
 *
 * The value on the return leg arrives from a redirect, so it is attacker-shaped
 * input in the case that matters. Naming it is the point — an operator cannot
 * act on "a different workspace" without seeing which — but it is normalised
 * when it parses, stripped of control characters either way, and bounded
 * either way so a refusal page cannot be turned into a wall of text.
 */
export function describeWorkspace(raw: string): string {
  // Bounded on BOTH branches. A perfectly valid URL can be four hundred
  // characters of path, so parsing is not what makes a value safe to put on a
  // page — the cap is.
  // eslint-disable-next-line no-control-regex
  const cleaned = (workspaceIdentity(raw) ?? raw).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (cleaned === "") return "no workspace at all";
  return cleaned.length > 120 ? `${cleaned.slice(0, 120)}...` : cleaned;
}

/**
 * What a claimed row looks like once it is written back: marked spent, and
 * emptied of its verifier.
 *
 * One definition, used by both in-process stores, so the two cannot disagree
 * about whether a spent handshake still holds a secret. The Nucleus store
 * expresses the same thing in its claiming UPDATE, because there the write has
 * to be conditional to be the decision as well as the record.
 */
function spend(row: ConnectRequest, now: Date): ConnectRequest {
  return { ...row, verifier: "", usedAt: now.toISOString() };
}

function claimFrom(row: ConnectRequest | undefined, now: Date): ClaimOutcome {
  if (row === undefined) return { ok: false, failure: "unknown" };
  if (row.usedAt !== "") return { ok: false, failure: "already-used" };
  if (Date.parse(row.expiresAt) <= now.getTime()) return { ok: false, failure: "expired" };
  return { ok: true, request: row };
}

/** File-backed: one JSON object mapping request_id -> row. Single-process by construction. */
export class FileConnectRequests implements ConnectRequestStore {
  #path: string;

  constructor(dir = stateDir()) {
    this.#path = join(dir, "connect-requests.json");
  }

  async create(request: ConnectRequest): Promise<void> {
    const cutoff = Date.now();
    await updateJsonFile<Record<string, ConnectRequest>>(this.#path, {}, (all) => {
      const next: Record<string, ConnectRequest> = {};
      // Prune on write rather than on a timer: an expired handshake is dead
      // weight that still holds a verifier, and this file is only ever touched
      // by a human starting a connect.
      for (const [id, row] of Object.entries(all)) {
        if (Date.parse(row.expiresAt) > cutoff) next[id] = row;
      }
      next[request.requestId] = request;
      return next;
    });
  }

  async claim(requestId: string, now = new Date()): Promise<ClaimOutcome> {
    // File mode is single-process, so read-check-write inside the store's own
    // lock is the honest implementation; the Nucleus path below is the real
    // conditional one. Same split as fileRuntime's claimDecision.
    let outcome: ClaimOutcome = { ok: false, failure: "unknown" };
    await updateJsonFile<Record<string, ConnectRequest>>(this.#path, {}, (all) => {
      outcome = claimFrom(all[requestId], now);
      if (!outcome.ok) return all;
      // Marked spent AND emptied of its verifier in the same write. `outcome`
      // already holds the row that was read, so the caller still gets the
      // secret it won; what is written back no longer contains one.
      return { ...all, [requestId]: spend(outcome.request, now) };
    });
    return outcome;
  }
}

/**
 * The columns of ship_connect_requests, in DDL order.
 *
 * Exported because migration 007 probes exactly this list write-shaped
 * (`UPDATE ... SET c = c WHERE 1 = 0`) — one definition, so a column added here
 * and forgotten in the migration is not possible. Same arrangement as
 * RUNTIME_CONFIG_COLUMNS, for the same reason.
 */
export const CONNECT_REQUEST_COLUMNS = ["request_id", "verifier", "akiroo_url", "expires_at", "used_at"];

/**
 * Nucleus-backed, over a table of its OWN.
 *
 * A new table rather than a column on anything existing, per the house rule:
 * Nucleus cannot ALTER-ADD a column to a populated table, and every table Ship
 * already has is populated on a deployed box.
 *
 * `used_at` is TEXT holding "" rather than NULL while a request is live. That
 * is not cosmetic: the claim below is a conditional UPDATE whose filter has to
 * express "not yet spent", and an equality test against a known value is the
 * shape this store layer supports everywhere. NULL semantics vary; "" does not.
 */
export class NucleusConnectRequests implements ConnectRequestStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_connect_requests (
          request_id TEXT,
          verifier TEXT,
          akiroo_url TEXT,
          expires_at TEXT,
          used_at TEXT
        )`,
      )
      .then(() => undefined)
      // A failed ensure must not be cached: one transient store error would
      // otherwise poison every later call for the life of the process.
      .catch((error: unknown) => {
        this.#ready = null;
        throw error;
      });
    return this.#ready;
  }

  async create(request: ConnectRequest): Promise<void> {
    await this.#ensure();
    // Expired rows still hold a verifier, so they are removed rather than left
    // to accumulate. Best-effort: a failed prune must not stop a connect.
    await this.#db
      .query("DELETE FROM ship_connect_requests WHERE expires_at < $1", [new Date().toISOString()])
      .catch(() => []);
    await this.#db.query(
      `INSERT INTO ship_connect_requests (request_id, verifier, akiroo_url, expires_at, used_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [request.requestId, request.verifier, request.akirooUrl, request.expiresAt, request.usedAt],
    );
  }

  async claim(requestId: string, now = new Date()): Promise<ClaimOutcome> {
    await this.#ensure();
    // Read FIRST, because the claim below erases the verifier and a read after
    // it would come back empty. This read decides nothing: it is the UPDATE
    // that picks the winner, so a row that looks live here and is claimed by
    // another tab a millisecond later still loses on rowCount.
    const rows = await this.#db.query(
      "SELECT request_id, verifier, akiroo_url, expires_at, used_at FROM ship_connect_requests WHERE request_id = $1",
      [requestId],
    );
    const row = rows[0];
    if (row === undefined) return { ok: false, failure: "unknown" };
    // One conditional UPDATE decides the winner: `used_at = ''` is part of the
    // filter, so a second returner updates zero rows and is refused. It also
    // empties the verifier, so the spent row keeps its identity and its
    // "already completed" answer without keeping the secret.
    const spent = await this.#db.exec(
      "UPDATE ship_connect_requests SET used_at = $1, verifier = $4 WHERE request_id = $2 AND used_at = $3",
      [now.toISOString(), requestId, "", ""],
    );
    if (spent === 0) return { ok: false, failure: "already-used" };
    const request: ConnectRequest = {
      requestId: String(row.request_id ?? ""),
      verifier: String(row.verifier ?? ""),
      akirooUrl: String(row.akiroo_url ?? ""),
      expiresAt: String(row.expires_at ?? ""),
      // The row now carries the claim we just made; report it unspent so the
      // caller sees the request it won rather than the mark that proves it did.
      usedAt: "",
    };
    // Expiry is checked AFTER the claim, not instead of it: claiming an aged
    // row costs nothing and burning it is the correct outcome anyway — the
    // verifier inside it must not be redeemable a second time.
    if (Date.parse(request.expiresAt) <= now.getTime()) return { ok: false, failure: "expired" };
    if (request.verifier === "") return { ok: false, failure: "unknown" };
    return { ok: true, request };
  }
}

/** In-memory, for tests and for callers that want no disk. */
export class MemoryConnectRequests implements ConnectRequestStore {
  #rows = new Map<string, ConnectRequest>();

  async create(request: ConnectRequest): Promise<void> {
    this.#rows.set(request.requestId, request);
  }

  async claim(requestId: string, now = new Date()): Promise<ClaimOutcome> {
    const outcome = claimFrom(this.#rows.get(requestId), now);
    if (outcome.ok) this.#rows.set(requestId, spend(outcome.request, now));
    return outcome;
  }
}
