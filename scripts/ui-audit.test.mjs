// Pure-helper tests for scripts/ui-audit-lib.mjs. The audit's verdicts are only
// as trustworthy as this arithmetic, so each rule has a case that must FAIL
// and a case that must pass (a rule that cannot fail would prove nothing).
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {aggregate, analyzeTabOrder, composite, contrastRatio, evaluateContrast, hasFocusIndicator, headingIssues, isLargeText, parseColor, renderMarkdown, summarize, targetTooSmall} from './ui-audit-lib.mjs';

test('parseColor handles rgb, rgba, slash alpha, color(srgb) and rejects the rest', () => {
  assert.deepEqual(parseColor('rgb(13, 17, 23)'), {r: 13, g: 17, b: 23, a: 1});
  assert.equal(parseColor('rgba(0, 0, 0, 0.5)').a, 0.5);
  assert.equal(parseColor('rgb(0 0 0 / 25%)').a, 0.25);
  assert.equal(parseColor('transparent').a, 0);
  assert.equal(Math.round(parseColor('color(srgb 1 0 0)').r), 255);
  assert.equal(parseColor('oklch(0.5 0.1 20)'), null);
  assert.equal(parseColor(undefined), null);
});

test('contrastRatio matches the WCAG reference values', () => {
  const black = {r: 0, g: 0, b: 0, a: 1}, white = {r: 255, g: 255, b: 255, a: 1};
  assert.equal(Math.round(contrastRatio(black, white)), 21);
  assert.equal(contrastRatio(white, white), 1);
  // #767676 on white is the canonical 4.54:1 AA boundary colour
  assert.ok(contrastRatio({r: 0x76, g: 0x76, b: 0x76, a: 1}, white) > 4.5);
  assert.ok(contrastRatio({r: 0x77, g: 0x77, b: 0x77, a: 1}, white) < 4.5);
});

test('composite blends alpha over an opaque base', () => {
  assert.deepEqual(composite({r: 255, g: 255, b: 255, a: 0.5}, {r: 0, g: 0, b: 0, a: 1}), {r: 127.5, g: 127.5, b: 127.5, a: 1});
});

test('isLargeText: 24px, or 18.66px bold', () => {
  assert.equal(isLargeText(24, '400'), true);
  assert.equal(isLargeText(19, '700'), true);
  assert.equal(isLargeText(19, '400'), false);
  assert.equal(isLargeText(14, '700'), false);
});

test('evaluateContrast: Ship dim text passes, a too-dim token fails (negative control)', () => {
  const dark = {layers: ['rgba(0, 0, 0, 0)', 'rgb(13, 17, 23)'], fontSize: 12, fontWeight: '400'};
  const ok = evaluateContrast({...dark, color: 'rgb(139, 148, 158)'}); // --dim on --bg
  assert.equal(ok.pass, true);
  assert.equal(ok.required, 4.5);
  const bad = evaluateContrast({...dark, color: 'rgb(72, 79, 88)'});
  assert.equal(bad.pass, false);
  assert.ok(bad.ratio < 4.5);
});

test('evaluateContrast: large text only needs 3:1, and unparseable colours are unmeasured not passing', () => {
  const mid = {color: 'rgb(110, 118, 129)', layers: ['rgb(13, 17, 23)'], fontWeight: '400'};
  assert.equal(evaluateContrast({...mid, fontSize: 12}).pass, false);
  assert.equal(evaluateContrast({...mid, fontSize: 28}).pass, true);
  assert.equal(evaluateContrast({...mid, color: 'oklch(0.5 0 0)', fontSize: 12}), null);
});

test('evaluateContrast: a fully transparent stack paints on white, so default black text passes', () => {
  const r = evaluateContrast({color: 'rgb(0, 0, 0)', layers: ['rgba(0, 0, 0, 0)'], fallback: 'rgba(0, 0, 0, 0)', fontSize: 13, fontWeight: '400'});
  assert.equal(r.pass, true);
  assert.equal(Math.round(r.ratio), 21);
});

test('evaluateContrast composites translucent layers and opacity over the canvas', () => {
  // white at 50% over black reads as grey 127.5 on black: ratio ~5.3
  const r = evaluateContrast({color: 'rgb(255, 255, 255)', layers: ['rgba(0, 0, 0, 1)'], fontSize: 14, fontWeight: '400', opacity: 0.5});
  assert.equal(r.pass, true);
  const faint = evaluateContrast({color: 'rgb(255, 255, 255)', layers: ['rgba(0, 0, 0, 1)'], fontSize: 14, fontWeight: '400', opacity: 0.3});
  assert.equal(faint.pass, false, 'opacity must lower the measured contrast');
  // all-transparent layers fall back to the canvas colour
  const canvas = evaluateContrast({color: 'rgb(230, 237, 243)', layers: ['rgba(0, 0, 0, 0)'], fallback: 'rgb(13, 17, 23)', fontSize: 14, fontWeight: '400'});
  assert.equal(canvas.pass, true);
});

test('headingIssues flags skips, missing and multiple h1, but not ascents', () => {
  assert.deepEqual(headingIssues([1, 2, 3, 2, 3]), []);
  assert.deepEqual(headingIssues([1, 2, 4]).map((i) => i.rule), ['heading-skip']);
  assert.deepEqual(headingIssues([1, 3, 1, 2]).map((i) => i.rule), ['heading-multiple-h1', 'heading-skip']);
  assert.deepEqual(headingIssues([2, 3]).map((i) => i.rule), ['heading-no-h1', 'heading-first-not-h1']);
  assert.deepEqual(headingIssues([]).map((i) => i.rule), ['heading-none']);
  assert.deepEqual(headingIssues([1, 4, 2]).map((i) => i.detail), ['h1 followed by h4']);
});

test('targetTooSmall: 24px minimum, inline text links exempt', () => {
  assert.equal(targetTooSmall({width: 24, height: 24}), false);
  assert.equal(targetTooSmall({width: 23.9, height: 30}), true);
  assert.equal(targetTooSmall({width: 200, height: 16}), true);
  assert.equal(targetTooSmall({width: 40, height: 16, inlineInText: true}), false);
});

test('analyzeTabOrder: full walk, unreached controls and a keyboard trap', () => {
  const ok = analyzeTabOrder(['0', '1', '2', null], ['0', '1', '2']);
  assert.deepEqual([ok.trap, ok.wrapped, ok.unreached, ok.reached], [null, true, [], 3]);
  const wrap = analyzeTabOrder(['0', '1', '2', '0'], ['0', '1', '2']);
  assert.equal(wrap.wrapped, true);
  assert.equal(wrap.trap, null);
  const missing = analyzeTabOrder(['0', '2', null], ['0', '1', '2']);
  assert.deepEqual(missing.unreached, ['1']);
  const trapped = analyzeTabOrder(['0', '1', '2', '1', '2', '1'], ['0', '1', '2', '3']);
  assert.equal(trapped.trap, '1');
  assert.deepEqual(trapped.unreached, ['3']);
  // composite controls (type=time) stay on one element for several presses: one stop, not a trap
  const time = analyzeTabOrder(['0', '1', '1', '1', '2', null], ['0', '1', '2']);
  assert.deepEqual([time.trap, time.unreached], [null, []]);
  const forever = analyzeTabOrder(['0', ...Array(10).fill('1')], ['0', '1', '2']);
  assert.equal(forever.trap, '1', 'a control that holds focus forever is a trap');
  assert.deepEqual(analyzeTabOrder(['0', 'x:div.menu', null], ['0']).unexpected, ['x:div.menu']);
});

test('hasFocusIndicator: outline, or any style change, but not an invisible outline', () => {
  const base = {outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'rgb(0, 0, 0)', boxShadow: 'none', borderColor: 'rgb(48, 54, 61)', backgroundColor: 'rgb(22, 27, 34)', color: 'rgb(230, 237, 243)', textDecorationLine: 'none'};
  assert.equal(hasFocusIndicator(base, base), false);
  assert.equal(hasFocusIndicator({...base, outlineStyle: 'auto', outlineWidth: '1px'}, base), true);
  assert.equal(hasFocusIndicator({...base, borderColor: 'rgb(88, 166, 255)'}, base), true);
  assert.equal(hasFocusIndicator({...base, boxShadow: 'rgb(88,166,255) 0 0 0 2px'}, base), true);
  assert.equal(hasFocusIndicator({...base, outlineStyle: 'solid', outlineWidth: '2px', outlineColor: 'rgba(0, 0, 0, 0)'}, base), false);
});

test('aggregate merges the same problem across routes/viewports and orders errors first', () => {
  const f = (route, viewport, rule, severity, selector, detail = '') => ({route, viewport, rule, severity, selector, detail});
  const rows = aggregate([
    f('/a', '390', 'tap', 'warn', 'a.x', '10x10'), f('/b', '390', 'tap', 'warn', 'a.x', '10x10'), f('/a', '1440', 'tap', 'warn', 'a.x', '10x10'),
    f('/a', '390', 'name', 'error', 'button'), f('/a', '390', 'tap', 'warn', 'a.y', '10x10'),
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].rule, 'name');
  const tap = rows.find((r) => r.selector === 'a.x');
  assert.deepEqual([tap.routes, tap.viewports, tap.count], [['/a', '/b'], ['390', '1440'], 3]);
  assert.deepEqual(summarize(rows).map((s) => [s.rule, s.distinct]), [['tap', 2], ['name', 1]]);
});

test('renderMarkdown states axe unavailability and unreachable pages rather than hiding them', () => {
  const md = renderMarkdown({meta: {generatedAt: 'now', routes: 1, viewports: [{name: '390', width: 390, height: 800, dpr: 2}]}, pages: [1], rows: [], unreachable: [{route: '/x', reason: 'HTTP 500'}], axe: {available: false, reason: 'no cdn'}});
  assert.match(md, /NOT RUN - no cdn/);
  assert.match(md, /`\/x`: HTTP 500/);
  assert.match(md, /no findings/);
});
