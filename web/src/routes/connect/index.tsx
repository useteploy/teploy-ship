import {
  CONNECT_REQUEST_TTL_MS,
  approveUrl,
  challengeFor,
  newRequestId,
  newVerifier,
  normalizeAkirooBase,
  resolveAkirooTarget,
  sealingStatus,
} from "../../lib/ship.server.js";
import { connectAccess, connectLimits } from "../../lib/connect.server.js";
import { checkRateLimit, clientKey, delay } from "../../lib/ratelimit.server.js";
import { publicOrigin, trustProxy } from "../../lib/oidc.server.js";
import { currentUser, sameOrigin } from "../../lib/session.server.js";
import { shipRuntime } from "../../lib/store.server.js";

export const config = { mode: "app" };

/**
 * Start a connect to an Akiroo workspace. SHIP starts it — that is the design.
 *
 * The operator types a workspace address here, on a page they navigated to
 * themselves, behind their own admin session. Ship mints a request id and a
 * PKCE verifier, keeps both locally, and hands the browser a link to the
 * workspace's approval page carrying only the request id and the CHALLENGE.
 * The verifier stays here, so the browser leg is not a credential and cannot be
 * turned into one by anyone who observes it.
 *
 * What this page will not do, and why each was a real option:
 *   - accept a workspace address from a link. A GET that starts a handshake is
 *     a handshake anyone can start on an admin's behalf. Starting is a POST,
 *     CSRF-checked with the same sameOrigin helper as every other mutation.
 *   - redirect straight to Akiroo after the POST. Ship's own CSP sets
 *     `form-action 'self'`, which Chrome enforces across the redirect that
 *     follows a form post, so a 302 to another origin here is blocked by the
 *     browser and reads to the operator as a hang. The POST answers with a page
 *     naming the exact address it is about to send them to, which is a better
 *     last look anyway.
 *   - put the verifier anywhere a browser can see it. approveUrl takes no
 *     verifier parameter, so that cannot regress by accident.
 */

interface ConnectData {
  state: "form" | "forbidden";
  role?: string;
  /** The workspace this Ship polls today, if any — connecting replaces it. */
  current?: { origin: string; source: string };
  /** Ship's own public address, which is what Akiroo will send the browser back to. */
  shipOrigin?: string;
  /** Set when the stored pull token would not be encrypted at rest. */
  sealingWarning?: string;
}

interface ConnectActionData {
  state: "handoff" | "bad-url" | "error";
  /** Where to continue. Built server-side from the validated address. */
  approve?: string;
  /** The workspace origin, for the operator to read before they leave. */
  origin?: string;
  message?: string;
}

function forbidden(body: string): Response {
  return new Response(body, { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function loader({ request }: { request: Request }): Promise<ConnectData> {
  // The layout already requires admin for /connect (requiredRole, ADMIN_PREFIXES).
  // Checked again here because a route that relies on a list in another file for
  // its only authorization is one edit away from being open, and because the
  // page has something better to say than a bare 403.
  const me = await currentUser(request);
  if (connectAccess(me) !== "allowed") return { state: "forbidden", role: me?.role ?? "viewer" };

  const runtime = await shipRuntime();
  const resolution = await resolveAkirooTarget(runtime.config);
  const sealing = sealingStatus();
  return {
    state: "form",
    shipOrigin: publicOrigin(request),
    ...(resolution.target !== undefined
      ? { current: { origin: resolution.target.url, source: resolution.status } }
      : {}),
    ...(sealing.sealed ? {} : { sealingWarning: sealing.detail }),
  };
}

export async function action({ request }: { request: Request }): Promise<ConnectActionData | Response> {
  // Both gates on the action too. An action reachable without the loader's
  // check is a real bypass: nothing makes a browser fetch the loader first.
  if (!sameOrigin(request)) {
    // Diagnostic for the 2026-08-28 blocked-connect investigation: the three
    // headers the check reads, on the refusal path only. Remove once the
    // browser-side cause is identified.
    console.warn(
      `[connect] csrf refusal: sec-fetch-site=${JSON.stringify(request.headers.get("sec-fetch-site"))} ` +
        `origin=${JSON.stringify(request.headers.get("origin"))} host=${JSON.stringify(request.headers.get("host"))} ` +
        `url=${request.url}`,
    );
    return forbidden("Cross-origin request blocked.");
  }
  const me = await currentUser(request);
  if (connectAccess(me) !== "allowed") return forbidden("Forbidden — connecting a workspace requires the admin role.");

  const client = clientKey(request, trustProxy());
  const limit = checkRateLimit(`connect:${client.key}`, Date.now(), connectLimits, client.lockable);
  if (!limit.allowed) {
    return { state: "error", message: `Too many attempts. Try again in ${limit.retryAfterSeconds ?? 300} seconds.` };
  }
  if (limit.delayMs !== undefined) await delay(limit.delayMs);

  const form = await request.formData();
  const typed = String(form.get("akiroo") ?? "").trim();
  // http/https only, a real host, no user:pass@ — the same validation the
  // connector re-runs on every resolve, applied before anything is stored.
  const base = normalizeAkirooBase(typed);
  if (base === null) {
    return {
      state: "bad-url",
      message:
        "That is not a workspace address this Ship will talk to. It must be a plain http or https URL with a host " +
        "and no embedded credentials — for example https://lite.akiroo.com.",
    };
  }

  const requestId = newRequestId();
  const verifier = newVerifier();
  const approve = approveUrl({
    akirooUrl: base,
    requestId,
    challenge: challengeFor(verifier),
    shipUrl: publicOrigin(request),
  });
  if (approve === null) return { state: "bad-url", message: "That workspace address could not be used." };

  // Stored BEFORE the browser is sent anywhere. The row is what /connect/return
  // looks for, so a handshake that was never recorded here can never complete —
  // which is the property that makes an unsolicited return link inert.
  const runtime = await shipRuntime();
  await runtime.connectRequests.create({
    requestId,
    verifier,
    akirooUrl: base,
    expiresAt: new Date(Date.now() + CONNECT_REQUEST_TTL_MS).toISOString(),
    usedAt: "",
  });
  // The audit line. The address and who typed it; never the verifier.
  console.log(`[ship] akiroo connect started for ${base} by ${me?.user ?? "unknown"}`);

  return { state: "handoff", approve, origin: new URL(base).origin };
}

const PANEL = "border:1px solid var(--border);border-radius:8px;padding:16px 18px;margin:16px 0;background:var(--panel)";
const ORIGIN = "display:block;margin:10px 0 4px;font-size:20px;font-weight:600;word-break:break-all";
const FIELD = "background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px 10px;font-size:15px;width:340px;max-width:100%";

export default function Connect({ data, actionData }: { data: ConnectData; actionData?: ConnectActionData }) {
  if (actionData?.state === "handoff") {
    return (
      <>
        <h1 class="page">Continue on the workspace</h1>
        <div style={PANEL}>
          <p>Ship has started a connect to</p>
          <code style={ORIGIN}>{actionData.origin}</code>
          <p class="meta">
            Read that address once more. The next step signs you in to that workspace and asks an owner there to approve
            handing this Ship a pull token.
          </p>
        </div>
        <p>
          {/* A link, not an auto-redirect. The operator leaves this site on a
              click they made, and they can see where to before they make it. */}
          <a href={actionData.approve}>Continue to the workspace</a>
        </p>
        <p class="meta">
          This connect expires in ten minutes. Nothing has been stored yet — Ship only accepts a workspace once that
          approval comes back to this server.
        </p>
      </>
    );
  }

  if (data.state === "forbidden") {
    return (
      <>
        <h1 class="page">Connect a workspace</h1>
        <div style={PANEL}>
          <p>
            Connecting a workspace requires the <b>admin</b> role, and you are signed in as <b>{data.role}</b>.
          </p>
          <p class="meta">
            Completing this hands Ship a credential that pulls work someone else queued, so it sits behind the same gate
            as the rest of Settings.
          </p>
        </div>
        <p><a href="/">Back to the inbox</a></p>
      </>
    );
  }

  return (
    <>
      <h1 class="page">Connect a workspace</h1>
      <p class="meta">
        Ship COLLECTS work from an Akiroo workspace: issues to fix, and decisions on runs parked for approval. Enter the
        workspace address and Ship will ask an owner there to approve the connection.
      </p>

      {data.current !== undefined && (
        <p style="color:var(--yellow)">
          This replaces the workspace this Ship polls today ({data.current.origin},{" "}
          {data.current.source === "runtime" ? "set by an earlier connect" : "set by the environment"}). One Ship polls
          one workspace.
        </p>
      )}

      {actionData?.state === "bad-url" && <p style="color:var(--red)">{actionData.message}</p>}
      {actionData?.state === "error" && <p style="color:var(--red)">{actionData.message}</p>}

      <label class="meta" for="akiroo" style="display:block;margin-top:18px">
        Workspace address
      </label>
      <form method="post" class="row-actions" style="gap:10px;margin-top:8px;flex-wrap:wrap">
        <input
          id="akiroo"
          type="url"
          name="akiroo"
          placeholder="https://lite.akiroo.com"
          autocomplete="off"
          spellcheck={false}
          required
          style={FIELD}
        />
        <button type="submit">Start connect</button>
      </form>

      {data.shipOrigin !== undefined && (
        <p class="meta" style="margin-top:14px">
          Ship will tell the workspace to send you back to <code>{data.shipOrigin}</code>. If that is not an address your
          browser can reach, set <code>SHIP_PUBLIC_URL</code> before starting.
        </p>
      )}

      {data.sealingWarning !== undefined && <p style="color:var(--yellow)">{data.sealingWarning}</p>}

      <p class="meta" style="margin-top:14px">
        Ship needs only outbound access to the workspace — no inbound port and no public route. If a link claiming to
        connect this Ship arrives by mail, ignore it: a connect that was not started on this page cannot complete.
      </p>
    </>
  );
}
