import type { AgentExecutor } from "@neutron-build/agents";
import { inputPathsToRead, detectStack, readinessInputsDigest } from "./stack-detect.js";
import type { ReadinessDigest, ReadinessInputs, StackDetection } from "./stack-detect.js";
import { recipeFromDetection } from "./stack-recipe.js";
import type { RecipeProposal } from "./stack-recipe.js";
import { recipeDigest } from "./environment-recipe.js";

/**
 * Project import dry-run (S05 + S06 wiring): read a checked-out repository's
 * manifests and lockfiles through an executor, and PROPOSE preparation, test
 * and services with citations. READ-ONLY and PROPOSAL-ONLY:
 *  - the only commands sent to the executor are two fixed file-listing /
 *    reading operations below, never a command taken from the repository;
 *  - nothing here writes a project, a recipe or a run. A person (or operator)
 *    copies a proposal into project settings themselves;
 *  - `SHIP_STACK_DETECT` (default off) gates every caller, see
 *    `stackDetectEnabled`.
 *
 * Reads are bounded and untrusted-input aware: the listing prunes
 * node_modules/.git, only regular files are listed (`-type f` does not match
 * a symlink, so a manifest that points at /etc/passwd is never read), paths
 * with control characters are dropped, and oversize manifests are reported
 * rather than parsed.
 */

/** Gate for the import dry-run, the CLI command and the setup-page suggestions. */
export function stackDetectEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.SHIP_STACK_DETECT ?? "").trim().toLowerCase();
  return raw === "on" || raw === "1" || raw === "true";
}

const MAX_FILES = 5000;
const MAX_DEPTH = 6;
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_LOCKFILE_BYTES = 32_000_000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface RepoRead {
  files: string[];
  manifests: Record<string, string>;
  /** path -> text (or an `oversize:<bytes>` marker), hashed into the digest, never parsed. */
  lockfiles: Record<string, string>;
  /** Anything that could not be read or was cut short; shown, never hidden. */
  notes: string[];
}

/** Bounded read of a checked-out tree. Throws only if the executor itself fails to list. */
export async function readRepoInputs(executor: AgentExecutor): Promise<RepoRead> {
  const notes: string[] = [];
  const listing = await executor.exec(
    `find . -maxdepth ${MAX_DEPTH} \\( -name node_modules -o -name .git \\) -prune -o -type f -print0`,
    { timeoutMs: 60_000 },
  );
  if (listing.exitCode !== 0) throw new Error(`could not list the repository (exit ${listing.exitCode})`);
  let files = listing.stdout.split("\0").filter((f) => f !== "").map((f) => f.replace(/^\.\//, ""));
  const dropped = files.filter((f) => CONTROL.test(f));
  if (dropped.length) notes.push(`${dropped.length} path(s) with control characters were ignored`);
  files = files.filter((f) => !CONTROL.test(f)).sort();
  if (files.length > MAX_FILES) { notes.push(`listing cut at ${MAX_FILES} of ${files.length} files`); files = files.slice(0, MAX_FILES); }

  const want = inputPathsToRead(files);
  const manifests: Record<string, string> = {};
  const lockfiles: Record<string, string> = {};
  const decode = new TextDecoder("utf-8");
  for (const [paths, out, cap, isLock] of [[want.manifests, manifests, MAX_MANIFEST_BYTES, false], [want.lockfiles, lockfiles, MAX_LOCKFILE_BYTES, true]] as const) {
    for (const p of paths) {
      try {
        const bytes = await executor.getFile(p);
        if (bytes.byteLength > cap) {
          notes.push(`${p} is ${bytes.byteLength} bytes (over ${cap}); ${isLock ? "recorded by size only" : "not parsed"}`);
          if (isLock) out[p] = `oversize:${bytes.byteLength}`;
        } else out[p] = decode.decode(bytes);
      } catch (e) {
        notes.push(`${p} could not be read: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return { files, manifests, lockfiles, notes };
}

export interface StackProposal {
  /** Constant: nothing was executed and nothing was applied. */
  mode: "proposal-only";
  detection: StackDetection;
  recipe: RecipeProposal;
  inputs: ReadinessInputs;
  /** Digest of manifests + lockfiles (+ image/config) alone. */
  inputsDigest: ReadinessDigest;
  /** Same inputs plus the canonical proposed recipe; null when no recipe was proposed. */
  recipeDigest: ReadinessDigest | null;
  notes: string[];
}

/** Pure half: detection, recipe and digests over already-read inputs. */
export function proposeFromRead(read: RepoRead, extra: { image?: string } = {}): StackProposal {
  const detection = detectStack({ files: read.files, manifests: read.manifests });
  const recipe = recipeFromDetection(detection, Object.keys(read.lockfiles));
  const inputs: ReadinessInputs = {
    manifests: read.manifests,
    lockfiles: read.lockfiles,
    ...(extra.image !== undefined ? { image: extra.image } : {}),
  };
  return {
    mode: "proposal-only",
    detection,
    recipe,
    inputs,
    inputsDigest: readinessInputsDigest(inputs),
    recipeDigest: recipe.recipe ? recipeDigest(recipe.recipe, inputs) : null,
    notes: read.notes,
  };
}

/** Read the tree through `executor`, then propose. */
export async function proposeFromExecutor(executor: AgentExecutor, extra: { image?: string } = {}): Promise<StackProposal> {
  return proposeFromRead(await readRepoInputs(executor), extra);
}

/** The digest worth recording next to projectReadinessKey: the recipe digest, else the inputs digest. */
export function readinessDigestOf(p: StackProposal): string {
  return (p.recipeDigest ?? p.inputsDigest).digest;
}

/** Plain-text rendering for the CLI. Every proposal carries its citation. */
export function renderProposal(p: StackProposal): string {
  const out: string[] = [];
  const d = p.detection;
  out.push(`stacks: ${d.stacks.map((s) => s.id + (s.version ? ` ${s.version.value}` : "")).join(", ") || "none recognised"}   confidence: ${d.confidence}`);
  for (const f of ["preparation", "test", "start"] as const) {
    const pr = d.proposals[f];
    const conflict = d.conflicts.find((c) => c.field === f);
    if (pr) out.push(`${f}: ${pr.command}${pr.safety === "review" ? `   [review: ${pr.flags.join("; ")}]` : ""}\n    from ${pr.source.file}${pr.source.line ? `:${pr.source.line}` : ""} ${pr.source.text}`);
    else if (conflict) out.push(`${f}: CONFLICT, nothing chosen: ${conflict.reason}\n${conflict.options.map((o) => `    - ${o.command} (${o.source.file})`).join("\n")}`);
    else out.push(`${f}: unknown (${d.unknown.find((u) => u.field === f)?.reason ?? "no evidence"})`);
  }
  for (const s of d.services) out.push(`service: ${s.name} (${s.kind}${s.image ? `, ${s.image}` : ""}${s.declared ? "" : ", hinted only"})   from ${s.source.file}${s.source.line ? `:${s.source.line}` : ""}`);
  if (p.recipe.recipe) out.push(`recipe: proposed (${p.recipe.issues.length ? `INVALID: ${p.recipe.issues.join("; ")}` : "valid"})`);
  else out.push("recipe: none proposed");
  for (const g of p.recipe.gaps) out.push(`  gap: ${g}`);
  for (const n of p.notes) out.push(`  note: ${n}`);
  out.push(`readiness digest: ${readinessDigestOf(p)}`);
  out.push("proposal only: nothing was run or saved. Enter the values you accept in project settings.");
  return out.join("\n");
}
