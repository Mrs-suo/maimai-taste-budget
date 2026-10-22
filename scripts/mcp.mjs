export const ALLOWED_TOOLS = new Set(['now-time-info', 'query-nearby-stores', 'query-meals', 'query-meal-detail', 'query-store-coupons', 'calculate-price', 'campaign-calendar', 'list-nutrition-foods']);

export function validate(value, schema, path = '参数') {
  if (typeof value === 'number' && ((schema.minimum != null && value < schema.minimum) || (schema.maximum != null && value > schema.maximum))) throw new Error(`${path} 超出数值范围`);
  if (typeof value === 'string' && ((schema.minLength != null && value.length < schema.minLength) || (schema.maxLength != null && value.length > schema.maxLength))) throw new Error(`${path} 长度不符合要求`);
  if (Array.isArray(value) && ((schema.minItems != null && value.length < schema.minItems) || (schema.maxItems != null && value.length > schema.maxItems))) throw new Error(`${path} 数量不符合要求`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path} 不在允许值内`);
  const type = schema.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 应是对象`);
    for (const k of schema.required || []) if (value[k] === undefined) throw new Error(`${path}.${k} 必填`);
    for (const [k, v] of Object.entries(value)) {
      if (!schema.properties?.[k]) throw new Error(`${path}.${k} 不是已知参数`);
      validate(v, schema.properties[k], `${path}.${k}`);
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} 应是数组`);
    for (const v of value) validate(v, schema.items || {}, path);
  } else if (type === 'integer' && !Number.isInteger(value)) throw new Error(`${path} 应是整数`);
  else if (type === 'number' && !Number.isFinite(value)) throw new Error(`${path} 应是数字`);
  else if (type === 'string' && typeof value !== 'string') throw new Error(`${path} 应是字符串`);
  else if (type === 'boolean' && typeof value !== 'boolean') throw new Error(`${path} 应是布尔值`);
}

export function parseRpc(text, id) {
  try { return JSON.parse(text); } catch {}
  for (const frame of text.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
    if (!data) continue;
    try { const obj = JSON.parse(data); if (obj.id === id) return obj; } catch {}
  }
  throw new Error('MCP 返回无法识别的消息');
}

export function unwrap(result) {
  if (result?.isError) throw new Error('MCP 工具调用失败，请检查工具参数或稍后重试');
  if (result?.structuredContent) return result.structuredContent;
  const text = (result?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  try { return JSON.parse(text); } catch { return { text }; }
}

export class McpClient {
  constructor(token, { transport = fetch, timeout = 25000 } = {}) {
    if (!token || !/^[A-Za-z0-9._~-]{10,512}$/.test(token)) throw new Error('请在本地设置有效的 MCD_MCP_TOKEN');
    this.token = token; this.transport = transport; this.timeout = timeout; this.id = 0; this.session = null; this.tools = null;
    this.audit = [];
  }
  async rpc(method, params = {}, notification = false) {
    const id = ++this.id;
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${this.token}` };
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    if (this.protocol) headers['MCP-Protocol-Version'] = this.protocol;
    let response;
    try {
      response = await this.transport('https://mcp.mcd.cn', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }), signal: AbortSignal.timeout(this.timeout), redirect: 'error' });
    } catch { throw new Error('MCP 连接超时或网络不可用；未自动重试'); }
    this.session = response.headers.get('mcp-session-id') || this.session;
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}${response.status === 401 ? '：凭证失效' : response.status === 429 ? '：请求过于频繁，请稍后重试' : ''}`);
    if (notification) { await response.body?.cancel(); return; }
    const data = parseRpc(await response.text(), id);
    if (data.error) throw new Error(`MCP 协议错误 ${data.error.code || ''}`);
    if (data.id !== id) throw new Error('MCP 响应编号不匹配');
    return data.result;
  }
  async init() {
    if (this.tools) return this;
    if (!this.initializing) this.initializing = this.discover().catch(e => { this.initializing = null; throw e; });
    return this.initializing;
  }
  async discover() {
    const hello = await this.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'maimai-taste-budget', version: '1.0.0' } });
    this.protocol = hello.protocolVersion;
    await this.rpc('notifications/initialized', {}, true);
    const tools = []; let cursor;
    for (let n = 0; n < 10; n++) {
      const result = await this.rpc('tools/list', cursor ? { cursor } : {});
      tools.push(...result.tools); cursor = result.nextCursor; if (!cursor) break;
    }
    this.tools = new Map(tools.map(t => [t.name, t])); return this;
  }
  async call(name, args = {}) {
    if (!ALLOWED_TOOLS.has(name)) throw new Error('本 Skill 仅允许查询与价格试算，不支持该工具');
    await this.init();
    const spec = this.tools.get(name); if (!spec) throw new Error(`服务端没有工具 ${name}`);
    validate(args, spec.inputSchema);
    const started = Date.now();
    try {
      const result = unwrap(await this.rpc('tools/call', { name, arguments: args }));
      if (result.success === false || (result.code != null && ![0, 200, '0', '200'].includes(result.code))) throw new Error('业务接口返回失败，请检查门店、时段或餐品');
      this.audit.push({ tool: name, ok: true, elapsedMs: Date.now() - started, at: new Date().toISOString() });
      return result;
    } catch (e) { this.audit.push({ tool: name, ok: false, elapsedMs: Date.now() - started, at: new Date().toISOString() }); throw e; }
  }
}
