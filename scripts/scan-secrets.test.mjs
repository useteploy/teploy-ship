// The parity half of the shared pattern set (see src/secret-patterns.ts for
// why both files exist): scan-secrets.mjs runs off a bare checkout with no
// build, so it repeats the literals — and this test fails the moment the two
// copies disagree, which is the only way the build gate and the support
// redaction gate stay the SAME gate.
import assert from "node:assert/strict";
import { test } from "node:test";

import { PATTERNS } from "./scan-secrets.mjs";
import { SECRET_PATTERNS } from "../dist/secret-patterns.js";

test("scan-secrets.mjs and src/secret-patterns.ts carry the identical pattern set", () => {
  assert.deepEqual(
    PATTERNS.map((p) => ({ name: p.name, source: p.re.source, flags: p.re.flags })),
    SECRET_PATTERNS.map((p) => ({ name: p.name, source: p.re.source, flags: p.re.flags })),
    "the script and the shared module must agree name-for-name and regex-for-regex; update both together",
  );
});

// Synthetic fixtures ONLY (documented example shapes, never real material).
test("every pattern still catches its class", () => {
  const fixtures = [
    ["private key block", "-----BEGIN RSA PRIVATE KEY-----"],
    ["AWS access key id", "key = AKIAIOSFODNN7EXAMPLE"],
    ["GitHub token", "token ghp_" + "a1".repeat(18)],
    ["Slack token", "token xoxb-" + "1234567890" + "abcdefghij"],
    ["OpenAI-style key", "key sk-" + "b2".repeat(16)],
    ["credential in a URL", "postgres://ship:supersecret@db.local:5432/ship"],
  ];
  for (const [name, line] of fixtures) {
    const pattern = PATTERNS.find((p) => p.name === name);
    assert.ok(pattern !== undefined, `pattern named ${name} exists`);
    assert.ok(pattern.re.test(line), `${name} still matches its fixture`);
  }
});
