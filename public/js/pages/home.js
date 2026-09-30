async function homePage(view) {
  const [origins, processes, terms, products] = await Promise.all([
    API.get('/api/origins'), API.get('/api/processes'),
    API.get('/api/terms'), API.get('/api/products'),
  ]);
  view.innerHTML = `
  <section class="hero">
    <h1>从产地到一爆，每个批次都有可追溯的曲线</h1>
    <p>这里把产地故事、处理法术语、烘焙批次谱系与烘焙曲线串在一起。曲线原始文件独立内容存储；
       当探头、采样间隔或时间零点不一致时，系统会明确标识“不可比”，而不是硬把它们排在一起。</p>
  </section>
  <h2 class="section-title"><span class="num">1</span>产地</h2>
  <div class="grid cols-3">
    ${origins.map((o) => card(`
      <h3>🗺 ${esc(o.name)} <span class="meta">${esc(o.country)}</span></h3>
      <div>${tags([o.region])}</div>
      <p>${esc(o.story)}</p>
      <p class="meta">海拔 ${o.altitude_min_m}–${o.altitude_max_m} m</p>
    `, `#/origin/${o.slug}`)).join('')}
  </div>
  <h2 class="section-title"><span class="num">2</span>处理法</h2>
  <div class="grid cols-3">
    ${processes.map((p) => card(`
      <h3>⚗ ${esc(p.name)} <span class="meta">${esc(p.full_name || '')}</span></h3>
      <p>${esc(p.description)}</p>
    `, `#/process/${p.slug}`)).join('')}
  </div>
  <h2 class="section-title"><span class="num">3</span>浏览方式</h2>
  <div class="grid cols-2">
    ${card(`<h3>📈 曲线比较与可比条件检查</h3>
      <p>按批次筛选或按豆款汇总，系统逐项核对温度探头、采样间隔、时间零点、温度单位与缺测情况，
      并对不可比项给出解释；感官评分按量表分组，不跨量表排名。</p>
      <a class="btn" href="#/compare">前往比较台</a>`, '#/compare')}
    ${card(`<h3>🛠 后台批次管理</h3>
      <p>维护批次谱系、提交/验收曲线（量纲错误拦截、晚到补录）、录入感官评语、发布与撤回，
      撤回后活动报名转“待确认”而非静默取消。</p>
      <a class="btn ghost" href="#/admin">进入后台</a> <span class="meta">演示账号 admin / roast2026</span>`, '#/admin')}
  </div>`;
}
