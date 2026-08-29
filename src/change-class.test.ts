import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DECISION_MARKER,
  MIGRATION_PATHS,
  changeClassConfigFromEnv,
  changeClassSummary,
  classifyChange,
  defaultChangeClassConfig,
  matchesGlob,
  mergeParkSummary,
  midRunParkReasons,
  parseNumstat,
} from "./change-class.js";
import type { ChangedFile } from "./change-class.js";

const file = (path: string, added = 5, deleted = 0, isDelete = false): ChangedFile => ({ path, added, deleted, isDelete });

test("a sensitive path makes a change serious however small it is", () => {
  // A one-line edit to a migration is exactly the change that most deserves a
  // person, and no size rule will ever catch it.
  for (const path of [
    "db/migrations/0007_add_column.sql",
    "schema.sql",
    "src/lib/oauth.ts",
    "app/payments/stripe.ts",
    "teploy.yml",
    "Dockerfile",
    "Dockerfile.worker",
    "go.mod",
    "pnpm-lock.yaml",
    "internal/security/policy.go",
    ".github/workflows/release.yml",
    ".env.production",
  ]) {
    const verdict = classifyChange({ files: [file(path, 1, 0)], testsPassed: true });
    assert.equal(verdict.class, "serious", path);
    assert.match(verdict.reasons.join(" "), /sensitive path rule/, path);
  }
});

test("a deletion is serious, and the reasons name the files", () => {
  const verdict = classifyChange({ files: [file("src/old.ts", 0, 40, true), file("src/keep.ts", 2, 0)], testsPassed: true });
  assert.equal(verdict.class, "serious");
  assert.match(verdict.reasons.join(" "), /deletes 1 file \(src\/old\.ts\)/);
});

test("size makes a change serious, in either dimension", () => {
  const big = classifyChange({ files: [file("src/a.ts", 500, 0)], testsPassed: true });
  assert.equal(big.class, "serious");
  assert.match(big.reasons.join(" "), /500 changed lines, over the 400 line threshold/);

  const wide = classifyChange({
    files: Array.from({ length: 20 }, (_, i) => file(`src/f${i}.ts`, 1, 0)),
    testsPassed: true,
  });
  assert.equal(wide.class, "serious");
  assert.match(wide.reasons.join(" "), /20 files, over the 15 file threshold/);
});

test("a plan that says a DECISION is needed is serious no matter the size", () => {
  const verdict = classifyChange({
    files: [file("src/a.ts", 3, 1)],
    testsPassed: true,
    planText: `1. Read the issue.\n2. ${DECISION_MARKER} should retries be capped at 3 or 5? I am assuming 3.\n`,
  });
  assert.equal(verdict.class, "serious");
  assert.match(verdict.reasons.join(" "), /the plan says a decision is needed/);
  assert.match(verdict.reasons.join(" "), /capped at 3 or 5/, "and quotes the actual question");
});

test("EVERY serious reason is collected, not just the first", () => {
  // A person answering the park wants all of them: "touches a migration" and
  // "deletes four files" are different worries.
  const verdict = classifyChange({
    files: [file("db/migrations/1.sql", 10, 0), file("src/gone.ts", 0, 5, true), ...Array.from({ length: 20 }, (_, i) => file(`src/f${i}.ts`))],
    testsPassed: true,
  });
  assert.equal(verdict.class, "serious");
  assert.ok(verdict.reasons.length >= 3, verdict.reasons.join(" | "));
});

test("small, contained and green is trivial", () => {
  const verdict = classifyChange({
    files: [file("README.md", 2, 1), file("src/a.ts", 4, 2)],
    testsPassed: true,
  });
  assert.equal(verdict.class, "trivial");
  assert.match(verdict.reasons[0]!, /2 files, 9 changed lines, suite green/);
});

test("small but UNTESTED is normal — 'small' is not the same claim as 'safe'", () => {
  const verdict = classifyChange({ files: [file("src/a.ts", 2, 0)], testsPassed: false });
  assert.equal(verdict.class, "normal");
  assert.match(verdict.reasons.join(" "), /the suite did not pass over this change/);

  const unknown = classifyChange({ files: [file("src/a.ts", 2, 0)] });
  assert.equal(unknown.class, "normal", "no suite result is not a passing suite");
});

test("a small change that wandered outside the files the task named is not trivial", () => {
  const stayed = classifyChange({
    files: [file("src/a.ts", 3, 0)],
    testsPassed: true,
    citedPaths: ["src/a.ts"],
  });
  assert.equal(stayed.class, "trivial");

  const wandered = classifyChange({
    files: [file("src/a.ts", 3, 0), file("src/unrelated.ts", 2, 0)],
    testsPassed: true,
    citedPaths: ["src/a.ts"],
  });
  assert.equal(wandered.class, "normal");
  assert.match(wandered.reasons.join(" "), /src\/unrelated\.ts, which the task did not name/);

  // Its own tests do not count as wandering: a fix that adds a test for itself
  // is doing the right thing.
  const withTest = classifyChange({
    files: [file("src/a.ts", 3, 0), file("src/a.test.ts", 8, 0)],
    testsPassed: true,
    citedPaths: ["src/a.ts"],
  });
  assert.equal(withTest.class, "trivial");
});

test("just over the trivial line is normal, not serious", () => {
  const verdict = classifyChange({ files: [file("src/a.ts", 41, 0)], testsPassed: true });
  assert.equal(verdict.class, "normal");
  assert.match(verdict.reasons.join(" "), /41 changed lines \(trivial is at most 40\)/);
});

test("an empty change is normal, never trivial", () => {
  // Trivial is a claim ABOUT a change, and there isn't one.
  const verdict = classifyChange({ files: [], testsPassed: true });
  assert.equal(verdict.class, "normal");
});

test("matchesGlob speaks the dialect the defaults are written in", () => {
  assert.equal(matchesGlob("db/migrations/1.sql", "**/migrations/**"), true);
  assert.equal(matchesGlob("migrations/1.sql", "**/migrations/**"), true);
  assert.equal(matchesGlob("src/migrationsx/1.sql", "**/migrations/**"), false);
  assert.equal(matchesGlob("a/b/schema.sql", "**/schema.sql"), true);
  assert.equal(matchesGlob("schema.sql", "**/schema.sql"), true);
  // A pattern with no slash matches the BASENAME, which is what an operator
  // writing `*auth*` expects.
  assert.equal(matchesGlob("src/lib/oauth.ts", "**/*auth*"), true);
  assert.equal(matchesGlob("src/authz/x.ts", "**/*auth*"), false, "a directory named auth is not a file named auth");
  assert.equal(matchesGlob("Dockerfile.worker", "**/Dockerfile*"), true);
  assert.equal(matchesGlob("go.mod", "go.mod"), true);
  assert.equal(matchesGlob("web/go.mod", "go.mod"), true);
  assert.equal(matchesGlob("DOCKERFILE", "**/Dockerfile*"), true, "case-insensitive: the same worry");
  assert.equal(matchesGlob("src/a.ts", "**/*.sql"), false);
});

test("parseNumstat reads git's output, binaries included", () => {
  const files = parseNumstat("12\t3\tsrc/a.ts\n0\t7\tsrc/b.ts\n-\t-\tassets/logo.png\n\n");
  assert.deepEqual(files, [
    { path: "src/a.ts", added: 12, deleted: 3, isDelete: false },
    { path: "src/b.ts", added: 0, deleted: 7, isDelete: false },
    { path: "assets/logo.png", added: 0, deleted: 0, isDelete: false },
  ]);
  // numstat alone cannot say "deleted" — that is why durable.ts asks git
  // separately with --diff-filter=D.
  assert.equal(files.every((f) => !f.isDelete), true);
});

test("the config is overridable per deployment", () => {
  const custom = changeClassConfigFromEnv({
    SHIP_CLASS_SERIOUS_LINES: "100",
    SHIP_CLASS_SERIOUS_FILES: "5",
    SHIP_CLASS_TRIVIAL_LINES: "10",
    SHIP_CLASS_SENSITIVE_PATHS: "**/secrets/**, infra/*.tf",
  });
  assert.equal(custom.seriousLines, 100);
  assert.equal(custom.seriousFiles, 5);
  assert.equal(custom.trivialLines, 10);
  assert.deepEqual(custom.sensitivePaths, ["**/secrets/**", "infra/*.tf"]);

  const verdict = classifyChange({ files: [file("infra/main.tf", 1, 0)], testsPassed: true, config: custom });
  assert.equal(verdict.class, "serious");

  // Empty or nonsense falls back rather than disabling the gate.
  const fallback = changeClassConfigFromEnv({ SHIP_CLASS_SERIOUS_LINES: "", SHIP_CLASS_SERIOUS_FILES: "nope" });
  assert.deepEqual(fallback, defaultChangeClassConfig);
});

test("the park's summary tells a human what they are deciding", () => {
  const files = [file("db/migrations/1.sql", 30, 0)];
  const text = changeClassSummary(classifyChange({ files, testsPassed: true }), files);
  assert.match(text, /classified \*\*serious\*\*/);
  assert.match(text, /1 file, 30 changed lines/);
  assert.match(text, /sensitive path rule/);
  assert.match(text, /Approve to push it/);
  assert.match(text, /The work is not lost either way/);

  const trivial = changeClassSummary(classifyChange({ files: [file("README.md", 1, 0)], testsPassed: true }), [file("README.md", 1, 0)]);
  assert.match(trivial, /classified \*\*trivial\*\*/);
  assert.doesNotMatch(trivial, /held for a decision/, "nothing to decide");
});

// --- C1: which serious changes still park mid-run ----------------------------

test("midRunParkReasons: only deletions and schema paths hold the work before the push", () => {
  // The C1 rule, stated as data: a serious change whose reasons are empty is
  // published as a draft and asked about at the merge boundary instead.
  assert.deepEqual(midRunParkReasons([file("src/a.ts", 500, 0)]), [], "a big change is undraftable-safe: the draft contains it");

  const deletes = midRunParkReasons([file("src/gone.ts", 0, 5, true), file("src/also-gone.ts", 0, 5, true)]);
  assert.equal(deletes.length, 1);
  assert.match(deletes[0]!, /deletes src\/gone\.ts, src\/also-gone\.ts/);

  const migrates = midRunParkReasons([file("db/migrations/0007.sql", 2, 0)]);
  assert.match(migrates[0]!, /db\/migrations\/0007\.sql is a schema or migration path/);

  const both = midRunParkReasons([file("db/migrate/x.sql", 2, 0), file("src/gone.ts", 0, 5, true)]);
  assert.equal(both.length, 2, "every reason is collected, like classifyChange");
});

test("midRunParkReasons: five deletions are named, more are summarised, and the migration globs match their dialect", () => {
  const six = midRunParkReasons(Array.from({ length: 6 }, (_, i) => file(`src/g${i}.ts`, 0, 5, true)));
  assert.match(six[0]!, /, …$/, "the tail is elided, not truncated silently");

  for (const [path, glob] of [
    ["db/migrations/1.sql", "**/migrations/**"],
    ["db/migrate/1.go", "**/migrate/**"],
    ["schema.sql", "**/schema.sql"],
  ] as const) {
    assert.equal(midRunParkReasons([file(path, 1, 0)]).length, 1, `${path} parks mid-run`);
    assert.ok(MIGRATION_PATHS.includes(glob), `${glob} is a declared migration path`);
  }
  assert.deepEqual(midRunParkReasons([file("src/migrations-not/x.ts", 1, 0)]), [], "a lookalike directory does not");
});

test("every migration path is also sensitive, so a migrate-only change actually classifies serious", () => {
  // midRunParkReasons is only consulted for a serious verdict; a path that
  // parks mid-run but never classifies serious is dead config.
  for (const glob of MIGRATION_PATHS) {
    assert.ok(
      defaultChangeClassConfig.sensitivePaths.includes(glob),
      `${glob} must appear in sensitivePaths or the mid-run park can never fire`,
    );
  }
});

test("the boundary park's summary tells a human what they are deciding, conflicts included", () => {
  const files = [file("src/big.ts", 401, 0)];
  const verdict = classifyChange({ files, testsPassed: true });
  const text = mergeParkSummary(verdict, files, "http://forge/o/r/pulls/9");
  assert.match(text, /classified \*\*serious\*\*/);
  assert.match(text, /draft pull request: http:\/\/forge\/o\/r\/pulls\/9/);
  assert.match(text, /held at the merge boundary/);
  assert.match(text, /deny to close the pull request/);
  assert.doesNotMatch(text, /conflict/);

  const conflicted = mergeParkSummary(verdict, files, "http://forge/o/r/pulls/9", ["src/big.ts"]);
  assert.match(conflicted, /could not be rebased/);
  assert.match(conflicted, /- src\/big\.ts/);
  assert.match(conflicted, /approve again/);
});
