import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentExecutor, ExecResult } from "@neutron-build/agents";

import { LOOK_HELP } from "./actions.js";
import { FileArtifacts, LOOK_IMAGE_DATA_CLASS, type Artifact, type ArtifactStore } from "./artifacts.js";
import {
  LOOK_IMAGE_NO_MODEL,
  LOOK_IMAGE_NO_STORE,
  LOOK_OPEN_PLAN,
  LOOK_SEALED,
  LOOK_SESSION,
  describeNeedle,
  findMatches,
  lookCommand,
  lookImageCap,
  lookShotPath,
  lookStaleRef,
  renderLook,
  runLook,
  runLookImage,
} from "./look.js";
import type { LookAction } from "./look.js";

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
function memoryArtifacts(): { store: ArtifactStore; ids: () => string[] } {
  const byId = new Map<string, Artifact>();
  const order: string[] = [];
  return {
    ids: () => order,
    store: {
      async put(name, bytes, dataClass) {
        const artifact: Artifact = {
          id: createHash("sha256").update(bytes).digest("hex"),
          name,
          mime: "image/png",
          data: Buffer.from(bytes).toString("base64"),
          bytes: bytes.length,
          ...(dataClass !== undefined ? { dataClass } : {}),
        };
        byId.set(artifact.id, artifact);
        order.push(artifact.id);
        return artifact.id;
      },
      async get(id) {
        return byId.get(id) ?? null;
      },
    },
  };
}
