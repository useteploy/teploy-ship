// Isolated file-store browser proof. Creates synthetic state and starts no worker.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const root=process.cwd();
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dir=await mkdtemp(join(tmpdir(),'ship-recovery-browser-'));
process.env.TEPLOY_SHIP_STATE=dir;
const {fileRuntime}=await import(root+'/dist/runtime.js');
const runtime=await fileRuntime();
const at=new Date().toISOString(),runId='run-browser-recovery';
await runtime.launches.prepare({runId,requestHash:'a'.repeat(64),meta:{runId,task:'Synthetic interrupted launch',status:'queued',model:'test',createdAt:at,updatedAt:at},started:{v:1,seq:0,type:'run-started',at,data:{workflow:'test',input:{task:'Synthetic interrupted launch'}}}});
const child=spawn(process.execPath,['dist/cli.js','web','--store','file','--port','7501'],{detached:true,env:{...process.env,SHIP_STORE:'file',SHIP_WEB_TOKEN:'synthetic-recovery'},stdio:'ignore'});
const browser=await chromium.launch();
try{
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:7501/login')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100));}assert.ok(ready);
 const page=await browser.newPage({extraHTTPHeaders:{authorization:'Bearer synthetic-recovery'}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 for(const width of [390,768,1440]){
  await page.setViewportSize({width,height:1000});
  assert.equal((await page.goto('http://127.0.0.1:7501/recovery')).status(),200);
  await page.getByText('Synthetic interrupted launch',{exact:true}).waitFor();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  if(width===390||width===1440)await page.screenshot({path:join(dir,`recovery-${width}.png`),fullPage:true});
 }
 await page.getByRole('button',{name:'Retry accepted launch'}).click();
 await page.waitForURL('**/runs/'+runId);
 assert.equal((await runtime.store.load(runId)).length,1);
 await page.goto('http://127.0.0.1:7501/recovery');
 await page.getByText('No pending accepted launches on this page.').waitFor();
 await page.goto(`http://127.0.0.1:7501/runs/${runId}?view=files`);
 await page.getByRole('button',{name:'Inspect live changes'}).waitFor();
 await page.getByText('Workspace recovery',{exact:true}).click();
 await page.getByText('No workspace snapshot is recorded.').waitFor();
 await page.setViewportSize({width:390,height:1000});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
 assert.deepEqual(errors,[]);
 console.log('Passed: responsive recovery UI, accepted launch retry, preserved run identity, workspace recovery disclosure, no hydration errors.');
}finally{await browser.close();try{process.kill(-child.pid,'SIGTERM')}catch{}await new Promise(r=>setTimeout(r,500));await rm(dir,{recursive:true,force:true});}
