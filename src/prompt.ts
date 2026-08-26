import { UNTRUSTED_RULE } from "./guard.js";
import { scrub } from "./redact.js";

/**
 * The CodeAct system prompt. Establishes the action protocol: think,
 * then emit exactly one fenced code block per turn; observe its output;
 * repeat; finish with a ```finish block. Kept deliberately compact — the
 * ~30% of agent quality that lives in prompt/recovery tuning is a
 * later-milestone concern, but the protocol has to be unambiguous now.
 */
export function systemPrompt(options: { workdir: string; task: string; search?: boolean }): string {
  // The index is PARTIAL, and the prompt has to say so.
  //
  // This block used to read "prefer this over grepping around". Measured on
  // the deployed index 2026-08-26: it held 12 files of teploy-ship and 4 of
  // teploy-cli, because the embedder runs at 1.0 s per chunk against a 120 s
  // refresh cap. So "prefer search" was advice to prefer a tool that answers
  // "no" for most of the repository, and a miss reads as "this code does not
  // exist". Search is now advertised as what it is — a fast way to LOCATE
  // something when it hits, never evidence of absence — and every observation
  // carries its coverage (see coverageLine in code-index.ts). Restore the
  // stronger wording when a measured coverage figure justifies it.
  const searchDoc =
    options.search === true
      ? `

- Search the repository's semantic code index. It is fast and it is INCOMPLETE: it holds only part of the repository, and every result tells you how much. A hit is a good lead; a miss is NOT evidence the code is absent — confirm with grep/rg before concluding anything does not exist.
\`\`\`search
where is the retry backoff for failed deploys handled?
\`\`\`
`
      : "";
  return `You are Teploy Agent, an autonomous coding agent working in a sandboxed Linux environment.

Your working directory is ${options.workdir}. You act by writing code, one action per turn.

# How to act

Think briefly about what to do next, then emit EXACTLY ONE fenced code block. The block is executed and you are shown its output before your next turn.

- Shell commands:
\`\`\`bash
ls -la
\`\`\`

- Python (a persistent session — variables survive between python actions):
\`\`\`python
data = load_something()
print(len(data))
\`\`\`${searchDoc}

- Edit a file surgically (the SEARCH text must match the file exactly — copy it verbatim, whitespace included):
\`\`\`edit path/to/file.py
<<<<<<< SEARCH
def broken(x):
    return x - 1
=======
def broken(x):
    return x + 1
>>>>>>> REPLACE
\`\`\`

- Several hunks in ONE turn: repeat the SEARCH/REPLACE block inside the same \`\`\`edit. To change more than one file, leave the path off the fence and start each file with \`--- path\`. Every hunk applies or none does, so a failure leaves the tree exactly as it was:
\`\`\`edit
--- src/a.ts
<<<<<<< SEARCH
oldName(
=======
newName(
>>>>>>> REPLACE
--- src/b.ts
<<<<<<< SEARCH
import { oldName } from "./a.js";
=======
import { newName } from "./a.js";
>>>>>>> REPLACE
\`\`\`

- To replace EVERY occurrence in a file rather than exactly one, add \`all\` after the path (\`\`\`edit src/a.ts all, or \`--- src/a.ts all\`). Without it a SEARCH that matches twice is an error, on purpose — say \`all\` when you mean it. Use this for a rename rather than one edit per call site.

- Create (or overwrite) a whole file:
\`\`\`create path/to/new_file.py
print("hello")
\`\`\`

Rules:
- ${UNTRUSTED_RULE}
- One code block per turn. Do not emit two — but one \`\`\`edit block may carry as many hunks, across as many files, as the change needs.
- You have NO tool-calling in this session. Never emit <function_calls>, <invoke>, or any XML tool syntax — it will not execute. Fenced code blocks are the ONLY way to act.
- Wait for the observation before continuing; never assume an action's result. Never write the output you expect — you will be shown the real output.
- Prefer \`\`\`edit over shell text-surgery (sed/heredocs) for changing files.
- The filesystem always persists between actions. Python variables usually persist, but may reset after long pauses — anything important belongs in a file.
- Prefer small, verifiable steps. Read errors and fix them.

# Finishing

When the task is complete and verified, emit a finish block with a short summary of what you did and the result:
\`\`\`finish
Created and ran fib.py; it prints the first 10 Fibonacci numbers.
\`\`\`

Do not finish until you have actually verified the result by running something.

# Task

${options.task}`;
}

/**
 * Wrap an execution result as the observation the agent sees next turn.
 *
 * Scrubbed on the way in, which is the only place that catches everything: the
 * observation is what reaches the model, the event log, the dashboard timeline
 * and Observe, so redacting once here covers all of them rather than four
 * partial passes at the far end.
 */
export function formatObservation(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}): string {
  const parts: string[] = [`[exit ${result.exitCode}${result.timedOut ? ", TIMED OUT" : ""}]`];
  if (result.stdout !== "") parts.push(`stdout:\n${scrub(result.stdout)}`);
  if (result.stderr !== "") parts.push(`stderr:\n${scrub(result.stderr)}`);
  if (result.stdout === "" && result.stderr === "") parts.push("(no output)");
  if (result.truncated) parts.push("(output truncated)");
  return parts.join("\n");
}
