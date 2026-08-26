import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalExecutor } from "@neutron-build/agents";

import { executeAction } from "./agent.js";
import { parseAction } from "./actions.js";

async function workspace(): Promise<LocalExecutor> {
  return new LocalExecutor({ root: await mkdtemp(join(tmpdir(), "editor-")) });
}

const editBlock = (file: string, search: string, replace: string): string =>
  "```edit " + file + "\n<<<<<<< SEARCH\n" + search + "\n=======\n" + replace + "\n>>>>>>> REPLACE\n```";

// ---- parsing ----

test("parses edit blocks with file path and SEARCH/REPLACE", () => {
  const action = parseAction("Fixing the bug.\n" + editBlock("src/x.py", "return x - 1", "return x + 1"));
  assert.deepEqual(action, {
    kind: "edit",
    edits: [{ file: "src/x.py", search: "return x - 1\n", replace: "return x + 1\n", all: false }],
  });
});

test("parses create blocks", () => {
  const action = parseAction('```create app/new.py\nprint("hi")\n```');
  assert.deepEqual(action, { kind: "create", file: "app/new.py", content: 'print("hi")\n' });
});

test("malformed edit blocks are invalid with a corrective message", () => {
  assert.equal(parseAction("```edit src/x.py\njust some text\n```").kind, "invalid");
  assert.equal(parseAction("```edit\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n```").kind, "invalid");
  assert.equal(parseAction("```create\ncontent\n```").kind, "invalid");
});

// ---- applying ----

test("create then edit then verify — the structured editing path", async () => {
  const executor = await workspace();
  const created = await executeAction(executor, {
    kind: "create",
    file: "math.py",
    content: "def double(x):\n    return x * 3\n",
  });
  assert.equal(created.exitCode, 0);

  const edited = await executeAction(executor, {
    kind: "edit",
    edits: [{ file: "math.py", search: "    return x * 3\n", replace: "    return x * 2\n", all: false }],
  });
  assert.equal(edited.exitCode, 0);
  assert.match(edited.stdout, /1 replacement/);

  const check = await executor.exec(`python3 -c "import math_check" 2>/dev/null; python3 -c "
import importlib.util
spec = importlib.util.spec_from_file_location('m', 'math.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert m.double(5) == 10
print('verified')"`);
  assert.match(check.stdout, /verified/);
});

test("zero matches and multiple matches fail with actionable errors", async () => {
  const executor = await workspace();
  await executor.putFile("dup.txt", "line\nline\nother\n");

  const none = await executeAction(executor, { kind: "edit", edits: [{ file: "dup.txt", search: "missing text", replace: "x", all: false }] });
  assert.equal(none.exitCode, 1);
  assert.match(none.stderr, /not found/);

  const many = await executeAction(executor, { kind: "edit", edits: [{ file: "dup.txt", search: "line\n", replace: "x\n", all: false }] });
  assert.equal(many.exitCode, 1);
  assert.match(many.stderr, /appears 2 times/);
});

test("editing a missing file points to create", async () => {
  const executor = await workspace();
  const result = await executeAction(executor, { kind: "edit", edits: [{ file: "ghost.py", search: "a", replace: "b", all: false }] });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /no such file.*create/i);
});

// --- C2: applying a multi-hunk, multi-file edit ----------------------------

test("a multi-file edit applies every hunk in one action, and reports the count", async () => {
  const executor = await workspace();
  await executor.putFile("a.ts", "import { oldName } from './x.js';\noldName(1);\noldName(2);\n");
  await executor.putFile("b.ts", "oldName(3);\n");

  const result = await executeAction(executor, {
    kind: "edit",
    edits: [
      { file: "a.ts", search: "oldName", replace: "newName", all: true },
      { file: "b.ts", search: "oldName", replace: "newName", all: true },
    ],
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /edited 2 files, 4 replacements/);
  assert.match(result.stdout, /a\.ts \(3\)/);

  assert.equal(new TextDecoder().decode(await executor.getFile("a.ts")).includes("oldName"), false);
  assert.equal(new TextDecoder().decode(await executor.getFile("b.ts")), "newName(3);\n");
});

test("`all` is what makes a repeated SEARCH legal — without it, it is still an error", async () => {
  const executor = await workspace();
  await executor.putFile("dup.txt", "line\nline\nother\n");

  const strict = await executeAction(executor, { kind: "edit", edits: [{ file: "dup.txt", search: "line\n", replace: "x\n", all: false }] });
  assert.equal(strict.exitCode, 1);
  assert.match(strict.stderr, /appears 2 times/);
  assert.match(strict.stderr, /add `all` after the path/, "the error has to teach the way out");
  assert.equal(new TextDecoder().decode(await executor.getFile("dup.txt")), "line\nline\nother\n", "and change nothing");

  const loose = await executeAction(executor, { kind: "edit", edits: [{ file: "dup.txt", search: "line\n", replace: "x\n", all: true }] });
  assert.equal(loose.exitCode, 0);
  assert.match(loose.stdout, /2 replacements/);
  assert.equal(new TextDecoder().decode(await executor.getFile("dup.txt")), "x\nx\nother\n");
});

test("a multi-file edit is ATOMIC: one bad hunk writes nothing at all", async () => {
  // A rename that applied to three of five files leaves a tree that does not
  // compile, and the publish gate ships whatever tree it finds.
  const executor = await workspace();
  await executor.putFile("a.ts", "oldName(1);\n");
  await executor.putFile("b.ts", "somethingElse(2);\n");

  const result = await executeAction(executor, {
    kind: "edit",
    edits: [
      { file: "a.ts", search: "oldName", replace: "newName", all: false },
      { file: "b.ts", search: "oldName", replace: "newName", all: false },
    ],
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /hunk 2 of 2/);
  assert.match(result.stderr, /No hunk in this block was applied/);
  assert.equal(new TextDecoder().decode(await executor.getFile("a.ts")), "oldName(1);\n", "the FIRST file must be untouched");
});

test("hunks against the same file compose, each seeing the previous one's result", async () => {
  const executor = await workspace();
  await executor.putFile("a.ts", "const a = 1;\nconst b = 2;\n");
  const result = await executeAction(executor, {
    kind: "edit",
    edits: [
      { file: "a.ts", search: "const a = 1;", replace: "const a = 10;", all: false },
      { file: "a.ts", search: "const b = 2;", replace: "const b = 20;", all: false },
    ],
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(new TextDecoder().decode(await executor.getFile("a.ts")), "const a = 10;\nconst b = 20;\n");
});

test("a 25-call-site rename is ONE action — the C2 done-check", async () => {
  const executor = await workspace();
  const files = ["core.ts", "api.ts", "cli.ts", "web.ts", "test.ts"];
  for (const file of files) {
    await executor.putFile(file, Array.from({ length: 5 }, (_, i) => `oldName(${i});`).join("\n") + "\n");
  }
  const result = await executeAction(executor, {
    kind: "edit",
    edits: files.map((file) => ({ file, search: "oldName", replace: "newName", all: true })),
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /25 replacements/);
  for (const file of files) {
    assert.equal(new TextDecoder().decode(await executor.getFile(file)).includes("oldName"), false, file);
  }
});
