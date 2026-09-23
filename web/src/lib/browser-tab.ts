/**
 * Pure helpers for the takeover BROWSER tab (client-side). The authoritative
 * URL guard and action bounds live in the worker (src/takeover-browser.ts,
 * enforced again inside the in-sandbox driver); these mirror just enough to
 * give the operator an immediate, honest refusal before a request is made —
 * the server re-checks everything and never trusts this file.
 */

export type NavResolution = { ok: true; url: string } | { ok: false; reason: string };

/**
 * The nav bar accepts an absolute http(s) URL or a /path resolved against the
 * page the browser is currently on. Anything else — file:, about:, a bare
 * path with nothing to resolve against — is refused with a reason, matching
 * the server's guard.
 */
export function resolveNavUrl(input: string, lastUrl: string | undefined): NavResolution {
  const trimmed = input.trim();
  if (trimmed === "") return { ok: false, reason: "Enter an http(s) URL or a /path." };
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    if (!/^https?:\/\//i.test(trimmed)) {
      return { ok: false, reason: `Refused: only http and https URLs are allowed (no ${trimmed.split(":")[0]}:).` };
    }
    return { ok: true, url: trimmed };
  }
  if (lastUrl === undefined) {
    return { ok: false, reason: "Enter a full http:// or https:// URL first — there is no current page to resolve a path against." };
  }
  try {
    const resolved = new URL(trimmed, lastUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return { ok: false, reason: "Refused: only http and https URLs are allowed." };
    }
    return { ok: true, url: resolved.toString() };
  } catch {
    return { ok: false, reason: "That path could not be resolved against the current page." };
  }
}

/**
 * Map a click on the rendered <img> to viewport coordinates for the click
 * action. The image is rendered at natural size (no CSS scaling), so the
 * ratio is 1:1 in the normal case — but it is COMPUTED, not assumed, with
 * the zero-size cases guarded: an unscaled image that has not loaded
 * (naturalWidth 0) or one collapsed by layout (clientWidth 0) answers null
 * instead of a division by zero, and the caller drops the click.
 */
export function clickPoint(
  offsetX: number,
  offsetY: number,
  displayedWidth: number,
  naturalWidth: number,
  displayedHeight: number,
  naturalHeight: number,
): { x: number; y: number } | null {
  if (
    !Number.isFinite(offsetX) || !Number.isFinite(offsetY) ||
    displayedWidth <= 0 || naturalWidth <= 0 || displayedHeight <= 0 || naturalHeight <= 0
  ) {
    return null;
  }
  const sx = displayedWidth / naturalWidth;
  const sy = displayedHeight / naturalHeight;
  if (sx <= 0 || sy <= 0 || !Number.isFinite(sx) || !Number.isFinite(sy)) return null;
  return {
    x: Math.max(0, Math.round(offsetX / sx)),
    y: Math.max(0, Math.round(offsetY / sy)),
  };
}
