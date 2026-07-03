import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalExecutor } from "@neutron-build/agents";

import { builtinSuite } from "./tasks.js";

async function freshExecutor(): Promise<LocalExecutor> {
  return new LocalExecutor({ root: await mkdtemp(join(tmpdir(), "task-check-")) });
}

function task(name: string) {
  const found = builtinSuite.find((t) => t.name === name);
  assert.ok(found, `missing task ${name}`);
  return found;
}

// These validate the BENCHMARK, not the agent: a correct solution must
// pass the task's check and a wrong one must fail. A benchmark whose
// checks are broken silently corrupts every future measurement.

test("fizzbuzz: correct output passes, wrong output fails", async () => {
  const t = task("fizzbuzz");
  const good = await freshExecutor();
  await good.putFile(
    "fizzbuzz.py",
    "for i in range(1,16):\n" +
      "    if i%15==0: print('FizzBuzz')\n" +
      "    elif i%3==0: print('Fizz')\n" +
      "    elif i%5==0: print('Buzz')\n" +
      "    else: print(i)\n",
  );
  assert.equal((await t.verify(good)).passed, true);

  const bad = await freshExecutor();
  await bad.putFile("fizzbuzz.py", "for i in range(1,16): print(i)\n"); // no fizz/buzz
  assert.equal((await t.verify(bad)).passed, false);
});

test("sum-numbers: correct answer passes, wrong answer fails", async () => {
  const t = task("sum-numbers");
  const good = await freshExecutor();
  await good.putFile("answer.txt", "49\n");
  assert.equal((await t.verify(good)).passed, true);

  const bad = await freshExecutor();
  await bad.putFile("answer.txt", "50");
  assert.equal((await t.verify(bad)).passed, false);
});

test("fix-bug: the fixed function passes, the seeded bug fails", async () => {
  const t = task("fix-bug");

  const fixed = await freshExecutor();
  if (t.setup) await t.setup(fixed);
  await fixed.putFile(
    "mathutil.py",
    "def factorial(n):\n    result = 1\n    for i in range(1, n+1):\n        result *= i\n    return result\n",
  );
  assert.equal((await t.verify(fixed)).passed, true);

  // the seeded (buggy) version must FAIL — proving the task actually tests something
  const buggy = await freshExecutor();
  if (t.setup) await t.setup(buggy);
  assert.equal((await t.verify(buggy)).passed, false);
});
