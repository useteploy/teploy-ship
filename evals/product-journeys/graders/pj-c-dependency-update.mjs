// Scenario pj-c-dependency-update: pin lifted past the 4.x rename, both call
// shapes handled, fallback intact, tests pass offline. The 3.x/4.x call
// shapes are verified BEHAVIOURALLY with fake markdown modules injected on
// sys.path — no network, no real package.
import * as lib from './lib.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function specAllows4(line) {
  const m = line.trim().match(/^markdown\s*(.*)$/);
  if (!m) return false;
  const clauses = m[1].split(',').map(c => c.trim()).filter(Boolean);
  if (clauses.length === 0) return true; // bare name admits any version
  return clauses.every(c => {
    const mm = c.match(/^(>=|<=|==|!=|>|<|~=)\s*([\d.]+)/);
    if (!mm) return true;
    const [, op, verStr] = mm;
    const major = Number(verStr.split('.')[0]);
    if (op === '<' || op === '<=') return major > 4; // only bounds above 4.x still admit 4.x
    if (op === '==') return major === 4;
    return true; // >=, >, ~=, != with lower bounds can still admit 4.x
  });
}

function shapeProbe(cwd, dir, subdir, marker) {
  return lib.run('python3', ['-c', `
import sys
sys.path.insert(0, ${JSON.stringify(join(dir, subdir))})
import service
out = service.render_description('*hi*')
assert '${marker}' in out, f'wrong render result: {out}'
print('${subdir}-ok')
`], { cwd, timeoutMs: 30000 });
}

export async function grade({ workDir }) {
  const reasons = [];
  const evidence = [];

  const req = lib.readText(workDir, 'requirements.txt');
  const markdownLine = req.split('\n').find(l => l.trim().startsWith('markdown'));
  const allows4 = markdownLine !== undefined && specAllows4(markdownLine);
  evidence.push({ kind: 'structural', check: 'requirements.txt allows markdown 4.x', value: { line: markdownLine, allows4 } });
  if (!allows4) reasons.push(`requirements.txt does not allow markdown 4.x (${JSON.stringify(markdownLine)})`);

  const dir = lib.mktmp('pj-c-dep-');
  mkdirSync(join(dir, 'three'));
  mkdirSync(join(dir, 'four'));
  writeFileSync(join(dir, 'three', 'markdown.py'), 'def markdown(text):\n    return "<markdown-3>" + text + "</markdown-3>"\n');
  writeFileSync(join(dir, 'four', 'markdown.py'), 'def render(text):\n    return "<markdown-4>" + text + "</markdown-4>"\n');

  const shape3 = await shapeProbe(workDir, dir, 'three', 'markdown-3');
  evidence.push({ kind: 'probe', check: '3.x markdown.markdown call shape works', value: { code: shape3.code, out: (shape3.stdout + shape3.stderr).trim().slice(-300) } });
  if (shape3.code !== 0) reasons.push('render path fails with a 3.x-only markdown module — the current shape was dropped');

  const shape4 = await shapeProbe(workDir, dir, 'four', 'markdown-4');
  evidence.push({ kind: 'probe', check: '4.x markdown.render call shape works', value: { code: shape4.code, out: (shape4.stdout + shape4.stderr).trim().slice(-300) } });
  if (shape4.code !== 0) reasons.push('render path fails with a 4.x-only markdown module — the rename was not handled');

  const fallback = await lib.run('python3', ['-c', `
import importlib.util, service
if importlib.util.find_spec('markdown'):
    print('markdown-installed; offline fallback probe not applicable')
else:
    out = service.render_description('*hi*')
    assert out == '*hi*', f'fallback broken: {out}'
    print('fallback-ok')
`], { cwd: workDir, timeoutMs: 30000 });
  evidence.push({ kind: 'probe', check: 'no-package fallback intact', value: { code: fallback.code, out: (fallback.stdout + fallback.stderr).trim().slice(-300) } });
  if (fallback.code !== 0) reasons.push('no-package fallback path is broken');

  const tests = await lib.run('python3', ['-m', 'unittest', 'discover', '-s', 'tests'], { cwd: workDir, timeoutMs: 120000 });
  evidence.push({ kind: 'fixture-tests', check: 'suite passes offline in the worked tree', value: tests.code });
  if (tests.code !== 0) reasons.push(`test suite fails offline:\n${tests.stdout.slice(-1500)}`);

  return lib.result(reasons.length === 0, reasons, evidence);
}
