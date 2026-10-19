import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { AgentExecutor, ExecResult } from "@neutron-build/agents";

import { LOOK_HELP } from "./actions.js";
import { systemPrompt } from "./prompt.js";
import { FileArtifacts, LOOK_IMAGE_DATA_CLASS, type Artifact, type ArtifactStore } from "./artifacts.js";
import {
  LOOK_IMAGE_NO_MODEL,
  LOOK_IMAGE_NO_STORE,
  LOOK_OPEN_PLAN,
  LOOK_SEALED,
  LOOK_SESSION,
  LOOK_REC_DIR,
  LOOK_RECORD_MAX_BYTES,
  describeNeedle,
  findMatches,
  lookCommand,
  lookImageCap,
  lookRecordCommand,
  lookShotPath,
  lookStaleRef,
  renderLook,
  runLook,
  runLookImage,
  runLookRecordFinalise,
} from "./look.js";
import type { LookAction } from "./look.js";
import { RECORDING_DATA_CLASS } from "./artifacts.js";

/**
 * The fake driver (deterministic, no network): an executor that answers the
 * driver scripts runLook writes by running the REAL observation code against
 * fixture pages. Only the browser half — connect, navigate, snapshot — is
 * faked; everything look.ts generates and everything it formats is the real
 * artifact, which is the seam these tests exist to pin.
 *
 * The mock's one claim about Playwright's semantics is spelled out where it
 * is made: a ref resolves iff the current fixture snapshot still carries it.
 */
const PAGES: Record<string, { title: string; snapshot: string }> = {
  "https://example.com/docs": {
    title: "Example Docs",
    snapshot: [
      "- generic [active] [ref=e1]:",
      "  - heading \"Getting started\" [ref=e2]:",
      "    - text: Getting started",
      "  - link \"API reference\" [ref=e3]:",
      "    - /url: /api",
      "  - button \"Sign in\" [ref=e4]",
      "  - textbox \"Search docs\" [ref=e5]",
      "  - iframe [ref=f1e6]:",
      "    - button \"Accept cookies\" [ref=f1e7]",
    ].join("\n"),
  },
  "https://example.com/pricing": {
    title: "Pricing",
    snapshot: ['- heading "Pricing" [ref=e1]:', "  - text: Simple pricing", "  - button \"Contact sales\" [ref=e2]"].join("\n"),
  },
};

interface FakeLookRun {
  executor: AgentExecutor;
  commands: string[];
  files: Map<string, string>;
  /** Every action the fake driver executed, parsed out of the written scripts. */
  actions: Array<Record<string, string | number | boolean | undefined>>;
}

/** A PNG with the right magic: passes the artifact store's allowlist. */
const FAKE_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 1, 2, 3, 4, 5]);

/**
 * The fake executor: putFile records, exec answers `node .teploy-agent/look-*`
 * with the real renderLook over fixture pages, and refuses anything else
 * loudly (a look turn must run nothing but the driver). getFile answers the
 * screenshot path an image look's driver writes — the browser half of the
 * capture is faked exactly like the navigation half is.
 */
function fakeLookDriver(): FakeLookRun {
  const commands: string[] = [];
  const files = new Map<string, string>();
  const actions: Array<Record<string, string | number | boolean | undefined>> = [];
  let page: { url: string; title: string; snapshot: string } | undefined;
  const exec = async (cmd: string): Promise<ExecResult> => {
    commands.push(cmd);
    const run = /^node \.teploy-agent\/look-(\S+)\.mjs$/m.exec(cmd);
    if (run === null) {
      return { exitCode: 9, stdout: "", stderr: `fake driver refuses to run: ${cmd}`, timedOut: false, truncated: false };
    }
    const script = files.get(`.teploy-agent/look-${run[1]}.mjs`);
    assert.ok(script !== undefined, "the driver script was written before it ran");
    // The ACTION literal is the contract between look.ts and the driver it
    // generates; reading it back here pins that the parameters actually ride
    // the script rather than some parallel channel.
    const action = JSON.parse((/^const ACTION = (\{.*?\});$/m.exec(script)?.[1] ?? "null") as string) as Record<string, string | number | boolean | undefined>;
    actions.push(action);
    assert.match(script, /function findMatches/, "the driver embeds the real findMatches source");
    assert.match(script, /function renderLook/, "the driver embeds the real renderLook source");
    if (action.image === true) {
      // The capture call must be IN the script the sandbox would run, after
      // the snapshot — text and pixels describe one render.
      assert.match(script, /await page\.ariaSnapshot/, "the text snapshot is taken");
      assert.ok(script.indexOf("await page.ariaSnapshot") < script.indexOf("await page.screenshot"), "the screenshot follows the a11y snapshot of the same render");
      assert.ok(script.includes(JSON.stringify(lookShotPath(String(run[1])))), "the screenshot writes to the path the harness will read");
    } else {
      assert.ok(!script.includes("page.screenshot"), "a text look's driver never captures pixels");
    }
    if (typeof action.url === "string") {
      const next = PAGES[action.url];
      assert.ok(next !== undefined, `fixture page exists for ${action.url}`);
      page = { url: action.url, ...next };
    }
    if (page === undefined) {
      return { exitCode: 1, stdout: "", stderr: "no page yet — a bare look needs url= first in this fixture", timedOut: false, truncated: false };
    }
    // The mock's one semantic claim (see the header): a ref resolves iff the
    // current snapshot still carries its label. Everything after that is the
    // real code path.
    if (typeof action.ref === "string") {
      if (!page.snapshot.includes(`[ref=${action.ref}]`)) {
        return { exitCode: 1, stdout: "", stderr: lookStaleRef(action.ref), timedOut: false, truncated: false };
      }
      const start = page.snapshot.indexOf(`[ref=${action.ref}]`);
      const line = page.snapshot.lastIndexOf("\n", start) + 1;
      const end = (() => {
        const indent = /^(\s*)/.exec(page.snapshot.slice(line))![1]!.length;
        const rest = page.snapshot.slice(line).split("\n");
        const out: string[] = [];
        for (const l of rest) {
          const li = /^(\s*)/.exec(l)![1]!.length;
          if (l.trim() !== "" && li <= indent && out.length > 0) break;
          out.push(l);
        }
        return line + out.join("\n").length;
      })();
      return {
        exitCode: 0,
        stdout: renderLook({ ref: action.ref }, page, page.snapshot.slice(line, end)),
        stderr: "",
        timedOut: false,
        truncated: false,
      };
    }
    return { exitCode: 0, stdout: renderLook(action, page, page.snapshot), stderr: "", timedOut: false, truncated: false };
  };
  return {
    commands,
    files,
    actions,
    executor: {
      exec,
      putFile: async (path, data) => {
        files.set(path, typeof data === "string" ? data : new TextDecoder().decode(data));
      },
      getFile: async (path) => {
        if (/^\.teploy-agent\/look-shot-\S+\.png$/.test(path)) return FAKE_PNG;
        throw new Error(`unused: ${path}`);
      },
      destroy: async () => {},
    },
  };
}

test("lookCommand runs the written driver through the flow rung's playwright symlink", () => {
  const cmd = lookCommand("t0");
  assert.match(cmd, /node \.teploy-agent\/look-t0\.mjs$/);
  assert.match(cmd, /ln -sfn "\$pw" \.teploy-agent\/node_modules\/playwright/);
  assert.match(cmd, /npm root -g/);
  // Missing node or playwright is NAMED, not just non-zero — the agent reads
  // stderr and should stop rather than retry an unfixable environment.
  assert.match(cmd, /echo "look: this sandbox has no node/);
  assert.match(cmd, /echo "look: this sandbox image has no playwright/);
});

test("the session script is the receipt's verified launch: decomposed proxy, headless=new, background networking off, fixed CDP port", () => {
  const source = LOOK_SESSION;
  // The proxy decomposition, verbatim from the receipt §7 — Chromium strips
  // env-proxy userinfo, so the credential must become explicit fields.
  assert.match(source, /process\.env\.HTTPS_PROXY \?\? process\.env\.https_proxy/);
  assert.match(source, /server: `\$\{u\.protocol\}\/\/\$\{u\.host\}`/);
  assert.match(source, /username: decodeURIComponent\(u\.username\)/);
  assert.match(source, /password: decodeURIComponent\(u\.password\)/);
  // Loopback bypasses the proxy (the agent's own dev server), and Playwright's
  // forced <-loopback> rule is disabled so the bypass actually applies.
  assert.match(source, /bypass: "localhost,127\.0\.0\.1,\[::1\]"/);
  assert.match(source, /PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = "1"/);
  assert.match(source, /--disable-background-networking/);
  assert.match(source, /--headless=new/);
  assert.match(source, /--remote-debugging-port=9222/);
  assert.match(source, /CHROMIUM_BIN/);
});

test("runLook: url then snapshot comes back as the observation, parameters riding the script", async () => {
  const fake = fakeLookDriver();
  const result = await runLook(fake.executor, "t0", { kind: "look", url: "https://example.com/docs" });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^\[page\] https:\/\/example\.com\/docs — Example Docs\n- generic \[active\] \[ref=e1\]:/);
  assert.match(result.stdout, /\[ref=f1e7\]/, "iframe-prefixed refs survive into the observation");
  assert.deepEqual(fake.actions, [{ url: "https://example.com/docs" }]);
  assert.ok(fake.files.has(".teploy-agent/look-session.mjs"), "the session script rides along for the first spawn");
});

test("runLook: depth is structural — it rides the ACTION the driver hands Playwright", async () => {
  const fake = fakeLookDriver();
  const result = await runLook(fake.executor, "t1", { kind: "look", url: "https://example.com/docs", depth: 3 });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(fake.actions.at(-1), { url: "https://example.com/docs", depth: 3 });
  void result;
});

test("runLook: find returns matching lines (refs included), regex or text", async () => {
  const fake = fakeLookDriver();
  await runLook(fake.executor, "t0", { kind: "look", url: "https://example.com/docs" });
  const text = await runLook(fake.executor, "t1", { kind: "look", find: "sign in" });
  assert.equal(text.exitCode, 0);
  assert.match(text.stdout, /1 match for "sign in":\n\s+- button "Sign in" \[ref=e4\]/);

  const re = await runLook(fake.executor, "t2", { kind: "look", find: "/(?:sign|cookie)s?/i" });
  assert.equal(re.exitCode, 0);
  assert.match(re.stdout, /2 matches for \/\(\?:sign\|cookie\)s\?\/i:/);
  assert.match(re.stdout, /\[ref=e4\]/);
  assert.match(re.stdout, /\[ref=f1e7\]/);

  const none = await runLook(fake.executor, "t3", { kind: "look", find: "no such phrase" });
  assert.equal(none.exitCode, 0);
  assert.match(none.stdout, /0 matches for "no such phrase"/);
});

test("runLook: ref resolves the subtree; a stale ref fails loudly and says to re-snapshot", async () => {
  const fake = fakeLookDriver();
  await runLook(fake.executor, "t0", { kind: "look", url: "https://example.com/docs" });
  const sub = await runLook(fake.executor, "t1", { kind: "look", ref: "e3" });
  assert.equal(sub.exitCode, 0);
  assert.match(sub.stdout, /subtree under e3:\n\s+- link "API reference" \[ref=e3\]:\n\s+- \/url: \/api/);

  // Navigate — every ref from the previous page is now stale.
  await runLook(fake.executor, "t2", { kind: "look", url: "https://example.com/pricing" });
  const stale = await runLook(fake.executor, "t3", { kind: "look", ref: "e4" });
  assert.equal(stale.exitCode, 1);
  assert.equal(stale.stderr, lookStaleRef("e4"));
  assert.match(stale.stderr, /Ref e4 not found in the current page snapshot\. Take a new one/);
});

test("the stale-ref and sealed-egress messages tell the agent what to do next", () => {
  assert.equal(
    lookStaleRef("f2e3"),
    "Ref f2e3 not found in the current page snapshot. Take a new one (```look on its own, or with url= to navigate first) and use refs from that snapshot.",
  );
  assert.match(LOOK_SEALED, /sealed/);
  assert.match(LOOK_SEALED, /```finish/);
  assert.ok(LOOK_HELP.includes("```look"), "the parse help names the action");
});

test("the open-tier refusal names the D3 rule: plan review, operator decision, no in-run workaround", () => {
  assert.match(LOOK_OPEN_PLAN, /network tier is open/);
  assert.match(LOOK_OPEN_PLAN, /plan an operator reviewed/);
  assert.match(LOOK_OPEN_PLAN, /plan review/);
  assert.match(LOOK_OPEN_PLAN, /```finish/);
  assert.match(LOOK_OPEN_PLAN, /Nothing you do inside the run changes that/);
  assert.match(LOOK_OPEN_PLAN, /allowlist/);
});

// --- acting on the same session (feat/browser-act): the baked helper -------
// The helper is images/browser-helper/ship-browser.mjs, baked to
// /usr/local/lib/ship-browser.mjs by both playwright-carrying sandbox images.

/** The helper as the images bake it, imported by URL so the repo copy is the one under test. */
const HELPER_URL = new URL("../images/browser-helper/ship-browser.mjs", import.meta.url);

test("the help and the prompt teach acting on the same session via the baked helper", () => {
  assert.ok(LOOK_HELP.includes("/usr/local/lib/ship-browser.mjs"), "the parse help names the helper by its baked path");
  assert.ok(LOOK_HELP.includes("byRef"), "the parse help names byRef");
  assert.ok(LOOK_HELP.includes("```look again"), "acting is taught as a loop: act, then re-observe");
  const on = systemPrompt({ workdir: "/work", task: "t", look: true });
  assert.ok(on.includes('"/usr/local/lib/ship-browser.mjs"'), "the prompt's example imports the baked path");
  assert.match(on, /node --input-type=module -e 'import \{ page, byRef \}/, "a copy-pasteable one-liner, not prose alone");
  assert.match(on, /await \(await byRef\("e5"\)\)\.fill\(/, "the example acts by ref");
  assert.ok(on.includes("process.exit(0)"), "the example ends the process — the CDP socket holds node open");
  // Flag-off runs never hear about it: the helper is part of the look offer.
  assert.ok(!systemPrompt({ workdir: "/work", task: "t" }).includes("ship-browser"), "no look, no helper bytes in the prompt");
});

test("ship-browser.mjs pure parts: ref grammar, endpoint parity with the session look owns, loud staleness", async () => {
  // Importable on the repo host (no playwright there) because playwright is
  // imported lazily inside page() — pinned here since the whole point of the
  // module is that it is dependency-free to import and only needs the image.
  const helper = (await import(HELPER_URL.href)) as {
    CDP: string;
    SESSION_SCRIPT: string;
    REF: RegExp;
    staleRef: (ref: string) => string;
    page: () => Promise<unknown>;
    byRef: (ref: string) => Promise<unknown>;
  };
  // It joins THE look session: the endpoint look's own session listens on.
  assert.equal(helper.CDP, "http://127.0.0.1:9222");
  assert.match(LOOK_SESSION, /--remote-debugging-port=9222/, "look.ts's session listens exactly there");
  assert.equal(helper.SESSION_SCRIPT, ".teploy-agent/look-session.mjs", "it spawns look.ts's script, never a launch of its own");
  // The same ref grammar as the look fence (LOOK_REF): eN and fNeN, nothing else.
  for (const good of ["e1", "e12", "f1e6", "f12e3"]) assert.equal(helper.REF.test(good), true, good);
  for (const bad of ["e", "12", "x12", "e12x", "f1", "f1e", "F1E2"]) assert.equal(helper.REF.test(bad), false, bad);
  // Staleness fails loudly with look's own shape, no fuzzy matching.
  assert.match(helper.staleRef("e12"), /^Ref e12 not found in (the )?current page snapshot\./);
  assert.match(helper.staleRef("f2e3"), /```look/);
  assert.equal(typeof helper.page, "function");
  assert.equal(typeof helper.byRef, "function");
});

test("the helper resolves refs and joins the session exactly the way the look driver does", async () => {
  const source = await readFile(fileURLToPath(HELPER_URL), "utf8");
  assert.match(source, /connectOverCDP\(CDP\)/, "it connects over CDP rather than launching a browser");
  assert.ok(!source.includes("await browser.close"), "closing the connection would tear down the run's look session");
  assert.match(source, /"aria-ref=" \+ ref/, "byRef resolves through the same aria-ref engine call");
  assert.match(source, /ariaSnapshot\(\{ mode: "ai" \}\)/, "it mints the connection's refs first, like the driver");
  // Parity with the driver look.ts actually writes: run one and compare the
  // pieces that must be shared — the session script path, its log, and the
  // ref engine — so the two halves cannot drift apart silently.
  const fake = fakeLookDriver();
  await runLook(fake.executor, "t0", { kind: "look", url: "https://example.com/docs" });
  const driver = fake.files.get(".teploy-agent/look-t0.mjs") ?? "";
  assert.ok(driver !== "", "the driver script was written");
  for (const shared of [".teploy-agent/look-session.mjs", "/tmp/ship-look-session.log", "http://127.0.0.1:9222"]) {
    assert.ok(source.includes(shared), `the helper carries ${shared}`);
    assert.ok(driver.includes(shared), `the driver carries ${shared}`);
  }
});

test("both playwright-carrying sandbox images bake the helper, and the build context lets it through", async () => {
  const copy = "COPY browser-helper/ship-browser.mjs /usr/local/lib/ship-browser.mjs";
  for (const stack of ["sandbox-node", "sandbox-go"]) {
    const dockerfile = await readFile(fileURLToPath(new URL(`../images/${stack}/Dockerfile`, import.meta.url)), "utf8");
    assert.ok(dockerfile.includes(copy), `${stack} bakes the helper at the path the prompt teaches`);
    assert.ok(
      dockerfile.includes(`node -e 'import("/usr/local/lib/ship-browser.mjs").then((m) =>`),
      `${stack} proves the baked copy imports and exports page/byRef`,
    );
  }
  // The rust image bakes no playwright, so it bakes no browser helper either.
  const rust = await readFile(fileURLToPath(new URL("../images/sandbox-rust/Dockerfile", import.meta.url)), "utf8");
  assert.ok(!rust.includes("ship-browser"), "no playwright, no helper");
  // The images/ context is an allowlist; the helper must be named through it.
  const dockerignore = await readFile(fileURLToPath(new URL("../images/.dockerignore", import.meta.url)), "utf8");
  assert.ok(dockerignore.includes("!browser-helper/ship-browser.mjs"), "the allowlist lets the helper into the context");
});


test("findMatches and renderLook: the shared observation helpers are self-contained", () => {
  // Self-containment is what lets look.ts embed them into the driver script;
  // these assertions run them through eval'd copies of their own source to
  // prove toString() is the whole function.
  const evald = new Function(`${describeNeedle} ${findMatches} ${renderLook} return { describeNeedle, findMatches, renderLook};`)() as {
    describeNeedle: typeof describeNeedle;
    findMatches: typeof findMatches;
    renderLook: typeof renderLook;
  };
  const snapshot = PAGES["https://example.com/docs"]!.snapshot;
  assert.deepEqual(evald.findMatches(snapshot, "Sign in"), ['  - button "Sign in" [ref=e4]']);
  assert.deepEqual(evald.findMatches(snapshot, "/cookie/i"), ['    - button "Accept cookies" [ref=f1e7]']);
  // Matching is case-insensitive; the quote in the observation preserves the
  // needle as the agent wrote it, so what it asked for stays readable.
  const lower = evald.renderLook({ find: "sign in" }, { url: "u", title: "" }, snapshot);
  assert.match(lower, /1 match for "sign in":\n\s+- button "Sign in" \[ref=e4\]/);
  const mixed = evald.renderLook({ find: "Sign In" }, { url: "u", title: "" }, snapshot);
  assert.equal(mixed.replace(/for "Sign In"/, 'for "sign in"'), lower);
});

// --- image mode (S12 gated slice): screenshot, artifact, refusals ---

test("an image look rides image: true on the ACTION and screenshots the same render as the text", async () => {
  const fake = fakeLookDriver();
  const result = await runLookImage(fake.executor, "t0", { kind: "look", url: "https://example.com/docs", image: true }, memoryArtifacts().store);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^\[page\] https:\/\/example\.com\/docs — Example Docs/);
  // The ACTION contract: image rides the script like every other parameter.
  assert.equal(fake.actions.at(-1)?.image, true, "the driver was told to capture");
  assert.ok(result.image !== undefined, "the screenshot came back as an artifact reference");
});

test("runLookImage stores the PNG as a look-image artifact and records its digest", async () => {
  const fake = fakeLookDriver();
  const { store, ids } = memoryArtifacts();
  const result = await runLookImage(fake.executor, "t7", { kind: "look", url: "https://example.com/docs", image: true }, store);
  const shot = result.image;
  assert.ok(shot !== undefined);
  assert.equal(shot.digest, createHash("sha256").update(FAKE_PNG).digest("hex"), "the digest is the sha256 of the captured bytes");
  assert.equal(shot.bytes, FAKE_PNG.length);
  const artifact = await store.get(shot.artifact);
  assert.ok(artifact !== null, "the artifact is retrievable by the recorded id");
  assert.equal(artifact.dataClass, LOOK_IMAGE_DATA_CLASS, "the data-class tag rides the artifact");
  assert.equal(artifact.mime, "image/png");
  assert.equal(artifact.bytes, FAKE_PNG.length);
  assert.deepEqual(ids(), [shot.artifact], "exactly one artifact per image look");
});

test("runLookImage prefers the store's temporary retention when it has one", async () => {
  const fake = fakeLookDriver();
  const dir = await mkdtemp(join(tmpdir(), "look-image-artifacts-"));
  const store = new FileArtifacts(dir);
  const result = await runLookImage(fake.executor, "t0", { kind: "look", url: "https://example.com/docs", image: true }, store);
  const shot = result.image;
  assert.ok(shot !== undefined);
  const artifact = await store.get(shot.artifact);
  assert.ok(artifact !== null);
  assert.equal(artifact.dataClass, LOOK_IMAGE_DATA_CLASS, "the class survives the temporary path too");
});

test("a failed driver turn returns the text failure with no image half", async () => {
  const fake = fakeLookDriver();
  const { store } = memoryArtifacts();
  // A stale ref fails loudly before any screenshot is taken.
  await runLook(fake.executor, "t0", { kind: "look", url: "https://example.com/pricing" });
  const result = await runLookImage(fake.executor, "t1", { kind: "look", ref: "e9999", image: true }, store);
  assert.equal(result.exitCode, 1);
  assert.equal(result.image, undefined, "no artifact is minted for a failed capture");
});

test("the image refusals name the env var, the cap, and the fix — never a silent downgrade", () => {
  assert.match(LOOK_IMAGE_NO_MODEL, /REFUSED/);
  assert.match(LOOK_IMAGE_NO_MODEL, /SHIP_LOOK_IMAGE_MODEL/, "the no-model refusal names the env var");
  assert.match(LOOK_IMAGE_NO_MODEL, /without image=/, "it says what still works");
  assert.match(lookImageCap(3), /REFUSED/);
  assert.match(lookImageCap(3), /3 screenshots per run/);
  assert.match(lookImageCap(3), /SHIP_LOOK_IMAGE_MAX/, "the cap refusal names the env var");
  assert.match(lookImageCap(1), /1 screenshot per run/, "the singular form reads like a person wrote it");
  assert.match(LOOK_IMAGE_NO_STORE, /REFUSED/);
  assert.match(LOOK_IMAGE_NO_STORE, /artifact store/);
  assert.ok(LOOK_HELP.includes("image=on"), "the parse help documents the parameter");
});

/** A minimal in-memory ArtifactStore: put/get plus a record of what landed. */
function memoryArtifacts(): { store: ArtifactStore; ids: () => string[]; temporary: () => string[] } {
  const byId = new Map<string, Artifact>();
  const order: string[] = [];
  const temps: string[] = [];
  const record = (name: string, bytes: Uint8Array, dataClass?: string, binding?: { runId: string; revision?: string; treeDigest?: string }, expires?: string): Artifact => {
    const artifact: Artifact = {
      id: createHash("sha256").update(bytes).digest("hex"),
      name,
      mime: "image/png",
      data: Buffer.from(bytes).toString("base64"),
      bytes: bytes.length,
      ...(dataClass !== undefined ? { dataClass } : {}),
      ...(binding !== undefined ? { runId: binding.runId, ...(binding.revision !== undefined ? { revision: binding.revision } : {}), ...(binding.treeDigest !== undefined ? { treeDigest: binding.treeDigest } : {}) } : {}),
    };
    byId.set(artifact.id, artifact);
    return artifact;
  };
  return {
    ids: () => order,
    temporary: () => temps,
    store: {
      async put(name, bytes, dataClass, binding) {
        const a = record(name, bytes, dataClass, binding);
        order.push(a.id);
        return a.id;
      },
      async putTemporary(name, bytes, dataClass, binding) {
        const a = record(name, bytes, dataClass, binding);
        order.push(a.id);
        temps.push(a.id);
        return a.id;
      },
      async get(id) {
        return byId.get(id) ?? null;
      },
    },
  };
}

// --- look recording (Q3b): the session's screencast, finalised once ----------

/** A JPEG with the right magic: passes the artifact store's allowlist like a strip. */
const FAKE_JPEG = new Uint8Array([255, 216, 255, 224, 1, 2, 3, 4, 5]);
/** WebM's EBML magic, for the ffmpeg path's report. */
const FAKE_WEBM = new Uint8Array([26, 69, 223, 163, 1, 2, 3, 4]);
/** A sha1-shaped tree digest, as `git write-tree` prints one. */
const TREE = "a".repeat(40);

test("flag off: the session the driver spawns is LOOK_SESSION verbatim; flag on: the recorder rides after it", async () => {
  const off = fakeLookDriver();
  await runLook(off.executor, "t0", { kind: "look", url: "https://example.com/docs" });
  assert.equal(off.files.get(".teploy-agent/look-session.mjs"), LOOK_SESSION, "byte-identical session script when the input did not admit recording");

  const on = fakeLookDriver();
  await runLook(on.executor, "t0", { kind: "look", url: "https://example.com/docs" }, undefined, true);
  const script = on.files.get(".teploy-agent/look-session.mjs")!;
  assert.ok(script.startsWith(LOOK_SESSION), "the launch contract is unchanged — the recorder is appended, never spliced in");
  assert.match(script, /Page\.startScreencast/);
  // A static page never repaints after the screencast starts: one still per
  // load guarantees at least one frame (live finding 2026-10-18).
  assert.match(script, /Page\.captureScreenshot/);
  assert.match(script, /page\.on\("load"/);
  // A launched Browser lists no default context, so the recorder must watch
  // through its own CDP connection (probed in the sandbox image 2026-10-18:
  // launched view 0 pages, CDP view 1).
  assert.match(script, /const recView = await chromium\.connectOverCDP\("http:\/\/127\.0\.0\.1:9222"\)/);
  assert.doesNotMatch(script.slice(LOOK_SESSION.length), /browser\.contexts\(\)/);
  assert.match(script, /format: "jpeg", quality: 60, maxWidth: 960, maxHeight: 600, everyNthFrame: 2/, "the design's capture parameters, verbatim");
  assert.match(script, /rec: cap reached/, "the frame/byte caps stop loudly");
  assert.ok(script.includes(`"${LOOK_REC_DIR}"`), "frames and the captured page text land under the rec dir");
  assert.match(script, /text\.txt/, "the DOM text is captured beside the frames — the Q3c proxy");
});

test("lookRecordCommand: the look prelude, an honest none without a session, the ffmpeg probe, the throwaway-index tree digest, then the finaliser", () => {
  const cmd = lookRecordCommand();
  assert.match(cmd, /node \.teploy-agent\/look-record\.mjs$/);
  assert.match(cmd, /ln -sfn "\$pw" \.teploy-agent\/node_modules\/playwright/);
  assert.match(cmd, /echo '\{"kind":"none","reason":"no look session ran, so nothing was captured"\}'; exit 0/);
  assert.match(cmd, /if command -v ffmpeg[^\n]*; then : > \.teploy-agent\/rec\/ffmpeg; fi/, "ffmpeg is probed, never assumed");
  assert.match(cmd, /GIT_INDEX_FILE="\$PWD\/\.teploy-agent\/rec\/index"/, "the tree digest uses a throwaway index, never the real one");
  assert.match(cmd, /git write-tree/);
});

/**
 * The fake finaliser host. Only the browser half — ffmpeg, the canvas strip —
 * is faked: putFile records, exec answers the finaliser's node run with the
 * report it would print, getFile answers the captured text and the assembled
 * recording, and everything else is refused loudly (a look run must run
 * nothing but its own scripts).
 */
function fakeFinaliser(
  report: { kind: "strip" | "webm" | "none"; frames?: number; capped?: string; treeDigest?: string },
  options: { text?: string; bytes?: Uint8Array; exit?: number } = {},
): { executor: AgentExecutor; commands: string[]; pulled: string[] } {
  const commands: string[] = [];
  const pulled: string[] = [];
  const bytes = options.bytes ?? FAKE_JPEG;
  const executor: AgentExecutor = {
    async exec(cmd) {
      commands.push(cmd);
      if (/^node \.teploy-agent\/look-record\.mjs$/m.test(cmd)) {
        if (options.exit !== undefined) return { exitCode: options.exit, stdout: "", stderr: "look-record: the browser session did not answer CDP", timedOut: false, truncated: false };
        const out =
          report.kind === "none"
            ? { kind: "none", reason: "no look session ran, so nothing was captured" }
            : {
                kind: report.kind,
                file: `${LOOK_REC_DIR}/look-record.${report.kind === "webm" ? "webm" : "jpg"}`,
                frames: report.frames ?? 5,
                ...(report.capped !== undefined ? { capped: report.capped } : {}),
                ...(report.treeDigest !== undefined ? { treeDigest: report.treeDigest } : {}),
              };
        return { exitCode: 0, stdout: JSON.stringify(out), stderr: "", timedOut: false, truncated: false };
      }
      if (cmd === `rm -rf ${LOOK_REC_DIR}`) return { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
      return { exitCode: 9, stdout: "", stderr: `fake finaliser refuses to run: ${cmd}`, timedOut: false, truncated: false };
    },
    putFile: async (path, data) => {
      void path;
      void data;
    },
    getFile: async (path) => {
      pulled.push(path);
      if (path === `${LOOK_REC_DIR}/text.txt`) return new TextEncoder().encode(options.text ?? "");
      if (path.endsWith(".webm") || path.endsWith(".jpg")) return bytes;
      throw new Error(`unused: ${path}`);
    },
    destroy: async () => {},
  };
  return { executor, commands, pulled };
}

test("the finaliser stores a strip as a temporary recording bound to the run and the tree it observed", async () => {
  const fake = fakeFinaliser({ kind: "strip", frames: 7, capped: "rec: cap reached (frame)", treeDigest: TREE });
  const { store, temporary } = memoryArtifacts();
  const outcome = await runLookRecordFinalise(fake.executor, store, { runId: "run-look-record" }, [{ name: "git-token", value: "token-never-on-page-999" }]);
  assert.equal(outcome.kind, "stored");
  if (outcome.kind === "stored") {
    assert.equal(outcome.format, "strip", "no ffmpeg in the image: the result says it is a strip, never passing one off as video");
    assert.equal(outcome.frames, 7);
    assert.equal(outcome.capped, "rec: cap reached (frame)", "the cap is stated on the run page, not hidden");
    assert.equal(outcome.treeDigest, TREE, "the working tree it observed");
    assert.equal(outcome.digest, createHash("sha256").update(FAKE_JPEG).digest("hex"));
    const kept = (await Promise.all(temporary().map((id) => store.get(id)))).find((a) => a?.id === outcome.artifact);
    assert.ok(kept !== undefined && kept !== null, "the recording went through putTemporary — the 7-day screenshot retention");
    assert.equal(kept.dataClass, RECORDING_DATA_CLASS);
    assert.equal(kept.runId, "run-look-record");
    assert.equal(kept.revision, undefined, "a look recording claims no revision: it ran before the commit");
    assert.equal(kept.treeDigest, TREE);
  }
  assert.ok(fake.commands.includes(`rm -rf ${LOOK_REC_DIR}`), "the rec dir is deleted in the sandbox once finalised");
});

test("the finaliser stores a webm report the same way, under the recording data class", async () => {
  const fake = fakeFinaliser({ kind: "webm", frames: 30 }, { bytes: FAKE_WEBM });
  const { store, temporary } = memoryArtifacts();
  const outcome = await runLookRecordFinalise(fake.executor, store, { runId: "run-look-record" }, []);
  assert.equal(outcome.kind, "stored");
  if (outcome.kind === "stored") assert.equal(outcome.format, "webm");
  assert.equal(temporary().length, 1);
  assert.equal((await store.get(temporary()[0]!))?.dataClass, RECORDING_DATA_CLASS);
});

test("Q3c: a page that rendered a configured secret withholds the recording — nothing stored, the refusal names the secret, never the value", async () => {
  const secret = "ghp_secret-on-screen-987654321";
  const fake = fakeFinaliser({ kind: "strip", frames: 4 }, { text: `Account\n personal token ${secret}\n bye` });
  const { store, ids } = memoryArtifacts();
  const outcome = await runLookRecordFinalise(fake.executor, store, { runId: "run-look-record" }, [{ name: "git-token", value: secret }]);
  assert.equal(outcome.kind, "withheld");
  if (outcome.kind === "withheld") {
    assert.match(outcome.reason, /configured secret value \(git-token\)/);
    assert.ok(!outcome.reason.includes(secret), "the refusal names WHICH secret, never the value");
  }
  assert.deepEqual(ids(), [], "nothing was stored");
  assert.ok(!JSON.stringify(outcome).includes(secret), "the step result carries no trace of the value");
  assert.ok(!fake.pulled.some((p) => p.endsWith(".jpg") || p.endsWith(".webm")), "the recording bytes were never even transferred out of the sandbox");
  assert.ok(fake.commands.includes(`rm -rf ${LOOK_REC_DIR}`), "the captured bytes are deleted in the sandbox");
});

test("a page without the secret records normally — the check is a gate, not a default refusal", async () => {
  const fake = fakeFinaliser({ kind: "strip", frames: 4 }, { text: "a clean page" });
  const { store, ids } = memoryArtifacts();
  const outcome = await runLookRecordFinalise(fake.executor, store, { runId: "run-look-record" }, [{ name: "git-token", value: "ghp_secret-on-screen-987654321" }]);
  assert.equal(outcome.kind, "stored");
  assert.equal(ids().length, 1);
});

test("an over-cap recording is dropped with the reason recorded, never silently truncated", async () => {
  const big = new Uint8Array(LOOK_RECORD_MAX_BYTES + 1);
  big.set([255, 216, 255, 224], 0);
  const fake = fakeFinaliser({ kind: "strip", frames: 600 }, { bytes: big });
  const { store, ids } = memoryArtifacts();
  const outcome = await runLookRecordFinalise(fake.executor, store, { runId: "run-look-record" }, []);
  assert.equal(outcome.kind, "dropped");
  if (outcome.kind === "dropped") assert.match(outcome.reason, new RegExp(`over the ${LOOK_RECORD_MAX_BYTES} byte cap: dropped rather than truncated`));
  assert.deepEqual(ids(), [], "over-cap bytes never reach the store");
});

test("no session, a dead finaliser, and a worker with no store are honest recorded outcomes, never run failures", async () => {
  const none = fakeFinaliser({ kind: "none" });
  assert.equal((await runLookRecordFinalise(none.executor, memoryArtifacts().store, { runId: "r" })).kind, "none");

  const dead = fakeFinaliser({ kind: "strip" }, { exit: 1 });
  const failed = await runLookRecordFinalise(dead.executor, memoryArtifacts().store, { runId: "r" });
  assert.equal(failed.kind, "failed");
  if (failed.kind === "failed") assert.match(failed.reason, /CDP/);

  const homeless = fakeFinaliser({ kind: "strip", frames: 3 });
  const dropped = await runLookRecordFinalise(homeless.executor, undefined, { runId: "r" });
  assert.equal(dropped.kind, "dropped");
  if (dropped.kind === "dropped") assert.match(dropped.reason, /no artifact store/);
});

test("the strip finaliser passes page.evaluate one argument (playwright refuses more)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./look.js", import.meta.url), "utf8");
  // Found live 2026-10-18: playwright throws "Too many arguments" past one.
  assert.doesNotMatch(src, /page\.evaluate\(\(w, h\)/);
  assert.doesNotMatch(src, /\}\), i, b64, cols, tileW, tileH\);/);
  assert.match(src, /\{ i, b64, cols, tileW, tileH \}\);/);
});

test("the strip finaliser exits instead of idling on its CDP connection (live finding 2026-10-18: exit 124)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./look.js", import.meta.url), "utf8");
  // The strip path ends by exiting the process, after the page closes.
  assert.match(src, /await page\.close\(\)\.catch\(\(\) => \{\}\);\n\}\n(\/\/[^\n]*\n)*process\.exit\(0\);/);
});
