import assert from "node:assert/strict";
import { test } from "node:test";

import { ArgError, COMMAND_FLAGS, enumFlag, numberFlag, parseArgs } from "./args.js";

test("parseArgs: boolean flags, value flags, positionals", () => {
  const parsed = parseArgs(["do the thing", "--durable", "--model", "anthropic/x", "--yes", "--max-steps", "5"], COMMAND_FLAGS.run);
  assert.deepEqual(parsed.positional, ["do the thing"]);
  assert.equal(parsed.flags.durable, true);
  assert.equal(parsed.flags.yes, true);
  assert.equal(parsed.flags.model, "anthropic/x");
  assert.equal(parsed.flags["max-steps"], "5");
});

test("TS-040: an unknown flag is an error, not a silently different run", () => {
  assert.throws(() => parseArgs(["t", "--modle", "x"], COMMAND_FLAGS.run), ArgError);
  // The suggestion makes the typo obvious rather than making the user diff docs.
  assert.throws(
    () => parseArgs(["t", "--modle", "x"], COMMAND_FLAGS.run),
    /unknown flag --modle.*Did you mean --model/s,
  );
  // A flag valid for another command is still refused here.
  assert.throws(() => parseArgs(["t", "--repo", "https://x/y/z"], COMMAND_FLAGS.run), /unknown flag --repo/);
});

test("TS-040: a value flag does not swallow the next flag", () => {
  // This used to set model to "--json" and drop --json entirely.
  assert.throws(() => parseArgs(["t", "--model", "--json"], COMMAND_FLAGS.run), /--model needs a value/);
  assert.throws(() => parseArgs(["t", "--model"], COMMAND_FLAGS.run), /--model needs a value/);
});

test("--name=value and -- are supported", () => {
  const parsed = parseArgs(["--model=anthropic/x", "--", "--not-a-flag", "tail"], COMMAND_FLAGS.run);
  assert.equal(parsed.flags.model, "anthropic/x");
  assert.deepEqual(parsed.positional, ["--not-a-flag", "tail"], "everything after -- is an argument");
});

test("a boolean flag rejects a value, and duplicates are refused", () => {
  assert.throws(() => parseArgs(["--yes=1"], COMMAND_FLAGS.run), /--yes takes no value/);
  assert.throws(() => parseArgs(["--model", "a", "--model", "b"], COMMAND_FLAGS.run), /given more than once/);
});

test("TS-040: numeric flags are range-checked, not merely finite", () => {
  assert.equal(numberFlag("5", "interval", 1, { min: 1 }), 5);
  assert.equal(numberFlag(undefined, "interval", 7, { min: 1 }), 7, "absent uses the fallback");

  // A negative interval becomes an immediate timer in Node, which busy-loops
  // against the store. "It parsed as a number" was never the constraint.
  assert.throws(() => numberFlag("-5", "interval", 1, { min: 1 }), /at least 1/);
  assert.throws(() => numberFlag("0", "max-concurrent", 3, { min: 1 }), /at least 1/);
  assert.throws(() => numberFlag("1.5", "max-steps", 20, { integer: true }), /whole number/);
  assert.throws(() => numberFlag("banana", "repeats", 1), /must be a number/);
  assert.throws(() => numberFlag("100000", "max-steps", 20, { max: 500 }), /at most 500/);
});

test("enum flags validate instead of casting", () => {
  assert.equal(enumFlag("egress", "sandbox-network", ["none", "egress"] as const, "none"), "egress");
  assert.equal(enumFlag(undefined, "sandbox-network", ["none", "egress"] as const, "none"), "none");
  assert.throws(
    () => enumFlag("bridge", "sandbox-network", ["none", "egress"] as const, "none"),
    /must be one of none \| egress/,
  );
});

test("every command in the usage table has a schema", () => {
  for (const command of ["run", "runs", "explain", "enqueue", "audit", "resume", "approve", "deny", "cancel", "inbox", "fix", "worker", "web", "eval"]) {
    assert.ok(COMMAND_FLAGS[command] !== undefined, `${command} needs a flag schema`);
  }
});
