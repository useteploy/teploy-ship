import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The tool/connector manifest contract (S24) — a pure module, wired nowhere yet.
 *
 * Four rules, each enforced by construction rather than by convention:
 *
 * 1. A manifest is a CLAIM. `validateManifest` only says whether the claim is
 *    well formed (required fields, bounded timeouts, closed enums, no unknown
 *    fields, a supported schema version). It grants nothing.
 * 2. Authority is the administrator's grant. `effectivePermissions` is an
 *    intersection: it reads ONLY the structured `permissions` fields of the
 *    manifest and the grant. Free text (description, instructions, skill
 *    prose) is never parsed for permissions, so imported text cannot widen
 *    anything. Asking for more than the grant yields the granted subset plus a
 *    report of the excess.
 * 3. A declared effect is descriptive. Real enforcement is the credential
 *    scope and the executor's controls (egress allowlist, read-only mounts);
 *    `conformanceChecks` is the audit that notices when an OBSERVED call
 *    contradicts the declaration, so a lying or buggy tool is caught, not
 *    trusted.
 * 4. Events to API clients are authenticated and deduplicable. The signing
 *    scheme is the one every teploy product uses (src/notify.ts):
 *    `X-Teploy-Signature: sha256=hex(HMAC-SHA256(secret, timestamp + "." + body))`,
 *    so a receiver of Ship, CLI, Dash and Observe writes one verifier. The
 *    timestamp is inside the MAC, which is what bounds replay; `eventId`
 *    dedupe handles at-least-once delivery (the outbox's honest guarantee) and
 *    a cursor tolerates out-of-order arrival and tells a reconnecting client
 *    where to resume.
 */

// ---------------------------------------------------------------- manifest

export const EFFECTS = ["read", "write", "network", "exec"] as const;
export type Effect = (typeof EFFECTS)[number];

/** The only ways a secret may reach a tool. "in prompt" and "argv" are named
 *  here only to be refused with a specific message. */
export const SECRET_TRANSPORTS = ["env-per-exec", "credential-proxy", "none"] as const;
export type SecretTransport = (typeof SECRET_TRANSPORTS)[number];

export const APPROVALS = ["never", "on-write", "always"] as const;
export type ToolApproval = (typeof APPROVALS)[number];

export const CANCELLATIONS = ["none", "abort-signal", "kill"] as const;
export type Cancellation = (typeof CANCELLATIONS)[number];

/** Structured permissions: the only thing authority is ever computed from. */
export interface Permissions {
  effects: Effect[];
  /** Exact hostnames; a grant may use a leading "*." to cover subdomains. */
  hosts: string[];
  scopes: string[];
}

export interface ToolDeclaration {
  name: string;
  description?: string;
  /** JSON-schema-shaped objects; validated only as objects here. */
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  permissions: Permissions;
  /** Names of secrets the tool needs (never values). */
  secrets: string[];
  secretTransport: SecretTransport;
  timeoutMs: number;
  cancellation: Cancellation;
  approval: ToolApproval;
}

export interface ToolManifest {
  schemaVersion: string;
  name: string;
  version: string;
  description?: string;
  tools: ToolDeclaration[];
}

/** Schema versions: the supported major is current; the previous major still
 *  loads with a deprecation warning; anything else is refused. */
export const MANIFEST_SCHEMA = { supportedMajor: 1, deprecatedMajors: [0] } as const;

export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 10 * 60 * 1000;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const NAME_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const VERSION_RE = /^(\d+)\.(\d+)(?:\.\d+)?$/;
const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const MANIFEST_KEYS = new Set(["schemaVersion", "name", "version", "description", "tools"]);
const TOOL_KEYS = new Set([
  "name", "description", "input", "output", "permissions", "secrets",
  "secretTransport", "timeoutMs", "cancellation", "approval",
]);
const PERMISSION_KEYS = new Set(["effects", "hosts", "scopes"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unknownKeys(obj: Record<string, unknown>, allowed: Set<string>, where: string, errors: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) errors.push(`${where}: unknown field "${key}"`);
  }
}

function stringList(v: unknown, where: string, errors: string[]): string[] | undefined {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x === "")) {
    errors.push(`${where}: must be an array of non-empty strings`);
    return undefined;
  }
  return v as string[];
}

export function validateManifest(manifest: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObject(manifest)) return { ok: false, errors: ["manifest: must be an object"], warnings };

  unknownKeys(manifest, MANIFEST_KEYS, "manifest", errors);

  if (typeof manifest.schemaVersion !== "string") {
    errors.push("manifest.schemaVersion: required string");
  } else {
    const m = VERSION_RE.exec(manifest.schemaVersion);
    if (!m) errors.push(`manifest.schemaVersion: "${manifest.schemaVersion}" is not major.minor`);
    else {
      const major = Number(m[1]);
      if ((MANIFEST_SCHEMA.deprecatedMajors as readonly number[]).includes(major)) {
        warnings.push(`manifest.schemaVersion: major ${major} is deprecated; migrate to ${MANIFEST_SCHEMA.supportedMajor}`);
      } else if (major !== MANIFEST_SCHEMA.supportedMajor) {
        errors.push(`manifest.schemaVersion: major ${major} is not supported`);
      }
    }
  }
  if (typeof manifest.name !== "string" || !NAME_RE.test(manifest.name)) errors.push("manifest.name: required, lowercase [a-z0-9_.-], max 64");
  if (typeof manifest.version !== "string" || !VERSION_RE.test(manifest.version)) errors.push("manifest.version: required major.minor[.patch]");
  if (manifest.description !== undefined && typeof manifest.description !== "string") errors.push("manifest.description: must be a string");

  if (!Array.isArray(manifest.tools) || manifest.tools.length === 0) {
    errors.push("manifest.tools: required non-empty array");
  } else {
    const seen = new Set<string>();
    manifest.tools.forEach((tool: unknown, i: number) => {
      const where = `tools[${i}]`;
      if (!isObject(tool)) { errors.push(`${where}: must be an object`); return; }
      unknownKeys(tool, TOOL_KEYS, where, errors);
      if (typeof tool.name !== "string" || !NAME_RE.test(tool.name)) errors.push(`${where}.name: required, lowercase [a-z0-9_.-], max 64`);
      else if (seen.has(tool.name)) errors.push(`${where}.name: duplicate "${tool.name}"`);
      else seen.add(tool.name);
      if (tool.description !== undefined && typeof tool.description !== "string") errors.push(`${where}.description: must be a string`);
      if (!isObject(tool.input)) errors.push(`${where}.input: required object`);
      if (!isObject(tool.output)) errors.push(`${where}.output: required object`);

      if (!isObject(tool.permissions)) errors.push(`${where}.permissions: required object`);
      else {
        const p = tool.permissions;
        unknownKeys(p, PERMISSION_KEYS, `${where}.permissions`, errors);
        const effects = stringList(p.effects, `${where}.permissions.effects`, errors);
        for (const e of effects ?? []) if (!(EFFECTS as readonly string[]).includes(e)) errors.push(`${where}.permissions.effects: unknown effect "${e}"`);
        const hosts = stringList(p.hosts, `${where}.permissions.hosts`, errors);
        for (const h of hosts ?? []) if (!HOST_RE.test(h)) errors.push(`${where}.permissions.hosts: invalid host "${h}"`);
        stringList(p.scopes, `${where}.permissions.scopes`, errors);
        if (effects && hosts && hosts.length > 0 && !effects.includes("network")) {
          errors.push(`${where}.permissions: hosts declared without the "network" effect`);
        }
        if (effects && hosts && effects.includes("network") && hosts.length === 0) {
          errors.push(`${where}.permissions: "network" effect needs at least one host`);
        }
      }

      const secrets = stringList(tool.secrets, `${where}.secrets`, errors);
      const transport = tool.secretTransport;
      if (typeof transport !== "string") errors.push(`${where}.secretTransport: required`);
      else if (!(SECRET_TRANSPORTS as readonly string[]).includes(transport)) {
        errors.push(/^(argv|in[-_ ]?prompt|prompt|args?)$/i.test(transport)
          ? `${where}.secretTransport: "${transport}" is forbidden; secrets travel by env-per-exec or credential-proxy only`
          : `${where}.secretTransport: must be one of ${SECRET_TRANSPORTS.join(" | ")}`);
      } else if (secrets) {
        if (secrets.length > 0 && transport === "none") errors.push(`${where}: declares secrets but secretTransport is "none"`);
        if (secrets.length === 0 && transport !== "none") errors.push(`${where}: secretTransport "${transport}" with no secrets declared`);
      }

      if (!Number.isInteger(tool.timeoutMs) || (tool.timeoutMs as number) < MIN_TIMEOUT_MS || (tool.timeoutMs as number) > MAX_TIMEOUT_MS) {
        errors.push(`${where}.timeoutMs: required integer in [${MIN_TIMEOUT_MS}, ${MAX_TIMEOUT_MS}]`);
      }
      if (!(CANCELLATIONS as readonly string[]).includes(tool.cancellation as string)) errors.push(`${where}.cancellation: must be one of ${CANCELLATIONS.join(" | ")}`);
      if (!(APPROVALS as readonly string[]).includes(tool.approval as string)) errors.push(`${where}.approval: must be one of ${APPROVALS.join(" | ")}`);
    });
  }
  return { ok: errors.length === 0, errors, warnings };
}

// ------------------------------------------------------ effective permissions

/** The administrator's intended permissions, supplied at install time from the
 *  admin's own input. Never derived from the manifest or its text. */
export interface AdminGrant {
  effects: Effect[];
  hosts: string[];
  scopes: string[];
}

export interface Excess { effects: Effect[]; hosts: string[]; scopes: string[] }

export interface ToolEffective {
  tool: string;
  granted: Permissions;
  /** Requested but not granted. Non-empty means the install must surface it. */
  excess: Excess;
}

function hostCovered(grantHost: string, host: string): boolean {
  if (grantHost === host) return true;
  // "*.example.com" covers subdomains of example.com, not example.com itself
  // and not another wildcard (a manifest cannot widen itself by asking for "*.").
  return grantHost.startsWith("*.") && !host.startsWith("*") && host.endsWith(grantHost.slice(1));
}

/** Intersection, never union. A malformed manifest gets nothing. */
export function effectivePermissions(manifest: ToolManifest, grant: AdminGrant): ToolEffective[] {
  if (!validateManifest(manifest).ok) return [];
  return manifest.tools.map((tool) => {
    const want = tool.permissions;
    const effects = want.effects.filter((e) => grant.effects.includes(e));
    const hosts = effects.includes("network") ? want.hosts.filter((h) => grant.hosts.some((g) => hostCovered(g, h))) : [];
    const scopes = want.scopes.filter((s) => grant.scopes.includes(s));
    return {
      tool: tool.name,
      granted: { effects, hosts, scopes },
      excess: {
        effects: want.effects.filter((e) => !effects.includes(e)),
        hosts: want.hosts.filter((h) => !hosts.includes(h)),
        scopes: want.scopes.filter((s) => !scopes.includes(s)),
      },
    };
  });
}

export function hasExcess(e: ToolEffective): boolean {
  return e.excess.effects.length + e.excess.hosts.length + e.excess.scopes.length > 0;
}

// ------------------------------------------------------------- conformance

export interface ObservedCall {
  tool: string;
  /** What the executor/credential layer actually saw the call do. */
  effects: Effect[];
  hosts: string[];
  argv: string[];
  /** Secret VALUES the harness injected for this call (for leak detection only). */
  secretValues: string[];
  /** Text sent to the model for this call, if captured. */
  promptText?: string;
}

export type ConformanceKind =
  | "unknown-tool"
  | "undeclared-effect"
  | "write-when-read-only"
  | "undeclared-host"
  | "secret-in-argv"
  | "secret-in-prompt";

export interface ConformanceFinding { kind: ConformanceKind; detail: string }

export function conformanceChecks(manifest: ToolManifest, call: ObservedCall): ConformanceFinding[] {
  const tool = manifest.tools.find((t) => t.name === call.tool);
  if (!tool) return [{ kind: "unknown-tool", detail: `call to undeclared tool "${call.tool}"` }];
  const findings: ConformanceFinding[] = [];
  const declared = tool.permissions.effects;
  const readOnly = !declared.includes("write") && !declared.includes("exec");

  for (const e of call.effects) {
    if (declared.includes(e)) continue;
    if (e === "write" && readOnly) findings.push({ kind: "write-when-read-only", detail: `"${tool.name}" declares read-only but performed a write` });
    else findings.push({ kind: "undeclared-effect", detail: `"${tool.name}" performed undeclared effect "${e}"` });
  }
  for (const h of call.hosts) {
    if (!tool.permissions.hosts.some((d) => hostCovered(d, h))) findings.push({ kind: "undeclared-host", detail: `"${tool.name}" contacted undeclared host "${h}"` });
  }
  // Leak checks report the secret's index, never its value.
  call.secretValues.forEach((value, i) => {
    if (value === "") return;
    if (call.argv.some((a) => a.includes(value))) findings.push({ kind: "secret-in-argv", detail: `secret #${i} appears in argv of "${tool.name}"` });
    if (call.promptText?.includes(value)) findings.push({ kind: "secret-in-prompt", detail: `secret #${i} appears in prompt text of "${tool.name}"` });
  });
  return findings;
}

// ------------------------------------------------------------------ events

export const EVENT_SCHEMA = { major: 1, minor: 0 } as const;
export const EVENT_SCHEMA_VERSION = `${EVENT_SCHEMA.major}.${EVENT_SCHEMA.minor}`;
export const DEFAULT_REPLAY_WINDOW_MS = 5 * 60 * 1000;

export interface EventEnvelope {
  eventId: string;
  schemaVersion: string;
  type: string;
  /** Monotonic position in the stream; reconnect with the last contiguous one. */
  cursor: number;
  /** Echoes the client's request id so an event can be correlated to its call. */
  requestId?: string;
  occurredAt: string;
  data: unknown;
}

/** Deterministic JSON: object keys sorted, so equal envelopes sign equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface SignedEvent {
  body: string;
  headers: { "X-Teploy-Timestamp": string; "X-Teploy-Signature": string };
}

function mac(secret: string, timestamp: string, body: string): Buffer {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
}

export function signEvent(event: EventEnvelope, secret: string, nowMs: number): SignedEvent {
  if (!secret) throw new Error("signEvent: refusing to sign with an empty secret");
  const body = canonicalJson(event);
  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    body,
    headers: { "X-Teploy-Timestamp": timestamp, "X-Teploy-Signature": `sha256=${mac(secret, timestamp, body).toString("hex")}` },
  };
}

/** Bounded set of seen event ids (FIFO eviction) so memory cannot grow forever. */
export class EventDedupe {
  #seen = new Set<string>();
  constructor(private readonly capacity = 10_000) {}
  has(id: string): boolean { return this.#seen.has(id); }
  add(id: string): void {
    this.#seen.add(id);
    if (this.#seen.size > this.capacity) this.#seen.delete(this.#seen.values().next().value as string);
  }
}

/** Tracks which cursors arrived. Out-of-order is fine; `resumeFrom` is the
 *  highest cursor below which nothing is missing — what a reconnect sends. */
export class CursorTracker {
  #contiguous: number;
  #ahead = new Set<number>();
  constructor(start = 0) { this.#contiguous = start; }
  observe(cursor: number): void {
    if (cursor <= this.#contiguous) return;
    this.#ahead.add(cursor);
    while (this.#ahead.has(this.#contiguous + 1)) { this.#ahead.delete(this.#contiguous + 1); this.#contiguous++; }
  }
  get resumeFrom(): number { return this.#contiguous; }
  /** True when later events have arrived while an earlier one is still missing. */
  get hasGap(): boolean { return this.#ahead.size > 0; }
}

export type VerifyFailure =
  | "bad-signature" | "malformed-signature" | "bad-timestamp" | "expired"
  | "malformed-body" | "malformed-envelope" | "unsupported-major";

export type VerifyResult =
  | { ok: true; duplicate: false; event: EventEnvelope; minorAhead: boolean }
  | { ok: true; duplicate: true; eventId: string }
  | { ok: false; reason: VerifyFailure };

export interface VerifyOptions {
  nowMs: number;
  replayWindowMs?: number;
  dedupe?: EventDedupe;
  cursors?: CursorTracker;
}

/**
 * Order matters: authenticate FIRST (the MAC covers the timestamp), then
 * freshness, then parse, then version, then dedupe. Only an event that passed
 * everything is remembered, so a forged event cannot poison the dedupe set.
 * A duplicate is an idempotent no-op, reported as ok so the sender stops
 * retrying. An unknown major is refused; a higher minor is tolerated (additive
 * fields are the contract) and flagged via `minorAhead`.
 */
export function verifyEvent(body: string, headers: { timestamp: string; signature: string }, secret: string, opts: VerifyOptions): VerifyResult {
  const sig = /^sha256=([0-9a-f]{64})$/.exec(headers.signature ?? "");
  if (!sig) return { ok: false, reason: "malformed-signature" };
  if (!/^\d{1,12}$/.test(headers.timestamp ?? "")) return { ok: false, reason: "bad-timestamp" };
  if (!secret) return { ok: false, reason: "bad-signature" };

  const expected = mac(secret, headers.timestamp, body);
  const given = Buffer.from(sig[1], "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: "bad-signature" };

  const window = opts.replayWindowMs ?? DEFAULT_REPLAY_WINDOW_MS;
  if (Math.abs(opts.nowMs - Number(headers.timestamp) * 1000) > window) return { ok: false, reason: "expired" };

  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return { ok: false, reason: "malformed-body" }; }
  if (!isObject(parsed) || typeof parsed.eventId !== "string" || parsed.eventId === "" || typeof parsed.type !== "string"
    || typeof parsed.schemaVersion !== "string" || !Number.isInteger(parsed.cursor) || (parsed.cursor as number) < 0
    || typeof parsed.occurredAt !== "string") {
    return { ok: false, reason: "malformed-envelope" };
  }
  const v = VERSION_RE.exec(parsed.schemaVersion);
  if (!v) return { ok: false, reason: "malformed-envelope" };
  if (Number(v[1]) !== EVENT_SCHEMA.major) return { ok: false, reason: "unsupported-major" };

  const event = parsed as unknown as EventEnvelope;
  if (opts.dedupe?.has(event.eventId)) return { ok: true, duplicate: true, eventId: event.eventId };
  opts.dedupe?.add(event.eventId);
  opts.cursors?.observe(event.cursor);
  return { ok: true, duplicate: false, event, minorAhead: Number(v[2]) > EVENT_SCHEMA.minor };
}
