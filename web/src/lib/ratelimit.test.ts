import assert from "node:assert/strict";
import test from "node:test";

import { checkRateLimit, clearRateLimit, clientKey, resetRateLimits, withVerifySlot } from "./ratelimit.server.js";

const cfg = { limit: 3, windowMs: 60_000, lockoutMs: 120_000, maxConcurrent: 2 };

test("TS-033: a trustworthy client address is locked out after the limit", () => {
  resetRateLimits();
  const key = "ip:1.2.3.4";
  for (let i = 0; i < 3; i++) {
    assert.equal(checkRateLimit(key, 1000, cfg, true).allowed, true, `attempt ${i + 1} is allowed`);
  }
  const blocked = checkRateLimit(key, 1000, cfg, true);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 120);

  // Still locked a minute later; free once the lockout passes.
  assert.equal(checkRateLimit(key, 61_000, cfg, true).allowed, false);
  assert.equal(checkRateLimit(key, 130_000, cfg, true).allowed, true);
});

test("a username is SLOWED, never locked — locking it would be an outage button", () => {
  // OWASP's point: an aggressive lockout is itself a denial of service. Anyone
  // who knows a username could otherwise lock its owner out at will.
  resetRateLimits();
  const key = "user:admin";
  for (let i = 0; i < 3; i++) assert.equal(checkRateLimit(key, 0, cfg, false).allowed, true);

  const over = checkRateLimit(key, 0, cfg, false);
  assert.equal(over.allowed, true, "the real owner can still get in");
  assert.ok((over.delayMs ?? 0) > 0, "but every further attempt costs time");

  // The delay grows with persistence and is capped, so a flood cannot pin
  // requests open either.
  const later = checkRateLimit(key, 0, cfg, false);
  assert.ok((later.delayMs ?? 0) >= (over.delayMs ?? 0));
  for (let i = 0; i < 20; i++) checkRateLimit(key, 0, cfg, false);
  assert.ok((checkRateLimit(key, 0, cfg, false).delayMs ?? 0) <= 5000, "delay is capped");
});

test("TS-033: an unidentified client can never lock the instance out", () => {
  // No declared proxy means no per-client identity — and the answer to that is
  // NOT one shared bucket, which would let any flood log everybody out.
  resetRateLimits();
  const { key, lockable } = clientKey(new Request("https://ship.test/login"), false);
  assert.equal(lockable, false);
  for (let i = 0; i < 50; i++) {
    assert.equal(checkRateLimit(key, 0, cfg, lockable).allowed, true, "never a hard lock");
  }
  assert.ok((checkRateLimit(key, 0, cfg, lockable).delayMs ?? 0) > 0, "slowed instead");
});

test("attempts age out of the window, so slow typing is never punished", () => {
  resetRateLimits();
  const key = "ip:1.2.3.4";
  assert.equal(checkRateLimit(key, 0, cfg, true).allowed, true);
  assert.equal(checkRateLimit(key, 30_000, cfg, true).allowed, true);
  // The first two are outside the window by now.
  assert.equal(checkRateLimit(key, 120_000, cfg, true).allowed, true);
  assert.equal(checkRateLimit(key, 120_001, cfg, true).allowed, true);
});

test("a successful login clears the key", () => {
  resetRateLimits();
  const key = "ip:1.2.3.4";
  checkRateLimit(key, 0, cfg, true);
  checkRateLimit(key, 0, cfg, true);
  clearRateLimit(key);
  for (let i = 0; i < 3; i++) assert.equal(checkRateLimit(key, 0, cfg, true).allowed, true);
});

test("clients and usernames get their own budgets", () => {
  resetRateLimits();
  for (let i = 0; i < 4; i++) checkRateLimit("ip:a", 0, cfg, true);
  assert.equal(checkRateLimit("ip:a", 0, cfg, true).allowed, false);
  assert.equal(checkRateLimit("ip:b", 0, cfg, true).allowed, true, "another client is unaffected");
  assert.equal(checkRateLimit("user:other", 0, cfg, false).allowed, true, "usernames are a separate budget");
});

test("TS-033: concurrent password verifications are capped, and shedding is distinguishable", async () => {
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Fill both slots with work that does not finish.
  const held = [withVerifySlot(() => blocked.then(() => "a"), cfg), withVerifySlot(() => blocked.then(() => "b"), cfg)];
  await new Promise((r) => setImmediate(r));

  const third = await withVerifySlot(async () => "c", cfg);
  assert.equal(third.shed, true, "past the ceiling, work is refused rather than queued onto the threadpool");

  release?.();
  const done = await Promise.all(held);
  assert.deepEqual(
    done.map((d) => (d.shed ? "shed" : d.value)),
    ["a", "b"],
  );

  // Slots are returned, so normal service resumes.
  const after = await withVerifySlot(async () => "d", cfg);
  assert.equal(after.shed === false && after.value, "d");
});

test("forwarded client addresses are only believed behind a declared proxy", () => {
  const request = new Request("https://ship.test/login", { headers: { "x-forwarded-for": "9.9.9.9, 10.0.0.1" } });
  assert.deepEqual(clientKey(request, true), { key: "ip:9.9.9.9", lockable: true });
  // An undeclared proxy means the header is attacker-chosen, so it can neither
  // identify anyone nor be allowed to lock anyone out.
  assert.deepEqual(clientKey(request, false), { key: "ip:unidentified", lockable: false });
});
