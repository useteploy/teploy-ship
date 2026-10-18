#!/usr/bin/env node
// ship-acp — the in-sandbox ACP driver (E7 H3, SHIP_ACP_HARNESS).
//
// Runs ONE whole Agent Client Protocol session inside ONE sandbox exec. Ship's
// exec has no stdin and is request/response, and ACP is bidirectional
// JSON-RPC 2.0 over stdio — so the bidirectional half lives HERE, inside the
// sandbox: this driver spawns the agent, speaks both directions on its behalf,
// answers permission requests itself from a fail-closed policy, and prints
// Ship's own JSONL events on stdout for the worker to parse.
//
//   initialize (protocolVersion 1)  ->  capabilities event (what was negotiated)
//   session/new   {cwd: workspace}  ->  session event
//   session/prompt {prompt}         ->  text / tool / permission events
//   session/update notifications    ->  text / tool events
//   session/request_permission      ->  answered by the policy below
//   prompt response {stopReason}    ->  usage + stop events
//
// Permission policy (fail-closed; see docs/adapters.md "ACP harnesses"):
//   read/search/think  allow when every location — and every path-like
//                      rawInput field (destination, newPath, path, filePath,
//                      target, file_path, absolute_path, dir_path, and each
//                      entry of paths[]) — canonicalises inside the
//                      workspace; a request naming nothing targets nothing
//                      and is allowed
//   edit/delete/move   allow only when EVERY location and path-like rawInput
//                      field canonicalises, through realpath, inside the
//                      workspace; no locations -> deny (rawInput cannot
//                      substitute for them)
//   execute            allow — the sandbox container is the boundary, the same
//                      authority decision every external harness makes
//   fetch              allow — the sandbox egress allowlist decides
//   anything else      deny
// allow is answered with the agent's allow_once option and deny with
// reject_once. allow_always is NEVER selected — it can outlive the session
// (Grok saves it for the whole project), and an allow that only exists as
// allow_always is turned into a deny.
//
// The agent process runs as a non-root user when the spec names one
// (spec.agentUser, resolved against /etc/passwd). The images bake no such user
// yet, so the worker sends none and the start event records the uid the agent
// actually ran as; H9 (registry images) is where the user lands.
//
// Credentials never appear in argv or in anything this prints: the driver
// scrubs the values (and their base64 forms) of the env names the spec lists
// out of every event and every relayed stderr byte before either leaves the
// sandbox. The worker scrubs again on its side of the boundary.
//
// Single file, no dependencies: it is baked into the sandbox images verbatim
// (images/build.sh copies it to /usr/local/bin/ship-acp).
//
// Portions derived from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.),
// v0.1.1-nightly.20261016.3218: the containment logic in
// packages/provider-acp/src/server/clientPolicy.ts, the session setup and
// cancel semantics of AcpSessionRuntime.ts, and the permission option
// selection of adapter.ts. See THIRD_PARTY.md.

import { spawn } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const SHIP_ACP_DRIVER_VERSION = "1.1.0";

/**
 * The protocol this driver speaks and the only version it accepts in an
 * initialize result. Every ACP agent the H0 receipts measured
 * (evals/receipts/2026-10-18-acp-*.txt) negotiated 1 — answering 2 to a
 * client offering 1 would violate the negotiation, so anything but 1 is an
 * error rather than a guess about a schema this driver has not read.
 */
export const SHIP_ACP_PROTOCOL_VERSION = 1;

/**
 * How long the agent has to honour a session/cancel before the driver kills
 * it (the tool-call budget backstop). A request, not a deadline: an agent
 * that ignores the cancel must not keep the exec — and the credential env it
 * holds — open until the run timeout. Overridable per exec via the spec's
 * cancelGraceMs (the worker's SHIP_ACP_CANCEL_GRACE_MS).
 */
export const ACP_CANCEL_GRACE_MS = 15_000;

const SPEC_DEFAULT = ".teploy-agent/acp-run.json";

const sleep = (ms) =>
  new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    timer.unref();
  });

// ---------------------------------------------------------------------------
// Credential scrubbing (exact-value, the same rule the worker applies)
// ---------------------------------------------------------------------------

/** Ported length floor from src/redact.ts: shorter values match ordinary output. */
export const EXACT_SCRUB_MIN_LENGTH = 8;

/** The strings to scrub for a set of env names: each value and its base64 form, longest first. */
function secretForms(names, env) {
  const forms = [];
  for (const name of names) {
    const value = env[name];
    if (typeof value !== "string" || value.length < EXACT_SCRUB_MIN_LENGTH) continue;
    forms.push({ needle: value, label: `[redacted ${name}]` });
    const encoded = Buffer.from(value, "utf8").toString("base64");
    if (encoded !== value) forms.push({ needle: encoded, label: `[redacted ${name} base64]` });
  }
  return forms.sort((a, b) => b.needle.length - a.needle.length);
}

function scrubber(forms) {
  return (text) => {
    let out = text;
    for (const { needle, label } of forms) {
      if (out.includes(needle)) out = out.split(needle).join(label);
    }
    return out;
  };
}

/**
 * A value cut off at the end of the text is still most of a credential: a
 * trailing prefix of at least EXACT_SCRUB_MIN_LENGTH characters is replaced
 * too (the rule src/redact.ts replaceTrailingPrefix applies).
 */
function scrubTrailingPrefix(text, forms) {
  for (const { needle, label } of forms) {
    for (let k = Math.min(needle.length - 1, text.length); k >= EXACT_SCRUB_MIN_LENGTH; k--) {
      if (text.endsWith(needle.slice(0, k))) return `${text.slice(0, text.length - k)}${label}`;
    }
  }
  return text;
}

/**
 * The same exact-value scrub over a stream that arrives in chunks: a chunk
 * boundary can split a value, so per-chunk scrubbing alone lets the halves
 * through. This holds back the last (longest needle - 1) characters until
 * the next chunk proves they are not the start of a secret, and `flush`
 * releases the remainder with a trailing prefix replaced — the worker's
 * exactScrubber (src/redact.ts) applied to the driver's stderr relay.
 */
function streamScrubber(forms, scrub) {
  const keep = forms.length === 0 ? 0 : Math.max(...forms.map((f) => f.needle.length)) - 1;
  let held = "";
  return {
    push(chunk) {
      if (forms.length === 0) return chunk;
      held = scrub(held + chunk);
      if (held.length <= keep) return "";
      const out = held.slice(0, held.length - keep);
      held = held.slice(held.length - keep);
      return out;
    },
    flush() {
      if (forms.length === 0) return held;
      const out = scrubTrailingPrefix(held, forms);
      held = "";
      return out;
    },
  };
}

/** Scrub every string in a JSON value. */
function scrubDeep(value, scrub) {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((entry) => scrubDeep(entry, scrub));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) out[key] = scrubDeep(entry, scrub);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Containment — ported from T3 Code clientPolicy.ts (MIT, T3 Tools Inc.)
// ---------------------------------------------------------------------------

/**
 * `realpath` cannot resolve a file that has not been created yet, so walk up
 * to the deepest existing ancestor and append the missing suffix to that
 * ancestor's canonical path. If an existing entry cannot be canonicalized
 * (for example, a broken symlink), fail closed (undefined).
 *
 * Do not lexically normalize before realpath. For a path such as
 * `workspace/link/../file`, the kernel resolves `link` before `..`; an eager
 * resolve() would erase that symlink traversal and could turn an outside
 * target into an apparently in-workspace path.
 */
export function acpCanonicalPathForContainment(path) {
  let candidate = path;
  const missingSuffix = [];
  for (;;) {
    try {
      return resolve(realpathSync.native(candidate), ...missingSuffix);
    } catch (cause) {
      if (cause?.code !== "ENOENT") return undefined;
    }
    try {
      lstatSync(candidate);
      return undefined;
    } catch (cause) {
      if (cause?.code !== "ENOENT") return undefined;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return undefined;
    missingSuffix.unshift(basename(candidate));
    candidate = parent;
  }
}

/** True when `path` (already canonical) is `root` or lives under it. */
export function acpPathIsWithinRoot(path, root) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Resolve a permission location against the session cwd; undefined when unusable. */
export function resolveAcpPermissionPath(path, cwd) {
  const trimmed = typeof path === "string" ? path.trim() : "";
  if (trimmed === "") return undefined;
  if (isAbsolute(trimmed)) return trimmed;
  if (typeof cwd !== "string" || cwd.trim() === "") return undefined;
  return `${cwd}${cwd.endsWith(sep) ? "" : sep}${trimmed}`;
}

/**
 * Path-like fields a tool puts in rawInput when the structured locations do
 * not carry them — camelCase, the snake_case spellings the gemini/qwen
 * tools use, and the array forms. A move is the case that matters: the
 * request names its SOURCE as a location and its destination ONLY in
 * rawInput — a policy that reads locations alone would let that
 * destination walk anywhere.
 */
export const ACP_RAW_INPUT_PATH_FIELDS = [
  "destination",
  "newPath",
  "path",
  "filePath",
  "target",
  "file_path",
  "absolute_path",
  "dir_path",
];

/** rawInput fields that carry a LIST of paths, gated entry by entry. */
export const ACP_RAW_INPUT_PATH_ARRAY_FIELDS = ["paths"];

/** The path-like rawInput values of a permission request, each with the field it came from. */
export function acpRawInputPathCandidates(rawInput) {
  if (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput)) return [];
  const out = [];
  for (const field of ACP_RAW_INPUT_PATH_FIELDS) {
    const value = rawInput[field];
    if (typeof value === "string" && value.trim() !== "") out.push({ path: value, origin: `rawInput ${field}` });
  }
  for (const field of ACP_RAW_INPUT_PATH_ARRAY_FIELDS) {
    const value = rawInput[field];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string" && entry.trim() !== "") out.push({ path: entry, origin: `rawInput ${field}[]` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The permission policy
// ---------------------------------------------------------------------------

export const ACP_READ_KINDS = new Set(["read", "search", "think"]);
export const ACP_MUTATION_KINDS = new Set(["edit", "delete", "move"]);
/**
 * Kinds whose boundary is elsewhere: the sandbox container (execute) and the
 * egress allowlist (fetch) — the change-phase row of the design note's
 * permission table. Everything the table does not name is denied.
 */
export const ACP_UNGATED_KINDS = new Set(["execute", "fetch"]);

/**
 * The fail-closed disposition for one permission request, given the canonical
 * workspace root, the tool kind, the location paths as the agent wrote them
 * and the request's rawInput. Path-like rawInput fields (destination,
 * newPath, path, filePath, target, file_path, absolute_path, dir_path and
 * each entry of paths[] — acpRawInputPathCandidates) are gated with the same
 * workspace check as locations, so a tool that names its target only in
 * rawInput cannot walk outside either. Returns allow/deny with a reason the
 * run records verbatim.
 */
export function acpPermissionDecision({ workspaceRoot, cwd, kind, locations, rawInput }) {
  const paths = Array.isArray(locations) ? locations.map((l) => (typeof l === "string" ? l : l?.path)) : [];
  const rawCandidates = acpRawInputPathCandidates(rawInput);
  const candidates = [
    ...paths.map((path) => ({ path, origin: "location" })),
    ...rawCandidates.map(({ path, origin }) => ({ path, origin })),
  ];
  const kindText = typeof kind === "string" && kind !== "" ? kind : "other";
  const contained = (path, origin) => {
    const resolvedPath = resolveAcpPermissionPath(path, cwd);
    if (resolvedPath === undefined) return `${origin} "${path}" is unusable`;
    const canonical = acpCanonicalPathForContainment(resolvedPath);
    if (canonical === undefined) return `${origin} "${path}" does not canonicalize (broken symlink or unresolvable)`;
    if (!acpPathIsWithinRoot(canonical, workspaceRoot)) return `${origin} "${path}" is outside the workspace`;
    return null;
  };
  if (ACP_UNGATED_KINDS.has(kindText)) {
    return {
      decision: "allow",
      reason: kindText === "execute" ? "execute: the sandbox container is the boundary" : "fetch: the egress allowlist decides",
    };
  }
  if (ACP_READ_KINDS.has(kindText)) {
    if (candidates.length === 0) return { decision: "allow", reason: "read with no locations: nothing outside the workspace is named" };
    for (const candidate of candidates) {
      const denial = contained(candidate.path, candidate.origin);
      if (denial !== null) return { decision: "deny", reason: `read denied: ${denial}` };
    }
    return { decision: "allow", reason: "read inside the workspace" };
  }
  if (ACP_MUTATION_KINDS.has(kindText)) {
    // No locations is denied even when rawInput names paths: the driver
    // cannot know the tool honours rawInput over locations, and an edit the
    // driver cannot see the target of is not an edit it can allow.
    if (paths.length === 0) return { decision: "deny", reason: `${kindText} with no locations is denied` };
    for (const candidate of candidates) {
      const denial = contained(candidate.path, candidate.origin);
      if (denial !== null) return { decision: "deny", reason: `${kindText} denied: ${denial}` };
    }
    return { decision: "allow", reason: `${kindText} inside the workspace (symlink-safe)` };
  }
  return { decision: "deny", reason: `unknown or ungated tool kind "${kindText}" is denied` };
}

/**
 * The option to answer with, ported from T3's adapter.ts selection with the
 * allow-always arm REMOVED: allow answers allow_once only (an allow that only
 * exists as allow_always is refused — the caller turns it into a deny), deny
 * answers reject_once. Undefined means no option of the wanted kind was
 * offered; the caller must then answer `cancelled`, never a broader grant.
 */
export function acpPermissionOptionId(options, decision) {
  const want = decision === "allow" ? "allow_once" : "reject_once";
  const found = (Array.isArray(options) ? options : []).find(
    (option) =>
      option !== null &&
      typeof option === "object" &&
      option.kind === want &&
      typeof option.optionId === "string" &&
      option.optionId.trim() !== "",
  );
  return found === undefined ? undefined : found.optionId.trim();
}

// ---------------------------------------------------------------------------
// The driver proper
// ---------------------------------------------------------------------------

function emit(type, fields, scrub) {
  process.stdout.write(`${JSON.stringify(scrubDeep({ type, ...fields }, scrub))}\n`);
}

function fail(message, scrub) {
  emit("error", { message }, scrub);
  process.exitCode = 1;
}

/**
 * Resolve a username against /etc/passwd to {uid, gid, home}, or undefined.
 * Ship's current sandbox images define no unprivileged user (they run the
 * exec as root); the worker sends no agentUser until an image carries one
 * (H9), and the start event records which uid the agent actually ran as.
 */
function agentUserInfo(name) {
  if (typeof name !== "string" || name.trim() === "") return undefined;
  try {
    const passwd = readFileSync("/etc/passwd", "utf8");
    for (const line of passwd.split("\n")) {
      const fields = line.split(":");
      if (fields[0] !== name.trim()) continue;
      const uid = Number(fields[2]);
      const gid = Number(fields[3]);
      if (!Number.isInteger(uid) || !Number.isInteger(gid)) return undefined;
      return { uid, gid, home: fields[5] ?? "", user: fields[0] };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  const specPath = process.argv[2] ?? SPEC_DEFAULT;
  let spec;
  try {
    spec = JSON.parse(readFileSync(specPath, "utf8"));
  } catch (error) {
    process.stderr.write(`ship-acp: cannot read spec ${specPath}: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
    return;
  }
  const workspaceInput = typeof spec.cwd === "string" && spec.cwd.trim() !== "" ? spec.cwd : ".";
  const workspaceRoot = acpCanonicalPathForContainment(resolve(workspaceInput)) ?? resolve(workspaceInput);
  const forms = secretForms(Array.isArray(spec.secretEnvNames) ? spec.secretEnvNames : [], process.env);
  const scrub = scrubber(forms);
  const stderrScrub = streamScrubber(forms, scrub);
  const binary = spec.binary;
  const args = Array.isArray(spec.args) ? spec.args : [];
  if (typeof binary !== "string" || binary.trim() === "") {
    fail("spec names no agent binary", scrub);
    return;
  }
  const maxSteps = Number.isInteger(spec.maxSteps) && spec.maxSteps > 0 ? spec.maxSteps : null;
  const cancelGraceMs = Number.isFinite(spec.cancelGraceMs) && spec.cancelGraceMs > 0 ? spec.cancelGraceMs : ACP_CANCEL_GRACE_MS;
  // The exec request's own timeout is the hard boundary; the driver keeps a
  // backstop just inside it so the run records a driver error instead of a
  // killed process, whenever the agent stalls before answering.
  const deadlineMs = Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 20_000 ? spec.timeoutMs - 5_000 : null;

  const asUser = agentUserInfo(spec.agentUser);
  const child = spawn(binary, args, {
    cwd: workspaceRoot,
    stdio: ["pipe", "pipe", "pipe"],
    // The agent runs detached, in a process group of its own, so a kill can
    // reach the whole tree and not just the agent process (killChild below):
    // a background process the agent spawned without its own session must
    // not outlive the exec that holds the credential env.
    detached: true,
    // TODO(H9): this branch must keep the per-exec HOME. The worker pins HOME
    // — and the vendor home vars — at a fresh 700 directory under /tmp that
    // the exec's own shell deletes on exit (harness-acp.ts agentHomeCommand);
    // trading it for the passwd home would put the vendor session store
    // (tool output, possibly secrets) back into the container, exactly what
    // the per-exec home exists to prevent. When an image bakes an unprivileged
    // user, spawn with process.env.HOME and make the worker chown the
    // directory to that uid. The passwd home is where the BINARY is
    // installed, not where its state belongs.
    ...(asUser !== undefined ? { uid: asUser.uid, gid: asUser.gid, env: { ...process.env, HOME: asUser.home } } : {}),
  });

  let sessionId = null;
  let sessionEnded = null; // { stopReason, by }
  let budgetCancelled = false;
  let agentExited = false;
  const toolCalls = new Set();
  const startedAt = Date.now();
  let stderrTail = "";

  emit("start", {
    driver: SHIP_ACP_DRIVER_VERSION,
    profile: spec.profile ?? null,
    workspace: workspaceRoot,
    agent: {
      binary,
      args,
      ...(asUser !== undefined ? { user: asUser.user, uid: asUser.uid, gid: asUser.gid } : { uid: typeof process.getuid === "function" ? process.getuid() : null }),
    },
  }, scrub);

  child.stderr.on("data", (chunk) => {
    // Relayed through the stream scrubber, not scrub() per chunk: the agent
    // writes its stderr in arbitrarily-split chunks, and a credential the
    // agent printed whole on one line would otherwise leave this sandbox as
    // two unrecognised halves.
    const text = stderrScrub.push(String(chunk));
    stderrTail = (stderrTail + text).slice(-4096);
    process.stderr.write(`[agent stderr] ${text}`);
  });
  /** Release the scrubber's held-back tail once the agent's stderr is closed. */
  const relayStderrTail = () => {
    const text = stderrScrub.flush();
    if (text === "") return;
    stderrTail = (stderrTail + text).slice(-4096);
    process.stderr.write(`[agent stderr] ${text}`);
  };

  let nextId = 1;
  const pending = new Map();
  const request = (method, params) =>
    new Promise((resolveRequest, rejectRequest) => {
      const id = nextId++;
      const onDeadline =
        deadlineMs === null
          ? null
          : setTimeout(() => {
              pending.delete(id);
              rejectRequest(new Error(`${method} did not answer within the driver deadline`));
            }, Math.max(0, deadlineMs - (Date.now() - startedAt)));
      if (onDeadline !== null) onDeadline.unref();
      pending.set(id, { resolveRequest, rejectRequest });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };
  const respond = (id, result) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  };
  const respondError = (id, code, message) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
  };

  /**
   * Signal the agent's whole process GROUP (negative pid: the agent was
   * spawned detached as its group leader, so the group is the agent plus
   * every background process it spawned without its own session). Never
   * gated on agentExited: an agent that exits on its own can leave a
   * same-group background process alive (a `sleep 40 &` it spawned), and
   * that survivor holds the exec's credential env — ESRCH from the group
   * kill only means the group is already gone. The child-only fallback is
   * for a platform that refuses group signals while the agent still lives.
   */
  const signalAgentGroup = (signal) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      if (agentExited) return;
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    }
  };
  const killChild = () => {
    if (child.pid === undefined) return;
    signalAgentGroup("SIGTERM");
    // The escalation for a group that traps or ignores SIGTERM. This timer
    // serves the paths the driver OUTLIVES (the budget backstop); finish()
    // fires the same kill itself, because an unref'd timer never runs after
    // process.exit.
    const force = setTimeout(() => signalAgentGroup("SIGKILL"), 3_000);
    force.unref();
  };
  const exited = new Promise((resolveExit) => child.on("exit", (code, signal) => resolveExit({ code, signal })));
  /**
   * The one exit path. A background grandchild that inherited the agent's
   * stdio keeps those pipes — and with them this process — alive long after
   * the agent itself exited, so after the kill race the driver destroys the
   * streams and exits explicitly: the exec that carries the credential env
   * must end when the session does, not when the agent's process tree
   * happens to. Everything meant for the record was written before this is
   * called. The group SIGKILL at the end is the one that always happens: a
   * grandchild that trapped SIGTERM survives the TERM above, and this
   * process exits before the unref'd 3s timer ever fires.
   */
  const finish = async (code) => {
    killChild();
    await Promise.race([exited, sleep(5_000)]);
    relayStderrTail();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    signalAgentGroup("SIGKILL");
    process.exit(code);
  };
  child.on("exit", (code, signal) => {
    agentExited = true;
    // Every request still waiting dies with the agent: an EPIPE on the next
    // stdin write must not become an unhandled stream error, and a hang must
    // not stand in for an answer.
    for (const [id, { rejectRequest }] of pending) {
      pending.delete(id);
      rejectRequest(new Error(`the agent exited before answering (code ${code ?? "null"}${signal !== null ? `, signal ${signal}` : ""})`));
    }
  });
  // A write against a dead agent's closed stdin: the exit handler above has
  // already rejected everything worth rejecting.
  child.stdin.on("error", () => {});
  child.on("error", (error) => {
    if (sessionEnded === null) fail(`cannot spawn ${binary}: ${error.message}`, scrub);
    killChild();
  });

  /**
   * authenticate + retry, ported from T3 AcpSessionRuntime's auth_required
   * path: the configured method is authoritative, a method the agent did not
   * advertise is an error, and a method that needs a terminal or browser is
   * refused as impossible headless (AcpSessionRuntime.ts:2125-2167).
   */
  const authenticateAfterRequired = async (configuredMethodId, authMethods, error) => {
    if (typeof configuredMethodId !== "string" || configuredMethodId.trim() === "") {
      throw new Error(`the agent requires authentication but the profile configures no method: ${error.message}`);
    }
    const methodId = configuredMethodId.trim();
    if (Array.isArray(authMethods)) {
      const advertised = authMethods.find((method) => method !== null && typeof method === "object" && method.id === methodId);
      if (advertised === undefined) {
        throw new Error(`the agent did not advertise the profile's authentication method "${methodId}"`);
      }
      if (typeof advertised.type === "string" && advertised.type !== "agent") {
        throw new Error(`authentication method "${methodId}" requires ${advertised.type} authentication, which cannot run inside a headless sandbox`);
      }
    }
    await request("authenticate", { methodId });
  };

  const handleServerRequest = (message) => {
    if (message.method === "session/request_permission") {
      const toolCall = message.params?.toolCall ?? {};
      const locations = Array.isArray(toolCall.locations) ? toolCall.locations : [];
      const verdict = acpPermissionDecision({ workspaceRoot, cwd: workspaceRoot, kind: toolCall.kind, locations, rawInput: toolCall.rawInput });
      // allow with no allow_once option becomes a DENY: never allow_always.
      let decision = verdict.decision;
      let optionId = acpPermissionOptionId(message.params?.options, decision);
      let reason = verdict.reason;
      if (decision === "allow" && optionId === undefined) {
        decision = "deny";
        reason = `${verdict.reason}, but the agent offered no allow-once option — an allow-always grant outlives the session, so this is a deny`;
        optionId = acpPermissionOptionId(message.params?.options, "deny");
      }
      emit(
        "permission",
        {
          kind: typeof toolCall.kind === "string" && toolCall.kind !== "" ? toolCall.kind : "other",
          title: typeof toolCall.title === "string" ? toolCall.title : "",
          locations: locations.map((l) => (typeof l?.path === "string" ? l.path : null)).filter((p) => p !== null),
          decision,
          optionKind: decision === "allow" ? "allow_once" : "reject_once",
          optionId: optionId ?? null,
          reason,
        },
        scrub,
      );
      if (optionId === undefined) {
        respond(message.id, { outcome: { outcome: "cancelled" } });
        return;
      }
      respond(message.id, { outcome: { outcome: "selected", optionId } });
      return;
    }
    // Elicitation (session/request_input) and anything else a headless client
    // cannot answer: cancelled, never guessed at.
    if (message.method === "session/request_input") {
      respond(message.id, { outcome: { outcome: "cancelled" } });
      return;
    }
    respondError(message.id, -32601, `ship-acp does not answer ${message.method}`);
  };

  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.trim() === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // Redact BEFORE truncating: truncation first would cut a credential
        // that straddles the cap in two, and the surviving half is secret
        // material no later pass can recognise. Redacted first, the cap can
        // only ever cut a [redacted …] marker, which is harmless.
        process.stderr.write(`[agent stdout, non-JSON] ${scrub(line).slice(0, 500)}\n`);
        continue;
      }
      if (message?.jsonrpc === "2.0" && message.id !== undefined && message.method !== undefined) {
        handleServerRequest(message);
        continue;
      }
      if (message?.jsonrpc === "2.0" && message.id !== undefined && pending.has(message.id)) {
        const { resolveRequest, rejectRequest } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error !== undefined) {
          rejectRequest(Object.assign(new Error(message.error.message ?? "agent error"), { acpError: message.error }));
        } else {
          resolveRequest(message.result ?? {});
        }
        continue;
      }
      if (message?.jsonrpc === "2.0" && message.method === "session/update") {
        const update = message.params?.update ?? {};
        if (update.sessionUpdate === "agent_message_chunk") {
          const content = update.content;
          if (content?.type === "text" && typeof content.text === "string" && content.text !== "") {
            emit("text", { messageId: typeof update.messageId === "string" ? update.messageId : null, text: content.text }, scrub);
          }
        } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
          if (typeof update.toolCallId === "string" && update.toolCallId !== "") toolCalls.add(update.toolCallId);
          const locations = Array.isArray(update.locations) ? update.locations : [];
          emit(
            "tool",
            {
              toolCallId: typeof update.toolCallId === "string" ? update.toolCallId : "",
              kind: typeof update.kind === "string" ? update.kind : null,
              title: typeof update.title === "string" ? update.title : "",
              status: typeof update.status === "string" ? update.status : null,
              locations: locations.map((l) => (typeof l?.path === "string" ? l.path : null)).filter((p) => p !== null),
            },
            scrub,
          );
          if (maxSteps !== null && !budgetCancelled && toolCalls.size >= maxSteps && sessionEnded === null) {
            budgetCancelled = true;
            notify("session/cancel", { sessionId });
            // A cancel is a request. An agent that ignores it must not keep
            // the exec (and the credential env it holds) open until the run
            // timeout: after the grace the driver kills the agent and
            // records the budget stop itself (the catch below).
            const grace = setTimeout(() => killChild(), cancelGraceMs);
            grace.unref();
          }
        }
        // Other updates (plans, thoughts, user echoes) are not Ship events.
        continue;
      }
      // Unknown notifications are ignored, not guessed at.
    }
  });

  try {
    const init = await request("initialize", {
      protocolVersion: SHIP_ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    if (init.protocolVersion !== SHIP_ACP_PROTOCOL_VERSION) {
      throw new Error(
        `agent negotiated ACP protocolVersion ${JSON.stringify(init.protocolVersion)}; ship-acp speaks ${SHIP_ACP_PROTOCOL_VERSION} only`,
      );
    }
    emit(
      "capabilities",
      {
        offered: SHIP_ACP_PROTOCOL_VERSION,
        protocolVersion: init.protocolVersion,
        agentInfo: init.agentInfo ?? null,
        agentCapabilities: init.agentCapabilities ?? null,
        authMethods: Array.isArray(init.authMethods) ? init.authMethods : [],
      },
      scrub,
    );

    const createSession = async () => {
      try {
        return await request("session/new", { cwd: workspaceRoot });
      } catch (error) {
        if (error.acpError?.code !== -32000) throw error;
        await authenticateAfterRequired(spec.authMethodId, init.authMethods, error);
        return await request("session/new", { cwd: workspaceRoot });
      }
    };
    const created = await createSession();
    if (typeof created.sessionId !== "string" || created.sessionId === "") throw new Error("session/new returned no sessionId");
    sessionId = created.sessionId;
    emit("session", { sessionId }, scrub);

    let promptText;
    try {
      promptText = readFileSync(
        resolve(workspaceRoot, typeof spec.promptPath === "string" && spec.promptPath !== "" ? spec.promptPath : ".teploy-agent/acp-prompt.md"),
        "utf8",
      );
    } catch (error) {
      throw new Error(`cannot read the prompt file: ${error instanceof Error ? error.message : String(error)}`);
    }
    const sendPrompt = async () => {
      try {
        return await request("session/prompt", { sessionId, prompt: [{ type: "text", text: promptText }] });
      } catch (error) {
        if (error.acpError?.code !== -32000) throw error;
        await authenticateAfterRequired(spec.authMethodId, init.authMethods, error);
        return await request("session/prompt", { sessionId, prompt: [{ type: "text", text: promptText }] });
      }
    };
    const response = await sendPrompt();
    if (response.usage !== undefined && response.usage !== null) emit("usage", { usage: response.usage }, scrub);
    const stopReason = typeof response.stopReason === "string" && response.stopReason !== "" ? response.stopReason : "end_turn";
    const byDriver = budgetCancelled && stopReason === "cancelled";
    sessionEnded = { stopReason: byDriver ? "max_turn_requests" : stopReason, by: byDriver ? "driver-budget" : "agent" };
    emit("stop", { reason: sessionEnded.stopReason, by: sessionEnded.by }, scrub);
    await finish(0);
  } catch (error) {
    if (budgetCancelled && sessionEnded === null) {
      // The grace timer killed an agent that ignored session/cancel. The
      // budget is still the truth about why the session ended, so the stop
      // is the driver-budget one — not an "exited before answering" error an
      // operator would have to decode back into a budget stop.
      sessionEnded = { stopReason: "max_turn_requests", by: "driver-budget" };
      emit("stop", { reason: sessionEnded.stopReason, by: sessionEnded.by }, scrub);
      await finish(0);
      return;
    }
    if (sessionEnded === null) {
      const tailText = stderrTail.trim();
      fail(
        `${error instanceof Error ? error.message : String(error)}${tailText !== "" ? ` (agent stderr tail: ${tailText.slice(-800)})` : ""}`,
        scrub,
      );
      emit("stop", { reason: "refusal", by: "driver" }, scrub);
    }
    await finish(1);
  }
}

// --version for image builds; the module guard keeps the exports importable by tests.
const invokedAsScript =
  process.argv[1] !== undefined &&
  (() => {
    try {
      return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
    } catch {
      return false;
    }
  })();
if (invokedAsScript) {
  if (process.argv[2] === "--version") {
    process.stdout.write(`ship-acp ${SHIP_ACP_DRIVER_VERSION}\n`);
  } else {
    await main();
  }
}
