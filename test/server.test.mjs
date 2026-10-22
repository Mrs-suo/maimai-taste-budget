import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createApp} from '../scripts/server.mjs';
test('同一会话并发查询返回 409，结束后可继续',async()=>{
 const port=18770;let release,entered;const started=new Promise(r=>entered=r);
 const server=createApp({port,token:'synthetic-test-token',plannerFactory:()=>({stores:async()=>{entered();await new Promise(r=>release=r);return[];}})});
 await new Promise(r=>server.listen(port,'127.0.0.1',r));
 try{const origin=`http://127.0.0.1:${port}`,b=await fetch(origin+'/api/bootstrap'),data=await b.json();const options={method:'POST',headers:{Origin:origin,Cookie:b.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':data.csrf,'Content-Type':'application/json'},body:'{}'};
 const first=fetch(origin+'/api/stores',options);await started;const second=await fetch(origin+'/api/stores',options);assert.equal(second.status,409);release();assert.equal((await first).status,200);
 }finally{release?.();await new Promise(r=>server.close(r));}
});
test('本机服务拒绝跨站、缺少 CSRF、未知 Host、无会话和超大请求，且会话隔离',async()=>{
 const port=18768;let calls=0;let instance=0;
 const server=createApp({port,token:'synthetic-test-token',plannerFactory:()=>{const id=++instance;return{stores:async()=>{calls++;return{id};}};}});
 await new Promise(r=>server.listen(port,'127.0.0.1',r));
 try{
 const origin=`http://127.0.0.1:${port}`;
 const b=await fetch(origin+'/api/bootstrap');const cookie=b.headers.get('set-cookie').split(';')[0];const {csrf}=await b.json();
 const headers={Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'};
 const post=(h,body='{}')=>fetch(origin+'/api/stores',{method:'POST',headers:h,body});
 assert.equal((await post({...headers,Origin:'https://evil.example'})).status,403);
 assert.equal((await post({...headers,'X-CSRF-Token':'bad'})).status,403);
 assert.equal((await post({...headers,Cookie:''})).status,403);
 const hostStatus=await new Promise((resolve,reject)=>{const r=http.request(origin+'/api/stores',{method:'POST',headers:{...headers,Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end('{}');});
 assert.equal(hostStatus,403);
 assert.equal((await post(headers,'x'.repeat(17000))).status,413);
 assert.equal(calls,0);
 assert.deepEqual(await(await post(headers)).json(),{id:1});
 const b2=await fetch(origin+'/api/bootstrap');const csrf2=(await b2.json()).csrf;
 assert.deepEqual(await(await post({...headers,Cookie:b2.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':csrf2})).json(),{id:2});
 const staticRes=await fetch(origin+'/');assert.equal(staticRes.status,200);assert.match(staticRes.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 assert.equal((await fetch(origin+'/scripts/mcp.mjs')).status,404);
 }finally{await new Promise(r=>server.close(r));}
});
test('无凭证保留历史页面，真实查询明确拒绝',async()=>{
 const port=18769,server=createApp({port,token:''});await new Promise(r=>server.listen(port,'127.0.0.1',r));
 try{const origin=`http://127.0.0.1:${port}`,res=await fetch(origin+'/api/bootstrap'),data=await res.json();assert.equal(data.liveEnabled,false);const denied=await fetch(origin+'/api/plan',{method:'POST',headers:{Origin:origin,Cookie:res.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':data.csrf,'Content-Type':'application/json'},body:'{}'});assert.equal(denied.status,503);}finally{await new Promise(r=>server.close(r));}
});
