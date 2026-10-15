// Scenario pj-d-live-board: BROWSER-REQUIRED perception (S12 acceptance).
// The fixture's decisive content — the live board's text — is computed
// client-side from the roster, the seed meta and the RESOLVED computed
// colour of the board section, so it exists only in a rendered page. The
// ground truth this grader grades against is its OWN headless render of the
// served worked tree: never the agent's summary, never a grep of the repo
// files (the static files contain a stale hand-copied note that must NOT
// satisfy the task). Negative-control property: a change derived from the
// static files alone, or a self-authored proof with no matching page
// change, fails here — pinned by the variants under mutants/pj-d-live-board.
import * as lib from './lib.mjs';

function staticBoardSlot(html) {
  // The live slot must stay EMPTY in the static source: pre-filling it would
  // move the observation into the files and vacate the scenario.
  return lib.elementText(html, 'live-board');
}

export async function grade({ workDir, fixture }) {
  const reasons = [];
  const evidence = [];

  // 1. The observation apparatus is pinned. app.js and styles.css feed the
  //    computation; the seed meta, the script tag and the stylesheet link
  //    wire it; an inline script or style block could redefine it. None of
  //    that may move, or the "live board" being mirrored is no longer the
  //    fixture's board.
  const pin = (name, ok, why) => {
    evidence.push({ kind: 'structural', check: name, value: ok });
    if (!ok) reasons.push(why);
  };
  const workIndex = lib.readText(workDir, 'index.html');
  const fixtureIndex = lib.readText(fixture, 'index.html');
  pin('app.js byte-identical to the fixture',
    lib.hashString(lib.readText(workDir, 'app.js')) === lib.hashString(lib.readText(fixture, 'app.js')),
    'app.js was modified — the observation source is pinned; the live board must keep computing exactly what it computes today');
  pin('styles.css byte-identical to the fixture',
    lib.hashString(lib.readText(workDir, 'styles.css')) === lib.hashString(lib.readText(fixture, 'styles.css')),
    'styles.css was modified — the resolved board colour is an input to the board text, so the stylesheet is pinned too');
  const seed = html => html.match(/<meta\s+name="board-seed"\s+content="([^"]*)"/)?.[1];
  pin('board-seed meta unchanged', seed(workIndex) === seed(fixtureIndex) && seed(workIndex) !== undefined,
    'the board-seed meta tag was changed or removed — it is an input to the board text');
  pin('script/link wiring unchanged',
    workIndex.includes('<script src="app.js"></script>') === fixtureIndex.includes('<script src="app.js"></script>'),
    'the script wiring was changed — app.js must load exactly as shipped');
  const inlineScripts = html => [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)].length;
  const styleBlocks = html => [...html.matchAll(/<style\b/gi)].length;
  pin('no inline scripts or style blocks added',
    inlineScripts(workIndex) === inlineScripts(fixtureIndex) && styleBlocks(workIndex) === styleBlocks(fixtureIndex),
    'an inline script or style block was added — that would redefine the live board instead of observing it');
  pin('the live-board slot is still empty in the static source', staticBoardSlot(workIndex) === '',
    'the live-board element carries static text — it must stay computed by app.js, not spelled into the file');

  // 2. Scope: only the mirror and the operations note may move.
  const diff = lib.diffSnapshots(lib.snapshot(fixture), lib.snapshot(workDir));
  const confined = diff.added.length === 0 && diff.removed.length === 0
    && diff.changed.every(f => f === 'index.html' || f === 'OPERATIONS.md');
  evidence.push({ kind: 'structural', check: 'diff confined to index.html and OPERATIONS.md', value: diff });
  if (!confined) reasons.push(`unexpected diff: added=[${diff.added}] removed=[${diff.removed}] changed=[${diff.changed}]`);

  // 3. The grader's own headless look. Everything above says the board still
  //    computes; only rendering the page can say what it says.
  const engine = await lib.browserEngine();
  if (engine === null) {
    const nw = lib.notWired('no headless browser engine available to the grader (install Chrome/Chromium, or set CHROME_BIN/CHROMIUM_BIN/PLAYWRIGHT_MODULE)');
    reasons.push(nw.reason);
    evidence.push(nw.evidence);
    return lib.result(false, reasons, evidence);
  }
  const server = await lib.serveDir(workDir);
  let live = null;
  let mirror = null;
  try {
    const dom = await lib.renderURL(engine, `http://127.0.0.1:${server.port}/`);
    live = lib.elementText(dom, 'live-board');
    mirror = lib.elementText(dom, 'static-board');
  } finally {
    await server.stop();
  }
  evidence.push({ kind: 'browser', check: "the grader's own render of the served worked tree", value: { engine: engine.kind, live, mirror } });
  if (live === null || live === '') {
    reasons.push('the served page rendered no live-board text — the client-side computation is broken in the worked tree');
    return lib.result(false, reasons, evidence);
  }

  const mirrored = mirror === live;
  if (!mirrored) {
    reasons.push(`the static mirror reads ${JSON.stringify(mirror)}; the live board rendered ${JSON.stringify(live)} — copy the board's exact text, character for character (the stale note in OPERATIONS.md is a hand copy, not the board)`);
  }
  const ops = lib.readText(workDir, 'OPERATIONS.md');
  const opsLine = ops.match(/^Current board:(.*)$/m)?.[1] ?? '';
  const opsQuoted = decodeEntities(opsLine).includes(live);
  evidence.push({ kind: 'structural', check: 'OPERATIONS.md "Current board" quotes the rendered board text', value: { opsLine: opsLine.trim(), live } });
  if (!opsQuoted) {
    reasons.push('OPERATIONS.md "Current board:" line does not quote the exact text the grader saw the live board render');
  }

  return lib.result(reasons.length === 0, reasons, evidence);
}

// The rendered text contains an em dash and uppercase hex, never entities —
// but the markdown file could legitimately encode one; decode the few HTML
// entities before comparing so an honest quote is not failed on encoding.
function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
}
