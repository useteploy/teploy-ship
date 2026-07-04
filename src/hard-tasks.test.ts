import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalExecutor } from "@neutron-build/agents";
import type { AgentExecutor } from "@neutron-build/agents";

import { hardSuite } from "./hard-tasks.js";

async function fresh(): Promise<LocalExecutor> {
  return new LocalExecutor({ root: await mkdtemp(join(tmpdir(), "hard-check-")) });
}

function task(name: string) {
  const found = hardSuite.find((t) => t.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
}

async function withSetup(name: string, then: (e: AgentExecutor) => Promise<void>): Promise<LocalExecutor> {
  const e = await fresh();
  const t = task(name);
  if (t.setup) await t.setup(e);
  await then(e);
  return e;
}

// Each hard task's check must PASS a correct solution and FAIL the seeded
// (buggy/absent) state — otherwise it can't measure anything.

test("multi-file-bug: fixed shapes.py passes, seeded bug fails", async () => {
  const fixed = await withSetup("multi-file-bug", async (e) => {
    await e.putFile("geometry/shapes.py", "import math\n\n\nclass Circle:\n    def __init__(self, r):\n        self.r = r\n\n    def area(self):\n        return math.pi * self.r ** 2\n");
  });
  assert.equal((await task("multi-file-bug").verify(fixed)).passed, true);

  const buggy = await fresh();
  await task("multi-file-bug").setup!(buggy);
  assert.equal((await task("multi-file-bug").verify(buggy)).passed, false);
});

test("roman-from-tests: correct impl passes, missing module fails", async () => {
  const ok = await withSetup("roman-from-tests", async (e) => {
    await e.putFile(
      "roman.py",
      "def roman_to_int(s):\n    vals = {'I':1,'V':5,'X':10,'L':50,'C':100,'D':500,'M':1000}\n    total = 0\n    prev = 0\n    for ch in reversed(s):\n        v = vals[ch]\n        total += -v if v < prev else v\n        prev = v\n    return total\n",
    );
  });
  assert.equal((await task("roman-from-tests").verify(ok)).passed, true);

  // a naive additive version fails the subtraction cases (IV, IX, ...)
  const naive = await withSetup("roman-from-tests", async (e) => {
    await e.putFile("roman.py", "def roman_to_int(s):\n    vals = {'I':1,'V':5,'X':10,'L':50,'C':100,'D':500,'M':1000}\n    return sum(vals[c] for c in s)\n");
  });
  assert.equal((await task("roman-from-tests").verify(naive)).passed, false);

  const missing = await fresh();
  await task("roman-from-tests").setup!(missing);
  assert.equal((await task("roman-from-tests").verify(missing)).passed, false);
});

test("csv-quoted: correct field passes, naive comma-split fails", async () => {
  const t = task("csv-quoted");
  const good = await fresh();
  await good.putFile("out.txt", "a, b, c\n");
  assert.equal((await t.verify(good)).passed, true);

  const naive = await fresh();
  await naive.putFile("out.txt", "a\n"); // what a naive split(',')[1] yields... roughly
  assert.equal((await t.verify(naive)).passed, false);
});

test("balanced-brackets: correct impl passes, naive counter fails", async () => {
  const ok = await fresh();
  await ok.putFile(
    "brackets.py",
    "def is_balanced(s):\n    pairs = {')':'(',']':'[','}':'{'}\n    stack = []\n    for c in s:\n        if c in '([{':\n            stack.append(c)\n        elif c in ')]}':\n            if not stack or stack.pop() != pairs[c]:\n                return False\n    return not stack\n",
  );
  assert.equal((await task("balanced-brackets").verify(ok)).passed, true);

  const naive = await fresh();
  await naive.putFile(
    "brackets.py",
    "def is_balanced(s):\n    return s.count('(')==s.count(')') and s.count('[')==s.count(']') and s.count('{')==s.count('}')\n",
  );
  assert.equal((await task("balanced-brackets").verify(naive)).passed, false); // ([)] slips through
});

test("config-mismatch: reconciled config passes, seeded crash fails", async () => {
  const fixed = await withSetup("config-mismatch", async (e) => {
    await e.putFile("process.py", "import json\n\nwith open('config.json') as f:\n    config = json.load(f)\n\nprint(config['timeout_ms'] / 1000)\n");
  });
  assert.equal((await task("config-mismatch").verify(fixed)).passed, true);

  const broken = await fresh();
  await task("config-mismatch").setup!(broken);
  assert.equal((await task("config-mismatch").verify(broken)).passed, false);
});

test("chunk-off-by-one: fixed passes, seeded bug fails", async () => {
  const fixed = await withSetup("chunk-off-by-one", async (e) => {
    await e.putFile("chunk.py", "def chunk(xs, n):\n    return [xs[i:i+n] for i in range(0, len(xs), n)]\n");
  });
  assert.equal((await task("chunk-off-by-one").verify(fixed)).passed, true);

  const buggy = await fresh();
  await task("chunk-off-by-one").setup!(buggy);
  assert.equal((await task("chunk-off-by-one").verify(buggy)).passed, false);
});
