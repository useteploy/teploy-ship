import { checkCommand } from "./eval.js";
import type { EvalTask } from "./eval.js";

/**
 * A small starter benchmark — real coding tasks with independent checks.
 * Deliberately tiny; the point is a measurable baseline that grows toward
 * a SWE-bench-class suite. Each verify runs the produced code and passes
 * only on the correct result, never on the agent's say-so.
 */
export const builtinSuite: EvalTask[] = [
  {
    name: "fizzbuzz",
    prompt:
      "Write a Python script fizzbuzz.py that prints the numbers 1 to 15, but 'Fizz' for multiples of 3, 'Buzz' for multiples of 5, and 'FizzBuzz' for multiples of both. Run it to confirm it works.",
    verify: checkCommand(
      "python3 fizzbuzz.py | tr '\\n' ',' | grep -qx '1,2,Fizz,4,Buzz,Fizz,7,8,Fizz,Buzz,11,Fizz,13,14,FizzBuzz,'",
    ),
    maxSteps: 12,
  },
  {
    name: "sum-numbers",
    prompt:
      "There is a file numbers.txt with one integer per line. Compute their sum and write just that number to a file called answer.txt.",
    setup: async (executor) => {
      await executor.putFile("numbers.txt", "3\n8\n15\n22\n1\n");
    },
    // 3+8+15+22+1 = 49; the persistent artifact answer.txt must contain it.
    verify: checkCommand("test \"$(tr -d '[:space:]' < answer.txt)\" = \"49\""),
    maxSteps: 12,
  },
  {
    name: "fix-bug",
    prompt:
      "The file mathutil.py has a function factorial(n) that returns the wrong result. Fix the bug so factorial(5) == 120, then verify. Do not change the function's name or signature.",
    setup: async (executor) => {
      // off-by-one: range(1, n) should be range(1, n+1)
      await executor.putFile(
        "mathutil.py",
        "def factorial(n):\n    result = 1\n    for i in range(1, n):\n        result *= i\n    return result\n",
      );
    },
    verify: checkCommand("python3 -c \"import mathutil; assert mathutil.factorial(5)==120; assert mathutil.factorial(0)==1; print('ok')\""),
    maxSteps: 12,
  },
];
