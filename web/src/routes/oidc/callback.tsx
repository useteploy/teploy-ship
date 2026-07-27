import { handleCallback } from "../../lib/oidc.server.js";

export const config = { mode: "app" };

/** GET /oidc/callback — complete the OIDC flow: verify the ID token, map the
 * role, mint the session cookie, and redirect to the app. Auth-exempt in
 * _layout (it carries no session yet). */
export async function loader({ request }: { request: Request }): Promise<Response> {
  return handleCallback(request);
}
