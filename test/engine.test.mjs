import test from 'node:test';
import assert from 'node:assert/strict';
import { nutritionTable, totals, checkCandidate, validateConstraints, safeQuote, defaultSelections, selectBaseline } from '../scripts/engine.mjs';
import { Planner } from '../scripts/planner.mjs';

const row = (productName, energyKcal, rest = {}) => ({ productName, energyKcal, protein: 1, fat: 2, carbohydrate: 3, sodium: 4, calcium: 5, ...rest });
const meal = (priceCents, energyKcal, complete = true) => ({ priceCents, nutrition: { energyKcal, complete } });
const bounds = { maxExtraCents: 500, maxTotalCents: 2500, maxKcal: 600 };

test('整分预算和热量上限允许恰好相等，超过一分或一千卡即排除', () => {
  const base = meal(2000, 500);
  const edge = checkCandidate(base, meal(2500, 600), bounds);
  assert.equal(edge.state, 'eligible');
  assert.equal(edge.deltaCents, 500);
  assert.equal(edge.deltaKcal, 100);
  assert.deepEqual(checkCandidate(base, meal(2501, 600), bounds).reasons, ['超过额外预算', '超过整餐预算']);
  assert.deepEqual(checkCandidate(base, meal(2500, 601), bounds).reasons, ['超过热量上限']);
  assert.equal(checkCandidate(base, meal(1900, 400), { maxExtraCents: 0 }).state, 'eligible');
});

test('预算输入拒绝缺失、null、负数、小数、字符串和超限值', () => {
  for (const maxExtraCents of [undefined, null, -1, 0.5, '500', NaN, Infinity, 100001]) {
    assert.throws(() => validateConstraints({ maxExtraCents }), String(maxExtraCents));
  }
  assert.doesNotThrow(() => validateConstraints({ maxExtraCents: 0, maxTotalCents: null, maxKcal: null }));
  assert.doesNotThrow(() => validateConstraints({ maxExtraCents: 100000, maxTotalCents: 100000, maxKcal: 10000 }));
  assert.throws(() => validateConstraints({ maxExtraCents: 1, maxKcal: 10001 }));
});

test('官方整单报价须是非负安全整数，展示价格不能替代应付价', () => {
  for (const price of [undefined, null, '2500', -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => safeQuote({ data: { price, productPrice: 2000 } }));
  }
  assert.equal(safeQuote({ data: { price: 0 } }).priceCents, 0);
  assert.equal(checkCandidate(meal(2000, 500), meal(null, 300), bounds).state, 'unverified');
});

test('缺失营养和冲突营养不能标成达标；已确认超预算仍须排除', () => {
  const nutrition = nutritionTable({ data: [row('汉堡', 300)] });
  const unknown = totals([{ name: '汉堡' }, { name: '未收录饮料' }], nutrition);
  assert.equal(unknown.complete, false);
  assert.equal(unknown.energyKcal, null);
  assert.deepEqual(unknown.missing, ['未收录饮料']);
  assert.equal(checkCandidate(meal(2000, 500), { priceCents: 2200, nutrition: unknown }, bounds).state, 'unknown-nutrition');
  assert.equal(checkCandidate(meal(2000, 500), { priceCents: 2600, nutrition: unknown }, bounds).state, 'excluded');
});

test('重复记录冲突后不能被后续记录覆盖，完全重复可用', () => {
  const nutrition = nutritionTable({ data: [row('汉堡', 300), row('汉堡', 301), row('汉堡', 300), row('中薯条', 200), row('中薯条', 200)] });
  assert.equal(nutrition.get('汉堡'), null);
  assert.equal(nutrition.get('中薯条').energyKcal, 200);
  assert.equal(totals([{ name: '汉堡' }], nutrition).complete, false);
});

test('份量与餐品名称必须精确匹配，不能用大杯替代中杯营养', () => {
  const nutrition = nutritionTable({ data: [row('可口可乐（大杯）', 250), row('中薯条', 300)] });
  assert.equal(totals([{ name: '可口可乐（中杯）' }], nutrition).complete, false);
  assert.equal(totals([{ name: '小薯条' }], nutrition).complete, false);
  assert.equal(totals([{ name: ' 中 薯 条™ ', count: 2 }], nutrition).energyKcal, 600);
});

test('糖包和奶油球未包含在整品营养证据时标记未知', () => {
  const nutrition = nutritionTable({ data: [row('咖啡', 5)] });
  const item = { name: '咖啡', modification: { items: [{ values: [{ name: '糖包', selectedQuantity: 1 }] }] } };
  assert.equal(totals([item], nutrition).complete, false);
});

test('支持带引号的 CSV 营养数据，非数值和负营养不补零', () => {
  const nutrition = nutritionTable({ data: '营养表\n{productName,energyKcal,protein}\n"饮料,大杯",100,2\n汉堡,null,-1' });
  assert.equal(nutrition.get('饮料,大杯').energyKcal, 100);
  assert.equal(nutrition.get('汉堡').energyKcal, null);
  assert.equal(nutrition.get('汉堡').protein, null);
  assert.throws(() => nutritionTable({ data: '不认识的格式' }));
});

const choice = (code, name, isDefault = 0) => ({ code, name, isDefault, quantity: isDefault, maxQuantity: 1 });
const detail = () => ({ code: 'combo', name: '单人套餐', rounds: [
  { id: 'main', minQuantity: 1, maxQuantity: 1, choices: [choice('burger', '汉堡', 1), choice('chicken', '鸡腿堡')] },
  { id: 'drink', minQuantity: 1, maxQuantity: 1, choices: [choice('cola', '可乐', 1), choice('tea', '茶'), { ...choice('sold', '售罄饮料'), maxQuantity: 0 }] },
  { id: 'side', minQuantity: 1, maxQuantity: 1, choices: [choice('fries', '薯条', 1), choice('pie', '派')] }
] });

test('原餐保留用户选择，拒绝多份套餐和门店不支持的选项', () => {
  const d = detail();
  assert.deepEqual(selectBaseline(d, ['chicken', 'cola', 'fries']).map(c => c.code), ['chicken', 'cola', 'fries']);
  assert.throws(() => selectBaseline(d, ['burger', 'sold', 'fries']));
  assert.throws(() => selectBaseline(d, ['burger']));
  d.rounds[0].maxQuantity = 2;
  assert.throws(() => defaultSelections(d));
});

test('实际推荐编排只换指定一项，其余用户选项保留且不核价售罄选项', async () => {
  const calls = [];
  const client = { audit: [], async call(name, args) {
    calls.push({ name, args: structuredClone(args) });
    if (name === 'query-meal-detail') return { data: detail() };
    assert.equal(name, 'calculate-price');
    return { data: { price: 2000 }, datetime: '2026-10-22T00:00:00Z' };
  } };
  const planner = new Planner(client);
  Object.assign(planner, { loadedAt: Date.now(), context: { storeCode: '1' }, menu: [{ code: 'combo', name: '单人套餐' }], nutrition: nutritionTable({ data: ['汉堡', '鸡腿堡', '可乐', '茶', '薯条', '派'].map(n => row(n, 100)) }), coupons: [], warnings: [], activityList: [] });
  const result = await planner.plan({ baseCode: 'combo', baselineCodes: ['chicken', 'cola', 'fries'], swapRound: 'drink', constraints: { maxExtraCents: 0 } });
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.base.components.map(c => c.code), ['chicken', 'cola', 'fries']);
  assert.deepEqual(result.candidates[0].components.map(c => c.code), ['chicken', 'tea', 'fries']);
  assert.deepEqual(result.locked, ['鸡腿堡', '薯条']);
  assert.equal(result.recommended, 'tea');
  const quoted = calls.filter(c => c.name === 'calculate-price').map(c => c.args.items[0].roundList.map(r => r.comboItemList[0].code));
  assert.deepEqual(quoted, [['chicken', 'cola', 'fries'], ['chicken', 'tea', 'fries']]);
  await assert.rejects(planner.plan({ baseCode: 'combo', swapRound: 'not-real', constraints: { maxExtraCents: 0 } }), /一项/);
});

test('单点路径不把大杯或其他份量冒充原餐品', async () => {
  const planner = new Planner({ async call() { return { data: { code: 'large', name: '可乐大杯' } }; } });
  planner.menu = [{ code: 'large', name: '可乐大杯' }];
  planner.context = { storeCode: '1' };
  assert.equal(await planner.singleRoute([{ code: 'medium', name: '可乐中杯' }]), null);
});

test('切换门店加载失败后不能继续使用旧门店菜单',async()=>{
 const planner=new Planner({call:async()=>{throw new Error('offline');}});planner.loadedAt=Date.now();planner.menu=[{code:'old'}];
 await assert.rejects(planner.load({storeCode:'2'}),/菜单查询失败/);assert.equal(planner.loadedAt,0);assert.deepEqual(planner.menu,[]);
 await assert.rejects(planner.plan({baseCode:'old',constraints:{maxExtraCents:0}}),/重新查询/);
});

test('餐品图片仅允许官方 HTTPS 图片域，通用图只匹配同名餐品',()=>{
 const p=new Planner({});p.menu=[{code:'corn',name:'玉米杯',image:'https://menu-img.mcd.cn/corn.png'},{code:'evil',name:'其他',image:'https://example.com/image.png'}];
 assert.equal(p.foodImage({code:'large',name:'大杯玉米杯'}),'https://menu-img.mcd.cn/corn.png');
 assert.equal(p.foodImage({code:'evil',name:'其他'}),null);
 assert.equal(p.foodImage({code:'absent',name:'鸡翅'}),null);
});
