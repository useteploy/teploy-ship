import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalExecutor } from "@neutron-build/agents";

import { extremeSuite } from "./extreme-tasks.js";

async function fresh(): Promise<LocalExecutor> {
  return new LocalExecutor({ root: await mkdtemp(join(tmpdir(), "extreme-")) });
}

function task(name: string) {
  const found = extremeSuite.find((t) => t.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
}

// Calibration: every check must PASS a correct solution and FAIL the
// seeded state (and, where interesting, a plausible-but-wrong one).

const CORRECT_CALC = `import re

def tokenize(s):
    return re.findall(r"\\d+\\.?\\d*|[-+*/()^]", s)

def evaluate(s):
    tokens = tokenize(s)
    pos = [0]

    def peek():
        return tokens[pos[0]] if pos[0] < len(tokens) else None

    def take():
        t = tokens[pos[0]]
        pos[0] += 1
        return t

    def atom():
        t = take()
        if t == "(":
            v = expr()
            take()
            return v
        return float(t)

    def power():
        if peek() == "-":
            take()
            return -power()
        v = atom()
        if peek() == "^":
            take()
            v = v ** power()
        return v

    def term():
        v = power()
        while peek() in ("*", "/"):
            op = take()
            v = v * power() if op == "*" else v / power()
        return v

    def expr():
        v = term()
        while peek() in ("+", "-"):
            op = take()
            v = v + term() if op == "-" else v + term() if False else (v + term() if op == "+" else v)
        return v

    return expr()
`;

test("expr-interpreter: correct fix passes, seeded fails, single-bug fix fails", async () => {
  const t = task("expr-interpreter");

  // seeded (both bugs) fails
  const seeded = await fresh();
  await t.setup!(seeded);
  assert.equal((await t.verify(seeded)).passed, false);

  // fully correct passes — write a known-good evaluator
  const good = await fresh();
  await t.setup!(good);
  await good.putFile(
    "calc.py",
    CORRECT_CALC.replace(
      'v = v + term() if op == "-" else v + term() if False else (v + term() if op == "+" else v)',
      'v = v + term() if op == "+" else v - term()',
    ),
  );
  const verdict = await t.verify(good);
  assert.equal(verdict.passed, true, verdict.detail);

  // fixing ONLY the associativity bug (leaving precedence broken) still fails
  const half = await fresh();
  await t.setup!(half);
  const halfFixed = CORRECT_CALC.replace(
    'v = v + term() if op == "-" else v + term() if False else (v + term() if op == "+" else v)',
    'v = v + term() if op == "+" else v - term()',
  ).replace('def power():\n        if peek() == "-":\n            take()\n            return -power()\n        v = atom()', 'def power():\n        v = atom()');
  await half.putFile("calc.py", halfFixed);
  // (this variant mishandles -2^2 → 4)
  assert.equal((await t.verify(half)).passed, false);
});

test("session-audit: correct totals pass, naive (no edge rules) fails", async () => {
  const t = task("session-audit");

  const good = await fresh();
  await t.setup!(good);
  await good.putFile("totals.txt", "alice 190\nbob 100\ncarol 80\n");
  const verdict = await t.verify(good);
  assert.equal(verdict.passed, true, verdict.detail);

  // naive: counts the ignored second login as a new session start
  const naive = await fresh();
  await t.setup!(naive);
  await naive.putFile("totals.txt", "alice 130\nbob 100\ncarol 80\n");
  assert.equal((await t.verify(naive)).passed, false);
});

test("build-order: correct Kahn+tie-break passes; wrong tie-break and missing cycle handling fail", async () => {
  const t = task("build-order");

  const good = await fresh();
  await t.setup!(good);
  await good.putFile(
    "plan.py",
    `deps = {}
for line in open("deps.txt"):
    line = line.strip()
    if not line:
        continue
    target, _, rest = line.partition(":")
    deps[target.strip()] = [d for d in rest.split() if d]
all_nodes = set(deps) | {d for ds in deps.values() for d in ds}
remaining = {n: set(deps.get(n, [])) for n in all_nodes}
order = []
while remaining:
    ready = sorted(n for n, ds in remaining.items() if not ds)
    if not ready:
        print("CYCLE")
        raise SystemExit
    n = ready[0]
    order.append(n)
    del remaining[n]
    for ds in remaining.values():
        ds.discard(n)
print("\\n".join(order))
`,
  );
  const verdict = await t.verify(good);
  assert.equal(verdict.passed, true, verdict.detail);

  // reverse-alphabetical tie-break fails
  const wrongTie = await fresh();
  await t.setup!(wrongTie);
  await wrongTie.putFile(
    "plan.py",
    `deps = {}
for line in open("deps.txt"):
    line = line.strip()
    if not line:
        continue
    target, _, rest = line.partition(":")
    deps[target.strip()] = [d for d in rest.split() if d]
all_nodes = set(deps) | {d for ds in deps.values() for d in ds}
remaining = {n: set(deps.get(n, [])) for n in all_nodes}
order = []
while remaining:
    ready = sorted((n for n, ds in remaining.items() if not ds), reverse=True)
    if not ready:
        print("CYCLE")
        raise SystemExit
    n = ready[0]
    order.append(n)
    del remaining[n]
    for ds in remaining.values():
        ds.discard(n)
print("\\n".join(order))
`,
  );
  assert.equal((await t.verify(wrongTie)).passed, false);
});

test("dedupe-refactor: behavior-preserving dedupe passes; seeded triplication fails; behavior drift fails", async () => {
  const t = task("dedupe-refactor");

  // seeded fails (three copies of the parse pattern)
  const seeded = await fresh();
  await t.setup!(seeded);
  assert.equal((await t.verify(seeded)).passed, false);

  // a proper refactor passes
  const good = await fresh();
  await t.setup!(good);
  await good.putFile(
    "report.py",
    `import sys

def parse(s):
    parts = s.split("-")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        return int(parts[0]), int(parts[1]), int(parts[2])
    return None

def cmd_age(s):
    parsed = parse(s)
    y = parsed[0] if parsed else 1970
    print(2026 - y)

def cmd_year(s):
    parsed = parse(s)
    print(parsed[0] if parsed else "ERR")

def cmd_iso(s):
    parsed = parse(s.strip())
    if parsed:
        y, m, d = parsed
        print(f"{y:04d}-{m:02d}-{d:02d}")
    else:
        print("ERR")

if __name__ == "__main__":
    cmd, date = sys.argv[1], sys.argv[2]
    {"age": cmd_age, "year": cmd_year, "iso": cmd_iso}[cmd](date)
`,
  );
  const verdict = await t.verify(good);
  assert.equal(verdict.passed, true, verdict.detail);

  // a dedupe that loses the iso strip quirk fails
  const drifted = await fresh();
  await t.setup!(drifted);
  await drifted.putFile(
    "report.py",
    `import sys

def parse(s):
    parts = s.split("-")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        return int(parts[0]), int(parts[1]), int(parts[2])
    return None

def cmd_age(s):
    parsed = parse(s)
    print(2026 - (parsed[0] if parsed else 1970))

def cmd_year(s):
    parsed = parse(s)
    print(parsed[0] if parsed else "ERR")

def cmd_iso(s):
    parsed = parse(s)
    if parsed:
        y, m, d = parsed
        print(f"{y:04d}-{m:02d}-{d:02d}")
    else:
        print("ERR")

if __name__ == "__main__":
    cmd, date = sys.argv[1], sys.argv[2]
    {"age": cmd_age, "year": cmd_year, "iso": cmd_iso}[cmd](date)
`,
  );
  assert.equal((await t.verify(drifted)).passed, false);
});
