import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentExecutor } from "@neutron-build/agents";
import { PNG } from "pngjs";

import { LOOK_IMAGE_DATA_CLASS } from "./artifacts.js";
import { FileArtifacts } from "./artifacts.js";
import { runLook, runLookImage } from "./look.js";

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

test("browser-act live (OPT-IN): the baked helper fills and submits a form by ref on the session look observes", async (t) => {
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

  const name = `s12-browser-act-${process.pid}`;
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
    // The form's submit handler stays ON the page (preventDefault): the
    // sealed container has no network, so "submitted" is DOM state the next
    // look must observe — which is the whole claim of the helper.
    await executor.putFile(
      "form.html",
      '<!doctype html><html><head><title>Join</title></head><body><main><h1>Join the list</h1>\n' +
        '<form id="f"><label>Your name<input type="text" name="name"></label>\n' +
        '<label>Email<input type="text" name="email"></label>\n' +
        '<button type="submit">Sign up</button></form></main>\n' +
        "<script>document.getElementById(\"f\").addEventListener(\"submit\", (e) => { e.preventDefault(); const n = new FormData(e.target).get(\"name\"); document.body.innerHTML = \"<main><h1>Thanks, \" + String(n).replace(/[<>&]/g, \"\") + \"!</h1><p>Check your inbox.</p></main>\"; });</script>\n" +
        "</body></html>",
    );
    docker(["exec", "-d", name, "sh", "-c", "cd /work && python3 -m http.server 8777 >/tmp/http.log 2>&1"]);

    // 1. Observe with the real look driver — the refs are its, not invented.
    const first = await runLook(executor, "act0", { kind: "look", url: "http://127.0.0.1:8777/form.html" });
    assert.equal(first.exitCode, 0, first.stderr);
    assert.match(first.stdout, /\[page\] http:\/\/127\.0\.0\.1:8777\/form\.html — Join/);
    const nameRef = /textbox "Your name" \[ref=(e\d+)\]/.exec(first.stdout)?.[1];
    const buttonRef = /button "Sign up" \[ref=(e\d+)\]/.exec(first.stdout)?.[1];
    assert.ok(nameRef !== undefined && buttonRef !== undefined, `the snapshot carries refs (name ${nameRef}, button ${buttonRef})`);

    // 2. Act with the baked helper, by ref, exactly as the prompt teaches.
    const act = await executor.exec(
      `node --input-type=module -e 'import { page, byRef } from "/usr/local/lib/ship-browser.mjs";
await (await byRef("${nameRef}")).fill("Ada Lovelace");
await (await byRef("${buttonRef}")).click();
process.exit(0);'`,
    );
    assert.equal(act.exitCode, 0, act.stderr);

    // 3. Re-observe: the SAME session, now showing what the helper did.
    const second = await runLook(executor, "act1", { kind: "look" });
    assert.equal(second.exitCode, 0, second.stderr);
    assert.match(second.stdout, /heading "Thanks, Ada Lovelace!"/, "the page changed — look sees the helper's actions");
    assert.match(second.stdout, /Check your inbox/);

    // 4. Stale refs fail loudly through the helper too, look's own shape.
    const stale = await executor.exec(
      `node --input-type=module -e 'import { byRef } from "/usr/local/lib/ship-browser.mjs";
await byRef("e9999");
process.exit(0);'`,
    );
    assert.notEqual(stale.exitCode, 0);
    assert.match(stale.stderr, /Ref e9999 not found in (the )?current page snapshot/);

    // 5. Cold start: kill the session (its node wrapper and chromium), then
    // page() must bring it back from look.ts's own session script — the one
    // copy of the launch — and a later look must observe THAT session.
    const killed = await executor.exec(
      'node -e \'const fs=require("fs");for(const d of fs.readdirSync("/proc")){if(!/^[0-9]+$/.test(d))continue;if(+d===process.pid||+d===process.ppid)continue;try{const c=fs.readFileSync("/proc/"+d+"/cmdline","utf8");if(c.includes("remote-debugging-port")||c.includes("look-session.mjs")){process.kill(+d,"SIGKILL");console.log("killed pid",d)}}catch{}}\'',
    );
    assert.match(killed.stdout, /killed pid/, "the session processes were found and killed");
    const revive = await executor.exec(
      `node --input-type=module -e 'import { page } from "/usr/local/lib/ship-browser.mjs";
const p = await page();
await p.goto("http://127.0.0.1:8777/form.html", { waitUntil: "load" });
console.log(await p.title());
process.exit(0);'`,
    );
    assert.equal(revive.exitCode, 0, revive.stderr);
    assert.match(revive.stdout, /Join/, "the helper restarted the session from look's script");
    const third = await runLook(executor, "act2", { kind: "look" });
    assert.equal(third.exitCode, 0, third.stderr);
    assert.match(third.stdout, /Join the list/, "a later look joins the session the helper revived");
  } finally {
    docker(["rm", "-f", name]);
  }
});

test("look live (OPT-IN): an image look screenshots the real chromium page and the artifact round-trips", async (t) => {
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

  const name = `s12-look-image-test-${process.pid}`;
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
    async getFile(path) {
      const r = docker(["exec", name, "cat", path]);
      assert.equal(r.status, 0, `getFile ${path}: ${r.stderr?.toString()}`);
      return new Uint8Array(Buffer.from((r.stdout as Buffer | null) ?? Buffer.alloc(0)));
    },
    async destroy() {},
  };

  try {
    // A page with something IN it to see: an image look's value is pixels
    // the a11y tree cannot carry (colour, layout, canvas).
    await executor.putFile(
      "page.html",
      '<!doctype html><html><head><title>Image Look</title></head><body style="background:#204060">\n' +
        '<h1 style="color:#ffffff">Pixels live here</h1>\n' +
        '<canvas id="c" width="80" height="40"></canvas>\n' +
        "<script>const c=document.getElementById('c').getContext('2d');c.fillStyle='#ff0055';c.fillRect(10,10,60,20);</script>\n" +
        "</body></html>",
    );
    docker(["exec", "-d", name, "sh", "-c", "cd /work && python3 -m http.server 8777 >/tmp/http.log 2>&1"]);

    const dir = await mkdtemp(join(tmpdir(), "look-image-live-"));
    const artifacts = new FileArtifacts(dir);
    const result = await runLookImage(executor, "img0", { kind: "look", url: "http://127.0.0.1:8777/page.html", image: true }, artifacts);
    assert.equal(result.exitCode, 0, result.stderr);
    // Text first, even in image mode.
    assert.match(result.stdout, /\[page\] http:\/\/127\.0\.0\.1:8777\/page\.html — Image Look/);
    assert.match(result.stdout, /heading "Pixels live here"/);
    const shot = result.image;
    assert.ok(shot !== undefined, "the screenshot came back from the sandbox");
    // The artifact round-trip: same id, tagged, decodable PNG of the page.
    const artifact = await artifacts.get(shot.artifact);
    assert.ok(artifact !== null);
    assert.equal(artifact.dataClass, LOOK_IMAGE_DATA_CLASS, "the data-class tag survives the real capture");
    assert.equal(artifact.mime, "image/png");
    const bytes = Buffer.from(artifact.data, "base64");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), shot.digest, "the recorded digest is the sha256 of the stored bytes");
    const png = PNG.sync.read(bytes);
    assert.ok(png.width > 0 && png.height > 0, `a real render, ${png.width}x${png.height}`);
    // The page's own pixels: somewhere in the shot, the canvas fill (#ff0055)
    // must appear — a scan, not a fixed coordinate, so the assertion survives
    // default-stylesheet layout rather than pinning it.
    let painted = 0;
    for (let i = 0; i + 2 < png.data.length; i += 4) {
      if (png.data[i] === 255 && png.data[i + 1] === 0 && png.data[i + 2] === 85) painted++;
    }
    assert.ok(painted > 100, `the canvas fill is in the shot (${painted}px) — real pixels, not a blank viewport`);
  } finally {
    docker(["rm", "-f", name]);
  }
});
