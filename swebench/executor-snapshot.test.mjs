// Seam test for the SWE-bench patch-preservation net.
//
// Reverting withDiffSnapshots to wrap only `exec` (its state before
// 2026-08-15) makes "recovers a fix that was written then reverted" fail with
// an empty patch — the exact shape of the 12/50 empty predictions in the
// 2026-08-12 GLM run.
//
// Run: node --test swebench/

import { test } from "node:test";
import assert from "node:assert/strict";
import { withDiffSnapshots, MUTATING_METHODS } from "./executor-snapshot.mjs";

/**
 * A fake testbed: a tree that `putFile` mutates and `exec` can revert,
 * standing in for git. `diff()` is non-empty whenever the tree differs from
 * its pristine state.
 */
function fakeTestbed() {
  const tree = new Map();
  return {
    tree,
    executor: {
      async exec(cmd) {
        if (cmd.includes("checkout")) tree.clear(); // the revert
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async putFile(path, data) {
        tree.set(path, data);
      },
      async getFile(path) {
        return tree.get(path) ?? "";
      },
      async destroy() {},
    },
    diff() {
      return [...tree.entries()].map(([p, d]) => `--- ${p}\n+++ ${d}`).join("\n");
    },
  };
}

/** Mirrors the harness: keep the last non-empty diff, prefer the final tree. */
function harness(bed) {
  let lastNonEmptyDiff = "";
  let snapshots = 0;
  const executor = withDiffSnapshots(bed.executor, async () => {
    snapshots++;
    const d = bed.diff();
    if (d.trim() !== "") lastNonEmptyDiff = d;
  });
  return {
    executor,
    finalPatch: () => (bed.diff().trim() !== "" ? bed.diff() : lastNonEmptyDiff),
    snapshots: () => snapshots,
  };
}

test("recovers a fix that was written via putFile then reverted", async () => {
  const bed = fakeTestbed();
  const h = harness(bed);

  // The losing sequence: edit (putFile), then revert, with no command between.
  await h.executor.putFile("src/thing.py", "the real fix");
  await h.executor.exec("git checkout -- .");

  assert.equal(bed.diff(), "", "tree really was reverted");
  assert.notEqual(
    h.finalPatch(),
    "",
    "empty patch: the putFile edit was never snapshotted, so the fix is unrecoverable",
  );
  assert.match(h.finalPatch(), /the real fix/);
});

test("still recovers a fix written via exec then reverted", async () => {
  const bed = fakeTestbed();
  const h = harness(bed);

  await h.executor.exec("sed -i ... src/thing.py");
  bed.tree.set("src/thing.py", "shell fix"); // the exec wrote it
  await h.executor.exec("true"); // a command that snapshots the edited tree
  await h.executor.exec("git checkout -- .");

  assert.match(h.finalPatch(), /shell fix/);
});

test("prefers the final tree over an older snapshot", async () => {
  const bed = fakeTestbed();
  const h = harness(bed);

  await h.executor.putFile("a.py", "first attempt");
  await h.executor.putFile("a.py", "better attempt");

  assert.match(h.finalPatch(), /better attempt/);
  assert.doesNotMatch(h.finalPatch(), /first attempt/);
});

test("an untouched tree yields an empty patch", async () => {
  const bed = fakeTestbed();
  const h = harness(bed);

  await h.executor.exec("ls");
  await h.executor.getFile("src/thing.py");

  assert.equal(h.finalPatch(), "", "no edit was made, so there is nothing to submit");
});

test("getFile does not trigger a snapshot", async () => {
  const bed = fakeTestbed();
  const h = harness(bed);

  await h.executor.getFile("src/thing.py");

  assert.equal(h.snapshots(), 0, "read-only calls must not pay for a diff");
});

test("every mutating method on the executor is wrapped", () => {
  const calls = [];
  const base = {
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    putFile: async () => {},
    getFile: async () => "",
    destroy: async () => {},
  };
  const wrapped = withDiffSnapshots(base, async () => calls.push("snapshot"));

  // Guards against a future executor method being added without a snapshot:
  // if the interface grows a mutating method, MUTATING_METHODS must grow too.
  for (const m of MUTATING_METHODS) {
    assert.equal(typeof wrapped[m], "function", `${m} must exist on the wrapper`);
  }
  assert.deepEqual(
    MUTATING_METHODS.slice().sort(),
    ["exec", "putFile"],
    "if the executor gained a mutating method, wrap it and update this list",
  );
});
