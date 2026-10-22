import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_TOOLS, McpClient, parseRpc, unwrap, validate } from '../scripts/mcp.mjs';

const fakeToken = 'synthetic-test-token';
test('并发首次查询共享一次初始化，避免相互覆盖 MCP 会话',async()=>{
 let starts=0;
 const client=new McpClient(fakeToken,{transport:async(_url,options)=>{
  const b=JSON.parse(options.body);let result;
  if(b.method==='initialize'){starts++;await new Promise(r=>setTimeout(r,5));result={protocolVersion:'2024-11-05'};}
  else if(b.method==='notifications/initialized')return new Response(null,{status:202});
  else if(b.method==='tools/list')result={tools:[{name:'now-time-info',inputSchema:{type:'object',properties:{}}}]};
  else result={structuredContent:{data:{date:'2026-10-22'}}};
  return Response.json({jsonrpc:'2.0',id:b.id,result});
 }});
 await Promise.all([client.call('now-time-info'),client.call('now-time-info')]);assert.equal(starts,1);assert.equal(client.audit.length,2);
});
const schema = { type: 'object', required: ['storeCode'], properties: { storeCode: { type: 'string' }, count: { type: 'integer' }, mode: { type: 'string', enum: ['pickup'] }, items: { type: 'array', items: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } } } };

test('解析 JSON、CRLF SSE、多行 data，忽略心跳及其他请求事件', () => {
  const obj = { jsonrpc: '2.0', id: 7, result: { ok: true } };
  assert.deepEqual(parseRpc(JSON.stringify(obj), 7), obj);
  const sse = ': heartbeat\r\n\r\ndata: {"jsonrpc":"2.0","method":"progress"}\r\n\r\ndata: {"id":6,"result":{}}\r\n\r\nevent: message\r\ndata: {"jsonrpc":"2.0", "id":7,\r\ndata: "result":{"ok":true}}\r\n\r\n';
  assert.deepEqual(parseRpc(sse, 7), obj);
  assert.throws(() => parseRpc('data: broken\n\n', 7));
  assert.throws(() => parseRpc('data: {"id":6}\n\n', 7));
});

test('工具结果优先结构化内容，错误结果不可作为推荐数据', () => {
  assert.deepEqual(unwrap({ structuredContent: { data: 1 }, content: [{ type: 'text', text: 'ignored' }] }), { data: 1 });
  assert.deepEqual(unwrap({ content: [{ type: 'text', text: '{"data":2}' }] }), { data: 2 });
  assert.throws(() => unwrap({ isError: true, structuredContent: { data: 1 } }));
});

test('白名单固定为查询和试算，业务写入在任何网络调用之前被拒绝', async () => {
  assert.deepEqual([...ALLOWED_TOOLS].sort(), ['now-time-info', 'query-nearby-stores', 'query-meals', 'query-meal-detail', 'query-store-coupons', 'calculate-price', 'campaign-calendar', 'list-nutrition-foods'].sort());
  let requests = 0;
  const client = new McpClient(fakeToken, { transport: async () => { requests++; throw Error('unexpected'); } });
  for (const name of ['create-order', 'cancel-order', 'auto-bind-coupons', 'mall-create-order', 'draw-lottery', 'party-order-create']) await assert.rejects(client.call(name), /仅允许/);
  assert.equal(requests, 0);
});

test('参数校验拒绝缺失、额外字段、错类型、枚举和嵌套错误', () => {
  assert.doesNotThrow(() => validate({ storeCode: '1', count: 1, mode: 'pickup', items: [{ code: 'meal' }] }, schema));
  for (const value of [{}, { storeCode: 1 }, { storeCode: '1', typo: 1 }, { storeCode: '1', count: 1.1 }, { storeCode: '1', mode: 'delivery' }, { storeCode: '1', items: [{}] }, { storeCode: '1', items: 'bad' }]) assert.throws(() => validate(value, schema));
});

test('服务端 schema 的数字、数组及字符串边界必须生效', () => {
  assert.throws(() => validate(0, { type: 'integer', minimum: 1 }));
  assert.throws(() => validate(4, { type: 'number', maximum: 3 }));
  assert.throws(() => validate([], { type: 'array', minItems: 1, items: { type: 'string' } }));
  assert.throws(() => validate(['a', 'b'], { type: 'array', maxItems: 1, items: { type: 'string' } }));
  assert.throws(() => validate('', { type: 'string', minLength: 1 }));
  assert.throws(() => validate('abcd', { type: 'string', maxLength: 3 }));
});

test('初始化协商、session、分页工具发现、SSE 调用及脱敏审计', async () => {
  const requests = [];
  const transport = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, options, body });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (body.method === 'initialize') result = { protocolVersion: '2025-03-26' };
    else if (body.method === 'tools/list') result = body.params.cursor ? { tools: [{ name: 'query-meals', inputSchema: schema }] } : { tools: [], nextCursor: 'page2' };
    else { assert.equal(body.method, 'tools/call'); return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: { code: 0, data: { meals: [] } } } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }); }
    return Response.json({ jsonrpc: '2.0', id: body.id, result }, { headers: { 'Mcp-Session-Id': 'test-session' } });
  };
  const client = new McpClient(fakeToken, { transport });
  assert.deepEqual(await client.call('query-meals', { storeCode: '1' }), { code: 0, data: { meals: [] } });
  assert.deepEqual(requests.map(r => r.body.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/list', 'tools/call']);
  assert.equal(requests[1].body.id, undefined);
  assert.equal(requests[1].options.headers['MCP-Protocol-Version'], '2025-03-26');
  assert.equal(requests[1].options.headers['Mcp-Session-Id'], 'test-session');
  assert.equal(requests[3].body.params.cursor, 'page2');
  assert.ok(requests.every(r => r.url === 'https://mcp.mcd.cn' && r.options.redirect === 'error'));
  assert.equal(client.audit.length, 1);
  assert.equal(client.audit[0].ok, true);
  assert.equal(JSON.stringify(client.audit).includes(fakeToken), false);
  assert.equal(JSON.stringify(client.audit).includes('storeCode'), false);
  const before = requests.length;
  await assert.rejects(client.call('query-meals', { storeCode: 1 }));
  assert.equal(requests.length, before);
});

test('HTTP 401/429、JSON-RPC 错误、错 id 和断网不自动重试', async () => {
  const cases = [
    [() => new Response('', { status: 401 }), /401/],
    [() => new Response('', { status: 429 }), /429/],
    [() => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32602 } }), /协议错误/],
    [() => Response.json({ jsonrpc: '2.0', id: 999, result: {} }), /编号不匹配/],
    [() => { throw Error('network'); }, /网络不可用/]
  ];
  for (const [respond, expected] of cases) {
    let requests = 0;
    const client = new McpClient(fakeToken, { transport: async () => { requests++; return respond(); } });
    await assert.rejects(client.rpc('tools/list'), expected);
    assert.equal(requests, 1);
  }
});

test('业务失败和工具 isError 均失败并记录审计，未发现工具不调用', async () => {
  for (const result of [{ isError: true }, { structuredContent: { code: 500, data: {} } }]) {
    const client = new McpClient(fakeToken, { transport: async (_url, options) => Response.json({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result }) });
    client.tools = new Map([['query-meals', { inputSchema: schema }]]);
    await assert.rejects(client.call('query-meals', { storeCode: '1' }));
    assert.equal(client.audit[0].ok, false);
    await assert.rejects(client.call('query-meal-detail'), /没有工具/);
  }
});
