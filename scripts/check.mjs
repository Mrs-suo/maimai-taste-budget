import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=new URL('../',import.meta.url);
const required=['README.md','SKILL.md','CONTEST_DECLARATION.md','MCP_INTEGRATION.md','mcp-config.example.json','docs/verification.md','docs/submission.md','web/index.html'];
for(const name of required)await fs.access(new URL(name,root));
const declaration=await fs.readFile(new URL('CONTEST_DECLARATION.md',root));
if(crypto.createHash('sha256').update(declaration).digest('hex')!=='cd28101bcb29cc8fb24b372fe91ce6b42c4a1487a54e01f7ade0c8c6a84241b7')throw new Error('官方声明字节与核实版本不符');
const config=JSON.parse(await fs.readFile(new URL('mcp-config.example.json',root),'utf8'));
if(!JSON.stringify(config).includes('${MCD_MCP_TOKEN}'))throw new Error('配置缺少环境变量占位符');
for(const dir of ['scripts','web','test'])for(const name of await fs.readdir(new URL(dir+'/',root))){if(!/\.(mjs|js)$/.test(name))continue;const file=new URL(dir+'/'+name,root);const r=spawnSync(process.execPath,['--check',file.pathname.replace(/^\/(?=[A-Z]:)/i,'')],{encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);}
console.log('交付文件、官方声明 SHA-256、占位配置及全部 JS 语法检查通过。');
