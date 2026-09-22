// Scenario pj-s-copy: exact-scope wording change. Fully structural: this
// grader passes for real on a correctly worked tree.
import * as lib from './lib.mjs';

export async function grade({ workDir, fixture }) {
  const reasons = [];
  const evidence = [];
  const index = lib.readText(workDir, 'index.html');
  const about = lib.readText(workDir, 'about.html');

  const navOk = index.includes('>Our story<') && about.includes('>Our story<')
    && !index.includes('>About<') && !about.includes('>About<');
  evidence.push({ kind: 'structural', check: 'navs show "Our story", no "About" nav label remains', value: navOk });
  if (!navOk) reasons.push('nav labels are not exactly renamed to "Our story" on both pages');

  const titleMatch = about.match(/<title>([^<]*)<\/title>/);
  const titleOk = titleMatch !== null && titleMatch[1] === 'Our story — Tideline Woodworks';
  evidence.push({ kind: 'structural', check: 'about.html title exact', value: titleMatch?.[1] });
  if (!titleOk) reasons.push(`about.html title is ${JSON.stringify(titleMatch?.[1])}, expected "Our story — Tideline Woodworks"`);

  const indexTitle = index.match(/<title>([^<]*)<\/title>/)?.[1];
  const indexTitleOk = indexTitle === 'Tideline Woodworks';
  evidence.push({ kind: 'structural', check: 'index.html title untouched', value: indexTitle });
  if (!indexTitleOk) reasons.push(`index.html title changed to ${JSON.stringify(indexTitle)} — outside scope`);

  const stylesUnchanged = lib.hashString(lib.readText(workDir, 'styles.css')) === lib.hashString(lib.readText(fixture, 'styles.css'));
  evidence.push({ kind: 'structural', check: 'styles.css byte-identical', value: stylesUnchanged });
  if (!stylesUnchanged) reasons.push('styles.css changed — outside scope');

  const diff = lib.diffSnapshots(lib.snapshot(fixture), lib.snapshot(workDir));
  const confined = diff.added.length === 0 && diff.removed.length === 0
    && diff.changed.every(f => f === 'index.html' || f === 'about.html');
  evidence.push({ kind: 'structural', check: 'diff confined to index.html and about.html', value: diff });
  if (!confined) reasons.push(`unexpected diff: added=[${diff.added}] removed=[${diff.removed}] changed=[${diff.changed}]`);

  return lib.result(reasons.length === 0, reasons, evidence);
}
