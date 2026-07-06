import { webToken } from "../lib/store.js";

export const config = { mode: "app" };

export async function action({ request }: { request: Request }): Promise<Response | { error: string }> {
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  if (token !== webToken()) {
    return { error: "Wrong token." };
  }
  const cookie = [
    `ship_token=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${60 * 60 * 24 * 30}`,
  ].join("; ");
  return new Response(null, { status: 302, headers: { location: "/", "set-cookie": cookie } });
}

export default function Login({ actionData }: { actionData?: { error?: string } }) {
  return (
    <div class="login">
      <h1>Teploy Ship</h1>
      <p class="meta">Enter the access token this server was started with.</p>
      <form method="post">
        <input type="password" name="token" placeholder="access token" autofocus />
        {actionData?.error !== undefined && <p style="color: var(--red)">{actionData.error}</p>}
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
