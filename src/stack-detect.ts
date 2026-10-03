/**
 * Stack and service detection (S05). A PURE function over a repository file
 * listing plus the text of well-known manifests that the caller already read:
 * no filesystem, no network, no model. It answers "what is this repo, what
 * services does it declare, and what preparation/test/start commands does the
 * repo itself justify", and nothing more.
 *
 * Rules that shape every line below:
 *  - A proposal is only ever built from a command the repo's own files justify,
 *    and cites that file and line. Where the evidence is absent or ambiguous the
 *    field is reported `unknown` and NOTHING is proposed. We never guess.
 *  - Conflicting signals (two lockfiles, poetry + requirements.txt, maven +
 *    gradle, two stacks both wanting to own `preparation`) are reported as a
 *    conflict carrying every option; no option is silently preferred.
 *  - Repo text is untrusted. A proposal that would run a script body containing
 *    shell metacharacters, network fetches, lifecycle hooks etc. is still
 *    reported (the repo owner may want it) but is marked `safety: "review"` with
 *    the reasons, and the validation plan makes it `requiresApproval`. Evidence
 *    text is JSON-quoted so control characters and escapes are never replayed.
 *  - The validation plan is deterministic: ordered commands, timeouts and what
 *    pass/fail means. It never needs a model, so an environment that cannot be
 *    prepared is told apart from code that fails its tests BEFORE paid diagnosis.
 *  - `readinessInputsDigest` hashes the recorded inputs so a later check can say
 *    `stale` the moment a manifest, lockfile, image or recipe changes.
 *
 * Not wired into any route or run; see the wiring points in the PR description.
 */
import { createHash } from "node:crypto";

export type StackId =
  | "node" | "python" | "go" | "rust" | "java" | "ruby" | "php" | "static" | "docker";
export type CommandField = "preparation" | "test" | "start";

export interface Evidence {
  file: string;
  /** 1-based line the claim came from, when a line could be located. */
  line?: number;
  /** JSON-quoted, truncated source text (never raw, so metacharacters stay inert). */
  text: string;
  claim: string;
}
export interface Proposal {
  field: CommandField;
  command: string;
  timeoutMs: number;
  stack: StackId | "procfile";
  /** Tool the command runs through (pnpm, poetry, mvn...), for conflict display. */
  tool?: string;
  source: Evidence;
  /** "review" = executes repo-authored text that needs a human look first. */
  safety: "safe" | "review";
  flags: string[];
}
export interface Conflict {
  field: CommandField;
  reason: string;
  options: Proposal[];
}
export interface UnknownItem {
  field: CommandField | "stack";
  reason: string;
}
export interface DetectedStack {
  id: StackId;
  version?: { value: string; source: Evidence };
  evidence: Evidence[];
}
export interface DetectedService {
  kind: string;
  name: string;
  image?: string;
  tag?: string;
  /** false = inferred from a hint such as .env.example, not declared in compose. */
  declared: boolean;
  source: Evidence;
  risks: string[];
}
export interface Monorepo {
  kinds: string[];
  evidence: Evidence[];
  packages: string[];
}
export interface ValidationStep {
  id: string;
  phase: CommandField;
  command: string;
  timeoutMs: number;
  /** exit-0: pass = exit 0. alive-at-timeout: pass = still running when the window ends. */
  expect: "exit-0" | "alive-at-timeout";
  pass: string;
  fail: string;
  /** Failure class decides whether paid diagnosis is even meaningful. */
  failureClass: "environment" | "repository";
  requiresApproval: boolean;
  source: Evidence;
}
export interface ValidationPlan {
  /** Constant: nothing in the plan needs a model. */
  needsModel: false;
  steps: ValidationStep[];
  servicesRequired: string[];
  /** Fields that have no single command: the plan cannot cover them until resolved. */
  blockedBy: { field: CommandField; reason: string }[];
}
export interface StackDetection {
  stacks: DetectedStack[];
  services: DetectedService[];
  monorepo?: Monorepo;
  proposals: { preparation?: Proposal; test?: Proposal; start?: Proposal };
  conflicts: Conflict[];
  evidence: Evidence[];
  confidence: "none" | "low" | "medium" | "high";
  unknown: UnknownItem[];
  validation: ValidationPlan;
}
export interface DetectInput {
  /** Repository-relative file paths (any depth). */
  files: readonly string[];
  /** Text of manifests, keyed by repository-relative path. Missing = not read. */
  manifests: Readonly<Record<string, string>>;
}

/** Root-level files whose text is worth reading; the caller fetches these. */
export const WELL_KNOWN_MANIFESTS: readonly string[] = [
  "package.json", "pnpm-workspace.yaml", ".nvmrc", ".node-version",
  "pyproject.toml", "requirements.txt", "Pipfile", "pytest.ini", "tox.ini", ".python-version",
  "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
  "Gemfile", ".ruby-version", "composer.json", "Procfile", "Dockerfile",
  "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", ".env.example", ".env.sample",
];
/** Lockfiles: hashed into readiness, never parsed here. */
export const WELL_KNOWN_LOCKFILES: readonly string[] = [
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "uv.lock", "poetry.lock", "Pipfile.lock", "Cargo.lock", "Gemfile.lock", "composer.lock", "go.sum", "gradle.lockfile",
];

/** Which of the well-known manifest/lockfile paths exist, i.e. what to read and record. */
export function inputPathsToRead(files: readonly string[]): { manifests: string[]; lockfiles: string[] } {
  const set = new Set(files.map(normPath));
  return {
    manifests: WELL_KNOWN_MANIFESTS.filter((p) => set.has(p)),
    lockfiles: WELL_KNOWN_LOCKFILES.filter((p) => set.has(p)),
  };
}

// ---------------------------------------------------------------- helpers

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}
const clip = (s: string, n = 160) => (s.length > n ? s.slice(0, n) + "..." : s);
/** JSON-quote so control characters and escapes are visible, never replayed. */
const quoted = (s: string) => JSON.stringify(clip(s));

/** 1-based line of the first match at or after `from` (0-based line index). */
function lineOf(text: string | undefined, pat: RegExp | string, from = 0): number | undefined {
  if (text === undefined) return undefined;
  const lines = text.split(/\r\n|\n|\r/);
  for (let i = from; i < lines.length; i++) {
    if (typeof pat === "string" ? lines[i].includes(pat) : pat.test(lines[i])) return i + 1;
  }
  return undefined;
}
function lineText(text: string | undefined, line: number | undefined): string {
  if (text === undefined || line === undefined) return "";
  return text.split(/\r\n|\n|\r/)[line - 1] ?? "";
}
function ev(file: string, text: string | undefined, line: number | undefined, claim: string): Evidence {
  return { file, ...(line !== undefined ? { line } : {}), text: quoted(lineText(text, line) || file), claim };
}

/**
 * Flags for shell text that a repo authored and we would end up executing.
 * `&&` alone is ordinary (`tsc && node --test`) and is not flagged.
 */
export function scanShell(body: string): string[] {
  const f: string[] = [];
  if (/`|\$\(/.test(body)) f.push("command-substitution");
  if (/\$[A-Za-z_{]/.test(body)) f.push("variable-expansion");
  if (/;/.test(body)) f.push("command-separator");
  if (/\|\|/.test(body)) f.push("or-chain");
  if (/(?<!\|)\|(?!\|)/.test(body)) f.push("pipe");
  if (/[<>]/.test(body)) f.push("redirect");
  if (/(?<!&)&(?!&)/.test(body)) f.push("background");
  if (/[\r\n]/.test(body)) f.push("multi-line");
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body)) f.push("control-characters");
  if (/\b(curl|wget|nc|ncat)\b/.test(body)) f.push("network-fetch");
  if (/\b(eval|(?:ba|z)?sh\s+-c)\b/.test(body)) f.push("eval");
  if (/\brm\s+-[a-zA-Z]*[rf]|\bsudo\b|\bmkfs\b|\bdd\s+if=|\bchmod\s+-R\b/.test(body)) f.push("destructive");
  return f;
}

interface Ctx {
  files: Set<string>;
  text: (path: string) => string | undefined;
  has: (path: string) => boolean;
  textsByPath: () => Record<string, string>;
}
type Cand = Proposal;

function mk(
  field: CommandField, stack: Cand["stack"], tool: string | undefined, command: string, timeoutMs: number,
  source: Evidence, executedRepoText: string[] = [],
): Cand {
  const flags = new Set<string>();
  for (const t of executedRepoText) for (const x of scanShell(t)) flags.add(x);
  const fl = [...flags];
  return { field, command, timeoutMs, stack, ...(tool ? { tool } : {}), source, safety: fl.length ? "review" : "safe", flags: fl };
}

interface PartialStack {
  stack: DetectedStack;
  cands: Cand[];
  /** Explicit conflicts found inside the stack (field -> reason). */
  conflicts: { field: CommandField; reason: string }[];
  unknown: UnknownItem[];
  monorepo?: { kinds: string[]; evidence: Evidence[] };
}

function addMono(out: PartialStack, kind: string, e: Evidence): void {
  out.monorepo = { kinds: [...(out.monorepo?.kinds ?? []), kind], evidence: [...(out.monorepo?.evidence ?? []), e] };
}

// ------------------------------------------------------------------- node

function parseJson(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
const own = (o: object | undefined, k: string): unknown =>
  o && Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined;

/** npm's own default placeholder: not a test command. */
const NPM_PLACEHOLDER = /no test specified/i;

function scriptLine(text: string, name: string): number | undefined {
  const s = lineOf(text, /"scripts"\s*:/);
  return lineOf(text, new RegExp(`^\\s*${JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`), s ? s - 1 : 0);
}

function detectNode(c: Ctx): PartialStack | undefined {
  if (!c.has("package.json")) return undefined;
  const text = c.text("package.json");
  const out: PartialStack = {
    stack: { id: "node", evidence: [ev("package.json", text, 1, "package.json present")] },
    cands: [], conflicts: [], unknown: [],
  };
  const pkg = parseJson(text);
  if (text !== undefined && !pkg) {
    out.unknown.push({ field: "stack", reason: "package.json is not valid JSON; nothing proposed from it" });
    return out;
  }
  const scripts = (own(pkg, "scripts") && typeof own(pkg, "scripts") === "object" ? own(pkg, "scripts") : {}) as Record<string, unknown>;
  const script = (n: string): string | undefined => {
    const v = own(scripts, n);
    return typeof v === "string" ? v : undefined;
  };

  // version hints
  const engines = own(pkg, "engines") as Record<string, unknown> | undefined;
  const nodeEngine = own(engines, "node");
  if (c.has(".nvmrc") || c.has(".node-version")) {
    const f = c.has(".nvmrc") ? ".nvmrc" : ".node-version";
    const v = (c.text(f) ?? "").trim().split(/\r?\n/)[0];
    if (v) out.stack.version = { value: v, source: ev(f, c.text(f), 1, "node version pin") };
  } else if (typeof nodeEngine === "string" && text) {
    out.stack.version = { value: nodeEngine, source: ev("package.json", text, lineOf(text, '"node"'), "engines.node") };
  }

  // workspaces
  const ws = own(pkg, "workspaces");
  if (ws !== undefined && text) {
    addMono(out, "npm-workspaces", ev("package.json", text, lineOf(text, '"workspaces"'), "package.json workspaces"));
  }
  if (c.has("pnpm-workspace.yaml")) {
    addMono(out, "pnpm-workspace", ev("pnpm-workspace.yaml", c.text("pnpm-workspace.yaml"), 1, "pnpm-workspace.yaml present"));
  }
  for (const f of ["turbo.json", "nx.json", "lerna.json"]) {
    if (c.has(f)) addMono(out, f.replace(".json", ""), ev(f, c.text(f), 1, `${f} present`));
  }

  // package manager: lockfiles and the packageManager field
  interface Pm { pm: "npm" | "pnpm" | "yarn" | "bun"; locked: boolean; berry?: boolean; src: Evidence }
  const lockMap: [string, Pm["pm"]][] = [
    ["package-lock.json", "npm"], ["npm-shrinkwrap.json", "npm"], ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"],
  ];
  const found: Pm[] = [];
  const berryFile = c.has(".yarnrc.yml");
  for (const [f, pm] of lockMap) {
    if (c.has(f) && !found.some((x) => x.pm === pm))
      found.push({ pm, locked: true, berry: pm === "yarn" ? berryFile : undefined, src: ev(f, c.text(f), 1, `${f} present`) });
  }
  const pmField = own(pkg, "packageManager");
  let fieldPm: Pm | undefined;
  if (typeof pmField === "string" && text) {
    const m = /^(npm|pnpm|yarn|bun)@(\d+)/.exec(pmField);
    if (m) {
      fieldPm = {
        pm: m[1] as Pm["pm"], locked: false, berry: m[1] === "yarn" ? Number(m[2]) >= 2 : undefined,
        src: ev("package.json", text, lineOf(text, '"packageManager"'), "packageManager field"),
      };
    }
  }
  let options: Pm[] = found;
  let conflictReason: string | undefined;
  if (found.length > 1) conflictReason = `multiple lockfiles: ${found.map((f) => f.src.file).join(", ")}`;
  else if (found.length === 1 && fieldPm && fieldPm.pm !== found[0].pm) {
    options = [found[0], { ...fieldPm, locked: false }];
    conflictReason = `packageManager field says ${fieldPm.pm} but the lockfile is ${found[0].src.file}`;
  } else if (found.length === 1 && fieldPm) {
    found[0].berry = found[0].berry ?? fieldPm.berry;
  } else if (found.length === 0 && fieldPm) options = [fieldPm];

  if (options.length === 0) {
    for (const f of ["preparation", "test", "start"] as const)
      out.unknown.push({ field: f, reason: "no lockfile and no packageManager field, so the package manager is unknown" });
    return out;
  }
  const hostileLife = ["preinstall", "install", "postinstall", "prepare"].flatMap((n) => (script(n) ? [script(n)!] : []));
  for (const o of options) {
    const prep = o.pm === "npm" ? (o.locked ? "npm ci" : "npm install")
      : o.pm === "pnpm" ? (o.locked ? "pnpm install --frozen-lockfile" : "pnpm install")
      : o.pm === "yarn" ? (o.berry ? "yarn install --immutable" : o.locked ? "yarn install --frozen-lockfile" : "yarn install")
      : (o.locked ? "bun install --frozen-lockfile" : "bun install");
    out.cands.push(mk("preparation", "node", o.pm, prep, 300_000, o.src, hostileLife));
    const run = (n: string) => (o.pm === "bun" ? `bun run ${n}` : `${o.pm} ${n}`);
    const t = script("test");
    if (t !== undefined && !NPM_PLACEHOLDER.test(t) && text) {
      const hooks = [script("pretest"), script("posttest")].filter((x): x is string => !!x);
      out.cands.push(mk("test", "node", o.pm, run("test"), 300_000,
        ev("package.json", text, scriptLine(text, "test"), `scripts.test = ${quoted(t)}`), [t, ...hooks]));
    }
    const s = script("start");
    if (s !== undefined && text) {
      const hooks = [script("prestart"), script("poststart")].filter((x): x is string => !!x);
      out.cands.push(mk("start", "node", o.pm, run("start"), 30_000,
        ev("package.json", text, scriptLine(text, "start"), `scripts.start = ${quoted(s)}`), [s, ...hooks]));
    }
  }
  const t = script("test");
  if (t === undefined) out.unknown.push({ field: "test", reason: "package.json has no scripts.test" });
  else if (NPM_PLACEHOLDER.test(t)) out.unknown.push({ field: "test", reason: "scripts.test is npm's 'no test specified' placeholder" });
  if (script("start") === undefined)
    out.unknown.push({ field: "start", reason: script("dev") !== undefined ? "package.json has scripts.dev but no scripts.start; a dev server is not proposed as the start command" : "package.json has no scripts.start" });
  if (conflictReason) for (const f of ["preparation", "test", "start"] as const) out.conflicts.push({ field: f, reason: conflictReason });
  return out;
}

// ----------------------------------------------------------------- python

function detectPython(c: Ctx): PartialStack | undefined {
  const marker = ["pyproject.toml", "requirements.txt", "Pipfile", "setup.py"].filter((f) => c.has(f));
  if (!marker.length) return undefined;
  const out: PartialStack = {
    stack: { id: "python", evidence: marker.map((f) => ev(f, c.text(f), 1, `${f} present`)) },
    cands: [], conflicts: [], unknown: [],
  };
  const py = c.text("pyproject.toml");
  const req = c.text("requirements.txt");

  for (const f of [".python-version"]) {
    if (c.has(f)) {
      const v = (c.text(f) ?? "").trim().split(/\r?\n/)[0];
      if (v) out.stack.version = { value: v, source: ev(f, c.text(f), 1, "python version pin") };
    }
  }
  if (!out.stack.version && py) {
    const l = lineOf(py, /^\s*requires-python\s*=/);
    const m = l && /=\s*["']([^"']+)["']/.exec(lineText(py, l));
    if (l && m) out.stack.version = { value: m[1], source: ev("pyproject.toml", py, l, "requires-python") };
  }

  interface Tool { tool: "uv" | "poetry" | "pipenv" | "pip"; prep?: string; prefix: string; src: Evidence; timeout: number }
  const tools: Tool[] = [];
  if (c.has("uv.lock")) tools.push({ tool: "uv", prep: "uv sync --frozen", prefix: "uv run ", src: ev("uv.lock", c.text("uv.lock"), 1, "uv.lock present"), timeout: 300_000 });
  else if (py && lineOf(py, /^\s*\[tool\.uv[\].]/)) tools.push({ tool: "uv", prep: "uv sync", prefix: "uv run ", src: ev("pyproject.toml", py, lineOf(py, /^\s*\[tool\.uv[\].]/), "[tool.uv] section"), timeout: 300_000 });
  const poetryLine = py ? lineOf(py, /^\s*\[tool\.poetry[\].]/) : undefined;
  if (c.has("poetry.lock")) tools.push({ tool: "poetry", prep: "poetry install --no-interaction", prefix: "poetry run ", src: ev("poetry.lock", c.text("poetry.lock"), 1, "poetry.lock present"), timeout: 300_000 });
  else if (poetryLine) tools.push({ tool: "poetry", prep: "poetry install --no-interaction", prefix: "poetry run ", src: ev("pyproject.toml", py, poetryLine, "[tool.poetry] section"), timeout: 300_000 });
  if (c.has("Pipfile")) tools.push({ tool: "pipenv", prep: c.has("Pipfile.lock") ? "pipenv install --deploy" : "pipenv install", prefix: "pipenv run ", src: ev("Pipfile", c.text("Pipfile"), 1, "Pipfile present"), timeout: 300_000 });
  if (c.has("requirements.txt")) tools.push({ tool: "pip", prep: "pip install -r requirements.txt", prefix: "", src: ev("requirements.txt", req, 1, "requirements.txt present"), timeout: 300_000 });

  const prefixes = tools.length ? tools : [{ tool: undefined, prefix: "" } as unknown as Tool];
  for (const t of tools) out.cands.push(mk("preparation", "python", t.tool, t.prep!, t.timeout, t.src));
  if (!tools.length) out.unknown.push({ field: "preparation", reason: "pyproject.toml/setup.py without a lockfile, [tool.*] installer section or requirements.txt: install method is unknown" });

  // test runner evidence
  let pytestEv: Evidence | undefined;
  if (c.has("pytest.ini")) pytestEv = ev("pytest.ini", c.text("pytest.ini"), 1, "pytest.ini present");
  else if (py && lineOf(py, /^\s*\[tool\.pytest/)) pytestEv = ev("pyproject.toml", py, lineOf(py, /^\s*\[tool\.pytest/), "[tool.pytest] section");
  else {
    for (const [f, t] of [["requirements.txt", req], ["pyproject.toml", py], ["Pipfile", c.text("Pipfile")], ["tox.ini", c.text("tox.ini")]] as const) {
      const l = t ? lineOf(t, /(^|[\s"'=<>~,\[])pytest(\b|$)/i) : undefined;
      if (l) { pytestEv = ev(f, t, l, "pytest listed"); break; }
    }
  }
  if (pytestEv) {
    for (const t of prefixes) out.cands.push(mk("test", "python", t.tool, `${t.prefix}pytest`, 300_000, pytestEv));
  } else {
    let unittestEv: Evidence | undefined;
    for (const f of Object.keys(c.textsByPath())) {
      if (/(^|\/)test[^/]*\.py$|_test\.py$/.test(f)) {
        const t = c.text(f);
        const l = t ? lineOf(t, /^\s*(import unittest|from unittest\b)/) : undefined;
        if (l) { unittestEv = ev(f, t, l, "unittest imported by a test module"); break; }
      }
    }
    if (unittestEv) for (const t of prefixes) out.cands.push(mk("test", "python", t.tool, `${t.prefix}python -m unittest discover`, 300_000, unittestEv));
    else out.unknown.push({ field: "test", reason: "no pytest configuration/dependency and no unittest-importing test module found" });
  }
  out.unknown.push({ field: "start", reason: "python projects have no declared entry point in the manifests read" });
  if (tools.length > 1) {
    const reason = `multiple install tools: ${tools.map((t) => t.src.file).join(", ")}`;
    for (const f of ["preparation", ...(pytestEv || out.cands.some((x) => x.field === "test") ? ["test"] : [])] as CommandField[]) out.conflicts.push({ field: f, reason });
  }
  return out;
}

// ---------------------------------------------------- go / rust / java / ...

function detectGo(c: Ctx): PartialStack | undefined {
  if (!c.has("go.mod")) return undefined;
  const t = c.text("go.mod");
  const out: PartialStack = { stack: { id: "go", evidence: [ev("go.mod", t, lineOf(t, /^\s*module\b/) ?? 1, "go.mod present")] }, cands: [], conflicts: [], unknown: [] };
  const gl = t ? lineOf(t, /^\s*go\s+\d/) : undefined;
  const gm = gl && /go\s+(\S+)/.exec(lineText(t, gl));
  if (gl && gm) out.stack.version = { value: gm[1], source: ev("go.mod", t, gl, "go directive") };
  const src = ev("go.mod", t, 1, "go.mod present");
  out.cands.push(mk("preparation", "go", "go", "go mod download", 300_000, src));
  out.cands.push(mk("test", "go", "go", "go test ./...", 300_000, src));
  if (c.has("main.go")) out.cands.push(mk("start", "go", "go", "go run .", 30_000, ev("main.go", c.text("main.go"), 1, "main.go at repository root")));
  else out.unknown.push({ field: "start", reason: "no main.go at the repository root; the main package is not identified" });
  if (c.has("go.work")) addMono(out, "go-work", ev("go.work", c.text("go.work"), 1, "go.work present"));
  return out;
}

function detectRust(c: Ctx): PartialStack | undefined {
  if (!c.has("Cargo.toml")) return undefined;
  const t = c.text("Cargo.toml");
  const out: PartialStack = { stack: { id: "rust", evidence: [ev("Cargo.toml", t, 1, "Cargo.toml present")] }, cands: [], conflicts: [], unknown: [] };
  const src = ev("Cargo.toml", t, 1, "Cargo.toml present");
  const wsLine = t ? lineOf(t, /^\s*\[workspace\]/) : undefined;
  const virtual = wsLine !== undefined && !(t && lineOf(t, /^\s*\[package\]/));
  if (wsLine) addMono(out, "cargo-workspace", ev("Cargo.toml", t, wsLine, "[workspace] section"));
  const locked = c.has("Cargo.lock");
  out.cands.push(mk("preparation", "rust", "cargo", locked ? "cargo fetch --locked" : "cargo fetch", 900_000, locked ? ev("Cargo.lock", c.text("Cargo.lock"), 1, "Cargo.lock present") : src));
  out.cands.push(mk("test", "rust", "cargo", wsLine ? "cargo test --workspace" : "cargo test", 900_000, wsLine ? ev("Cargo.toml", t, wsLine, "[workspace] section") : src));
  const binLine = t ? lineOf(t, /^\s*\[\[bin\]\]/) : undefined;
  if (!virtual && (c.has("src/main.rs") || binLine)) {
    out.cands.push(mk("start", "rust", "cargo", "cargo run", 30_000, c.has("src/main.rs") ? ev("src/main.rs", c.text("src/main.rs"), 1, "src/main.rs present") : ev("Cargo.toml", t, binLine, "[[bin]] target")));
  } else out.unknown.push({ field: "start", reason: virtual ? "virtual workspace manifest: which binary to run is not identified" : "no src/main.rs or [[bin]] target" });
  return out;
}

function detectJava(c: Ctx): PartialStack | undefined {
  const mvn = c.has("pom.xml");
  const gradle = c.has("build.gradle") || c.has("build.gradle.kts");
  if (!mvn && !gradle) return undefined;
  const out: PartialStack = { stack: { id: "java", evidence: [] }, cands: [], conflicts: [], unknown: [] };
  if (mvn) {
    const t = c.text("pom.xml");
    const e = ev("pom.xml", t, 1, "pom.xml present");
    out.stack.evidence.push(e);
    const cmd = c.has("mvnw") ? "./mvnw" : "mvn";
    out.cands.push(mk("preparation", "java", "maven", `${cmd} -B dependency:go-offline`, 600_000, e));
    out.cands.push(mk("test", "java", "maven", `${cmd} -B test`, 600_000, e));
    const ml = t ? lineOf(t, /<modules>/) : undefined;
    if (ml) addMono(out, "maven-modules", ev("pom.xml", t, ml, "<modules> declared"));
  }
  if (gradle) {
    const f = c.has("build.gradle") ? "build.gradle" : "build.gradle.kts";
    const e = ev(f, c.text(f), 1, `${f} present`);
    out.stack.evidence.push(e);
    const cmd = c.has("gradlew") ? "./gradlew" : "gradle";
    out.cands.push(mk("preparation", "java", "gradle", `${cmd} --no-daemon assemble`, 600_000, e));
    out.cands.push(mk("test", "java", "gradle", `${cmd} --no-daemon test`, 600_000, e));
    for (const sf of ["settings.gradle", "settings.gradle.kts"]) {
      const st = c.text(sf);
      const l = st ? lineOf(st, /^\s*include\b/) : undefined;
      if (l) addMono(out, "gradle-multiproject", ev(sf, st, l, "include declares subprojects"));
    }
  }
  out.unknown.push({ field: "start", reason: "JVM projects declare no start command in build files" });
  if (mvn && gradle) for (const f of ["preparation", "test"] as const) out.conflicts.push({ field: f, reason: "both pom.xml and build.gradle present" });
  return out;
}

function detectRuby(c: Ctx): PartialStack | undefined {
  if (!c.has("Gemfile")) return undefined;
  const t = c.text("Gemfile");
  const e = ev("Gemfile", t, 1, "Gemfile present");
  const out: PartialStack = { stack: { id: "ruby", evidence: [e] }, cands: [], conflicts: [], unknown: [] };
  if (c.has(".ruby-version")) {
    const v = (c.text(".ruby-version") ?? "").trim();
    if (v) out.stack.version = { value: v, source: ev(".ruby-version", c.text(".ruby-version"), 1, "ruby version pin") };
  }
  out.cands.push(mk("preparation", "ruby", "bundler", "bundle install", 300_000, c.has("Gemfile.lock") ? ev("Gemfile.lock", c.text("Gemfile.lock"), 1, "Gemfile.lock present") : e));
  const specs = [...c.files].some((f) => f.startsWith("spec/"));
  const rspecEv = c.has(".rspec") ? ev(".rspec", c.text(".rspec"), 1, ".rspec present")
    : specs ? ev("Gemfile", t, 1, "spec/ directory present")
    : t && lineOf(t, /\brspec\b/) ? ev("Gemfile", t, lineOf(t, /\brspec\b/), "rspec in Gemfile") : undefined;
  const rakeTests = c.has("Rakefile") && [...c.files].some((f) => f.startsWith("test/"));
  if (rspecEv) out.cands.push(mk("test", "ruby", "rspec", "bundle exec rspec", 300_000, rspecEv));
  if (rakeTests) out.cands.push(mk("test", "ruby", "rake", "bundle exec rake test", 300_000, ev("Rakefile", c.text("Rakefile"), 1, "Rakefile plus test/ directory")));
  if (rspecEv && rakeTests) out.conflicts.push({ field: "test", reason: "both rspec (spec/) and rake test (test/) layouts present" });
  if (!rspecEv && !rakeTests) out.unknown.push({ field: "test", reason: "no .rspec/spec/ or Rakefile+test/ found" });
  out.unknown.push({ field: "start", reason: "no Procfile web entry" });
  return out;
}

function detectPhp(c: Ctx): PartialStack | undefined {
  if (!c.has("composer.json")) return undefined;
  const t = c.text("composer.json");
  const e = ev("composer.json", t, 1, "composer.json present");
  const out: PartialStack = { stack: { id: "php", evidence: [e] }, cands: [], conflicts: [], unknown: [] };
  const pkg = parseJson(t);
  if (t !== undefined && !pkg) {
    out.unknown.push({ field: "stack", reason: "composer.json is not valid JSON; nothing proposed from it" });
    return out;
  }
  const sc = own(pkg, "scripts") as Record<string, unknown> | undefined;
  const testScript = own(sc, "test");
  const body = typeof testScript === "string" ? testScript : Array.isArray(testScript) ? testScript.filter((x) => typeof x === "string").join("\n") : undefined;
  out.cands.push(mk("preparation", "php", "composer", "composer install --no-interaction", 300_000, e));
  if (body !== undefined && t) out.cands.push(mk("test", "php", "composer", "composer test", 300_000, ev("composer.json", t, lineOf(t, '"test"'), `scripts.test = ${quoted(body)}`), [body]));
  else {
    const pf = c.has("phpunit.xml") ? "phpunit.xml" : c.has("phpunit.xml.dist") ? "phpunit.xml.dist" : undefined;
    if (pf) out.cands.push(mk("test", "php", "phpunit", "vendor/bin/phpunit", 300_000, ev(pf, c.text(pf), 1, `${pf} present`)));
    else out.unknown.push({ field: "test", reason: "no composer scripts.test and no phpunit.xml" });
  }
  out.unknown.push({ field: "start", reason: "composer.json declares no start command" });
  return out;
}

// ------------------------------------------------------ docker / services

const IMAGE_KINDS: [RegExp, string][] = [
  [/^(postgres|postgresql|postgis|pgvector)/, "postgres"], [/^(mysql)$/, "mysql"], [/^mariadb/, "mariadb"],
  [/^(redis|valkey|keydb)/, "redis"], [/^mongo/, "mongodb"], [/^rabbitmq/, "rabbitmq"], [/^memcached/, "memcached"],
  [/^(elasticsearch|opensearch)/, "search"], [/^(kafka|redpanda|cp-kafka)/, "kafka"], [/^minio/, "minio"],
  [/^clickhouse/, "clickhouse"], [/^(mailhog|mailpit)/, "mail"],
];
function imageKind(image: string): { kind: string; tag?: string } {
  const [ref] = image.split("@");
  const slash = ref.lastIndexOf("/");
  const last = ref.slice(slash + 1);
  const colon = last.indexOf(":");
  const base = (colon === -1 ? last : last.slice(0, colon)).toLowerCase();
  const tag = colon === -1 ? undefined : last.slice(colon + 1);
  if (image.includes("${")) return { kind: "other", tag: undefined };
  const hit = IMAGE_KINDS.find(([re]) => re.test(base));
  return { kind: hit ? hit[1] : "other", tag };
}

const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
function parseCompose(file: string, text: string): DetectedService[] {
  const lines = text.split(/\r\n|\n|\r/);
  const start = lines.findIndex((l) => /^services:\s*(#.*)?$/.test(l));
  if (start === -1) return [];
  const svcs: { name: string; line: number; image?: string; risks: string[] }[] = [];
  let keyIndent = -1;
  let cur: (typeof svcs)[number] | undefined;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const ind = l.length - l.trimStart().length;
    if (ind === 0) break;
    if (keyIndent === -1) keyIndent = ind;
    if (ind === keyIndent) {
      const m = /^\s*["']?([A-Za-z0-9_.-]+)["']?:\s*(#.*)?$/.exec(l);
      cur = m ? { name: m[1], line: i + 1, risks: [] } : undefined;
      if (cur) svcs.push(cur);
      continue;
    }
    if (!cur) continue;
    const im = /^\s*image:\s*["']?([^"'\s#]+)/.exec(l);
    if (im && ind > keyIndent) cur.image = im[1];
    if (/^\s*privileged:\s*["']?true/i.test(l)) cur.risks.push("privileged");
    if (/docker\.sock/.test(l)) cur.risks.push("docker-socket-mount");
    if (/^\s*network_mode:\s*["']?host/i.test(l)) cur.risks.push("host-network");
  }
  return svcs.map((s) => {
    const k = s.image ? imageKind(s.image) : { kind: "other" as const, tag: undefined };
    return {
      kind: s.image ? k.kind : "other", name: s.name, ...(s.image ? { image: s.image } : {}), ...(k.tag ? { tag: k.tag } : {}),
      declared: true, source: ev(file, text, s.line, s.image ? `service ${s.name} uses ${s.image}` : `service ${s.name} (built locally, no image)`), risks: s.risks,
    };
  });
}

const ENV_HINTS: [RegExp, string][] = [
  [/^\s*(?:export\s+)?[A-Z_]*(?:DATABASE|DB)_URL\s*=\s*["']?postgres/i, "postgres"],
  [/^\s*(?:export\s+)?[A-Z_]*(?:DATABASE|DB)_URL\s*=\s*["']?mysql/i, "mysql"],
  [/^\s*(?:export\s+)?[A-Z_]*REDIS[A-Z_]*URL\s*=\s*["']?redis/i, "redis"],
  [/^\s*(?:export\s+)?MONGO[A-Z_]*(?:URI|URL)\s*=\s*["']?mongodb/i, "mongodb"],
];

function detectDocker(c: Ctx): { stack?: DetectedStack; services: DetectedService[] } {
  const services: DetectedService[] = [];
  let stack: DetectedStack | undefined;
  if (c.has("Dockerfile")) {
    const t = c.text("Dockerfile");
    const l = t ? lineOf(t, /^\s*FROM\s/i) : undefined;
    stack = { id: "docker", evidence: [ev("Dockerfile", t, l ?? 1, l ? "Dockerfile base image" : "Dockerfile present")] };
  }
  for (const f of COMPOSE_FILES) {
    const t = c.text(f);
    if (c.has(f) && t) services.push(...parseCompose(f, t));
  }
  for (const f of [".env.example", ".env.sample"]) {
    const t = c.text(f);
    if (!t) continue;
    for (const [re, kind] of ENV_HINTS) {
      const l = lineOf(t, re);
      if (l && !services.some((s) => s.kind === kind))
        services.push({ kind, name: kind, declared: false, source: ev(f, t, l, `${f} hints at a ${kind} service (not declared)`), risks: [] });
    }
  }
  return { stack, services };
}

function detectStatic(c: Ctx, others: number): DetectedStack | undefined {
  if (others > 0 || !c.has("index.html")) return undefined;
  return { id: "static", evidence: [ev("index.html", c.text("index.html"), 1, "index.html at root and no build manifest")] };
}

function procfileStart(c: Ctx): Cand | undefined {
  const t = c.text("Procfile");
  if (!c.has("Procfile") || !t) return undefined;
  const l = lineOf(t, /^\s*web\s*:/);
  if (!l) return undefined;
  const body = lineText(t, l).replace(/^\s*web\s*:\s*/, "").trim();
  if (!body) return undefined;
  return mk("start", "procfile", "procfile", body, 30_000, ev("Procfile", t, l, "Procfile web process"), [body]);
}

// ------------------------------------------------------------------ main

export function detectStack(input: DetectInput): StackDetection {
  const files = new Set<string>();
  for (const f of input.files) if (!/(^|\/)(node_modules|\.git)(\/|$)/.test(normPath(f))) files.add(normPath(f));
  const texts: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.manifests)) {
    if (typeof v === "string") {
      texts[normPath(k)] = v;
      files.add(normPath(k));
    }
  }
  const c: Ctx = {
    files,
    text: (p) => (Object.prototype.hasOwnProperty.call(texts, p) ? texts[p] : undefined),
    has: (p) => files.has(p),
    textsByPath: () => texts,
  };

  const parts = [detectNode(c), detectPython(c), detectGo(c), detectRust(c), detectJava(c), detectRuby(c), detectPhp(c)]
    .filter((x): x is PartialStack => !!x);
  const docker = detectDocker(c);
  const stat = detectStatic(c, parts.length);

  const stacks: DetectedStack[] = [...parts.map((p) => p.stack), ...(stat ? [stat] : []), ...(docker.stack ? [docker.stack] : [])];
  const services = docker.services;

  // monorepo
  const kinds: string[] = [];
  const mEvidence: Evidence[] = [];
  for (const p of parts) if (p.monorepo) { kinds.push(...p.monorepo.kinds); mEvidence.push(...p.monorepo.evidence); }
  const nested = [...files]
    .filter((f) => /\/(package\.json|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|pyproject\.toml|composer\.json)$/.test(f) && !f.includes("node_modules/"))
    .map((f) => f.slice(0, f.lastIndexOf("/")))
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
  const monorepo: Monorepo | undefined = kinds.length ? { kinds, evidence: mEvidence, packages: nested.slice(0, 200) } : undefined;

  // gather candidates per field
  const cands: Cand[] = parts.flatMap((p) => p.cands);
  const pf = procfileStart(c);
  if (pf) cands.push(pf);
  const innerConflicts = parts.flatMap((p) => p.conflicts);
  const unknown: UnknownItem[] = [];
  const proposals: StackDetection["proposals"] = {};
  const conflicts: Conflict[] = [];
  const stackNames = parts.length;

  for (const field of ["preparation", "test", "start"] as const) {
    const opts = cands.filter((x) => x.field === field);
    const inner = innerConflicts.filter((x) => x.field === field).map((x) => x.reason);
    if (opts.length === 0) {
      const why = parts.flatMap((p) => p.unknown.filter((u) => u.field === field).map((u) => u.reason));
      unknown.push({ field, reason: why.length ? why.join("; ") : stacks.length ? "no evidence in the manifests read" : "no recognised stack" });
    } else if (opts.length === 1 && !inner.length) {
      proposals[field] = opts[0];
    } else {
      const reason = inner.length ? inner.join("; ") : `${stackNames} stacks each propose a ${field} command: ${[...new Set(opts.map((o) => o.stack))].join(", ")}`;
      conflicts.push({ field, reason, options: opts });
    }
  }
  for (const p of parts) for (const u of p.unknown) if (u.field === "stack") unknown.push(u);
  if (!stacks.length) unknown.unshift({ field: "stack", reason: "no recognised manifest in the file listing" });

  const evidence = [
    ...stacks.flatMap((s) => s.evidence),
    ...services.map((s) => s.source),
    ...mEvidence,
  ];
  const props = Object.values(proposals);
  const anyFlag = props.some((p) => p.safety === "review");
  const confidence: StackDetection["confidence"] = !stacks.length ? "none"
    : conflicts.length || !props.length ? "low"
    : proposals.preparation && proposals.test && !anyFlag ? "high"
    : "medium";

  return { stacks, services, ...(monorepo ? { monorepo } : {}), proposals, conflicts, evidence, confidence, unknown, validation: buildValidationPlan({ proposals, conflicts, services }) };
}

// ------------------------------------------------------- validation plan

/**
 * Ordered, model-free checks. A failing prepare step is an ENVIRONMENT failure
 * (nothing about the code is known yet); a failing test step is the repo's own
 * verdict. Only the second is a candidate for diagnosis.
 */
export function buildValidationPlan(d: Pick<StackDetection, "proposals" | "conflicts" | "services">): ValidationPlan {
  const steps: ValidationStep[] = [];
  const p = d.proposals;
  if (p.preparation) steps.push({
    id: "prepare", phase: "preparation", command: p.preparation.command, timeoutMs: p.preparation.timeoutMs, expect: "exit-0",
    pass: "dependencies installed (exit code 0)", fail: "environment is not usable; do not diagnose code, repair setup or its inputs",
    failureClass: "environment", requiresApproval: p.preparation.safety === "review", source: p.preparation.source,
  });
  if (p.test) steps.push({
    id: "test", phase: "test", command: p.test.command, timeoutMs: p.test.timeoutMs, expect: "exit-0",
    pass: "the repository's own tests pass (exit code 0)", fail: "tests fail: a repository result, eligible for diagnosis once prepare passed and services were reachable",
    failureClass: "repository", requiresApproval: p.test.safety === "review", source: p.test.source,
  });
  if (p.start) steps.push({
    id: "start", phase: "start", command: p.start.command, timeoutMs: p.start.timeoutMs, expect: "alive-at-timeout",
    pass: `process is still running when the ${p.start.timeoutMs} ms window ends (then stopped)`,
    fail: "process exited inside the window: it does not stay up with this configuration",
    failureClass: "repository", requiresApproval: p.start.safety === "review", source: p.start.source,
  });
  return {
    needsModel: false,
    steps,
    servicesRequired: [...new Set(d.services.filter((s) => s.declared).map((s) => s.kind === "other" ? s.name : s.kind))],
    blockedBy: d.conflicts.map((x) => ({ field: x.field, reason: x.reason })).concat(
      (["preparation", "test", "start"] as const).filter((f) => !p[f] && !d.conflicts.some((x) => x.field === f)).map((f) => ({ field: f, reason: "unknown: nothing proposed" })),
    ),
  };
}

// ------------------------------------------------------ readiness digest

export interface ReadinessInputs {
  /** path -> text, for manifests. */
  manifests?: Readonly<Record<string, string>>;
  /** path -> text (or any stable content hash string), for lockfiles. */
  lockfiles?: Readonly<Record<string, string>>;
  /** The preparation/test/start recipe text actually recorded. */
  recipe?: string;
  /** Image identity (digest preferred over tag). */
  image?: string;
  /** Other configuration identity, e.g. a serialised env-var NAME list. */
  config?: Readonly<Record<string, string>>;
}
export interface ReadinessDigest {
  digest: string;
  entries: { kind: string; key: string; sha256: string }[];
}
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Stable digest of the recorded inputs. Each entry is hashed on its own, then
 * the sorted (kind, key, hash) triples are length-prefixed into the final hash
 * (belt and braces: per-entry hashing already stops path/content byte shifts). Content is
 * hashed exactly as given (no newline normalisation): a changed byte is a change.
 */
export function readinessInputsDigest(inputs: ReadinessInputs): ReadinessDigest {
  const entries: ReadinessDigest["entries"] = [];
  const add = (kind: string, rec: Readonly<Record<string, string>> | undefined) => {
    for (const k of Object.keys(rec ?? {})) entries.push({ kind, key: normPath(k), sha256: sha(rec![k]) });
  };
  add("manifest", inputs.manifests);
  add("lockfile", inputs.lockfiles);
  add("config", inputs.config);
  if (inputs.recipe !== undefined) entries.push({ kind: "recipe", key: "", sha256: sha(inputs.recipe) });
  if (inputs.image !== undefined) entries.push({ kind: "image", key: "", sha256: sha(inputs.image) });
  entries.sort((a, b) => (a.kind + "\0" + a.key < b.kind + "\0" + b.key ? -1 : a.kind + "\0" + a.key > b.kind + "\0" + b.key ? 1 : 0));
  const h = createHash("sha256");
  for (const e of entries) for (const s of [e.kind, e.key, e.sha256]) h.update(`${Buffer.byteLength(s)}:${s}\n`);
  return { digest: h.digest("hex"), entries };
}

export interface ReadinessCheck {
  status: "fresh" | "stale";
  changed: string[];
  added: string[];
  removed: string[];
}
/** `stale` as soon as any recorded input changed, appeared or disappeared. */
export function checkReadinessInputs(recorded: ReadinessDigest, current: ReadinessInputs): ReadinessCheck {
  const now = readinessInputsDigest(current);
  const id = (e: { kind: string; key: string }) => (e.key ? `${e.kind}:${e.key}` : e.kind);
  const before = new Map(recorded.entries.map((e) => [id(e), e.sha256]));
  const after = new Map(now.entries.map((e) => [id(e), e.sha256]));
  const changed = [...after].filter(([k, v]) => before.has(k) && before.get(k) !== v).map(([k]) => k);
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const same = now.digest === recorded.digest && !changed.length && !added.length && !removed.length;
  return { status: same ? "fresh" : "stale", changed, added, removed };
}
