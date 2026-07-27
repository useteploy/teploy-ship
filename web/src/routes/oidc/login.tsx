import { startLogin } from "../../lib/oidc.server.js";

export const config = { mode: "app" };

/** GET /oidc/login — begin the OIDC authorization-code flow (redirects to the
 * IdP). Auth-exempt in _layout: this is how a user establishes a session. */
export async function loader({ request }: { request: Request }): Promise<Response> {
  return startLogin(request);
}
