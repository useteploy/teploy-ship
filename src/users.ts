import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scrypt as scryptCb, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import type { NucleusPgwire } from "./nucleus-pgwire.js";
import { withFileLock, writeJsonFile } from "./file-store.js";
import { stateDir } from "./run-store.js";

/**
 * Ship's local account store, conforming to the Teploy RBAC contract
 * (admin/editor/viewer). Roles mean the same thing here as in Dash and
 * Observe, and are modeled so a future OIDC claim (teploy_role) maps 1:1 —
 * so Phase 2 SSO federation slots in without reshaping this.
 *
 * Ship's approve button is remote code + spend approval, so the meaningful
 * lines are: viewer watches; editor approves/launches; admin manages
 * accounts, sources, and secrets. Passwords are hashed with Node's built-in
 * scrypt (no dependency), never stored in plaintext.
 */

export type Role = "admin" | "editor" | "viewer";

export const ROLE_ADMIN: Role = "admin";
export const ROLE_EDITOR: Role = "editor";
export const ROLE_VIEWER: Role = "viewer";

/** Normalize any string to a known role, defaulting unknown to viewer
 * (least privilege — an unrecognized role never gains access). */
export function normalizeRole(r: string | undefined): Role {
  return r === "admin" || r === "editor" || r === "viewer" ? r : "viewer";
}

function roleRank(r: Role): number {
  return r === "admin" ? 3 : r === "editor" ? 2 : 1;
}

/** True when a user holding `have` may act where `need` is required. */
export function roleAllows(have: Role, need: Role): boolean {
  return roleRank(have) >= roleRank(need);
}

export interface ShipUser {
  username: string;
  passwordHash: string;
  role: Role;
  createdAt: string;
}

/** The API/UI projection of an account — never the hash. */
export interface UserView {
  username: string;
  role: Role;
  createdAt: string;
}

export interface UserStore {
  list(): Promise<UserView[]>;
  count(): Promise<number>;
  /** Verify credentials; returns the user on success, null otherwise. Always
   * spends hashing time (even on a missing user) to hide which names exist. */
  verify(username: string, password: string): Promise<UserView | null>;
  create(username: string, password: string, role: Role): Promise<void>;
  setPassword(username: string, password: string): Promise<void>;
  setRole(username: string, role: Role): Promise<void>;
  remove(username: string): Promise<void>;
  get(username: string): Promise<UserView | null>;
}

// ── Password hashing (scrypt, dependency-free) ──────────────────────────

const scrypt = promisify(scryptCb);
const KEYLEN = 32;
const SALTLEN = 16;
// A well-formed hash of nothing anyone knows, used to spend equal CPU on a
// missing-user verify so response time doesn't leak which usernames exist.
const DUMMY_HASH = `scrypt$${"00".repeat(SALTLEN)}$${"00".repeat(KEYLEN)}`;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALTLEN);
  const derived = (await scrypt(password, salt, KEYLEN)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  const derived = (await scrypt(password, salt, expected.length)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

function validatePassword(password: string): void {
  if (password.length < 8) throw new Error("password must be at least 8 characters");
}

function validateUsername(username: string): string {
  const u = username.trim();
  if (u === "") throw new Error("username is required");
  // "token" is the reserved identity of the SHIP_WEB_TOKEN master credential.
  if (u === "token") throw new Error('"token" is a reserved username');
  if (!/^[A-Za-z0-9._@-]+$/.test(u)) throw new Error("username has invalid characters");
  return u;
}

const view = (u: ShipUser): UserView => ({ username: u.username, role: u.role, createdAt: u.createdAt });

// ── File-backed store (single users.json under the state dir) ────────────

interface UsersFile {
  users: ShipUser[];
}

export class FileUserStore implements UserStore {
  #file: string;

  constructor(file = join(stateDir(), "users.json")) {
    this.#file = file;
  }

  async #read(): Promise<ShipUser[]> {
    const raw = await readFile(this.#file, "utf8").catch(() => "");
    if (raw.trim() === "") return [];
    try {
      const parsed = JSON.parse(raw) as UsersFile;
      return (parsed.users ?? []).map((u) => ({ ...u, role: normalizeRole(u.role) }));
    } catch {
      return [];
    }
  }

  /**
   * Atomic, with a UNIQUE temp name. A shared `${file}.tmp` meant two
   * overlapping writers staged over each other and one rename landed a
   * half-written account file.
   */
  async #write(users: ShipUser[]): Promise<void> {
    await writeJsonFile(this.#file, { users } satisfies UsersFile, 0o600);
  }

  /**
   * Serialize a read-modify-write on the account file. Account changes are the
   * one place where a lost update is an authorization bug: two admins editing
   * at once could otherwise resurrect a removed user or undo a role change.
   */
  #mutate<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.#file, fn);
  }

  async list(): Promise<UserView[]> {
    return (await this.#read()).map(view).sort((a, b) => (a.username < b.username ? -1 : 1));
  }

  async count(): Promise<number> {
    return (await this.#read()).length;
  }

  async get(username: string): Promise<UserView | null> {
    const u = (await this.#read()).find((x) => x.username === username);
    return u ? view(u) : null;
  }

  async verify(username: string, password: string): Promise<UserView | null> {
    const u = (await this.#read()).find((x) => x.username === username);
    const ok = await verifyPassword(password, u?.passwordHash ?? DUMMY_HASH);
    return ok && u ? view(u) : null;
  }

  async create(username: string, password: string, role: Role): Promise<void> {
    return this.#mutate(async () => {
      const u = validateUsername(username);
      validatePassword(password);
      const users = await this.#read();
      if (users.some((x) => x.username === u)) throw new Error(`user "${u}" already exists`);
      users.push({ username: u, passwordHash: await hashPassword(password), role: normalizeRole(role), createdAt: new Date().toISOString() });
      await this.#write(users);
    });
  }

  async setPassword(username: string, password: string): Promise<void> {
    return this.#mutate(async () => {
      validatePassword(password);
      const users = await this.#read();
      const u = users.find((x) => x.username === username);
      if (!u) throw new Error("user not found");
      u.passwordHash = await hashPassword(password);
      await this.#write(users);
    });
  }

  async setRole(username: string, role: Role): Promise<void> {
    return this.#mutate(async () => {
      const users = await this.#read();
      const u = users.find((x) => x.username === username);
      if (!u) throw new Error("user not found");
      u.role = normalizeRole(role);
      await this.#write(users);
    });
  }

  async remove(username: string): Promise<void> {
    return this.#mutate(async () => {
      const users = await this.#read();
      const next = users.filter((x) => x.username !== username);
      if (next.length === users.length) throw new Error("user not found");
      await this.#write(next);
    });
  }
}

// ── Nucleus-backed store (ship_users table) ──────────────────────────────

export class NucleusUserStore implements UserStore {
  #db: NucleusPgwire;
  #ready: Promise<void> | null = null;

  constructor(db: NucleusPgwire) {
    this.#db = db;
  }

  #ensure(): Promise<void> {
    this.#ready ??= this.#db
      .query(
        `CREATE TABLE IF NOT EXISTS ship_users (
          username TEXT,
          password_hash TEXT,
          role TEXT,
          created_at TEXT
        )`,
      )
      .then(() => undefined);
    return this.#ready;
  }

  async #all(): Promise<ShipUser[]> {
    await this.#ensure();
    const rows = await this.#db.query("SELECT * FROM ship_users", []);
    return rows.map((r) => ({
      username: String(r.username),
      passwordHash: String(r.password_hash),
      role: normalizeRole(typeof r.role === "string" ? r.role : undefined),
      createdAt: String(r.created_at),
    }));
  }

  async list(): Promise<UserView[]> {
    return (await this.#all()).map(view).sort((a, b) => (a.username < b.username ? -1 : 1));
  }

  async count(): Promise<number> {
    return (await this.#all()).length;
  }

  async get(username: string): Promise<UserView | null> {
    const u = (await this.#all()).find((x) => x.username === username);
    return u ? view(u) : null;
  }

  async verify(username: string, password: string): Promise<UserView | null> {
    const u = (await this.#all()).find((x) => x.username === username);
    const ok = await verifyPassword(password, u?.passwordHash ?? DUMMY_HASH);
    return ok && u ? view(u) : null;
  }

  async create(username: string, password: string, role: Role): Promise<void> {
    const u = validateUsername(username);
    validatePassword(password);
    await this.#ensure();
    if ((await this.#all()).some((x) => x.username === u)) throw new Error(`user "${u}" already exists`);
    await this.#db.query(
      "INSERT INTO ship_users (username, password_hash, role, created_at) VALUES ($1, $2, $3, $4)",
      [u, await hashPassword(password), normalizeRole(role), new Date().toISOString()],
    );
  }

  async setPassword(username: string, password: string): Promise<void> {
    validatePassword(password);
    await this.#ensure();
    if (!(await this.get(username))) throw new Error("user not found");
    await this.#db.query("UPDATE ship_users SET password_hash = $1 WHERE username = $2", [await hashPassword(password), username]);
  }

  async setRole(username: string, role: Role): Promise<void> {
    await this.#ensure();
    if (!(await this.get(username))) throw new Error("user not found");
    await this.#db.query("UPDATE ship_users SET role = $1 WHERE username = $2", [normalizeRole(role), username]);
  }

  async remove(username: string): Promise<void> {
    await this.#ensure();
    if (!(await this.get(username))) throw new Error("user not found");
    await this.#db.query("DELETE FROM ship_users WHERE username = $1", [username]);
  }
}
