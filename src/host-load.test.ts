import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BASE_RESERVE_MB,
  DERIVED_CEILING_CAP,
  capacityPlan,
  describeCapacity,
  diskPathCandidates,
  hostHold,
  hostLoad,
  sandboxHostFromEnv,
  sandboxLimitsFor,
} from "./host-load.js";
import type { HostLimits, HostLoad } from "./host-load.js";

const LIMITS: HostLimits = { minFreeMB: 600, maxLoadPerCpu: 1.5, minFreeDiskMB: 2048, maxInodeUsedPct: 95 };

/** A 4 KiB-block filesystem with `freeGB` available and `inodePct` of its inodes used. */
function fakeStatfs(freeGB: number, opts: { totalGB?: number; inodePct?: number; files?: number } = {}) {
  const bsize = 4096;
  const totalGB = opts.totalGB ?? 75;
  const blocks = Math.round((totalGB * 1024 * 1024 * 1024) / bsize);
  const bavail = Math.round((freeGB * 1024 * 1024 * 1024) / bsize);
  // 5% reserved for root, as ext4 does: bfree > bavail, which is exactly the
  // gap df excludes from its denominator and the block count does not.
  const bfree = bavail + Math.round(blocks * 0.05);
  const files = opts.files ?? 4_980_736;
  return () => ({ bsize, blocks, bfree, bavail, files, ffree: Math.round(files * (1 - (opts.inodePct ?? 41) / 100)) });
}

function load(over: Partial<HostLoad> = {}): HostLoad {
  return { totalMemMB: 3921, freeMemMB: 2500, load1: 1, cpus: 4, ...over };
}

test("hostLoad reads MemAvailable (not MemFree) and MemTotal, and falls back without procfs", () => {
  const meminfo = "MemTotal:        4015000 kB\nMemFree:          556000 kB\nMemAvailable:    2596000 kB\n";
  const sensed = hostLoad({ readMeminfo: () => meminfo, statfs: fakeStatfs(2.8) });
  assert.equal(sensed.freeMemMB, 2535, "MemAvailable in MB, not MemFree");
  assert.equal(sensed.totalMemMB, 3921, "MemTotal in MB");
  assert.ok(sensed.cpus >= 1);
  const fallback = hostLoad({
    readMeminfo: () => {
      throw new Error("no /proc");
    },
    statfs: fakeStatfs(2.8),
  });
  assert.ok(Number.isFinite(fallback.freeMemMB) && fallback.freeMemMB >= 0);
  assert.ok(fallback.totalMemMB > 0, "os.totalmem() answers when procfs does not");
});

test("hostLoad senses the docker root: free MB, df-style used %, inode %", () => {
  const sensed = hostLoad({ readMeminfo: () => "", statfs: fakeStatfs(2.8, { totalGB: 75, inodePct: 41 }) });
  assert.ok(sensed.disk !== undefined, "disk sensed");
  assert.equal(sensed.disk!.freeMB, 2867, "2.8 GiB available");
  assert.equal(sensed.disk!.usedPct, 96.1, "df-style: root-reserved blocks excluded from the denominator");
  assert.equal(sensed.disk!.inodeUsedPct, 41);
});

test("hostLoad tries each mount point and reports no disk rather than throwing when none answer", () => {
  const tried: string[] = [];
  const sensed = hostLoad({
    readMeminfo: () => "",
    diskPaths: ["/var/lib/docker", "/"],
    statfs: (p) => {
      tried.push(p);
      if (p === "/") return fakeStatfs(9)();
      throw new Error("ENOENT");
    },
  });
  assert.deepEqual(tried, ["/var/lib/docker", "/"], "docker root first, container root as the fallback");
  assert.equal(sensed.disk?.freeMB, 9216);

  const none = hostLoad({
    readMeminfo: () => "",
    diskPaths: ["/nope"],
    statfs: () => {
      throw new Error("ENOENT");
    },
  });
  assert.equal(none.disk, undefined, "unsensed disk is absent, not zero — zero would read as 'full'");
  assert.ok(none.freeMemMB >= 0, "the rest of the sense still works");
});

test("diskPathCandidates puts SHIP_DISK_PATH first", () => {
  const before = process.env.SHIP_DISK_PATH;
  try {
    process.env.SHIP_DISK_PATH = "/mnt/data";
    assert.deepEqual(diskPathCandidates(), ["/mnt/data", "/var/lib/docker", "/"]);
    delete process.env.SHIP_DISK_PATH;
    assert.deepEqual(diskPathCandidates(), ["/var/lib/docker", "/"]);
  } finally {
    if (before === undefined) delete process.env.SHIP_DISK_PATH;
    else process.env.SHIP_DISK_PATH = before;
  }
});

test("hostHold: disk binds ahead of memory, then load per cpu; 0 disables a limit", () => {
  assert.equal(hostHold(load(), LIMITS), null);
  assert.equal(hostHold(load({ freeMemMB: 400 }), LIMITS), "memory");
  assert.equal(hostHold(load({ freeMemMB: 400, load1: 9 }), LIMITS), "memory", "memory reported when both bind");
  assert.equal(hostHold(load({ load1: 6.1 }), LIMITS), "load");
  assert.equal(hostHold(load({ load1: 6.0 }), LIMITS), null, "exactly at the ratio still launches");
  assert.equal(
    hostHold(load({ freeMemMB: 100, load1: 99 }), { ...LIMITS, minFreeMB: 0, maxLoadPerCpu: 0 }),
    null,
    "both off",
  );

  const squeezed = { freeMB: 900, usedPct: 99, inodeUsedPct: 41 };
  assert.equal(hostHold(load({ disk: squeezed }), LIMITS), "disk");
  assert.equal(
    hostHold(load({ freeMemMB: 100, load1: 99, disk: squeezed }), LIMITS),
    "disk",
    "disk outranks memory: a full docker root breaks the daemon for every tenant",
  );
  assert.equal(
    hostHold(load({ disk: { freeMB: 40_000, usedPct: 50, inodeUsedPct: 99 } }), LIMITS),
    "disk",
    "inodes fail independently of bytes",
  );
  assert.equal(hostHold(load({ disk: squeezed }), { ...LIMITS, minFreeDiskMB: 0 }), null, "0 disables the disk floor");
  assert.equal(hostHold(load({ disk: { freeMB: 40_000, usedPct: 50, inodeUsedPct: 0 } }), LIMITS), null, "no inode accounting reads as no pressure");
});

test("capacityPlan derives the ceiling from the box: docs/capacity.md's min(vCPU, (RAM-1.5)/0.4)", () => {
  // docs/capacity.md's worked examples, sensed rather than configured.
  const idle = { activeRuns: 0, limits: LIMITS };
  const big = capacityPlan(load({ totalMemMB: 16384, freeMemMB: 14000, cpus: 8, disk: { freeMB: 200_000, usedPct: 20, inodeUsedPct: 10 } }), idle);
  assert.equal(big.maxConcurrent, 8, "8 vCPU / 16 GB -> min(8, 36) = 8");
  assert.equal(big.binding, "cpu");
  const mid = capacityPlan(load({ totalMemMB: 8192, freeMemMB: 7000, cpus: 4, disk: { freeMB: 200_000, usedPct: 20, inodeUsedPct: 10 } }), idle);
  assert.equal(mid.maxConcurrent, 4, "4 vCPU / 8 GB -> min(4, 16) = 4");
  const small = capacityPlan(load({ totalMemMB: 4096, freeMemMB: 3400, cpus: 2, disk: { freeMB: 200_000, usedPct: 20, inodeUsedPct: 10 } }), idle);
  assert.equal(small.maxConcurrent, 2, "2 vCPU / 4 GB -> min(2, 6) = 2");
  assert.equal(small.binding, "cpu");
});

test("capacityPlan: a squeezed disk lowers the ceiling and names disk as binding", () => {
  // deploy-test as measured 2026-08-26: 4 cpu, 3921 MB, 2867 MB free on a 97%-full root.
  const box = load({ totalMemMB: 3921, freeMemMB: 2268, disk: { freeMB: 2867, usedPct: 97, inodeUsedPct: 41 } });
  const plan = capacityPlan(box, { activeRuns: 0, limits: LIMITS });
  assert.equal(plan.binding, "disk");
  assert.equal(plan.maxConcurrent, 1, "floored at 1: (2867-2048)/1024 = 0 more runs fit");
  assert.equal(plan.terms.cpu, 4);
  assert.ok(plan.terms.disk !== null && plan.terms.disk < plan.terms.memory);

  const cleared = capacityPlan({ ...box, disk: { freeMB: 20_000, usedPct: 74, inodeUsedPct: 41 } }, { activeRuns: 0, limits: LIMITS });
  assert.equal(cleared.maxConcurrent, 4, "the squeeze clears and the ceiling comes back up");
  assert.equal(cleared.binding, "memory", "memory 4 (bounded by MemAvailable) edges out cpu 4 on the tie");
});

test("capacityPlan: a memory-squeezed box lowers the ceiling without an operator touching a knob", () => {
  const roomy = { freeMB: 200_000, usedPct: 20, inodeUsedPct: 10 };
  const full = capacityPlan(load({ totalMemMB: 8192, freeMemMB: 7000, cpus: 8, disk: roomy }), { activeRuns: 0, limits: LIMITS });
  assert.equal(full.maxConcurrent, 8, "cpu binds while there is RAM to spare");
  // Same box, a co-tenant now holding 5 GB. MemTotal has not moved; MemAvailable has.
  const hogged = capacityPlan(load({ totalMemMB: 8192, freeMemMB: 1800, cpus: 8, disk: roomy }), { activeRuns: 0, limits: LIMITS });
  assert.equal(hogged.binding, "memory");
  assert.equal(hogged.maxConcurrent, 3, "(1800-600)/400 = 3");
  // This worker's OWN runs must not shrink the ceiling: freeMemMB falls by ~400
  // per run and activeRuns rises by 1, and the two cancel.
  const running = capacityPlan(load({ totalMemMB: 8192, freeMemMB: 7000 - 3 * 400, cpus: 8, disk: roomy }), { activeRuns: 3, limits: LIMITS });
  assert.equal(running.maxConcurrent, 8, "three of its own runs in flight, same ceiling");
});

test("capacityPlan never returns 0 — a 0 ceiling wedges the worker; holding is hostHold's job", () => {
  const dead = load({ totalMemMB: 1024, freeMemMB: 100, cpus: 1, disk: { freeMB: 10, usedPct: 100, inodeUsedPct: 99 } });
  const plan = capacityPlan(dead, { activeRuns: 0, limits: LIMITS });
  assert.equal(plan.maxConcurrent, 1);
  assert.equal(plan.binding, "disk");
  assert.ok(plan.terms.memory < 1, "the term itself is honest about there being no room");
  assert.equal(hostHold(dead, LIMITS), "disk", "the hold is what actually stops the launch");
});

test("capacityPlan: an override wins outright and is reported as the binding", () => {
  const box = load({ disk: { freeMB: 2867, usedPct: 97, inodeUsedPct: 41 } });
  const plan = capacityPlan(box, { activeRuns: 0, limits: LIMITS, override: 6 });
  assert.equal(plan.maxConcurrent, 6);
  assert.equal(plan.binding, "override");
  assert.equal(plan.terms.disk, 0, "the sensed terms are still reported, so an override is visibly an override");
  assert.equal(capacityPlan(box, { activeRuns: 0, limits: LIMITS, override: 0 }).binding, "disk", "0 is not an override");
});

test("capacityPlan bounds the derived ceiling at the cap; unsensed disk drops out of the min", () => {
  const huge = load({ totalMemMB: 262_144, freeMemMB: 250_000, cpus: 64 });
  const plan = capacityPlan(huge, { activeRuns: 0, limits: LIMITS });
  assert.equal(plan.maxConcurrent, DERIVED_CEILING_CAP, "beyond 4 is a projection (docs/capacity.md)");
  assert.equal(plan.terms.disk, null, "no statfs, no disk term");
  assert.equal(plan.binding, "cpu");
});

test("sandboxLimitsFor splits the box across the slots it planned for", () => {
  const four = sandboxLimitsFor(load({ totalMemMB: 3921, cpus: 4 }), 4);
  assert.equal(four.cpus, 1, "4 cpu / 4 slots");
  assert.equal(four.memoryMb, 576, `(3921-${BASE_RESERVE_MB})/4 rounded down to 64 MB`);
  const one = sandboxLimitsFor(load({ totalMemMB: 3921, cpus: 4 }), 1);
  assert.equal(one.cpus, 4);
  assert.equal(one.memoryMb, 2368, "one slot gets the whole usable box as its cap");
  const tiny = sandboxLimitsFor(load({ totalMemMB: 2048, cpus: 2 }), 4);
  assert.equal(tiny.cpus, 0.5, "fractional shares are honest on a small box");
  assert.equal(tiny.memoryMb, 512, "floored: below 512 MB nothing builds");
  const builder = sandboxLimitsFor(load({ totalMemMB: 131_072, cpus: 32 }), 2);
  assert.equal(builder.memoryMb, 4096, "capped: a 64 GB default is not a default");
});

test("sandboxLimitsFor sizes from the sandbox host when the operator names one", () => {
  // The worker on a 29 GB box, the daemon on a 7.8 GB one: without the
  // override every run gets the 4096 cap (four of them on a box that cannot
  // back two). With it, the cap is the daemon box's share.
  const worker = load({ totalMemMB: 29_000, cpus: 8 });
  assert.equal(sandboxLimitsFor(worker, 4).memoryMb, 4096, "worker-sized: capped at the 4 GB default");
  const sized = sandboxLimitsFor(worker, 4, { totalMemMB: 7800, cpus: 4 });
  assert.equal(sized.memoryMb, Math.floor((7800 - BASE_RESERVE_MB) / 4 / 64) * 64, "the daemon box's usable memory split across the slots");
  assert.equal(sized.memoryMb, 1536);
  assert.equal(sized.cpus, 1, "cpus follow the sandbox host too");
  const memOnly = sandboxLimitsFor(worker, 4, { totalMemMB: 7800 });
  assert.equal(memOnly.cpus, 2, "an unset field falls back to the worker host's value");
});

test("sandboxHostFromEnv reads only positive numbers and leaves the rest to the worker host", () => {
  assert.deepEqual(sandboxHostFromEnv({}), {});
  assert.deepEqual(sandboxHostFromEnv({ SHIP_SANDBOX_HOST_MEMORY_MB: "7800" }), { totalMemMB: 7800 });
  assert.deepEqual(sandboxHostFromEnv({ SHIP_SANDBOX_HOST_MEMORY_MB: "7800", SHIP_SANDBOX_HOST_CPUS: "4" }), { totalMemMB: 7800, cpus: 4 });
  assert.deepEqual(sandboxHostFromEnv({ SHIP_SANDBOX_HOST_MEMORY_MB: "lots", SHIP_SANDBOX_HOST_CPUS: "0" }), {}, "garbage and zero are not a box");
});

test("describeCapacity says the ceiling, the binding and the numbers behind it", () => {
  const line = describeCapacity(
    load({ totalMemMB: 3921, freeMemMB: 2268, disk: { freeMB: 2867, usedPct: 97, inodeUsedPct: 41 } }),
    capacityPlan(load({ totalMemMB: 3921, freeMemMB: 2268, disk: { freeMB: 2867, usedPct: 97, inodeUsedPct: 41 } }), {
      activeRuns: 0,
      limits: LIMITS,
    }),
  );
  assert.match(line, /1 slot, disk binding/);
  assert.match(line, /disk 2867 MB free \(97% used, 41% inodes\)/);
  assert.match(line, /2268\/3921 MB free/);
});
