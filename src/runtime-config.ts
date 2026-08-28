import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";

import { readJsonFile, updateJsonFile } from "./file-store.js";
import { stateDir } from "./run-store.js";
import { upsertByKey } from "./upsert.js";
import type { NucleusPgwire } from "./nucleus-pgwire.js";

/**
 * Runtime configuration: settings an operator changes WHILE Ship is running,
 * without a redeploy and without `teploy secret set`.
 *
 * Everything else Ship reads from the environment is install-shaped — the store
 * URL, the forge token, the model gateway — set once by install.sh or by the
 * deploy manifest and changed by redeploying. The browser-mediated Akiroo
 * connect is the first thing that is not: an admin starts a connect on Ship, an
 * owner approves it on the workspace, and Ship itself receives a freshly minted
 * pull token seconds later. There is no deploy in that loop to carry the value,
 * so the value has to land somewhere the running processes can both write and
 * read.
 *
 * The precedence is settled and deliberately NOT the usual "env always wins":
 *
 *   a non-empty runtime value WINS over the environment variable of the same
 *   name; when the runtime value is absent or empty, process.env is used.
 *
 * The handshake is the more recent deliberate act of an operator who was
 * looking at the connector at the time, so it outranks a value baked into the
 * manifest months ago. What makes that safe rather than confusing is that
 * resolution REPORTS its source (see ResolvedValue.source) and the Settings
 * page renders it — an override that is invisible is the kind that costs an
 * hour.
 *
 * The store is deliberately small and NOT a general settings bag. Its `list()`
 * returns metadata with no values at all, so no generic debug or status route
 * can ever grow into a credential dump: reading a value requires naming the key.
 */

/** Where a resolved value came from. */
export type ConfigSource = "runtime" | "env" | "unset";

export interface ResolvedValue {
  /** Trimmed value; empty string exactly when source is "unset". */
  value: string;
  source: ConfigSource;
}

/** One row's metadata — never its value. See the note on RuntimeConfigStore.list. */
export interface RuntimeConfigEntry {
  key: string;
  /** True when the stored value is non-empty. The value itself is not exposed here. */
  set: boolean;
  updatedAt: string;
  /** Who wrote it: a Ship username, or a subsystem name like "akiroo-connect". */
  updatedBy?: string;
}

export interface RuntimeConfigStore {
  /** The stored value for one key, or undefined when unset or empty. */
  get(key: string): Promise<string | undefined>;
  /** Write (or overwrite) one key. An empty value removes it, so "clear" is not a second verb. */
  set(key: string, value: string, updatedBy?: string): Promise<void>;
  remove(key: string): Promise<void>;
  /**
   * Every key this store holds, WITHOUT values.
   *
   * The Settings page needs to say which keys are overridden and when; it never
   * needs the secret itself, and a list() that returned values would make every
   * future caller a potential disclosure. Callers that genuinely need a value
   * ask for it by name.
   */
  list(): Promise<RuntimeConfigEntry[]>;
}

/**
 * Keys whose stored value is sealed at rest (see seal/unseal below).
 *
 * Fixed here rather than passed in by callers: a credential that is only
 * protected when the caller remembers to ask is not protected. Add a key to
 * this set and every store starts sealing it on the next write; values already
 * written in the clear keep being read (unseal passes them through), so turning
 * it on is not a migration.
 */
export const SEALED_KEYS = new Set(["AKIROO_PULL_TOKEN"]);

const SEAL_PREFIX = "enc:v1:";

/**
 * The key material for sealing, or null when this install has none.
 *
 * This SHOULD be on by default and is not, and the reason is worth writing down
 * because it looks like an oversight and is not one. Sealing is only useful if
 * the process that READS the value can open it, and the reader here is the
 * worker: the web process completes the handshake, the worker polls with the
 * token. So a default key would have to be derived from something present in
 * BOTH. Ship has no such secret:
 *
 *   SHIP_SESSION_SECRET, SHIP_WEB_TOKEN   in web; stripped from every joined
 *                                          worker by join.ts NOT_FOR_A_WORKER,
 *                                          because they are per-install
 *                                          dashboard secrets and two hosts
 *                                          sharing them means either can mint
 *                                          the other's sessions.
 *   SHIP_GIT_TOKEN, AI_GATEWAY_KEY        in the worker; stripped from web by
 *                                          cli.ts WORKER_ONLY_SECRETS.
 *   NUCLEUS_URL                            in both — and useless, because it is
 *                                          the address of the very store this
 *                                          would be protecting.
 *
 * Deriving from SHIP_SESSION_SECRET anyway would work on a single box and
 * encrypt the token to nobody on a joined fleet, where unseal() throws and the
 * connector stops. A default that breaks the multi-host deployment is not a
 * default. So sealing stays explicit, and `sealingStatus` below exists so the
 * Settings page can say plainly that it is off and what to set.
 *
 * Set SHIP_CONFIG_KEY (same value on the dashboard host and on every worker;
 * `teploy-ship join` carries it, since it is not in NOT_FOR_A_WORKER) and a
 * reader who can reach Ship's unauthenticated Nucleus but not its environment
 * no longer gets the token. Rotating it makes sealed values unreadable: re-run
 * the connect, which is a twenty-second operation.
 */
function sealingKey(env: NodeJS.ProcessEnv): Buffer | null {
  const secret = (env.SHIP_CONFIG_KEY ?? "").trim();
  if (secret === "") return null;
  return createHash("sha256").update(secret).digest();
}

/**
 * Whether stored credentials are encrypted at rest on this install, and the
 * sentence to show an operator when they are not.
 *
 * Surfaced on Settings rather than left to a comment: "the pull token is in the
 * clear in Nucleus" is a fact about a running deployment, and a fact about a
 * running deployment that only appears in source is one nobody acts on.
 */
export function sealingStatus(env: NodeJS.ProcessEnv = process.env): { sealed: boolean; detail: string } {
  if (sealingKey(env) !== null) {
    return { sealed: true, detail: "SHIP_CONFIG_KEY is set — the stored pull token is encrypted at rest" };
  }
  return {
    sealed: false,
    detail:
      "SHIP_CONFIG_KEY is not set, so the stored pull token sits in Nucleus in the clear — " +
      "anyone who can reach the store can read it without reaching this server's environment. " +
      "Set the SAME value on the dashboard host and on every worker (teploy-ship join carries it) to seal it.",
  };
}

/** AES-256-GCM, random IV per write, tag and IV carried in the stored string. */
export function seal(value: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = sealingKey(env);
  if (key === null) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${SEAL_PREFIX}${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

/**
 * Reverse of seal. A value that was never sealed passes through unchanged, so a
 * store written before SHIP_CONFIG_KEY existed keeps working.
 *
 * A sealed value that cannot be opened THROWS rather than returning the
 * ciphertext: handing `enc:v1:...` back as if it were a pull token would make a
 * rotated SHIP_CONFIG_KEY look like an Akiroo authentication failure, and the
 * operator would rotate the wrong credential.
 */
export function unseal(stored: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!stored.startsWith(SEAL_PREFIX)) return stored;
  const key = sealingKey(env);
  if (key === null) {
    throw new Error("runtime config holds a sealed value but SHIP_CONFIG_KEY is not set");
  }
  const [rawIv, rawTag, rawBody] = stored.slice(SEAL_PREFIX.length).split(".");
  if (rawIv === undefined || rawTag === undefined || rawBody === undefined) {
    throw new Error("runtime config holds a malformed sealed value");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(rawIv, "base64url"));
  decipher.setAuthTag(Buffer.from(rawTag, "base64url"));
  try {
    return Buffer.concat([decipher.update(Buffer.from(rawBody, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("runtime config value could not be opened — SHIP_CONFIG_KEY was rotated; re-run the connect");
  }
}

function storedForm(key: string, value: string, env: NodeJS.ProcessEnv): string {
  return SEALED_KEYS.has(key) ? seal(value, env) : value;
}

function plainForm(key: string, stored: string, env: NodeJS.ProcessEnv): string {
  return SEALED_KEYS.has(key) ? unseal(stored, env) : stored;
}

/**
 * Resolve one key against the settled precedence and report which side won.
 *
 * Per VALUE. Callers that own a pair of values which are only meaningful
 * together (the Akiroo base and its pull token) must NOT apply this
 * independently — see resolveAkirooTarget in akiroo.ts for why mixing a runtime
 * URL with an environment token is a credential-disclosure bug rather than a
 * merge.
 */
export async function resolveConfigValue(
  store: Pick<RuntimeConfigStore, "get">,
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedValue> {
  const stored = (await store.get(key))?.trim() ?? "";
  if (stored !== "") return { value: stored, source: "runtime" };
  const fromEnv = (env[key] ?? "").trim();
  if (fromEnv !== "") return { value: fromEnv, source: "env" };
  return { value: "", source: "unset" };
}

/**
 * Do two resolutions name the same value? Used to decide whether a connector
 * actually changed between polls, without ever comparing secrets by logging
 * them. Length-guarded because timingSafeEqual throws on a length mismatch.
 */
export function sameResolvedValue(a: ResolvedValue, b: ResolvedValue): boolean {
  if (a.source !== b.source) return false;
  const left = Buffer.from(a.value, "utf8");
  const right = Buffer.from(b.value, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

interface FileRow {
  value: string;
  updatedAt: string;
  updatedBy?: string;
}

/** File-backed: one JSON object mapping key -> row. Single-process by construction. */
export class FileRuntimeConfig implements RuntimeConfigStore {
  #path: string;
  #env: NodeJS.ProcessEnv;

  constructor(dir = stateDir(), env: NodeJS.ProcessEnv = process.env) {
    this.#path = join(dir, "runtime-config.json");
    this.#env = env;
  }

  async #read(): Promise<Record<string, FileRow>> {
    return readJsonFile<Record<string, FileRow>>(this.#path, {});
  }

  async get(key: string): Promise<string | undefined> {
    const row = (await this.#read())[key];
    if (row === undefined || row.value === "") return undefined;
    return plainForm(key, row.value, this.#env);
  }

  async set(key: string, value: string, updatedBy?: string): Promise<void> {
    const trimmed = value.trim();
    if (trimmed === "") return this.remove(key);
    const row: FileRow = {
      value: storedForm(key, trimmed, this.#env),
      updatedAt: new Date().toISOString(),
      ...(updatedBy !== undefined && updatedBy !== "" ? { updatedBy } : {}),
    };
    await updateJsonFile<Record<string, FileRow>>(this.#path, {}, (all) => ({ ...all, [key]: row }));
  }

  async remove(key: string): Promise<void> {
    await updateJsonFile<Record<string, FileRow>>(this.#path, {}, (all) => {
      const next = { ...all };
      delete next[key];
      return next;
    });
  }

  async list(): Promise<RuntimeConfigEntry[]> {
    const all = await this.#read();
    return Object.entries(all)
      .map(([key, row]) => ({
        key,
        set: row.value !== "",
        updatedAt: row.updatedAt,
        ...(row.updatedBy !== undefined ? { updatedBy: row.updatedBy } : {}),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
  }
}

/**
 * The columns of ship_runtime_config, in DDL order.
 *
 * Exported because migration 006 probes exactly this list write-shaped
 * (`UPDATE ... SET c = c WHERE 1 = 0`) — one definition, so a column added here
 * and forgotten in the migration is not possible.
 *
 * `config_key`/`config_value` rather than the obvious `key`/`value`: both bare
 * names are keywords in the SQL standard, and this table is created from
 * application code against Nucleus's own parser rather than Postgres's. The
 * prefix costs nothing and removes a class of "works on my Postgres" surprise.
 */
export const RUNTIME_CONFIG_COLUMNS = ["config_key", "config_value", "updated_at", "updated_by"];

/**
 * Nucleus-backed, over a table of its OWN.
 *
 * A new table rather than a column on anything existing, per the house rule:
 * Nucleus cannot ALTER-ADD a column to a populated table, and ship_docs /
 * ship_tasks are populated on every deployed box. ship_fleet_load and
 * ship_code_rates are the same decision made twice before.
 */
export class NucleusRuntimeConfig implements RuntimeConfigStore {
  #db: NucleusPgwire;
  #env: NodeJS.ProcessEnv;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire, env: NodeJS.ProcessEnv = process.env) {
    this.#db = db;
    this.#env = env;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_runtime_config (
          config_key TEXT,
          config_value TEXT,
          updated_at TEXT,
          updated_by TEXT
        )`,
      )
      .then(() => undefined)
      // A failed ensure must not be cached: one transient store error would
      // otherwise poison every later call for the life of the process.
      .catch((error: unknown) => {
        this.#ready = null;
        throw error;
      });
    return this.#ready;
  }

  async get(key: string): Promise<string | undefined> {
    await this.#ensure();
    const rows = await this.#db.query(
      `SELECT config_value FROM ship_runtime_config WHERE config_key = $1`,
      [key],
    );
    const raw = rows[0]?.config_value;
    if (raw === null || raw === undefined || String(raw) === "") return undefined;
    return plainForm(key, String(raw), this.#env);
  }

  async set(key: string, value: string, updatedBy?: string): Promise<void> {
    const trimmed = value.trim();
    if (trimmed === "") return this.remove(key);
    await this.#ensure();
    const stored = storedForm(key, trimmed, this.#env);
    const at = new Date().toISOString();
    const by = updatedBy !== undefined && updatedBy !== "" ? updatedBy : null;
    await upsertByKey(this.#db, {
      table: "ship_runtime_config",
      keyColumn: "config_key",
      key,
      update: () =>
        this.#db.query(
          `UPDATE ship_runtime_config SET config_value = $1, updated_at = $2, updated_by = $3 WHERE config_key = $4`,
          [stored, at, by, key],
        ),
      insert: () =>
        this.#db.query(
          `INSERT INTO ship_runtime_config (config_key, config_value, updated_at, updated_by) VALUES ($1, $2, $3, $4)`,
          [key, stored, at, by],
        ),
    });
  }

  async remove(key: string): Promise<void> {
    await this.#ensure();
    await this.#db.query(`DELETE FROM ship_runtime_config WHERE config_key = $1`, [key]);
  }

  async list(): Promise<RuntimeConfigEntry[]> {
    await this.#ensure();
    // config_value is read only to answer "is it set", and is never returned.
    const rows = await this.#db.query(
      `SELECT config_key, config_value, updated_at, updated_by FROM ship_runtime_config`,
    );
    return rows
      .map((row) => ({
        key: String(row.config_key),
        set: row.config_value !== null && row.config_value !== undefined && String(row.config_value) !== "",
        updatedAt: row.updated_at === null || row.updated_at === undefined ? "" : String(row.updated_at),
        ...(row.updated_by !== null && row.updated_by !== undefined ? { updatedBy: String(row.updated_by) } : {}),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
  }
}

/** In-memory, for tests and for the file runtime's callers that want no disk. */
export class MemoryRuntimeConfig implements RuntimeConfigStore {
  #rows = new Map<string, { value: string; updatedAt: string; updatedBy?: string }>();

  async get(key: string): Promise<string | undefined> {
    const row = this.#rows.get(key);
    return row === undefined || row.value === "" ? undefined : row.value;
  }

  async set(key: string, value: string, updatedBy?: string): Promise<void> {
    const trimmed = value.trim();
    if (trimmed === "") return this.remove(key);
    this.#rows.set(key, {
      value: trimmed,
      updatedAt: new Date().toISOString(),
      ...(updatedBy !== undefined && updatedBy !== "" ? { updatedBy } : {}),
    });
  }

  async remove(key: string): Promise<void> {
    this.#rows.delete(key);
  }

  async list(): Promise<RuntimeConfigEntry[]> {
    return [...this.#rows.entries()]
      .map(([key, row]) => ({
        key,
        set: row.value !== "",
        updatedAt: row.updatedAt,
        ...(row.updatedBy !== undefined ? { updatedBy: row.updatedBy } : {}),
      }))
      .sort((a, b) => (a.key < b.key ? -1 : 1));
  }
}
