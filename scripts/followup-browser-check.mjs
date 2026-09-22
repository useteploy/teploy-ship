// Mutating check: isolated file-store UI, no worker/model/forge execution.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
if(process.env.SHIP_ISOLATED_CHECK!=='1')throw new Error('Isolated UI required');
const base=process.env.SHIP_URL,token=process.env.SHIP_WEB_TOKEN,parent=process.env.SHIP_TEST_RUN;
assert.ok(base&&token&&parent);
const browser=await chromium.launch();
try {
 const page=await browser.newPage({extraHTTPHeaders:{authorization:`Bearer ${token}`},viewport:{width:390,height:1000}});
 const url=`${base}/runs/${parent}`;
 await page.goto(url);
 const form=page.locator('.message-composer');
 await form.locator('[name=message]').fill('Synthetic browser follow-up recovery');
 await form.locator('[name=journey]').selectOption('change');
 await form.locator('[name=plan]').uncheck();
 const requestId=await form.locator('[name=requestId]').inputValue();
 await page.reload();
 await page.waitForFunction(()=>document.querySelector('[name=message]')?.value==='Synthetic browser follow-up recovery');
 assert.equal(await form.locator('[name=requestId]').inputValue(),requestId);
 assert.equal(await form.locator('[name=plan]').isChecked(),false);
 let accepted;
 await page.route('**/*',async route=>{
  if(route.request().method()==='POST'&&new URL(route.request().url()).pathname===`/runs/${parent}`){
   const response=await route.fetch({maxRedirects:0});accepted=response.headers()['location'];await route.abort('failed');
  }else await route.continue();
 });
 await form.getByRole('button',{name:'Start follow-up'}).click();
 for(let i=0;i<100&&!accepted;i++)await page.waitForTimeout(100);
 assert.match(accepted??'',/^\/runs\/run-request-/);
 await page.unroute('**/*');
 await page.goto(url);
 await page.waitForFunction(()=>document.querySelector('[name=message]')?.value==='Synthetic browser follow-up recovery');
 assert.equal(await form.locator('[name=requestId]').inputValue(),requestId);
 assert.equal(await form.locator('[name=plan]').isChecked(),false);
 await form.getByRole('button',{name:'Start follow-up'}).click();
 await page.waitForURL('**/runs/run-request-*');
 assert.equal(new URL(page.url()).pathname,accepted);
 for(const width of [390,768,1440]){
  await page.setViewportSize({width,height:1000});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
 }
 console.log('Passed: follow-up draft and plan choice survive reload and accepted/lost response; retry returns the same child at mobile/tablet/desktop widths.');
}finally{await browser.close()}
