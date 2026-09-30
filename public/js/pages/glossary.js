const CAT = { origin: '产地', process: '处理法', roast: '烘焙', sensory: '感官', event: '活动' };
async function glossaryPage(view) {
  const terms = await API.get('/api/terms');
  const groups = {};
  for (const t of terms) (groups[t.category] ||= []).push(t);
  view.innerHTML = `
    <h1>术语表</h1>
    <p class="meta">产地页与处理法页引用同一套术语；与测量方法相关的术语特别说明了为什么不同口径不能直接比较。</p>
    ${Object.entries(groups).map(([cat, list]) => `
      <h2 class="section-title"><span class="num">${esc(CAT[cat] || cat)}</span></h2>
      <div class="grid cols-2">
        ${list.map((t) => `<div class="card"><h3>${esc(t.term)} <span class="meta">${esc(t.slug)}</span></h3>
          <p>${esc(t.definition)}</p>${(t.see_also || []).length ? `<div class="meta">另见：${t.see_also.map(esc).join('、')}</div>` : ''}
        </div>`).join('')}
      </div>`).join('')}`;
}
