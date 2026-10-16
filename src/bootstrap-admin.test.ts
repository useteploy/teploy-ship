import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BOOTSTRAP_ADMIN_CLAIM_KEY, bootstrapAdmin } from "./bootstrap-admin.js";
import type { BootstrapRuntime } from "./bootstrap-admin.js";
import { MemoryRuntimeConfig } from "./runtime-config.js";
import { FileUserStore, hashPassword, verifyPassword } from "./users.js";
import type { Role, ShipUser, UserStore, UserView } from "./users.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A UserStore with the same validation calls as FileUserStore but in memory,
 * with real scrypt hashes (hashPassword/verifyPassword are the production
 * functions) so "the password verifies" is a real claim, plus call counters
 * and failure injection for the claim/release tests. */
class MemoryUsers implements UserStore {
  rows: ShipUser[] = [];
  createCalls = 0;
  failNextCreate: Error | null = null;

  async create(username: string, password: string, role: Role): Promise<void> {
    this.createCalls += 1;
    if (this.failNextCreate !== null) {
      const error = this.failNextCreate;
      this.failNextCreate = null;
      throw error;
    }
    const u = username.trim();
    if (u === "") throw new Error("username is required");
    if (u === "token") throw new Error('"token" is a reserved username');
    if (password.length < 8) throw new Error("password must be at least 8 characters");
    if (this.rows.some((x) => x.username === u)) throw new Error(`user "${u}" already exists`);
    this.rows.push({ username: u, passwordHash: await hashPassword(password), role, createdAt: new Date().toISOString() });
  }

  async count(): Promise<number> {
    return this.rows.length;
  }

  async list(): Promise<UserView[]> {
    return this.rows.map(({ username, role, createdAt }) => ({ username, role, createdAt }));
  }

  async get(username: string): Promise<UserView | null> {
    const row = this.rows.find((x) => x.username === username);
    return row === undefined ? null : { username: row.username, role: row.role, createdAt: row.createdAt };
  }

  async verify(username: string, password: string): Promise<UserView | null> {
    const row = this.rows.find((x) => x.username === username);
    const ok = await verifyPassword(password, row?.passwordHash ?? "scrypt$" + "00".repeat(16) + "00".repeat(32));
    if (!ok || row === undefined) return null;
    return { username: row.username, role: row.role, createdAt: row.createdAt };
  }

  async setPassword(username: string, password: string): Promise<void> {
    const row = this.rows.find((x) => x.username === username);
    if (row === undefined) throw new Error("user not found");
    row.passwordHash = await hashPassword(password);
  }

  async setRole(username: string, role: Role): Promise<void> {
    const row = this.rows.find((x) => x.username === username);
    if (row === undefined) throw new Error("user not found");
    row.role = role;
  }

  async remove(username: string): Promise<void> {
    const next = this.rows.filter((x) => x.username !== username);
    if (next.length === this.rows.length) throw new Error("user not found");
    this.rows = next;
  }
}

/** A file-kind runtime: config-store claim, no KV surface. */
function fileRuntime(users: UserStore): { runtime: BootstrapRuntime; config: MemoryRuntimeConfig } {
  const config = new MemoryRuntimeConfig();
  return { runtime: { kind: "file", users, config }, config };
}

/** A nucleus-kind runtime over a shared KV map, so two "processes" race on one
 * store. kv.setNX/cdel follow the documented semantics: set-if-absent, and a
 * delete that only lands when the expected holder matches. */
interface SharedKv {
  map: Map<string, string>;
  setNxCalls: Array<{ key: string; value: string }>;
  cdelCalls: Array<{ key: string; expected: string }>;
}

function sharedKv(): SharedKv {
  return { map: new Map(), setNxCalls: [], cdelCalls: [] };
}

function nucleusRuntime(users: UserStore, kv: SharedKv): BootstrapRuntime {
  return {
    kind: "nucleus",
    users,
    config: new MemoryRuntimeConfig(),
    db: {
      kv: {
        async setNX(key, value): Promise<boolean> {
          kv.setNxCalls.push({ key, value });
          if (kv.map.has(key)) return false;
          kv.map.set(key, value);
          return true;
        },
        async cdel(key, expected): Promise<boolean> {
          kv.cdelCalls.push({ key, expected });
          if (kv.map.get(key) !== expected) return false;
          kv.map.delete(key);
          return true;
        },
        async cexpire(): Promise<boolean> {
          return true;
        },
      },
    },
  };
}

const BOTH = { SHIP_BOOTSTRAP_ADMIN_USER: "tyler", SHIP_BOOTSTRAP_ADMIN_PASSWORD: "a-very-long-horse-battery" };
const PASSWORD = "a-very-long-horse-battery";

function capture(): { lines: string[]; log: (l: string) => void } {
  const lines: string[] = [];
  return { lines, log: (l: string) => lines.push(l) };
}

// ---------------------------------------------------------------------------
// The bootstrap itself
// ---------------------------------------------------------------------------

test("an empty store plus both variables creates a verifiable admin and takes the claim", async () => {
  const { runtime, config } = fileRuntime(new MemoryUsers());
  const out = capture();
  const result = await bootstrapAdmin(runtime, BOTH, out.log);
  assert.equal(result.outcome, "created");
  assert.equal(result.username, "tyler");
  // Verifiable password: the REAL verify path accepts it, and the role is admin.
  const users = runtime.users as MemoryUsers;
  const verified = await users.verify("tyler", PASSWORD);
  assert.notEqual(verified, null);
  assert.equal(verified?.role, "admin");
  // The claim is written, once ever, and names the bootstrapped username.
  assert.equal(await config.get(BOOTSTRAP_ADMIN_CLAIM_KEY), "tyler");
  // One log line on success, naming the username and never the password.
  assert.equal(out.lines.length, 1);
  assert.match(out.lines[0]!, /created initial admin user "tyler"/);
});

test("a second boot with the same secrets is a no-op that claims nothing new", async () => {
  const { runtime, config } = fileRuntime(new MemoryUsers());
  await bootstrapAdmin(runtime, BOTH, () => {});
  const before = await config.get(BOOTSTRAP_ADMIN_CLAIM_KEY);
  const users = runtime.users as MemoryUsers;
  const createsBefore = users.createCalls;

  const out = capture();
  const second = await bootstrapAdmin(runtime, BOTH, out.log);

  assert.equal(second.outcome, "skipped-existing");
  assert.equal(users.createCalls, createsBefore, "no second create");
  assert.equal(await config.get(BOOTSTRAP_ADMIN_CLAIM_KEY), before, "the claim is untouched");
  assert.equal(out.lines.length, 0, "an idempotent boot is a silent one");
  // The ORIGINAL password still verifies — the no-op changed nothing.
  assert.notEqual(await users.verify("tyler", PASSWORD), null);
});

test("an install with existing principals is skipped entirely, even with the env set", async () => {
  const users = new MemoryUsers();
  await users.create("earlier", "an-earlier-long-password", "viewer");
  const { runtime, config } = fileRuntime(users);
  const out = capture();
  const result = await bootstrapAdmin(runtime, BOTH, out.log);
  assert.equal(result.outcome, "skipped-existing");
  assert.equal(users.createCalls, 1, "only the seeded account exists");
  assert.equal(await config.get(BOOTSTRAP_ADMIN_CLAIM_KEY), undefined, "no claim is taken");
  assert.equal(out.lines.length, 0);
});

test("exactly one of the two variables is refused, precisely, with nothing touched", async () => {
  for (const [env, missing] of [
    [{ SHIP_BOOTSTRAP_ADMIN_USER: "tyler" } as NodeJS.ProcessEnv, "SHIP_BOOTSTRAP_ADMIN_PASSWORD"],
    [{ SHIP_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD } as NodeJS.ProcessEnv, "SHIP_BOOTSTRAP_ADMIN_USER"],
  ] as const) {
    const users = new MemoryUsers();
    const { runtime, config } = fileRuntime(users);
    const out = capture();
    const result = await bootstrapAdmin(runtime, env, out.log);
    assert.equal(result.outcome, "refused");
    assert.match(result.reason ?? "", new RegExp(missing));
    assert.match(out.lines[0] ?? "", new RegExp(missing), "one precise line naming the missing variable");
    assert.equal(out.lines.length, 1);
    assert.equal(users.createCalls, 0, "nothing was created");
    assert.equal(await config.get(BOOTSTRAP_ADMIN_CLAIM_KEY), undefined, "nothing was claimed");
  }
});

test("neither variable set is a silent unset", async () => {
  const { runtime } = fileRuntime(new MemoryUsers());
  const out = capture();
  assert.equal((await bootstrapAdmin(runtime, {}, out.log)).outcome, "unset");
  assert.equal(out.lines.length, 0);
});

test("the password never appears in any log line, result, or refusal reason", async () => {
  const scenarios: Array<{ runtime: BootstrapRuntime; env: NodeJS.ProcessEnv }> = [
    // happy path
    { runtime: fileRuntime(new MemoryUsers()).runtime, env: BOTH },
    // one-variable refusals (both directions)
    { runtime: fileRuntime(new MemoryUsers()).runtime, env: { SHIP_BOOTSTRAP_ADMIN_USER: "tyler" } },
    { runtime: fileRuntime(new MemoryUsers()).runtime, env: { SHIP_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD } },
    // a too-short password and a reserved username: error paths with messages
    {
      runtime: fileRuntime(new MemoryUsers()).runtime,
      env: { SHIP_BOOTSTRAP_ADMIN_USER: "tyler", SHIP_BOOTSTRAP_ADMIN_PASSWORD: "short" },
    },
    {
      runtime: fileRuntime(new MemoryUsers()).runtime,
      env: { SHIP_BOOTSTRAP_ADMIN_USER: "token", SHIP_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD },
    },
    // a create failure mid-bootstrap
    ...((): Array<{ runtime: BootstrapRuntime; env: NodeJS.ProcessEnv }> => {
      const users = new MemoryUsers();
      users.failNextCreate = new Error("store unavailable mid-write");
      return [{ runtime: fileRuntime(users).runtime, env: BOTH }];
    })(),
  ];
  for (const { runtime, env } of scenarios) {
    const out = capture();
    const result = await bootstrapAdmin(runtime, env, out.log);
    const everything = [...out.lines, result.reason ?? "", result.username ?? ""].join("\n");
    assert.ok(!everything.includes(PASSWORD), `password leaked in: ${everything}`);
    assert.ok(!everything.includes("short"), "the refused short password is not echoed either");
  }
});

test("invalid or reserved credentials are refused BEFORE any claim is taken", async () => {
  for (const env of [
    { SHIP_BOOTSTRAP_ADMIN_USER: "tyler", SHIP_BOOTSTRAP_ADMIN_PASSWORD: "short" },
    { SHIP_BOOTSTRAP_ADMIN_USER: "token", SHIP_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD },
    { SHIP_BOOTSTRAP_ADMIN_USER: "has spaces!", SHIP_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD },
    { SHIP_BOOTSTRAP_ADMIN_USER: "  ", SHIP_BOOTSTRAP_ADMIN_PASSWORD: PASSWORD },
  ] as unknown as NodeJS.ProcessEnv[]) {
    const users = new MemoryUsers();
    const { runtime, config } = fileRuntime(users);
    const result = await bootstrapAdmin(runtime, env, () => {});
    assert.equal(result.outcome, "error", `expected a refusal for ${JSON.stringify(env.SHIP_BOOTSTRAP_ADMIN_USER)}`);
    assert.equal(users.createCalls, 0);
    assert.equal(await config.get(BOOTSTRAP_ADMIN_CLAIM_KEY), undefined, "the once-ever claim is never spent on invalid input");
  }
});

// ---------------------------------------------------------------------------
// Atomicity, under each store's single-writer semantics
// ---------------------------------------------------------------------------

test("file runtime: two in-process boots race and the claim serializes them to one admin", async () => {
  const { runtime, config } = fileRuntime(new MemoryUsers());
  const results = await Promise.all([
    bootstrapAdmin(runtime, BOTH, () => {}),
    bootstrapAdmin(runtime, BOTH, () => {}),
  ]);
  const created = results.filter((r) => r.outcome === "created");
  assert.equal(created.length, 1, `exactly one boot creates; saw ${JSON.stringify(results.map((r) => r.outcome))}`);
  assert.equal((runtime.users as MemoryUsers).rows.length, 1);
  assert.equal(await config.get(BOOTSTRAP_ADMIN_CLAIM_KEY), "tyler");
});

test("nucleus runtime: two web processes on one store — the KV setNX decides, the loser creates nothing", async () => {
  const kv = sharedKv();
  // Two runtimes over one shared KV map, each with its own (empty) users view,
  // which is exactly the two-process boot race: both count zero principals.
  const a = nucleusRuntime(new MemoryUsers(), kv);
  const b = nucleusRuntime(new MemoryUsers(), kv);
  const first = await bootstrapAdmin(a, BOTH, () => {});
  const second = await bootstrapAdmin(b, BOTH, () => {});
  assert.equal(first.outcome, "created");
  assert.equal(second.outcome, "skipped-claimed", "the claim, not the count, is the boundary");
  assert.equal((b.users as MemoryUsers).createCalls, 0);
  assert.deepEqual(
    kv.setNxCalls.map((c) => c.key),
    [BOOTSTRAP_ADMIN_CLAIM_KEY, BOOTSTRAP_ADMIN_CLAIM_KEY],
    "both tried; the map is the atomicity",
  );
});

test("a failed create releases OUR claim (value-conditionally) so a retry can succeed", async () => {
  // nucleus: cdel is value-conditional — a rival's release cannot drop ours.
  const kv = sharedKv();
  const users = new MemoryUsers();
  const runtime = nucleusRuntime(users, kv);
  users.failNextCreate = new Error("store unavailable");
  const failed = await bootstrapAdmin(runtime, BOTH, () => {});
  assert.equal(failed.outcome, "error");
  assert.deepEqual(kv.cdelCalls, [{ key: BOOTSTRAP_ADMIN_CLAIM_KEY, expected: "tyler" }], "released with our own value");
  assert.equal(await bootstrapAdmin(runtime, BOTH, () => {}).then((r) => r.outcome), "created", "the retry works");

  // And a claim held by someone else is never released by our failure: the
  // bootstrap cannot win the claim (setNX loses), so it creates nothing and
  // the holder's claim survives untouched.
  const held = { ...sharedKv(), map: new Map([[BOOTSTRAP_ADMIN_CLAIM_KEY, "someone-else"]]) };
  const bystander = nucleusRuntime(new MemoryUsers(), held);
  const result = await bootstrapAdmin(bystander, BOTH, () => {});
  assert.equal(result.outcome, "skipped-claimed");
  assert.equal(held.map.get(BOOTSTRAP_ADMIN_CLAIM_KEY), "someone-else");
  assert.equal(held.cdelCalls.length, 0, "a loser never reaches for the release path");
});

test("file runtime: a failed create removes the config-store claim, and only our own", async () => {
  const users = new MemoryUsers();
  const { runtime, config } = fileRuntime(users);
  users.failNextCreate = new Error("store unavailable");
  assert.equal((await bootstrapAdmin(runtime, BOTH, () => {})).outcome, "error");
  assert.equal(await config.get(BOOTSTRAP_ADMIN_CLAIM_KEY), undefined, "claim released");
  assert.equal((await bootstrapAdmin(runtime, BOTH, () => {})).outcome, "created", "retry succeeds");
});

// ---------------------------------------------------------------------------
// Real-store interop: the bootstrap's writes round-trip through FileUserStore
// ---------------------------------------------------------------------------

test("against the real FileUserStore: the bootstrapped account logs in through verify()", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-bootstrap-"));
  try {
    const users = new FileUserStore(join(dir, "users.json"));
    const { runtime } = fileRuntime(users);
    const result = await bootstrapAdmin(runtime, BOTH, () => {});
    assert.equal(result.outcome, "created");
    const verified = await users.verify("tyler", PASSWORD);
    assert.notEqual(verified, null);
    assert.equal(verified?.role, "admin");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
