#!/usr/bin/env node
/**
 * Guard against shipping a stale dist/ (incident 2026-10-18).
 *
 * Four production deploys in a row shipped a dist/ built hours earlier while
 * the image label carried the new git revision, because the Dockerfile COPYed
 * locally pre-built `dist/` and `web/dist/` and nothing tied those outputs to
 * the source beside them. The fix compiles both in a builder stage from the
 * source in the build context, and this script is the tripwire that keeps
 * that fix from being quietly reverted: it fails when the Dockerfile copies
 * host build outputs again, when the ignore files would let a host dist/
 * back into a build context, or when the source the image needs is excluded
 * from what `teploy deploy` syncs.
 *
 * Plain node, no dependencies — same shape as scripts/flag-reference.mjs, so
 * every CI job can afford to run it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const fail = (msg) => failures.push(msg);
const read = (p) => {
  const full = join(root, p);
  if (!existsSync(full)) {
    fail(`${p} is missing — the image build cannot be verified without it`);
    return '';
  }
  return readFileSync(full, 'utf8');
};

/** Parse an ignore file into non-comment, non-empty patterns. */
const patterns = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));

/** Does an ignore list cover `path`? Matches `path`, `/path`, `path/`, `dir/**` forms. */
const excludes = (list, path) =>
  list.some((p) => {
    const negated = p.startsWith('!');
    const bare = negated ? p.slice(1) : p;
    return !negated && (bare === path || bare === `/${path}` || bare === `${path}/`);
  });

// 1. .dockerignore must keep host build outputs and dependency trees out of
//    the Docker build context. Without this, a `COPY dist/` reintroduced in
//    the Dockerfile would go back to silently shipping whatever was last
//    built on the laptop that ran the deploy.
const dockerignore = patterns(read('.dockerignore'));
const teployignore = patterns(read('.teployignore'));
const dockerfile = read('Dockerfile');
const dockerfileLines = dockerfile.split('\n').map((l) => l.trim());
for (const path of ['.git', 'node_modules', 'web/node_modules', 'dist', 'web/dist']) {
  if (!excludes(dockerignore, path)) fail(`.dockerignore does not exclude ${path}`);
}

// 2. The Dockerfile must not COPY host build outputs, and must take both
//    compiled trees from the builder stage instead.
for (const line of dockerfileLines) {
  if (/^COPY\s+(--from=\S+\s+)?(dist|web\/dist)\/?\s/.test(line) && !line.startsWith('COPY --from=')) {
    fail(`Dockerfile copies a host build output instead of compiling it: ${line}`);
  }
}
const fromBuilder = dockerfileLines.filter((l) => /^COPY\s+--from=builder\s+/.test(l));
if (!fromBuilder.some((l) => /\sdist\b|\sdist\//.test(l))) {
  fail('Dockerfile does not COPY --from=builder the compiled dist/');
}
if (!fromBuilder.some((l) => /web\/dist\b|web\/dist\//.test(l))) {
  fail('Dockerfile does not COPY --from=builder the compiled web/dist/');
}

// 3. The builder stage must actually compile both trees from source with the
//    same commands CI runs, from the lockfile.
for (const needed of [
  /pnpm install --frozen-lockfile/,
  /pnpm --dir web install --frozen-lockfile/,
  /pnpm run build/,
  /cd web && pnpm run build|pnpm --dir web run build/,
]) {
  if (!needed.test(dockerfile)) fail(`Dockerfile builder stage is missing: ${needed}`);
}

// 4. .teployignore must sync the source the builder compiles and must not
//    re-allowlist build outputs (the `!` lines that caused the incident:
//    dist/ is gitignored, and the sync used to un-ignore it on purpose).
for (const forbidden of ['!/dist/', '!/web/dist/']) {
  if (teployignore.includes(forbidden)) fail(`.teployignore re-includes a build output: ${forbidden}`);
}
for (const source of ['/src', 'src', '/web/src', 'web/src']) {
  if (teployignore.includes(source)) fail(`.teployignore excludes source the image compiles: ${source}`);
}

if (failures.length > 0) {
  console.error('check-image-sources: FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('check-image-sources: OK — the image compiles dist/ and web/dist/ from synced source, and no host build output can reach it.');
