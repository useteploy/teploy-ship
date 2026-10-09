import { dashboardCsp } from "./csp.js";
import { previewFrameBase } from "./preview-frame.server.js";
import { publicOrigin } from "./oidc.server.js";

/** Every console response, including auth failures and redirects, is private.
 * TS-33: HTML and router JSON share URLs; retain the framework's representation
 * identity even behind a proxy. Existing cached responses still require a purge.
 */
export function withSecurityHeaders(response: Response, request: Request): Response {
  const headers = new Headers(response.headers);
  const vary = (headers.get("vary") ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (!vary.includes("*")) {
    for (const field of ["Accept", "Accept-Language", "X-Neutron-Data", "X-Neutron-Routes"]) {
      if (!vary.some(value => value.toLowerCase() === field.toLowerCase())) vary.push(field);
    }
    headers.set("vary", vary.join(", "));
  }
  headers.set("cache-control", "private, no-store");
  // Inline scripts/styles are part of the console; previews use the configured
  // tailnet origin. Keep the established CSP while protecting every response.
  headers.set("content-security-policy", dashboardCsp(previewFrameBase()));
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "same-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (publicOrigin(request).startsWith("https://")) {
    headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
