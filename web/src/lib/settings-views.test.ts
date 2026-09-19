import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingsView, groupVisible, settingLabel } from '../views/settings-views.js';
test('settings defaults to overview and preserves existing deep links', () => {
  assert.equal(settingsView(null), 'overview');
  assert.equal(settingsView('invalid'), 'overview');
  assert.equal(settingsView('team'), 'team');
  assert.equal(settingsView('system'), 'system');
});
test('team and overview never leak the full configuration table into their content', () => {
  for (const group of ['Harness', 'Runtime', 'Sandbox', 'Git & access']) {
    assert.equal(groupVisible('team', group), false);
    assert.equal(groupVisible('overview', group), false);
    assert.equal(groupVisible('system', group), true);
  }
  assert.equal(groupVisible('models', 'Sandbox'), true);
  assert.equal(groupVisible('models', 'Git & access'), false);
  assert.equal(groupVisible('integrations', 'Git & access'), true);
  assert.equal(settingLabel('SHIP_DAILY_BUDGET_USD'), 'Daily budget (USD)');
});
