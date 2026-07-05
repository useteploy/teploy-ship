import { checkCommand } from "./eval.js";
import type { EvalTask } from "./eval.js";

/**
 * Tier 3 — the headroom tier. Built after both Sonnet (100%) and a
 * kernel+editor Haiku (100% pass@2) saturated hardSuite. These demand
 * genuine multi-step diagnosis across files, spec-compliance with edge
 * cases models reliably fumble, and state tracking — and their verifies
 * are exhaustive enough that a plausible-but-wrong solution fails.
 */
export const extremeSuite: EvalTask[] = [
  {
    // Two interacting bugs in a mini interpreter: precedence AND
    // right-associativity of exponentiation. Fixing only one still fails.
    name: "expr-interpreter",
    prompt:
      "calc.py evaluates arithmetic expressions but gives wrong answers for some inputs (run test_calc.py to see). Find and fix ALL bugs so every test passes. Do not modify test_calc.py.",
    setup: async (executor) => {
      await executor.putFile(
        "calc.py",
        `import re

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
            take()  # )
            return v
        if t == "-":
            return -atom()
        return float(t)

    def power():
        v = atom()
        # bug 1: ^ handled left-associatively (2^3^2 should be 512, not 64)
        while peek() == "^":
            take()
            v = v ** atom()
        return v

    def term():
        v = power()
        while peek() in ("*", "/"):
            op = take()
            v = v * power() if op == "*" else v / power()
        return v

    def expr():
        # bug 2: + and - bind tighter than * and / (parses term as expr)
        v = term()
        while peek() in ("+", "-"):
            op = take()
            v = v + term() if op == "+" else v - term()
        return v

    return expr()
`,
      );
      await executor.putFile(
        "test_calc.py",
        `from calc import evaluate

cases = {
    "1+2*3": 7,
    "(1+2)*3": 9,
    "2^3^2": 512,
    "2*3^2": 18,
    "-2^2": -4,
    "10-4-3": 3,
    "8/4/2": 1,
    "2+3*4^2-1": 49,
}
for expr, want in cases.items():
    got = evaluate(expr)
    assert abs(got - want) < 1e-9, f"{expr}: got {got}, want {want}"
print("all calc tests passed")
`,
      );
    },
    verify: checkCommand(
      "python3 -c \"from calc import evaluate as e; assert abs(e('2^3^2')-512)<1e-9; assert abs(e('1+2*3')-7)<1e-9; assert abs(e('2*3^2')-18)<1e-9; assert abs(e('-2^2')-(-4))<1e-9; assert abs(e('10-4-3')-3)<1e-9; assert abs(e('(2+3)*4^2/8')-10)<1e-9; print('ok')\"",
    ),
    maxSteps: 25,
  },
  {
    // Log-order state reconstruction with interleaved sessions and edge
    // rules (logout without login ignored; crash closes session at crash
    // time; concurrent sessions per user forbidden -> reject second login).
    name: "session-audit",
    prompt:
      "events.log contains 'timestamp user action' lines (actions: login, logout, crash). Compute total connected seconds per user under these rules: a login starts a session unless the user already has one open (then it is IGNORED); logout or crash closes the open session (logout/crash without an open session is IGNORED). Write the result to totals.txt, one 'user seconds' line per user, sorted by user.",
    setup: async (executor) => {
      await executor.putFile(
        "events.log",
        [
          "100 alice login",
          "150 bob login",
          "160 alice login", // ignored: already open
          "200 alice logout", // alice: 100
          "210 alice logout", // ignored
          "250 bob crash", // bob: 100
          "300 bob logout", // ignored
          "310 carol logout", // ignored
          "320 carol login",
          "400 carol crash", // carol: 80
          "410 alice login",
          "500 alice logout", // alice: +90 = 190
        ].join("\n") + "\n",
      );
    },
    verify: checkCommand(
      "test \"$(tr -s ' ' < totals.txt | sed 's/ *$//' | tr '\\n' '|')\" = \"alice 190|bob 100|carol 80|\"",
    ),
    maxSteps: 20,
  },
  {
    // Dependency-aware topological build order with cycle detection and
    // deterministic tie-breaking — the tie-break and the cycle report are
    // where plausible solutions fail.
    name: "build-order",
    prompt:
      "deps.txt lists 'target: dep1 dep2 ...' lines. Write plan.py that prints a valid build order (dependencies before dependents), one target per line, choosing ALPHABETICALLY FIRST among available targets at every step. If the graph has a cycle, print exactly 'CYCLE' and nothing else. Verify with the provided deps.txt, then also make sure your program handles a cyclic file correctly.",
    setup: async (executor) => {
      await executor.putFile(
        "deps.txt",
        // multiple roots and multiple simultaneously-ready nodes, so the
        // alphabetical tie-break is actually exercised at several steps
        "app: lib\nlib: core util\ncore:\nutil:\ncli: app\nzed:\n",
      );
    },
    verify: checkCommand(
      "test \"$(python3 plan.py | tr '\\n' '|')\" = \"core|util|lib|app|cli|zed|\" && printf 'a: b\\nb: c\\nc: a\\n' > cyc.txt && cp deps.txt deps.bak && cp cyc.txt deps.txt && test \"$(python3 plan.py | tr '\\n' '|')\" = \"CYCLE|\"; RC=$?; cp deps.bak deps.txt; exit $RC",
    ),
    maxSteps: 20,
  },
  {
    // Refactor under a compatibility constraint: dedupe three copies of
    // parsing logic into one, while byte-identical CLI behavior is
    // enforced by the check (including the odd legacy quirks).
    name: "dedupe-refactor",
    prompt:
      "report.py has the same date-parsing logic copy-pasted in three functions, each with subtle drift. Refactor to ONE shared parse function while keeping the observable output of `python3 report.py <cmd> <date>` byte-identical for all three commands (their quirks are intentional legacy behavior: `age` treats bad dates as 1970-01-01, `year` prints ERR for bad dates, `iso` strips whitespace first). Run it to verify each command still behaves exactly the same.",
    setup: async (executor) => {
      await executor.putFile(
        "report.py",
        `import sys

def cmd_age(s):
    parts = s.split("-")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
    else:
        y, m, d = 1970, 1, 1
    print(2026 - y)

def cmd_year(s):
    parts = s.split("-")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
        print(y)
    else:
        print("ERR")

def cmd_iso(s):
    s = s.strip()
    parts = s.split("-")
    if len(parts) == 3 and all(p.isdigit() for p in parts):
        y, m, d = int(parts[0]), int(parts[1]), int(parts[2])
        print(f"{y:04d}-{m:02d}-{d:02d}")
    else:
        print("ERR")

if __name__ == "__main__":
    cmd, date = sys.argv[1], sys.argv[2]
    {"age": cmd_age, "year": cmd_year, "iso": cmd_iso}[cmd](date)
`,
      );
    },
    verify: checkCommand(
      "test \"$(python3 report.py age 2000-1-2)\" = \"26\" && test \"$(python3 report.py age garbage)\" = \"56\" && test \"$(python3 report.py year 1999-12-31)\" = \"1999\" && test \"$(python3 report.py year nope)\" = \"ERR\" && test \"$(python3 report.py iso ' 2026-7-5 ')\" = \"2026-07-05\" && test \"$(python3 report.py iso ' bad ')\" = \"ERR\" && test $(grep -c 'def ' report.py) -le 5 && test $(grep -c 'all(p.isdigit()' report.py) -le 1",
    ),
    maxSteps: 25,
  },
];
