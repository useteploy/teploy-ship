import { checkCommand } from "./eval.js";
import type { EvalTask } from "./eval.js";

/**
 * The discriminating tier — genuinely harder, self-contained coding
 * tasks. Each `verify` independently asserts the required behavior on the
 * produced artifact (never by re-running a seeded test the agent could
 * have edited), so it can't be gamed. Designed to sit below 100% so
 * prompt/recovery/action changes show up as a moving number.
 *
 * Verifies use `python3 -c '...'` with double-quoted Python strings so
 * they nest cleanly under `sh -c`.
 */
export const hardSuite: EvalTask[] = [
  {
    // Multi-file diagnosis: the failing check is about total_area (utils.py)
    // but the bug is in Circle.area (shapes.py). Requires tracing across files.
    name: "multi-file-bug",
    prompt:
      "Running `python3 check_geometry.py` fails with a wrong-total-area assertion. Find and fix the bug so it passes. The bug is not necessarily where the error surfaces — trace it.",
    setup: async (executor) => {
      await executor.putFile("geometry/__init__.py", "");
      await executor.putFile(
        "geometry/shapes.py",
        "import math\n\n\nclass Circle:\n    def __init__(self, r):\n        self.r = r\n\n    def area(self):\n        return math.pi * self.r  # bug: should use r squared\n",
      );
      await executor.putFile(
        "geometry/utils.py",
        "def total_area(shapes):\n    return sum(s.area() for s in shapes)\n",
      );
      await executor.putFile(
        "check_geometry.py",
        "import math\nfrom geometry.shapes import Circle\nfrom geometry.utils import total_area\n\nexpected = math.pi * 1 + math.pi * 4\nassert abs(total_area([Circle(1), Circle(2)]) - expected) < 1e-9, 'wrong total area'\nprint('ok')\n",
      );
    },
    verify: checkCommand(
      "python3 -c 'from geometry.shapes import Circle; from geometry.utils import total_area; import math; assert abs(Circle(3).area() - math.pi*9) < 1e-9; assert abs(total_area([Circle(1), Circle(2)]) - math.pi*5) < 1e-9; print(\"ok\")'",
    ),
    maxSteps: 15,
  },
  {
    // Read a spec expressed as tests, then implement — including the
    // subtraction rule (IV=4) a naive additive solution gets wrong.
    name: "roman-from-tests",
    prompt:
      "test_roman.py imports roman_to_int from a module `roman` that does not exist yet. Read the tests to learn the required behavior, create roman.py implementing roman_to_int, and make `python3 test_roman.py` pass.",
    setup: async (executor) => {
      await executor.putFile(
        "test_roman.py",
        'from roman import roman_to_int as r\n\nassert r("III") == 3\nassert r("IV") == 4\nassert r("IX") == 9\nassert r("LVIII") == 58\nassert r("MCMXCIV") == 1994\nprint("all roman tests passed")\n',
      );
    },
    verify: checkCommand(
      'python3 -c \'from roman import roman_to_int as r; assert r("IV")==4; assert r("IX")==9; assert r("XL")==40; assert r("XC")==90; assert r("CD")==400; assert r("MCMXCIV")==1994; assert r("III")==3; print("ok")\'',
    ),
    maxSteps: 15,
  },
  {
    // A naive comma-split gives the wrong field; correct CSV parsing (quoted
    // field containing commas) is required.
    name: "csv-quoted",
    prompt:
      "data.csv has a header row and one data row. Extract the value of the `description` column from the data row and write exactly that value (no quotes, no trailing newline needed) to out.txt. Note the field may itself contain commas.",
    setup: async (executor) => {
      await executor.putFile("data.csv", 'id,description\n7,"a, b, c"\n');
    },
    verify: checkCommand('test "$(cat out.txt)" = "a, b, c"'),
    maxSteps: 12,
  },
  {
    // Bracket matching that a naive counter fails on: "([)]" is unbalanced.
    name: "balanced-brackets",
    prompt:
      "Create brackets.py with a function is_balanced(s) that returns True iff the brackets (), [], {} in s are correctly matched and nested (other characters ignored). Then verify it works.",
    verify: checkCommand(
      'python3 -c \'from brackets import is_balanced as b; assert b("()[]{}"); assert b("([{}])"); assert b(""); assert b("a(b)c"); assert not b("([)]"); assert not b("("); assert not b(")"); assert not b("{[}"); print("ok")\'',
    ),
    maxSteps: 12,
  },
  {
    // Diagnose a KeyError whose cause is a config key-name mismatch; fix
    // either side to make it run and print the timeout in seconds.
    name: "config-mismatch",
    prompt:
      "`python3 process.py` crashes. Diagnose the cause, fix it (code or config, whichever is sensible), and make it run and print the timeout in seconds as `5.0`.",
    setup: async (executor) => {
      await executor.putFile("config.json", '{"name": "svc", "timeout_ms": 5000, "retries": 3}\n');
      await executor.putFile(
        "process.py",
        "import json\n\nwith open('config.json') as f:\n    config = json.load(f)\n\nprint(config['timeout'] / 1000)\n",
      );
    },
    verify: checkCommand('test "$(python3 process.py)" = "5.0"'),
    maxSteps: 15,
  },
  {
    // Off-by-one bug in a seeded module that drops the final partial chunk.
    name: "chunk-off-by-one",
    prompt:
      "chunk.py has a function chunk(xs, n) that splits a list into consecutive sublists of length n (the last may be shorter). It has a bug: run `python3 test_chunk.py`, find the bug, fix it so all cases pass.",
    setup: async (executor) => {
      await executor.putFile(
        "chunk.py",
        "def chunk(xs, n):\n    result = []\n    for i in range(0, len(xs) - n, n):  # bug: drops the last chunk\n        result.append(xs[i:i + n])\n    return result\n",
      );
      await executor.putFile(
        "test_chunk.py",
        'from chunk import chunk\n\nassert chunk([1, 2, 3, 4, 5], 2) == [[1, 2], [3, 4], [5]]\nassert chunk([1, 2, 3, 4], 2) == [[1, 2], [3, 4]]\nassert chunk([], 3) == []\nprint("chunk tests passed")\n',
      );
    },
    verify: checkCommand(
      'python3 -c \'from chunk import chunk; assert chunk([1,2,3,4,5],2)==[[1,2],[3,4],[5]]; assert chunk([1,2,3],3)==[[1,2,3]]; assert chunk([1,2,3,4],3)==[[1,2,3],[4]]; assert chunk([],3)==[]; print("ok")\'',
    ),
    maxSteps: 12,
  },
];
