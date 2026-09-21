// Grade a separately checked-out result, outside the agent's test suite.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert.ok(process.argv[2], 'Usage: node check-customer-directory.mjs /path/to/result [expected button label]');
const dir = resolve(process.argv[2]);
const label = process.argv[3] || 'Save customer';
const artifacts = mkdtempSync(resolve(process.env.SHIP_EVAL_ARTIFACTS || tmpdir(), 'ship-fixture-'));
const db = artifacts + '/data.sqlite';
const server = spawn('python3', ['-u', '-c', `import runpy
m = runpy.run_path('app.py')
s = m['ThreadingHTTPServer'](('127.0.0.1', 0), m['Handler'])
print(s.server_port, flush=True)
s.serve_forever()`], { cwd: dir, env: { ...process.env, DIRECTORY_DB: db }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('App did not start within 10 seconds')), 10000);
    let output = '';
    server.on('error', reject);
    server.on('exit', code => { clearTimeout(timer); reject(new Error(`App exited: ${code}`)); });
    server.stdout.on('data', chunk => {
      output += chunk;
      if (/^\d+\n/.test(output)) { clearTimeout(timer); resolve(Number(output.split('\n')[0])); }
    });
  });
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}`);
  const button = page.getByRole('button', { name: label, exact: true });
  await button.waitFor();
  await page.getByLabel('Name', { exact: true }).fill('Ada Lovelace');
  await page.getByLabel('Email', { exact: true }).fill('ada@example.test');
  await button.click();
  await page.getByText('Ada Lovelace — ada@example.test', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Ada Lovelace — ada@example.test', { exact: true }).waitFor();
  const rows = JSON.parse(execFileSync('python3', ['-c',
    'import sqlite3,json,sys; print(json.dumps(sqlite3.connect(sys.argv[1]).execute("SELECT name,email FROM contacts").fetchall()))', db], { encoding: 'utf8' }));
  assert.deepEqual(rows, [['Ada Lovelace', 'ada@example.test']]);
  if (process.argv.includes('--search')) {
    const base = `http://127.0.0.1:${port}`;
    for (const [name, email] of [['Grace Hopper', 'grace@example.test'], ['Percent%', 'percent@example.test'], ['Under_score', 'under@example.test'], ['Back\\Slash', 'back@example.test']]) {
      const response = await page.request.post(base + '/api/contacts', { data: { name, email } });
      assert.equal(response.status(), 201);
    }
    for (const [query, expected] of [['ADA', ['Ada Lovelace']], [' grace@ ', ['Grace Hopper']], ['%', ['Percent%']], ['_', ['Under_score']], ['\\', ['Back\\Slash']], ["' OR 1=1 --", []], ['nobody', []]]) {
      const response = await page.request.get(base + '/api/contacts?q=' + encodeURIComponent(query));
      assert.equal(response.status(), 200);
      assert.deepEqual((await response.json()).map(row => row.name), expected, `Search ${query}`);
    }
    await page.reload();
    const search = page.getByLabel('Search customers', { exact: true });
    const names = expected => page.waitForFunction(expected => JSON.stringify([...document.querySelectorAll('#contacts li')].map(e => e.textContent.split(' — ')[0])) === JSON.stringify(expected), expected);
    await search.fill(' grace@ ');
    await names(['Grace Hopper']);
    await search.fill('nobody');
    await names([]);
    await search.fill('');
    await names(['Ada Lovelace', 'Grace Hopper', 'Percent%', 'Under_score', 'Back\\Slash']);
    let release;
    const delayed = new Promise(resolve => { release = resolve; });
    await page.route('**/api/contacts?q=*', async route => {
      if (new URL(route.request().url()).searchParams.get('q') === 'ADA') {
        await new Promise(resolve => setTimeout(resolve, 1200));
        await route.continue().catch(() => {});
        release();
      } else await route.continue();
    });
    const issued = page.waitForRequest(r => new URL(r.url()).searchParams.get('q') === 'ADA');
    await search.fill('ADA');
    await issued;
    await search.fill('Grace');
    await names(['Grace Hopper']);
    await delayed;
    await page.waitForTimeout(300);
    assert.deepEqual(await page.locator('#contacts li').allTextContents(), ['Grace Hopper — grace@example.test']);
    const saved = await page.request.get(base + '/api/contacts');
    assert.equal((await saved.json()).length, 5, 'Search must not modify stored contacts');
    for (const [name, email] of [['Grace New', 'grace.new@example.test'], ['Ada New', 'ada.new@example.test']]) {
      await page.getByLabel('Name', { exact: true }).fill(name);
      await page.getByLabel('Email', { exact: true }).fill(email);
      const refreshed = page.waitForResponse(r => new URL(r.url()).pathname === '/api/contacts' && r.request().method() === 'GET');
      await button.click();
      await refreshed;
      await names(['Grace Hopper', 'Grace New']);
      assert.equal(await search.inputValue(), 'Grace', 'Saving must retain the active search');
    }
    const count = Number(execFileSync('python3', ['-c', 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT COUNT(*) FROM contacts").fetchone()[0])', db], { encoding: 'utf8' }));
    assert.equal(count, 7, 'Both matching and nonmatching customers must be saved');
    console.log('Search API, literal wildcards, trimming, browser filtering/clearing, stale responses, active-filter saves and data preservation passed.');
  }
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${artifacts}/${width}.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['button wording', 'browser create', 'reload', 'SQLite persistence', 'responsive layout', 'browser errors'], artifacts }));
} finally {
  if (browser) await browser.close();
  server.kill();
}
