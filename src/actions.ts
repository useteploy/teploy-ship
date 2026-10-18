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
  | { kind: "look"; url?: string; ref?: string; find?: string; depth?: number; image?: boolean } // browser perception (S12): the run's page as an a11y-tree text with refs; image=on adds a PNG screenshot (gated slice)
  | { kind: "delegate"; task: string; repo?: string; path?: string; target?: string } // bounded child work (S20/S22): spawn one child run, park, merge its result back as an observation
  | { kind: "mcp"; tool: string; args: Record<string, unknown> } // a declared MCP tool (D1, input.mcp): mcp.<server>.<tool> + JSON arguments
  | { kind: "finish"; message: string }
  | { kind: "ask"; question: string } // a question for the operator; the run parks on the answer (durable, input.ask)
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

/** `look` fence parameters: `key=value` tokens, whitespace-delimited. */
const LOOK_PARAM = /(?:^|\s)(url|ref|find|depth|image)=/g;
/**
 * The element-ref grammar of Playwright's ai snapshots (tool-vocab addendum
 * §4): `e12`, or `f2e3` for an element inside an iframe.
 */
const LOOK_REF = /^(f\d+)?e\d+$/;
/** A `find=` needle wrapped as /pattern/flags is a regex; anything else is text. */
const LOOK_FIND_RE = /^\/(.+)\/([a-z]*)$/s;
const LOOK_DEPTH_MAX = 30;

export const LOOK_HELP =
  "```look observes the run's browser page as text (the accessibility tree, with [ref=eN] labels you can reuse):\n" +
  "```look https://example.com/docs\n" +
  "Narrow it instead of re-reading a big page — ```look find=Sign ?up (text or /regex/flags), ```look ref=e12 depth=3 (a subtree from your last snapshot).\n" +
  "```look image=on additionally captures a PNG screenshot of the page alongside the text (offered only when the run admits image looks).";

/**
 * Parse a ```look fence argument into the action. Parameters are `url=` (or a
 * bare url before the first `key=`), `ref=`, `find=`, `depth=`, `image=`;
 * values run to the next parameter, so a find needle may contain spaces.
 * Token control is STRUCTURAL on purpose (the tool-vocab addendum's rule):
 * find/ref/depth decide how much of the tree is rendered at all, never a
 * post-hoc trim of a giant blob.
 */
export function parseLookArgs(arg: string): Action {
  const params = new Map<string, string>();
  const marks = [...arg.matchAll(LOOK_PARAM)];
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!;
    const start = mark.index! + mark[0]!.length;
    const end = i + 1 < marks.length ? marks[i + 1]!.index : arg.length;
    params.set(mark[1]!, arg.slice(start, end).trim());
  }
  // Text before the first key= is the url shorthand: ```look https://example.com
  const lead = marks.length === 0 ? arg.trim() : arg.slice(0, marks[0]!.index).trim();
  if (lead !== "") params.set("url", lead);

  const url = params.get("url");
  if (url === "") return { kind: "invalid", message: "```look url= is empty.\n\n" + LOOK_HELP };
  if (url !== undefined && !/^https?:\/\//i.test(url)) {
    return { kind: "invalid", message: `\`\`\`look url must be http(s), got: ${url}\n\n` + LOOK_HELP };
  }
  const ref = params.get("ref");
  if (ref === "") return { kind: "invalid", message: "```look ref= is empty — pass a ref from your last snapshot, e.g. ref=e12.\n\n" + LOOK_HELP };
  if (ref !== undefined && !LOOK_REF.test(ref)) {
    return { kind: "invalid", message: `\`\`\`look ref must be an element ref from a previous snapshot (e12, or f2e3 inside an iframe), got: ${ref}\n\n` + LOOK_HELP };
  }
  const find = params.get("find");
  if (find === "") return { kind: "invalid", message: "```look find= is empty.\n\n" + LOOK_HELP };
  if (find !== undefined) {
    const regex = LOOK_FIND_RE.exec(find);
    if (regex !== null) {
      try {
        new RegExp(regex[1]!, regex[2]);
      } catch (error) {
        return { kind: "invalid", message: `\`\`\`look find= regex does not compile: ${error instanceof Error ? error.message : String(error)}\n\n` + LOOK_HELP };
      }
    }
  }
  if (ref !== undefined && find !== undefined) {
    return { kind: "invalid", message: "```look ref= and find= both narrow the same snapshot — pick one.\n\n" + LOOK_HELP };
  }
  const depthRaw = params.get("depth");
  let depth: number | undefined;
  if (depthRaw !== undefined) {
    depth = Number(depthRaw);
    if (!Number.isInteger(depth) || depth < 1 || depth > LOOK_DEPTH_MAX) {
      return { kind: "invalid", message: `\`\`\`look depth= must be a whole number from 1 to ${LOOK_DEPTH_MAX}, got: ${depthRaw}` };
    }
  }
  // image= parses wherever the look dialect is on, so a run that admits looks
  // but not pixels can REFUSE the image loudly at execution (durable.ts names
  // SHIP_LOOK_IMAGE_MODEL) rather than the param silently vanishing — the
  // refusal is the honest shape for "parseable but not offered here".
  const imageRaw = params.get("image");
  let image: boolean | undefined;
  if (imageRaw !== undefined) {
    if (/^(on|true|1|yes)$/i.test(imageRaw)) image = true;
    else if (/^(off|false|0|no)$/i.test(imageRaw)) image = undefined;
    else {
      return { kind: "invalid", message: `\`\`\`look image= must be on or off, got: ${imageRaw}\n\n` + LOOK_HELP };
    }
  }
  return {
    kind: "look",
    ...(url !== undefined ? { url } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(find !== undefined ? { find } : {}),
    ...(depth !== undefined ? { depth } : {}),
    ...(image !== undefined ? { image } : {}),
  };
}

/**
 * `delegate` fence parameters: `key=value` tokens before the body, like
 * `look`'s. Only two exist in v1 and both are scope HINTS, never authority:
 * `repo=` must name the parent's own repository (the loop enforces that —
 * the parser only checks the shape), `path=` narrows where the child works.
 */
const DELEGATE_PARAM = /(?:^|\s)(repo|path|target)=/g;
/** A delegate target id (delegate-targets.ts): what `target=` may name. Lives here so the parser stays dependency-free. */
export const DELEGATE_TARGET_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The task prompt carried in the body is clamped here, before it reaches a run. */
export const DELEGATE_TASK_MAX = 8000;

export const DELEGATE_HELP =
  "```delegate spawns ONE child run with a task and waits for its result:\n" +
  "```delegate path=src/foo\nMake the foo parser accept RFC 3339 durations. Add tests.\n```\n" +
  "Use it to split off self-contained work you do not need to interleave with your own. " +
  "The child is an ordinary run with the same permissions as this one; it cannot delegate further. " +
  "target=<id> runs the child on one of the targets this run was offered; leave it off to use this run's own model.";

/**
 * Parse a ```delegate fence. The body is the child's task (required); the
 * fence argument carries the optional `repo=` / `path=` hints and `target=`
 * (DT2), which names an allowlisted target id — never a free-form model.
 * Budget and gates are inherited, not chosen by the model; whether the target
 * is allowed is the spawn's decision (delegate-targets.ts), not the parser's.
 */
export function parseDelegateArgs(arg: string, code: string): Action {
  const params = new Map<string, string>();
  const marks = [...arg.matchAll(DELEGATE_PARAM)];
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]!;
    const start = mark.index! + mark[0]!.length;
    const end = i + 1 < marks.length ? marks[i + 1]!.index : arg.length;
    params.set(mark[1]!, arg.slice(start, end).trim());
  }
  const repo = params.get("repo");
  if (repo === "") return { kind: "invalid", message: "```delegate repo= is empty — pass the repository's full clone URL, or leave it off to use this run's repository.\n\n" + DELEGATE_HELP };
  if (repo !== undefined && !/^(https?|file|ssh|git):\/\/|^git@/.test(repo)) {
    return { kind: "invalid", message: `\`\`\`delegate repo= must be a full clone URL, got: ${repo}\n\n` + DELEGATE_HELP };
  }
  const path = params.get("path");
  if (path === "") return { kind: "invalid", message: "```delegate path= is empty — pass the subdirectory to scope the child to, or leave it off.\n\n" + DELEGATE_HELP };
  if (path !== undefined) {
    const bad = validateActionPath(path);
    if (bad !== null) return { kind: "invalid", message: `cannot scope delegation to ${path}: ${bad}` };
  }
  const target = params.get("target");
  if (target === "") return { kind: "invalid", message: "```delegate target= is empty — name one of the targets this run was offered, or leave it off to use this run's own model.\n\n" + DELEGATE_HELP };
  if (target !== undefined && !DELEGATE_TARGET_ID.test(target)) {
    return { kind: "invalid", message: `\`\`\`delegate target= must be a target id (lowercase letters, digits, . _ -), got: ${target}\n\n` + DELEGATE_HELP };
  }
  const task = code.trim();
  if (task === "") {
    return { kind: "invalid", message: "```delegate block needs the child's task in its body, e.g.\n```delegate path=src/foo\nMake the foo parser accept RFC 3339 durations. Add tests.\n```" };
  }
  return {
    kind: "delegate",
    task: task.length > DELEGATE_TASK_MAX ? `${task.slice(0, DELEGATE_TASK_MAX)}\n…(task clamped at ${DELEGATE_TASK_MAX} chars)` : task,
    ...(repo !== undefined ? { repo } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(target !== undefined ? { target } : {}),
  };
}

/** An ```mcp block's body is capped before it is parsed or sent anywhere. */
export const MCP_ARGS_MAX = 64_000;

/**
 * Parse a ```mcp fence: the tool id on the fence (`mcp.<server>.<tool>`), a
 * JSON object of arguments in the body (empty body = no arguments). Shape only:
 * whether the tool is offered, granted and conforming is the loop's decision
 * (mcp.ts prepareMcpCall), never the parser's.
 */
export function parseMcpBlock(arg: string, code: string): Action {
  const tool = arg.trim();
  if (!/^mcp\.[a-z][a-z0-9_-]*\.\S+$/.test(tool)) {
    return { kind: "invalid", message: "```mcp needs the tool on the fence, exactly as listed: ```mcp mcp.server.tool, with a JSON object of arguments in the body." };
  }
  const body = code.trim();
  if (body.length > MCP_ARGS_MAX) return { kind: "invalid", message: `\`\`\`mcp arguments are limited to ${MCP_ARGS_MAX} characters.` };
  if (body === "") return { kind: "mcp", tool, args: {} };
  let args: unknown;
  try {
    args = JSON.parse(body);
  } catch (error) {
    return { kind: "invalid", message: `\`\`\`mcp arguments must be one JSON object: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) return { kind: "invalid", message: "```mcp arguments must be one JSON object, e.g. {\"query\": \"retry\"}." };
  return { kind: "mcp", tool, args: args as Record<string, unknown> };
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
/**
 * The model's turn, cut at the end of its first action block.
 *
 * What goes into the transcript as the assistant's message. Everything after
 * the first fenced action is discarded — the protocol is one block per turn
 * and the parser only ever reads the first — and the reason is not tidiness:
 * a model that keeps writing after its block writes the observation it
 * EXPECTS, in the exact `[exit 0] stdout:` shape the real one arrives in.
 * Left in the transcript, that fiction sits beside the real observation and
 * the model then reasons about which of the two to believe. Measured live
 * 2026-09-15 (run-a3d15f43, GLM 5.3): thirty-plus turns re-verifying a
 * finished change against "resets" that were its own invented output. A
 * turn with no action block is kept whole — there is nothing to cut at.
 *
 * Pure, so a replay trims the recorded text identically.
 */
export function transcriptTurn(text: string, dialect?: ActionDialect): string {
  const fenced = firstFencedAction(text, dialect);
  if (fenced === null) return text;
  return text.slice(0, fenced.end).trimEnd();
}

function firstFencedAction(text: string, dialect?: ActionDialect): { end: number } | null {
  const langs = actionLangs(dialect);
  for (const match of text.matchAll(FENCE)) {
    const lang = (match[1]!.trim().split(/\s+/)[0] ?? "").toLowerCase();
    if (langs.has(lang)) return { end: match.index + match[0].length };
  }
  return null;
}

const ACTION_LANGS: ReadonlySet<string> = new Set(["finish", "edit", "create", "search", "ask", ...PYTHON_LANGS, ...BASH_LANGS]);
/** ACTION_LANGS plus `look` — the one action whose offerance is runtime-gated. */
const LOOK_ACTION_LANGS: ReadonlySet<string> = new Set([...ACTION_LANGS, "look"]);
/** ...plus `delegate` (S20/S22): offered only where the run input admits delegation. */
const DELEGATE_ACTION_LANGS: ReadonlySet<string> = new Set([...LOOK_ACTION_LANGS, "delegate"]);

function actionLangs(dialect?: ActionDialect): ReadonlySet<string> {
  // `mcp` (D1) widens whichever set applies; absent, the sets are exactly the
  // pre-MCP ones, so flag-off transcripts trim identically.
  if (dialect?.mcp === true) return new Set([...actionLangsBase(dialect), "mcp"]);
  return actionLangsBase(dialect);
}

function actionLangsBase(dialect?: ActionDialect): ReadonlySet<string> {
  if (dialect?.delegate === true) return DELEGATE_ACTION_LANGS;
  return dialect?.look === true ? LOOK_ACTION_LANGS : ACTION_LANGS;
}

/**
 * Which actions this session parses. `look` (S12) is the first action that is
 * OFFERED conditionally: flag-off must be byte-identical to a pre-feature
 * run, so a ```look block is not an action at all — it falls through the
 * unknown-language scan and a turn containing one parses as `none`, exactly
 * as before the action existed. Every pre-existing caller passes nothing and
 * keeps that behaviour. `delegate` (S20/S22) follows the same rule, with one
 * deliberate widening: a DELEGATION CHILD parses the action too
 * (input.delegateChild), so a child that tries to delegate is REFUSED with a
 * clear message by the loop rather than being told "no code block found" —
 * the one-level limit is a policy answer, not a parse accident.
 */
export interface ActionDialect {
  look?: boolean;
  delegate?: boolean;
  /**
   * Two-way steering (D2, input.steerReply): a ```reply block is the agent's
   * message to the operator. NOT an action — parseAction never returns it,
   * so the turn's real action (if any) still runs; read it with parseReply.
   */
  reply?: boolean;
  /** ```mcp (D1): parsed only where the run input carries `mcp`. */
  mcp?: boolean;
}

/** Longest reply kept; a reply is a message to a person, not a report. */
export const REPLY_MAX = 4000;

/**
 * The agent's ```reply to the operator in this turn, or null.
 *
 * Only a reply that comes BEFORE the turn's first action block counts: the
 * transcript is cut at the end of that block (transcriptTurn) and everything
 * after it is discarded unread, a reply included — the same rule as any
 * text the model writes after acting. Pure over the recorded think text, so
 * the reply needs no step of its own: live, replay and the thread view all
 * read the same bytes off the same `turn-N-think` result.
 *
 * Without the dialect this always returns null and a ```reply block is an
 * unknown-language fence that parseAction skips — a reply-only turn on a
 * flag-off run parses as `none`, exactly as before the feature existed.
 */
export function parseReply(text: string, dialect?: ActionDialect): string | null {
  if (dialect?.reply !== true) return null;
  const langs = actionLangs(dialect);
  for (const match of text.matchAll(FENCE)) {
    const lang = (match[1]!.trim().split(/\s+/)[0] ?? "").toLowerCase();
    if (lang === "reply") {
      const body = match[2]!.trim();
      if (body === "") return null;
      return body.length > REPLY_MAX ? `${body.slice(0, REPLY_MAX)}\n…(reply clamped)` : body;
    }
    if (langs.has(lang)) return null;
  }
  return null;
}

export function parseAction(text: string, dialect?: ActionDialect): Action {
  const fenced = parseFencedAction(text, dialect);
  const xml = parseToolXmlAction(text);
  if (fenced !== null && xml !== null) {
    return fenced.index <= xml.index ? fenced.action : xml.action;
  }
  return fenced?.action ?? xml?.action ?? { kind: "none" };
}

function parseFencedAction(text: string, dialect?: ActionDialect): { index: number; action: Action } | null {
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
    if (lang === "ask") {
      const question = code.trim();
      if (question === "") return { index, action: { kind: "invalid", message: "```ask block needs the question in its body, e.g.\n```ask\nShould the new endpoint require auth, or stay public like /health?\n```" } };
      return { index, action: { kind: "ask", question } };
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
    if (lang === "look" && dialect?.look === true) {
      return { index, action: parseLookArgs(arg) };
    }
    if (lang === "delegate" && dialect?.delegate === true) {
      return { index, action: parseDelegateArgs(arg, code) };
    }
    if (lang === "mcp" && dialect?.mcp === true) {
      return { index, action: parseMcpBlock(arg, code) };
    }
    if (PYTHON_LANGS.has(lang)) {
      if (code.trim() === "") return { index, action: { kind: "invalid", message: "The Python action is empty. Put the code on a new line after ```python and close the block on its own line." } };
      return { index, action: { kind: "python", code } };
    }
    if (BASH_LANGS.has(lang) && arg === "") {
      if (code.trim() === "") return { index, action: { kind: "invalid", message: "The shell action is empty. Put the command on a new line after ```bash and close the block on its own line." } };
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
    case "look": {
      const where =
        action.url !== undefined
          ? action.url
          : action.ref !== undefined
            ? `ref=${action.ref}`
            : action.find !== undefined
              ? `find=${firstLine(action.find)}`
              : "snapshot";
      return `look: ${where}${action.image === true ? " +image" : ""}`;
    }
    case "finish":
      return "finish";
    case "delegate":
      return `delegate: ${firstLine(action.task)}`;
    case "mcp":
      return `mcp: ${action.tool}`;
    case "ask":
      return `ask: ${firstLine(action.question)}`;
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
  "You did not run anything between being asked to verify and finishing again — so nothing has been demonstrated. Run one command that actually proves the task is done and PASSES: the project's tests, the program itself, a check that reads back what you claim to have changed. A command that merely executes is not evidence — `ls` runs successfully and proves nothing. Show its real output, including its exit status if it is not obvious. If you genuinely cannot verify, say so explicitly in your finish message instead of implying success.";

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
