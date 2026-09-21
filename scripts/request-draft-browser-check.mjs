/** UI-only: edit a fresh browser's draft, reload, simulate a lost response.
 * Does not send a request or launch work. Uses SHIP_URL/SHIP_WEB_TOKEN.
 */
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
assert.ok(process.env.SHIP_URL && process.env.SHIP_WEB_TOKEN);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({extraHTTPHeaders:{authorization:`Bearer ${process.env.SHIP_WEB_TOKEN}`}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(process.env.SHIP_URL);
  await page.locator('#new-task[data-ready=true]').waitFor();
  const prompt = page.locator('textarea[name=task]');
  const id = page.locator('input[name=requestId]');
  await prompt.fill('Browser check: preserve this unsent request');
  const original = await id.inputValue();
  assert.match(original,/^[a-f0-9-]{36}$/);
  await page.reload();
  await page.locator('#new-task[data-ready=true]').waitFor();
  assert.equal(await prompt.inputValue(),'Browser check: preserve this unsent request');
  assert.equal(await id.inputValue(),original);
  let blocked = 0;
  // Fulfill locally: the server never receives this mutation.
  await page.route('**/*',async route => {
    if(route.request().method() === 'POST') { blocked++; await route.fulfill({status:503,body:'Simulated lost response'}); }
    else await route.continue();
  });
  await page.locator('button[value=submit-request]').click();
  await page.waitForTimeout(300);
  assert.equal(blocked,1);
  await page.goto(process.env.SHIP_URL);
  await page.locator('#new-task[data-ready=true]').waitFor();
  assert.equal(await id.inputValue(),original,'Retry must reuse the original ID');
  assert.equal(await prompt.inputValue(),'Browser check: preserve this unsent request');
  await prompt.fill('Browser check: deliberately changed request');
  assert.notEqual(await id.inputValue(),original,'Changed intent needs a fresh ID');
  assert.deepEqual(errors,[]);
  console.log('Passed: draft and request ID survive reload/lost response; edited intent gets a fresh ID. No request submitted.');
} finally { await browser.close(); }
