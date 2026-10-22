export const normalize = s => String(s || '').replace(/[™®]/g, '').normalize('NFKC').replace(/\s/g, '');
export const money = n => (n / 100).toFixed(2);

function csv(line) {
  const result = []; let field = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (quoted && line[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { result.push(field.trim()); field = ''; }
    else field += c;
  }
  result.push(field.trim()); return result;
}
export function nutritionTable(response) {
  const data = response.data;
  let rows;
  if (Array.isArray(data)) rows = data;
  else if (typeof data === 'string') {
    const lines = data.split(/\r?\n/); const head = lines.findIndex(l => /\{productName,/.test(l));
    if (head < 0) throw new Error('官方营养表格式已变化，不能安全解析');
    const keys = lines[head].match(/\{([^}]+)\}/)[1].split(',');
    rows = lines.slice(head + 1).filter(l => l.trim()).map(l => Object.fromEntries(keys.map((k, i) => [k, csv(l.trim())[i]])));
  } else throw new Error('官方营养表为空或格式未知');
  const map = new Map();
  for (const r of rows) {
    const name = normalize(r.productName); if (!name) continue;
    const record = { name: r.productName };
    for (const key of ['energyKcal', 'protein', 'fat', 'carbohydrate', 'sodium', 'calcium']) {
      const raw = r[key]; const v = raw === null || raw === undefined || raw === '' || raw === 'null' ? NaN : Number(raw);
      record[key] = Number.isFinite(v) && v >= 0 ? v : null;
    }
    if (map.has(name) && JSON.stringify(map.get(name)) !== JSON.stringify(record)) map.set(name, null);
    else if (!map.has(name)) map.set(name, record);
  }
  return map;
}

export function totals(components, nutrition) {
  const values = { energyKcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 0, calcium: 0 };
  const missing = [];
  for (const item of components) {
    // 奶油球/糖包会改变营养，官方整品记录无法证明是否包含这些额外项。
    const extra = item.modification?.items?.some(g => g.values?.some(v => v.selectedQuantity > 0 && /糖|奶油球/.test(v.name)));
    const row = extra ? null : nutrition.get(normalize(item.name));
    if (!row || row.energyKcal === null) missing.push(item.name);
    for (const key of Object.keys(values)) {
      if (!row || row[key] === null) values[key] = null;
      else if (values[key] !== null) values[key] += row[key] * (item.count || 1);
    }
  }
  return { ...values, complete: missing.length === 0, missing };
}

export function defaultSelections(detail) {
  const rounds = detail.rounds || [];
  if (rounds.length < 2 || rounds.length > 6) throw new Error('本版支持可逐项选配的单人套餐，请换一个套餐');
  return rounds.map(r => {
    if (r.minQuantity !== 1 || r.maxQuantity !== 1) throw new Error('此套餐包含多份或任选多项，本版暂不支持，避免误算份数');
    const defaults = r.choices.filter(c => c.isDefault === 1 && c.quantity > 0);
    if (defaults.length !== 1 || defaults[0].quantity !== 1) throw new Error('此套餐默认选项不唯一，请换一个单人套餐');
    return { ...defaults[0], round: String(r.id), count: 1 };
  });
}

export function selectBaseline(detail, codes = []) {
  const defaults = defaultSelections(detail);
  if (codes.length === 0) return defaults;
  if (codes.length !== defaults.length) throw new Error('原餐的选项数量不正确');
  return detail.rounds.map((r, i) => {
    const c = r.choices.find(c => c.code === codes[i]);
    if (!c || c.maxQuantity === 0) throw new Error('原餐含门店不支持的选项');
    return { ...c, round: String(r.id), count: 1 };
  });
}

export function modification(item) {
  const values = [];
  for (const group of item.modification?.items || []) {
    for (const v of group.values || []) {
      if (v.selectedQuantity > 0) values.push({ code: v.code, key: v.selectedKey, quantity: v.selectedQuantity });
      else if (v.unselectedKey) values.push({ code: v.code, key: v.unselectedKey, quantity: 0 });
    }
  }
  if (values.some(v => !v.key || !v.code)) throw new Error('特调默认值不完整，无法构造可靠报价');
  return values.length ? { values } : undefined;
}
export function basket(detail, components) {
  return [{ productCode: detail.code, quantity: 1, roundList: components.map(c => ({ round: c.round, comboItemList: [{ code: c.code, quantity: 1, ...(modification(c) ? { modification: modification(c) } : {}) }] })) }];
}

export function validateConstraints(raw = {}) {
  for (const [k, max] of [['maxExtraCents', 100000], ['maxTotalCents', 100000], ['maxKcal', 10000]]) {
    const v = raw[k];
    if (k === 'maxExtraCents' && v == null) throw new Error('请设置最多加多少钱');
    if (v !== undefined && v !== null && (!Number.isInteger(v) || v < 0 || v > max)) throw new Error(`${k} 超出范围或不是整数`);
  }
  return raw;
}
export function checkCandidate(base, candidate, constraints) {
  validateConstraints(constraints);
  const reasons = [];
  if (!Number.isSafeInteger(base.priceCents) || !Number.isSafeInteger(candidate.priceCents)) return { state: 'unverified', reasons: ['官方报价不完整'] };
  const deltaCents = candidate.priceCents - base.priceCents;
  if (deltaCents > constraints.maxExtraCents) reasons.push('超过额外预算');
  if (constraints.maxTotalCents != null && candidate.priceCents > constraints.maxTotalCents) reasons.push('超过整餐预算');
  if (constraints.maxKcal != null && candidate.nutrition.energyKcal != null && candidate.nutrition.energyKcal > constraints.maxKcal) reasons.push('超过热量上限');
  const deltaKcal = base.nutrition.energyKcal != null && candidate.nutrition.energyKcal != null ? candidate.nutrition.energyKcal - base.nutrition.energyKcal : null;
  return { state: reasons.length ? 'excluded' : !candidate.nutrition.complete ? 'unknown-nutrition' : 'eligible', reasons, deltaCents, deltaKcal };
}

export function safeQuote(result) {
  const d = result.data;
  if (!d || !Number.isSafeInteger(d.price) || d.price < 0) throw new Error('官方核价未返回有效的整单应付金额');
  return { priceCents: d.price, quotedAt: result.datetime || new Date().toISOString(), productCents: Number.isSafeInteger(d.productPrice) ? d.productPrice : null, packingCents: Number.isSafeInteger(d.packingPrice) ? d.packingPrice : null };
}

export function menuList(response) {
  if (!response.data?.meals || !Array.isArray(response.data?.categories)) throw new Error('门店菜单格式不可识别');
  const categories = response.data.categories;
  return Object.entries(response.data.meals).map(([code, m]) => ({ code, name: m.name, image: m.image, categories: categories.filter(c => c.meals?.some(x => x.code === code)).map(c => c.name.replace(/\n/g, '')), tags: [...new Set(categories.flatMap(c => c.meals?.filter(x => x.code === code).flatMap(x => x.tags || []) || []))] }));
}

export function activities(response, date) {
  return (response.data?.dailyList || []).flatMap(day => (day.events || []).map(e => ({ date: day.date, status: day.date < date ? '往期' : day.date > date ? '预告' : '今日', title: e.activityTitle || e.articleDto?.title || e.activitySubTitle || '官方活动', text: (e.articleDto?.content || e.activitySubTitle || '').slice(0,700) }))).filter(e => e.title !== '官方活动');
}

export function recommendationOrder(a, b) {
  const priority = { eligible: 0, 'unknown-nutrition': 1, excluded: 2, unverified: 3 };
  return priority[a.state] - priority[b.state] || Number(b.newTagged) - Number(a.newTagged) || a.priceCents - b.priceCents || a.name.localeCompare(b.name, 'zh');
}
