import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { McpClient, ALLOWED_TOOLS } from './mcp.mjs';
import { Planner } from './planner.mjs';
import { money } from './engine.mjs';

const args=process.argv.slice(2), command=args.shift();
async function jsonFile(path){if(!path)throw new Error('请提供 JSON 文件路径');return JSON.parse(await fs.readFile(path,'utf8'));}
function print(result){console.log(JSON.stringify(result,null,2));}
try {
  if(command==='demo'){
    const r=await jsonFile(fileURLToPath(new URL('../examples/verified-report.json',import.meta.url)));
    console.log('历史实测回放｜不是当前报价，不使用你的账户数据。');
    console.log(`原餐：${r.base.name} ¥${money(r.base.priceCents)} / ${r.base.nutrition.energyKcal} kcal`);
    for(const c of r.candidates)console.log(`${c.name}｜¥${money(c.priceCents)}｜${c.nutrition.energyKcal??'未知'} kcal｜${c.state}`);
  }else if(command==='probe'){
    const c=await new McpClient(process.env.MCD_MCP_TOKEN).init();print({connected:true,allowed:[...c.tools.keys()].filter(x=>ALLOWED_TOOLS.has(x))});
  }else if(command==='stores'){
    const p=new Planner(new McpClient(process.env.MCD_MCP_TOKEN));print(await p.stores(args[0],args[1]));
  }else if(command==='menu'){
    const p=new Planner(new McpClient(process.env.MCD_MCP_TOKEN));const r=await p.load(await jsonFile(args[0]));print(r);
  }else if(command==='base'){
    const p=new Planner(new McpClient(process.env.MCD_MCP_TOKEN));await p.load(await jsonFile(args[0]));print(await p.base(args[1]));
  }else if(command==='plan'){
    const input=await jsonFile(args[0]);const p=new Planner(new McpClient(process.env.MCD_MCP_TOKEN));await p.load(input.context);print(await p.plan(input));
  }else{
    console.log('麦麦尝新预算 · Node.js 22+\n  node scripts/cli.mjs demo\n  node scripts/cli.mjs probe\n  node scripts/cli.mjs stores 城市 地标\n  node scripts/cli.mjs menu context.json\n  node scripts/cli.mjs base context.json 套餐编码\n  node scripts/cli.mjs plan request.json\n真实调用从环境变量 MCD_MCP_TOKEN 读取凭证。只支持到店自取与价格试算。');
    if(command)process.exitCode=1;
  }
}catch(e){console.error(e.message);process.exitCode=1;}
