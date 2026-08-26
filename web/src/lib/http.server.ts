/** A 302 to `location`. One copy for every route action and redirect stub. */
export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}
