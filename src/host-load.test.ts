import assert from "node:assert/strict";
import { test } from "node:test";

import { hostHold, hostLoad } from "./host-load.js";

test("hostLoad reads MemAvailable (not MemFree) and falls back without procfs", () => {
  const meminfo = "MemTotal:        4015000 kB\nMemFree:          556000 kB\nMemAvailable:    2596000 kB\n";
  const load = hostLoad(() => meminfo);
  assert.equal(load.freeMemMB, 2535, "MemAvailable in MB, not MemFree");
  assert.ok(load.cpus >= 1);
  const fallback = hostLoad(() => {
    throw new Error("no /proc");
  });
  assert.ok(Number.isFinite(fallback.freeMemMB) && fallback.freeMemMB >= 0);
});

test("hostHold: memory binds first, then load per cpu; 0 disables a limit", () => {
  const limits = { minFreeMB: 600, maxLoadPerCpu: 1.5 };
  assert.equal(hostHold({ freeMemMB: 2500, load1: 1, cpus: 4 }, limits), null);
  assert.equal(hostHold({ freeMemMB: 400, load1: 1, cpus: 4 }, limits), "memory");
  assert.equal(hostHold({ freeMemMB: 400, load1: 9, cpus: 4 }, limits), "memory", "memory reported when both bind");
  assert.equal(hostHold({ freeMemMB: 2500, load1: 6.1, cpus: 4 }, limits), "load");
  assert.equal(hostHold({ freeMemMB: 2500, load1: 6.0, cpus: 4 }, limits), null, "exactly at the ratio still launches");
  assert.equal(hostHold({ freeMemMB: 100, load1: 99, cpus: 1 }, { minFreeMB: 0, maxLoadPerCpu: 0 }), null, "both off");
});
