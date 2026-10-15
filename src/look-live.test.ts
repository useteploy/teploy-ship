import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import type { AgentExecutor } from "@neutron-build/agents";

import { runLook } from "./look.js";

/**
 * The OPTIONAL real-path proof for the ```look driver (S12). The unit suite
 * (look.test.ts) runs the real generated scripts against a fake page; this
 * test runs them against the REAL stack the product uses — the
 * ship-sandbox-node image's Debian Chromium and its pinned playwright 1.63 —
 * through a local html server, inside a sealed (--network none) container so
 * the proof needs no egress at all.
 *
 * OPT-IN, not auto-detected: it creates and destroys a docker container, and
 * the default suite stays hermetic. Run it with SHIP_LOOK_LIVE=1 and docker
 * carrying the image (images/build.sh node); SHIP_LOOK_LIVE_IMAGE overrides
 * the image tag. A full manual pass — including the iframe, depth and
 * process-tree checks — is recorded in
 * evals/receipts/2026-10-15-look-live-driver-proof.txt.
 */
const IMAGE = process.env.SHIP_LOOK_LIVE_IMAGE ?? "ship-sandbox-node:dev";

function docker(args: string[], options: { input?: string } = {}): ReturnType<typeof spawnSync> {
  return spawnSync("docker", args, { maxBuffer: 64 << 20, timeout: 180_000, ...(options.input !== undefined ? { input: options.input } : {}) });
}

test("look live (OPT-IN): the real driver drives the sandbox image's chromium and observes it as text", async (t) => {
  if (process.env.SHIP_LOOK_LIVE !== "1") {
    t.skip("opt-in only: SHIP_LOOK_LIVE=1, docker, and the ship-sandbox-node image — the committed receipt documents a manual pass");
    return;
  }
  if (spawnSync("bash", ["-c", "command -v docker"]).status !== 0) {
    t.skip("no docker on this machine");
    return;
  }
  if (docker(["images", "-q", IMAGE]).stdout?.toString().trim() === "") {
    t.skip(`image ${IMAGE} not present (images/build.sh node)`);
    return;
  }

  const name = `s12-look-test-${process.pid}`;
  docker(["rm", "-f", name]);
  const started = docker(["run", "-d", "--name", name, "--shm-size", "512m", "--network", "none", "--cpus", "1", "--memory", "1024m", IMAGE, "sleep", "infinity"]);
  assert.equal(started.status, 0, started.stderr?.toString());

  const executor: AgentExecutor = {
    async exec(cmd) {
      const r = docker(["exec", name, "sh", "-c", cmd]);
      return { exitCode: r.status ?? 1, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "", timedOut: false, truncated: false };
    },
    async putFile(path, data) {
      const r = docker(["exec", "-i", name, "sh", "-c", `mkdir -p "$(dirname ${path})" && cat > ${path}`], { input: typeof data === "string" ? data : new TextDecoder().decode(data) });
      assert.equal(r.status, 0, `putFile ${path}: ${r.stderr?.toString()}`);
    },
    async getFile() {
      throw new Error("unused");
    },
    async destroy() {},
  };

  try {
    await executor.putFile(
      "page.html",
      '<!doctype html><html><head><title>Look Live</title></head><body><main><h1>Docs</h1>\n' +
        '<button id="b">Sign in</button>\n<a href="/page.html">API reference</a>\n' +
        '<label>Search docs<input type="text" name="q"></label>\n' +
        '<iframe srcdoc="<button>Accept cookies</button>" title="consent"></iframe>\n</main></body></html>',
    );
    docker(["exec", "-d", name, "sh", "-c", "cd /work && python3 -m http.server 8777 >/tmp/http.log 2>&1"]);

    const first = await runLook(executor, "live0", { kind: "look", url: "http://127.0.0.1:8777/page.html" });
    assert.equal(first.exitCode, 0, first.stderr);
    assert.match(first.stdout, /\[page\] http:\/\/127\.0\.0\.1:8777\/page\.html — Look Live/);
    const buttonRef = /button "Sign in" \[ref=(e\d+)\]/.exec(first.stdout)?.[1];
    const iframeRef = /\[ref=(f\d+e\d+)\]/.exec(first.stdout)?.[1];
    assert.ok(buttonRef !== undefined, "the snapshot carries element refs");
    assert.ok(iframeRef !== undefined, "and an iframe-prefixed one");

    const find = await runLook(executor, "live1", { kind: "look", find: "sign in" });
    assert.equal(find.exitCode, 0);
    assert.match(find.stdout, new RegExp(`1 match for "sign in":\\n\\s+- button "Sign in" \\[ref=${buttonRef}\\]`));

    const sub = await runLook(executor, "live2", { kind: "look", ref: buttonRef });
    assert.equal(sub.exitCode, 0);
    assert.match(sub.stdout, new RegExp(`subtree under ${buttonRef}:\\n- button "Sign in"`));

    const inFrame = await runLook(executor, "live3", { kind: "look", ref: iframeRef });
    assert.equal(inFrame.exitCode, 0, "a frame-prefixed ref resolves into the iframe");
    assert.match(inFrame.stdout, /Accept cookies/);

    const stale = await runLook(executor, "live4", { kind: "look", ref: "e9999" });
    assert.equal(stale.exitCode, 1);
    assert.match(stale.stderr, /^Ref e9999 not found in the current page snapshot\./);

    const again = await runLook(executor, "live5", { kind: "look" });
    assert.equal(again.exitCode, 0);
    assert.match(again.stdout, /Look Live/, "the background session survived between driver runs — same page, no re-navigation");
  } finally {
    docker(["rm", "-f", name]);
  }
});
