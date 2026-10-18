import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SETTINGS_VIEWS } from '../views/settings-views.js';
import { importNotice, provenanceLine } from '../views/skills-views.js';

test('the settings nav carries the Skills page under the admin/policies area', () => {
  const skills = SETTINGS_VIEWS.find((v) => v.key === 'skills');
  assert.equal(skills?.href, '/skills');
  assert.ok(SETTINGS_VIEWS.findIndex((v) => v.key === 'skills') > SETTINGS_VIEWS.findIndex((v) => v.key === 'governance'));
});

test('importNotice names what was stripped and what was flagged, or stays empty', () => {
  assert.equal(importNotice({ strippedFrontmatter: [], flags: [] }), '');
  assert.equal(
    importNotice({ strippedFrontmatter: ['allowed-tools', 'model'], flags: ['attempts to override prior instructions'] }),
    'stripped frontmatter (never stored, never read): allowed-tools, model · flagged by the injection screen: attempts to override prior instructions',
  );
});

test('provenanceLine shows source, importer and time without the body', () => {
  const line = provenanceLine({
    importedBy: 'op@example',
    importedAt: '2026-10-17T09:41:00.000Z',
    source: { kind: 'git', ref: 'https://forge.example/o/r@abc123' },
  });
  assert.equal(line, 'git from https://forge.example/o/r@abc123 · op@example · 2026-10-17 09:41 UTC');
  assert.equal(
    provenanceLine({ importedBy: 'op', importedAt: '2026-10-17T09:41:00.000Z', source: { kind: 'upload' } }),
    'upload · op · 2026-10-17 09:41 UTC',
  );
});
