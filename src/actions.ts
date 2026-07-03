// CodeAct action space: the agent expresses each action as executable
// code (a fenced block), not structured tool-call JSON. One action per
// turn — the model thinks in prose, then emits a single code block.

export type Action =
  | { kind: "bash"; code: string }
  | { kind: "python"; code: string }
  | { kind: "finish"; message: string }
  | { kind: "none" }; // no actionable block found — the model must retry

const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;

const BASH_LANGS = new Set(["bash", "sh", "shell", ""]);
const PYTHON_LANGS = new Set(["python", "py", "python3"]);

/**
 * Parse the first actionable code block from a model response. CodeAct is
 * one action per turn, so later blocks are ignored (the model is told to
 * emit exactly one). A `finish` block ends the task; its body is the
 * final answer. Prose outside the block is the agent's reasoning and is
 * kept in history but never executed.
 */
export function parseAction(text: string): Action {
  for (const match of text.matchAll(FENCE)) {
    const lang = match[1]!.trim().toLowerCase();
    const code = match[2]!;
    if (lang === "finish") {
      return { kind: "finish", message: code.trim() };
    }
    if (PYTHON_LANGS.has(lang)) {
      return { kind: "python", code };
    }
    if (BASH_LANGS.has(lang)) {
      return { kind: "bash", code };
    }
    // A fenced block in an unknown language (e.g. ```json data) isn't an
    // action — keep scanning for a real one.
  }
  return { kind: "none" };
}

/** Human-readable one-liner for logs/telemetry. */
export function describeAction(action: Action): string {
  switch (action.kind) {
    case "bash":
      return `bash: ${firstLine(action.code)}`;
    case "python":
      return `python: ${firstLine(action.code)}`;
    case "finish":
      return "finish";
    case "none":
      return "no-action";
  }
}

function firstLine(code: string): string {
  const line = code.trim().split("\n", 1)[0] ?? "";
  return line.length > 80 ? line.slice(0, 77) + "..." : line;
}
