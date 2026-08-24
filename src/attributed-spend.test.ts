import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileAttributedSpendStore, attributionsFrom } from "./attributed-spend.js";
import { repoKeyOf } from "./durable.js";

const T0 = "2026-08-24T12:00:00.000Z";

// Amounts chosen to be exact in binary (0.25 + 0.5 = 0.75) so the accumulate
// assertion checks arithmetic, not float tolerance.
test("file store: adds accumulate per bucket, kinds and days stay independent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-attributed-"));
  const store = new FileAttributedSpendStore(dir);
  await store.add("repo", "git.example.com/tyler/teploy-ship", "2026-08-24", 0.25);
  await store.add("repo", "git.example.com/tyler/teploy-ship", "2026-08-24", 0.5);
  await store.add("repo", "git.example.com/tyler/teploy-ship", "2026-08-23", 0.125); // another day
  await store.add("actor", "github:tyler", "2026-08-24", 0.75); // another kind, same-looking spend
  await store.add("repo", "git.example.com/tyler/teploy-ship", "2026-08-24", 0); // zero is a no-op

  const entries = (await store.list()).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.day < b.day ? -1 : 1));
  assert.deepEqual(entries, [
    { kind: "repo", key: "git.example.com/tyler/teploy-ship", day: "2026-08-23", amountUSD: 0.125 },
    { kind: "repo", key: "git.example.com/tyler/teploy-ship", day: "2026-08-24", amountUSD: 0.75 },
    { kind: "actor", key: "github:tyler", day: "2026-08-24", amountUSD: 0.75 },
  ]);
});

test("file store: survives restart — a second store instance reads the same buckets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-attributed-"));
  await new FileAttributedSpendStore(dir).add("repo", "git.example.com/tyler/a", "2026-08-24", 0.25);
  const reopened = new FileAttributedSpendStore(dir);
  await reopened.add("repo", "git.example.com/tyler/a", "2026-08-24", 0.5);
  assert.deepEqual(await reopened.list(), [
    { kind: "repo", key: "git.example.com/tyler/a", day: "2026-08-24", amountUSD: 0.75 },
  ]);
});

test("file store: a damaged file throws rather than reading back empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-attributed-"));
  await writeFile(join(dir, "attributed-spend.json"), "{not json", "utf8");
  const store = new FileAttributedSpendStore(dir);
  await assert.rejects(() => store.list(), "silent zeros would read as nobody spent anything");
});

function runStarted(repo?: string): { type: string; data: unknown } {
  return { type: "run-started", data: { input: { task: "t", ...(repo !== undefined ? { repo } : {}) } } };
}

test("attributionsFrom: https URLs (with and without .git) land on the repoKeyOf key", () => {
  const https = attributionsFrom(null, [runStarted("https://git.example.com/tyler/teploy-ship.git")]);
  const bare = attributionsFrom(null, [runStarted("https://git.example.com/tyler/teploy-ship")]);
  assert.equal(https.repo, repoKeyOf("https://git.example.com/tyler/teploy-ship.git"));
  assert.equal(bare.repo, https.repo, "clone-URL spelling must not split one repo into two buckets");
  assert.equal(https.actor, undefined, "null meta omits the actor field");
});

test("attributionsFrom: an scp-style ssh URL is omitted, not thrown — repoKeyOf only parses http/https/file", () => {
  // The spec assumed ssh normalises to the same key; that is repoSlug's job,
  // not repoKeyOf's (scp-form is not a URL and new URL() throws on it). Using
  // repoKeyOf verbatim per the spec, the honest total behaviour is: no key,
  // no repo row — and the run-started input on the product path is always
  // http(s) anyway, because repo-setup's parseRepoUrl already refused
  // anything else before the run could spend anything.
  const out = attributionsFrom({ actor: "a" }, [runStarted("git@git.example.com:tyler/teploy-ship")]);
  assert.equal("repo" in out, false);
  assert.equal(out.actor, "a");
});

test("attributionsFrom: no repo on the run-started input means no repo field", () => {
  const out = attributionsFrom({ actor: "tyler@deploy-test" }, [runStarted()]);
  assert.equal("repo" in out, false);
  assert.equal(out.actor, "tyler@deploy-test", "the actor id passes through verbatim");
});

test("attributionsFrom: a missing or empty actor is omitted, never recorded as a bucket", () => {
  const empty = attributionsFrom({ actor: "" }, [runStarted("https://git.example.com/tyler/a")]);
  assert.equal(empty.actor, undefined);
  const absent = attributionsFrom({}, [runStarted("https://git.example.com/tyler/a")]);
  assert.equal(absent.actor, undefined);
  assert.equal(absent.repo, repoKeyOf("https://git.example.com/tyler/a"), "the repo dimension still lands");
});

test("attributionsFrom: no run-started event at all yields neither field", () => {
  assert.deepEqual(attributionsFrom({ actor: "u" }, [{ type: "step-completed", data: { result: true } }]), {
    actor: "u",
  });
});
