/** Read-only browser acceptance checks against a running Ship deployment.
 * SHIP_URL, SHIP_WEB_TOKEN, SHIP_TEST_RUN are required. Install playwright or
 * set PLAYWRIGHT_MODULE to its module path. No runs are launched or approved.
 */
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SHIP_URL;
const token = process.env.SHIP_WEB_TOKEN;
const run = process.env.SHIP_TEST_RUN;
assert.ok(base && token && run, 'Set SHIP_URL, SHIP_WEB_TOKEN and SHIP_TEST_RUN');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({extraHTTPHeaders: {authorization: `Bearer ${token}`}});
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({width, height: 1000});
    for (const path of ['/setup', '/projects', '/settings', '/workflows', `/runs/${encodeURIComponent(run)}?view=review`, `/runs/${encodeURIComponent(run)}?view=files`]) {
      const response = await page.goto(new URL(path, base).href);
      assert.equal(response.status(), 200, path);
      await page.waitForTimeout(400);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), `${width}px overflow: ${path}`);
    }
  }
  await page.goto(new URL(`/runs/${encodeURIComponent(run)}?view=review`, base).href);
  const response = await page.request.get(new URL(`/api/runs/${encodeURIComponent(run)}/workspace?view=review`, base).href);
  assert.equal(response.status(), 200, 'Workspace resource must return JSON in production');
  const data = await response.json();
  assert.equal(data.runId, run);
  assert.equal(data.view, 'review');
  const composer = page.locator('textarea[name=message]').first();
  if (await composer.count()) {
    const original = await composer.inputValue();
    const draft = `Browser acceptance draft ${Date.now()}`;
    await composer.fill(draft);
    await page.waitForTimeout(5500);
    assert.equal(await composer.inputValue(), draft, 'Polling must preserve an unsent draft');
    await composer.fill(original);
  }
  assert.deepEqual(errors, [], 'No browser hydration errors');
  console.log('Passed: 18 responsive pages, live workspace JSON, draft retention and browser hydration.');
} finally {
  await browser.close();
}
