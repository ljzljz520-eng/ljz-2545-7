async function originPage(view, slug) {
  const d = await API.get('/api/origins/' + encodeURIComponent(slug));
  view.innerHTML = `
    ${backLink('#/')}
    <section class="hero" style="padding:26px 30px">
      <h1>${esc(d.origin.name)} <small style="font-size:16px;opacity:.8">${esc(d.origin.country)} · ${esc(d.origin.region || '')}</small></h1>
      <p>${esc(d.origin.story)}</p>
      <div class="meta" style="color:#e7d3ae">海拔 ${d.origin.altitude_min_m}–${d.origin.altitude_max_m} m</div>
    </section>
    <div class="two-col">
      <div>
        <h2>当地处理法</h2>
        <div class="grid">
          ${d.processes.map((p) => card(`
            <h3>${esc(p.name)} <span class="meta">${esc(p.full_name || '')}</span></h3>
            <p class="meta">${esc(p.note || '')}</p>
            <p>${esc(p.description)}</p>
            <a href="#/process/${p.slug}">查看处理法 →</a>`)).join('') || '<p class="meta">暂无</p>'}
        </div>
        <h2>相关术语</h2>
        <div>${d.terms.map((t) => `<a class="tag term" href="#/glossary">${esc(t.term)}</a>`).join('') || '<span class="meta">暂无</span>'}</div>
      </div>
      <div>
        <h2>相关活动</h2>
        <div class="grid">${(d.events||[]).map((e) => `<a class="card link" href="#/event/${e.id}"><h3>${esc(e.title)}</h3>
          <div class="meta">${fmtDT(e.held_on)} · ${esc(e.location)}</div></a>`).join('') || '<p class="meta">近期暂无关联活动</p>'}</div>
        <h2>在售批次曲线</h2>
        <div class="grid">
          ${d.batches.map((b) => card(`
            <h3>${esc(b.code)} ${statusTag(b.status)}</h3>
            <div class="meta">${esc(b.brand || '')} ${esc(b.product_name || '')} · ${esc(b.roaster || '')} · ${fmtDate(b.roast_date)}</div>
            <p>${esc(b.story || '')}</p>
            <a href="#/batch/${b.id}">查看曲线与感官评语 →</a>`)).join('') || '<p class="meta">当前没有已发布批次</p>'}
        </div>
      </div>
    </div>`;
}
