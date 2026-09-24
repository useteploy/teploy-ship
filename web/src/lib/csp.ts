/**
 * The dashboard's Content-Security-Policy (applied in _layout.tsx) and the
 * one frame origin it admits.
 *
 * Frames of other origins stay blocked by `default-src 'self'` unless a
 * preview base is configured; then exactly `http://*.<base>` is framed —
 * the tailnet previews the run page's panel shows
 * (DELEGATED_DECISIONS_2026-09-23 §10), and nothing else. A framed preview
 * is its own origin: it gets none of the dashboard's cookies, storage or
 * same-origin fetch. What must never happen is the reverse (agent code on
 * THIS origin), which is why previews are never proxied through a dashboard
 * path. `frame-ancestors 'none'` still stops anyone framing the dashboard.
 */
export function dashboardCsp(frameBase?: string): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(frameBase !== undefined ? [`frame-src http://*.${frameBase}`] : []),
    "object-src 'none'",
    "img-src 'self' data: https: http:",
    "media-src 'self' https: http:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
  ].join("; ");
}

/** Whether `dashboardCsp(frameBase)` lets the browser frame `url`: http, default port, a host under the base. */
export function frameAllowed(url: string, frameBase: string | undefined): boolean {
  if (frameBase === undefined) return false;
  try {
    const u = new URL(url);
    return u.protocol === "http:" && u.port === "" && u.hostname.endsWith(`.${frameBase}`);
  } catch {
    return false;
  }
}
