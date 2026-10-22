const $=id=>document.getElementById(id);
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const yuan=n=>n==null?'未核实':`¥${(n/100).toFixed(2)}`;
let boot,mode='historical',report,stores=[],base;
let avoided=[];try{avoided=JSON.parse(localStorage.getItem('maimai-dislikes')||'[]');if(!Array.isArray(avoided))avoided=[];}catch{}
let busy=false;
const scrollToControl=id=>$(id)?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:id==='results'?'start':'center'});
function showError(message){$('error').textContent=message;$('error').focus({preventScroll:true});scrollToControl('error');}
async function api(path,input){
 let res;try{res=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':boot.csrf},body:JSON.stringify(input),signal:AbortSignal.timeout(180000)});}catch(e){throw new Error(e.name==='TimeoutError'?'查询超时，请稍后重新查询；不会自动下单。':'无法连接本地服务，请检查服务是否仍在运行，然后重试。');}
 let data;try{data=await res.json();}catch{throw new Error('服务返回了无法识别的内容，请稍后重试。');}
 if(!res.ok)throw new Error(data.error||'查询失败，请稍后重试');return data;
}
async function run(fn,label=''){
 if(busy)return;busy=true;$('error').textContent='';const controls=[...document.querySelectorAll('button,input,select')];controls.forEach(b=>b.disabled=true);
 $('progress').hidden=!label;$('progress').textContent=label;document.querySelector('.workspace').setAttribute('aria-busy','true');
 try{await fn();}catch(e){showError(e.message);}finally{controls.forEach(b=>b.disabled=false);$('progress').hidden=true;document.querySelector('.workspace').setAttribute('aria-busy','false');busy=false;}
}
function invalidate(){report=null;$('results').innerHTML='';$('activities').innerHTML='';}
function resetMeal(){base=null;$('mealFields').hidden=true;$('meals').innerHTML='';$('rounds').innerHTML='';invalidate();}
function resetStore(){resetMeal();stores=[];$('storeFields').hidden=true;$('stores').innerHTML='';$('time').innerHTML='';}
function refreshFilters(){
 if(!report)return;
 if(mode==='live'&&Date.now()-Date.parse(report.createdAt)>600000){invalidate();throw new Error('上次报价已超过 10 分钟，请重新核价。');}
 render();
 if(mode==='live')$('notice').textContent='已按新条件筛选本次核价结果；没有额外查询。需要最新价格时，点击“帮我换个新口味”。';
}
function constraints(){const read=(id,scale,max,required=false)=>{const value=$(id).value;if(!value.trim()){if(required)throw new Error('请填写额外预算');return null;}const n=Number(value),scaled=Math.round(n*scale);if(!Number.isFinite(n)||n<0||n>max||Math.abs(n*scale-scaled)>1e-7)throw new Error('预算最多两位小数，热量请填写整数，且不能为负');return scaled;};return{maxExtraCents:read('extra',100,1000,true),maxTotalCents:read('total',100,1000),maxKcal:read('kcal',1,10000)};}
function reevaluate(c,b,limits){if(c.priceCents==null)return c;const reasons=[];if(c.priceCents-b.priceCents>limits.maxExtraCents)reasons.push('超过额外预算');if(limits.maxTotalCents!=null&&c.priceCents>limits.maxTotalCents)reasons.push('超过整餐预算');if(limits.maxKcal!=null&&c.nutrition.energyKcal!=null&&c.nutrition.energyKcal>limits.maxKcal)reasons.push('超过热量上限');return{...c,reasons,state:reasons.length?'excluded':!c.nutrition.complete?'unknown-nutrition':'eligible'};}
function foodPhoto(url,name,extra='') {
 try{const u=new URL(url);if(u.protocol!=='https:'||u.hostname!=='menu-img.mcd.cn')return '';}catch{return '';}
 return `<figure class="food-photo ${extra}"><img src="${escape(url)}" alt="${escape(name)}餐品示意" loading="lazy" width="320" height="240" referrerpolicy="no-referrer"><figcaption>餐品示意 · 份量以名称为准</figcaption></figure>`;
}
function bindImageFallbacks(){document.querySelectorAll('.food-photo img,.hero-food img').forEach(img=>{const fail=()=>{img.hidden=true;const caption=img.parentElement.querySelector('figcaption,.photo-caption');if(caption)caption.textContent='图片暂不可用，餐品信息仍可查看';};img.addEventListener('error',fail,{once:true});if(img.complete&&!img.naturalWidth)fail();});}
function render(){if(!report)return;const limits=constraints();const rows=report.candidates.map(c=>reevaluate(c,report.base,limits));const eligible=rows.filter(c=>c.state==='eligible'&&!avoided.includes(c.code));const rest=rows.filter(c=>c.state!=='eligible'||avoided.includes(c.code));const kcal=report.base.nutrition.energyKcal;const notes=report.warnings||[];
 $('results').innerHTML=`<section class="panel"><p class="eyebrow">这次保留 · ${report.locked.map(escape).join(' + ')}</p><div class="summary">${foodPhoto(report.base.image,report.base.name,'base-photo')}<div><h2>原本这一餐</h2><p>${report.base.components.map(c=>escape(c.name)).join(' + ')}</p></div><div class="price">${yuan(report.base.priceCents)} <small>／ ${kcal??'未知'} 千卡</small></div></div><p class="muted">${mode==='historical'?'历史回放，调预算只筛选历史结果。':'本次门店核价，重新查询后价格可能变化。'} ${escape(report.storeName||'门店 '+report.context.storeCode)} · ${escape(report.context.reservationDate||'当前时段')}</p><details class="coverage"><summary>这次比较了哪些方案？</summary><p class="muted">已核价 ${report.coverage.evaluated} / ${report.coverage.available} 个候选。${escape(report.coverage.scope)}</p></details>${notes.length?`<p>${notes.map(escape).join('<br>')}</p>`:''}</section><h2>${eligible.length?'这次，试试这样换':'这次没有全部满足条件的替换'}</h2>${!eligible.length?'<p class="empty">可以保留原餐，或调整预算和热量条件再看。营养未知的选项不会冒充达标推荐。</p>':''}<button class="adjust-budget" data-adjust>调整预算与热量 ↑</button><div class="cards">${eligible.map((c,i)=>card(c,i===0)).join('')}</div><details><summary>还有 ${rest.length} 个选项：查看条件不符、营养待确认或不喜欢的原因</summary><div class="cards">${rest.map(c=>card(c,false)).join('')}</div></details>`;
 const acts=(report.activities||[]).filter(a=>a.status!=='往期').slice(0,8);$('activities').innerHTML=acts.length?acts.map(a=>`<details class="activity"><summary><span>${escape(a.date)} · ${escape(a.status)}</span><strong>${escape(a.title)}</strong></summary><p>${escape(a.text)}</p></details>`).join(''):'<p class="muted">此查询范围内没有可展示的当日活动或预告。</p>';
 bindImageFallbacks();
 $('results').querySelectorAll('[data-avoid]').forEach(b=>b.onclick=()=>run(async()=>{constraints();if(!avoided.includes(b.dataset.avoid))avoided.push(b.dataset.avoid);try{localStorage.setItem('maimai-dislikes',JSON.stringify(avoided));}catch{}render();}));
 $('results').querySelectorAll('[data-save]').forEach(b=>b.onclick=()=>run(async()=>save(rows.find(c=>c.code===b.dataset.save))));
 $('results').querySelectorAll('[data-adjust]').forEach(b=>b.onclick=()=>{$('extra').focus({preventScroll:true});scrollToControl('extra');});
}
function card(c,best){const delta=c.deltaCents;return `<article class="card ${best?'best':''}"><span class="badge">${avoided.includes(c.code)?'你标记了不喜欢':c.state==='eligible'?(best?'这次可以试试':'另一个选择'):c.state==='unknown-nutrition'?'营养待确认':c.state==='excluded'?'暂不符合条件':'价格待核实'}${c.newTagged?' · 菜单标记上新':''}</span>${foodPhoto(c.image,c.name)}<h3>${escape(c.name)}</h3><p>${escape(c.from)} → ${escape(c.name)}，其余不变</p><div class="metrics"><div><strong>${yuan(c.priceCents)}</strong><span>整餐核价</span></div><div><strong>${c.nutrition.energyKcal??'未知'}</strong><span>整餐千卡</span></div></div><p class="delta">${delta==null?'未取得可靠报价':delta<=0?`比原餐省 ${yuan(-delta)}`:`比原餐多 ${yuan(delta)}`} ${c.deltaKcal==null?'· 热量差未知':`· ${c.deltaKcal>0?'增加':'减少'} ${Math.abs(c.deltaKcal)} 千卡`}</p><p class="muted">${escape(c.route||'暂无可靠路径')}${c.couponTitle?` · ${escape(c.couponTitle)}`:''}${c.couponSavingCents>0?` · 比已核实无券方案省 ${yuan(c.couponSavingCents)}`:''}<br>${escape((c.reasons||[]).join('；'))}${!c.nutrition.complete?`营养缺失：${c.nutrition.missing.map(escape).join('、')}`:''}</p>${c.relatedActivities?.length?`<p>相关活动：${c.relatedActivities.map(a=>escape(a.title)).join('；')}</p>`:''}<div class="actions"><button data-save="${escape(c.code)}">保存对照卡</button><button data-avoid="${escape(c.code)}">我不喜欢这个</button></div><details><summary>展开核价依据</summary>${(c.comparisons||[]).map(q=>`<p>${escape(q.route)} ${escape(q.couponTitle||'无券')} · ${yuan(q.priceCents)}</p>`).join('')}${(c.failures||[]).map(x=>`<p>${escape(x)}</p>`).join('')}</details></article>`;}
function save(c){const canvas=document.createElement('canvas');canvas.width=900;canvas.height=650;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff8ee';ctx.fillRect(0,0,900,650);ctx.fillStyle='#c82022';ctx.font='bold 42px Microsoft YaHei';ctx.fillText('麦麦尝新预算 · 今天只换一样',45,75);ctx.fillStyle='#25332d';ctx.font='26px Microsoft YaHei';const lines=[`${c.from} → ${c.name}`,`其他保留：${report.locked.join('、')}`,`原餐 ${yuan(report.base.priceCents)} / ${report.base.nutrition.energyKcal??'未知'} 千卡`,`换后 ${yuan(c.priceCents)} / ${c.nutrition.energyKcal??'未知'} 千卡`,c.deltaCents==null?'价格未核实':`变化 ${c.deltaCents>=0?'+':''}${yuan(c.deltaCents)}，热量变化 ${c.deltaKcal??'未知'} 千卡`,`${mode==='historical'?'历史实测回放，非当前价格':'本次查询，非下单凭证'}`,`门店 ${report.context.storeCode} · ${report.context.reservationDate||report.createdAt.slice(0,10)}`,`营养${c.nutrition.complete?'来自官方餐品表':'数据缺失，不可判断是否达标'} · 独立参赛作品`];lines.forEach((s,i)=>ctx.fillText(s,45,150+i*57,810));canvas.toBlob(blob=>{const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='麦麦尝新对照卡.png';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});}
async function demo(){
 mode='historical';resetStore();$('liveForm').hidden=true;$('demo').classList.add('active');$('live').classList.remove('active');
 report=await(await fetch('/demo.json')).json();$('notice').textContent='历史实测回放 · 2026-10-22 · 上海华旭国际大厦测试门店。这里不是你的当前位置或当前账户优惠。';render();
}
$('demo').onclick=()=>run(demo);
$('live').onclick=()=>run(async()=>{
 if(!boot.liveEnabled)throw new Error('本机服务未配置 MCD_MCP_TOKEN。请按 README 在本地进程配置后重启，页面不收集凭证。');
 mode='live';resetStore();$('liveForm').hidden=false;$('demo').classList.remove('active');$('live').classList.add('active');$('notice').textContent='实时查询 · 先选门店、原餐和唯一要换的一项，再核价。';scrollToControl('city');
});
$('city').addEventListener('input',resetStore);$('keyword').addEventListener('input',resetStore);
$('search').onclick=()=>run(async()=>{
 resetStore();stores=await api('stores',{city:$('city').value.trim(),keyword:$('keyword').value.trim()});
 $('stores').innerHTML=stores.map((s,i)=>`<option value="${i}">${escape(s.name)} · ${escape(s.address)}</option>`).join('');
 $('storeFields').hidden=!stores.length;if(!stores.length)throw new Error('没有找到门店，请换一个地标');times();scrollToControl('stores');
},'正在找附近门店…');
function times(){
 const store=stores[Number($('stores').value)];
 const slots=(store?.reservation||[]).flatMap(t=>[...String(t.reservationOptionText||'').matchAll(/(\d{2}):(\d{2})至(\d{2}):(\d{2})/g)].flatMap(m=>{
  const a=Number(m[1])*60+Number(m[2]),b=Number(m[3])*60+Number(m[4]),values=[];
  for(let v=Math.ceil(a/30)*30;v<=b;v+=30){const time=String(Math.floor(v/60)).padStart(2,'0')+':'+String(v%60).padStart(2,'0');values.push(`${t.date} ${time}`);}return values;
 }));
 $('time').innerHTML='<option value="">现在</option>'+[...new Set(slots)].sort().map(t=>`<option value="${escape(t)}">${escape(t)}</option>`).join('');base=null;
}
$('stores').onchange=()=>{resetMeal();times();};$('time').onchange=resetMeal;
$('menu').onclick=()=>run(async()=>{
 resetMeal();const store=stores[Number($('stores').value)];if(!store)throw new Error('请先选择门店');
 const data=await api('menu',{storeCode:store.code,...($('time').value?{reservationDate:$('time').value}:{})});
 if(!data.menu.length)throw new Error('此时段没有支持的套餐，可换一个官方可选时段');
 $('meals').innerHTML=data.menu.map(m=>`<option value="${escape(m.code)}">${escape(m.name)}</option>`).join('');$('mealFields').hidden=false;scrollToControl('meals');
},'正在读取这家店的菜单、活动和营养信息…');
$('meals').onchange=()=>{invalidate();base=null;$('rounds').innerHTML='';};$('rounds').onchange=invalidate;
$('base').onclick=()=>run(async()=>{
 invalidate();base=null;$('rounds').innerHTML='';
 const result=await api('base',{code:$('meals').value});const changeable=result.rounds.filter(r=>r.choices.length>1);
 if(!changeable.length)throw new Error('这份套餐没有可替换项，请换一份套餐');base=result;
 $('rounds').innerHTML=base.rounds.map(r=>`<label>原餐 · ${escape(r.name)}<select data-round="${escape(r.id)}">${r.choices.map(c=>`<option value="${escape(c.code)}" ${c.code===r.selected?'selected':''}>${escape(c.name)}</option>`).join('')}</select></label>`).join('')+`<label>这次只换<select id="swap">${changeable.map(r=>`<option value="${escape(r.id)}" ${r.id==='2'?'selected':''}>${escape(r.name)}</option>`).join('')}</select></label><p class="muted">其余餐品保持不变。下面设置预算，就可以开始比较。</p>`;
 scrollToControl('swap');
},'正在读取套餐组成和可替换项…');
$('calculate').onclick=()=>run(async()=>{
 const limits=constraints();if(mode==='historical'){render();scrollToControl('results');return;}
 if(!base)throw new Error('请先选定门店、套餐和原餐组成');invalidate();
 try{
  report=await api('plan',{baseCode:base.code,baselineCodes:[...document.querySelectorAll('[data-round]')].map(s=>s.value),swapRound:$('swap').value,constraints:limits,avoidCodes:[]});
  report.storeName=stores[Number($('stores').value)]?.name;render();$('notice').textContent='实时核价已完成 · 调整预算和热量即可筛选本次结果；不会创建订单。';scrollToControl('results');
 }catch(e){$('notice').textContent='这次核价未完成，请查看错误提示后重试。';throw e;}
},'正在逐项比较套餐、单点和可用优惠，通常需要数秒至数十秒…');
document.querySelectorAll('[data-budget]').forEach(button=>button.onclick=()=>run(async()=>{$('extra').value=button.dataset.budget;syncPresets();refreshFilters();}));
function syncPresets(){document.querySelectorAll('[data-budget]').forEach(button=>{const selected=Number(button.dataset.budget)===Number($('extra').value)&&$('extra').value!=='';button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));});}
$('extra').addEventListener('input',syncPresets);
for(const id of ['extra','total','kcal'])$(id).addEventListener('change',()=>run(async()=>{constraints();refreshFilters();}));
syncPresets();
$('clear').onclick=()=>run(async()=>{avoided=[];try{localStorage.removeItem('maimai-dislikes');}catch{}refreshFilters();});
run(async()=>{boot=await(await fetch('/api/bootstrap')).json();await demo();},'正在载入历史实测示例…');
