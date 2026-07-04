// CodeAct action space: the agent expresses each action as executable
// code (a fenced block), not structured tool-call JSON. One action per
// turn — the model thinks in prose, then emits a single code block.

export type Action =
  | { kind: "bash"; code: string }
  | { kind: "python"; code: string }
  | { kind: "edit"; file: string; search: string; replace: string }
  | { kind: "create"; file: string; content: string }
  | { kind: "finish"; message: string }
  | { kind: "invalid"; message: string } // recognized but malformed — feed the error back
  | { kind: "none" }; // no actionable block found — the model must retry

const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;

const BASH_LANGS = new Set(["bash", "sh", "shell", ""]);
const PYTHON_LANGS = new Set(["python", "py", "python3"]);

const SEARCH_REPLACE = /^<{7} SEARCH\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7} REPLACE\s*$/m;

/**
 * Parse the first actionable code block from a model response. CodeAct is
 * one action per turn, so later blocks are ignored (the model is told to
 * emit exactly one). A `finish` block ends the task; its body is the
 * final answer. Prose outside the block is the agent's reasoning and is
 * kept in history but never executed.
 */
export function parseAction(text: string): Action {
  for (const match of text.matchAll(FENCE)) {
    const info = match[1]!.trim();
    const code = match[2]!;
    const [langRaw, ...argParts] = info.split(/\s+/);
    const lang = (langRaw ?? "").toLowerCase();
    const arg = argParts.join(" ");

    if (lang === "finish") {
      return { kind: "finish", message: code.trim() };
    }
    if (lang === "edit") {
      if (arg === "") return { kind: "invalid", message: "```edit needs a file path: ```edit path/to/file" };
      const sr = SEARCH_REPLACE.exec(code);
      if (sr === null) {
        return {
          kind: "invalid",
          message:
            "```edit block must contain exactly:\n<<<<<<< SEARCH\n(old text)\n=======\n(new text)\n>>>>>>> REPLACE",
        };
      }
      return { kind: "edit", file: arg, search: sr[1]!, replace: sr[2]! };
    }
    if (lang === "create") {
      if (arg === "") return { kind: "invalid", message: "```create needs a file path: ```create path/to/file" };
      return { kind: "create", file: arg, content: code };
    }
    if (PYTHON_LANGS.has(lang)) {
      return { kind: "python", code };
    }
    if (BASH_LANGS.has(lang) && arg === "") {
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
    case "edit":
      return `edit: ${action.file}`;
    case "create":
      return `create: ${action.file}`;
    case "finish":
      return "finish";
    case "invalid":
      return "invalid-action";
    case "none":
      return "no-action";
  }
}

function firstLine(code: string): string {
  const line = code.trim().split("\n", 1)[0] ?? "";
  return line.length > 80 ? line.slice(0, 77) + "..." : line;
}
