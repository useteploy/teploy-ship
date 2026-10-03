// Pure helpers for scripts/ui-audit.mjs. Nothing here touches a browser, the
// network or the file system, so each rule can be tested with plain values
// (scripts/ui-audit.test.mjs) and so a regression in the audit's own arithmetic
// cannot silently turn a real failure into a pass.

/** WCAG 2.x AA text contrast: 4.5:1, or 3:1 for large text. */
export const CONTRAST_NORMAL = 4.5;
export const CONTRAST_LARGE = 3;
/** WCAG 2.2 SC 2.5.8 (AA) minimum target size, CSS px. */
export const MIN_TARGET = 24;

/**
 * Parse a computed CSS colour into {r,g,b,a}. Chromium reports computed colours
 * as `rgb()`/`rgba()` (or `color(srgb ...)` for wide-gamut values); anything
 * else returns null so the caller counts it as "not measured" rather than as a
 * pass.
 */
export function parseColor(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return {r: 0, g: 0, b: 0, a: 0};
  let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) return {r: +m[1], g: +m[2], b: +m[3], a: alpha(m[4])};
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) return {r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: alpha(m[4])};
  return null;
}
function alpha(raw) {
  if (raw === undefined) return 1;
  const n = raw.endsWith('%') ? parseFloat(raw) / 100 : parseFloat(raw);
  return Math.min(1, Math.max(0, n));
}

/** Source-over composite of `top` onto an OPAQUE `bottom`. */
export function composite(top, bottom) {
  const a = top.a;
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  };
}

/** WCAG relative luminance of an opaque colour. */
export function luminance({r, g, b}) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** "Large text" per WCAG: >= 24px, or >= 18.66px (14pt) and bold. */
export function isLargeText(fontSizePx, fontWeight) {
  const weight = Number(fontWeight);
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && (weight >= 700 || fontWeight === 'bold'));
}

/**
 * Evaluate one text sample. `layers` is the stack of background colours from
 * the innermost element outwards (computed strings); the first opaque layer
 * ends the walk. `fallback` is the page canvas colour used if every layer is
 * transparent. Returns null when something cannot be measured (unparseable
 * colour) so the report counts it as unmeasured.
 */
export function evaluateContrast({color, layers, fallback = 'rgb(255, 255, 255)', fontSize, fontWeight, opacity = 1}) {
  const fg = parseColor(color);
  if (fg === null) return null;
  let base = parseColor(fallback);
  if (base === null) return null;
  // A transparent canvas is painted white by the browser, never black.
  base = base.a === 0 ? {r: 255, g: 255, b: 255, a: 1} : {...base, a: 1};
  const parsed = [];
  for (const layer of layers) {
    const c = parseColor(layer);
    if (c === null) return null;
    if (c.a === 0) continue;
    parsed.push(c);
    if (c.a >= 1) break;
  }
  let bg = base;
  for (let i = parsed.length - 1; i >= 0; i--) bg = composite(parsed[i], bg);
  const text = composite({...fg, a: fg.a * opacity}, bg);
  const ratio = contrastRatio(text, bg);
  const large = isLargeText(fontSize, fontWeight);
  const required = large ? CONTRAST_LARGE : CONTRAST_NORMAL;
  return {ratio: Math.round(ratio * 100) / 100, required, large, pass: ratio >= required};
}

/**
 * Heading outline problems from a list of levels in document order.
 * A skip is going DOWN by more than one level (h2 -> h4); going up is fine.
 */
export function headingIssues(levels) {
  const issues = [];
  if (levels.length === 0) {
    issues.push({rule: 'heading-none', detail: 'page has no headings'});
    return issues;
  }
  const h1s = levels.filter((l) => l === 1).length;
  if (h1s === 0) issues.push({rule: 'heading-no-h1', detail: 'page has no h1'});
  if (h1s > 1) issues.push({rule: 'heading-multiple-h1', detail: `${h1s} h1 elements`});
  if (levels[0] !== 1) issues.push({rule: 'heading-first-not-h1', detail: `first heading is h${levels[0]}`});
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) {
      issues.push({rule: 'heading-skip', detail: `h${levels[i - 1]} followed by h${levels[i]}`});
    }
  }
  return issues;
}

/**
 * Is a target big enough? Inline links inside running text are exempt under
 * 2.5.8, and a control whose own box is small but whose label is bigger (a
 * checkbox in a <label>) is measured by the larger of the two.
 */
export function targetTooSmall({width, height, inlineInText = false}, min = MIN_TARGET) {
  if (inlineInText) return false;
  return width < min || height < min;
}

/**
 * Keyboard walk analysis. `stops` is the sequence of ids the focus visited as
 * Tab was pressed from the top of the document (`null` = focus left the page
 * content, i.e. wrapped to browser chrome / body). `expected` lists the ids
 * that should be reachable.
 *
 * - unreached: expected ids never focused.
 * - trap: focus revisited an earlier id other than the first stop, or stayed on
 *   one element for `maxRun` consecutive presses, so Tab can never get past it.
 * - unexpected: ids focused that were not in the expected list (focusable
 *   things the audit's selector did not anticipate; they are reported, not
 *   hidden).
 */
export function analyzeTabOrder(stops, expected, maxRun = 8) {
  const seen = [];
  let trap = null;
  let wrapped = false;
  let run = 0;
  for (let i = 0; i < stops.length; i++) {
    const id = stops[i];
    if (id === null) { wrapped = true; break; }
    // A composite control (<input type=time>, a date field) takes several Tab
    // presses while document.activeElement stays the same element. That is a
    // single stop, not a trap, up to maxRun presses; beyond that Tab is stuck.
    if (seen.length > 0 && seen[seen.length - 1] === id) {
      run++;
      if (run >= maxRun) { trap = id; break; }
      continue;
    }
    run = 0;
    if (seen.includes(id)) {
      if (id === seen[0]) wrapped = true;
      else trap = id;
      break;
    }
    seen.push(id);
  }
  const reached = new Set(seen);
  const want = new Set(expected);
  return {
    trap,
    wrapped,
    reached: reached.size,
    unreached: [...want].filter((id) => !reached.has(id)),
    unexpected: seen.filter((id) => !want.has(id)),
  };
}

/** Did focus change anything visible? Compare style signatures. */
export function hasFocusIndicator(focused, blurred) {
  const outline = (s) => s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && (parseColor(s.outlineColor)?.a ?? 1) > 0;
  if (outline(focused)) return true;
  for (const key of ['boxShadow', 'borderColor', 'backgroundColor', 'color', 'textDecorationLine']) {
    if (focused[key] !== blurred[key] && focused[key] !== undefined) return true;
  }
  return false;
}

/**
 * Collapse raw findings (one per route x viewport x element) into one row per
 * distinct problem, remembering where it was seen. The report is for a person
 * deciding what to fix, so 5 viewports of the same missing label is one row.
 */
export function aggregate(findings) {
  const rows = new Map();
  for (const f of findings) {
    const key = [f.rule, f.selector ?? '', f.detail ?? ''].join('\u0000');
    let row = rows.get(key);
    if (!row) {
      row = {rule: f.rule, severity: f.severity, selector: f.selector ?? '', detail: f.detail ?? '', routes: new Set(), viewports: new Set(), count: 0};
      rows.set(key, row);
    }
    row.routes.add(f.route);
    row.viewports.add(f.viewport);
    row.count++;
  }
  return [...rows.values()]
    .map((r) => ({...r, routes: [...r.routes].sort(), viewports: [...r.viewports]}))
    .sort((a, b) => (a.severity === b.severity ? a.rule.localeCompare(b.rule) : a.severity === 'error' ? -1 : 1) || b.routes.length - a.routes.length);
}

/** Totals by rule across aggregated rows. */
export function summarize(rows) {
  const byRule = {};
  for (const r of rows) {
    byRule[r.rule] ??= {severity: r.severity, distinct: 0, routes: new Set()};
    byRule[r.rule].distinct++;
    for (const route of r.routes) byRule[r.rule].routes.add(route);
  }
  return Object.entries(byRule)
    .map(([rule, v]) => ({rule, severity: v.severity, distinct: v.distinct, routes: v.routes.size}))
    .sort((a, b) => b.distinct - a.distinct);
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Markdown for the generated section of the report. */
export function renderMarkdown({meta, pages, rows, unreachable, axe}) {
  const lines = [];
  lines.push(`Generated ${meta.generatedAt} by \`scripts/ui-audit.mjs\`. ${pages.length} page loads (${meta.routes} routes x ${meta.viewports.length} viewports).`);
  lines.push('');
  lines.push(`Viewports: ${meta.viewports.map((v) => `${v.name} (${v.width}x${v.height}, dpr ${v.dpr})`).join('; ')}.`);
  lines.push('');
  lines.push(`axe-core: ${axe.available ? `${axe.version} (${axe.source})` : `NOT RUN - ${axe.reason}`}.`);
  lines.push('');
  lines.push('### Summary by rule');
  lines.push('');
  lines.push('| Rule | Severity | Distinct problems | Routes affected |');
  lines.push('|---|---|---|---|');
  for (const s of summarize(rows)) lines.push(`| ${s.rule} | ${s.severity} | ${s.distinct} | ${s.routes} |`);
  if (rows.length === 0) lines.push('| (none) | | 0 | 0 |');
  lines.push('');
  lines.push('### Pages that could not be audited');
  lines.push('');
  if (unreachable.length === 0) lines.push('None: every listed route answered 200.');
  for (const u of unreachable) lines.push(`- \`${u.route}\`: ${u.reason}`);
  lines.push('');
  lines.push('### Findings');
  lines.push('');
  lines.push('| Severity | Rule | Element | Detail | Routes | Viewports |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    const routes = r.routes.length > 4 ? `${r.routes.slice(0, 4).join(', ')} +${r.routes.length - 4}` : r.routes.join(', ');
    lines.push(`| ${r.severity} | ${r.rule} | \`${cell(r.selector)}\` | ${cell(r.detail)} | ${cell(routes)} | ${r.viewports.join(', ')} |`);
  }
  if (rows.length === 0) lines.push('| | no findings | | | | |');
  lines.push('');
  return lines.join('\n');
}
