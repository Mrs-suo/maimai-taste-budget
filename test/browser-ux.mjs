// Optional browser regression: requires an existing Playwright installation.
// No real MCP credentials or network calls are used in this fixture test.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createApp} from '../scripts/server.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const sample=JSON.parse(await fs.readFile(new URL('../examples/verified-report.json',import.meta.url),'utf8'));
const port=18801,origin=`http://127.0.0.1:${port}`;
const server=createApp({port,token:'synthetic-test-token'});
await new Promise(r=>server.listen(port,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,...(process.env.BROWSER_EXECUTABLE?{executablePath:process.env.BROWSER_EXECUTABLE}:{})});
try{
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let plans=0,failMenu=false;
 await page.route('https://menu-img.mcd.cn/**',r=>r.abort());
 await page.route('**/api/*',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/bootstrap')return route.continue();
  let body;
  if(path==='/api/stores')body=[{code:'1450713',name:'测试门店',address:'测试地址',reservation:[]}];
  else if(path==='/api/menu'){
   if(failMenu)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'测试菜单不可用'})});
   body={menu:[{code:'combo',name:'测试套餐'}]};
  }else if(path==='/api/base')body={code:'combo',rounds:sample.base.components.map((c,i)=>({id:String(i+1),name:c.name,selected:c.code,choices:i===1?[c,...sample.candidates.map(x=>({code:x.code,name:x.name}))]:[c]}))};
  else if(path==='/api/plan'){plans++;await new Promise(r=>setTimeout(r,80));body={...sample,mode:'live',createdAt:new Date().toISOString()};}
  else throw Error('Unexpected API: '+path);
  return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto(origin);await page.getByText('原本这一餐',{exact:true}).waitFor();
 await page.locator('#live').click();await page.locator('#city').fill('上海');await page.locator('#keyword').fill('地标');
 await page.locator('#search').click();await page.locator('#stores option').waitFor({state:'attached'});
 await page.locator('#menu').click();await page.locator('#meals option').waitFor({state:'attached'});
 await page.locator('#base').click();await page.locator('#swap').waitFor();assert.equal(await page.locator('#swap option').count(),1);
 await page.locator('#calculate').click();await page.getByText('原本这一餐',{exact:true}).waitFor();assert.equal(plans,1);
 await page.locator('[data-budget="0"]').click();assert.equal(await page.locator('.cards').first().locator('article').count(),1);
 await page.locator('[data-budget="5"]').click();assert.equal(await page.locator('.cards').first().locator('article').count(),2);
 await page.locator('#kcal').fill('500');await page.locator('#kcal').blur();await page.getByText('这次没有全部满足条件的替换',{exact:true}).waitFor();assert.equal(plans,1);
 await page.locator('#kcal').fill('700');await page.locator('#kcal').blur();await page.locator('[data-avoid]').first().click();assert.equal(await page.locator('.card.best h3').innerText(),'大杯玉米杯');
 await page.locator('#clear').click();assert.equal(await page.locator('.card.best h3').innerText(),'小杯玉米杯');
 await page.locator('.card.best').scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('.card.best img')?.hidden);
 assert.match(await page.locator('.card.best figcaption').innerText(),/图片暂不可用/);
 failMenu=true;await page.locator('#menu').click();await page.getByText('测试菜单不可用',{exact:true}).waitFor();assert.equal(await page.locator('#results article').count(),0);assert.equal(await page.locator('#mealFields').isVisible(),false);assert.equal(await page.locator('#error').evaluate(e=>e===document.activeElement),true);
 failMenu=false;await page.locator('#menu').click();await page.locator('#meals option').waitFor({state:'attached'});
 await page.locator('#keyword').fill('新地标');assert.equal(await page.locator('#storeFields').isVisible(),false);assert.equal(await page.locator('#mealFields').isVisible(),false);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
 console.log('浏览器回归通过：实时筛选、无额外请求、偏好恢复、无效替换项、图片失败、旧结果清除、菜单重试与手机布局。');
}finally{await browser.close();await new Promise(r=>server.close(r));}
