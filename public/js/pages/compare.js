let compareChart = null;
async function comparePage(view) {
  const [batches, products] = await Promise.all([API.get('/api/admin/batches').catch(() => null), API.get('/api/products')]);
  // 未登录时用产品下的批次（公开接口）——改为管理员接口可选；这里公开比较台只列 published，用 /api/products 组装
  let batchOpts = batches;
  if (!batchOpts) {
    const all = await Promise.all(products.map((p) => API.get('/api/products/' + p.id)));
    batchOpts = all.flatMap((d) => d.batches.map((b) => ({ ...b, brand: d.product.brand, product_name: d.product.name })));
  }
  const sel = new URLSearchParams(location.hash.split('?')[1] || '');
  view.innerHTML = `
    <h1>曲线比较台</h1>
    <div class="callout">比较结果不是“谁分数高”。系统先做<b>可比条件检查</b>：温度探头（类型/位置）、采样间隔（容差 10%）、
      时间零点、温度单位全部一致才可逐点比较；长缺测区间保留空段不参与比较；感官评分按量表分组。</div>
    <div class="card">
      <div class="pill-nav">
        <button data-mode="batch" class="on">按批次筛选</button>
        <button data-mode="product">按豆款汇总</button>
      </div>
      <div id="modePane"></div>
    </div>
    <div id="compareResult"></div>`;
  let mode = 'batch';
  const picked = new Set();
  function renderMode() {
    const pane = document.getElementById('modePane');
    if (mode === 'batch') {
      pane.innerHTML = `
        <p class="meta">选择 ≥2 个批次（下架批次也可选，用于历史对照，但会单独标识）：</p>
        <div class="grid cols-3">
          ${batchOpts.map((b) => `<label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;color:var(--ink)">
            <input type="checkbox" style="width:auto" value="${b.id}" data-batch="${b.id}">
            <span><b>${esc(b.code)}</b> ${statusTag(b.status)}<br><span class="meta">${esc(b.brand)} ${esc(b.product_name)}</span></span></label>`).join('')}
        </div>
        <button class="btn" id="runBtn">比较所选批次</button>
        <button class="btn ghost" id="sensoryBtn">只比感官评分</button>`;
    } else {
      pane.innerHTML = `
        <p class="meta">选择 ≥2 个豆款；每款按其全部批次曲线逐对比对，并提示同名不同批问题：</p>
        <div class="grid cols-3">
          ${products.map((p) => `<label style="display:flex;gap:8px;font-size:13px;color:var(--ink)">
            <input type="checkbox" style="width:auto" value="${p.id}" data-prod="${p.id}">
            <span><b>${esc(p.brand)}</b> ${esc(p.name)}</span></label>`).join('')}
        </div>
        <button class="btn" id="runBtn">按豆款汇总比较</button>`;
    }
    pane.querySelectorAll('button[data-mode]').forEach((btn) => btn.onclick = () => {
      mode = btn.dataset.mode;
      document.querySelectorAll('button[data-mode]').forEach((x) => x.classList.toggle('on', x === btn));
      renderMode();
    });
    pane.querySelector('#runBtn').onclick = () => runCompare(mode);
    const sb = pane.querySelector('#sensoryBtn');
    if (sb) sb.onclick = runSensory;
  }
  renderMode();

  async function runCompare(m) {
    const ids = [...document.querySelectorAll(m === 'batch' ? 'input[data-batch]:checked' : 'input[data-prod]:checked')]
      .map((x) => x.value);
    if (ids.length < 2) return toast('请至少选择 2 项', true);
    const url = `/api/compare?mode=${m}&ids=${ids.join(',')}`;
    const data = await API.get(url);
    const box = document.getElementById('compareResult');
    box.innerHTML = renderResult(data) + `<div class="chart-wrap"><canvas id="cmpChart" style="width:100%;height:360px"></canvas>
      <div class="chart-legend" id="cmpLegend"></div></div>
      <div id="sensoryZone"></div>`;
    // 叠加曲线（仅取各对象第一条曲线用于可视化）
    compareChart?.destroy();
    const palette = ['#7a4b26', '#2e5d7d', '#b3382f', '#2e7d4f', '#8a5cf0', '#c77f18'];
    const series = [];
    let zeroSet = new Set();
    const targets = m === 'batch' ? data.items : data.groups.flatMap((g) => g.curves.slice(0, 1));
    let ci = 0;
    for (const it of targets) {
      const curveId = it.curve_id;
      try {
        const pts = await API.get(`/api/curves/${curveId}/points`);
        zeroSet.add(pts.curve.time_zero);
        const color = palette[ci++ % palette.length];
        series.push({ name: it.batch_code, color, points: pts.points, cols: pts.columns.includes('bt_c') ? ['bt_c'] : ['temp_c'] });
      } catch { /* 无曲线忽略 */ }
    }
    compareChart = new CurveChart(document.getElementById('cmpChart'), {});
    compareChart.setData(series, {
      zeroLabel: zeroSet.size === 1 ? tzLabel([...zeroSet][0]) : '⚠ 多个零点',
      zeroWarning: zeroSet.size > 1,
    });
    document.getElementById('cmpLegend').innerHTML = series.map((s) =>
      `<span><i style="border-color:${s.color};color:${s.color}"></i>${esc(s.name)}</span>`).join('');
    // 感官区按钮
    const batchIds = m === 'batch' ? data.items.map((x) => x.batch_id)
      : [...new Set(data.groups.flatMap((g) => g.curves.map((c) => c.batch_id)))];
    document.getElementById('sensoryZone').innerHTML =
      `<p><button class="btn ghost" id="sensoryBtn2">查看这些批次的感官评分（分量表）</button></p>`;
    document.getElementById('sensoryBtn2').onclick = async () => {
      const d2 = await API.get('/api/compare/sensory?batches=' + batchIds.join(','));
      document.getElementById('sensoryZone').innerHTML = renderSensory(d2);
    };
  }

  async function runSensory() {
    const ids = [...document.querySelectorAll('input[data-batch]:checked')].map((x) => x.value);
    if (ids.length < 2) return toast('请至少选择 2 个批次', true);
    const d = await API.get('/api/compare/sensory?batches=' + ids.join(','));
    document.getElementById('compareResult').innerHTML = renderSensory(d);
  }
}

function renderResult(data) {
  if (data.mode === 'batch') {
    return `
      <h2 class="section-title"><span class="num">✓</span>测量条件概览</h2>
      <div class="grid cols-2">${data.items.map((it) => `
        <div class="card">
          <h3>${esc(it.batch_code)} ${statusTag(it.status)}</h3>
          <div class="meta">${esc(it.brand)} ${esc(it.product_name)}</div>
          ${kv([
            ['探头', `${esc(it.probe_type)} / ${esc(it.probe_position)}`],
            ['采样间隔', it.sampling_interval_s + ' s'],
            ['时间零点', tzLabel(it.time_zero)],
            ['单位', '°' + it.temp_unit],
            ['最长缺测', it.max_gap_samples + ' 点'],
          ])}
        </div>`).join('')}
      </div>
      <h2 class="section-title"><span class="num">⚖</span>两两可比检查（${data.pairs.length} 对）</h2>
      ${data.pairs.map(renderPair).join('')}
      ${data.notes.length ? `<div class="callout">${data.notes.map(esc).join('<br>')}</div>` : ''}
      <div class="callout">叠加图说明：时间零点一致时可视觉对照；零点不同时图顶部有警告，仅作形状浏览，不可读具体时刻差值。</div>`;
  }
  // product mode
  return `
    <h2 class="section-title"><span class="num">📦</span>按豆款汇总（曲线仍按原批次分组）</h2>
    <div class="grid cols-2">${data.groups.map((g) => `
      <div class="card">
        <h3>${esc(g.brand)} · ${esc(g.product_name)}</h3>
        <div class="meta">涉及 ${g.batch_count} 个批次</div>
        <table><tr><th>批次</th><th>探头</th><th>间隔</th><th>零点</th><th>状态</th></tr>
        ${g.curves.map((c) => `<tr><td><a href="#/batch/${c.batch_id}">${esc(c.batch_code)}</a></td>
          <td>${esc(c.probe_type)}</td><td>${c.sampling_interval_s}s</td>
          <td>${tzLabel(c.time_zero)}</td><td>${statusTag(c.status)}</td></tr>`).join('')}
        </table>
      </div>`).join('')}
    </div>
    <h2 class="section-title"><span class="num">⚖</span>跨款批对批检查</h2>
    ${data.pairs.map(renderPair).join('')}
    <div class="callout warn">按产品汇总不是把所有曲线平均：同名同品牌换批后的曲线仍绑定原批，比较落到“批对批”，避免把品牌同名当成实验条件相同。</div>
    ${data.notes.length ? `<div class="callout">${data.notes.map(esc).join('<br>')}</div>` : ''}`;
}

function renderPair(pr) {
  const verdictText = { comparable: '可比', incomparable: '不可比', comparable_with_gaps: '有限可比（缺测区间不比较）' }[pr.verdict];
  return `<div class="card" style="margin:10px 0">
    <h3>${esc(pr.a)} <span class="meta">vs</span> ${esc(pr.b)}
      <span class="badge-verdict verdict-${pr.verdict}">${verdictText}</span>
      ${pr.product_a ? `<div class="meta" style="font-weight:400">${esc(pr.product_a)} ↔ ${esc(pr.product_b)}</div>` : ''}
    </h3>
    <ul class="checklist">
      ${pr.checks.map((c) => `<li class="${c.ok ? 'ok' : c.severity === 'partial' ? 'partial' : 'fail'}">
        <span class="mark">${c.ok ? '✅' : c.severity === 'partial' ? '⚠️' : '⛔'}</span>
        <span><b>${esc(c.label)}</b>：${esc(c.detail)}</span></li>`).join('')}
    </ul>
    ${pr.verdict === 'incomparable' ? '<div class="callout bad">不可比项解释：硬性条件（探头/采样/零点/单位）不一致，系统不对曲线做逐点差值或排名；如确需对照，只能并列查看并保留各自元数据。</div>' : ''}
    ${pr.verdict === 'comparable_with_gaps' ? '<div class="callout">仅连续 ≤2 点的缺口做虚线插值（仅显示），长缺测段在统计与比较中排除。</div>' : ''}
  </div>`;
}

function renderSensory(d) {
  return `<h2 class="section-title"><span class="num">☕</span>感官评分（按量表分组）</h2>
    <div class="callout ${d.ranking_allowed ? 'ok' : 'bad'}">${esc(d.explanation)}</div>
    ${d.groups.map((g) => `
      <div class="card" style="margin:12px 0">
        <h3>${esc(g.code)} · ${esc(g.name)} <span class="tag">范围 ${g.min_score}–${g.max_score}</span></h3>
        <table><tr><th>排名(组内)</th><th>批次</th><th>原始分</th><th>归一化</th><th>评语</th><th>风味</th><th>评审</th></tr>
        ${g.rankings.map((r, i) => `<tr><td>${i + 1}</td>
          <td><a href="#/batch/${r.batch_id}">${esc(r.batch_code)}</a></td>
          <td><b>${r.score}</b></td><td>${(r.normalized * 100).toFixed(0)} / 100</td>
          <td>${esc(r.notes || '')}</td><td>${tags(r.flavor_tags || [])}</td>
          <td class="meta">${esc(r.cupper)}</td></tr>`).join('')}
        </table>
      </div>`).join('')}
    <div class="callout">禁止把 SCA 百分制与 5 分/10 分制直接混排；归一化仅用于同表内直观参考，不改变“不同量表不排名”的原则。</div>`;
}
