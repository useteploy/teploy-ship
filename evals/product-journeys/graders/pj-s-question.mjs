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
//   index.html:6:'  <title>Tideline Woodworks</title>'
// Single quotes count as quoting (a correct live answer used them and failed
// the 2026-09-24 canary); an apostrophe inside a word does not open a quote.
// A file name never starts mid-word or right after a backslash: the Outcome
// line of a Ship transcript is JSON, where "\nindex.html" is an escaped
// newline followed by index.html, not a file called nindex.html.
const CITATION = /(?<![\\A-Za-z0-9_.-])([A-Za-z0-9_.-]+\.[A-Za-z0-9]+)\s*[,:]\s*(?:line\s+)?(\d+)\s*[,:]\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`)/g;

// The first quoted segment of a findings detail, by position: backticks
// (the scan's documented convention), double or single quotes. A single
// quote only opens a segment when it is not inside a word.
const QUOTED = /`([^`\n]+)`|"([^"\n]+)"|(?<![A-Za-z0-9])'([^'\n]+)'(?![A-Za-z0-9])/;
function firstQuoted(detail) {
  const m = String(detail).match(QUOTED);
  return m === null ? null : (m[1] ?? m[2] ?? m[3]);
}

// A ship SCAN answers in the product's own findings shape, not inline prose
// — the scan contract is structured output (title/severity/file/line/detail
// with the exact string backticked in detail), and no task prompt can
// override a product format. Those findings carry the same verifiable
// file:line:string triple, so they are citations here too, extracted with
// the SAME downstream verification (re-opened files, verbatim containment,
// independent coverage). Found live by the first ship-adapter canary
// (2026-09-22): a correct scan failed a grader that understood only one
// answer syntax.
function findingsCitations(transcript) {
  const out = [];
  const blocks = [...transcript.matchAll(/FINDINGS_JSON\s*(\[[\s\S]*?\])\s*(?:\n|$)/g)];
  for (const block of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(block[1]);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const f of parsed) {
      if (typeof f?.file !== 'string' || !Number.isInteger(f?.line)) continue;
      // The exact string is the first quoted segment of detail (the scan's
      // documented "Exact current string: `...`" convention, or quotes).
      const str = typeof f.detail === 'string' ? firstQuoted(f.detail) : null;
      if (str === null) continue;
      out.push({ file: f.file, line: f.line, str });
    }
  }
  return out;
}

function fixtureLines(fixture) {
  const files = new Map();
  for (const rel of lib.walkFiles(fixture)) {
    files.set(rel, readFileSync(join(fixture, rel), 'utf8').split('\n'));
  }
  return files;
}

// The question journey can answer with a Markdown evidence table. Each row
// still supplies the same file, line, and exact quoted string; the verifier
// below checks it against the fixture rather than trusting the table.
function tableCitations(transcript) {
  const rows = /^\s*\|\s*`?([A-Za-z0-9_.-]+\.[A-Za-z0-9]+)`?\s*\|\s*(\d+)\s*\|\s*`([^`]+)`[^\n]*\|\s*$/gm;
  return [...transcript.matchAll(rows)].map(m => ({ file: m[1], line: Number(m[2]), str: m[3] }));
}

// The Outcome line of a Ship transcript is JSON; layout-sensitive
// extraction replaces it with the summary the run reported, so the answer
// is read as rendered, not as one escaped line.
function withOutcomeSummary(transcript) {
  return String(transcript).replace(/^Outcome: (.+)$/gm, (line, raw) => {
    try { const outcome = JSON.parse(raw); return typeof outcome.summary === 'string' ? outcome.summary : line; }
    catch { return line; }
  });
}

function markdownCitations(transcript) {
  // Keep the file/line and quoted content on the same line; all extracted
  // claims still go through the exact fixture checks below.
  const rows = /`([A-Za-z0-9_.-]+\.[A-Za-z0-9]+):(\d+)`[ \t]*(?:—|–|→|->|-|:)[ \t]*`([^`\n]+)`/g;
  return [...withOutcomeSummary(transcript).matchAll(rows)].map(m => ({ file: m[1], line: Number(m[2]), str: m[3] }));
}

// A bound triple can also be laid out as a signpost: the reference names
// the file and the line with the word "line" between them ("`index.html`
// line 16", "`index.html:16`"), and the exact string follows on the same
// line after a dash or colon connector, or on the next line as a fenced or
// indented block under a heading that ends with ":". Found live by the
// 2026-10-03/04 batch (eval-20261003-3/4, eval-20261004-1): all three
// answers carried the same verifiable triple the inline forms carry and all
// three failed a grader that understood only adjacent-quote layouts. The
// binding stays tight on purpose: between the line number and the string
// there must be a connector (dash, arrow or colon) and no digits (so range
// prose like "lines 18–20" never binds), and a block binds only directly
// under a colon-ended heading. Every bound triple goes through the same
// verbatim verification below — a paraphrase or an off-by-one in this
// layout fails exactly as it does inline.
const SIGNPOST_REF = /(?<![\\A-Za-z0-9_.-])`?([A-Za-z0-9_.-]+\.[A-Za-z0-9]+)`?(?:\s*[,:]\s*|\s+)(?:lines?\s+)?(\d+)/g;
const SIGNPOST_CONNECTOR = /[—–→]|->|:|-/;

function signpostCitations(transcript) {
  const out = [];
  const lines = withOutcomeSummary(transcript).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const ref of line.matchAll(SIGNPOST_REF)) {
      const after = line.slice(ref.index + ref[0].length);
      const quoted = after.match(QUOTED);
      if (quoted !== null) {
        const between = after.slice(0, quoted.index);
        if (SIGNPOST_CONNECTOR.test(between) && !/\d/.test(between)) {
          out.push({ file: ref[1], line: Number(ref[2]), str: quoted[1] ?? quoted[2] ?? quoted[3] });
        }
      }
      if (line.trimEnd().endsWith(':') && i + 1 < lines.length && lines[i + 1].trim() !== '') {
        const next = lines[i + 1];
        let str = null;
        if (/^\s*(?:```|~~~)/.test(next)) {
          for (let j = i + 2; j < lines.length && !/^\s*(?:```|~~~)/.test(lines[j]); j++) {
            if (lines[j].trim() !== '') { str = lines[j].trim(); break; }
          }
        } else if (/^ {2,}\S/.test(next)) {
          str = next.trim();
        }
        if (str !== null) out.push({ file: ref[1], line: Number(ref[2]), str });
      }
    }
  }
  return out;
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

export async function grade({ workDir, fixture, scenario, transcriptPath, summary }) {
  const reasons = [];
  const evidence = [];
  const diff = lib.diffSnapshots(lib.snapshot(fixture), lib.snapshot(workDir));
  const unchanged = diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
  evidence.push({ kind: 'structural', check: 'work tree unchanged', value: diff });
  if (!unchanged) {
    reasons.push(`work tree changed: added=[${diff.added}] removed=[${diff.removed}] changed=[${diff.changed}] — the task is answer-only`);
  }

  const transcript = transcriptPath ? lib.agentText(readFileSync(transcriptPath, 'utf8'), scenario) : null;
  if (transcript === null) {
    for (const check of [
      'every cited file:line:string occurrence verified verbatim against the fixture',
      'cited occurrence count matches an independent count over the fixture',
      'no PR opened, nothing pushed'
    ]) {
      const nw = lib.notWired(`${check} (requires a run transcript)`);
      reasons.push(nw.reason);
      evidence.push(nw.evidence);
    }
    return lib.result(false, reasons, evidence);
  }

  const files = fixtureLines(fixture);
  const citations = [
    ...[...transcript.matchAll(CITATION)].map(m => ({ file: m[1], line: Number(m[2]), str: m[3] ?? m[4] ?? m[5] })),
    ...findingsCitations(transcript),
    ...tableCitations(transcript),
    ...markdownCitations(transcript),
    ...signpostCitations(transcript),
  ];

  let citationsOk = true;
  if (citations.length === 0) {
    reasons.push('the transcript cites nothing in a checkable form — each occurrence needs file, line number and the quoted exact string, e.g. index.html:6:"Tideline Woodworks", about.html, line 15: "Tideline Woodworks", or a FINDINGS_JSON entry with file/line and the exact string backticked in detail');
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

  const published = lib.noPublication(summary);
  evidence.push(published.evidence);
  if (published.ok !== true) reasons.push(published.reason);

  return lib.result(reasons.length === 0, reasons, evidence);
}
