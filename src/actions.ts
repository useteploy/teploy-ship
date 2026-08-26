// CodeAct action space: the agent expresses each action as executable
// code (a fenced block), not structured tool-call JSON. One action per
// turn — the model thinks in prose, then emits a single code block.

/**
 * One search/replace within one file.
 *
 * An `edit` action carries a LIST of these, which is the whole of C2. It used
 * to carry exactly one, and the loop is one action per turn — so a rename
 * across 30 call sites cost 30 of the run's 40 turns and could not finish, and
 * the SEARCH text had to be globally unique in the file, which forced the agent
 * to quote surrounding lines it did not want to change. Both limits were on the
 * ACTION FORMAT, not on anything the publisher enforces (publish caps are 200
 * files / 20k lines), so they were pure self-inflicted ceiling.
 */
export interface EditHunk {
  file: string;
  search: string;
  replace: string;
  /**
   * Replace every occurrence rather than requiring exactly one.
   *
   * Opt-in, and it must stay opt-in: a SEARCH that accidentally matches twice
   * is the agent misreading the file, and silently changing both is how a
   * surgical edit becomes a blast radius. `all` is the agent saying it means
   * it, and the observation reports the count so a wrong guess is visible.
   */
  all: boolean;
}

export type Action =
  | { kind: "bash"; code: string }
  | { kind: "python"; code: string }
  | { kind: "edit"; edits: EditHunk[] }
  | { kind: "create"; file: string; content: string }
  | { kind: "search"; query: string } // semantic code retrieval (repo runs with an index)
  | { kind: "finish"; message: string }
  | { kind: "invalid"; message: string } // recognized but malformed — feed the error back
  | { kind: "none" }; // no actionable block found — the model must retry

const FENCE = /```([^\n`]*)\n([\s\S]*?)```/g;

/**
 * Validate a model-supplied file path before it reaches the executor.
 *
 * `edit` and `create` handed the path straight to getFile/putFile. A correct
 * executor roots paths inside the workspace, but "correct" is then a property
 * of every current AND future executor implementation, including a remote
 * daemon on another host. The harness should not be relying on that: a path is
 * the one thing here the model fully controls.
 *
 * Rejected: absolute paths, traversal, NUL bytes, Windows drive/UNC forms, git
 * internals, and the harness's own scratch directory.
 */
export function validateActionPath(path: string): string | null {
  const value = path.trim();
  if (value === "") return "a file path is required";
  if (value.length > 1024) return "that path is unreasonably long";
  if (value.includes("\0")) return "paths may not contain NUL bytes";
  if (value.startsWith("/") || value.startsWith("\\\\")) return "absolute paths are not allowed — use a path relative to the working directory";
  if (/^[A-Za-z]:[\\/]/.test(value)) return "drive-letter paths are not allowed — use a path relative to the working directory";
  const parts = value.split(/[\\/]+/);
  if (parts.some((p) => p === "..")) return "'..' is not allowed in a path";
  if (parts[0] === ".git") return ".git is off limits — change files, not git's internals";
  if (parts[0] === ".teploy-agent") return ".teploy-agent is harness scratch, not part of the repository";
  return null;
}

const BASH_LANGS = new Set(["bash", "sh", "shell", ""]);
const PYTHON_LANGS = new Set(["python", "py", "python3"]);

const SEARCH_REPLACE = /^<{7} SEARCH\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7} REPLACE\s*$/m;
const SEARCH_REPLACE_ALL = /^<{7} SEARCH\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7} REPLACE[^\S\n]*$/gm;
/** A `--- path/to/file` line inside a multi-file edit block. */
const EDIT_FILE_HEADER = /^---[^\S\n]+(\S[^\n]*?)[^\S\n]*$/;

const EDIT_FORMAT_HELP =
  "```edit block must contain at least one:\n<<<<<<< SEARCH\n(old text)\n=======\n(new text)\n>>>>>>> REPLACE\n\n" +
  "Several hunks may follow one another in the same block. To edit more than one file in a turn, omit the path " +
  'from the fence and start each file with a "--- path/to/file" line. Add "all" after the path (```edit path/to/file all) ' +
  "to replace every occurrence instead of requiring exactly one.";

/**
 * Parse an ```edit body into one or more hunks.
 *
 * Two shapes, and the single-file one is unchanged so every existing prompt,
 * transcript and replayed run parses exactly as before:
 *
 *   ```edit path/to/file [all]      -> hunks all apply to that file
 *   ```edit                         -> body carries "--- path" headers
 */
export function parseEditBlock(arg: string, code: string): Action {
  const words = arg.trim().split(/\s+/).filter((w) => w !== "");
  const all = words[words.length - 1]?.toLowerCase() === "all";
  const file = (all ? words.slice(0, -1) : words).join(" ").trim();

  if (file !== "") {
    const bad = validateActionPath(file);
    if (bad !== null) return { kind: "invalid", message: `cannot edit ${file}: ${bad}` };
    const hunks = hunksIn(code).map((h) => ({ ...h, file, all }));
    if (hunks.length === 0) return { kind: "invalid", message: EDIT_FORMAT_HELP };
    return { kind: "edit", edits: hunks };
  }

  // No path on the fence: the body must name its files.
  const sections = splitByFileHeader(code);
  if (sections.length === 0) {
    return {
      kind: "invalid",
      message: "```edit needs a file path: ```edit path/to/file\n\n" + EDIT_FORMAT_HELP,
    };
  }
  const edits: EditHunk[] = [];
  for (const section of sections) {
    const bad = validateActionPath(section.file);
    if (bad !== null) return { kind: "invalid", message: `cannot edit ${section.file}: ${bad}` };
    const hunks = hunksIn(section.body);
    if (hunks.length === 0) {
      return { kind: "invalid", message: `no SEARCH/REPLACE hunk under "--- ${section.file}".\n\n${EDIT_FORMAT_HELP}` };
    }
    for (const hunk of hunks) edits.push({ ...hunk, file: section.file, all: section.all });
  }
  return { kind: "edit", edits };
}

function hunksIn(code: string): Array<{ search: string; replace: string }> {
  SEARCH_REPLACE_ALL.lastIndex = 0;
  return [...code.matchAll(SEARCH_REPLACE_ALL)].map((m) => ({ search: m[1]!, replace: m[2]! }));
}

function splitByFileHeader(code: string): Array<{ file: string; all: boolean; body: string }> {
  const sections: Array<{ file: string; all: boolean; body: string }> = [];
  let current: { file: string; all: boolean; body: string[] } | null = null;
  for (const line of code.split("\n")) {
    const header = EDIT_FILE_HEADER.exec(line);
    // A "--- " line inside a hunk body is diff context, not a header. Only a
    // line that appears BEFORE any hunk content, or between hunks, can start a
    // file — cheaply approximated by requiring the current section to have a
    // complete hunk before a new header is honoured.
    if (header !== null && (current === null || hunksIn(current.body.join("\n")).length > 0)) {
      if (current !== null) sections.push({ file: current.file, all: current.all, body: current.body.join("\n") });
      const words = header[1]!.trim().split(/\s+/);
      const all = words[words.length - 1]?.toLowerCase() === "all";
      current = { file: (all ? words.slice(0, -1) : words).join(" "), all, body: [] };
      continue;
    }
    if (current !== null) current.body.push(line);
  }
  if (current !== null) sections.push({ file: current.file, all: current.all, body: current.body.join("\n") });
  return sections.filter((s) => s.file !== "");
}

/**
 * Parse the first action from a model response. CodeAct is one action per
 * turn, so later blocks are ignored (the model is told to emit exactly
 * one). A `finish` block ends the task; its body is the final answer.
 * Prose outside the block is the agent's reasoning and is never executed.
 *
 * Models sometimes fall back into their native tool-calling dialect and
 * emit `<invoke name="bash"><parameter name="command">…` XML instead of a
 * fenced block — then hallucinate the tool result and "finish" in the
 * same message. The XML is rescued into a real action, and WHICHEVER
 * comes first in the text wins, so a hallucinated trailing ```finish
 * never outranks the action the model actually attempted.
 */
export function parseAction(text: string): Action {
  const fenced = parseFencedAction(text);
  const xml = parseToolXmlAction(text);
  if (fenced !== null && xml !== null) {
    return fenced.index <= xml.index ? fenced.action : xml.action;
  }
  return fenced?.action ?? xml?.action ?? { kind: "none" };
}

function parseFencedAction(text: string): { index: number; action: Action } | null {
  for (const match of text.matchAll(FENCE)) {
    const index = match.index;
    const info = match[1]!.trim();
    const code = match[2]!;
    const [langRaw, ...argParts] = info.split(/\s+/);
    const lang = (langRaw ?? "").toLowerCase();
    const arg = argParts.join(" ");

    if (lang === "finish") {
      return { index, action: { kind: "finish", message: code.trim() } };
    }
    if (lang === "edit") {
      return { index, action: parseEditBlock(arg, code) };
    }
    if (lang === "create") {
      if (arg === "") return { index, action: { kind: "invalid", message: "```create needs a file path: ```create path/to/file" } };
      const bad = validateActionPath(arg);
      if (bad !== null) return { index, action: { kind: "invalid", message: `cannot create ${arg}: ${bad}` } };
      return { index, action: { kind: "create", file: arg, content: code } };
    }
    if (lang === "search") {
      const query = code.trim();
      if (query === "") return { index, action: { kind: "invalid", message: "```search block needs a query in its body, e.g.\n```search\nwhere is retry backoff handled?\n```" } };
      return { index, action: { kind: "search", query } };
    }
    if (PYTHON_LANGS.has(lang)) {
      return { index, action: { kind: "python", code } };
    }
    if (BASH_LANGS.has(lang) && arg === "") {
      return { index, action: { kind: "bash", code } };
    }
    // A fenced block in an unknown language (e.g. ```json data) isn't an
    // action — keep scanning for a real one.
  }
  return null;
}

const INVOKE = /<(?:\w+:)?invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?invoke>/;
const INVOKE_OPEN = /<(?:\w+:)?invoke\s+name="([^"]+)"/;
const PARAM_ALL = /<(?:\w+:)?parameter\s+name="([^"]*)"[^>]*>([\s\S]*?)<\/(?:\w+:)?parameter>/g;

/**
 * Pull a named parameter out of a rescued tool-call payload.
 *
 * The old version took the FIRST <parameter> whatever it was called, so a
 * native payload that puts `description` before `command` executed the
 * description text as a shell command and silently dropped the real one.
 */
function paramByName(xml: string, names: string[]): string | null {
  const found = new Map<string, string>();
  for (const match of xml.matchAll(PARAM_ALL)) {
    found.set(match[1]!.toLowerCase(), match[2]!);
  }
  for (const name of names) {
    const value = found.get(name);
    if (value !== undefined && value.trim() !== "") return value;
  }
  return null;
}

const XML_CORRECTION =
  'You emitted XML tool-call syntax, but this session has NO tool-calling — it will never execute. Act with a fenced code block instead: ```bash, ```python, ```edit, ```create, or ```finish.';

function parseToolXmlAction(text: string): { index: number; action: Action } | null {
  const match = INVOKE.exec(text);
  if (match === null) {
    // an opening tag with no close (cut-off output) still deserves the correction
    const open = INVOKE_OPEN.exec(text);
    return open === null ? null : { index: open.index, action: { kind: "invalid", message: XML_CORRECTION } };
  }
  const name = match[1]!.toLowerCase();
  const body = match[2]!;
  if (/bash|shell|terminal|cmd|exec/.test(name)) {
    const code = paramByName(body, ["command", "cmd", "script", "code", "input"]);
    if (code !== null) return { index: match.index, action: { kind: "bash", code } };
  }
  if (/python/.test(name)) {
    const code = paramByName(body, ["code", "script", "command", "input"]);
    if (code !== null) return { index: match.index, action: { kind: "python", code } };
  }
  return { index: match.index, action: { kind: "invalid", message: XML_CORRECTION } };
}

/** Human-readable one-liner for logs/telemetry. */
export function describeAction(action: Action): string {
  switch (action.kind) {
    case "bash":
      return `bash: ${firstLine(action.code)}`;
    case "python":
      return `python: ${firstLine(action.code)}`;
    case "edit": {
      const files = [...new Set(action.edits.map((e) => e.file))];
      const where = files.length === 1 ? files[0]! : `${files.length} files`;
      return `edit: ${where}${action.edits.length > 1 ? ` (${action.edits.length} hunks)` : ""}`;
    }
    case "create":
      return `create: ${action.file}`;
    case "search":
      return `search: ${firstLine(action.query)}`;
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

/**
 * Finish-guard nudges, shared by the live loop (agent.ts) and the durable
 * workflow (durable.ts) so both stay word-for-word identical — the durable
 * loop replays deterministically, and the transcripts should match.
 *
 * The first finish of a run is always held once:
 * - with zero successful executions, the agent is told to do the work;
 * - otherwise it is told to PROVE each deliverable with a real command.
 * The second finish is honored unconditionally (no loops). This kills the
 * hallucinated-verification finish observed live (2026-07-05): the agent
 * claimed done.txt existed without ever creating it.
 */
export const FINISH_NUDGE_NO_WORK =
  "You are finishing without having successfully executed anything. Do the work first: take the actions the task needs, verify the result with a command, and only then finish.";

export const FINISH_NUDGE_FAILED =
  "Your most recent executed command FAILED. The task is NOT done: fix the problem in the actual files, run a command that proves it works (tests pass, program runs), and only then finish.";

/**
 * The second hold, and the one that makes the gate evidence-based rather than
 * ceremonial. The old gate asked the agent to verify and then accepted the very
 * next finish — including one that ran nothing in between, which is exactly the
 * hallucinated-verification failure it was built to stop. This fires only when
 * the agent came back with a finish having executed NOTHING successfully since
 * being asked to prove its work. Bounded: it is asked once, then honoured.
 */
export const FINISH_NUDGE_NO_EVIDENCE =
  "You did not run anything between being asked to verify and finishing again — so nothing has been demonstrated. Run one command that actually proves the task is done (execute the tests, run the program, read back the files you created) and show its real output. If you genuinely cannot verify, say so explicitly in your finish message instead of implying success.";

export const FINISH_NUDGE_VERIFY =
  "Before finishing, verify your work. Re-read the task, then run one command that PROVES each artifact or change it requires actually exists and is correct (list or cat the files you claim to have created, run the tests, execute the program). If any check fails or anything is missing, fix it before finishing. If everything is already proven, finish again.";

/**
 * A finish over an UNCHANGED working tree.
 *
 * The verified-finish gate used to ask only "did any command succeed?", which
 * an agent satisfies with `cat`, `grep` and `pytest` while having written
 * nothing. On the 2026-08-18 cross-family run, four of nine claude-haiku-4.5
 * runs finished this way — status `finished`, zero edits, empty patch — versus
 * zero of one hundred GLM runs. Empty-patch rate tracked model FAMILY (56% vs
 * 6-8%), not model strength, which is what makes it a harness defect rather
 * than a capability gap: the gate was tuned against a model that happens not to
 * do this.
 *
 * Only fires where a workspace fingerprint exists (a git repo) and the tree is
 * clean, so it cannot misfire on tasks whose deliverable is not a diff.
 */
export const FINISH_NUDGE_CLEAN_TREE =
  "Your working tree is UNCHANGED — `git diff` is empty, so you have not edited any file. The deliverable is the edited tree, not your description of it: a summary with no diff is worth nothing here. Make the actual edit now, verify it, then finish. If you genuinely believe no code change is required, say that explicitly and explain why.";
