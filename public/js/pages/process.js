async function processPage(view, slug) {
  const d = await API.get('/api/processes/' + encodeURIComponent(slug));
  view.innerHTML = `
    ${backLink('#/')}
    <section class="hero" style="padding:26px 30px">
      <h1>${esc(d.process.name)} <small style="font-size:16px;opacity:.8">${esc(d.process.full_name || '')}</small></h1>
      <p>${esc(d.process.description)}</p>
    </section>
    <div class="two-col">
      <div>
        <h2>采用该处理法的产地</h2>
        <div class="grid">
          ${d.origins.map((o) => card(`
            <h3>${esc(o.name)} <span class="meta">${esc(o.country)}</span></h3>
            <p class="meta">${esc(o.note || '')}</p>
            <a href="#/origin/${o.slug}">查看产地 →</a>`)).join('') || '<p class="meta">暂无</p>'}
        </div>
        <h2>相关术语</h2>
        <div>${d.terms.map((t) => `<a class="tag term" href="#/glossary">${esc(t.term)}</a>`).join('')}</div>
      </div>
      <div>
        <h2>相关活动</h2>
        <div class="grid">${(d.events||[]).map((e) => `<a class="card link" href="#/event/${e.id}"><h3>${esc(e.title)}</h3>
          <div class="meta">${fmtDT(e.held_on)} · ${esc(e.location)}</div></a>`).join('') || '<p class="meta">近期暂无关联活动</p>'}</div>
        <h2>批次曲线</h2>
        <div class="grid">
          ${d.batches.map((b) => card(`
            <h3>${esc(b.code)} ${statusTag(b.status)}</h3>
            <div class="meta">${esc(b.brand || '')} ${esc(b.product_name || '')} · ${fmtDate(b.roast_date)}</div>
            <a href="#/batch/${b.id}">查看曲线 →</a>`)).join('') || '<p class="meta">当前没有已发布批次</p>'}
        </div>
      </div>
    </div>`;
}
