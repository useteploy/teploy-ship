/**
 * The credential shapes this repository refuses to ship, in two roles.
 *
 * These six patterns are the single source of truth for BOTH gates that share
 * them: `scripts/scan-secrets.mjs` (fails the build when one is committed)
 * and `src/support.ts` (the S19 redaction gate — rewrites every hit in a
 * support bundle before it is written to disk). The check that guards this
 * repository and the check that guards what leaves it for a vendor must not
 * be able to disagree, which is why the set lives exactly once here.
 *
 * The script cannot import this file: it runs in CI straight off a checkout
 * (`node scripts/scan-secrets.mjs`) with no build step, so `dist/` may not
 * exist — and this module must compile to `dist/` because the shipped image
 * copies only `dist/`. So the script carries the same literals and exports
 * them, and `scripts/scan-secrets.test.mjs` fails when the two drift apart in
 * name, source or flag order. Duplication that a test cannot let rot beats a
 * dependency edge that breaks one consumer or the other.
 *
 * Order is load-bearing for the scan only in that it drives report order; the
 * support gate re-derives its own ordering (see src/support.ts).
 */

export interface SecretPattern {
  /** Human name, also the redaction category in the bundle's report. */
  name: string;
  /** Detection only — no global flag, matching the script's line-by-line `.test`. */
  re: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{20,}\b/ },
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: "credential in a URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]{6,}@/ },
];

/** Marker inserted by the support gate for one hit of a pattern, e.g. `[REDACTED:github-token]`. */
export function redactionMarker(name: string): string {
  return `[REDACTED:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}]`;
}
