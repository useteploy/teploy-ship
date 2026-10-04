/**
 * Plan grounding (S07, first part). A plan that names `src/billing/invoice.ts`,
 * `computeProration()` or `pnpm run migrate` is making claims about the
 * repository. This module answers one narrow, model-free question: do those
 * named files, symbols and package/make commands exist in the tree at the
 * stated revision?
 *
 * What it is NOT: it does not judge whether the plan is good, does not read
 * code semantically, and "grounded" only means "the name exists". A plan can be
 * fully grounded and wrong. The advisory is for the reviewer, never a gate.
 *
 * Rules that shape the code:
 *  - Three-valued, never two. A reference is `grounded`, `ungrounded` (we
 *    looked and it is absent) or `unchecked` (we could not look: truncated
 *    listing, path outside the repo, command we do not understand, git error).
 *    `unchecked` is shown as such and never counted as a pass.
 *  - A reference on a line that says it will CREATE it is `proposed`, not
 *    ungrounded; a plan is allowed to introduce new files. If a "create" target
 *    already exists we say so (`proposed` + note) because that is a plan/repo
 *    disagreement a reviewer wants to see.
 *  - Revision-bound. Facts come from the git object database at `revision`
 *    (`git ls-tree`, `git show`, `git grep` against that commit), not from the
 *    working tree, so an uncommitted or untracked file cannot make a claim look
 *    grounded. If the caller states an expected revision and HEAD differs, no
 *    reference is asserted at all (`revisionMismatch`).
 *  - Plan text is untrusted. It never reaches a shell: symbols are matched
 *    against a strict identifier grammar before being interpolated, paths are
 *    never interpolated (they are compared to the listing), and command text is
 *    only parsed, never run.
 *
 * Observe-only: nothing here writes a run, a step or a record. Gate callers
 * with `planGroundingEnabled` (SHIP_PLAN_GROUNDING, default off).
 */
import type { AgentExecutor } from "@neutron-build/agents";

/** Gate for every caller. Default OFF. */
export function planGroundingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.SHIP_PLAN_GROUNDING ?? "").trim().toLowerCase();
  return raw === "on" || raw === "1" || raw === "true";
}

export type RefKind = "file" | "symbol" | "command";
export type RefStatus = "grounded" | "ungrounded" | "proposed" | "unchecked";

export interface PlanRef {
  kind: RefKind;
  /** Normalised name: path without `./` and `:line`, symbol without `()`, command text. */
  name: string;
  /** 1-based line of the plan text the reference came from. */
  line: number;
  /** True when the plan line says it creates/adds this thing. */
  creates: boolean;
}

export interface RefResult extends PlanRef {
  status: RefStatus;
  /** Why: what was looked up, or why it could not be. Always set. */
  detail: string;
}

/** Facts about the tree at `revision`. Built by `readGroundingFacts` or by hand in tests. */
export interface GroundingFacts {
  revision: string;
  /** Every path at the revision, or undefined when the listing could not be trusted (error/truncated). */
  files?: Set<string>;
  filesNote?: string;
  /** Root package.json scripts, undefined when absent/unreadable. */
  scripts?: Record<string, string>;
  scriptsNote?: string;
  /** Makefile target names, undefined when no Makefile or unreadable. */
  makeTargets?: Set<string>;
  makeNote?: string;
  /** symbol -> found. Absent key = could not be looked up (see symbolNotes). */
  symbols: Record<string, boolean>;
  symbolNotes: Record<string, string>;
}

export interface GroundingReport {
  /** Constant: nothing was executed against the repo beyond read-only git queries. */
  mode: "advisory";
  revision: string;
  /** Set when the caller's expected revision does not match; then every ref is `unchecked`. */
  revisionMismatch?: { expected: string; actual: string };
  refs: RefResult[];
  counts: Record<RefStatus, number>;
  /** True only when at least one reference was found and none is ungrounded; says nothing about `unchecked`. */
  allCheckedGrounded: boolean;
}

const MAX_REFS = 200;
const FILE_EXT = "(?:ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|md|py|go|rs|java|rb|php|sh|sql|css|html|lock|txt|cfg|ini|env|mk)";
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const CREATE_WORDS = /\b(create|creates|creating|add|adds|adding|introduce|introduces|new file|new module|scaffold|write a new|generate)\b/i;
const PKG_BUILTIN = new Set([
  "install", "i", "add", "remove", "rm", "update", "up", "upgrade", "uninstall", "ci", "init", "publish", "pack", "link", "unlink",
  "audit", "outdated", "list", "ls", "exec", "dlx", "x", "create", "config", "cache", "store", "prune", "dedupe", "why", "rebuild",
  "version", "login", "logout", "whoami", "help", "import", "patch", "fetch", "env", "self-update", "setup", "root", "bin", "run",
  "start", "test", "stop", "restart", "workspaces", "workspace", "info", "run-script", "install-test",
]);
/** `npm start`/`npm test`-style aliases that run a script of that name. */
const RUN_ALIASES = new Set(["start", "test", "stop", "restart"]);

function normPath(raw: string): string | undefined {
  let p = raw.trim().replace(/^\.\//, "").replace(/:\d+(?::\d+)?$/, "").replace(/#L\d+.*$/, "");
  p = p.replace(/[.,;)]+$/, "");
  if (p === "" || p.startsWith("/") || p.startsWith("~") || p.split("/").includes("..")) return undefined;
  return p;
}

function looksLikePath(s: string): boolean {
  if (/\s/.test(s) || /^[a-z]+:\/\//i.test(s) || s.startsWith("@") && !s.includes(".")) return false;
  const bare = s.replace(/:\d+(?::\d+)?$/, "");
  if (/[*?{}<>|$`"'=]/.test(bare)) return false;
  if (bare.includes("/")) return /[A-Za-z0-9]/.test(bare) && /\/[^/]+$/.test(bare) && !/^\d+\/\d+$/.test(bare) && !bare.endsWith("/");
  return new RegExp(`^[A-Za-z0-9_.-]+\\.${FILE_EXT}$`).test(bare);
}

function looksLikeSymbol(s: string): string | undefined {
  const t = s.replace(/\(\s*\)$/, "").replace(/\(.*\)$/, "");
  const hadCall = t !== s;
  const segs = t.split(".");
  if (!segs.every((x) => IDENT.test(x))) return undefined;
  // A bare lowercase word (`true`, `config`, `user`) is prose, not a code claim.
  const distinctive = (x: string) => /[a-z][A-Z]/.test(x) || /^[A-Z][a-z]+[A-Z]/.test(x) || x.includes("_") && x.length > 3;
  if (segs.length === 1 && !hadCall && !distinctive(t)) return undefined;
  if (segs.length === 1 && hadCall && t.length < 3) return undefined;
  if (segs.length > 1 && !hadCall && !segs.some(distinctive) && !/^[A-Z]/.test(segs[0]!)) return undefined;
  return t;
}

const COMMAND_START = /^(?:\$\s*)?(?:pnpm|npm|yarn|make|node|npx|cargo|go|pytest|python3?|git|docker|tsc|bun)\b/;

function commandOf(s: string): string | undefined {
  const t = s.trim().replace(/^\$\s*/, "");
  return COMMAND_START.test(s.trim()) ? t : undefined;
}

/** Pull file, symbol and command references out of plan text. Pure; order is source order, de-duplicated by kind+name. */
export function extractRefs(plan: string): PlanRef[] {
  const out: PlanRef[] = [];
  const seen = new Set<string>();
  const push = (kind: RefKind, name: string, line: number, creates: boolean) => {
    const key = `${kind}\0${name}`;
    if (seen.has(key) || out.length >= MAX_REFS) return;
    seen.add(key);
    out.push({ kind, name, line, creates });
  };
  const lines = plan.split(/\r?\n/);
  let fenced = false;
  lines.forEach((text, i) => {
    const line = i + 1;
    if (/^\s*```/.test(text)) { fenced = !fenced; return; }
    const creates = CREATE_WORDS.test(text);
    if (fenced) {
      const cmd = commandOf(text);
      if (cmd !== undefined) push("command", cmd, line, false);
      return;
    }
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const span = m[1]!.trim();
      const cmd = commandOf(span);
      if (cmd !== undefined) { push("command", cmd, line, false); continue; }
      if (looksLikePath(span)) {
        const p = normPath(span);
        // Keep an out-of-repo path as a ref so it is reported `unchecked`, not silently dropped.
        push("file", p ?? span, line, creates);
        continue;
      }
      const sym = looksLikeSymbol(span);
      if (sym !== undefined) push("symbol", sym, line, creates);
    }
  });
  return out;
}

/** What a package-manager command line means for script checking; undefined when we do not understand it. */
function scriptOf(command: string): { tool: string; script: string } | undefined | "unparsed" {
  const parts = command.trim().split(/\s+/);
  const tool = parts[0]!;
  if (!["pnpm", "npm", "yarn", "bun"].includes(tool)) return undefined;
  if (/(^|\s)(&&|\|\||;|\|)(\s|$)/.test(command) || parts.some((p) => /^(--filter|-F|-C|--prefix|-w|--workspace|--cwd|--dir|-r|--recursive)(=|$)/.test(p))) return "unparsed";
  const args = parts.slice(1).filter((p) => !p.startsWith("-"));
  const first = args[0];
  if (first === undefined) return "unparsed";
  if (first === "run" || first === "run-script") return args[1] !== undefined ? { tool, script: args[1] } : "unparsed";
  if (RUN_ALIASES.has(first)) return { tool, script: first };
  if (PKG_BUILTIN.has(first)) return "unparsed";
  if (tool === "npm") return "unparsed"; // `npm foo` is not a script shortcut
  return { tool, script: first };
}

/** Pure judgement of `refs` against `facts`. */
export function groundRefs(refs: PlanRef[], facts: GroundingFacts): RefResult[] {
  return refs.map((ref): RefResult => {
    const r = (status: RefStatus, detail: string): RefResult => ({ ...ref, status, detail });
    if (ref.kind === "file") {
      const p = normPath(ref.name);
      if (p === undefined || p !== ref.name) return r("unchecked", "path is absolute or escapes the repository; not looked up");
      if (facts.files === undefined) return r("unchecked", facts.filesNote ?? "file listing unavailable");
      const isDir = [...facts.files].some((f) => f.startsWith(`${p}/`));
      const exists = facts.files.has(p) || isDir;
      if (ref.creates) return exists ? r("proposed", `plan says it creates ${p}, but it already exists at ${facts.revision.slice(0, 12)}`) : r("proposed", `new at ${facts.revision.slice(0, 12)} (not present, plan creates it)`);
      return exists ? r("grounded", `present at ${facts.revision.slice(0, 12)}`) : r("ungrounded", `no such path at ${facts.revision.slice(0, 12)}`);
    }
    if (ref.kind === "symbol") {
      const segs = ref.name.split(".");
      const missing: string[] = [];
      for (const s of segs) {
        const v = facts.symbols[s];
        if (v === undefined) return r("unchecked", facts.symbolNotes[s] ?? `${s} was not searched`);
        if (!v) missing.push(s);
      }
      if (missing.length === 0) return r("grounded", `identifier text found at ${facts.revision.slice(0, 12)} (name match only, not a semantic check)`);
      if (ref.creates) return r("proposed", `${missing.join(", ")} not present; plan introduces it`);
      return r("ungrounded", `${missing.join(", ")} not found in any tracked file at ${facts.revision.slice(0, 12)}`);
    }
    // command
    const sc = scriptOf(ref.name);
    if (sc !== undefined && sc !== "unparsed") {
      if (facts.scripts === undefined) return r("unchecked", facts.scriptsNote ?? "root package.json unavailable");
      return sc.script in facts.scripts ? r("grounded", `package.json script "${sc.script}" exists`) : r("ungrounded", `no package.json script "${sc.script}" at the repository root`);
    }
    const mk = /^make\s+([A-Za-z0-9_.-]+)\s*$/.exec(ref.name);
    if (mk) {
      if (facts.makeTargets === undefined) return r("unchecked", facts.makeNote ?? "no Makefile read");
      return facts.makeTargets.has(mk[1]!) ? r("grounded", `Makefile target "${mk[1]}" exists`) : r("ungrounded", `no Makefile target "${mk[1]}"`);
    }
    return r("unchecked", "command form not verified (only package scripts and make targets are checked; nothing was run)");
  });
}

export interface GroundOptions {
  /** Revision the plan claims to be about; mismatch with facts.revision asserts nothing. */
  expectedRevision?: string;
}

/** Pure end to end: extract, check, summarise. */
export function groundPlan(plan: string, facts: GroundingFacts, opts: GroundOptions = {}): GroundingReport {
  const refs = extractRefs(plan);
  const exp = opts.expectedRevision?.trim().toLowerCase();
  const act = facts.revision.toLowerCase();
  const mismatch = exp !== undefined && exp !== "" && !(act.startsWith(exp) || exp.startsWith(act));
  const results: RefResult[] = mismatch
    ? refs.map((x) => ({ ...x, status: "unchecked" as const, detail: `plan is about ${exp}, tree is at ${act.slice(0, 12)}; nothing asserted` }))
    : groundRefs(refs, facts);
  const counts: Record<RefStatus, number> = { grounded: 0, ungrounded: 0, proposed: 0, unchecked: 0 };
  for (const x of results) counts[x.status]++;
  return {
    mode: "advisory",
    revision: facts.revision,
    ...(mismatch ? { revisionMismatch: { expected: exp!, actual: act } } : {}),
    refs: results,
    counts,
    allCheckedGrounded: counts.grounded > 0 && counts.ungrounded === 0,
  };
}

/** Plain-text advisory for a reviewer. Ungrounded first; unchecked is never folded into "ok". */
export function renderGrounding(report: GroundingReport): string {
  const out: string[] = [];
  const c = report.counts;
  out.push(`Plan grounding at ${report.revision.slice(0, 12)} (advisory, name-existence only): ${c.grounded} grounded, ${c.ungrounded} ungrounded, ${c.proposed} proposed, ${c.unchecked} unchecked`);
  if (report.revisionMismatch) out.push(`REVISION MISMATCH: plan is about ${report.revisionMismatch.expected}, tree is at ${report.revisionMismatch.actual.slice(0, 12)}; no reference was checked`);
  if (report.refs.length === 0) out.push("The plan names no files, symbols or commands, so there was nothing to ground.");
  const order: RefStatus[] = ["ungrounded", "unchecked", "proposed", "grounded"];
  for (const s of order) for (const x of report.refs.filter((y) => y.status === s)) out.push(`  [${s}] ${x.kind} ${JSON.stringify(x.name)} (plan line ${x.line}): ${x.detail}`);
  return out.join("\n");
}

const SAFE_SYMBOL = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_SYMBOLS = 60;
const MAX_LIST_BYTES = 8 * 1024 * 1024;

/**
 * Read the facts for `refs` through `executor` with read-only git queries
 * against `rev` (default HEAD). Throws only when the directory is not a git
 * repository at all; every other failure degrades to `unchecked`.
 */
export async function readGroundingFacts(executor: AgentExecutor, refs: PlanRef[], rev = "HEAD"): Promise<GroundingFacts> {
  if (!/^[A-Za-z0-9._\/-]+$/.test(rev) || rev.startsWith("-")) throw new Error(`unsafe revision ${JSON.stringify(rev)}`);
  const head = await executor.exec(`git rev-parse --verify --quiet ${rev}^{commit}`, { timeoutMs: 30_000 });
  const revision = head.stdout.trim();
  if (head.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(revision)) throw new Error(`not a git repository or unknown revision ${rev}`);
  const facts: GroundingFacts = { revision, symbols: {}, symbolNotes: {} };

  const wantFiles = refs.some((x) => x.kind === "file");
  if (wantFiles) {
    const ls = await executor.exec(`git ls-tree -r -z --name-only ${revision}`, { timeoutMs: 60_000, maxOutputBytes: MAX_LIST_BYTES });
    if (ls.exitCode !== 0 || ls.timedOut) facts.filesNote = `git ls-tree failed (exit ${ls.exitCode}${ls.timedOut ? ", timed out" : ""})`;
    else if (ls.truncated) facts.filesNote = `file listing truncated at ${MAX_LIST_BYTES} bytes; absence cannot be asserted`;
    else facts.files = new Set(ls.stdout.split("\0").filter((f) => f !== ""));
  }

  const wantScripts = refs.some((x) => x.kind === "command" && scriptOf(x.name) !== undefined && scriptOf(x.name) !== "unparsed");
  if (wantScripts) {
    const pj = await executor.exec(`git show ${revision}:package.json`, { timeoutMs: 30_000 });
    if (pj.exitCode !== 0) facts.scriptsNote = "no package.json at the repository root at this revision";
    else {
      try {
        const parsed = JSON.parse(pj.stdout) as { scripts?: unknown };
        const s = parsed.scripts;
        facts.scripts = s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, string>) : {};
      } catch { facts.scriptsNote = "root package.json is not valid JSON"; }
    }
  }

  if (refs.some((x) => x.kind === "command" && /^make\s/.test(x.name))) {
    const mf = await executor.exec(`git show ${revision}:Makefile`, { timeoutMs: 30_000 });
    if (mf.exitCode !== 0) facts.makeNote = "no Makefile at the repository root at this revision";
    else facts.makeTargets = new Set([...mf.stdout.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].map((m) => m[1]!));
  }

  const symbols = [...new Set(refs.filter((x) => x.kind === "symbol").flatMap((x) => x.name.split(".")))];
  for (const [i, s] of symbols.entries()) {
    if (i >= MAX_SYMBOLS) { facts.symbolNotes[s] = `more than ${MAX_SYMBOLS} distinct identifiers; not searched`; continue; }
    if (!SAFE_SYMBOL.test(s)) { facts.symbolNotes[s] = "not a plain identifier; not searched"; continue; }
    // -q: exit 0 found, 1 absent, >1 error. -I skips binaries. Only the committed tree at `revision` is searched.
    const g = await executor.exec(`git grep -q -I -w -F -e ${s} ${revision} --`, { timeoutMs: 60_000, maxOutputBytes: 4096 });
    if (g.exitCode === 0) facts.symbols[s] = true;
    else if (g.exitCode === 1 && !g.timedOut) facts.symbols[s] = false;
    else facts.symbolNotes[s] = `git grep failed (exit ${g.exitCode}${g.timedOut ? ", timed out" : ""})`;
  }
  return facts;
}

/** Read the tree through `executor` and ground `plan` in it. */
export async function groundPlanFromExecutor(executor: AgentExecutor, plan: string, opts: GroundOptions & { rev?: string } = {}): Promise<GroundingReport> {
  const refs = extractRefs(plan);
  const facts = await readGroundingFacts(executor, refs, opts.rev ?? "HEAD");
  return groundPlan(plan, facts, opts);
}
