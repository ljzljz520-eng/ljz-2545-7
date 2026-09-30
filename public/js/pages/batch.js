const batchCharts = [];
async function batchPage(view, id) {
  batchCharts.forEach((c) => c.destroy()); batchCharts.length = 0;
  const d = await API.get('/api/batches/' + id);
  const b = d.batch;
  const withdrawn = b.status === 'withdrawn';
  view.innerHTML = `
    ${backLink(b.product_id ? `#/product/${b.product_id}` : '#/products')}
    <h1>批次 ${esc(b.code)} ${statusTag(b.status)}</h1>
    ${withdrawn ? `<div class="callout bad">该批次已撤回/下架：本页为<b>只读历史档案</b>，旧链接保留可访问；曲线与评语不删除，下载仍可追溯原始数据。</div>` : ''}
    <div class="two-col">
      <div class="card">
        <h3>批次信息</h3>
        ${kv([
          ['豆款', b.brand ? `${esc(b.brand)} / ${esc(b.product_name)}` : '—'],
          ['产地', b.origin_slug ? `<a href="#/origin/${b.origin_slug}">${esc(b.origin_name)}</a>` : '—'],
          ['处理法', b.process_slug ? `<a href="#/process/${b.process_slug}">${esc(b.process_name)}</a>` : '—'],
          ['烘焙日期', fmtDate(b.roast_date)], ['烘焙师/机器', `${esc(b.roaster)} / ${esc(b.machine)}`],
          ['重量', `${b.weight_in_g ?? '?'}g → ${b.weight_out_g ?? '?'}g`],
        ])}
        <button class="btn ghost small" id="lineageBtn">查看谱系</button>
        <div id="lineageBox"></div>
        ${b.story ? `<p class="meta">${esc(b.story)}</p>` : ''}
      </div>
      <div class="card">
        <h3>感官评语</h3>
        <div class="callout">评语自带量表；不同量表（百分制/5分制/10分制）<b>不混合排名</b>。</div>
        ${d.sensory.length ? d.sensory.map((s) => `
          <div style="border-bottom:1px solid var(--line);padding:8px 0">
            <b>${s.score}</b> <span class="tag">${esc(s.scale_code)} (${s.min_score}–${s.max_score})</span>
            <span class="meta">${esc(s.cupper)} · ${fmtDate(s.evaluated_on)}</span>
            <div>${tags(s.flavor_tags || [])}</div>
            <div class="meta">${esc(s.notes)}</div>
          </div>`).join('') : '<p class="meta">暂无评语</p>'}
      </div>
    </div>
    <h2 class="section-title"><span class="num">↗</span>烘焙曲线（${d.curves.length}）</h2>
    <div class="callout">时间零点/探头/采样间隔以<b>每条曲线自己的测量元数据</b>为准；下方逐图独立展示，避免误读为同一口径。</div>
    <div class="grid">
      ${d.curves.map((c) => `
      <div class="card">
        <h3>${esc(c.source_filename || c.filename)} ${statusTag(c.review_status)}
          ${c.is_late ? '<span class="tag warn">晚到补录</span>' : ''}</h3>
        ${kv([
          ['温度探头', `${esc(c.probe_type)} / ${esc(c.probe_position || '未标注')}`],
          ['采样间隔', `${c.sampling_interval_s} s`],
          ['时间零点', tzLabel(c.time_zero)],
          ['温度单位', '°' + c.temp_unit],
          ['点数/时长', `${c.point_count} 点 / ${c.duration_s}s`],
          ['最长缺测', `${c.max_gap_samples} 个连续点`],
          ['提交/收到', `${fmtDT(c.submitted_at)} / ${fmtDT(c.received_at)}`],
        ])}
        ${c.max_gap_samples > 2 ? `<div class="callout bad">存在 ${c.max_gap_samples} 点连续缺测（长缺测）：图中保留空段，不做填补，不参与逐点比较。</div>` : ''}
        ${c.range_check && c.range_check.suspicious ? `<div class="callout bad">量纲可疑：数值范围 ${c.range_check.minC}–${c.range_check.maxC}（声明 °${c.temp_unit}）</div>` : ''}
        ${c.reject_reason ? `<div class="callout bad">验收问题：${esc(c.reject_reason)}</div>` : ''}
        <div class="chart-wrap"><canvas id="chart-${c.id}" style="width:100%;height:280px"></canvas></div>
        <a class="btn ghost small" href="/api/curves/${c.id}/download">下载原始 CSV（含 sha256/元数据响应头）</a>
        <span class="meta">sha256:${c.sha256.slice(0, 16)}…</span>
      </div>`).join('')}
    </div>`;

  document.getElementById('lineageBtn').onclick = async () => {
    const l = await API.get(`/api/batches/${id}/lineage`).catch(() => null);
    const box = document.getElementById('lineageBox');
    if (!l) { box.innerHTML = '<p class="meta">谱系（后台数据，需登录后查看）</p>'; return; }
    box.innerHTML = `<div class="flow" style="margin-top:8px">
      ${l.ancestors.map((x) => `<a class="step" href="#/batch/${x.id}">${esc(x.code)}</a><span class="arrow">→</span>`).join('')}
      <span class="step" style="background:var(--crema)"><b>${esc(l.root.code)}</b></span>
      ${l.descendants.map((x) => `<span class="arrow">→</span><a class="step" href="#/batch/${x.id}">${esc(x.code)}</a>`).join('')}
    </div>`;
  };

  for (const c of d.curves) {
    const pts = await API.get(`/api/curves/${c.id}/points`);
    const chart = new CurveChart(document.getElementById('chart-' + c.id), {});
    const cols = pts.columns;
    const palette = { et_c: '#b3382f', bt_c: '#7a4b26', temp_c: '#2e5d7d' };
    chart.setData(cols.map((col) => ({
      name: col, color: palette[col] || '#7a4b26', points: pts.points, cols: [col],
    })), { zeroLabel: tzLabel(c.time_zero) });
    batchCharts.push(chart);
  }
}
