async function productsPage(view) {
  const ps = await API.get('/api/products');
  view.innerHTML = `
    <h1>豆款与批次</h1>
    <div class="callout">豆款换批后，<b>旧曲线永远绑定原批次</b>；品牌同名不等于实验条件相同——
    比较时仍以每批的探头、采样间隔、时间零点元数据为准。</div>
    <div class="grid cols-2">
      ${ps.map((p) => card(`
        <h3>${esc(p.brand)} · ${esc(p.name)}</h3>
        <p class="meta">${esc(p.description)}</p>
        <div>当前批次：${p.current_batch_code ? `<b>${esc(p.current_batch_code)}</b>` : '<span class="status-withdrawn">无在售批</span>'}</div>
        <a href="#/product/${p.id}">查看全部批次谱系 →</a>`)).join('')}
    </div>`;
}

async function productPage(view, id) {
  const d = await API.get('/api/products/' + id);
  view.innerHTML = `
    ${backLink('#/products')}
    <h1>${esc(d.product.brand)} · ${esc(d.product.name)}</h1>
    <p class="meta">${esc(d.product.description)}</p>
    <div class="flow">
      ${d.batches.map((b, i) => `${i ? '<span class="arrow">→</span>' : ''}
        <a class="step" href="#/batch/${b.id}">${esc(b.code)} ${statusTag(b.status)}
        <br><span class="meta">已验收曲线 ×${b.accepted_curves} · ${fmtDate(b.roast_date)}</span></a>`).join('')}
    </div>
    <div class="grid cols-2" style="margin-top:16px">
      ${d.batches.map((b) => card(`
        <h3>${esc(b.code)} ${statusTag(b.status)}${b.parent_id ? ' <span class="tag">换批/迭代</span>' : ' <span class="tag">首批</span>'}</h3>
        ${kv([
          ['烘焙日期', fmtDate(b.roast_date)],
          ['烘焙师', esc(b.roaster)],
          ['机器', esc(b.machine)],
          ['收得率', b.weight_in_g && b.weight_out_g ? ((b.weight_out_g / b.weight_in_g) * 100).toFixed(1) + '%' : '—'],
          ['谱系备注', esc(b.lineage_note || '—')],
        ])}
        ${b.story ? `<p class="meta">${esc(b.story)}</p>` : ''}
        <a href="#/batch/${b.id}">进入批次（曲线/评语） →</a>`)).join('')}
    </div>`;
}
