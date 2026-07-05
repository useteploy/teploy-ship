import assert from "node:assert/strict";
import { test } from "node:test";

import { parseArgs } from "./args.js";

test("boolean flags never consume the next token", () => {
  // --handoff eating "--store" sent approve to the wrong store in the
  // first worker E2E — every boolean flag must be declared.
  const args = parseArgs(["run-abc", "--handoff", "--store", "nucleus", "--nucleus-url", "postgres://x"]);
  assert.equal(args.flags.handoff, true);
  assert.equal(args.flags.store, "nucleus");
  assert.equal(args.flags["nucleus-url"], "postgres://x");
  assert.deepEqual(args.positional, ["run-abc"]);

  const live = parseArgs(["do it", "--durable", "--yes", "--json", "--headless", "--model", "m"]);
  assert.equal(live.flags.durable, true);
  assert.equal(live.flags.yes, true);
  assert.equal(live.flags.json, true);
  assert.equal(live.flags.headless, true);
  assert.equal(live.flags.model, "m");
  assert.deepEqual(live.positional, ["do it"]);
});
