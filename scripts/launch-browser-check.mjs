// Mutating browser check: only an isolated file-store UI with no worker.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
if(process.env.SHIP_ISOLATED_CHECK!=='1')throw new Error('Isolated UI required; this creates one synthetic run');
const base=process.env.SHIP_URL,token=process.env.SHIP_WEB_TOKEN;
assert.ok(base&&token);
const browser=await chromium.launch();
try {
 const page=await browser.newPage({extraHTTPHeaders:{authorization:`Bearer ${token}`}});
 await page.goto(base);
 await page.locator('#new-task[data-ready=true]').waitFor();
 await page.locator('#task-prompt').fill('Synthetic lost-response launch proof');
 const requestId=await page.locator('#new-task input[name=requestId]').inputValue();
 let accepted;
 await page.route('**/*',async route=>{
  if(route.request().method()==='POST'&&new URL(route.request().url()).pathname==='/'){
   const response=await route.fetch({maxRedirects:0});
   accepted=response.headers()['location'];
   await route.abort('failed');
  } else await route.continue();
 });
 await page.getByRole('button',{name:'Start task',exact:true}).click();
 await page.waitForURL(url=>url.href.startsWith('chrome-error:')||url.pathname==='/').catch(()=>{});
 for(let i=0;i<50&&!accepted;i++)await page.waitForTimeout(100);
 assert.match(accepted??'',/^\/runs\/run-request-/,'server accepted before its response was lost');
 await page.unroute('**/*');
 await page.goto(base);
 await page.locator('#new-task[data-ready=true]').waitFor();
 assert.equal(await page.locator('#new-task input[name=requestId]').inputValue(),requestId);
 assert.equal(await page.locator('#task-prompt').inputValue(),'Synthetic lost-response launch proof');
 await page.getByRole('button',{name:'Start task',exact:true}).click();
 await page.waitForURL('**/runs/run-request-*');
 assert.equal(new URL(page.url()).pathname,new URL(accepted,base).pathname);
 for (const width of [390,768,1440]) {
  await page.setViewportSize({width,height:1000});
  await page.waitForTimeout(200);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'responsive run page');
  assert.ok(await page.locator('.eyebrow').evaluate(e=>e.scrollWidth<=e.clientWidth+2),'full stable request ID remains readable');
 }
 console.log('Passed: server accepted a launch, browser lost the response, restored draft retry returned the identical run.');
} finally {await browser.close();}
