// Build a reproducible SWE-bench instance list for run-inference.mjs.
//
//   node make-sample.mjs [count] [out.json]        # default: 50 -> instances-lite-50.json
//
// Why a sample rather than all 300: n=50 answers the only question that
// actually gates a decision — is Ship in the same league as the field
// (OpenHands' published Lite aggregate is 41.7%), or nowhere near it — at
// roughly +/-14 points of 95% confidence. Full Lite narrows that to +/-5.5 for
// six times the API spend, and precision is not the scarce thing here. Run the
// full set afterwards if the sample lands close enough that the answer matters.
//
// The sample is SEEDED and sorted, so the same count always yields the same
// instances: a before/after comparison after a prompt or harness change is
// meaningless if the instance set moved underneath it.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const DATASET = "princeton-nlp/SWE-bench_Lite";
const ROWS_URL = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}&config=default&split=test`;

const count = Number(process.argv[2] ?? 50);
const outPath = process.argv[3] ?? fileURLToPath(new URL(`./instances-lite-${count}.json`, import.meta.url));

/**
 * The official evaluation image for an instance.
 *
 * SWE-bench encodes the `__` in an instance id as `_1776_` because a docker
 * tag cannot carry a double underscore — e.g. pallets__flask-4045 becomes
 * sweb.eval.x86_64.pallets_1776_flask-4045. Getting this wrong surfaces late,
 * as a pull failure partway into a paid run.
 */
function imageFor(instanceId) {
  return `swebench/sweb.eval.x86_64.${instanceId.replaceAll("__", "_1776_")}:latest`;
}

/** mulberry32 — a small deterministic PRNG so the sample is reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function fetchAll() {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const res = await fetch(`${ROWS_URL}&offset=${offset}&length=100`);
    if (!res.ok) throw new Error(`dataset fetch failed: ${res.status} ${res.statusText}`);
    const body = await res.json();
    const page = body.rows ?? [];
    rows.push(...page.map((r) => r.row));
    if (rows.length >= (body.num_rows_total ?? 0) || page.length === 0) break;
  }
  return rows;
}

const all = await fetchAll();
console.error(`fetched ${all.length} instances from ${DATASET}`);

// Sort before sampling: the API's order is not guaranteed stable across calls,
// and an unstable input makes a "seeded" sample only look reproducible.
const sorted = [...all].sort((a, b) => a.instance_id.localeCompare(b.instance_id));

const random = rng(20260808);
const pool = [...sorted];
for (let i = pool.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}
const picked = pool.slice(0, Math.min(count, pool.length)).sort((a, b) => a.instance_id.localeCompare(b.instance_id));

const out = picked.map((r) => ({
  instance_id: r.instance_id,
  image: imageFor(r.instance_id),
  problem_statement: r.problem_statement,
}));

await writeFile(outPath, `${JSON.stringify(out, null, 2)}\n`);

const repos = new Map();
for (const r of picked) {
  const repo = r.instance_id.split("__")[0];
  repos.set(repo, (repos.get(repo) ?? 0) + 1);
}
console.error(`wrote ${out.length} instances -> ${outPath}`);
console.error(`repo spread: ${[...repos.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.error(
  `\nDisk: each instance pulls a 1-2 GB image. ${out.length} distinct images will NOT fit on a small box —\n` +
    `run with SWEBENCH_PRUNE_IMAGES=1 so each image is removed after its instance.`,
);
