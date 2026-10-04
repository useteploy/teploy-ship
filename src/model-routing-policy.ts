/**
 * Everything model-routing needs from the OUTSIDE world, kept apart from the
 * pure policy engine in model-routing.ts: the on/off flag, loading a policy
 * from disk, and turning a provider error into something a policy can name.
 *
 * Three decisions worth knowing:
 *   - The flag is `SHIP_MODEL_ROUTING=shadow|on`. Anything else, including a
 *     typo, is OFF. A typo that silently meant "on" would let a fallback move
 *     project data to another provider; a typo that means "off" costs nothing.
 *   - A policy file is versioned twice: `schemaVersion` (the file format, only
 *     1 is understood — a newer file is refused, not half-read) and `version`
 *     (the operator's own label, copied into every recorded Segment). The
 *     sha256 of the file's bytes is returned as well, so a record can prove
 *     which exact file produced it even if someone reuses a version label.
 *   - Failure classes are NOT fallback triggers. `auth` and `context-length`
 *     map to no trigger at all: switching providers because a key is wrong, or
 *     because the prompt is too long, would hide a real defect (or send the
 *     same oversize private context somewhere else). Only the mapping below
 *     can lead to a switch, and only if the policy's `fallbackOn` also lists it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { validatePolicy } from "./model-routing.js";
import type { Candidate, FallbackTrigger, RoutingPolicy } from "./model-routing.js";

export type RoutingMode = "off" | "shadow" | "on";

export function routingMode(env: NodeJS.ProcessEnv = process.env): RoutingMode {
  const raw = env.SHIP_MODEL_ROUTING?.trim().toLowerCase();
  return raw === "shadow" || raw === "on" ? raw : "off";
}

export const POLICY_SCHEMA_VERSION = 1;

export type PolicyLoad =
  | { ok: true; policy: RoutingPolicy; digest: string; path: string }
  | { ok: false; errors: readonly string[]; path: string };

const TOP_KEYS = new Set(["schemaVersion", "version", "roles", "fallbackOn"]);
const CANDIDATE_KEYS = new Set([
  "model",
  "effort",
  "capabilities",
  "dataDestination",
  "retention",
  "maxContext",
  "requestedAuthority",
]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Shape-check BEFORE handing to validatePolicy, which assumes the types are
 * right (`c.capabilities.includes` would throw on a string). Unknown keys are
 * errors: a misspelt `dataDestinaton` must not become "no destination declared"
 * silently, and a field a future version adds must not be ignored.
 */
export function parsePolicy(raw: unknown): { ok: true; policy: RoutingPolicy } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ["policy must be a JSON object"] };
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) errors.push(`unknown policy field: ${k}`);
  if (raw.schemaVersion !== POLICY_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${POLICY_SCHEMA_VERSION} (got ${JSON.stringify(raw.schemaVersion)})`);
  }
  if (typeof raw.version !== "string") errors.push("policy has no version");
  if (!isObject(raw.roles)) errors.push("roles must be an object");
  if (raw.fallbackOn !== undefined && !isStringArray(raw.fallbackOn)) errors.push("fallbackOn must be an array of strings");
  const roles: Record<string, Candidate[]> = {};
  if (isObject(raw.roles)) {
    for (const [role, list] of Object.entries(raw.roles)) {
      if (!Array.isArray(list)) {
        errors.push(`role ${role}: candidates must be an array`);
        continue;
      }
      const out: Candidate[] = [];
      for (const [i, c] of list.entries()) {
        const where = `role ${role}[${i}]`;
        if (!isObject(c)) {
          errors.push(`${where}: candidate must be an object`);
          continue;
        }
        for (const k of Object.keys(c)) if (!CANDIDATE_KEYS.has(k)) errors.push(`${where}: unknown field ${k}`);
        if (!isStringArray(c.capabilities)) errors.push(`${where}: capabilities must be an array of strings`);
        if (c.dataDestination !== undefined && !(isObject(c.dataDestination) && typeof c.dataDestination.host === "string" && typeof c.dataDestination.class === "string")) {
          errors.push(`${where}: dataDestination must be {host, class} strings`);
        }
        if (c.requestedAuthority !== undefined) {
          const a = c.requestedAuthority;
          const ok = isObject(a) &&
            (a.tools === undefined || isStringArray(a.tools)) &&
            (a.connections === undefined || isStringArray(a.connections));
          if (!ok) errors.push(`${where}: requestedAuthority must be {tools?, connections?} string arrays`);
        }
        out.push(c as unknown as Candidate);
      }
      roles[role] = out;
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const policy: RoutingPolicy = {
    version: raw.version as string,
    roles,
    fallbackOn: ((raw.fallbackOn as string[] | undefined) ?? []) as FallbackTrigger[],
  };
  const semantic = validatePolicy(policy);
  return semantic.length > 0 ? { ok: false, errors: semantic } : { ok: true, policy };
}

/** Read and validate the policy file named by `SHIP_MODEL_ROUTING_POLICY`. Never throws. */
export function loadRoutingPolicy(env: NodeJS.ProcessEnv = process.env): PolicyLoad | undefined {
  const path = env.SHIP_MODEL_ROUTING_POLICY?.trim();
  if (path === undefined || path === "") return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { ok: false, path, errors: [`cannot read policy file: ${error instanceof Error ? error.message : String(error)}`] };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, path, errors: [`policy file is not JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const parsed = parsePolicy(json);
  if (!parsed.ok) return { ok: false, path, errors: parsed.errors };
  return { ok: true, path, policy: parsed.policy, digest: createHash("sha256").update(text).digest("hex") };
}

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

export type FailureClass =
  | "rate-limit"
  | "overloaded"
  | "context-length"
  | "auth"
  | "content-filter"
  | "network"
  | "unknown";

const statusOf = (error: unknown): number | undefined => {
  const e = error as { status?: unknown; statusCode?: unknown } | null;
  const s = e?.status ?? e?.statusCode;
  return typeof s === "number" ? s : undefined;
};

const MESSAGE_RULES: ReadonlyArray<[FailureClass, RegExp]> = [
  // Most specific first: a 400 that says "context length" is not "unknown".
  ["context-length", /context length|context_length|context window|too many tokens|maximum context|prompt is too long/],
  ["content-filter", /content[_ -]?(filter|policy|management)|safety|refus|blocked by|violat.*policy/],
  ["auth", /invalid[_ ]api[_ ]key|unauthori[sz]ed|forbidden|authentication|permission denied|incorrect api key/],
  ["rate-limit", /rate.?limit|too many requests|quota exceeded|\b429\b/],
  ["overloaded", /overload|capacity|\b529\b|\b503\b|service unavailable|temporarily/],
  ["network", /timeout|timed out|econnreset|econnrefused|etimedout|enotfound|eai_again|socket hang up|network|fetch failed|\b50[24]\b/],
];

/**
 * What kind of failure is this? Status code wins when present (it is the
 * provider's own statement); message text is the fallback and also refines a
 * 400. Anything unrecognised is `unknown`, which maps to no trigger: an error
 * nobody understands is not grounds to send data elsewhere.
 *
 * 5xx other than 503/529 are `network` ("the transport or the server fell
 * over") rather than `overloaded`, because only 503/529 say "back off, we are
 * full"; the distinction matters to nobody today (both map to `outage`) but is
 * kept so a policy can later treat them differently without re-classifying.
 */
export function classifyFailure(error: unknown): FailureClass {
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  const status = statusOf(error);
  if (status !== undefined) {
    if (status === 429) return /overload|capacity/.test(message) ? "overloaded" : "rate-limit";
    if (status === 503 || status === 529) return "overloaded";
    if (status === 401 || status === 403) return "auth";
    if (status === 413) return "context-length";
    if (status >= 500 && status <= 599) return "network";
    if (status >= 400 && status <= 499) {
      for (const [cls, re] of MESSAGE_RULES) if ((cls === "context-length" || cls === "content-filter") && re.test(message)) return cls;
      return "unknown";
    }
  }
  for (const [cls, re] of MESSAGE_RULES) if (re.test(message)) return cls;
  return "unknown";
}

/**
 * The only bridge from a failure to a switch. `undefined` = never a reason to
 * switch model, whatever the policy says.
 */
export function triggerFor(cls: FailureClass): FallbackTrigger | undefined {
  switch (cls) {
    case "rate-limit":
      return "rate-limit";
    case "overloaded":
    case "network":
      return "outage";
    case "content-filter":
      return "refusal";
    case "context-length":
    case "auth":
    case "unknown":
      return undefined;
  }
}
