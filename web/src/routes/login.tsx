import { authenticate, requestIsSecure, sessionSetCookie, currentUser } from "../lib/session.server.js";
import { oidcEnabled, oidcLabel, trustProxy } from "../lib/oidc.server.js";
import { checkRateLimit, clearRateLimit, clientKey, delay, loginLimits, withVerifySlot } from "../lib/ratelimit.server.js";

export const config = { mode: "app" };

export async function loader({ request }: { request: Request }): Promise<Response | { sso: { label: string } | null; error: string | null }> {
  // Already signed in: the layout lets /login through unauthenticated, so
  // without this an authenticated visitor is shown a sign-in form while every
  // nav link works — indistinguishable from being signed out.
  if ((await currentUser(request)) !== null) {
    return new Response(null, { status: 302, headers: { location: "/" } });
  }
  // The OIDC callback redirects here with ?error=…; read it on the server so
  // the rendered page and the hydrated one agree.
  return { sso: oidcEnabled() ? { label: oidcLabel() } : null, error: new URL(request.url).searchParams.get("error") };
}

export async function action({ request }: { request: Request }): Promise<Response | { error: string }> {
  const form = await request.formData();
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");

  // Three layers, none of which hands an attacker an outage button:
  //   - the client address may be locked out, but only when a declared proxy
  //     makes it trustworthy (then the one locked out IS the attacker);
  //   - the username is only ever slowed, because locking it would let anyone
  //     who knows a name lock out its owner;
  //   - the concurrency slot bounds the CPU an unauthenticated caller can make
  //     this process spend on scrypt, which runs on the same threadpool as the
  //     store I/O the rest of the dashboard needs.
  const client = clientKey(request, trustProxy());
  const byClient = checkRateLimit(client.key, Date.now(), loginLimits, client.lockable);
  if (!byClient.allowed) {
    return { error: `Too many attempts. Try again in ${byClient.retryAfterSeconds ?? 300} seconds.` };
  }
  const byUser = checkRateLimit(`user:${username.toLowerCase()}`, Date.now(), loginLimits, false);
  const wait = Math.max(byClient.delayMs ?? 0, byUser.delayMs ?? 0);
  if (wait > 0) await delay(wait);
  const verified = await withVerifySlot(() => authenticate(username, password));
  if (verified.shed) {
    return { error: "The server is busy verifying sign-ins. Try again in a moment." };
  }
  const principal = verified.value;
  if (principal === null) {
    return { error: "Wrong username or password." };
  }
  // A legitimate user who mistyped twice is not an attacker.
  clearRateLimit(client.key);
  clearRateLimit(`user:${username.toLowerCase()}`);
  // The same trusted-proxy ladder OIDC uses. Reading X-Forwarded-Proto
  // unconditionally let a caller choose the scheme and strip Secure from a
  // privileged cookie on an HTTPS deployment.
  const cookie = sessionSetCookie(principal, requestIsSecure(request));
  return new Response(null, { status: 302, headers: { location: "/", "set-cookie": cookie } });
}

export default function Login({ data, actionData }: { data?: { sso: { label: string } | null; error?: string | null }; actionData?: { error?: string } }) {
  const sso = data?.sso ?? null;
  const error = actionData?.error ?? data?.error ?? undefined;
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
