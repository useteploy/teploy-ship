import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentExecutor } from "@neutron-build/agents";

import type { ExecutorProvider } from "./durable.js";
import { SandboxPool, parsePoolHandle, parseSandboxUrls, poolHandle } from "./sandbox-pool.js";

/** A fake daemon that counts creates and can be told to refuse. */
function daemon(name: string, options: { refuse?: boolean; snapshots?: boolean } = {}): {
  provider: ExecutorProvider;
  creates: () => number;
  destroys: () => number;
  refuse: (on: boolean) => void;
} {
  let creates = 0;
  let destroys = 0;
  let refusing = options.refuse === true;
  const base: ExecutorProvider = {
    isolated: true,
    async create() {
      if (refusing) throw new Error(`${name} is down`);
      creates += 1;
      return { handle: `${name}-run-${creates}` };
    },
    attach(handle: string) {
      return { handle } as unknown as AgentExecutor;
    },
    async destroy() {
      destroys += 1;
    },
    ...(options.snapshots === true
      ? {
          async snapshot(handle: string) {
            return `${name}-snap-of-${handle}`;
          },
          async createFrom(image: string) {
            creates += 1;
            return { handle: `${name}-from-${image}` };
          },
        }
      : {}),
  };
  return { provider: base, creates: () => creates, destroys: () => destroys, refuse: (on) => (refusing = on) };
}

test("parseSandboxUrls: one URL, many URLs, and the shapes an operator actually types", () => {
  assert.deepEqual(parseSandboxUrls("http://a:7439"), ["http://a:7439"]);
  assert.deepEqual(parseSandboxUrls("http://a:7439,http://b:7439"), ["http://a:7439", "http://b:7439"]);
  assert.deepEqual(parseSandboxUrls("http://a:7439 , http://b:7439\n"), ["http://a:7439", "http://b:7439"]);
  assert.deepEqual(parseSandboxUrls("http://a:7439/,http://a:7439"), ["http://a:7439"], "a trailing slash is the same host");
  assert.deepEqual(parseSandboxUrls(""), []);
  assert.deepEqual(parseSandboxUrls(undefined), []);
});

test("a handle says which host it is on, and an untagged one is host 0", () => {
  assert.equal(poolHandle(2, "run-abc"), "2@run-abc");
  assert.deepEqual(parsePoolHandle("2@run-abc"), { index: 2, handle: "run-abc" });
  // The compatibility case that matters: a run recorded before pools existed.
  assert.deepEqual(parsePoolHandle("run-abc"), { index: 0, handle: "run-abc" });
  assert.deepEqual(parsePoolHandle("@run-abc"), { index: 0, handle: "@run-abc" });
  assert.deepEqual(parsePoolHandle("x@run-abc"), { index: 0, handle: "x@run-abc" });
});

test("placement is least-loaded, so work spreads instead of piling on the first host", async () => {
  const a = daemon("a");
  const b = daemon("b");
  const pool = new SandboxPool({ hosts: [{ url: "a", provider: a.provider }, { url: "b", provider: b.provider }] });

  const handles = [await pool.create(), await pool.create(), await pool.create(), await pool.create()];
  assert.deepEqual(handles.map((h) => h.handle.split("@")[0]), ["0", "1", "0", "1"]);
  assert.equal(a.creates(), 2);
  assert.equal(b.creates(), 2);
});

test("a released handle frees its slot, so the host is eligible again", async () => {
  const a = daemon("a");
  const b = daemon("b");
  const pool = new SandboxPool({ hosts: [{ url: "a", provider: a.provider }, { url: "b", provider: b.provider }] });

  const first = await pool.create();
  await pool.create();
  await pool.destroy(first.handle);
  assert.equal(a.destroys(), 1);
  const third = await pool.create();
  assert.equal(third.handle.split("@")[0], "0", "host a has room again");
});

test("a host that refuses work is skipped, and the run lands on the survivor", async () => {
  const a = daemon("a", { refuse: true });
  const b = daemon("b");
  const lines: string[] = [];
  const pool = new SandboxPool({
    hosts: [{ url: "http://a:7439", provider: a.provider }, { url: "http://b:7439", provider: b.provider }],
    log: (line) => lines.push(line),
  });

  const created = await pool.create();
  assert.equal(created.handle.split("@")[0], "1", "placed on b");
  assert.equal(b.creates(), 1);
  assert.match(lines.join("\n"), /http:\/\/a:7439 is not taking work \(a is down\)/, "and says which host, and why");

  const state = pool.state();
  assert.equal(state[0]?.healthy, false);
  assert.equal(state[0]?.lastError, "a is down");
  assert.equal(state[1]?.healthy, true);
});

test("a host in cooldown is skipped for new work, then tried again", async () => {
  const a = daemon("a", { refuse: true });
  const b = daemon("b");
  let clock = 1_000_000;
  const pool = new SandboxPool({
    hosts: [{ url: "a", provider: a.provider }, { url: "b", provider: b.provider }],
    now: () => clock,
    cooldownMs: 30_000,
  });

  await pool.create(); // a refuses, b takes it; a goes into cooldown
  a.refuse(false); // a is healthy again, but the pool does not know yet
  const during = await pool.create();
  assert.equal(during.handle.split("@")[0], "1", "still avoiding a while it is in cooldown");

  clock += 31_000;
  const after = await pool.create();
  assert.equal(after.handle.split("@")[0], "0", "cooldown elapsed: a is tried, and works");
  assert.equal(pool.state()[0]?.healthy, true);
});

// A cooldown is a GUESS about a host. A pool that refuses to place anything
// because every host is briefly in cooldown has turned a blip into an outage.
test("when every host is in cooldown, the pool tries them anyway rather than refusing", async () => {
  const a = daemon("a", { refuse: true });
  const pool = new SandboxPool({ hosts: [{ url: "a", provider: a.provider }] });
  await assert.rejects(pool.create(), /no sandbox host could start a sandbox/);
  a.refuse(false);
  const created = await pool.create();
  assert.equal(created.handle, "0@a-run-1", "the very next create is attempted, not deferred");
});

test("a pool that cannot place anywhere names every host and every reason", async () => {
  const a = daemon("a", { refuse: true });
  const b = daemon("b", { refuse: true });
  const pool = new SandboxPool({ hosts: [{ url: "http://a:7439", provider: a.provider }, { url: "http://b:7439", provider: b.provider }] });
  await assert.rejects(pool.create(), (error: Error) => {
    assert.match(error.message, /http:\/\/a:7439: a is down/);
    assert.match(error.message, /http:\/\/b:7439: b is down/);
    return true;
  });
});

test("attach goes back to the host the run is ON — a workspace cannot be moved", async () => {
  const a = daemon("a");
  const b = daemon("b");
  const pool = new SandboxPool({ hosts: [{ url: "a", provider: a.provider }, { url: "b", provider: b.provider }] });
  await pool.create(); // host 0
  const second = await pool.create(); // host 1
  const attached = pool.attach(second.handle) as unknown as { handle: string };
  assert.equal(attached.handle, "b-run-1", "the daemon's own id, on the right daemon");
});

test("a run whose host is gone fails with the reason, not a confusing error from the wrong daemon", () => {
  const a = daemon("a");
  const pool = new SandboxPool({ hosts: [{ url: "a", provider: a.provider }] });
  assert.throws(
    () => pool.attach("3@run-xyz"),
    /sandbox was on host #3, which is no longer in SHIP_SANDBOX_URL \(1 host\(s\) configured\)/,
  );
});

test("isolated is all-or-nothing: one non-isolating host makes the pool non-isolating", () => {
  // A run whose task came from outside refuses to execute on a non-isolating
  // provider, and that check reads ONE boolean — so a mixed pool must answer
  // false, which is the safe answer.
  const isolating = daemon("a");
  const notIsolating = daemon("b");
  (notIsolating.provider as { isolated?: boolean }).isolated = false;
  assert.equal(new SandboxPool({ hosts: [{ url: "a", provider: isolating.provider }] }).isolated, true);
  assert.equal(
    new SandboxPool({ hosts: [{ url: "a", provider: isolating.provider }, { url: "b", provider: notIsolating.provider }] }).isolated,
    false,
  );
});

test("a snapshot restores on the host that took it", async () => {
  const a = daemon("a", { snapshots: true });
  const b = daemon("b", { snapshots: true });
  const pool = new SandboxPool({ hosts: [{ url: "a", provider: a.provider }, { url: "b", provider: b.provider }] });
  await pool.create(); // host 0
  const onB = await pool.create(); // host 1
  const image = await pool.snapshot!(onB.handle);
  assert.equal(image, "1@b-snap-of-b-run-1");
  const restored = await pool.createFrom!(image);
  assert.equal(restored.handle.split("@")[0], "1", "restored on the host that holds the image");
});

test("snapshot support is all-or-nothing, because the durable loop treats it that way", () => {
  // It snapshots before parking and expects to restore afterwards; a pool that
  // sometimes could would park runs it cannot resume.
  const withSnaps = daemon("a", { snapshots: true });
  const without = daemon("b");
  assert.notEqual(new SandboxPool({ hosts: [{ url: "a", provider: withSnaps.provider }] }).snapshot, undefined);
  assert.equal(
    new SandboxPool({ hosts: [{ url: "a", provider: withSnaps.provider }, { url: "b", provider: without.provider }] }).snapshot,
    undefined,
  );
});

test("a pool needs a host", () => {
  assert.throws(() => new SandboxPool({ hosts: [] }), /needs at least one host/);
});

test("SB-A: warm calls route to the host the handle names, and a host without a cache answers null", async () => {
  const asked: string[] = [];
  const warmed = (name: string): ExecutorProvider => ({
    isolated: true,
    async create() {
      return { handle: `${name}-run` };
    },
    attach(handle: string) {
      return { handle } as unknown as AgentExecutor;
    },
    async warmInfo(handle: string) {
      asked.push(`${name}:${handle}`);
      return { repo: name, booted: true, lockHash: "a", repoDir: ".", templateHash: "a" };
    },
    async warmCommit(handle: string) {
      asked.push(`${name}:commit:${handle}`);
      return { repo: name, booted: true, lockHash: "b", repoDir: ".", templateHash: "b" };
    },
  });
  const plain: ExecutorProvider = {
    isolated: true,
    async create() {
      return { handle: "plain-run" };
    },
    attach(handle: string) {
      return { handle } as unknown as AgentExecutor;
    },
  };
  const pool = new SandboxPool({ hosts: [{ url: "http://a", provider: warmed("a") }, { url: "http://b", provider: plain }] });

  const onA = await pool.create();
  const onB = await pool.create();
  assert.equal((await pool.warmInfo(onA.handle))?.repo, "a");
  assert.equal((await pool.warmCommit(onA.handle))?.lockHash, "b");
  // A template on one daemon means nothing on another; the handle's tag is
  // what decides, exactly as it does for snapshots.
  assert.deepEqual(asked, ["a:a-run", "a:commit:a-run"]);
  assert.equal(await pool.warmInfo(onB.handle), null, "a host with no cache is a cold path, not an error");
});
