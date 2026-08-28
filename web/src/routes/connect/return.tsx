import {
  AKIROO_ORG_ID_KEY,
  AKIROO_ORG_NAME_KEY,
  AKIROO_TOKEN_KEY,
  AKIROO_URL_KEY,
  CLAIM_MESSAGES,
  DELIVERY_CODE_PARAM,
  akirooWorkspaceKey,
  describeWorkspace,
  exchangeConnectRequest,
  requestIsSpent,
  sameWorkspace,
  sealingStatus,
  validDeliveryCode,
  workspaceIdentity,
} from "../../lib/ship.server.js";
import { connectAccess, isTopLevelNavigation } from "../../lib/connect.server.js";
import { currentUser } from "../../lib/session.server.js";
import { shipRuntime } from "../../lib/store.server.js";

export const config = { mode: "app" };

/**
 * The workspace approved; finish the connect.
 *
 * This route is the control that closes the phishing path the first version of
 * this flow had. It does exactly one thing before it will talk to anybody:
 * looks the request id up in SHIP'S OWN store. Absent, expired, already spent,
 * or naming a workspace other than the one the operator typed — all four are a
 * refusal in plain language, and nothing is stored and nothing is requested.
 *
 * So an unsolicited "re-authorize your Ship" link is inert now, not merely
 * hard to satisfy: whoever sends it cannot put a row in this Ship's store, and
 * without that row there is no verifier, and without the verifier the exchange
 * cannot happen. That is a structural property rather than a check an attacker
 * might be able to answer.
 *
 * It also carries the DELIVERY CODE. That value exists only in this redirect
 * and in Akiroo's approval row, it is the third thing the exchange requires,
 * and it reaches this Ship only because Akiroo sent the browser to the address
 * its approval page displayed. It is read out of the query, handed straight to
 * the exchange, and never put in the response, in a log line or in a message —
 * for the seconds it is alive it is a credential.
 *
 * The exchange itself is SERVER to server, from here to the workspace, so the
 * pull token never enters the browser. See akiroo-connect.ts.
 */

interface ReturnData {
  state: "refused" | "failed" | "forbidden";
  message: string;
  role?: string;
  /** True when starting over is the fix, so the page can say so plainly. */
  restart?: boolean;
}

export async function loader({ request }: { request: Request }): Promise<ReturnData | Response> {
  // Admin on the loader as well as in the layout's path list, for the same
  // reason /connect checks: a route whose only authorization lives in another
  // file is one edit away from being open. This route has no action — the
  // browser arrives here by a redirect from the workspace, which is a GET.
  const me = await currentUser(request);
  if (connectAccess(me) !== "allowed") {
    return {
      state: "forbidden",
      role: me?.role ?? "viewer",
      message: "Finishing a connect requires the admin role.",
    };
  }

  // A GET that spends a single-use row and makes an outbound request should
  // only run for a navigation the operator actually made.
  if (!isTopLevelNavigation(request)) {
    return { state: "refused", message: CLAIM_MESSAGES.unknown };
  }

  const url = new URL(request.url);
  const requestId = (url.searchParams.get("request") ?? "").trim();
  const claimedAkiroo = (url.searchParams.get("akiroo") ?? "").trim();
  const deliveryCode = (url.searchParams.get(DELIVERY_CODE_PARAM) ?? "").trim();
  const runtime = await shipRuntime();

  const claim = await runtime.connectRequests.claim(requestId);
  if (!claim.ok) {
    return { state: "refused", message: CLAIM_MESSAGES[claim.failure], restart: claim.failure !== "unknown" };
  }
  const pending = claim.request;

  // The workspace named in the return must be the workspace the operator typed.
  // Compared against the STORED value, never against anything else in this URL:
  // a return that arrives from somewhere else is a redirect that went astray or
  // a handshake being finished by a third party, and neither should reach the
  // exchange. The exchange itself contacts the stored address regardless, so
  // this is a refusal for the operator's benefit rather than the only guard.
  //
  // An ABSENT parameter is a refusal, not a skipped check. It was a skipped
  // check until this version, which meant the one guard the contract puts here
  // was bypassed by leaving a parameter off — the easiest thing in the world
  // for whoever wrote the link, and indistinguishable to the operator from a
  // connect that worked.
  if (!sameWorkspace(claimedAkiroo, pending.akirooUrl)) {
    // Both values, named. An Akiroo whose PUBLIC_BASE_URL disagrees with the
    // address the operator reached it on lands here, and "a different
    // workspace" alone sent them looking for an attacker rather than for the
    // setting that is actually wrong.
    return {
      state: "refused",
      message:
        `That approval came back naming ${describeWorkspace(claimedAkiroo)}, but this connect was started against ` +
        `${workspaceIdentity(pending.akirooUrl) ?? pending.akirooUrl}. Nothing was stored. ` +
        "If those are the same installation, its PUBLIC_BASE_URL does not match the address you reached it on; " +
        "otherwise start the connect again from Settings.",
      restart: true,
    };
  }

  // The delivery code is minted by Akiroo at approval time and sent only to the
  // Ship address its approval page displayed. Its absence means this browser
  // did not come from an approval on the workspace this handshake names, so
  // there is nothing to redeem and no reason to make an outbound request.
  if (!validDeliveryCode(deliveryCode)) {
    return {
      state: "refused",
      message:
        "That approval came back without the code the workspace issues when an owner approves. Nothing was stored. " +
        "Start the connect again from Settings, and approve it on the workspace's own page rather than following a link.",
      restart: true,
    };
  }

  const outcome = await exchangeConnectRequest({
    origin: pending.akirooUrl,
    requestId: pending.requestId,
    verifier: pending.verifier,
    deliveryCode,
  });
  if (!outcome.ok) {
    return {
      state: "failed",
      message: requestIsSpent(outcome.failure)
        ? `${outcome.message} Nothing was stored — this Ship still polls whatever it polled before.`
        : outcome.message,
      restart: true,
    };
  }

  const by = me?.user ?? "unknown";
  // Order matters only in that both land before the worker's next five-second
  // tick reads them; the resolver refuses a half-written pair rather than
  // pairing a new workspace's URL with the previous one's token.
  await runtime.config.set(AKIROO_URL_KEY, outcome.akirooUrl, by);
  await runtime.config.set(AKIROO_TOKEN_KEY, outcome.pullToken, by);
  await runtime.config.set(AKIROO_ORG_ID_KEY, outcome.orgId ?? "", by);
  await runtime.config.set(AKIROO_ORG_NAME_KEY, outcome.orgLabel ?? "", by);

  // Start this workspace's queue from the beginning. A reconnect that inherited
  // a position — the previous workspace's, or this one's from before its outbox
  // was rebuilt — polls past the top of a queue it has never read, receives
  // nothing forever, and reports itself connected. Re-scanning is cheap and the
  // delivery claims short-circuit anything already handled.
  await runtime.akirooCursor.reset(akirooWorkspaceKey(outcome.akirooUrl));

  // The audit line. Origin and workspace label only: the token and the verifier
  // are never written anywhere but the config row.
  console.log(
    `[ship] akiroo connector set to ${outcome.akirooUrl}` +
      `${outcome.orgId !== undefined ? ` (org ${outcome.orgId})` : ""} by ${by}`,
  );
  const sealing = sealingStatus();
  if (!sealing.sealed) console.warn(`[ship] ${sealing.detail}`);

  // Same-origin, so no form-action question: the operator lands on the page
  // that states what this Ship is now bound to, from the store rather than from
  // anything this request carried.
  return new Response(null, { status: 302, headers: { location: "/settings?view=system&connected=1" } });
}

const PANEL = "border:1px solid var(--border);border-radius:8px;padding:16px 18px;margin:16px 0;background:var(--panel)";

export default function ConnectReturn({ data }: { data: ReturnData }) {
  return (
    <>
      <h1 class="page">Connect not completed</h1>
      <div style={PANEL}>
        <p>{data.message}</p>
        {data.state === "forbidden" && (
          <p class="meta">You are signed in as {data.role}. Ask an admin to start the connect.</p>
        )}
      </div>
      <p class="row-actions" style="gap:14px">
        {data.restart === true && <a href="/connect">Start the connect again</a>}
        <a href="/settings?view=system">Settings</a>
        <a href="/">Back to the inbox</a>
      </p>
    </>
  );
}
