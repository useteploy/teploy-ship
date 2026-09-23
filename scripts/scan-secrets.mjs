#!/usr/bin/env node
// Fail the build on a credential committed to the tree.
//
// Deliberately a small local script rather than a third-party scanning action:
// it needs no license, no network, and no trust in another publisher's
// workflow, and it shares its patterns with the publication screen that stops
// the AGENT committing the same shapes (src/publish-policy.ts). The check that
// guards Ship's own repository and the check that guards the repositories Ship
// writes to should not be able to disagree.
//
// The pattern set also guards the S19 support bundle (src/support.ts redacts
// every hit before it reaches a vendor). The canonical copy lives in
// src/secret-patterns.ts; this script repeats the literals because it must run
// off a bare checkout with no build, and scripts/scan-secrets.test.mjs fails
// the suite if the two ever drift apart.
//
// Usage: node scripts/scan-secrets.mjs [paths...]   (default: git ls-files)
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { argv } from "node:process";

export const PATTERNS = [
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{20,}\b/ },
  { name: "OpenAI-style key", re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: "credential in a URL", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]{6,}@/ },
];

// Files that legitimately contain the SHAPES above: the patterns themselves,
// and the tests that prove they match.
const ALLOW = [/^src\/publish-policy\.ts$/, /^src\/redact\.ts$/, /^src\/secret-patterns\.ts$/, /^scripts\/scan-secrets\.mjs$/, /\.test\.ts$/, /\.test\.mjs$/];

/** Scan the given files (default: the tracked tree). Exits 1 on any finding. */
export function scan(files) {
  let findings = 0;
  for (const file of files) {
    if (ALLOW.some((re) => re.test(file))) continue;
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue; // deleted between listing and reading
    }
    if (!stat.isFile() || stat.size > 2_000_000) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // binary or unreadable
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      for (const { name, re } of PATTERNS) {
        if (re.test(lines[i])) {
          console.error(`${file}:${i + 1}: possible ${name}`);
          findings += 1;
        }
      }
    }
  }
  return findings;
}

// Run only when invoked as the CLI, not when a test imports the module.
const invokedDirectly = argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href;
if (invokedDirectly) {
  const files =
    argv.length > 2
      ? argv.slice(2)
      : execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const findings = scan(files);
  if (findings > 0) {
    console.error(`\n${findings} possible credential(s) found. Remove them and rotate anything real.`);
    process.exit(1);
  }
  console.log(`scanned ${files.length} files, no credentials found`);
}
