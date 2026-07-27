import { shipRuntime } from "../lib/store.server.js";
import { currentUser } from "../lib/session.server.js";

export const config = { mode: "app" };

interface AccountData {
  user: string;
  role: string;
  tokenSession: boolean;
}

export async function loader({ request }: { request: Request }): Promise<AccountData> {
  const me = await currentUser(request);
  return { user: me?.user ?? "", role: me?.role ?? "viewer", tokenSession: me?.user === "token" };
}

export async function action({ request }: { request: Request }): Promise<{ error?: string; ok?: string }> {
  const me = await currentUser(request);
  if (me === null) return { error: "Not signed in." };
  if (me.user === "token") {
    return { error: "You are signed in with the access token, not a user account — nothing to change here." };
  }
  const form = await request.formData();
  const current = String(form.get("current") ?? "");
  const next = String(form.get("next") ?? "");
  const runtime = await shipRuntime();
  if ((await runtime.users.verify(me.user, current)) === null) {
    return { error: "Current password is incorrect." };
  }
  try {
    await runtime.users.setPassword(me.user, next);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Failed." };
  }
  return { ok: "Password changed." };
}

export default function Account({ data, actionData }: { data: AccountData; actionData?: { error?: string; ok?: string } }) {
  return (
    <>
      <h1 class="page">Account</h1>
      <p class="meta">
        Signed in as <b>{data.user}</b> · role <b>{data.role}</b>.
      </p>
      {data.tokenSession ? (
        <p class="meta">
          You are signed in with the server access token, not a personal account. Ask an admin to create you an account
          on <a href="/settings">Settings</a>.
        </p>
      ) : (
        <>
          <h2 class="section">Change password</h2>
          {actionData?.error !== undefined && <p style="color:var(--red)">{actionData.error}</p>}
          {actionData?.ok !== undefined && <p style="color:var(--green)">{actionData.ok}</p>}
          <form method="post" class="login" style="margin:8px 0">
            <input type="password" name="current" placeholder="current password" autocomplete="current-password" />
            <input type="password" name="next" placeholder="new password (8+ chars)" autocomplete="new-password" />
            <button type="submit">Change password</button>
          </form>
        </>
      )}
    </>
  );
}
