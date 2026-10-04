import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeTestIntegrity, isTestFile, parseUnifiedDiff, testIntegritySummary } from "./test-integrity.js";
import type { TestIntegrityKind } from "./test-integrity.js";

// Diff builders. Lines are written with their own `+`, `-` or ` ` prefix and
// the hunk header's counts are computed, so a fixture cannot drift out of
// step with what it claims.
function edit(path: string, body: string[], opts: { newFile?: boolean } = {}): string {
  const o = body.filter((l) => l[0] === "-" || l[0] === " ").length;
  const n = body.filter((l) => l[0] === "+" || l[0] === " ").length;
  return [
    `diff --git a/${path} b/${path}`,
    ...(opts.newFile ? ["new file mode 100644"] : []),
    `--- ${opts.newFile ? "/dev/null" : `a/${path}`}`,
    `+++ b/${path}`,
    `@@ -${opts.newFile ? 0 : 10},${o} +${opts.newFile ? 1 : 10},${n} @@`,
    ...body,
    "",
  ].join("\n");
}
const remove = (path: string, lines = ["x"]): string =>
  [`diff --git a/${path} b/${path}`, "deleted file mode 100644", `--- a/${path}`, "+++ /dev/null", `@@ -1,${lines.length} +0,0 @@`, ...lines.map((l) => `-${l}`), ""].join("\n");
const rename = (from: string, to: string): string =>
  [`diff --git a/${from} b/${to}`, "similarity index 100%", `rename from ${from}`, `rename to ${to}`, ""].join("\n");
const join = (...d: string[]): string => d.join("");

const kinds = (diff: string, oraclePaths?: string[]): TestIntegrityKind[] =>
  analyzeTestIntegrity(diff, { oraclePaths }).findings.map((f) => f.kind);
const verdict = (diff: string, oraclePaths?: string[]) => analyzeTestIntegrity(diff, { oraclePaths }).verdict;

// ---------------------------------------------------------------------------
// parser

test("parseUnifiedDiff reads files, line numbers, deletes, renames and new files", () => {
  const files = parseUnifiedDiff(
    join(
      edit("src/a.ts", [" keep", "-old", "+new", "+extra"]),
      remove("src/gone.ts", ["a", "b"]),
      rename("src/x.ts", "src/y.ts"),
      edit("src/fresh.ts", ["+one", "+two"], { newFile: true }),
    ),
  );
  assert.deepEqual(files.map((f) => f.path), ["src/a.ts", "src/gone.ts", "src/y.ts", "src/fresh.ts"]);
  assert.equal(files[0]!.added, 2);
  assert.equal(files[0]!.deleted, 1);
  assert.deepEqual(files[0]!.hunks[0]!.lines.map((l) => [l.op, l.oldLine, l.newLine]), [[" ", 10, 10], ["-", 11, undefined], ["+", undefined, 11], ["+", undefined, 12]]);
  assert.equal(files[1]!.isDelete, true);
  assert.equal(files[1]!.deleted, 2);
  assert.equal(files[2]!.isRename, true);
  assert.equal(files[2]!.oldPath, "src/x.ts");
  assert.equal(files[3]!.isNew, true);
});

test("a removed line that looks like a file header stays inside its hunk", () => {
  // `-- ` removed from a SQL comment is "--- " on the wire.
  const d = "diff --git a/q.sql b/q.sql\n--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,1 @@\n--- a comment\n-select 1;\n+select 2;\n";
  const files = parseUnifiedDiff(d);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.deleted, 2);
});

test("a plain diff -u without git headers parses, and garbage yields nothing", () => {
  const files = parseUnifiedDiff("--- lib/a.py\t2020\n+++ lib/a.py\t2021\n@@ -1 +1 @@\n-x\n+y\n");
  assert.equal(files[0]!.path, "lib/a.py");
  assert.equal(files[0]!.added, 1);
  assert.deepEqual(parseUnifiedDiff("not a diff at all"), []);
  assert.equal(analyzeTestIntegrity("").verdict, "clean");
  assert.equal(analyzeTestIntegrity("").summary.filesAnalysed, 0);
});

test("isTestFile follows conventions and rejects look-alikes", () => {
  for (const p of ["src/a.test.ts", "web/x.spec.tsx", "pkg/a_test.go", "tests/test_a.py", "a/test_b.py", "src/FooTest.java", "tests/x.rs", "spec/a_spec.rb"]) assert.equal(isTestFile(p), true, p);
  for (const p of ["src/contest.ts", "src/latest.ts", "src/testing-utils.ts", "README.md", "src/attest.py"]) assert.equal(isTestFile(p), false, p);
});

// ---------------------------------------------------------------------------
// oracle

test("oracle: any touch of a declared oracle path is tampered", () => {
  const oracle = ["acceptance/**", "scripts/oracle.sh", "golden/"];
  const edited = edit("acceptance/checkout.test.ts", [" a", "-assert.equal(x, 1);", "+assert.equal(x, 1);", " b"]);
  assert.equal(verdict(edited, oracle), "tampered");
  assert.deepEqual(kinds(edited, oracle).filter((k) => k === "oracle-edit"), ["oracle-edit"]);
  assert.equal(verdict(remove("acceptance/old.test.ts"), oracle), "tampered");
  assert.equal(verdict(edit("scripts/oracle.sh", ["+echo hi"], { newFile: true }), oracle), "tampered");
  assert.equal(verdict(edit("golden/out.txt", ["-a", "+b"]), oracle), "tampered");
  // moving a file OUT of the oracle is still touching it
  assert.equal(verdict(rename("acceptance/a.ts", "src/a.ts"), oracle), "tampered");
});

test("oracle near-miss: unrelated paths, and no oracle declared, are not tampered", () => {
  const oracle = ["acceptance/**", "scripts/oracle.sh"];
  assert.equal(verdict(edit("src/acceptance.ts", ["-a", "+b"]), oracle), "clean");
  assert.equal(verdict(edit("scripts/oracle-helper.sh", ["-a", "+b"]), oracle), "clean");
  assert.equal(verdict(edit("acceptance/x.ts", ["-a", "+b"])), "clean");
  assert.equal(analyzeTestIntegrity(edit("acceptance/x.ts", ["-a", "+b"])).summary.oracleConfigured, false);
});

// ---------------------------------------------------------------------------
// skip / only / disable markers: one trigger per framework, each tampered

const skipTriggers: Array<[string, string, string]> = [
  ["jest it.skip", "src/a.test.ts", '+  it.skip("adds", () => {'],
  ["jest xit", "src/a.test.ts", '+  xit("adds", () => {'],
  ["describe.skip", "src/a.spec.js", '+describe.skip("suite", () => {'],
  ["vitest test.fixme", "src/a.test.ts", '+test.fixme("x", () => {'],
  ["node:test skip option", "src/a.test.ts", '+test("adds", { skip: true }, () => {'],
  ["node:test skip reason", "src/a.test.ts", '+test("adds", { skip: "flaky" }, () => {'],
  ["node:test t.skip", "src/a.test.ts", "+  t.skip();"],
  ["node:test skip own line", "src/a.test.ts", "+  skip: true,"],
  ["pytest skip", "tests/test_a.py", "+@pytest.mark.skip(reason='later')"],
  ["pytest xfail", "tests/test_a.py", "+@pytest.mark.xfail"],
  ["pytest.skip()", "tests/test_a.py", "+    pytest.skip('nope')"],
  ["unittest.skip", "tests/test_a.py", "+@unittest.skip('later')"],
  ["Go t.Skip", "pkg/a_test.go", '+\tt.Skip("later")'],
  ["Go t.Skipf", "pkg/a_test.go", '+\tt.Skipf("later %d", 1)'],
  ["Rust ignore", "src/lib.rs", "+#[ignore]"],
  ["Rust ignore reason", "src/lib.rs", '+#[ignore = "slow"]'],
  ["JUnit Disabled", "src/test/java/ATest.java", "+  @Disabled"],
  ["JUnit Ignore", "src/test/java/ATest.java", "+  @Ignore"],
];

for (const [name, path, line] of skipTriggers) {
  test(`skip marker triggers and is tampered: ${name}`, () => {
    const d = edit(path, [" a", line, " b"]);
    const r = analyzeTestIntegrity(d);
    assert.equal(r.findings.some((f) => f.kind === "skipped-test" && f.severity === "high" && f.line === 11), true, JSON.stringify(r.findings));
    assert.equal(r.verdict, "tampered");
  });
}

test("focus markers (.only, fit, only: true) are flagged: a convenient subset is not acceptance", () => {
  for (const [path, line] of [
    ["src/a.test.ts", '+it.only("adds", () => {'],
    ["src/a.test.ts", '+describe.only("s", () => {'],
    ["src/a.test.js", '+fit("adds", () => {'],
    ["src/a.test.ts", '+test("adds", { only: true }, () => {'],
  ] as const) {
    const r = analyzeTestIntegrity(edit(path, [" a", line, " b"]));
    assert.deepEqual(r.findings.map((f) => f.kind), ["focused-test"], line);
    assert.equal(r.verdict, "tampered");
  }
});

test("skip markers near-misses stay clean", () => {
  const clean: Array<[string, string[]]> = [
    // un-skipping is the opposite of tampering
    ["src/a.test.ts", [" a", '-  it.skip("adds", () => {', '+  it("adds", () => {', " b"]],
    // same marker line moved, not added
    ["src/a.test.ts", ['-  it.skip("a", () => {', " mid", '+  it.skip("a", () => {']],
    // explicit false
    ["src/a.test.ts", ['+test("adds", { skip: false }, () => {']],
    // a comment mentioning it
    ["src/a.test.ts", ["+  // we used to it.skip(this) here", "+// t.skip()"]],
    // a title that merely contains the word
    ["src/a.test.ts", ['+test("it does not skip anything", () => {']],
    // .skip( on an ordinary method in SOURCE, not a test path
    ["src/stream.ts", ["+  const rest = it.skip(3);", "+  items.only(2);"]],
    // pytest marks that are not skip
    ["tests/test_a.py", ["+@pytest.mark.parametrize('x', [1])", "+@pytest.mark.slow"]],
    // Go identifiers that only resemble Skip
    ["pkg/a_test.go", ["+\tif t.Skipped() {", "+\tskipped := true"]],
    // Rust attribute that is not ignore
    ["src/lib.rs", ["+#[derive(Debug)]", "+#[should_panic]"]],
    // Java annotation that is not Disabled
    ["src/test/java/ATest.java", ["+  @Test", "+  @DisplayName(\"disabled things\")"]],
    // markdown documentation of a skip
    ["docs/testing.md", ["+Use `it.skip(` sparingly.", "+@pytest.mark.skip"]],
  ];
  for (const [path, body] of clean) assert.deepEqual(kinds(edit(path, body)), [], `${path}: ${body.join(" | ")}`);
});

test("a conditional skip is suspicious, not tampered: it is a policy, not a mute", () => {
  for (const [path, body] of [
    ["pkg/a_test.go", ["+\tif testing.Short() {", '+\t\tt.Skip("short")', "+\t}"]],
    ["tests/test_a.py", ["+@pytest.mark.skipif(sys.platform == 'win32', reason='posix only')"]],
    ["src/a.test.ts", ['+test("posix", { skip: process.platform === "win32" }, () => {']],
    ["src/test/java/ATest.java", ["+  @DisabledOnOs(OS.WINDOWS)"]],
  ] as Array<[string, string[]]>) {
    const r = analyzeTestIntegrity(edit(path, body));
    assert.equal(r.findings.length, 1, `${path}: ${JSON.stringify(r.findings)}`);
    assert.equal(r.findings[0]!.confidence, "med");
    assert.equal(r.verdict, "suspicious");
  }
});

test("test.todo is low severity and only suspicious", () => {
  const r = analyzeTestIntegrity(edit("src/a.test.ts", ['+test.todo("later");']));
  assert.equal(r.findings[0]!.severity, "low");
  assert.equal(r.verdict, "suspicious");
});

// ---------------------------------------------------------------------------
// deleted tests, blocks and fixtures

test("deleting a test file is flagged; deleting non-test files or renaming a test is not", () => {
  const r = analyzeTestIntegrity(remove("src/billing.test.ts", ["a", "b", "c"]));
  assert.deepEqual(r.findings.map((f) => f.kind), ["deleted-test-file"]);
  assert.equal(r.verdict, "suspicious"); // obsolete tests exist: a person decides
  assert.deepEqual(kinds(remove("pkg/test_a.py")), ["deleted-test-file"]);
  assert.deepEqual(kinds(remove("src/legacy.ts")), []);
  assert.deepEqual(kinds(remove("docs/old.md")), []);
  assert.deepEqual(kinds(rename("src/a.test.ts", "src/b.test.ts")), []);
});

test("deleting a fixture or snapshot is flagged; deleting an ordinary asset is not", () => {
  assert.deepEqual(kinds(remove("tests/fixtures/orders.json")), ["deleted-fixture"]);
  assert.deepEqual(kinds(remove("src/__snapshots__/a.test.ts.snap")), ["deleted-fixture"]);
  assert.deepEqual(kinds(remove("pkg/testdata/in.txt")), ["deleted-fixture"]);
  assert.deepEqual(kinds(remove("public/logo.png")), []);
});

test("deleted test blocks: removed declarations beyond added ones, per language", () => {
  const triggers: Array<[string, string]> = [
    ["src/a.test.ts", '-it("adds", () => {'],
    ["src/a.test.ts", '-  test("adds", () => {'],
    ["tests/test_a.py", "-def test_adds():"],
    ["pkg/a_test.go", "-func TestAdds(t *testing.T) {"],
    ["pkg/a_test.go", '-\tt.Run("case", func(t *testing.T) {'],
    ["src/lib.rs", "-#[test]"],
    ["src/test/java/ATest.java", "-  @Test"],
  ];
  for (const [path, line] of triggers) {
    const r = analyzeTestIntegrity(edit(path, [" ctx", line, "-  body();", " end"]));
    assert.equal(r.findings.some((f) => f.kind === "deleted-test-block" && f.line === 11), true, `${path}: ${JSON.stringify(r.findings)}`);
    assert.equal(r.verdict, "suspicious");
  }
});

test("deleted test block near-misses: rename, move, and replacement stay clean", () => {
  // rename: one out, one in
  assert.deepEqual(kinds(edit("src/a.test.ts", ['-it("adds numbers", () => {', '+it("adds two numbers", () => {', " body"])), []);
  // python rename with a changed signature
  assert.deepEqual(kinds(edit("tests/test_a.py", ["-def test_add():", "+def test_add_positive(fixture):", " body"])), []);
  // moved to another hunk of the same file
  const twoHunks = [
    "diff --git a/src/a.test.ts b/src/a.test.ts", "--- a/src/a.test.ts", "+++ b/src/a.test.ts",
    "@@ -10,2 +10,0 @@", '-it("moves", () => {', "-  body", "@@ -40,1 +38,3 @@", " ctx", '+it("moves", () => {', "+  body", "",
  ].join("\n");
  assert.equal(parseUnifiedDiff(twoHunks)[0]!.hunks.length, 2);
  assert.deepEqual(kinds(twoHunks), []);
  // a non-test declaration removed from SOURCE
  assert.deepEqual(kinds(edit("src/a.ts", ["-function test(x) {", "-  return x;", "-}"])), []);
  // a removed it() that is only a comment
  assert.deepEqual(kinds(edit("src/a.test.ts", ["-// it(old)", " body"])), []);
});

// ---------------------------------------------------------------------------
// removed assertions, weakened matchers

test("removed assertion with no replacement in the hunk is flagged", () => {
  for (const [path, body] of [
    ["src/a.test.ts", [" run();", "-  assert.equal(r, 3);", " done();"]],
    ["src/a.test.ts", [" run();", "-  expect(r).toBe(3);", " done();"]],
    ["tests/test_a.py", [" r = run()", "-    assert r == 3", " done()"]],
    ["pkg/a_test.go", [" r := run()", '-\tt.Errorf("bad %d", r)', " done()"]],
  ] as Array<[string, string[]]>) {
    const r = analyzeTestIntegrity(edit(path, body));
    assert.equal(r.findings.some((f) => f.kind === "removed-assertion"), true, `${path}: ${JSON.stringify(r.findings)}`);
  }
});

test("removed assertion near-misses: replaced, extracted to a helper, tightened, or in source", () => {
  // replaced one for one
  assert.deepEqual(kinds(edit("src/a.test.ts", ["-  assert.equal(r, 3);", "+  assert.equal(r, 4);"])), []);
  // extracted to a helper that asserts
  assert.deepEqual(kinds(edit("src/a.test.ts", ["-  assert.equal(r.a, 1);", "-  assert.equal(r.b, 2);", "+  assertShape(r, { a: 1, b: 2 });", "+  assertDone(r);"])), []);
  // assertion removed from SOURCE, not a test file
  assert.deepEqual(kinds(edit("src/a.ts", ["-  assert(x > 0);"])), []);
  // a commented-out line is not an assertion
  assert.deepEqual(kinds(edit("src/a.test.ts", ["-  // assert.equal(old, 1);"])), []);
  // net-added assertions
  assert.deepEqual(kinds(edit("src/a.test.ts", ["-  assert.equal(r, 3);", "+  assert.equal(r, 3);", "+  assert.equal(r2, 4);"])), []);
});

test("weakened matchers: strong to truthy/defined, across jest, node:assert and pytest", () => {
  const cases: Array<[string, string, string]> = [
    ["src/a.test.ts", "-  expect(r).toBe(3);", "+  expect(r).toBeDefined();"],
    ["src/a.test.ts", "-  expect(r).toEqual({ a: 1 });", "+  expect(r).toBeTruthy();"],
    ["src/a.test.ts", "-  expect(r).toStrictEqual(x);", "+  expect(r).not.toBeNull();"],
    ["src/a.test.ts", "-  assert.equal(r, 3);", "+  assert.ok(r);"],
    ["src/a.test.ts", "-  assert.deepEqual(r, x);", "+  assert(r);"],
    ["tests/test_a.py", "-    assert r == 3", "+    assert r"],
    ["src/a.test.ts", "-  expect(r).toBe(false);", "+  expect(r).toBeFalsy();"],
  ];
  for (const [path, from, to] of cases) {
    const r = analyzeTestIntegrity(edit(path, [" a", from, to, " b"]));
    assert.equal(r.findings.some((f) => f.kind === "weakened-matcher"), true, `${from} -> ${to}: ${JSON.stringify(r.findings)}`);
    assert.equal(r.verdict, "suspicious");
  }
});

test("weakened matcher near-misses: tightening, equivalent rewrites, and unrelated weak lines", () => {
  const clean: Array<[string, string[]]> = [
    // tightening
    ["src/a.test.ts", ["-  expect(r).toBeDefined();", "+  expect(r).toBe(3);"]],
    ["src/a.test.ts", ["-  assert.ok(r);", "+  assert.equal(r, 3);"]],
    ["tests/test_a.py", ["-    assert r", "+    assert r == 3"]],
    // strong to equally strong
    ["src/a.test.ts", ["-  expect(r).toBe(3);", "+  expect(r).toStrictEqual(3);"]],
    // strong to an ok() that still compares
    ["src/a.test.ts", ["-  assert.equal(r, 3);", "+  assert.ok(r === 3);"]],
    // a new weak assertion ADDED while the strong one stays
    ["src/a.test.ts", ["   assert.equal(r, 3);", "+  assert.ok(extra);"]],
    // weak matcher in SOURCE
    ["src/a.ts", ["-  if (x === 3) {", "+  if (x) {"]],
  ];
  for (const [path, body] of clean) assert.deepEqual(kinds(edit(path, body)), [], `${path}: ${body.join(" | ")}`);
});

// ---------------------------------------------------------------------------
// changed expected literals

test("an expected literal edited in a test while source also changes is flagged", () => {
  const d = join(
    edit("src/price.ts", ["-  return qty * 10;", "+  return qty * 12;"]),
    edit("src/price.test.ts", [" run();", "-  assert.equal(total(2), 20);", "+  assert.equal(total(2), 24);", " done();"]),
  );
  const r = analyzeTestIntegrity(d);
  assert.deepEqual(r.findings.map((f) => f.kind), ["changed-expected-literal"]);
  assert.equal(r.findings[0]!.file, "src/price.test.ts");
  assert.match(r.findings[0]!.evidence, /src\/price\.ts/);
  assert.equal(r.verdict, "suspicious");
  // string literals too
  const s = join(
    edit("src/name.go", ["-\treturn \"a\"", "+\treturn \"b\""]),
    edit("src/name_test.go", ['-\tt.Fatalf("want %q", "a")', '+\tt.Fatalf("want %q", "b")']),
  );
  assert.deepEqual(kinds(s), ["changed-expected-literal"]);
});

test("changed literal near-misses: test-only change, source-only change, doc change, rename of a title", () => {
  const testOnly = edit("src/price.test.ts", ["-  assert.equal(total(2), 20);", "+  assert.equal(total(2), 24);"]);
  assert.deepEqual(kinds(testOnly), []);
  const srcOnly = edit("src/price.ts", ["-  return qty * 10;", "+  return qty * 12;"]);
  assert.deepEqual(kinds(srcOnly), []);
  // test changes structurally (not just a literal) alongside source
  assert.deepEqual(
    kinds(join(srcOnly, edit("src/price.test.ts", ["-  assert.equal(total(2), 20);", "+  assert.equal(totalWithTax(2), 20);"]))),
    [],
  );
  // only a doc changes beside the literal edit
  assert.deepEqual(kinds(join(edit("README.md", ["-a", "+b"]), testOnly)), []);
  // a non-assertion literal (a title) changed beside source
  assert.deepEqual(kinds(join(srcOnly, edit("src/price.test.ts", ['-test("doubles 2", () => {', '+test("doubles 3", () => {']))), []);
});

// ---------------------------------------------------------------------------
// test bypasses

test("bypass: || true and friends on a test command in package.json, CI and scripts", () => {
  const cases: Array<[string, string, "tampered" | "suspicious"]> = [
    ["package.json", '+    "test": "vitest run || true",', "tampered"],
    ["package.json", '+    "ci": "pnpm test || exit 0",', "tampered"],
    [".github/workflows/ci.yml", "+      - run: pytest -q || true", "tampered"],
    ["scripts/ci.sh", "+go test ./... ; exit 0", "tampered"],
    ["Makefile", "+\tcargo test || :", "tampered"],
    ["scripts/ci.sh", '+npm test || echo "tests failed, continuing"', "suspicious"],
  ];
  for (const [path, line, v] of cases) {
    const r = analyzeTestIntegrity(edit(path, [" a", line, " b"]));
    assert.deepEqual(r.findings.map((f) => f.kind), ["test-bypass"], `${path}: ${line}`);
    assert.equal(r.verdict, v, line);
  }
});

test("bypass: neutered package.json test script and exit-0 test scripts", () => {
  assert.equal(verdict(edit("package.json", ['-    "test": "vitest run",', '+    "test": "echo skipped",'])), "tampered");
  assert.equal(verdict(edit("package.json", ['-    "test": "vitest run",', '+    "test": "true",'])), "tampered");
  assert.deepEqual(kinds(edit("scripts/run-tests.sh", [" set -e", "+exit 0", " vitest run"])), ["test-bypass"]);
});

test("bypass: process.exit(0) and early return inside tests", () => {
  const exit = analyzeTestIntegrity(edit("src/a.test.ts", [" a", "+  process.exit(0);", " b"]));
  assert.deepEqual(exit.findings.map((f) => f.kind), ["test-bypass"]);
  assert.equal(exit.verdict, "suspicious"); // child-process fixtures legitimately exit(0)

  const bodies: Array<[string, string[]]> = [
    ["src/a.test.ts", ['   test("adds", () => {', "+    return;", "     assert.equal(add(1, 2), 3);"]],
    ["src/a.test.ts", ['   it("adds", async () => {', "+    return", "     assert.equal(await add(1, 2), 3);"]],
    ["tests/test_a.py", ["   def test_adds():", "+    return", "     assert add(1, 2) == 3"]],
    ["pkg/a_test.go", [" func TestAdds(t *testing.T) {", "+\treturn", "\tif add(1, 2) != 3 {"]],
    ["src/lib.rs", ["   #[test]", "   fn adds() {", "+    return;", "     assert_eq!(add(1, 2), 3);"]],
  ];
  for (const [path, body] of bodies) {
    const r = analyzeTestIntegrity(edit(path, body));
    assert.deepEqual(r.findings.map((f) => f.kind), ["test-bypass"], path);
    assert.equal(r.verdict, "tampered", path);
  }
});

test("bypass near-misses: unrelated || true, CLI exit(0), later or helper returns, scoped CI flags", () => {
  const clean: Array<[string, string[]]> = [
    // || true on a command that is not a test run
    ["package.json", ['+    "clean": "rm -rf dist || true",']],
    [".github/workflows/ci.yml", ["+      - run: rm -rf .cache || true"]],
    // the test command itself, unmodified, gains a flag
    ["package.json", ['+    "test": "vitest run --coverage",']],
    // process.exit(0) in source, not a test
    ["src/cli.ts", ["+  process.exit(0);"]],
    // return as a guard later in a test, not its first statement
    ["src/a.test.ts", ['   test("adds", () => {', "     const r = add(1, 2);", "+    if (!r) return;", "     assert.equal(r, 3);"]],
    ["src/a.test.ts", ["   const r = add(1, 2);", "+  return;", "   assert.equal(r, 3);"]],
    // return inside a helper declared in the test file
    ["src/a.test.ts", ["   function helper(x) {", "+    return;", "   }"]],
    // a return whose line merely moved
    ["src/a.test.ts", ['   test("adds", () => {', "-    return;", "+    return;"]],
    // exit 0 in a non-test shell script
    ["scripts/deploy.sh", ["+exit 0"]],
    // continue-on-error not near a test step
    [".github/workflows/ci.yml", ["   - name: lint", "+    continue-on-error: true"]],
    // a || true comment
    ["Makefile", ["+# pytest || true is forbidden here"]],
  ];
  for (const [path, body] of clean) assert.deepEqual(kinds(edit(path, body)), [], `${path}: ${body.join(" | ")}`);
});

test("bypass: continue-on-error right after a test step is flagged at low confidence", () => {
  const r = analyzeTestIntegrity(edit(".github/workflows/ci.yml", ["   - name: Run tests", "     run: pnpm test", "+    continue-on-error: true"]));
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0]!.kind, "test-bypass");
  assert.equal(r.findings[0]!.confidence, "low");
  assert.equal(r.verdict, "suspicious");
});

// ---------------------------------------------------------------------------
// benign diffs must stay clean

test("benign diffs stay clean", () => {
  const benign: Record<string, string> = {
    "adding new tests": edit("src/a.test.ts", [" import x;", '+test("adds negatives", () => {', "+  assert.equal(add(-1, -2), -3);", "+});"]),
    "adding a new test file": edit("src/b.test.ts", ['+test("b", () => {', "+  assert.equal(b(), 1);", "+});"], { newFile: true }),
    "renaming a test": edit("src/a.test.ts", ['-test("adds", () => {', '+test("adds two positive numbers", () => {', "   assert.equal(add(1, 2), 3);"]),
    "tightening an assertion": edit("src/a.test.ts", ["-  expect(r).toBeDefined();", "+  expect(r).toEqual({ id: 1 });"]),
    "tightening ok to equal": edit("src/a.test.ts", ["-  assert.ok(r);", "+  assert.deepEqual(r, { id: 1 });"]),
    "refactoring helpers": edit("src/a.test.ts", [
      "-function build() { return { a: 1 }; }",
      "+const build = (): Shape => ({ a: 1 });",
      "   assert.equal(build().a, 1);",
    ]),
    "renaming a test file": rename("src/a.test.ts", "src/b.test.ts"),
    "source change with new test": join(
      edit("src/a.ts", ["-  return 1;", "+  return 2;"]),
      edit("src/a.test.ts", ['+test("returns two", () => {', "+  assert.equal(a(), 2);", "+});"]),
    ),
    "docs only": edit("docs/guide.md", ["-old", "+new, mentioning it.skip( and process.exit(0)"]),
    "unskipping a test": edit("src/a.test.ts", ['-test.skip("adds", () => {', '+test("adds", () => {']),
    "deleting a non-test file": remove("src/old-helper.ts"),
    "reordering imports": edit("src/a.test.ts", ["-import b;", "-import a;", "+import a;", "+import b;"]),
    "comment-only edit in a test": edit("src/a.test.ts", ["-// old note", "+// new note, not it.skip(x)"]),
  };
  for (const [name, d] of Object.entries(benign)) {
    const r = analyzeTestIntegrity(d);
    assert.equal(r.verdict, "clean", `${name}: ${JSON.stringify(r.findings)}`);
    assert.deepEqual(r.findings, [], name);
  }
});

// ---------------------------------------------------------------------------
// verdict, ordering, summary

test("verdict ladder: clean, suspicious, tampered; oracle outranks everything", () => {
  assert.equal(verdict(edit("src/a.ts", ["-a", "+b"])), "clean");
  assert.equal(verdict(remove("src/a.test.ts")), "suspicious");
  assert.equal(verdict(edit("src/a.test.ts", ["+it.only('x', () => {"])), "tampered");
  assert.equal(verdict(edit("acceptance/a.test.ts", ["+// harmless"]), ["acceptance/**"]), "tampered");
});

test("result is deterministic and the summary counts every finding", () => {
  const d = join(
    edit("src/a.test.ts", [" a", '+it.skip("x", () => {', "-  expect(r).toBe(3);", "+  expect(r).toBeDefined();"]),
    remove("src/b.test.ts"),
  );
  const a = analyzeTestIntegrity(d, { oraclePaths: ["none/**"] });
  const b = analyzeTestIntegrity(d, { oraclePaths: ["none/**"] });
  assert.deepEqual(a, b);
  assert.equal(a.summary.total, a.findings.length);
  assert.equal(a.summary.filesAnalysed, 2);
  assert.equal(a.summary.oracleConfigured, true);
  assert.equal(Object.values(a.summary.bySeverity).reduce((x, y) => x + y, 0), a.findings.length);
  assert.equal(a.summary.byKind["skipped-test"], 1);
  assert.equal(a.summary.byKind["deleted-test-file"], 1);
  for (const f of a.findings) {
    assert.equal(typeof f.file, "string");
    assert.equal(Number.isInteger(f.line), true);
    assert.notEqual(f.evidence, "");
  }
});

test("testIntegritySummary states the heuristic limit and caps long lists", () => {
  assert.match(testIntegritySummary(analyzeTestIntegrity("")), /not proof/);
  const many = join(...Array.from({ length: 12 }, (_, i) => remove(`src/f${i}.test.ts`)));
  const text = testIntegritySummary(analyzeTestIntegrity(many));
  assert.match(text, /suspicious \(12 findings/);
  assert.match(text, /and 2 more/);
  assert.match(text, /flags rather than proves intent/);
});
