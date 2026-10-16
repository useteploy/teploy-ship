import { withFileLock } from "./file-store.js";
import { validatePassword, validateUsername, ROLE_ADMIN } from "./users.js";
import type { UserStore } from "./users.js";
import type { RuntimeConfigStore } from "./runtime-config.js";
import type { KvSurface } from "./nucleus-pgwire.js";

/**
 * Bootstrap the initial local admin account (the port of observe's
 * EnsureAdmin, in Ship's shape).
 *
 * The gap this closes: Ship has scrypt password login and a users store with
 * setPassword/setRole, but NOTHING ever created the first local account — no
 * CLI command, no bootstrap — so a fresh deployment had no local login, and
 * the break-glass SHIP_WEB_TOKEN stayed the de-facto login forever. Two
 * environment secrets (delivered as teploy secrets) now provision the first
 * admin at WEB process boot:
 *
 *   SHIP_BOOTSTRAP_ADMIN_USER      the username to create
 *   SHIP_BOOTSTRAP_ADMIN_PASSWORD  its password (never logged, never stored
 *                                  in the clear — the users store hashes it)
 *
 * Rules, all inherited from observe's design because they were decided there
 * for reasons that still hold:
 *
 *   - NO OVERWRITE: the account is created only when the users store holds no
 *     local principals at all. An install that already has accounts is left
 *     alone, however the env is set.
 *   - ATOMIC CLAIM: two boots (two web processes, or a rolling deploy's old
 *     and new process) can both observe an empty store and both try to
 *     create; only the one that wins the claim proceeds. On the nucleus and
 *     postgres runtimes the claim is the store's own atomic setNX
 *     (`ship:bootstrap:admin` in the KV surface — the same primitive
 *     admission, the outbox and the delivery log already rely on). On the
 *     file runtime it is the delegation ledger's machinery: withFileLock
 *     around a read-check-write against the runtime config store.
 *   - ONCE EVER: the claim is not released on success. A later boot with the
 *     same (or different) secrets is a no-op; even deleting every local
 *     account does not re-open bootstrap while the claim stands.
 *   - NO HALF-BOOTSTRAP: if exactly one of the two variables is set, nothing
 *     is created and one precise line says which variable is missing.
 *   - THE PASSWORD IS NEVER LOGGED. The success line names the username.
 */

/** The claim key. KV naming (`ship:<thing>:<what>`) on the store runtimes;
 * same string in the runtime config on the file runtime, where it is visible
 * (key + updatedAt + updatedBy, never a value) on the Settings page. */
export const BOOTSTRAP_ADMIN_CLAIM_KEY = "ship:bootstrap:admin";

export const BOOTSTRAP_ADMIN_USER_VAR = "SHIP_BOOTSTRAP_ADMIN_USER";
export const BOOTSTRAP_ADMIN_PASSWORD_VAR = "SHIP_BOOTSTRAP_ADMIN_PASSWORD";

/**
 * The slice of ShipRuntime bootstrap needs, structural so a test can stand in
 * a fake without a live store (the codebase's PoolLike/KvSurface pattern).
 * `db` is present on the nucleus/postgres runtimes (NucleusShipRuntime).
 */
export interface BootstrapRuntime {
  kind: "file" | "nucleus" | "postgres";
  users: UserStore;
  config: RuntimeConfigStore;
  db?: { kv: KvSurface };
}

export type BootstrapAdminOutcome =
  /** Account created and the claim taken. */
  | "created"
  /** Neither variable set — nothing was asked for, nothing logged. */
  | "unset"
  /** Exactly one variable set — refused, one log line, nothing touched. */
  | "refused"
  /** The store already holds local principals — skipped, nothing touched. */
  | "skipped-existing"
  /** Another boot holds the bootstrap claim — skipped, nothing touched. */
  | "skipped-claimed"
  /** Acted and failed; the claim was released so a retry can succeed. */
  | "error";

export interface BootstrapAdminResult {
  outcome: BootstrapAdminOutcome;
  /** The created username (outcome "created"). */
  username?: string;
  /** One-line reason for refused/error. Never contains the password. */
  reason?: string;
}

const line = (message: string): string => `bootstrap admin: ${message}`;

/**
 * Claim the bootstrap, once, atomically under the store's single-writer
 * semantics. True iff THIS caller is the one that took it.
 *
 * ATOMICITY CEILING, stated honestly per runtime kind: the nucleus/postgres
 * path is atomic across processes (KV setNX is the store primitive every
 * other cross-process claim here uses). The file path is atomic within this
 * process only — withFileLock is a promise chain, not an OS lock — which is
 * the file runtime's documented ceiling everywhere else too: it is the
 * single-process path by construction, and multi-process deployments run on
 * the shared store.
 */
async function claimBootstrap(runtime: BootstrapRuntime, username: string): Promise<boolean> {
  if (runtime.kind !== "file") {
    if (runtime.db === undefined) {
      throw new Error(`a ${runtime.kind} runtime has no KV surface to claim through`);
    }
    // The username is the claim's value, which is what makes the failure
    // release below value-conditional: a rival can never release our claim.
    return runtime.db.kv.setNX(BOOTSTRAP_ADMIN_CLAIM_KEY, username);
  }
  let claimed = false;
  await withFileLock(BOOTSTRAP_ADMIN_CLAIM_KEY, async () => {
    if ((await runtime.config.get(BOOTSTRAP_ADMIN_CLAIM_KEY)) !== undefined) return;
    await runtime.config.set(BOOTSTRAP_ADMIN_CLAIM_KEY, username, "bootstrap-admin");
    claimed = true;
  });
  return claimed;
}

/**
 * Give the claim back after a failure to create, so one transient store error
 * does not permanently brick bootstrap (the claim would otherwise outlive the
 * attempt with no account behind it). Value-conditional on both runtimes: a
 * rival that somehow holds the claim is never released by us.
 */
async function releaseBootstrapClaim(runtime: BootstrapRuntime, username: string, log: (l: string) => void): Promise<void> {
  try {
    if (runtime.kind !== "file") {
      await runtime.db?.kv.cdel(BOOTSTRAP_ADMIN_CLAIM_KEY, username);
      return;
    }
    await withFileLock(BOOTSTRAP_ADMIN_CLAIM_KEY, async () => {
      if ((await runtime.config.get(BOOTSTRAP_ADMIN_CLAIM_KEY)) !== username) return;
      await runtime.config.remove(BOOTSTRAP_ADMIN_CLAIM_KEY);
    });
  } catch (error) {
    // Never fatal: the claim staying set with no account is recoverable (the
    // SHIP_WEB_TOKEN master credential is always an admin way in), but it
    // must be SAID, not silently swallowed.
    log(line(`releasing the claim after a failure did not succeed — bootstrap may need the "${BOOTSTRAP_ADMIN_CLAIM_KEY}" claim removed by hand (${error instanceof Error ? error.message : String(error)})`));
  }
}

/**
 * Create the initial admin from the environment. Never throws: every failure
 * is a result plus (where one is called for) a single log line.
 *
 * The crash window between a won claim and the created account is narrow and
 * known: a hard kill there leaves the claim set with no account, bootstrap
 * stays closed, and the SHIP_WEB_TOKEN master credential remains the admin
 * way in (log in with it, create accounts in Settings → Users). Same trade
 * observe's EnsureAdmin makes; a once-ever bootstrap does not warrant a TTL
 * setNX cannot express anyway.
 */
export async function bootstrapAdmin(
  runtime: BootstrapRuntime,
  env: NodeJS.ProcessEnv = process.env,
  log: (l: string) => void = (l) => console.log(l),
): Promise<BootstrapAdminResult> {
  const usernameRaw = env[BOOTSTRAP_ADMIN_USER_VAR] ?? "";
  const password = env[BOOTSTRAP_ADMIN_PASSWORD_VAR] ?? "";
  const userSet = usernameRaw !== "";
  const passwordSet = password !== "";
  if (!userSet && !passwordSet) return { outcome: "unset" };
  if (userSet !== passwordSet) {
    const setVar = userSet ? BOOTSTRAP_ADMIN_USER_VAR : BOOTSTRAP_ADMIN_PASSWORD_VAR;
    const missingVar = userSet ? BOOTSTRAP_ADMIN_PASSWORD_VAR : BOOTSTRAP_ADMIN_USER_VAR;
    const reason = `${setVar} is set but ${missingVar} is not — set both or clear both; nothing was created`;
    log(line(`refusing to act: ${reason}`));
    return { outcome: "refused", reason };
  }

  // Fail closed on an unreadable store: treating a read error as "no
  // principals" would let a store outage mint an admin nobody asked to
  // bootstrap over (observe's HasAdminUsers lesson, same direction).
  let count: number;
  try {
    count = await runtime.users.count();
  } catch (error) {
    const reason = `the users store could not be read (${error instanceof Error ? error.message : String(error)})`;
    log(line(`not applied: ${reason}`));
    return { outcome: "error", reason };
  }
  if (count > 0) return { outcome: "skipped-existing" };

  // Validate through the users store's own policy BEFORE claiming, so a bad
  // username or a too-short password never takes the once-ever claim (and
  // never needs the failure release). One policy backs every entry point.
  let username: string;
  try {
    username = validateUsername(usernameRaw);
    validatePassword(password);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(line(`not applied: ${reason}`));
    return { outcome: "error", reason };
  }

  let claimed: boolean;
  try {
    claimed = await claimBootstrap(runtime, username);
  } catch (error) {
    const reason = `the bootstrap claim could not be taken (${error instanceof Error ? error.message : String(error)})`;
    log(line(`not applied: ${reason}`));
    return { outcome: "error", reason };
  }
  if (!claimed) return { outcome: "skipped-claimed" };

  try {
    await runtime.users.create(username, password, ROLE_ADMIN);
  } catch (error) {
    const reason = `user creation failed (${error instanceof Error ? error.message : String(error)})`;
    await releaseBootstrapClaim(runtime, username, log);
    log(line(`not applied: ${reason}`));
    return { outcome: "error", reason };
  }
  log(line(`created initial admin user "${username}"`));
  return { outcome: "created", username };
}
