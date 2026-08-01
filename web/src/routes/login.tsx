import { authenticate, requestIsSecure, sessionSetCookie, currentUser } from "../lib/session.server.js";
import { oidcEnabled, oidcLabel, trustProxy } from "../lib/oidc.server.js";
import { checkRateLimit, clearRateLimit, clientKey, withVerifySlot } from "../lib/ratelimit.server.js";

export const config = { mode: "app" };

export async function loader({ request }: { request: Request }): Promise<Response | { sso: { label: string } | null }> {
  // Already signed in: the layout lets /login through unauthenticated, so
  // without this an authenticated visitor is shown a sign-in form while every
  // nav link works — indistinguishable from being signed out.
  if ((await currentUser(request)) !== null) {
    return new Response(null, { status: 302, headers: { location: "/" } });
  }
  return { sso: oidcEnabled() ? { label: oidcLabel() } : null };
}

export async function action({ request }: { request: Request }): Promise<Response | { error: string }> {
  const form = await request.formData();
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");

  // Two limits, for two different problems. The per-key window bounds password
  // GUESSING; the concurrency slot bounds the CPU an unauthenticated caller can
  // make this process spend, because every attempt (including a miss, by
  // design) runs scrypt on the shared threadpool and would otherwise starve the
  // store I/O the rest of the dashboard depends on.
  const key = `${clientKey(request, trustProxy())}|${username.toLowerCase()}`;
  const limit = checkRateLimit(key);
  if (!limit.allowed) {
    return { error: `Too many attempts. Try again in ${limit.retryAfterSeconds ?? 300} seconds.` };
  }
  const verified = await withVerifySlot(() => authenticate(username, password));
  if (verified.shed) {
    return { error: "The server is busy verifying sign-ins. Try again in a moment." };
  }
  const principal = verified.value;
  if (principal === null) {
    return { error: "Wrong username or password." };
  }
  // A legitimate user who mistyped twice is not an attacker.
  clearRateLimit(key);
  // The same trusted-proxy ladder OIDC uses. Reading X-Forwarded-Proto
  // unconditionally let a caller choose the scheme and strip Secure from a
  // privileged cookie on an HTTPS deployment.
  const cookie = sessionSetCookie(principal, requestIsSecure(request));
  return new Response(null, { status: 302, headers: { location: "/", "set-cookie": cookie } });
}

export default function Login({ data, actionData }: { data?: { sso: { label: string } | null }; actionData?: { error?: string } }) {
  const sso = data?.sso ?? null;
  const urlError = typeof location !== "undefined" ? new URLSearchParams(location.search).get("error") : null;
  const error = actionData?.error ?? urlError ?? undefined;
  return (
    <div class="login">
      <h1>Teploy Ship</h1>
      <p class="meta">Sign in to manage runs and approvals.</p>
      {sso !== null && (
        <>
          <a href="/oidc/login" class="sso-btn">{sso.label}</a>
          <div class="sso-divider">or</div>
        </>
      )}
      <form method="post">
        <input type="text" name="username" placeholder="username" autocomplete="username" autofocus />
        <input type="password" name="password" placeholder="password" autocomplete="current-password" />
        {error !== undefined && <p style="color: var(--red)">{error}</p>}
        <button type="submit">Sign in</button>
      </form>
      <p class="meta" style="margin-top:14px">
        First sign-in: use any username, and <code>SHIP_WEB_TOKEN</code> as the
        password — read it with <code>teploy secret get SHIP_WEB_TOKEN</code>.
        Then create named accounts in Settings.
      </p>
      <style dangerouslySetInnerHTML={{ __html: `
        .sso-btn { display:block; text-align:center; padding:9px 10px; margin:10px 0 4px;
          border:1px solid var(--border); border-radius:6px; color:var(--text); text-decoration:none; }
        .sso-btn:hover { border-color:var(--dim); text-decoration:none; }
        .sso-divider { display:flex; align-items:center; gap:10px; color:var(--dim); font-size:12px; margin:10px 0; }
        .sso-divider::before, .sso-divider::after { content:""; flex:1; height:1px; background:var(--border); }
      ` }} />
    </div>
  );
}
