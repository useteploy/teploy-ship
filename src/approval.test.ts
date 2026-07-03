import assert from "node:assert/strict";
import { test } from "node:test";

import { autoApprove, defaultApprovalPolicy } from "./approval.js";

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
