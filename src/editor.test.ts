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
  assert.deepEqual(action, { kind: "edit", file: "src/x.py", search: "return x - 1\n", replace: "return x + 1\n" });
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
    file: "math.py",
    search: "    return x * 3\n",
    replace: "    return x * 2\n",
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

  const none = await executeAction(executor, { kind: "edit", file: "dup.txt", search: "missing text", replace: "x" });
  assert.equal(none.exitCode, 1);
  assert.match(none.stderr, /not found/);

  const many = await executeAction(executor, { kind: "edit", file: "dup.txt", search: "line\n", replace: "x\n" });
  assert.equal(many.exitCode, 1);
  assert.match(many.stderr, /appears 2 times/);
});

test("editing a missing file points to create", async () => {
  const executor = await workspace();
  const result = await executeAction(executor, { kind: "edit", file: "ghost.py", search: "a", replace: "b" });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /no such file.*create/i);
});
