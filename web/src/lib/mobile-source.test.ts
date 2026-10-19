// Source-level guards for the mobile layout (390 px audit, 2026-10-18). The
// behavioural check is a browser pass at 360/390/414/768; these stop the
// specific regressions from coming back between passes.
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

test("form text is 16px on touch layouts so iOS does not zoom on focus", () => {
  assert.match(DESIGN_CSS, /@media \(max-width: 720px\), \(pointer: coarse\) \{\s*input[^{]*select, textarea \{ font-size: 16px !important; \}/);
});

test("the nav collapses behind a Menu button below desktop", () => {
  const layout = readFileSync(join(root, "routes/_layout.tsx"), "utf8");
  assert.match(layout, /class="nav-toggle" aria-expanded="false" aria-controls="main-nav"/);
  assert.match(layout, /<nav class="nav" id="main-nav"/);
  assert.match(layout, /header\.top\.nav-open nav\.nav \{ display: flex; \}/);
  assert.match(layout, /viewport-fit=cover/);
});

/** The header's identity controls must reach a 44x44 touch target on ANY
 *  touch device — including one wider than every width breakpoint, which is
 *  why the query keys on input capability and never on width alone. */
test("header brand and product chip are 44x44 touch targets on coarse pointers", () => {
  const layout = readFileSync(join(root, "routes/_layout.tsx"), "utf8");
  const query = /@media \(max-width: 720px\), \(pointer: coarse\), \(any-pointer: coarse\) \{([\s\S]*?)\n\}/.exec(layout);
  assert.ok(query !== null, "the header touch block must key on pointer capability, not width alone");
  const block = query[1]!;
  assert.match(block, /header\.top \.brand \{[^}]*min-height: 44px[^}]*min-width: 44px/);
  assert.match(block, /header\.top \.switcher-static \{[^}]*min-height: 44px[^}]*min-width: 44px/);
});

test("the runs list renders as cards below desktop", () => {
  assert.match(readFileSync(join(root, "routes/runs/index.tsx"), "utf8"), /<table class="runs run-list">/);
  assert.match(DESIGN_CSS, /@media \(max-width: 920px\) \{\s*table\.run-list thead/);
});

/** RunMeta.repo reaches every surface that renders a run row; absent repo
 *  renders nothing (the guard is the conditional, not the string). */
test("run rows show the run's repository when meta carries one", () => {
  const runs = readFileSync(join(root, "routes/runs/index.tsx"), "utf8");
  assert.match(runs, /run\.repo !== undefined && <span class="run-repo"/);
  const inbox = readFileSync(join(root, "routes/index.tsx"), "utf8");
  assert.match(inbox, /r\.repo !== undefined && <span class="meta">\{r\.repo\}<\/span>/);
  const attention = readFileSync(join(root, "routes/attention.tsx"), "utf8");
  assert.match(attention, /r\.repo !== undefined && <span class="run-repo"/);
  assert.match(DESIGN_CSS, /\.run-repo \{[^}]*text-overflow: ellipsis/, "the repo line truncates rather than pushing a card wide");
});

test("every table sits in a scroll container or stacks on a phone", () => {
  const offenders: string[] = [];
  for (const f of [...sources(join(root, "routes")), ...sources(join(root, "views"))]) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (/<table[\s>]/.test(line) && !/table-wrap[^>]*>\s*<table/.test(line) && !line.includes("stack")) offenders.push(`${f}: ${line.trim()}`);
    }
  }
  // A table may open on the line after its wrapper.
  const unwrapped = offenders.filter((o) => {
    const [file] = o.split(": ");
    const lines = readFileSync(file, "utf8").split("\n");
    const i = lines.findIndex((l) => l.trim() === o.slice(file.length + 2));
    return !/table-wrap/.test(lines[i - 1] ?? "");
  });
  assert.deepEqual(unwrapped, []);
});
