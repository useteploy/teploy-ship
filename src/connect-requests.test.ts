import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONNECT_REQUEST_COLUMNS,
  CONNECT_REQUEST_TTL_MS,
  FileConnectRequests,
  MemoryConnectRequests,
  NucleusConnectRequests,
  approveUrl,
  challengeFor,
  describeWorkspace,
  newRequestId,
  newVerifier,
  sameWorkspace,
  validDeliveryCode,
  workspaceIdentity,
} from "./connect-requests.js";
import type { ConnectRequest, ConnectRequestStore } from "./connect-requests.js";
import { NucleusPgwire } from "./nucleus-pgwire.js";
import type { PoolLike, QueryResultLike } from "./nucleus-pgwire.js";

const AKIROO = "https://lite.akiroo.com";
const SHIP = "https://ship.tailnet.internal";

function pending(overrides: Partial<ConnectRequest> = {}): ConnectRequest {
  return {
    requestId: "req-1",
    verifier: "verifier-1",
    akirooUrl: AKIROO,
    expiresAt: new Date(Date.now() + CONNECT_REQUEST_TTL_MS).toISOString(),
    usedAt: "",
    ...overrides,
  };
}

async function stores(): Promise<Array<{ name: string; store: ConnectRequestStore }>> {
  const dir = await mkdtemp(join(tmpdir(), "ship-connect-"));
  return [
    { name: "memory", store: new MemoryConnectRequests() },
    { name: "file", store: new FileConnectRequests(dir) },
  ];
}

test("a request this Ship started can be claimed once, and never twice", async () => {
  for (const { name, store } of await stores()) {
    await store.create(pending());
    const first = await store.claim("req-1");
    assert.ok(first.ok, name);
    assert.equal(first.request.verifier, "verifier-1", name);

    // Single-use is the whole point: the browser leg is replayable — history,
    // a back button, a link someone kept — and a second replay must not produce
    // a second exchange against a workspace that approved one.
    const second = await store.claim("req-1");
    assert.ok(!second.ok, name);
    assert.equal(second.failure, "already-used", name);
  }
});

test("a claim erases the verifier it hands out, so a spent row holds no secret", async () => {
  // A connected Ship starts no further handshakes, so nothing ever calls
  // create() again, so the expiry prune never runs and the spent row sat there
  // with a live-looking verifier in it indefinitely. The row itself must stay —
  // it is what makes a second return read "already completed" rather than "this
  // Ship did not start that connect" — but the secret in it must not.
  for (const { name, store } of await stores()) {
    await store.create(pending());
    const won = await store.claim("req-1");
    assert.ok(won.ok, name);
    assert.equal(won.request.verifier, "verifier-1", `${name}: the winner still gets it`);

    const again = await store.claim("req-1");
    assert.ok(!again.ok, name);
    assert.equal(again.failure, "already-used", `${name}: the row survives, so the answer is still specific`);
  }

  // And it is gone from the medium, not merely absent from the return value.
  const dir = await mkdtemp(join(tmpdir(), "ship-connect-"));
  const disk = new FileConnectRequests(dir);
  await disk.create(pending());
  await disk.claim("req-1");
  const raw = await readFile(join(dir, "connect-requests.json"), "utf8");
  assert.ok(raw.includes("req-1"), "the row is still there");
  assert.ok(!raw.includes("verifier-1"), "the verifier is not");
});

test("a request this Ship never started is refused — the control that closes the phish", async () => {
  for (const { name, store } of await stores()) {
    // Nothing was created. This is exactly the case where someone mails an
    // admin a /connect/return link: there is no local row, so no exchange is
    // attempted and no credential is requested.
    const outcome = await store.claim("req-someone-elses");
    assert.ok(!outcome.ok, name);
    assert.equal(outcome.failure, "unknown", name);
  }
});

test("an aged request is refused rather than honoured late", async () => {
  for (const { name, store } of await stores()) {
    await store.create(pending({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    const outcome = await store.claim("req-1");
    assert.ok(!outcome.ok, name);
    assert.equal(outcome.failure, "expired", name);
  }
});

test("the file store keeps requests across process boundaries and prunes dead ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ship-connect-"));
  await new FileConnectRequests(dir).create(pending({ requestId: "old", expiresAt: new Date(Date.now() - 1000).toISOString() }));
  await new FileConnectRequests(dir).create(pending({ requestId: "live" }));

  // A different instance, standing in for the next request that the web process
  // serves: the live request survives...
  assert.ok((await new FileConnectRequests(dir).claim("live")).ok);
  // ...and the expired one was dropped on the next write rather than left on
  // disk holding a verifier nobody will ever use.
  assert.equal((await new FileConnectRequests(dir).claim("old")).ok, false);
});

test("the challenge is a hash of the verifier, and the two are not interchangeable", () => {
  const verifier = newVerifier();
  assert.equal(challengeFor(verifier), challengeFor(verifier), "both sides derive it independently");
  assert.notEqual(challengeFor(verifier), verifier);
  assert.notEqual(challengeFor(verifier), challengeFor(newVerifier()));
  assert.match(challengeFor(verifier), /^[A-Za-z0-9_-]+$/, "base64url, so it survives a query string intact");
});

test("request ids and verifiers are random and are not each other", () => {
  assert.notEqual(newRequestId(), newRequestId());
  assert.notEqual(newVerifier(), newVerifier());
  // The verifier is the secret half and is sized for it; the request id only
  // has to not collide.
  assert.ok(Buffer.from(newVerifier(), "base64url").length >= 32);
  assert.ok(Buffer.from(newRequestId(), "base64url").length >= 16);
});

test("the approve URL carries the challenge and CANNOT carry the verifier", () => {
  const verifier = newVerifier();
  const url = approveUrl({ akirooUrl: `${AKIROO}/`, requestId: "req-1", challenge: challengeFor(verifier), shipUrl: SHIP });
  assert.ok(url !== null);
  const parsed = new URL(url);
  assert.equal(parsed.origin, AKIROO);
  assert.equal(parsed.pathname, "/connect/approve");
  assert.equal(parsed.searchParams.get("request"), "req-1");
  assert.equal(parsed.searchParams.get("challenge"), challengeFor(verifier));
  assert.equal(parsed.searchParams.get("ship"), SHIP);
  // The property the whole flow rests on. approveUrl takes no verifier
  // parameter, so this cannot regress by an edit that "just adds one more
  // field" — it would have to change the signature.
  assert.ok(!url.includes(verifier));
});

test("the approve link keeps the path prefix, so every leg addresses one workspace", () => {
  // The approve link used to be built from the ORIGIN while the exchange and
  // the outbox poll kept the full base, so a path-prefixed Akiroo was
  // approved at one URL and polled at another. It is the same representation
  // now — origin plus prefix, trailing slash gone.
  const url = approveUrl({ akirooUrl: `${AKIROO}/akiroo/`, requestId: "req-1", challenge: "c", shipUrl: SHIP });
  assert.ok(url !== null);
  assert.equal(new URL(url).pathname, "/akiroo/connect/approve");
  assert.equal(workspaceIdentity(`${AKIROO}/akiroo/`), `${AKIROO}/akiroo`);
  assert.equal(workspaceIdentity(`${AKIROO}/`), AKIROO);
  assert.equal(workspaceIdentity("javascript:alert(1)"), null);
});

test("an address that is not a plain http(s) workspace produces no approve URL at all", () => {
  for (const bad of ["javascript:alert(1)", "https://user:pw@lite.akiroo.com", "not a url", ""]) {
    assert.equal(approveUrl({ akirooUrl: bad, requestId: "r", challenge: "c", shipUrl: SHIP }), null, bad);
  }
});

test("the return leg compares FULL workspace addresses, prefix included", () => {
  // Only a trailing slash is decoration. A different path prefix is a
  // different installation as far as every other leg is concerned — it is
  // where the exchange POSTs and where the poll reads — so forgiving it here
  // would be this side agreeing with an address the rest of the code does not
  // use.
  assert.ok(sameWorkspace(AKIROO, `${AKIROO}/`));
  assert.ok(sameWorkspace(`${AKIROO}/akiroo`, `${AKIROO}/akiroo/`));
  assert.ok(!sameWorkspace(AKIROO, `${AKIROO}/tenant/a`));
  assert.ok(!sameWorkspace(`${AKIROO}/tenant/a`, `${AKIROO}/tenant/b`));
  assert.ok(!sameWorkspace(AKIROO, "https://evil.example"));
  assert.ok(!sameWorkspace(AKIROO, "http://lite.akiroo.com"), "scheme is part of the identity");
  assert.ok(!sameWorkspace(AKIROO, "https://user:pw@lite.akiroo.com"));
  // An absent parameter is a refusal at the call site, and it is a mismatch
  // here too — there is no spelling of "nothing" that names this workspace.
  assert.ok(!sameWorkspace(AKIROO, ""));
});

test("a refusal can name the address that arrived without letting it run the page", () => {
  assert.equal(describeWorkspace(`${AKIROO}/`), AKIROO);
  assert.equal(describeWorkspace(""), "no workspace at all", "the refusal has to read as a sentence");
  assert.equal(describeWorkspace("   "), "no workspace at all");
  // Not a URL, so it is passed through — cleaned of anything that could break
  // out of a line of prose, and bounded.
  assert.equal(describeWorkspace("not a url\nLocation: x"), "not a url Location: x");
  assert.ok(describeWorkspace("https://a.example/".padEnd(400, "z")).length <= 123);
});

test("a delivery code is required to look like one before it is sent anywhere", () => {
  // 32 bytes base64url. The shape check is not the security control — Akiroo's
  // atomic claim is — but it keeps a query string full of junk from being
  // forwarded to the workspace as though it were an approval.
  assert.ok(validDeliveryCode(Buffer.from(new Uint8Array(32).fill(7)).toString("base64url")));
  assert.ok(!validDeliveryCode(""), "absent is not valid");
  assert.ok(!validDeliveryCode("short"));
  assert.ok(!validDeliveryCode("a".repeat(129)));
  assert.ok(!validDeliveryCode("has spaces in it and is long enough"));
  assert.ok(!validDeliveryCode("contains/slash+plus=padding=========="), "base64url only");
});

// --- the production store ----------------------------------------------------

/**
 * A pgwire pool that answers the five statements NucleusConnectRequests issues,
 * with NUCLEUS's semantics rather than Postgres's — wrapped in the REAL
 * NucleusPgwire, so the adapter's `rowCount ?? 0` mapping is on the path under
 * test rather than assumed by a hand-written db fake.
 *
 * SHIP_STORE=nucleus is what a deployed Ship runs, and this store's single-use
 * claim is the control the whole turned-around connect flow rests on. It had no
 * test of any kind; the memory and file stores below it were the only ones
 * exercised, and neither of them can express the thing that matters here, which
 * is that the claim is decided by the WRITE and not by the read before it.
 *
 * What this fake encodes, and how far each part is verified — per the house
 * rule that a mock encoding an external system's semantics is itself a claim:
 *
 *   - unknown TABLE raises; unknown COLUMN in a SELECT projection resolves to
 *     NULL rather than raising; unknown COLUMN in an UPDATE assignment DOES
 *     raise. Verified against a live Nucleus on 2026-08-04 and reproduced in
 *     migrations.test.ts, which exists because a SELECT-shaped probe made three
 *     migrations declare themselves unnecessary.
 *   - an UPDATE reports the number of rows it actually wrote, and reports ZERO
 *     as `UPDATE 0` rather than as a bare tag. Read out of the engine source on
 *     2026-08-27: nucleus/src/wire/mod.rs:882 lists UPDATE among the tags that
 *     carry a count, and nucleus/src/executor/dml.rs:2084 is the read-modify-
 *     write retry — a row a concurrent session moved OUT OF THE PREDICATE
 *     "drops out of the statement rather than being resurrected", so the loser
 *     of a race on `used_at = ''` is not counted. That is exactly the behaviour
 *     the claim below needs, and it is a source read, not a live probe.
 */
function nucleusPool(options: { countUpdates?: boolean; existing?: { cols: string[]; rows: Record<string, unknown>[] } } = {}) {
  const countUpdates = options.countUpdates ?? true;
  const tables = new Map<string, { cols: string[]; rows: Record<string, unknown>[] }>();
  if (options.existing !== undefined) tables.set("ship_connect_requests", options.existing);
  const sql: string[] = [];

  const table = (name: string) => {
    const found = tables.get(name);
    if (found === undefined) throw new Error(`relation "${name}" does not exist`);
    return found;
  };

  /** `col = $n` / `col < $n` joined by AND. A column the table lacks reads as NULL, so it matches nothing. */
  const where = (t: { cols: string[] }, clause: string, params: unknown[]) => (row: Record<string, unknown>): boolean =>
    clause.split(/\s+AND\s+/i).every((term) => {
      const m = /^(\w+) (=|<) \$(\d+)$/.exec(term.trim());
      if (m === null) throw new Error(`fake pool cannot parse predicate: ${term}`);
      if (!t.cols.includes(m[1]!)) return false;
      const have = row[m[1]!];
      const want = params[Number(m[3]) - 1];
      return m[2] === "=" ? have === want : String(have) < String(want);
    });

  const run = (text: string, params: unknown[]): QueryResultLike => {
    const statement = text.replace(/\s+/g, " ").trim();
    sql.push(statement);

    const create = /^CREATE TABLE IF NOT EXISTS (\w+) \((.+)\)$/i.exec(statement);
    if (create !== null) {
      // IF NOT EXISTS is a no-op on a table that is already there — which is the
      // deployed-box case migration 007 exists for, and why `existing` above can
      // seed a shape the DDL would not produce.
      if (!tables.has(create[1]!)) {
        tables.set(create[1]!, { cols: [...create[2]!.matchAll(/(\w+) TEXT/g)].map((m) => m[1]!), rows: [] });
      }
      // DDL tags carry no count on the wire ("CREATE TABLE", never "CREATE
      // TABLE 0"); a null rowCount is what node-postgres makes of that.
      return { rows: [], rowCount: null };
    }

    const insert = /^INSERT INTO (\w+) \(([\w, ]+)\) VALUES \(([$\d, ]+)\)$/i.exec(statement);
    if (insert !== null) {
      const t = table(insert[1]!);
      const cols = insert[2]!.split(",").map((c) => c.trim());
      for (const col of cols) {
        if (!t.cols.includes(col)) throw new Error(`column "${col}" of relation "${insert[1]}" does not exist`);
      }
      t.rows.push(Object.fromEntries(cols.map((c, i) => [c, params[i]])));
      return { rows: [], rowCount: 1 };
    }

    const del = /^DELETE FROM (\w+) WHERE (.+)$/i.exec(statement);
    if (del !== null) {
      const t = table(del[1]!);
      const doomed = where(t, del[2]!, params);
      const before = t.rows.length;
      t.rows = t.rows.filter((r) => !doomed(r));
      return { rows: [], rowCount: before - t.rows.length };
    }

    const update = /^UPDATE (\w+) SET (.+?) WHERE (.+)$/i.exec(statement);
    if (update !== null) {
      const t = table(update[1]!);
      const sets = [...update[2]!.matchAll(/(\w+) = \$(\d+)/g)];
      // Strict on the assignment side. This is the half that raises on Nucleus,
      // and the half migration 007 is written against.
      for (const s of sets) {
        if (!t.cols.includes(s[1]!)) throw new Error(`column "${s[1]}" of relation "${update[1]}" does not exist`);
      }
      const hit = t.rows.filter(where(t, update[3]!, params));
      for (const row of hit) for (const s of sets) row[s[1]!] = params[Number(s[2]) - 1];
      return { rows: [], rowCount: countUpdates ? hit.length : null };
    }

    const select = /^SELECT ([\w, ]+) FROM (\w+) WHERE (.+)$/i.exec(statement);
    if (select !== null) {
      const t = table(select[2]!);
      const cols = select[1]!.split(",").map((c) => c.trim());
      const hit = t.rows.filter(where(t, select[3]!, params));
      // Lenient on the projection: a column the table lacks comes back NULL.
      const rows = hit.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])));
      return { rows, rowCount: rows.length };
    }

    throw new Error(`fake pool cannot parse: ${statement}`);
  };

  const pool: PoolLike = {
    async query(text, params = []) {
      return run(text, params);
    },
    async connect() {
      throw new Error("this pool does not fail transiently, so no retry should have been attempted");
    },
    on() {
      return undefined;
    },
    async end() {},
  };
  return {
    store: new NucleusConnectRequests(new NucleusPgwire("postgres://fake", "connect-requests-test", { pool })),
    rows: () => tables.get("ship_connect_requests")?.rows ?? [],
    cols: () => tables.get("ship_connect_requests")?.cols ?? [],
    sql,
  };
}

test("the Nucleus store owns its own table, and its columns are the ones migration 007 probes", async () => {
  const nucleus = nucleusPool();
  await nucleus.store.create(pending());
  assert.deepEqual(nucleus.cols(), CONNECT_REQUEST_COLUMNS, "the DDL and the migration's probe list are one definition");

  const joined = nucleus.sql.join("\n");
  // A NEW table, per the house rule: Nucleus cannot ALTER-ADD a column to a
  // populated one, and every table a deployed Ship already has is populated.
  assert.match(joined, /CREATE TABLE IF NOT EXISTS ship_connect_requests/);
  assert.doesNotMatch(joined, /ALTER TABLE/i);
});

test("the Nucleus store claims a handshake once, and the second return loses on the row count", async () => {
  const nucleus = nucleusPool();
  await nucleus.store.create(pending());

  const first = await nucleus.store.claim("req-1");
  assert.ok(first.ok);
  assert.equal(first.request.verifier, "verifier-1");
  assert.equal(first.request.akirooUrl, AKIROO, "the row it won, not a row it invented");

  const second = await nucleus.store.claim("req-1");
  assert.ok(!second.ok);
  assert.equal(second.failure, "already-used");

  // The decision is the WRITE. A store that read the row, judged it live and
  // then wrote unconditionally would pass both assertions above under a single
  // caller and hand out two exchanges under two — so the filter is what is
  // pinned here, not the outcome.
  const claim = nucleus.sql.find((s) => s.startsWith("UPDATE ship_connect_requests"));
  assert.ok(claim !== undefined, "the claim must be an UPDATE, not a read followed by a write");
  assert.match(claim, /WHERE request_id = \$\d+ AND used_at = \$\d+/, "unspent is part of the filter, not of a prior read");
});

/**
 * The property the reversal rests on, stated as the race it exists for: a
 * browser leg is replayable — history, a back button, two tabs — and two
 * returns arriving together must produce ONE exchange against a workspace that
 * approved one. Both callers read the row as live before either writes, which
 * is precisely the window a read-then-write store gets wrong.
 */
test("two returns racing the Nucleus store produce one exchange and one refusal", async () => {
  const nucleus = nucleusPool();
  await nucleus.store.create(pending());

  const [a, b] = await Promise.all([nucleus.store.claim("req-1"), nucleus.store.claim("req-1")]);
  assert.equal([a, b].filter((o) => o.ok).length, 1, "exactly one winner");
  const loser = [a, b].find((o) => !o.ok);
  assert.equal(loser?.ok === false ? loser.failure : "", "already-used");
});

/**
 * The rowCount contract, named because nothing else pins it. `exec` maps an
 * absent count to 0 (nucleus-pgwire.ts:150) and the claim treats 0 as "someone
 * else won" — so a wire that stopped reporting counts on UPDATE would make
 * every connect refuse, which is loud and safe. The failure worth preventing is
 * the other direction: a claim that treated an unknown count as a win would
 * hand the verifier to every returner.
 */
test("the single-use claim rests on the row count: an UPDATE reporting none refuses rather than grants", async () => {
  const nucleus = nucleusPool({ countUpdates: false });
  await nucleus.store.create(pending());
  const outcome = await nucleus.store.claim("req-1");
  assert.ok(!outcome.ok, "no count means no proof this caller won, and no proof is a refusal");
  assert.equal(outcome.failure, "already-used");
});

test("the Nucleus claim erases the verifier in the row, not merely from the answer it returns", async () => {
  const nucleus = nucleusPool();
  await nucleus.store.create(pending());
  const won = await nucleus.store.claim("req-1");
  assert.ok(won.ok);
  assert.equal(won.request.verifier, "verifier-1", "the winner is still handed the secret it won");

  // A connected Ship starts no further handshakes, so create() — and with it
  // the expiry prune — never runs again. The spent row must therefore not be
  // the thing left holding a live-looking verifier forever.
  assert.deepEqual(
    nucleus.rows().map((r) => [r.request_id, r.verifier]),
    [["req-1", ""]],
    "the row survives so a second return still reads 'already completed'; the secret in it does not",
  );
});

test("a request the Nucleus store never recorded is unknown, and nothing is written for it", async () => {
  const nucleus = nucleusPool();
  await nucleus.store.create(pending());
  const outcome = await nucleus.store.claim("someone-elses-request");
  assert.ok(!outcome.ok);
  assert.equal(outcome.failure, "unknown", "the answer that tells an operator the link did not come from here");
  assert.equal(nucleus.rows()[0]?.used_at, "", "the real handshake was left alone");
});

test("an aged Nucleus row is burned by the claim and still refused", async () => {
  const nucleus = nucleusPool();
  await nucleus.store.create(pending({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
  const outcome = await nucleus.store.claim("req-1");
  assert.ok(!outcome.ok);
  assert.equal(outcome.failure, "expired");
  // Expiry is judged AFTER the claim on purpose: an aged row still holds a
  // verifier, and spending it is how that verifier stops being redeemable.
  assert.notEqual(nucleus.rows()[0]?.used_at, "", "the aged row was spent, not left live");
  assert.equal(nucleus.rows()[0]?.verifier, "");
});

test("the Nucleus store prunes expired handshakes when the next connect is started", async () => {
  const nucleus = nucleusPool();
  await nucleus.store.create(pending({ requestId: "old", expiresAt: new Date(Date.now() - 1000).toISOString() }));
  await nucleus.store.create(pending({ requestId: "live" }));
  assert.deepEqual(nucleus.rows().map((r) => r.request_id), ["live"], "a dead row still holds a verifier");
});

/**
 * Why migration 007 is written at all. On a deployment whose table predates a
 * column, Nucleus answers the SELECT of it with NULL — so the store reads back
 * an empty verifier with no error at all — and it is the UPDATE assignment that
 * raises. Failing loud there is the correct end: the alternative is a connect
 * that posts an empty verifier to Akiroo and reports the workspace's refusal as
 * the operator's mistake.
 */
test("a Nucleus table behind the DDL fails loud on the write, because the read of it cannot fail", async () => {
  const behind = nucleusPool({
    existing: {
      cols: ["request_id", "akiroo_url", "expires_at", "used_at"],
      rows: [{ request_id: "req-1", akiroo_url: AKIROO, expires_at: new Date(Date.now() + 60_000).toISOString(), used_at: "" }],
    },
  });
  await assert.rejects(behind.store.claim("req-1"), /column "verifier"/, "the write is the half that raises");
});

test("a row holding no verifier is unknown, not an exchange with an empty secret", async () => {
  const nucleus = nucleusPool({
    existing: {
      cols: CONNECT_REQUEST_COLUMNS,
      rows: [{ request_id: "req-1", verifier: "", akiroo_url: AKIROO, expires_at: new Date(Date.now() + 60_000).toISOString(), used_at: "" }],
    },
  });
  const outcome = await nucleus.store.claim("req-1");
  assert.ok(!outcome.ok, "there is nothing here to redeem, so there is no handshake here");
  assert.equal(outcome.failure, "unknown");
});
