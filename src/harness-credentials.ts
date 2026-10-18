import { createHash } from "node:crypto";
import { join } from "node:path";

import { readJsonFile, updateJsonFile } from "./file-store.js";
import { stateDir } from "./run-store.js";
import { upsertByKey } from "./upsert.js";
import { seal, unseal, sealingStatus } from "./runtime-config.js";
import { HARNESS_VERSIONS, NATIVE_HARNESS_ID } from "./harness.js";
import { externalHarnessConfig, providerEgressAllow } from "./harness-external.js";
import { loadRoutingPolicy } from "./model-routing-policy.js";
import { routingTaskFromEnv } from "./model-routing-wire.js";
import { checkDestinationHost } from "./model-routing.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";

/**
 * Sealed harness credentials (H2, SHIP_HARNESS_CRED): the per-project,
 * per-profile store an external harness's API key lives in when it is not in
 * the deployment's environment.
 *
 * Until now a credential reached a vendor agent exactly one way — the worker's
 * own env, forwarded by name (harness-external.ts forwardEnv). That couples
 * "which key a project's runs may spend on" to "which keys this machine
 * holds": every project on a worker shares every key, and changing one means
 * a redeploy. This store is the other half: an operator with the `policies`
 * grant seals a key against ONE project and ONE harness profile, the enqueue
 * admits runs against it, and the worker unseals it into the same exec-env
 * delivery H1 built (never a workspace file, never argv).
 *
 * Rules that are load-bearing:
 *
 *   - Values are NEVER returned. `presence` is metadata (name, when, who);
 *     `bindings`/`resolve` hand the unsealed value to the enqueue gate and the
 *     worker only. No API surface this file feeds can grow into a dump.
 *   - Storing is refused while sealing is off (runtime-config.ts
 *     sealingStatus): a plaintext API key in the state store is strictly worse
 *     than the env var it replaces, so the store fails closed instead.
 *   - The run input records a REFERENCE — project, profile, env name, version
 *     — never a value. The worker resolves the reference at exec time, so a
 *     rotated key reaches the next run without touching any recorded log.
 *   - Decision 11: API keys are the default credential path. Subscription
 *     logins are a later admin opt-in (H7) and nothing here stores or mints
 *     one; an env-sourced subscription token keeps its existing behaviour
 *     when the flag is off.
 *
 * The enqueue half (admitHarnessCredentials) refuses, by name, BEFORE the run
 * exists — the same no-ghost-run rule as the budget cap and plan review:
 *   harness-credential-missing      nothing the profile authenticates with is
 *                                   in the deployment env or the store
 *   credential-destination-unknown  a credential travels but no provider host
 *                                   can be derived to judge (a subscription
 *                                   token — Decision 11's deferred case)
 *   no-routing-policy / routing-policy-invalid /
 *   destination-not-in-policy / destination-not-allowed / retention-exceeds
 *                                   the DT2 data-class gate, applied to every
 *                                   external harness rather than only to
 *                                   delegate targets
 *
 * The keying discipline (hash of a length-prefixed tuple, so an arbitrary
 * project or profile cannot escape or exceed a store key) is imitated from T3
 * Code's ProviderCredentialStore (MIT, Copyright (c) 2026 T3 Tools Inc.,
 * v0.1.1-nightly.20261016.3218), cut to Ship's sealed-at-rest store.
 */

export const HARNESS_CRED_FLAG = "SHIP_HARNESS_CRED";

/**
 * On only for an explicit "on" — the strict spelling the incident and ACP
 * flags use, so a bare "1" or "true" cannot turn a credential gate on by
 * accident. Anything else, including unset, is off, and off is byte-identical
 * to the pre-H2 behaviour: no gate, no input field, no store read.
 */
export function harnessCredEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[HARNESS_CRED_FLAG] ?? "").trim().toLowerCase() === "on";
}

/**
 * The env names that AUTHENTICATE a harness profile — a credential, not a
 * tuning knob. Base URLs and config blobs are forwarded too, but they name no
 * secret, and the presence gate asks about secrets.
 *
 * Subscription tokens (CLAUDE_CODE_OAUTH_TOKEN, CODEX_ACCESS_TOKEN) are listed
 * because they are credentials a deployment may legitimately hold in env;
 * under the flag they additionally fail the destination gate, which is
 * Decision 11's "API keys first" made mechanical rather than a silent
 * behaviour change to an existing deployment (flag off changes nothing).
 */
const PROFILE_CREDENTIALS: Record<string, readonly string[]> = {
  "claude-code": ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
  opencode: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "ZHIPU_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  codex: ["CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "AI_GATEWAY_KEY"],
};

/**
 * Which credential names a profile is actually asking for: its credential
 * list INTERSECTED with the effective forward list, because "forwarded" is
 * forwardEnv's own rule — a name SHIP_HARNESS_ENV removed is not delivered,
 * and a presence gate over a name the harness never sees would refuse runs
 * for a reason the operator already overruled.
 */
export function profileCredentialNames(id: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const names = PROFILE_CREDENTIALS[id] ?? [];
  const forward = externalHarnessConfig(id, env).forward;
  return names.filter((name) => forward.includes(name));
}

/** Every credential name any profile knows — the Projects page's suggestions. */
export function allProfileCredentialNames(): string[] {
  return [...new Set(Object.values(PROFILE_CREDENTIALS).flat())].sort();
}

/**
 * What a run's input records about one sealed credential: WHERE it lives and
 * WHICH version was current at enqueue. Never a value, never a digest of one
 * (a digest of a low-entropy secret is a brute-force oracle; a version number
 * says everything replay needs).
 */
export interface HarnessCredentialRef {
  /** The project's repo slug — the store's first key half. */
  project: string;
  /** The harness profile (adapter id) the credential is sealed for. */
  profile: string;
  /** The env name the worker delivers the value under. */
  envName: string;
  /** The binding's version at enqueue: bumped on every store, never reused. */
  version: number;
}

/** Presence metadata — the only shape any UI or API gets. */
export interface HarnessCredentialPresence {
  profile: string;
  envName: string;
  version: number;
  setAt: string;
  /** Who stored it: a Ship username. */
  setBy?: string;
}

/** A binding with its value — enqueue and worker only, never a response body. */
export interface HarnessCredentialBinding extends HarnessCredentialPresence {
  value: string;
}

export interface HarnessCredentialStore {
  /** Seal one value against a project + profile + env name. Refused while sealing is off. */
  set(args: { project: string; profile: string; envName: string; value: string; actor: string }): Promise<HarnessCredentialPresence>;
  /** Remove one binding. Clearing an absent binding is a no-op. */
  clear(args: { project: string; profile: string; envName: string }): Promise<void>;
  /** Every binding's metadata for one project, no values. */
  presence(project: string): Promise<HarnessCredentialPresence[]>;
  /** Every binding with its value unsealed — the enqueue gate and the worker's path. */
  bindings(project: string): Promise<HarnessCredentialBinding[]>;
  /** One binding's value, or undefined when the binding does not exist. */
  resolve(project: string, profile: string, envName: string): Promise<{ value: string; version: number } | undefined>;
}

/**
 * The store key for one binding: a hash of the length-prefixed tuple. Project
 * slugs and profile ids arrive from forms and records, and a raw
 * `${project}|${profile}|${env}` key is one `../` or overlong slug away from
 * a filename the file store cannot hold; the hash is always a safe,
 * fixed-width key, and no repo name lands in the store file's key space.
 */
function bindingKey(project: string, profile: string, envName: string): string {
  const raw = `${project.length}:${project}${profile.length}:${profile}${envName}`;
  return createHash("sha256").update(raw).digest("hex");
}

/** Refuse a binding the delivery path could not act on, at the only write site. */
function assertBindingShape(profile: string, envName: string): void {
  if (profile === NATIVE_HARNESS_ID || HARNESS_VERSIONS[profile] === undefined) {
    throw new Error(`a harness credential is stored for an external harness id, got: ${JSON.stringify(profile)}; known: ${Object.keys(HARNESS_VERSIONS).filter((id) => id !== NATIVE_HARNESS_ID).join(", ")}`);
  }
  // forwardEnv forwards exactly this shape; anything else would be stored and
  // then silently undelivered.
  if (!/^[A-Z_][A-Z0-9_]*$/.test(envName)) {
    throw new Error(`a harness credential's env name must be UPPER_SNAKE_CASE (forwardEnv's own rule), got: ${JSON.stringify(envName)}`);
  }
}

interface StoredRow {
  value: string;
  version: number;
  setAt: string;
  setBy?: string;
  /** The binding a row belongs to, recorded beside it so listing needs no key re-derivation. */
  who?: { project: string; profile: string; envName: string };
}

function toPresence(row: StoredRow): HarnessCredentialPresence {
  const who = row.who!;
  return {
    profile: who.profile,
    envName: who.envName,
    version: row.version,
    setAt: row.setAt,
    ...(row.setBy !== undefined && row.setBy !== "" ? { setBy: row.setBy } : {}),
  };
}

/** One store's write path, shared by the file and Nucleus backends. */
async function writeBinding(
  read: () => Promise<{ find(): Promise<StoredRow | undefined>; write(row: StoredRow): Promise<void> }>,
  args: { project: string; profile: string; envName: string; value: string; actor: string },
  env: NodeJS.ProcessEnv,
): Promise<HarnessCredentialPresence> {
  assertBindingShape(args.profile, args.envName);
  const value = args.value.trim();
  if (value === "") throw new Error("a harness credential cannot be empty — use Clear to remove one");
  if (value.includes("\0")) throw new Error("a harness credential cannot contain a NUL byte");
  // Fail closed, the whole point of the store: runtime-config's seal would
  // pass the value through UNENCRYPTED with no SHIP_CONFIG_KEY, which is a
  // plaintext key in the state store instead of the env var it replaces.
  if (!sealingStatus(env).sealed) {
    throw new Error(
      "storing a harness credential requires encryption at rest: SHIP_CONFIG_KEY is not set on this process. Set the SAME value on the dashboard host and on every worker (teploy-ship join carries it), then store the credential again.",
    );
  }
  const ctx = await read();
  const prior = await ctx.find();
  const row: StoredRow = {
    value: seal(value, env),
    // A version is never reused, so a recorded reference always names exactly
    // one store event and a replay can tell "same binding" from "rewritten".
    version: (prior?.version ?? 0) + 1,
    setAt: new Date().toISOString(),
    ...(args.actor !== "" ? { setBy: args.actor } : {}),
    who: { project: args.project, profile: args.profile, envName: args.envName },
  };
  await ctx.write(row);
  return toPresence(row);
}

/** File-backed: one JSON object mapping binding hash -> row. Single-process by construction. */
export class FileHarnessCredentials implements HarnessCredentialStore {
  #path: string;
  #env: NodeJS.ProcessEnv;

  constructor(dir = stateDir(), env: NodeJS.ProcessEnv = process.env) {
    this.#path = join(dir, "harness-credentials.json");
    this.#env = env;
  }

  async #rows(): Promise<Record<string, StoredRow>> {
    return readJsonFile<Record<string, StoredRow>>(this.#path, {});
  }

  async set(args: { project: string; profile: string; envName: string; value: string; actor: string }): Promise<HarnessCredentialPresence> {
    const key = bindingKey(args.project, args.profile, args.envName);
    return writeBinding(
      async () => ({
        find: async () => (await this.#rows())[key],
        write: async (row) => {
          await updateJsonFile<Record<string, StoredRow>>(this.#path, {}, (all) => ({ ...all, [key]: row }));
        },
      }),
      args,
      this.#env,
    );
  }

  async clear(args: { project: string; profile: string; envName: string }): Promise<void> {
    const key = bindingKey(args.project, args.profile, args.envName);
    await updateJsonFile<Record<string, StoredRow>>(this.#path, {}, (all) => {
      if (!(key in all)) return all;
      const next = { ...all };
      delete next[key];
      return next;
    });
  }

  async presence(project: string): Promise<HarnessCredentialPresence[]> {
    return rowsOfProject(await this.#rows(), project).map(toPresence);
  }

  async bindings(project: string): Promise<HarnessCredentialBinding[]> {
    const rows = rowsOfProject(await this.#rows(), project);
    return rows.map((row) => ({ ...toPresence(row), value: unseal(row.value, this.#env) }));
  }

  async resolve(project: string, profile: string, envName: string): Promise<{ value: string; version: number } | undefined> {
    const row = (await this.#rows())[bindingKey(project, profile, envName)];
    if (row === undefined) return undefined;
    return { value: unseal(row.value, this.#env), version: row.version };
  }
}

function rowsOfProject(rows: Record<string, StoredRow>, project: string): StoredRow[] {
  return Object.values(rows)
    .filter((row) => row.who?.project === project)
    .sort((a, b) => {
      const x = a.who!;
      const y = b.who!;
      return x.profile === y.profile ? (x.envName < y.envName ? -1 : 1) : x.profile < y.profile ? -1 : 1;
    });
}

/**
 * Nucleus-backed, over a table of its own (the house rule: Nucleus cannot
 * ALTER a populated table). The doc carries the binding beside the sealed
 * value, so presence is a real query rather than a key re-derivation.
 */
export class NucleusHarnessCredentials implements HarnessCredentialStore {
  #db: NucleusPgwire;
  #env: NodeJS.ProcessEnv;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire, env: NodeJS.ProcessEnv = process.env) {
    this.#db = db;
    this.#env = env;
  }

  #ensure(): Promise<void> {
    return this.#ready ??= this.#db
      .query("CREATE TABLE IF NOT EXISTS ship_harness_credentials (binding TEXT, doc TEXT)")
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#ready = null;
        throw error;
      });
  }

  async #docOf(key: string): Promise<StoredRow | undefined> {
    const rows = await this.#db.query("SELECT doc FROM ship_harness_credentials WHERE binding = $1", [key]);
    const raw = rows[0]?.doc;
    return raw === null || raw === undefined ? undefined : (JSON.parse(String(raw)) as StoredRow);
  }

  async set(args: { project: string; profile: string; envName: string; value: string; actor: string }): Promise<HarnessCredentialPresence> {
    const key = bindingKey(args.project, args.profile, args.envName);
    return writeBinding(
      async () => ({
        find: async () => await this.#docOf(key),
        write: async (row) => {
          await this.#ensure();
          const doc = JSON.stringify(row);
          await upsertByKey(this.#db, {
            table: "ship_harness_credentials",
            keyColumn: "binding",
            key,
            update: () => this.#db.query("UPDATE ship_harness_credentials SET doc = $1 WHERE binding = $2", [doc, key]),
            insert: () => this.#db.query("INSERT INTO ship_harness_credentials (binding, doc) VALUES ($1, $2)", [key, doc]),
          });
        },
      }),
      args,
      this.#env,
    );
  }

  async clear(args: { project: string; profile: string; envName: string }): Promise<void> {
    await this.#ensure();
    await this.#db.query("DELETE FROM ship_harness_credentials WHERE binding = $1", [bindingKey(args.project, args.profile, args.envName)]);
  }

  async presence(project: string): Promise<HarnessCredentialPresence[]> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT doc FROM ship_harness_credentials");
    return rows
      .map((r) => JSON.parse(String(r.doc)) as StoredRow)
      .filter((row) => row.who?.project === project)
      .sort((a, b) => {
        const x = a.who!;
        const y = b.who!;
        return x.profile === y.profile ? (x.envName < y.envName ? -1 : 1) : x.profile < y.profile ? -1 : 1;
      })
      .map(toPresence);
  }

  async bindings(project: string): Promise<HarnessCredentialBinding[]> {
    const rows: StoredRow[] = [];
    await this.#ensure();
    const all = await this.#db.query("SELECT binding, doc FROM ship_harness_credentials");
    for (const r of all) {
      const row = JSON.parse(String(r.doc)) as StoredRow;
      if (row.who?.project === project) rows.push(row);
    }
    rows.sort((a, b) => {
      const x = a.who!;
      const y = b.who!;
      return x.profile === y.profile ? (x.envName < y.envName ? -1 : 1) : x.profile < y.profile ? -1 : 1;
    });
    return rows.map((row) => ({ ...toPresence(row), value: unseal(row.value, this.#env) }));
  }

  async resolve(project: string, profile: string, envName: string): Promise<{ value: string; version: number } | undefined> {
    await this.#ensure();
    const row = await this.#docOf(bindingKey(project, profile, envName));
    if (row === undefined) return undefined;
    return { value: unseal(row.value, this.#env), version: row.version };
  }
}

/** In-memory, for tests. */
export class MemoryHarnessCredentials implements HarnessCredentialStore {
  #rows = new Map<string, StoredRow>();

  constructor(private env: NodeJS.ProcessEnv = process.env) {}

  async set(args: { project: string; profile: string; envName: string; value: string; actor: string }): Promise<HarnessCredentialPresence> {
    const key = bindingKey(args.project, args.profile, args.envName);
    return writeBinding(
      async () => ({
        find: async () => this.#rows.get(key),
        write: async (row) => {
          this.#rows.set(key, row);
        },
      }),
      args,
      this.env,
    );
  }

  async clear(args: { project: string; profile: string; envName: string }): Promise<void> {
    this.#rows.delete(bindingKey(args.project, args.profile, args.envName));
  }

  async presence(project: string): Promise<HarnessCredentialPresence[]> {
    return rowsOfProject(Object.fromEntries(this.#rows), project).map(toPresence);
  }

  async bindings(project: string): Promise<HarnessCredentialBinding[]> {
    return rowsOfProject(Object.fromEntries(this.#rows), project).map((row) => ({ ...toPresence(row), value: unseal(row.value, this.env) }));
  }

  async resolve(project: string, profile: string, envName: string): Promise<{ value: string; version: number } | undefined> {
    const row = this.#rows.get(bindingKey(project, profile, envName));
    if (row === undefined) return undefined;
    return { value: unseal(row.value, this.env), version: row.version };
  }
}

// ---------------------------------------------------------------------------
// Worker-side resolution
// ---------------------------------------------------------------------------

/** How an executing adapter asks the store for a reference's value. */
export interface HarnessCredentialResolution {
  resolve(ref: HarnessCredentialRef): Promise<{ value: string } | undefined>;
}

/**
 * Bind a store to the adapter option harness-external.ts reads. Undefined
 * when the runtime carries no store (a legacy injected adapter), which leaves
 * references unresolvable — deliberately fail-closed at exec time rather than
 * silently running a credential-referencing run without its credential.
 */
export function harnessCredentialResolver(store: HarnessCredentialStore | undefined): HarnessCredentialResolution | undefined {
  return store === undefined ? undefined : { resolve: (ref) => store.resolve(ref.project, ref.profile, ref.envName) };
}

/**
 * Unseal a run's recorded references into an env overlay for its execs.
 *
 * Failures come back as a NAMED refusal string, never a thrown error: the
 * caller records them on the harness-run step (the contract a replay reads),
 * and the vendor process is not started. A binding that was cleared, a worker
 * with no store wired, or a SHIP_CONFIG_KEY that rotated since enqueue are
 * all live-state facts — the enqueue admitted the run, and the honest outcome
 * is a recorded refusal that names what to re-store, not a run that quietly
 * proceeds unauthenticated.
 */
export async function resolveCredentialOverlay(
  refs: readonly HarnessCredentialRef[] | undefined,
  resolver: HarnessCredentialResolution | undefined,
): Promise<{ overlay: Record<string, string>; failure?: string }> {
  if (refs === undefined || refs.length === 0) return { overlay: {} };
  const missing = (ref: HarnessCredentialRef, why: string): string =>
    `harness credential ${ref.envName} for ${ref.project} (${ref.profile}), which this run's input recorded at enqueue, is not available: ${why}. ` +
    "The agent was not started. Re-store it in Project settings, or unset SHIP_HARNESS_CRED and deliver credentials by the deployment environment.";
  if (resolver === undefined) {
    return { overlay: {}, failure: missing(refs[0]!, "this worker has no credential store wired") };
  }
  const overlay: Record<string, string> = {};
  for (const ref of refs) {
    let resolved: { value: string } | undefined;
    try {
      resolved = await resolver.resolve(ref);
    } catch (error) {
      return { overlay: {}, failure: missing(ref, `the sealed value could not be opened (${error instanceof Error ? error.message : String(error)})`) };
    }
    if (resolved === undefined || resolved.value.trim() === "") {
      return { overlay: {}, failure: missing(ref, "the binding is no longer in the store") };
    }
    overlay[ref.envName] = resolved.value;
  }
  return { overlay };
}

// ---------------------------------------------------------------------------
// The enqueue gate
// ---------------------------------------------------------------------------

export type HarnessCredentialAdmission =
  | { ok: true; refs: HarnessCredentialRef[]; envOverlay: Record<string, string> }
  | { ok: false; code: string; reason: string };

/** The refusal an enqueue surface raises: the code first, so it is named. */
export function harnessCredentialRefusal(code: string, why: string): string {
  return `run refused (${code}): ${why}`;
}

/**
 * Admit one enqueue's external harnesses against the credential store and the
 * routing policy's data-class gate.
 *
 * Presence first (the most actionable refusal), destination second. Both are
 * judged with the SAME derivation the run will actually execute with: stored
 * values are unsealed HERE and overlaid on the env, so a base URL that lives
 * in the store routes the egress derivation and the destination gate to the
 * host the harness will really dial — judging from the deployment env alone
 * would check the wrong host for exactly the runs that use the store.
 *
 * The destination check is the DT2 gate (delegate-targets.ts) generalised to
 * every external harness: the hosts providerEgressAllow derives must be
 * declared in the routing policy and permitted for the deployment's data
 * class, whatever SHIP_MODEL_ROUTING says — a data-protection floor is not a
 * routing preference. It must not break the production shape: claude-code or
 * opencode rerouted to api.z.ai under a policy whose api.z.ai entry retains
 * nothing, with SHIP_MODEL_ROUTING_DESTINATIONS=api.z.ai, passes every check
 * here (harness-credentials.test.ts pins that exact ensemble).
 */
export async function admitHarnessCredentials(args: {
  /** Every harness ref the run will execute under, native ones excluded by the caller. */
  refs: readonly { id: string }[];
  /** The project's repo slug, or null when the run has no repo (env-only). */
  project: string | null;
  store: HarnessCredentialStore | undefined;
  env: NodeJS.ProcessEnv;
}): Promise<HarnessCredentialAdmission> {
  const { env } = args;
  const refuse = (code: string, why: string): HarnessCredentialAdmission => ({ ok: false, code, reason: harnessCredentialRefusal(code, why) });
  let stored: HarnessCredentialBinding[] = [];
  if (args.project !== null && args.store !== undefined) {
    try {
      stored = await args.store.bindings(args.project);
    } catch (error) {
      // A sealed value that cannot be opened is not "no credential": the run
      // WOULD deliver it, and neither gate may judge a half-readable store.
      return refuse(
        "credential-store-unreadable",
        `a credential stored for this project could not be opened (${error instanceof Error ? error.message : String(error)}). Nothing was enqueued.`,
      );
    }
  }
  const refs: HarnessCredentialRef[] = [];
  const overlay: Record<string, string> = {};
  for (const ref of args.refs) {
    const names = profileCredentialNames(ref.id, env);
    const forward = externalHarnessConfig(ref.id, env).forward;
    const mine = stored.filter((b) => b.profile === ref.id);
    // Delivery rule, same as forwardEnv: a stored name rides only when the
    // harness's forward list still carries it. The store value WINS over a
    // deployment env value of the same name — the more specific, more recent
    // deliberate act, the same precedence runtime-config settled.
    const delivered = mine.filter((b) => forward.includes(b.envName));
    for (const binding of delivered) overlay[binding.envName] = binding.value;
    const heldInEnv = names.some((name) => (env[name] ?? "").trim() !== "");
    const heldInStore = names.some((name) => mine.some((b) => b.envName === name));
    if (names.length > 0 && !heldInEnv && !heldInStore) {
      return refuse(
        "harness-credential-missing",
        `${ref.id} authenticates with one of ${names.join(", ")}, and none is set in the deployment environment or stored for ${args.project ?? "a workspace run"} (Project settings, SHIP_HARNESS_CRED=on).`,
      );
    }
    // The destination gate runs whenever a host is derivable, and the hosts
    // are derived from the env the run will REALLY deliver — deployment env
    // overlaid with this profile's unsealed store values (a base URL in the
    // store reroutes exactly the derivation below and the run's own
    // sandboxEgressAllow, or the two would judge different wires).
    const derivedEnv: NodeJS.ProcessEnv = { ...env, ...Object.fromEntries(delivered.map((b) => [b.envName, b.value])) };
    const hosts = providerEgressAllow([ref], derivedEnv).map((entry) => entry.split(":")[0]!.toLowerCase());
    if (hosts.length === 0) {
      if (names.length === 0) continue;
      return refuse(
        "credential-destination-unknown",
        `${ref.id} holds a credential (${names.join(", ")}) whose provider host cannot be derived, so the routing policy cannot judge where this project's data would go. Subscription tokens name no host Ship is allowed to guess (Decision 11: API keys first); use an API key or a base URL the derivation can read.`,
      );
    }
    const loaded = loadRoutingPolicy(env);
    if (loaded === undefined) {
      return refuse("no-routing-policy", `no routing policy is loaded (SHIP_MODEL_ROUTING_POLICY), so no destination is declared for ${ref.id}'s provider host ${hosts.join(", ")}, and Ship cannot judge where this project's data would go`);
    }
    if (!loaded.ok) {
      return refuse("routing-policy-invalid", `the routing policy does not load (${loaded.errors.join("; ")}), so ${ref.id}'s provider destination cannot be checked`);
    }
    const task = { ...routingTaskFromEnv(env), uncertainSideEffects: false };
    for (const host of hosts) {
      const check = checkDestinationHost(loaded.policy, host, task);
      if (!check.ok) {
        return refuse(check.code, `${ref.id} would send this project's data to ${host} (data class ${task.dataClass}), and the routing policy does not permit it: ${check.why}`);
      }
    }
    for (const binding of delivered) {
      // Only credential-shaped names become references: the store may hold a
      // base URL for delivery, and rewriting THAT into a run's input would
      // move sandboxEgressAllow-style facts into a credential reference.
      if (names.includes(binding.envName)) refs.push({ project: args.project!, profile: ref.id, envName: binding.envName, version: binding.version });
    }
  }
  return { ok: true, refs, envOverlay: overlay };
}
