import { SESSION_COOKIE, requestIsSecure } from "../lib/session.server.js";
import { requireRouteRole } from "../lib/route-access.server.js";

export const config = { mode: "app" };

/** POST /logout — clear the session cookie and go to the login page. */
export async function action({ request }: { request: Request }): Promise<Response> {
  await requireRouteRole(request, "/logout", "action");
  const cookie = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", ...(requestIsSecure(request) ? ["Secure"] : [])].join("; ");
  return new Response(null, { status: 302, headers: { location: "/login", "set-cookie": cookie } });
}

export async function loader({ request }: { request: Request }): Promise<Response> {
  await requireRouteRole(request, "/logout", "loader");
  return new Response(null, { status: 302, headers: { location: "/account" } });
}

export default function Logout() {
  return null;
}
