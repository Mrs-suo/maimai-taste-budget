import { nutritionTable, totals, defaultSelections, selectBaseline, basket, modification, menuList, activities, checkCandidate, safeQuote, recommendationOrder, normalize, validateConstraints } from './engine.mjs';

export class Planner {
  constructor(client) { this.client = client; this.details = new Map(); }
  foodImage(item) {
    const generic = item.name.replace(/小杯|中杯|大杯/g, '');
    const image = this.menu.find(m=>m.code===item.code)?.image || this.menu.find(m=>m.name===generic)?.image;
    try { const u=new URL(image); return u.protocol==='https:' && u.hostname==='menu-img.mcd.cn' ? u.href : null; } catch { return null; }
  }
  async stores(city, keyword) {
    if (!city || !keyword || city.length > 50 || keyword.length > 100) throw new Error('请填写城市与附近地标');
    const r = await this.client.call('query-nearby-stores', { beType: 1, searchType: 2, city, keyword });
    if (!Array.isArray(r.data)) throw new Error('门店查询未返回可用列表');
    return r.data.map(s => ({ code: s.storeCode, name: s.storeName, address: s.address, open: s.businessStatus, reservation: s.reservationTimeOptions || [] }));
  }
  async load(context) {
    if (!/^\d{1,20}$/.test(context.storeCode)) throw new Error('门店编码无效');
    if (context.reservationDate && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(context.reservationDate)) throw new Error('预约时间格式应为 yyyy-MM-dd HH:mm');
    this.context = { storeCode: context.storeCode, orderType: 1, beType: 1, ...(context.reservationDate ? { reservationDate: context.reservationDate } : {}) };
    this.details.clear(); this.loadedAt = 0; this.menu = [];
    const result = await Promise.allSettled([
      this.client.call('query-meals', this.context), this.client.call('list-nutrition-foods'), this.client.call('campaign-calendar'), this.client.call('query-store-coupons', this.context), this.client.call('now-time-info')
    ]);
    if (result[0].status !== 'fulfilled') throw new Error(`菜单查询失败：${result[0].reason.message}`);
    this.menu = menuList(result[0].value);
    this.loadedAt = Date.now();
    this.warnings = [];
    const names = ['菜单', '营养表', '活动日历', '门店优惠券', '官方时间'];
    for (let i=1;i<result.length;i++) if (result[i].status === 'rejected') this.warnings.push(`${names[i]}暂不可用：${result[i].reason.message}`);
    try { this.nutrition = result[1].status === 'fulfilled' ? nutritionTable(result[1].value) : new Map(); } catch(e) { this.nutrition = new Map(); this.warnings.push(e.message); }
    const date = this.context.reservationDate?.slice(0,10) || (result[4].status === 'fulfilled' ? result[4].value.data?.date : null);
    this.activityList = result[2].status === 'fulfilled' && date ? activities(result[2].value, date) : [];
    if (!date && result[2].status === 'fulfilled') this.warnings.push('无法确认官方日期，暂不展示活动时效');
    this.coupons = result[3].status === 'fulfilled' && Array.isArray(result[3].value.data) ? result[3].value.data : [];
    if(result[3].status==='fulfilled' && !Array.isArray(result[3].value.data))this.warnings.push('优惠券格式无法识别，仅核算无券价格');
    return { menu: this.menu.filter(m => /套餐|三件套|单人餐/.test(m.name)), activities: this.activityList, couponCount: this.coupons.length, warnings: this.warnings, context: this.context };
  }
  async detail(code) {
    if (!this.details.has(code)) {
      const r = await this.client.call('query-meal-detail', { ...this.context, code });
      if (!r.data?.code || r.data.code !== code) throw new Error('餐品详情不匹配');
      this.details.set(code, r.data);
    }
    return this.details.get(code);
  }
  async base(code) {
    if (!this.menu?.some(m => m.code === code)) throw new Error('请从当前门店菜单选择套餐');
    const detail = await this.detail(code); const defaults = defaultSelections(detail);
    return { code, name: detail.name, rounds: detail.rounds.map((r, i) => ({ id: String(r.id), name: r.name, selected: defaults[i].code, choices: r.choices.filter(c => c.maxQuantity !== 0).map(c => ({ code: c.code, name: c.name, kcal: this.nutrition.get(normalize(c.name))?.energyKcal ?? null })) })), nutrition: totals(defaults, this.nutrition) };
  }
  async bestQuote(routes) {
    const quotes = [], failures = []; let attempts = 0;
    for (const route of routes) {
      const variants = [{ items: route.items, couponTitle: null }];
      // 一次只用一张适用商品券。套餐子项不能冒充单点 SKU 套券。
      for (const coupon of this.coupons) {
        if (!coupon.couponId || !coupon.couponCode) continue;
        for (let i = 0; i < route.items.length; i++) {
          if (!(coupon.products || []).some(p => p.productCode === route.items[i].productCode)) continue;
          const items = structuredClone(route.items);
          items[i].couponId = coupon.couponId; items[i].couponCode = coupon.couponCode;
          variants.push({ items, couponTitle: coupon.title });
        }
      }
      if (variants.length > 7) this.warnings.push('匹配券较多，仅比较前 6 个单券方案');
      for (const variant of variants.slice(0,7)) {
        attempts++;
        try {
          const response = await this.client.call('calculate-price', { ...this.context, items: variant.items, needTableware: false });
          quotes.push({ ...safeQuote(response), route: route.name, couponTitle: variant.couponTitle, usedCoupon: Boolean(variant.couponTitle) });
        } catch(e) { failures.push(`${route.name}${variant.couponTitle ? '（用券）' : '（无券）'}：${e.message}`); }
      }
    }
    if (!quotes.length) throw new Error('候选餐单官方核价失败，未使用展示价代替');
    quotes.sort((a,b) => a.priceCents - b.priceCents || Number(a.usedCoupon) - Number(b.usedCoupon));
    const best = quotes[0];
    const noCoupon = quotes.filter(q=>!q.usedCoupon).sort((a,b)=>a.priceCents-b.priceCents)[0];
    return { ...best, couponSavingCents: noCoupon ? noCoupon.priceCents - best.priceCents : null, comparisons: quotes, failures, attempts };
  }
  async singleRoute(components) {
    const items=[];
    const family = s => normalize(s).replace(/可口可乐/g,'可乐').replace(/中杯|大杯|小杯|中薯条|大薯条|小薯条/g, m=>m.includes('薯条')?'薯条':'');
    for(const component of components) {
      const candidates=this.menu.filter(m=>m.code===component.code || family(m.name)===family(component.name)).slice(0,3);
      let found;
      for(const candidate of candidates){
        const d=await this.detail(candidate.code);
        if(!d.rounds?.length && normalize(d.name)===normalize(component.name) && JSON.stringify(modification(d))===JSON.stringify(modification(component))) {
          found={productCode:d.code,quantity:1,...(modification(component)?{modification:modification(component)}:{})};break;
        }
        if(d.rounds?.length===1){
          const r=d.rounds[0];const choice=r.choices?.find(c=>c.code===component.code && normalize(c.name)===normalize(component.name));
          if(choice && r.minQuantity===1 && r.maxQuantity===1 && JSON.stringify(modification(choice))===JSON.stringify(modification(component))){
            found={productCode:d.code,quantity:1,roundList:[{round:String(r.id),comboItemList:[{code:choice.code,quantity:1,...(modification(choice)?{modification:modification(choice)}:{})}]}]};break;
          }
        }
      }
      if(!found)return null;items.push(found);
    }
    return {name:'同餐品单点组合',items};
  }
  async plan(request) {
    const {baseCode, baselineCodes, swapRound, constraints}=request;
    const avoidCodes = Array.isArray(request.avoidCodes) ? request.avoidCodes.filter(c=>typeof c==='string').slice(0,200) : [];
    validateConstraints(constraints);
    if (!this.loadedAt || Date.now()-this.loadedAt>600000)throw new Error('菜单已超过 10 分钟，请重新查询门店菜单');
    if(!this.menu.some(m=>m.code===baseCode))throw new Error('套餐不在当前门店菜单');
    const detail=await this.detail(baseCode);const baseline=selectBaseline(detail,baselineCodes);
    const index=detail.rounds.findIndex(r=>String(r.id)===String(swapRound));
    if(index<0)throw new Error('请选择这次想换的一项');
    const current=baseline[index];
    const quote=async components=>{
      const routes=[{name:'原套餐选配',items:basket(detail,components)}];
      try {const singles=await this.singleRoute(components);if(singles)routes.push(singles);}catch { this.warnings.push('部分单点路径无法核实，本次保留已核实的套餐路径'); }
      return this.bestQuote(routes);
    };
    const base={name:detail.name,image:detail.image||this.foodImage(detail),components:baseline.map(c=>({code:c.code,name:c.name,image:this.foodImage(c)})),nutrition:totals(baseline,this.nutrition),...(await quote(baseline))};
    const round=detail.rounds[index];
    const seen=new Set();
    const options=round.choices.filter(c=> c.code!==current.code && c.maxQuantity!==0 && !avoidCodes.includes(c.code) && !seen.has(c.code) && seen.add(c.code));
    const candidates=[];
    for(const choice of options.slice(0,12)){
      const components=baseline.map((c,i)=>i===index?{...choice,round:String(round.id),count:1}:c);
      const tags=this.menu.find(m=>m.code===choice.code)?.tags||[];
      const nutrition=totals(components,this.nutrition);
      const relatedActivities=this.activityList.filter(a=>a.status==='今日' && normalize(a.title+' '+a.text).includes(normalize(choice.name))).map(a=>({date:a.date,title:a.title}));
      const common={code:choice.code,name:choice.name,image:this.foodImage(choice),from:current.name,components:components.map(c=>({code:c.code,name:c.name,image:this.foodImage(c)})),nutrition,newTagged:tags.some(t=>/上新|新品/.test(t)),tags,relatedActivities};
      try {const q=await quote(components);candidates.push({...common,...q,...checkCandidate(base,{...q,nutrition},constraints)});}
      catch(e){candidates.push({...common,state:'unverified',reasons:[e.message],priceCents:null,deltaCents:null,deltaKcal:null});}
    }
    candidates.sort(recommendationOrder);
    const eligible=candidates.filter(c=>c.state==='eligible');
    return { mode:'live', context:this.context, createdAt:new Date().toISOString(), base, candidates, recommended:eligible[0]?.code||null, constraints, changedRound:String(round.id), locked:baseline.filter((_,i)=>i!==index).map(c=>c.name), couponCount:this.coupons.length, activities:this.activityList, warnings:[...new Set(this.warnings)], coverage:{evaluated:candidates.length,available:options.length,maxCouponsPerRoute:6,scope:'当前套餐的单项替换；验证通过的同餐品单点路径及至多 6 个单券方案。非全菜单穷举，不保证全局最低。'}, audit:this.client.audit.map(a=>({...a})) };
  }
}
