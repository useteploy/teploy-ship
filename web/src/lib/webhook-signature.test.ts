import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

/**
 * SHIP-08: the GitHub and Forgejo receivers compared the signature's STRING
 * length before `timingSafeEqual`, which compares BYTES and throws when they
 * differ. A header of the right character count with one non-ASCII character
 * turned an unsigned request into a 500 and a stack trace in the log.
 */
process.env.TEPLOY_SHIP_STATE = mkdtempSync(join(tmpdir(), "ship-webhook-signature-"));
process.env.SHIP_STORE = "file";
process.env.SHIP_WEB_TOKEN ??= "webhook-signature-tests";
const SECRET = "webhook-signature-secret";
process.env.SHIP_WEBHOOK_SECRET = SECRET;

const github = await import("../routes/hooks/github.js");
const forgejo = await import("../routes/hooks/forgejo.js");

const BODY = JSON.stringify({ zen: "signature probe" });
const HEX = createHmac("sha256", SECRET).update(BODY).digest("hex");

const RECEIVERS = [
  { name: "github", route: github, header: "x-hub-signature-256", prefix: "sha256=", event: { "x-github-event": "ping" } },
  { name: "forgejo", route: forgejo, header: "x-gitea-signature", prefix: "", event: { "x-gitea-event": "ping" } },
  { name: "forgejo (x-forgejo-signature)", route: forgejo, header: "x-forgejo-signature", prefix: "", event: { "x-forgejo-event": "ping" } },
] as const;

function post(receiver: (typeof RECEIVERS)[number], signature: string | null): Request {
  return new Request(`https://ship.test/hooks/${receiver.name.split(" ")[0]}`, {
    method: "POST",
    body: BODY,
    headers: { "content-type": "application/json", ...receiver.event, ...(signature !== null ? { [receiver.header]: signature } : {}) },
  });
}

for (const receiver of RECEIVERS) {
  test(`${receiver.name}: a malformed signature is a 401, never a crash`, async () => {
    const malformed: Array<[string, string | null]> = [
      ["absent", null],
      ["empty", ""],
      ["wrong, right length", `${receiver.prefix}${"0".repeat(64)}`],
      // Same CHARACTER count as a real signature; each é is two UTF-8 bytes.
      ["non-ASCII, right character count", `${receiver.prefix}${"é".repeat(64)}`],
      ["one non-ASCII character in an otherwise correct signature", `${receiver.prefix}${HEX.slice(0, 63)}é`],
      ["non-ASCII, right byte count", `${receiver.prefix}${"é".repeat(32)}`],
      ["too short", `${receiver.prefix}${HEX.slice(0, 10)}`],
      ["too long", `${receiver.prefix}${HEX}00`],
    ];
    for (const [label, signature] of malformed) {
      const response = await receiver.route.action({ request: post(receiver, signature) });
      assert.equal(response.status, 401, label);
    }
  });

  test(`${receiver.name}: the correct signature is still accepted`, async () => {
    const response = await receiver.route.action({ request: post(receiver, `${receiver.prefix}${HEX}`) });
    assert.notEqual(response.status, 401);
    assert.ok(response.status < 500, `status ${response.status}`);
  });
}
