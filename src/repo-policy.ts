import { parseRepoUrl } from "./git.js";
import type { RepoRef } from "./git.js";

/**
 * Which repositories Ship will point a credential at, and which credential.
 *
 * The hole this closes: a repository URL could arrive inside free-form text
 * from an external system — `repo:https://attacker.example/org/repo` in a Slack
 * mention or a Linear description, or `repository.clone_url` inside a webhook
 * body — and Ship would classify any non-github.com host as Forgejo, select the
 * generic deploy token, and put it in the clone URL as basic-auth. That is a
 * write-capable credential handed to whoever supplied the string, plus an SSRF
 * reach into whatever the worker can route to.
 *
 * The control is an explicit allowlist rather than a private-IP block, because
 * a self-hosted Forgejo on a tailnet (100.x, the normal Teploy topology) is a
 * LEGITIMATE target — blocking private ranges would break the default
 * deployment while still allowing exfiltration to any public host. Only naming
 * the origins actually distinguishes them.
 *
 * Trust levels, because "unset allowlist" must not mean "unset security":
 *
 *   operator — an authenticated human typed this URL (`fix --repo`, the
 *              dashboard's new-run form). Allowed when no allowlist is set.
 *   external — the URL came from outside: webhook payload, chat message, issue
 *              body. ALWAYS requires an allowlist. With none configured these
 *              are refused outright, which is the fail-closed default.
 *
 * Set SHIP_REPO_ALLOWLIST to lift that restriction, e.g.
 *   SHIP_REPO_ALLOWLIST=https://github.com/useteploy,http://100.108.123.49:49152/tyler
 */

export type RepoTrust = "operator" | "external";

export class RepoNotAllowedError extends Error {
  readonly url: string;
  constructor(url: string, detail: string) {
    super(`refusing repository ${url}: ${detail}`);
    this.name = "RepoNotAllowedError";
    this.url = url;
  }
}

export interface RepoAllowEntry {
  /** Lowercased scheme://host[:port]. */
  origin: string;
  owner?: string;
  repo?: string;
}

/**
 * Parse SHIP_REPO_ALLOWLIST. Entries are comma- or whitespace-separated and
 * may name an origin, an origin+owner, or an exact repository:
 *
 *   https://github.com                     every repo on that host
 *   https://github.com/useteploy           every repo under that owner
 *   https://github.com/useteploy/teploy-cli  exactly that repo
 *
 * A malformed entry is dropped rather than silently widening the list.
 */
export function parseAllowlist(raw: string | undefined): RepoAllowEntry[] {
  if (raw === undefined || raw.trim() === "") return [];
  const entries: RepoAllowEntry[] = [];
  for (const piece of raw.split(/[,\s]+/)) {
    const value = piece.trim().replace(/\/+$/, "");
    if (value === "") continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const segments = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
    const entry: RepoAllowEntry = { origin: `${url.protocol}//${url.host}`.toLowerCase() };
    if (segments[0] !== undefined) entry.owner = segments[0].toLowerCase();
    if (segments[1] !== undefined) entry.repo = segments[1].toLowerCase();
    entries.push(entry);
  }
  return entries;
}

/** Does this repo match any allowlist entry? Comparison is case-insensitive. */
export function isAllowed(ref: RepoRef, entries: RepoAllowEntry[]): boolean {
  const origin = ref.base.toLowerCase();
  const owner = ref.owner.toLowerCase();
  const repo = ref.repo.toLowerCase();
  return entries.some(
    (e) =>
      e.origin === origin &&
      (e.owner === undefined || e.owner === owner) &&
      (e.repo === undefined || e.repo === repo),
  );
}

export interface RepoPolicyConfig {
  /** Raw SHIP_REPO_ALLOWLIST value. */
  allowlist?: string;
  /** Raw SHIP_GIT_TOKENS value: JSON of origin -> token. */
  originTokens?: string;
  gitToken?: string;
  githubToken?: string;
}

export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): RepoPolicyConfig {
  return {
    ...(env.SHIP_REPO_ALLOWLIST !== undefined ? { allowlist: env.SHIP_REPO_ALLOWLIST } : {}),
    ...(env.SHIP_GIT_TOKENS !== undefined ? { originTokens: env.SHIP_GIT_TOKENS } : {}),
    ...(env.SHIP_GIT_TOKEN !== undefined ? { gitToken: env.SHIP_GIT_TOKEN } : {}),
    ...(env.SHIP_GITHUB_TOKEN !== undefined ? { githubToken: env.SHIP_GITHUB_TOKEN } : {}),
  };
}

/**
 * Per-origin credentials: SHIP_GIT_TOKENS is a JSON object keyed by origin, so
 * a deployment that reaches two forges stops having to hand both of them one
 * token that works on either.
 *
 *   SHIP_GIT_TOKENS={"https://github.com":"ghp_…","http://100.108.123.49:49152":"…"}
 *
 * Invalid JSON is treated as no mapping rather than throwing at import time;
 * the caller still falls back to the single-token vars.
 */
export function parseOriginTokens(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [origin, token] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof token !== "string" || token === "") continue;
    out[origin.trim().replace(/\/+$/, "").toLowerCase()] = token;
  }
  return out;
}

/**
 * Validate a repository URL against the policy and return its parsed ref.
 * Throws RepoNotAllowedError with an operator-actionable message otherwise.
 */
export function assertRepoAllowed(
  url: string,
  options: { trust: RepoTrust; config?: RepoPolicyConfig },
): RepoRef {
  const config = options.config ?? policyFromEnv();
  let ref: RepoRef;
  try {
    ref = parseRepoUrl(url);
  } catch (error) {
    throw new RepoNotAllowedError(url, error instanceof Error ? error.message : String(error));
  }
  // Local bare repos (tests, air-gapped mirrors) take no credential at all, so
  // there is nothing to leak and nothing to allowlist.
  if (ref.base === "file://") return ref;

  const entries = parseAllowlist(config.allowlist);
  if (entries.length === 0) {
    if (options.trust === "external") {
      throw new RepoNotAllowedError(
        url,
        "it came from an external source (webhook, chat, or issue text) and SHIP_REPO_ALLOWLIST is not set. " +
          "Set SHIP_REPO_ALLOWLIST to the origins Ship may clone, e.g. SHIP_REPO_ALLOWLIST=https://github.com/your-org",
      );
    }
    return ref;
  }
  if (!isAllowed(ref, entries)) {
    throw new RepoNotAllowedError(url, `${ref.base}/${ref.owner}/${ref.repo} is not in SHIP_REPO_ALLOWLIST`);
  }
  return ref;
}

/**
 * The credential for a repo's origin, refusing to produce one for a host the
 * policy does not name. This is the last gate before a token reaches a git
 * command, so it re-checks the allowlist rather than trusting that intake did.
 *
 * Order: exact origin in SHIP_GIT_TOKENS, then SHIP_GITHUB_TOKEN for github.com,
 * then the generic SHIP_GIT_TOKEN.
 */
export function credentialFor(ref: RepoRef, config: RepoPolicyConfig): string {
  if (ref.base === "file://") return "";
  const entries = parseAllowlist(config.allowlist);
  if (entries.length > 0 && !isAllowed(ref, entries)) {
    throw new RepoNotAllowedError(
      `${ref.base}/${ref.owner}/${ref.repo}`,
      "not in SHIP_REPO_ALLOWLIST — refusing to send a git credential to it",
    );
  }
  const byOrigin = parseOriginTokens(config.originTokens);
  const exact = byOrigin[ref.base.toLowerCase()];
  if (exact !== undefined && exact !== "") return exact;
  if (ref.kind === "github" && config.githubToken !== undefined && config.githubToken !== "") {
    return config.githubToken;
  }
  return config.gitToken ?? "";
}
