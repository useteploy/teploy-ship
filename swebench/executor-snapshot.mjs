// Patch-preservation safety net for the SWE-bench harness.
//
// The prediction is the working-tree diff at the end of a run. An agent that
// writes a correct fix and then reverts it while thrashing would otherwise
// submit an empty patch — an automatic zero regardless of model quality. So
// the tree is snapshotted after every MUTATING action and the last non-empty
// diff is kept as a fallback.
//
// The seam this guards: the agent has TWO ways to change the tree, and they go
// through different executor methods. Shell edits go through `exec`, but the
// `edit` and `create` actions write through `putFile` (see agent.ts:380,401)
// and never touch `exec`. Wrapping only `exec` therefore samples the tree at
// command boundaries and misses any edit not followed by a command — including
// the case that matters most, where the very next action is a revert.
//
// Keep both wrapped. If a third mutating method is ever added to the executor
// interface, wrap it here too.

/**
 * Wrap an executor so every mutating call triggers `onMutate` afterwards.
 * Read-only methods (getFile) and lifecycle (destroy) pass through untouched.
 */
export function withDiffSnapshots(base, onMutate) {
  return {
    async exec(cmd, opts) {
      const result = await base.exec(cmd, opts);
      await onMutate();
      return result;
    },
    async putFile(path, data) {
      const result = await base.putFile(path, data);
      await onMutate();
      return result;
    },
    getFile: (path) => base.getFile(path),
    destroy: () => base.destroy(),
  };
}

/** The method names that must trigger a snapshot. Asserted by the test. */
export const MUTATING_METHODS = ["exec", "putFile"];
