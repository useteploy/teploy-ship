import type { AgentExecutor, ExecResult } from "@neutron-build/agents";

/**
 * A persistent Python kernel that lives INSIDE the agent's workspace and
 * is driven entirely through the executor's exec/putFile primitives — so
 * it works identically on LocalExecutor and SandboxExecutor with no new
 * daemon API. Cells execute in one long-lived namespace (variables
 * survive between python actions, Jupyter-style); results come back
 * through files with a done-marker handshake.
 *
 * Restart semantics matter for durability: the kernel process dies with
 * its container (snapshots capture the FILESYSTEM, not process memory),
 * so after a snapshot-restore the pid file is stale and ensureKernel
 * starts a fresh kernel — which skips every cell that already has a done
 * marker, so restored workspaces never re-execute old cells. Namespace
 * variables do NOT survive a restore; files do (and the prompt says so).
 */
const DIR = ".teploy-agent/kernel";

/**
 * The kernel loop.
 *
 * `cancel-<cid>` is the abandonment protocol: when the caller gives up waiting
 * on a cell it drops that marker, and the kernel raises inside the running cell
 * at its next bytecode boundary. Without it a timed-out cell kept running —
 * still writing files, still holding sockets — while the agent moved on and
 * later actions raced it, and a late write could land in the final commit.
 * A cell that ignores the interrupt (blocked in C, or catching BaseException)
 * is escalated by the caller killing the kernel outright.
 */
const KERNEL_PY = `import io, os, sys, time, threading, traceback, _thread
base = os.path.dirname(os.path.abspath(__file__))
ns = {"__name__": "__main__"}
done = {f[5:] for f in os.listdir(base) if f.startswith("done-")}

def watch(cid, stop):
    # Raise KeyboardInterrupt in the main thread the moment the caller gives up.
    while not stop.is_set():
        if os.path.exists(os.path.join(base, "cancel-" + cid)):
            _thread.interrupt_main()
            return
        time.sleep(0.05)

while not os.path.exists(os.path.join(base, "kernel.stop")):
    for f in sorted(os.listdir(base)):
        if not (f.startswith("cell-") and f.endswith(".py")):
            continue
        cid = f[5:-3]
        if cid in done:
            continue
        done.add(cid)
        buf = io.StringIO()
        ok = True
        out, err = sys.stdout, sys.stderr
        sys.stdout = sys.stderr = buf
        stop = threading.Event()
        watcher = threading.Thread(target=watch, args=(cid, stop), daemon=True)
        watcher.start()
        try:
            with open(os.path.join(base, f)) as src:
                code = src.read()
            exec(compile(code, f, "exec"), ns)
        except BaseException:
            ok = False
            traceback.print_exc()
        finally:
            stop.set()
            sys.stdout, sys.stderr = out, err
        with open(os.path.join(base, "out-" + cid + ".txt"), "w") as o:
            o.write(buf.getvalue())
        with open(os.path.join(base, "exit-" + cid), "w") as e:
            e.write("0" if ok else "1")
        with open(os.path.join(base, "done-" + cid), "w") as d:
            d.write("1")
    time.sleep(0.05)
`;

/**
 * Start the kernel if it isn't already running. Stale pid files (kernel
 * died with its container; a restored snapshot carries the old file) are
 * detected and replaced. Liveness is NOT just kill -0: in containers and
 * on snapshot-restore, small dense PID spaces recycle the old pid onto an
 * unrelated process, so on Linux the check also demands /proc/<pid>/cmdline
 * mention kernel.py (elsewhere, ps -o command; bare kill -0 is the last
 * resort). Returns false when the workspace cannot run the kernel at all
 * (no python3) — callers fall back to per-file execution.
 */
export async function ensureKernel(executor: AgentExecutor): Promise<boolean> {
  const isOurs =
    `p="$(cat ${DIR}/kernel.pid 2>/dev/null)"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null && ` +
    `{ if [ -r "/proc/$p/cmdline" ]; then tr '\\0' ' ' < "/proc/$p/cmdline" | grep -q kernel.py; ` +
    `elif command -v ps >/dev/null 2>&1; then ps -p "$p" -o command= 2>/dev/null | grep -q kernel.py; ` +
    `else true; fi; }`;
  const result = await executor.exec(
    `mkdir -p ${DIR} && rm -f ${DIR}/kernel.stop && ` +
      `if ${isOurs}; then echo alive; ` +
      `else command -v python3 >/dev/null 2>&1 || exit 9; ` +
      `nohup python3 ${DIR}/kernel.py > ${DIR}/kernel.log 2>&1 & echo $! > ${DIR}/kernel.pid; echo started; fi`,
    { timeoutMs: 15000 },
  );
  return result.exitCode === 0;
}

/** Write kernel.py into the workspace (idempotent; cheap). */
export async function installKernel(executor: AgentExecutor): Promise<void> {
  await executor.putFile(`${DIR}/kernel.py`, KERNEL_PY);
}

/**
 * Execute one cell in the persistent namespace and wait for its result.
 *
 * On timeout the cell is CANCELLED, not abandoned: the caller drops a
 * cancel marker, the kernel interrupts the cell, and we wait briefly for it to
 * unwind. A cell that will not die takes the whole kernel with it. Leaving it
 * running (the old behaviour, and documented as such) meant a timed-out cell
 * kept mutating the workspace while later actions and the final commit read it.
 */
export async function runCell(
  executor: AgentExecutor,
  cellId: string,
  code: string,
  timeoutMs = 120_000,
): Promise<ExecResult> {
  await executor.putFile(`${DIR}/cell-${cellId}.py`, code);
  const iterations = Math.max(1, Math.ceil(timeoutMs / 100));
  const waiter =
    `i=0; while [ ! -f ${DIR}/done-${cellId} ] && [ "$i" -lt ${iterations} ]; do sleep 0.1; i=$((i+1)); done; ` +
    `if [ ! -f ${DIR}/done-${cellId} ]; then exit 124; fi; ` +
    `cat ${DIR}/out-${cellId}.txt; exit "$(cat ${DIR}/exit-${cellId})"`;
  const result = await executor.exec(waiter, { timeoutMs: timeoutMs + 10_000 });
  if (result.exitCode !== 124) return result;

  // Timed out: interrupt the cell and give it a moment to unwind.
  await executor.exec(`touch ${DIR}/cancel-${cellId}`, { timeoutMs: 10_000 }).catch(() => {});
  const settled = await executor
    .exec(
      `i=0; while [ ! -f ${DIR}/done-${cellId} ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i+1)); done; ` +
        `[ -f ${DIR}/done-${cellId} ] && echo stopped || echo stuck`,
      { timeoutMs: 15_000 },
    )
    .catch(() => ({ stdout: "stuck" }) as ExecResult);

  if (settled.stdout.trim() !== "stopped") {
    // It ignored the interrupt (blocked in C, or swallowing BaseException).
    // A workspace being mutated by a cell nobody is waiting for is worse than
    // losing the namespace, so the kernel goes; the next python action starts
    // a fresh one and the prompt already warns that variables can reset.
    await stopKernel(executor);
  }
  return {
    ...result,
    stdout:
      "[kernel] cell exceeded its timeout and was cancelled" +
      (settled.stdout.trim() === "stopped" ? "." : "; the kernel was restarted, so python variables are gone.") +
      " Long-running work belongs in a bash action or a file.",
    timedOut: true,
  };
}

/** Ask the kernel to exit and kill it if it lingers (cleanup for local runs). */
export async function stopKernel(executor: AgentExecutor): Promise<void> {
  await executor
    .exec(
      `touch ${DIR}/kernel.stop 2>/dev/null; ` +
        `[ -f ${DIR}/kernel.pid ] && { sleep 0.3; kill "$(cat ${DIR}/kernel.pid)" 2>/dev/null; }; true`,
      { timeoutMs: 10_000 },
    )
    .catch(() => {});
}
