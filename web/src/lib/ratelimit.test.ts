import assert from "node:assert/strict";
import test from "node:test";

import { checkRateLimit, clearRateLimit, clientKey, resetRateLimits, withVerifySlot } from "./ratelimit.server.js";

const cfg = { limit: 3, windowMs: 60_000, lockoutMs: 120_000, maxConcurrent: 2 };

test("TS-033: repeated login attempts are locked out after the limit", () => {
  resetRateLimits();
  const key = "ip:1.2.3.4|admin";
  for (let i = 0; i < 3; i++) {
    assert.equal(checkRateLimit(key, 1000, cfg).allowed, true, `attempt ${i + 1} is allowed`);
  }
  const blocked = checkRateLimit(key, 1000, cfg);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 120);

  // Still locked a minute later; free once the lockout passes.
  assert.equal(checkRateLimit(key, 61_000, cfg).allowed, false);
  assert.equal(checkRateLimit(key, 130_000, cfg).allowed, true);
});

test("attempts age out of the window, so slow typing is never punished", () => {
  resetRateLimits();
  const key = "ip:1.2.3.4|user";
  assert.equal(checkRateLimit(key, 0, cfg).allowed, true);
  assert.equal(checkRateLimit(key, 30_000, cfg).allowed, true);
  // The first two are outside the window by now.
  assert.equal(checkRateLimit(key, 120_000, cfg).allowed, true);
  assert.equal(checkRateLimit(key, 120_001, cfg).allowed, true);
});

test("a successful login clears the key", () => {
  resetRateLimits();
  const key = "ip:1.2.3.4|ok";
  checkRateLimit(key, 0, cfg);
  checkRateLimit(key, 0, cfg);
  clearRateLimit(key);
  for (let i = 0; i < 3; i++) assert.equal(checkRateLimit(key, 0, cfg).allowed, true);
});

test("different users and clients get their own budgets", () => {
  resetRateLimits();
  for (let i = 0; i < 4; i++) checkRateLimit("ip:a|admin", 0, cfg);
  assert.equal(checkRateLimit("ip:a|admin", 0, cfg).allowed, false);
  assert.equal(checkRateLimit("ip:b|admin", 0, cfg).allowed, true, "another client is unaffected");
  assert.equal(checkRateLimit("ip:a|other", 0, cfg).allowed, true, "another username is unaffected");
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
  assert.equal(clientKey(request, true), "ip:9.9.9.9");
  assert.equal(clientKey(request, false), "ip:shared", "an undeclared proxy means the header is attacker-controlled");
});
