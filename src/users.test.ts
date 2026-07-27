import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileUserStore,
  hashPassword,
  verifyPassword,
  normalizeRole,
  roleAllows,
} from "./users.js";

async function freshStore(): Promise<FileUserStore> {
  const dir = await mkdtemp(join(tmpdir(), "ship-users-"));
  return new FileUserStore(join(dir, "users.json"));
}

test("roleAllows enforces admin > editor > viewer", () => {
  assert.equal(roleAllows("admin", "admin"), true);
  assert.equal(roleAllows("admin", "editor"), true);
  assert.equal(roleAllows("editor", "editor"), true);
  assert.equal(roleAllows("editor", "admin"), false);
  assert.equal(roleAllows("viewer", "editor"), false);
  assert.equal(roleAllows("viewer", "viewer"), true);
});

test("normalizeRole defaults unknown to viewer (least privilege)", () => {
  assert.equal(normalizeRole("admin"), "admin");
  assert.equal(normalizeRole("editor"), "editor");
  assert.equal(normalizeRole("root"), "viewer");
  assert.equal(normalizeRole(undefined), "viewer");
});

test("password hashing round-trips and rejects wrong password", async () => {
  const h = await hashPassword("correct horse battery");
  assert.equal(await verifyPassword("correct horse battery", h), true);
  assert.equal(await verifyPassword("wrong", h), false);
  assert.match(h, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
});

test("create + verify with role; wrong password and unknown user fail", async () => {
  const s = await freshStore();
  await s.create("jane", "hunter2pw", "editor");
  const ok = await s.verify("jane", "hunter2pw");
  assert.equal(ok?.role, "editor");
  assert.equal(await s.verify("jane", "nope"), null);
  assert.equal(await s.verify("ghost", "whatever"), null); // must not throw
});

test("create rejects duplicates, short passwords, reserved and invalid names", async () => {
  const s = await freshStore();
  await s.create("jane", "hunter2pw", "viewer");
  await assert.rejects(() => s.create("jane", "another8x", "viewer"), /already exists/);
  await assert.rejects(() => s.create("bob", "short", "viewer"), /at least 8/);
  await assert.rejects(() => s.create("token", "password8", "admin"), /reserved/);
  await assert.rejects(() => s.create("has space", "password8", "viewer"), /invalid characters/);
});

test("setRole and setPassword mutate; old password stops working", async () => {
  const s = await freshStore();
  await s.create("kate", "initial8x", "viewer");
  await s.setRole("kate", "admin");
  assert.equal((await s.get("kate"))?.role, "admin");
  await s.setPassword("kate", "rotated8x");
  assert.equal(await s.verify("kate", "rotated8x") !== null, true);
  assert.equal(await s.verify("kate", "initial8x"), null);
});

test("remove deletes and list/count reflect it", async () => {
  const s = await freshStore();
  await s.create("a", "password8", "admin");
  await s.create("b", "password8", "viewer");
  assert.equal(await s.count(), 2);
  const list = await s.list();
  assert.deepEqual(list.map((u) => u.username), ["a", "b"]); // sorted
  await s.remove("a");
  assert.equal(await s.get("a"), null);
  assert.equal(await s.count(), 1);
  await assert.rejects(() => s.remove("a"), /not found/);
});

test("verify never returns a hash to callers", async () => {
  const s = await freshStore();
  await s.create("jane", "hunter2pw", "editor");
  const view = await s.verify("jane", "hunter2pw");
  assert.equal(Object.prototype.hasOwnProperty.call(view ?? {}, "passwordHash"), false);
});
