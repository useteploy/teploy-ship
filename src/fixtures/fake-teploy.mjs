#!/usr/bin/env node
// A FAKE `teploy` CLI for teploy-adapter.test.ts. It emulates only the four
// commands the adapter issues (`status --json`, `deploy`, `rollback --to`,
// `exec <server> -- docker image inspect <name>`) over a JSON state file named
// by FAKE_TEPLOY_STATE. Nothing here talks to a network, a docker daemon or a
// real teploy binary.
//
// The status shape is the one captured live from the real CLI on 2026-09-22
// (see delivery.test.ts): top-level `app` and `server`, snake_case
// `state.current_hash`, and containers whose fields are the Go struct's
// capitalised ID/Name/Image/State. The faults a test can arm live in the same
// state file so the test harness can flip them between calls:
//   unreadable: "exit" | "garbage"   status fails / prints non-JSON
//   wrongApp: "<name>"               status describes another app
//   hideArtifact: true               containers report an image ID and `exec`
//                                    cannot resolve it (the artifact is hidden)
//   idForm: true                     containers report an image ID; `exec`
//                                    resolves it through imageTags
//   pending: {when, change}          a rival change lands at the START of the
//                                    next deploy ("before-deploy") or just
//                                    after it applied ("after-deploy")
//   failDeploy: "exit-before" | "exit-after-apply"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const path = process.env.FAKE_TEPLOY_STATE;
if (!path) {
  process.stderr.write("fake teploy: FAKE_TEPLOY_STATE is not set\n");
  process.exit(2);
}
const load = () => JSON.parse(readFileSync(path, "utf8"));
const save = (s) => writeFileSync(path, JSON.stringify(s, null, 2));
const log = (line) => appendFileSync(`${path}.calls`, `${line}\n`);

const imageFor = (s, image) => {
  if (!s.idForm && !s.hideArtifact) return image;
  const id = randomBytes(6).toString("hex");
  s.imageTags = { ...(s.imageTags ?? {}), [id]: [image] };
  return id;
};

/** Make the target serve (hash, image) with a NEW container, as a real redeploy does. */
const land = (s, hash, image) => {
  s.current_hash = hash;
  s.containers = [{ ID: randomBytes(6).toString("hex"), Name: `${s.app}-web-${hash}`, Image: imageFor(s, image), State: "running" }];
  s.releases = [...(s.releases ?? []).filter((r) => r.hash !== hash), { hash, image }];
};

const applyChange = (s, change) => {
  if (change.unreadable) s.unreadable = "exit";
  else land(s, change.revision, change.artifact);
};

const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const s = load();
log(`${cmd} ${args.join(" ")}`);

if (cmd === "status") {
  if (s.unreadable === "exit") {
    process.stderr.write("ssh: connect to host: connection refused\n");
    process.exit(1);
  }
  if (s.unreadable === "garbage") {
    process.stdout.write("<html>502 bad gateway</html>");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    app: s.wrongApp ?? s.app,
    server: s.server,
    state: { current_hash: s.current_hash ?? "", schema_version: 2 },
    containers: s.containers ?? [],
  }));
  process.exit(0);
}

if (cmd === "deploy") {
  if (s.pending?.when === "before-deploy") {
    applyChange(s, s.pending.change);
    s.pending = null;
  }
  if (s.failDeploy === "exit-before") {
    save(s);
    process.stderr.write("deploy: build cache unavailable\n");
    process.exit(1);
  }
  const image = flag("--image");
  const version = flag("--version");
  if (!image || !version) {
    save(s);
    process.stderr.write("deploy: --image and --version are required\n");
    process.exit(2);
  }
  // A real deploy takes seconds; the pause is what lets a test see two
  // overlapping deploys if the adapter's caller failed to serialise them.
  await new Promise((r) => setTimeout(r, 25));
  land(s, version, image);
  if (s.pending?.when === "after-deploy") {
    applyChange(s, s.pending.change);
    s.pending = null;
  }
  save(s);
  if (s.failDeploy === "exit-after-apply") {
    process.stderr.write("deploy: timed out waiting for health check\n");
    process.exit(1);
  }
  process.stdout.write("Deployed\n");
  process.exit(0);
}

if (cmd === "rollback") {
  const to = flag("--to");
  const release = (s.releases ?? []).find((r) => r.hash === to);
  if (!release) {
    process.stderr.write(`rollback: version ${to} is not retained\n`);
    process.exit(1);
  }
  land(s, release.hash, release.image);
  save(s);
  process.stdout.write(`Rolled back to ${to}\n`);
  process.exit(0);
}

if (cmd === "exec") {
  // exec <server> -- docker image inspect <name>
  const name = args[args.length - 1];
  if (s.hideArtifact || s.unreadable === "exit") {
    process.stderr.write("exec: ssh: connection refused\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify([{ Id: `sha256:${name}`, RepoTags: (s.imageTags ?? {})[name] ?? [] }]));
  process.exit(0);
}

process.stderr.write(`fake teploy: unsupported command ${cmd}\n`);
process.exit(2);
