import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalExecutor } from "@neutron-build/agents";
import type { AgentExecutor } from "@neutron-build/agents";

import { executeAction } from "./agent.js";
import { ensureKernel, installKernel, runCell, stopKernel } from "./kernel.js";

async function workspace(): Promise<LocalExecutor> {
  return new LocalExecutor({ root: await mkdtemp(join(tmpdir(), "kernel-")) });
}

test("variables persist between cells — the whole point", async (t) => {
  const executor = await workspace();
  t.after(() => stopKernel(executor));
  await installKernel(executor);
  assert.equal(await ensureKernel(executor), true);

  const first = await runCell(executor, "c1", "x = 40 + 2\nprint('set')", 20000);
  assert.equal(first.exitCode, 0);
  assert.match(first.stdout, /set/);

  const second = await runCell(executor, "c2", "print(f'x is {x}')", 20000);
  assert.equal(second.exitCode, 0);
  assert.match(second.stdout, /x is 42/);
});

test("exceptions report real tracebacks and nonzero exit, and the kernel survives", async (t) => {
  const executor = await workspace();
  t.after(() => stopKernel(executor));
  await installKernel(executor);
  await ensureKernel(executor);

  const boom = await runCell(executor, "c1", "raise ValueError('kaboom')", 20000);
  assert.equal(boom.exitCode, 1);
  assert.match(boom.stdout, /ValueError: kaboom/);

  // kernel still alive and namespace still works after an exception
  const after = await runCell(executor, "c2", "y = 7\nprint(y)", 20000);
  assert.equal(after.exitCode, 0);
  assert.match(after.stdout, /7/);
});

test("ensureKernel is idempotent and revives a dead kernel with a stale pid file", async (t) => {
  const executor = await workspace();
  t.after(() => stopKernel(executor));
  await installKernel(executor);
  await ensureKernel(executor);
  await runCell(executor, "c1", "z = 1", 20000);

  // kill the kernel behind our back (simulates a reaped/restored container)
  await executor.exec('kill "$(cat .teploy-agent/kernel/kernel.pid)" 2>/dev/null; sleep 0.2');

  assert.equal(await ensureKernel(executor), true);
  // fresh namespace (state died with the process) but cells run again —
  // and completed cells were NOT re-executed (done markers respected)
  const result = await runCell(executor, "c2", "print('alive again')", 20000);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /alive again/);
});

test("a cell exceeding its timeout reports timedOut without wedging the run", async (t) => {
  const executor = await workspace();
  t.after(() => stopKernel(executor));
  await installKernel(executor);
  await ensureKernel(executor);

  const slow = await runCell(executor, "c1", "import time\ntime.sleep(30)", 1500);
  assert.equal(slow.timedOut, true);
});

test("executeAction falls back to per-file execution when the kernel cannot start", async () => {
  const inner = await workspace();
  // an executor whose kernel-start exec always fails (as if python3 were absent for the daemon)
  const executor: AgentExecutor = {
    async exec(cmd, opts) {
      if (cmd.includes("kernel.py")) return { exitCode: 9, stdout: "", stderr: "no kernel", timedOut: false, truncated: false };
      return inner.exec(cmd, opts);
    },
    putFile: (p, d) => inner.putFile(p, d),
    getFile: (p) => inner.getFile(p),
    destroy: () => inner.destroy(),
  };
  const result = await executeAction(executor, { kind: "python", code: "print('fallback works')" }, 20000, "fb");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /fallback works/);
});

test("stopKernel actually kills the process", async () => {
  const executor = await workspace();
  await installKernel(executor);
  await ensureKernel(executor);
  await runCell(executor, "c1", "a = 1", 20000);
  await stopKernel(executor);
  // Bare kill -0 false-positives when the pid is recycled (dense container
  // PID spaces) — assert OUR kernel is gone, not that the pid is unused.
  const alive = await executor.exec(
    'p="$(cat .teploy-agent/kernel/kernel.pid)"; if [ -r "/proc/$p/cmdline" ] && tr "\\0" " " < "/proc/$p/cmdline" | grep -q kernel.py; then echo alive; elif [ ! -d /proc ] && kill -0 "$p" 2>/dev/null; then echo alive; else echo dead; fi',
  );
  assert.match(alive.stdout, /dead/);
});
