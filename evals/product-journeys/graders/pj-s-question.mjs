// Scenario pj-s-question: grounded question about the static site.
// Structural: the work tree must be untouched. The citation checks verify
// the run transcript against the pristine fixture: every cited
// file:line:"string" occurrence must exist verbatim, the cited lines that
// contain "Tideline" must exactly cover the fixture's own Tideline lines,
// and the home-page tagline line must be among the citations. "No PR
// opened" is verified from the adapter-reported summary. Without a
// transcript the citation checks fall back to not-wired and fail — no
// grader passes on checks it cannot perform.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as lib from './lib.mjs';

// A citation is a dotted filename, a line number and a quoted exact string,
// tolerant of the separators a real answer uses:
//   index.html:6:"Tideline Woodworks"
//   about.html, line 15: "Tideline Woodworks"
// The quoted string is mandatory — "the exact current string" is the task's
// own demand — and unknown files are rejected by the caller of this match.
const CITATION = /([A-Za-z0-9_.-]+\.[A-Za-z0-9]+)\s*[,:]\s*(?:line\s+)?(\d+)\s*[,:]\s*"([^"]*)"/g;

function fixtureLines(fixture) {
  const files = new Map();
  for (const rel of lib.walkFiles(fixture)) {
    files.set(rel, readFileSync(join(fixture, rel), 'utf8').split('\n'));
  }
  return files;
}

function linesContaining(files, needle) {
  const hits = new Set();
  for (const [rel, lines] of files) {
    lines.forEach((line, i) => {
      if (line.includes(needle)) hits.add(`${rel}:${i + 1}`);
    });
  }
  return hits;
}

export async function grade({ workDir, fixture, transcriptPath, summary }) {
  const reasons = [];
  const evidence = [];
  const diff = lib.diffSnapshots(lib.snapshot(fixture), lib.snapshot(workDir));
  const unchanged = diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
  evidence.push({ kind: 'structural', check: 'work tree unchanged', value: diff });
  if (!unchanged) {
    reasons.push(`work tree changed: added=[${diff.added}] removed=[${diff.removed}] changed=[${diff.changed}] — the task is answer-only`);
  }

  const transcript = transcriptPath ? readFileSync(transcriptPath, 'utf8') : null;
  if (transcript === null) {
    for (const check of [
      'every cited file:line:string occurrence verified verbatim against the fixture',
      'cited occurrence count matches an independent count over the fixture',
      'no PR opened'
    ]) {
      const nw = lib.notWired(`${check} (requires a run transcript)`);
      reasons.push(nw.reason);
      evidence.push(nw.evidence);
    }
    return lib.result(false, reasons, evidence);
  }

  const files = fixtureLines(fixture);
  const citations = [...transcript.matchAll(CITATION)].map(m => ({ file: m[1], line: Number(m[2]), str: m[3] }));

  let citationsOk = true;
  if (citations.length === 0) {
    reasons.push('the transcript cites nothing in a checkable form — each occurrence needs file, line number and the quoted exact string, e.g. index.html:6:"Tideline Woodworks" or about.html, line 15: "Tideline Woodworks"');
    citationsOk = false;
  }
  const citedTideline = new Set();
  for (const c of citations) {
    const lines = files.get(c.file);
    if (lines === undefined) {
      reasons.push(`cites a file the fixture does not contain: ${c.file}`);
      citationsOk = false;
      continue;
    }
    const lineText = lines[c.line - 1];
    if (lineText === undefined) {
      reasons.push(`${c.file}:${c.line} is past the end of the file`);
      citationsOk = false;
      continue;
    }
    if (!lineText.includes(c.str)) {
      reasons.push(`${c.file}:${c.line} does not contain ${JSON.stringify(c.str)} verbatim`);
      citationsOk = false;
    }
    if (lineText.includes('Tideline')) citedTideline.add(`${c.file}:${c.line}`);
  }
  evidence.push({ kind: 'transcript', check: 'every cited file:line:string occurrence exists verbatim in the fixture', value: { citations: citations.length, ok: citationsOk } });

  const independent = linesContaining(files, 'Tideline');
  const missing = [...independent].filter(x => !citedTideline.has(x)).sort();
  const extra = [...citedTideline].filter(x => !independent.has(x)).sort();
  const coverageOk = missing.length === 0 && extra.length === 0;
  evidence.push({
    kind: 'transcript',
    check: 'cited Tideline lines exactly cover the fixture occurrences (independent count)',
    value: { independent: [...independent].sort(), cited: [...citedTideline].sort(), missing, extra }
  });
  if (!coverageOk) {
    reasons.push(`Tideline coverage mismatch: independent=${JSON.stringify([...independent].sort())} cited=${JSON.stringify([...citedTideline].sort())}`);
  }

  const indexLines = files.get('index.html') ?? [];
  const taglineLines = indexLines.map((line, i) => line.includes('class="tagline"') ? i + 1 : 0).filter(n => n > 0);
  const taglineCited = citations.some(c => c.file === 'index.html' && taglineLines.includes(c.line));
  evidence.push({ kind: 'transcript', check: 'the home-page tagline line is cited', value: { taglineLines, cited: taglineCited } });
  if (!taglineCited) reasons.push(`the tagline line (index.html:${taglineLines.join(',') || '?'}) is not cited`);

  if (summary && summary.prOpened === false) {
    evidence.push({ kind: 'adapter-reported', check: 'no PR opened', value: true });
  } else if (summary && summary.prOpened === true) {
    reasons.push('a pull request was opened — the task is answer-only');
    evidence.push({ kind: 'adapter-reported', check: 'no PR opened', value: false });
  } else {
    const nw = lib.notWired('no PR opened (adapter summary did not report it)');
    reasons.push(nw.reason);
    evidence.push(nw.evidence);
  }

  return lib.result(reasons.length === 0, reasons, evidence);
}
