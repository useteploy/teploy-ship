import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  UNKNOWN_ACTOR,
  actorFromMeta,
  actorFromPrincipal,
  cliActor,
  formatActor,
  intakeActor,
  isAttributable,
} from "./actor.js";
import { MIGRATIONS } from "./migrations.js";
import { RUN_META_FIELDS } from "./run-store.js";
import { DOC_FIELDS } from "./nucleus-pgwire.js";

test("an unknown actor is not attributable and a named one is", () => {
  assert.equal(isAttributable(UNKNOWN_ACTOR), false);
  assert.equal(isAttributable(undefined), false);
  assert.equal(isAttributable({ id: "alice", kind: "user" }), true);
  assert.equal(isAttributable({ id: "ci:bot", kind: "intake" }), true);
});

test("a principal keeps its STABLE id, not its display name", () => {
  // The whole point of reusing Principal's rule: an SSO identity is issuer#sub.
  // Keying on the display name would follow whoever holds the handle today.
  const actor = actorFromPrincipal({ user: "https://idp#sub-42", display: "Alice" });
  assert.equal(actor.id, "https://idp#sub-42");
  assert.equal(actor.display, "Alice");
  assert.equal(actor.kind, "user");
});

test("an empty or absent principal is the unknown actor, never a blank name", () => {
  assert.deepEqual(actorFromPrincipal(null), UNKNOWN_ACTOR);
  assert.deepEqual(actorFromPrincipal(undefined), UNKNOWN_ACTOR);
  assert.deepEqual(actorFromPrincipal({ user: "" }), UNKNOWN_ACTOR);
});

test("a CLI actor is user@host, because two `deploy` users on two boxes are two people", () => {
  const actor = cliActor();
  assert.equal(actor.kind, "cli");
  assert.match(actor.id, /.+@.+/);
});

test("an intake actor is namespaced by source and blank handles do not become names", () => {
  assert.equal(intakeActor("octocat", "github").id, "github:octocat");
  assert.equal(intakeActor("octocat", "github").kind, "intake");
  assert.deepEqual(intakeActor(undefined, "github"), UNKNOWN_ACTOR);
  assert.deepEqual(intakeActor("   ", "github"), UNKNOWN_ACTOR);
});

test("actorFromMeta rejects a kind it does not recognise rather than trusting the column", () => {
  // The column is a TEXT field in a store an operator can write to by hand.
  assert.equal(actorFromMeta({ actor: "a", actorKind: "user" }).kind, "user");
  assert.equal(actorFromMeta({ actor: "a", actorKind: "root" }).kind, "unknown");
  assert.deepEqual(actorFromMeta({}), UNKNOWN_ACTOR);
});

test("formatActor shows the id when there is nothing extra to say", () => {
  assert.equal(formatActor({ id: "alice", kind: "cli" }), "alice");
  assert.equal(formatActor({ id: "alice", display: "alice", kind: "cli" }), "alice");
  assert.equal(formatActor({ id: "idp#42", display: "Alice", kind: "user" }), "Alice (idp#42)");
});

// ── The seam ─────────────────────────────────────────────────────────────

/**
 * A field on RunMeta must reach the database, and three separate hand-written
 * lists decide whether it does. `source` was added to the interface alone once
 * and took down every write that carried it (migration 001). The compiler
 * catches RUN_META_FIELDS falling behind; nothing catches the column map or the
 * migration, so this does.
 */
test("SEAM: actor reaches the Nucleus column map and has a migration", () => {
  for (const field of ["actor", "actorKind"]) {
    assert.ok(
      RUN_META_FIELDS.includes(field as never),
      `${field} is missing from RUN_META_FIELDS — it will not persist`,
    );
    assert.ok(
      DOC_FIELDS.includes(field),
      `${field} is missing from the Nucleus COLUMNS map — column() THROWS on it and every write carrying it fails`,
    );
  }
  const ids = MIGRATIONS.map((m) => m.id);
  assert.ok(
    ids.includes("004-ship-docs-actor"),
    "no migration adds actor/actor_kind — an existing deployment cannot write a run at all",
  );
  assert.ok(
    ids.includes("005-ship-tasks-requested-by"),
    "no migration adds requested_by — an existing deployment cannot file an intake task",
  );
});

/**
 * Every migration must probe WRITE-shaped. Nucleus resolves an unknown column
 * in a projection to NULL rather than erroring, so a `SELECT` probe reports the
 * column present, `needed()` returns false, and migrate() records the migration
 * as applied without running it — leaving the schema wrong, the log saying it is
 * fine, and the ledger blocking the fixed build from ever retrying.
 *
 * This asserts the property for the whole list rather than for 004 and 005, so
 * migration 006 cannot reintroduce it either.
 */
test("SEAM: no migration probes for a column with SELECT", async () => {
  const source = await readFile(new URL("../src/migrations.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("const docsSourceColumn"));
  assert.doesNotMatch(
    body,
    /SELECT\s+[a-z_]+\s+FROM\s+\$\{?table/i,
    "a migration probes a column with SELECT — Nucleus answers that with NULL, so the probe always reports the column present",
  );
  assert.match(
    source,
    /UPDATE \$\{table\} SET \$\{assignments\} WHERE 1 = 0/,
    "hasColumns is no longer a write-shaped probe",
  );
});

/**
 * All four enqueue surfaces must name an actor.
 *
 * Deliberately a source-text assertion and not an end-to-end run: the failure
 * this guards against is one call site being missed while the other three work,
 * which every end-to-end test would still pass. This is the house failure mode
 * — "correct on both ends, unwired in between" — and four hand-edited call
 * sites across two packages is exactly its shape.
 */
test("SEAM: every enqueueRun call site passes an actor", async () => {
  const sites: Array<[string, number]> = [
    ["../src/cli.ts", 1],
    ["../src/worker.ts", 1],
    ["../web/src/routes/index.tsx", 2],
  ];
  for (const [rel, expected] of sites) {
    const source = await readFile(new URL(rel, import.meta.url), "utf8");
    const calls = source.split("enqueueRun(").slice(1);
    assert.equal(
      calls.length,
      expected,
      `${rel} has ${calls.length} enqueueRun call(s), expected ${expected} — a new enqueue surface must also pass an actor, so update this list deliberately`,
    );
    for (const [i, call] of calls.entries()) {
      // The options object ends at the call's closing "});" — enough to scope
      // the search to this call rather than the whole file.
      const body = call.slice(0, call.indexOf("});"));
      assert.match(
        body,
        /\bactor:/,
        `${rel} enqueueRun call #${i + 1} does not pass an actor — that run will be unattributable`,
      );
    }
  }
});

/** Both approval surfaces must record who decided. */
test("SEAM: every approval delivery records a granter", async () => {
  const sites = ["../src/cli.ts", "../web/src/routes/index.tsx", "../web/src/routes/runs/[id].tsx"];
  for (const rel of sites) {
    const source = await readFile(new URL(rel, import.meta.url), "utf8");
    const calls = source.split("deliverEvent(").slice(1);
    assert.ok(calls.length > 0, `${rel} no longer delivers approval events`);
    for (const [i, call] of calls.entries()) {
      const body = call.slice(0, call.indexOf("});"));
      assert.match(
        body,
        /\bby:/,
        `${rel} deliverEvent call #${i + 1} records no granter — the approval cannot be attributed`,
      );
    }
  }
});
