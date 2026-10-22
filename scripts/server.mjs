import http from 'node:http';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpClient } from './mcp.mjs';
import { Planner } from './planner.mjs';

export function createApp({token=process.env.MCD_MCP_TOKEN, port=Number(process.env.PORT||8768), plannerFactory=()=>new Planner(new McpClient(token))}={}){
 const sessions=new Map();
 const root=new URL('../',import.meta.url);
 const files={'/':['web/index.html','text/html; charset=utf-8'],'/app.js':['web/app.js','text/javascript; charset=utf-8'],'/styles.css':['web/styles.css','text/css; charset=utf-8'],'/favicon.svg':['web/favicon.svg','image/svg+xml'],'/demo.json':['examples/verified-report.json','application/json; charset=utf-8']};
 const server=http.createServer(async(req,res)=>{
  const hosts=[`127.0.0.1:${port}`,`localhost:${port}`];
  const send=(status,data,type='application/json; charset=utf-8')=>{res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://menu-img.mcd.cn; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(typeof data==='string'||Buffer.isBuffer(data)?data:JSON.stringify(data));};
  if(!hosts.includes(req.headers.host))return send(403,{error:'仅允许本机访问'});
  const path=new URL(req.url,`http://${req.headers.host}`).pathname;
  try{
   if(req.method==='GET'&&files[path]){const [file,type]=files[path];return send(200,await fs.readFile(new URL(file,root)),type);}
   if(req.method==='GET'&&path==='/api/bootstrap'){
    for(const [k,v]of sessions)if(Date.now()-v.created>3600000)sessions.delete(k);
    const sid=req.headers.cookie?.match(/(?:^|;\s*)maimai_session=([a-f0-9]{32})/)?.[1];
    let s=sessions.get(sid);
    if(!s){if(sessions.size>=16)return send(429,{error:'本机会话过多，请稍后重试'});const id=crypto.randomBytes(16).toString('hex');s={csrf:crypto.randomBytes(24).toString('hex'),created:Date.now(),busy:false,planner:null};sessions.set(id,s);res.setHeader('Set-Cookie',`maimai_session=${id}; HttpOnly; SameSite=Strict; Path=/`);}
    return send(200,{liveEnabled:Boolean(token),csrf:s.csrf});
   }
   if(req.method!=='POST'||!path.startsWith('/api/'))return send(404,{error:'未找到页面'});
   if(req.headers.origin!==`http://${req.headers.host}`)return send(403,{error:'拒绝跨站请求'});
   const sid=req.headers.cookie?.match(/(?:^|;\s*)maimai_session=([a-f0-9]{32})/)?.[1];const s=sessions.get(sid);
   if(!s||req.headers['x-csrf-token']!==s.csrf||Date.now()-s.created>3600000)return send(403,{error:'会话已失效，请刷新页面'});
   if(!token)return send(503,{error:'尚未设置本地 MCP 凭证，可先体验历史回放'});
   if(s.busy)return send(409,{error:'上一次查询还未完成，请稍候'});
   if(!req.headers['content-type']?.startsWith('application/json'))return send(415,{error:'需要 JSON 请求'});
   let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>16384)return send(413,{error:'请求过大'});}
   let input;try{input=JSON.parse(text);}catch{return send(400,{error:'请求格式错误'});}
   if(s.busy)return send(409,{error:'上一次查询还未完成，请稍候'});
   s.busy=true;
   try{
    s.planner ||= plannerFactory();const p=s.planner;
    if(path==='/api/stores')return send(200,await p.stores(input.city,input.keyword));
    if(path==='/api/menu')return send(200,await p.load(input));
    if(path==='/api/base')return send(200,await p.base(input.code));
    if(path==='/api/plan')return send(200,await p.plan(input));
    return send(404,{error:'未知操作'});
   }finally{s.busy=false;}
  }catch(e){send(400,{error:String(e.message||'处理失败').replaceAll(token||'__NO_TOKEN__','[已隐藏]')});}
 });
 return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const port=Number(process.env.PORT||8768);
 if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('PORT 应为 1024–65535 的整数');
 createApp({port}).listen(port,'127.0.0.1',()=>console.log(`麦麦尝新预算 http://127.0.0.1:${port} ｜${process.env.MCD_MCP_TOKEN?'已启用本地 MCP':'历史回放模式'}`));
}
