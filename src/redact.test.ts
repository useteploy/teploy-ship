import assert from "node:assert/strict";
import { test } from "node:test";

import { clamp, redact, redactKnownValues, safeForDisplay, scrub } from "./redact.js";

test("TS-061: credentials embedded in URLs are stripped", () => {
  assert.equal(
    redact("cloning https://ghp_abcdefghijklmnopqrstuvwxyz012345@github.com/o/r.git"),
    "cloning https://***@github.com/o/r.git",
  );
  assert.equal(
    redact("postgres://nucleus:hunter2@ship-nucleus:5432/nucleus"),
    "postgres://***:***@ship-nucleus:5432/nucleus",
  );
});

test("provider token shapes are redacted wherever they appear", () => {
  const text = [
    "token=ghp_abcdefghijklmnopqrstuvwxyz012345",
    "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789",
    "slack: xoxb-1234567890-abcdefghij",
    "aws AKIAIOSFODNN7EXAMPLE",
  ].join("\n");
  const out = redact(text);
  assert.doesNotMatch(out, /ghp_abcdefghijklmnop/);
  assert.doesNotMatch(out, /sk-abcdefghijklmnop/);
  assert.doesNotMatch(out, /xoxb-1234567890/);
  assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/);
});

test("authorization headers and assignments are redacted, shape preserved", () => {
  assert.match(redact("Authorization: Bearer abcdefghijklmnop"), /Authorization: Bearer \[redacted\]/);
  assert.match(redact('DATABASE_PASSWORD="s3cr3t-value"'), /DATABASE_PASSWORD="\[redacted\]"/);
  assert.match(redact('{"api_key": "abcdef123456"}'), /"api_key": "\[redacted\]"/);
});

test("a private key block is replaced by the fact of it", () => {
  const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nmore\n-----END RSA PRIVATE KEY-----";
  assert.equal(redact(key), "[redacted RSA private key]");
});

test("TS-061: the process's own secret values are redacted by exact match", () => {
  // Pattern matching cannot recognise an arbitrary deploy token — but the
  // process knows its own, and any occurrence of that exact string is it.
  const env = { SHIP_GIT_TOKEN: "a-perfectly-ordinary-looking-string", PATH: "/usr/bin" };
  const out = redactKnownValues("git clone failed for a-perfectly-ordinary-looking-string", env);
  assert.equal(out, "git clone failed for [redacted SHIP_GIT_TOKEN]");

  // Non-secret variables are left alone, and short values are skipped so a
  // two-character secret cannot rewrite half the text.
  assert.equal(redactKnownValues("look in /usr/bin", env), "look in /usr/bin");
  assert.equal(redactKnownValues("abc", { TOKEN: "abc" }), "abc");
});

test("ordinary output is untouched", () => {
  const normal = "3 tests passed in 1.2s\n  at src/index.ts:14";
  assert.equal(scrub(normal, {}), normal);
});

test("large blobs are clamped from both ends", () => {
  const big = "a".repeat(50_000);
  const out = clamp(big, 1000);
  assert.ok(out.length < 1200);
  assert.match(out, /characters omitted/);
  assert.equal(clamp("short", 1000), "short");
});

test("safeForDisplay scrubs before it clamps", () => {
  const text = `${"x".repeat(500)} ghp_abcdefghijklmnopqrstuvwxyz012345 ${"y".repeat(500)}`;
  const out = safeForDisplay(text, 2000, {});
  assert.doesNotMatch(out, /ghp_abcdefghijklmnop/);
});
