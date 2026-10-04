import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterGenerateResult, ModelAdapter } from "@neutron-build/ai";
import { LocalExecutor } from "@neutron-build/agents";
import type { AgentExecutor } from "@neutron-build/agents";
import { MemoryEventStore, executeRun } from "@neutron-build/workflow";

import { PLAN_EVENT, durableAgent } from "./durable.js";
import type { DurableAgentOutput, ExecutorProvider } from "./durable.js";
import { HARNESS_PACKAGES, HARNESS_VERSIONS } from "./harness.js";
import {
  OPERATION_CAPABILITY, STEER_UNSUPPORTED_MESSAGE, conformanceCheck, declarationFor, harnessSupports,
} from "./harness-capabilities.js";
import type { ConformanceMismatch, HarnessDeclaration, HarnessOperation, ObservedBehaviour } from "./harness-capabilities.js";
import { externalAdapters, shq } from "./harness-external.js";

/**
 * Real adapter probes for `conformanceCheck` (S13).
 *
 * `conformanceCheck` is pure: it compares a declaration with an observation
 * somebody hands it. Until now nobody did, so the declaration table was a claim
 * checked only against itself. These probes DRIVE each adapter through the
 * boundary its own tests already use and report what happened:
 *
 *   native       durableAgent + a scripted ModelAdapter + LocalExecutor
 *   claude-code  durableAgent + the real externalAdapters() + a fake `claude`
 *   opencode     durableAgent + the real externalAdapters() + a fake `opencode`
 *
 * The fake binary is the only stand-in: the adapter code, the executor
 * abstraction, the command line, the prompt file and the env file are the
 * production ones. No live harness and no model is run. What a probe can tell
 * you is what Ship's side did with the operation; it cannot tell you what the
 * real vendor binary would do with the same arguments.
 *
 * Only three operations are probed: plan-review, steer and investigate. The
 * rest (approvals, recovery, browser, interrupt, tools) have no accept/refuse
 * point to drive from here, and a probe that invented one would be a pass that
 * means nothing. They are listed as `unprobed`, which is not the same as ok.
 */

export const PROBED_OPERATIONS: readonly HarnessOperation[] = ["plan-review", "steer", "investigate"];

type ProbedId = "native" | "claude-code" | "opencode";

export interface ProbeOptions {
  /**
   * The steer admission gate. Default: the same `harnessSupports` the run
   * page's steer route calls before it stores a note (web/src/routes/runs/[id].tsx).
   * A test that wants to know what an adapter does WHEN the gate lets a note
   * through (a table that wrongly claims support) overrides it.
   */
  admitSteer?: (harnessId: string) => boolean;
}

/** One scripted ModelAdapter for the native loop that records everything it was shown. */
function scriptedNativeModel(plan: string): { model: ModelAdapter; seen: () => string; calls: () => number } {
  const shown: string[] = [];
  let calls = 0;
  const model: ModelAdapter = {
    provider: "probe",
    modelId: "probe-1",
    async doGenerate(options): Promise<AdapterGenerateResult> {
      calls++;
      for (const m of options.messages) shown.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
      // With a plan configured the first call is the plan; every other turn finishes.
      const text = calls === 1 && plan !== "" ? plan : "```finish\nNo findings.\n```";
      return { content: [{ type: "text", text }], finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, raw: null };
    },
    async *doStream() {
      throw new Error("unused");
    },
  };
  return { model, seen: () => shown.join("\n"), calls: () => calls };
}

export interface FakeExternalRig {
  provider: ExecutorProvider;
  executor: LocalExecutor;
  /** The sandbox root the executor runs in. */
  root: string;
  runs(): Promise<number>;
  /** Everything the binary was invoked with (one argument per line). */
  args(): Promise<string>;
  /** The binary's environment as it saw it. */
  seenEnv(): Promise<string>;
  /** The binary's view of .teploy-agent/ at the moment it started. */
  seenAgentDir(): Promise<string>;
  edited(): Promise<boolean>;
}

const CLAUDE_STREAM = JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: "done", usage: { input_tokens: 1, output_tokens: 1 } });
const OPENCODE_STREAM = [
  JSON.stringify({ type: "text", part: { type: "text", text: "done" } }),
  JSON.stringify({ type: "step_finish", part: { tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } }),
].join("\n");

/**
 * A fake vendor binary on the sandbox PATH. It records how it was invoked,
 * what environment and `.teploy-agent/` directory it saw, leaves an edit in
 * the tree, and prints a minimal valid stream. `extraScript` lines run before
 * the stream (a harness that misbehaves, for the negative controls).
 */
export async function fakeExternalHarness(
  id: "claude-code" | "opencode",
  opts: { extraScript?: string[]; exitCode?: number } = {},
): Promise<FakeExternalRig> {
  const bin = await mkdtemp(join(tmpdir(), "probe-bin-"));
  const root = await mkdtemp(join(tmpdir(), "probe-work-"));
  const rec = await mkdtemp(join(tmpdir(), "probe-rec-"));
  const binary = HARNESS_PACKAGES[id]!.binary;
  const stream = id === "claude-code" ? CLAUDE_STREAM : OPENCODE_STREAM;
  await mkdir(bin, { recursive: true });
  const script = [
    "#!/bin/sh",
    `if [ "$1" = "--version" ]; then echo "${HARNESS_PACKAGES[id]!.version} (probe)"; exit 0; fi`,
    `echo run >> ${shq(join(rec, "runs"))}`,
    `printf '%s\\n' "$@" > ${shq(join(rec, "args"))}`,
    `env > ${shq(join(rec, "env"))}`,
    `ls -a .teploy-agent > ${shq(join(rec, "agentdir"))} 2>&1`,
    `echo edited > edited.txt`,
    ...(opts.extraScript ?? []),
    // A crash prints no result stream: with one, the adapter correctly trusts it.
    ...(opts.exitCode !== undefined ? [`echo "boom" >&2`, `exit ${opts.exitCode}`] : []),
    `cat <<'EOF'\n${stream}\nEOF`,
  ].join("\n");
  await writeFile(join(bin, binary), `${script}\n`);
  await chmod(join(bin, binary), 0o755);
  const executor = new LocalExecutor({ root, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
  const read = (name: string) => readFile(join(rec, name), "utf8").catch(() => "");
  return {
    provider: { isolated: true, async create() { return { handle: root }; }, attach: () => executor },
    executor,
    root,
    runs: async () => (await read("runs")).split("\n").filter((l) => l === "run").length,
    args: () => read("args"),
    seenEnv: () => read("env"),
    seenAgentDir: () => read("agentdir"),
    edited: async () => (await stat(join(root, "edited.txt")).then(() => true, () => false)),
  };
}

async function drive(wf: ReturnType<typeof durableAgent>, input: Record<string, unknown>) {
  const store = new MemoryEventStore();
  const outcome = await executeRun({ workflow: wf, runId: "probe", store, input: input as never });
  return { outcome, out: outcome.output as DurableAgentOutput | undefined, events: await store.load("probe") };
}

async function nativeRig(plan: string, steer?: { drain: () => Promise<string[]> }) {
  const root = await mkdtemp(join(tmpdir(), "probe-native-"));
  const executor = new LocalExecutor({ root });
  const provider: ExecutorProvider = { async create() { return { handle: root }; }, attach: () => executor };
  const model = scriptedNativeModel(plan);
  const wf = durableAgent({ model: model.model, executor: provider, workdir: ".", maxSteps: 6, ...(steer !== undefined ? { steer } : {}) });
  return { wf, model };
}

/** Drive one operation against one harness and report what was observed. */
export async function probeOperation(id: ProbedId, operation: HarnessOperation, options: ProbeOptions = {}): Promise<ObservedBehaviour> {
  const harness = { id, version: HARNESS_VERSIONS[id]! };
  const external = id !== "native";
  const rig = external ? await fakeExternalHarness(id) : undefined;
  const note = "probe-steer-note: prefer the smaller change";
  const store = { added: 0 };
  let started = false;
  let honoured: boolean | undefined;
  let message: string | undefined;

  const input: Record<string, unknown> = { task: "probe task", ...(external ? { harness } : {}) };
  if (operation === "plan-review") input.plan = true;
  else if (operation === "investigate") input.mode = "scan";
  else if (operation === "steer") {
    const admit = (options.admitSteer ?? ((hid: string) => harnessSupports({ harness: { id: hid } }, "steer")))(id);
    if (!admit) {
      // Refused at the gate, before any note is stored and before anything runs.
      return { operation, accepted: false, sideEffects: store.added > 0, refusalMessage: STEER_UNSUPPORTED_MESSAGE };
    }
    store.added++;
    input.steer = true;
  } else {
    throw new Error(`probeOperation: ${operation} has no probe; see PROBED_OPERATIONS`);
  }

  const steer = operation === "steer" ? { drain: async () => [note] } : undefined;
  const native = external ? undefined : await nativeRig(operation === "plan-review" ? "1. Write the file\n2. Verify it" : "", steer);
  const wf = external
    ? durableAgent({
        model: scriptedNativeModel("").model,
        executor: rig!.provider,
        workdir: ".",
        harnesses: externalAdapters({ env: {} }),
        maxSteps: 6,
        ...(steer !== undefined ? { steer } : {}),
      })
    : native!.wf;
  const { outcome, out } = await drive(wf, input);

  if (external) started = (await rig!.runs()) > 0;
  else started = native!.model.calls() > 0;
  if (!started && out?.status === "error") message = out.summary;

  // What the harness actually RECEIVED, as opposed to what Ship was handed.
  const received = external ? `${await rig!.args()}\n${await rig!.seenEnv()}` : native!.model.seen();
  if (operation === "plan-review") honoured = outcome.status === "waiting" && outcome.eventName === PLAN_EVENT;
  if (operation === "investigate") honoured = /read-only/i.test(received);
  if (operation === "steer") honoured = received.includes(note);

  const sideEffects = started || (external && (await rig!.edited())) || store.added > 0;
  return {
    operation,
    accepted: started,
    sideEffects,
    ...(started ? { honoured: honoured === true } : {}),
    ...(message !== undefined ? { refusalMessage: message } : {}),
  };
}

export interface ProbeResult {
  operation: HarnessOperation;
  observed: ObservedBehaviour;
  ok: boolean;
  mismatches: ConformanceMismatch[];
}

export interface ProbeReport {
  harness: string;
  results: ProbeResult[];
  /** Operations nothing was driven for. Not a pass: nothing was observed. */
  unprobed: HarnessOperation[];
  ok: boolean;
}

/**
 * Probe every probed operation for a harness and judge each against
 * `declaration` (default: the published one). Passing a different declaration
 * is how a test asks "would this table have been caught?".
 */
export async function probeHarness(id: ProbedId, options: ProbeOptions & { declaration?: HarnessDeclaration } = {}): Promise<ProbeReport> {
  const declaration = options.declaration ?? declarationFor(id);
  if (declaration === undefined) throw new Error(`no declaration for harness "${id}"`);
  const results: ProbeResult[] = [];
  for (const operation of PROBED_OPERATIONS) {
    const observed = await probeOperation(id, operation, options);
    const verdict = conformanceCheck(declaration, observed);
    results.push({ operation, observed, ok: verdict.ok, mismatches: verdict.mismatches });
  }
  const unprobed = (Object.keys(OPERATION_CAPABILITY) as HarnessOperation[]).filter((op) => !PROBED_OPERATIONS.includes(op));
  return { harness: id, results, unprobed, ok: results.every((r) => r.ok) };
}

/**
 * Where a credential was left behind after a harness run: a file under the
 * sandbox root that contains it, or the executor's own environment. Empty
 * means none of those places held it, nothing about places not looked at.
 */
export async function credentialResidue(root: string, executor: AgentExecutor, secrets: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  const hit = (text: string) => secrets.some((s) => s !== "" && text.includes(s));
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && (await stat(path)).size < 2_000_000 && hit(await readFile(path, "utf8").catch(() => ""))) found.push(path.slice(root.length + 1));
    }
  };
  await walk(root);
  const env = await executor.exec("env", { timeoutMs: 10_000 });
  if (hit(env.stdout)) found.push("(executor environment)");
  return found;
}
