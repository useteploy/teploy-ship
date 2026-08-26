import assert from "node:assert/strict";
import { test } from "node:test";

import { autoApprove, defaultApprovalPolicy, resolveApprovalPolicy, sandboxApprovalPolicy } from "./approval.js";

test("default policy flags destructive, network, and privilege commands", () => {
  for (const cmd of ["rm -rf /", "sudo apt install x", "curl http://x", "wget http://x", "git push origin main", "mkfs.ext4 /dev/sda", "dd if=/dev/zero of=/dev/sda", "shutdown now"]) {
    assert.equal(defaultApprovalPolicy({ kind: "bash", code: cmd }), "required", `expected required: ${cmd}`);
  }
});

test("default policy auto-approves ordinary commands", () => {
  for (const cmd of ["ls -la", "cat file.txt", "python3 script.py", "echo hi > out.txt", "grep foo *.js", "npm test", "mkdir build"]) {
    assert.equal(defaultApprovalPolicy({ kind: "bash", code: cmd }), "auto", `expected auto: ${cmd}`);
  }
});

test("default policy flags python that shells out or opens the network", () => {
  assert.equal(defaultApprovalPolicy({ kind: "python", code: "import os; os.system('rm x')" }), "required");
  assert.equal(defaultApprovalPolicy({ kind: "python", code: "import requests; requests.get(u)" }), "required");
  assert.equal(defaultApprovalPolicy({ kind: "python", code: "shutil.rmtree('/tmp/x')" }), "required");
  assert.equal(defaultApprovalPolicy({ kind: "python", code: "print(sum(range(10)))" }), "auto");
});

test("finish and none never require approval", () => {
  assert.equal(defaultApprovalPolicy({ kind: "finish", message: "done" }), "auto");
  assert.equal(defaultApprovalPolicy({ kind: "none" }), "auto");
});

test("autoApprove approves everything", () => {
  assert.equal(autoApprove({ kind: "bash", code: "rm -rf /" }), "auto");
});

test("sandboxApprovalPolicy admits the verification steps that stalled L0 round 2", () => {
  const admitted = [
    "rm -rf /tmp/vfy && mkdir -p /tmp/vfy && cp -a /work/. /tmp/vfy/ && cd /tmp/vfy && go test ./...",
    "cd /tmp && timeout 90 curl -sSL -o t.zip https://proxy.golang.org/golang.org/toolchain/@v/list",
    "env | grep -i proxy; curl -sS -o /dev/null -w '%{http_code}\\n' https://proxy.golang.org/",
    "mkdir -p .teploy-agent && cat > .teploy-agent/findings.json <<'EOF'\n[]\nEOF",
    "sudo apt-get install -y jq",
  ];
  for (const code of admitted) {
    assert.equal(sandboxApprovalPolicy({ kind: "bash", code }), "auto", `expected auto: ${code}`);
  }
  assert.equal(
    sandboxApprovalPolicy({ kind: "python", code: "import subprocess; subprocess.run(['go','test','./...'])" }),
    "auto",
  );
});

test("sandboxApprovalPolicy still gates what outlives the container", () => {
  const gated = [
    "git push origin HEAD:refs/heads/mine",
    "npm publish --access public",
    "pnpm publish",
    "cargo publish",
    "twine upload dist/*",
    "gh release create v1.0.0",
    "docker push registry.example.com/app:latest",
  ];
  for (const code of gated) {
    assert.equal(sandboxApprovalPolicy({ kind: "bash", code }), "required", `expected required: ${code}`);
  }
});

test("resolveApprovalPolicy: no sandbox means no boundary to lean on", () => {
  const noSandbox = resolveApprovalPolicy({ sandboxed: false }, {});
  assert.equal(noSandbox({ kind: "bash", code: "rm -rf /tmp/x" }), "required");
  const sandboxed = resolveApprovalPolicy({ sandboxed: true }, {});
  assert.equal(sandboxed({ kind: "bash", code: "rm -rf /tmp/x" }), "auto");
});

test("resolveApprovalPolicy honours SHIP_SANDBOX_APPROVAL", () => {
  const strict = resolveApprovalPolicy({ sandboxed: true }, { SHIP_SANDBOX_APPROVAL: "strict" });
  assert.equal(strict({ kind: "bash", code: "curl https://example.com" }), "required");
  const auto = resolveApprovalPolicy({ sandboxed: true }, { SHIP_SANDBOX_APPROVAL: "auto" });
  assert.equal(auto({ kind: "bash", code: "git push" }), "auto");
  const boundary = resolveApprovalPolicy({ sandboxed: true }, { SHIP_SANDBOX_APPROVAL: "boundary" });
  assert.equal(boundary({ kind: "bash", code: "curl https://example.com" }), "auto");
  assert.equal(boundary({ kind: "bash", code: "git push" }), "required");
  // An unknown value falls back to the default rather than silently disabling the gate.
  const bogus = resolveApprovalPolicy({ sandboxed: false }, { SHIP_SANDBOX_APPROVAL: "yolo" });
  assert.equal(bogus({ kind: "bash", code: "curl https://example.com" }), "required");
});
