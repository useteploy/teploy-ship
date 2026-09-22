// Mutating check: isolated file-store UI only, no connected worker.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
if(process.env.SHIP_ISOLATED_CHECK!=='1')throw new Error('Isolated UI required');
const base=process.env.SHIP_URL,token=process.env.SHIP_WEB_TOKEN;
assert.ok(base&&token);
const repo=`browser-proof/${randomUUID()}`;
const urls=[`https://first.example/${repo}`,`https://second.example/${repo}`];
const browser=await chromium.launch();
try {
  const page=await browser.newPage({extraHTTPHeaders:{authorization:`Bearer ${token}`}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  for(let i=0;i<urls.length;i++){
    await page.goto(new URL('/setup',base).href);
    const details=page.locator('details').filter({has:page.getByText('Connect a repository',{exact:true})});
    if(!await details.evaluate(e=>e.open))await details.locator('summary').click();
    await details.locator('input[name=url]').fill(urls[i]);
    await details.locator('input[name=tests]').fill(`echo forge-${i}`);
    await details.getByRole('button',{name:'Save and check setup'}).click();
    await page.waitForURL(url=>url.searchParams.get('repo')===urls[i]);
    assert.equal(await page.locator('select[name=repo]').inputValue(),urls[i]);
    assert.equal(await page.getByRole('button',{name:'Verify environment',exact:true}).count(),1);
    assert.equal(await page.locator('section.setup-environment input[name=tests]').inputValue(),`echo forge-${i}`);
  }
  for(const width of [390,768,1440]){
    await page.setViewportSize({width,height:1000});
    for(let i=0;i<urls.length;i++){
      await page.goto(new URL(`/setup?repo=${encodeURIComponent(urls[i])}`,base).href);
      assert.equal(await page.locator('section.setup-environment input[name=tests]').inputValue(),`echo forge-${i}`);
      for(const href of await page.locator('a[href^="/projects?repo="]').evaluateAll(es=>es.map(e=>e.getAttribute('href')))){
        assert.equal(new URL(href,base).searchParams.get('repo'),urls[i]);
      }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'setup overflow');
      await page.goto(new URL(`/projects?repo=${encodeURIComponent(urls[i])}`,base).href);
      assert.equal(await page.locator('input[name=repo]').first().inputValue(),urls[i]);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'project overflow');
    }
  }
  await page.goto(new URL(`/projects?repo=${encodeURIComponent(repo)}`,base).href);
  assert.match(await page.locator('body').innerText(),/identity conflicts/);
  assert.deepEqual(errors,[]);
  console.log('Passed: two same-named forge projects registered through UI, independent settings and qualified links at three widths; ambiguous short name refused.');
}finally{await browser.close()}
