import { normalizeAkirooBase } from "./akiroo.js";

/**
 * The Ship half of the browser-mediated Akiroo connect: the server-to-server
 * leg that turns an approved handshake into a pull token.
 *
 * Ship has no inbound route from the internet, so Akiroo's server can never
 * reach it. The operator's browser is the only party that can see both sides,
 * and this is the whole reason the flow exists. What the browser carries is
 * deliberately not a credential:
 *
 *   Ship -> Akiroo (browser)   request_id + challenge + Ship's address
 *   Akiroo -> Ship (browser)   request_id + DELIVERY CODE
 *   Ship -> Akiroo (server)    request_id + VERIFIER + delivery code -> pull token
 *
 * That is PKCE, and the property to preserve is that the verifier never travels
 * through the browser. A fully observed browser leg — history, access log,
 * Referer, an extension with tab access — still cannot be exchanged for a
 * token, because the exchange requires the preimage of a hash only this Ship
 * holds. The token likewise never touches the browser: it is the response to
 * this POST and goes straight into the runtime config store.
 *
 * The delivery code is the other half, and it is the half PKCE cannot supply.
 * PKCE proves the redeemer STARTED the handshake; it does not prove the owner
 * approved THIS Ship. Akiroo mints the code at approval time and sends it only
 * to the ship_url its approval page displayed, so an attacker who induced an
 * approval naming somebody else's Ship never receives it. See
 * connect-requests.ts validDeliveryCode for the attack it closes.
 *
 * Everything here is pure or takes its `fetch` as a parameter, because the two
 * properties that matter (a request is redeemed exactly once against the origin
 * the operator typed, and a failed redemption is explained in words an operator
 * can act on) are the kind that need a test, and a route module has no test
 * harness in this repo.
 */

/** The keys the completed handshake writes into the runtime config store. */
export const AKIROO_ORG_ID_KEY = "AKIROO_ORG_ID";
export const AKIROO_ORG_NAME_KEY = "AKIROO_ORG_NAME";

/** How long Ship waits on Akiroo before calling the exchange unreachable. */
export const EXCHANGE_TIMEOUT_MS = 10_000;

/**
 * Cap on the exchange response body.
 *
 * The response is three short strings. Anything larger is either not Akiroo or
 * is an error page, and reading it unbounded would let whatever the operator
 * typed as their workspace URL decide how much memory this process spends.
 *
 * Enforced while READING, not from Content-Length. A chunked response declares
 * no length, so a header check alone caps nothing at all on exactly the reply
 * an unfriendly server would send — the reader below stops at the cap and
 * abandons the rest.
 */
export const EXCHANGE_MAX_BYTES = 64 * 1024;

/**
 * Why an exchange did not produce a token. Distinguished because the operator's
 * next move differs: a dead request means start the connect again on Ship, an
 * unreachable host means fix the network and the request may still be good.
 */
export type ExchangeFailure =
  | "expired"
  | "already-used"
  | "unknown-request"
  | "rejected"
  | "rate-limited"
  | "unreachable"
  | "workspace-error"
  | "bad-response"
  | "origin-mismatch";

export interface ExchangeSuccess {
  ok: true;
  /** The Akiroo base Ship should poll — always the origin it just POSTed to. */
  akirooUrl: string;
  /** Plaintext, shown once by Akiroo. Never rendered, never logged. */
  pullToken: string;
  /** What to call the workspace on Ship's own Settings page, when Akiroo named it. */
  orgLabel?: string;
  orgId?: string;
}

export interface ExchangeError {
  ok: false;
  failure: ExchangeFailure;
  /** Operator-facing sentence. Never carries the verifier, the token or a response body. */
  message: string;
}

export type ExchangeOutcome = ExchangeSuccess | ExchangeError;

/** Whether the handshake is dead and the operator has to start it again on Ship. */
export function requestIsSpent(failure: ExchangeFailure): boolean {
  return failure === "expired" || failure === "already-used" || failure === "unknown-request";
}

function failed(failure: ExchangeFailure, message: string): ExchangeError {
  return { ok: false, failure, message };
}

/** Akiroo's machine-readable `reason`, when it sent one, mapped to ours. */
function failureFromReason(reason: string, status: number): ExchangeFailure {
  if (reason === "expired") return "expired";
  if (reason === "already_used") return "already-used";
  if (reason === "unknown_request") return "unknown-request";
  // A verifier that does not hash to the stored challenge is not a dead
  // request: it means the two sides disagree about what was approved, which is
  // a refusal to restart from, not to retry. The same answer covers a delivery
  // code that does not match, which Akiroo cannot distinguish either — both
  // fall out of the same atomic claim matching no row.
  //
  // `verifier_mismatch` is the string Akiroo actually emits
  // (connections_handshake.go errConnectVerifier). This branch said
  // "bad_verifier" until the two were compared side by side; it produced the
  // right outcome only because the default fallthrough is also "rejected",
  // which is the kind of agreement that stops being true the moment either
  // side adds a case.
  // `delivery_mismatch` (connections_handshake.go errConnectDelivery) is named
  // here for the same reason: it too reached the right outcome via the default
  // fallthrough, which is the identical latent bug one line up, reintroduced by
  // the change that added the delivery code.
  if (reason === "verifier_mismatch" || reason === "delivery_mismatch" || reason === "malformed") {
    return "rejected";
  }
  if (status === 404) return "unknown-request";
  if (status === 409) return "already-used";
  if (status === 429) return "rate-limited";
  return "rejected";
}

const MESSAGES: Record<ExchangeFailure, string> = {
  expired: "That connect has expired. Handshakes are good for ten minutes — start the connect again from Settings.",
  "already-used": "That handshake has already been redeemed. Start the connect again from Settings.",
  "unknown-request":
    "The workspace does not recognise that handshake. It may have been approved on a different workspace, or its approval may have been cleared. Start the connect again from Settings.",
  rejected:
    "The workspace refused the exchange. Start the connect again from Settings; if it keeps failing, check that this Ship and that workspace are on compatible versions.",
  "rate-limited": "The workspace is rate-limiting connect attempts. Wait a minute and start the connect again.",
  unreachable:
    "Ship could not reach that workspace. Check it is up and that this server has outbound access to it, then start the connect again.",
  // Deliberately NOT the unreachable message. A 5xx means the address answered
  // — the network is fine and the operator's next hour belongs in the
  // workspace's logs, not in a firewall rule. Reporting this as "could not
  // reach" sent them to debug connectivity that had just demonstrably worked.
  "workspace-error":
    "The workspace answered, but with a server error. Nothing was stored. Check the workspace's logs, then start the connect again from Settings.",
  "bad-response": "That address answered, but not like an Akiroo workspace. Check the URL you entered on Settings.",
  "origin-mismatch":
    "The workspace answered with a different address than the one this connect was started against. Nothing was stored. Start the connect again from Settings.",
};

/**
 * Redeem an approved handshake for a pull token, server-side.
 *
 * `origin` is the base the OPERATOR typed when they started this handshake,
 * read back out of Ship's own pending-request row — never out of the query
 * string the browser came back with. It is the ONLY address contacted, and the
 * `akiroo_url` in the response is checked against it rather than believed, so a
 * workspace cannot answer a redemption by pointing the poller somewhere else.
 *
 * Redirects are an error rather than followed. Without that, an address that
 * reads as perfectly ordinary can bounce this request to an internal host, and
 * the origin the operator typed stops describing where their credential went.
 * The same option is set on the ongoing poll.
 *
 * `origin` is used VERBATIM including any path prefix — the one representation
 * of a workspace address that the approve link, this exchange and the outbox
 * poll all share (connect-requests.ts workspaceIdentity). Reducing it to a bare
 * origin here would address a path-prefixed Akiroo differently than the leg
 * that got it approved.
 */
export async function exchangeConnectRequest(options: {
  origin: string;
  requestId: string;
  /** The PKCE verifier. Sent ONLY here, in a server-to-server POST body. */
  verifier: string;
  /**
   * The delivery code Akiroo sent through the browser to the Ship its approval
   * page displayed. Required rather than optional: an exchange that forgot it
   * is refused by the workspace, and a caller that cannot supply one has not
   * been through an approval at all.
   */
  deliveryCode: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ExchangeOutcome> {
  const base = normalizeAkirooBase(options.origin);
  if (base === null) return failed("bad-response", MESSAGES["bad-response"]);
  const doFetch = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(`${base}/api/connections/teploy_ship/handshake/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        request_id: options.requestId,
        verifier: options.verifier,
        delivery_code: options.deliveryCode,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? EXCHANGE_TIMEOUT_MS),
    });
  } catch {
    // The thrown error is deliberately not carried into the message: it can
    // quote the request URL, and a future edit that moved anything secret into
    // that URL would leak it here. The operator does not need it to act on this.
    return failed("unreachable", MESSAGES.unreachable);
  }

  if (!response.ok) {
    if (response.status >= 500) return failed("workspace-error", MESSAGES["workspace-error"]);
    if (response.status === 429) return failed("rate-limited", MESSAGES["rate-limited"]);
    const reason = await readReason(response);
    const failure = failureFromReason(reason, response.status);
    return failed(failure, MESSAGES[failure]);
  }

  const body = await readJson(response);
  if (body === null) return failed("bad-response", MESSAGES["bad-response"]);
  const pullToken = typeof body.pull_token === "string" ? body.pull_token.trim() : "";
  const claimed = typeof body.akiroo_url === "string" ? body.akiroo_url : "";
  if (pullToken === "") return failed("bad-response", MESSAGES["bad-response"]);

  // The workspace is allowed to name itself differently in cosmetic ways (a
  // trailing slash, a different path prefix) but not to name a different host.
  const claimedBase = normalizeAkirooBase(claimed);
  if (claimedBase !== null && !sameOriginBase(claimedBase, base)) {
    return failed("origin-mismatch", MESSAGES["origin-mismatch"]);
  }

  return {
    ok: true,
    // The origin Ship contacted, not the one the response asserted: the
    // operator typed this one, so this is the one that gets polled.
    akirooUrl: base,
    pullToken,
    ...(typeof body.org_label === "string" && body.org_label !== "" ? { orgLabel: body.org_label } : {}),
    ...(typeof body.org_id === "string" && body.org_id !== "" ? { orgId: body.org_id } : {}),
  };
}

function sameOriginBase(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** An error body's `reason` field, or "" — never the body itself. */
async function readReason(response: Response): Promise<string> {
  const body = await readJson(response).catch(() => null);
  return body !== null && typeof body.reason === "string" ? body.reason : "";
}

/**
 * Read at most EXCHANGE_MAX_BYTES of a body, as text.
 *
 * Reading the stream rather than calling `.text()` is the point. `.text()`
 * buffers whatever arrives, so a Content-Length check in front of it caps
 * nothing when the response is chunked — which is the one case a hostile
 * server controls completely. Here the cap is the loop condition: past it the
 * body is abandoned, the reader cancelled, and the response treated as not
 * being an Akiroo answer.
 */
async function readCapped(response: Response): Promise<string | null> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      size += value.byteLength;
      if (size > EXCHANGE_MAX_BYTES) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Parse a capped JSON body, or null.
 *
 * Content-type is required rather than sniffed: an HTML login page that happens
 * to contain the word "pull_token" is not an answer, and refusing anything that
 * is not declared JSON is the cheapest way to say so.
 */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!type.includes("application/json")) return null;
  const text = await readCapped(response);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
