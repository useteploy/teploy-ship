// Source-level guards for defects the S10 UI audit (scripts/ui-audit.mjs) found.
// They are deliberately blunt: the audit is the behavioural check, these stop
// the specific regressions from coming back between audit runs.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DESIGN_CSS } from "./design.js";

const root = join(import.meta.dirname, "..");
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(name) ? [path] : [];
  });
}

test("no table header cell is empty (screen readers announce a blank column)", () => {
  const offenders = [...sources(join(root, "routes")), ...sources(join(root, "views"))].filter((f) => /<th\s*\/>|<th>\s*<\/th>/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, []);
});

test("policy and reviewer form controls that only had a placeholder carry an accessible name", () => {
  const src = readFileSync(join(root, "routes/policies.tsx"), "utf8");
  for (const input of src.match(/<input[^>]*type="(?:text|time)"[^>]*>/g) ?? []) assert.match(input, /aria-label=|id=/, input);
});

test("design CSS keeps text links distinguishable without colour and provides .sr-only", () => {
  assert.match(DESIGN_CSS, /\.meta > a[^{]*\{[^}]*text-decoration: underline/);
  assert.match(DESIGN_CSS, /\.sr-only \{[^}]*clip: rect\(0 0 0 0\)/);
});
