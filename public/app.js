'use strict';
/* 山脊烘焙故事站 · 前端（无框架，hash 路由 + 原生 SVG 绘图） */

const app = document.getElementById('app');
const COLORS = ['#9c3b2e', '#3f5e8c', '#4f6b45', '#b5782b', '#7a4a8b', '#2f7e7b', '#c25b30'];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
}
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body instanceof FormData ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const msg = (data && (data.error || JSON.stringify(data))) || ('HTTP ' + res.status);
    const err = new Error(msg);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}
function fmtDate(v) { if (!v) return '—'; return String(v).slice(0, 10); }
function esc(s) { return h('span').appendChild(document.createTextNode(s == null ? '' : String(s))).parentNode.textContent; }
function paragraphs(text) {
  return String(text || '').split(/\n+/).filter(Boolean).map((p) => h('p', {}, p));
}
function statusBadge(s) { return h('span', { class: 'badge ' + s }, { draft: '草稿', published: '已发布', delisted: '已下架' }[s] || s); }
function regStatus(s) {
  return { confirmed: '已确认', pending: '待确认', pending_confirmation: '需确认', cancelled: '已取消' }[s] || s;
}

/* ================= SVG 曲线图 ================= */
function drawCurves(chart, { small = false } = {}) {
  const W = small ? 460 : 920, H = small ? 220 : 400;
  const pad = { l: 56, r: 18, t: 18, b: 40 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const grid = chart.grid;
  let yMin = Infinity, yMax = -Infinity;
  chart.series.forEach((s) => s.values.forEach((v) => { if (v !== null) { yMin = Math.min(yMin, v); yMax = Math.max(yMax, v); } }));
  if (!isFinite(yMin)) { yMin = 0; yMax = 100; }
  yMin -= 3; yMax += 3;
  const xAt = (t) => pad.l + ((t - grid[0]) / (grid[grid.length - 1] - grid[0] || 1)) * iw;
  const yAt = (v) => pad.t + ih - ((v - yMin) / (yMax - yMin || 1)) * ih;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  const NS = 'http://www.w3.org/2000/svg';
  const add = (name, attrs, parent = svg) => {
    const e = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    parent.appendChild(e);
    return e;
  };
  // 网格与轴
  for (let i = 0; i <= 5; i++) {
    const y = pad.t + (ih / 5) * i;
    add('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, stroke: '#e6dccb', 'stroke-width': 1 });
    const val = yMax - ((yMax - yMin) / 5) * i;
    const t = add('text', { x: pad.l - 8, y: y + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#7d6b5c' });
    t.textContent = val.toFixed(1);
  }
  const ticks = Math.min(8, grid.length - 1);
  for (let i = 0; i <= ticks; i++) {
    const idx = Math.round((grid.length - 1) * (i / ticks));
    const x = xAt(grid[idx]);
    const t = add('text', { x, y: H - 12, 'text-anchor': 'middle', 'font-size': 11, fill: '#7d6b5c' });
    t.textContent = grid[idx] + 's';
  }
  const ax = add('text', { x: pad.l + iw / 2, y: H - 0, 'text-anchor': 'middle', 'font-size': 12, fill: '#4a3528' });
  ax.textContent = `相对“${timeZeroLabel(chart.time_zero)}”的时间（秒）`;
  const ay = add('text', { x: 14, y: pad.t + ih / 2, 'text-anchor': 'middle', 'font-size': 12, fill: '#4a3528',
    transform: `rotate(-90 14 ${pad.t + ih / 2})` });
  ay.textContent = '豆温 (°C，统一量纲)';

  // 曲线按段绘制，长缺口天然断开
  chart.series.forEach((s, si) => {
    const color = COLORS[si % COLORS.length];
    s.segments.forEach(([a, b]) => {
      let d = '';
      for (let i = a; i <= b; i++) {
        if (s.values[i] === null) continue;
        d += (d ? 'L' : 'M') + xAt(grid[i]).toFixed(1) + ',' + yAt(s.values[i]).toFixed(1) + ' ';
      }
      add('path', { d, fill: 'none', stroke: color, 'stroke-width': 2.2, 'stroke-linejoin': 'round' });
    });
  });
  const legend = h('div', { class: 'chart-legend' },
    chart.series.map((s, i) => h('span', {}, h('span', { class: 'swatch', style: `background:${COLORS[i % COLORS.length]}` }), s.label)),
    chart.resampled ? h('span', { class: 'pill WARN' }, '⚠ 已重采样到公共网格（未插值）') : null,
    h('span', { class: 'muted small' }, '缺口处断线 = 长缺测不插值')
  );
  return h('div', { class: 'chart-wrap' }, svg, legend);
}

// 单条曲线（批次详情，允许展示插值点）
function drawSingleCurve(data) {
  const seriesName = Object.keys(data.series).find((k) => /bean|bt/i.test(k)) || Object.keys(data.series)[0];
  const s = data.series[seriesName];
  const unit = (s.unit || data.curve.temp_unit);
  const celsius = unit === 'F' ? s.values.map((v) => v === null ? null : (v - 32) * 5 / 9) : s.values;
  const grid = data.time;
  const chart = {
    grid, time_zero: data.curve.time_zero,
    series: [{
      label: `${seriesName} (${unit}→°C)`,
      values: celsius,
      segments: cSegments(celsius),
    }],
  };
  const wrap = drawCurves(chart, { small: false });
  // 插值点叠加小圆点
  const svgEl = wrap.querySelector('svg');
  const NS = 'http://www.w3.org/2000/svg';
  const pad = { l: 56, r: 18, t: 18, b: 40 }, W = 920, H = 400;
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  let yMin = Math.min(...celsius.filter((v) => v !== null)) - 3, yMax = Math.max(...celsius.filter((v) => v !== null)) + 3;
  const xAt = (t) => pad.l + ((t - grid[0]) / (grid[grid.length - 1] - grid[0] || 1)) * iw;
  const yAt = (v) => pad.t + ih - ((v - yMin) / (yMax - yMin)) * ih;
  s.filled.forEach((i) => {
    if (celsius[i] === null) return;
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', xAt(grid[i])); c.setAttribute('cy', yAt(celsius[i])); c.setAttribute('r', 3.2);
    c.setAttribute('fill', '#fff'); c.setAttribute('stroke', '#9c3b2e'); c.setAttribute('stroke-width', 1.6);
    svgEl.appendChild(c);
  });
  wrap.appendChild(h('div', { class: 'chart-legend' },
    h('span', {}, h('span', { class: 'swatch', style: 'background:#9c3b2e' }), seriesName),
    h('span', { class: 'pill WARN' }, '○ 空心点 = 短缺口(≤2点)展示插值，不作为原始数据'),
  ));
  return wrap;
}
function cSegments(values) {
  const segs = []; let i = 0;
  while (i < values.length) {
    if (values[i] === null) { i++; continue; }
    let j = i; while (j < values.length && values[j] !== null) j++;
    segs.push([i, j - 1]); i = j;
  }
  return segs;
}
function timeZeroLabel(z) {
  return { charge: '下锅', turning_point: '回温点', first_crack_start: '一爆开始', roast_start: '烘焙开始', other: '其他' }[z] || z;
}

/* ================= 路由 ================= */
const routes = {};
function route(path, fn) { routes[path] = fn; }
async function render() {
  const hash = location.hash.slice(1) || '/';
  document.querySelectorAll('#nav a').forEach((a) => {
    const target = a.getAttribute('href').slice(1);
    a.classList.toggle('active', target !== '/' && hash.startsWith(target));
  });
  app.innerHTML = '';
  app.appendChild(h('div', { class: 'loading' }, '正在加载…'));
  const fn = matchRoute(hash);
  try { await fn(); } catch (e) {
    app.innerHTML = '';
    app.appendChild(h('div', { class: 'notice block' }, '出错了：' + e.message));
  }
  window.scrollTo(0, 0);
}
function matchRoute(hash) {
  for (const [pat, fn] of Object.entries(routes)) {
    const m = hashMatch(pat, hash);
    if (m) return () => fn(m);
  }
  return routes['/404'];
}
function hashMatch(pat, hash) {
  const pp = pat.split('/').filter(Boolean), hh = hash.split('?')[0].split('/').filter(Boolean);
  if (pp.length !== hh.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) params[pp[i].slice(1)] = decodeURIComponent(hh[i]);
    else if (pp[i] !== hh[i]) return null;
  }
  const q = {};
  (hash.split('?')[1] || '').split('&').filter(Boolean).forEach((kv) => {
    const [k, v] = kv.split('='); q[k] = decodeURIComponent(v || '');
  });
  return { params, query: q };
}
window.addEventListener('hashchange', render);

/* ================= 页面：首页 ================= */
route('/', async () => {
  const cat = await api('/api/catalog');
  const hero = h('div', { class: 'hero' },
    h('h1', {}, '每一支豆子，都有一条可追溯的曲线'),
    h('p', {}, '我们把产地故事、处理法、批次谱系、烘焙曲线测量条件与杯测评语完整公开。换批不换名，但数据不混；不同探头与时间零点的曲线，绝不叠在一起糊弄排名。'),
    h('div', { class: 'hero-meta' },
      h('span', {}, h('b', {}, String(cat.origins.length)), '个产地'),
      h('span', {}, h('b', {}, String(cat.processes.length)), '种处理法'),
      h('span', {}, h('b', {}, String(cat.products.length)), '款豆款'),
      h('span', {}, h('b', {}, String(cat.events.length)), '场开放活动'),
    )
  );
  const card = (href, title, sub, body) => h('a', { class: 'card linked', href },
    h('h3', {}, title), h('div', { class: 'meta' }, sub), body ? h('div', { style: 'margin-top:8px' }, body) : null);

  app.innerHTML = '';
  app.append(
    hero,
    h('h2', {}, '产地故事'),
    h('div', { class: 'grid cols-3' }, cat.origins.map((o) => card(`#/origins/${o.slug}`, o.name, `${o.country} · ${o.region || ''}`,
      h('span', { class: 'tag origin' }, o.altitude_m || '海拔—')))),
    h('h2', {}, '处理法'),
    h('div', { class: 'grid cols-3' }, cat.processes.map((p) => card(`#/processes/${p.slug}`, p.name, p.category,
      h('span', { class: 'tag process' }, '查看关联批次与术语')))),
    h('h2', {}, '豆款（按批次管理）'),
    h('div', { class: 'grid cols-3' }, cat.products.map((p) => card(`#/products/${p.slug}`, `${p.brand} · ${p.name}`,
      `${p.published_batches} 个已发布批次`, h('span', { class: 'tag roast' }, '同名≠同条件，逐批查看')))),
    h('h2', {}, '近期活动'),
    h('div', { class: 'grid cols-2' }, cat.events.length
      ? cat.events.map((e) => card(`#/events/${e.slug}`, e.title, fmtDate(e.starts_at),
        h('span', { class: 'tag sensory' }, `名额 ${e.capacity}`)))
      : [h('div', { class: 'card muted' }, '暂无开放活动')]),
  );
});

/* ================= 列表页 ================= */
route('/origins', async () => {
  const cat = await api('/api/catalog');
  app.innerHTML = '';
  app.append(h('h1', {}, '产地'), p('每个产地页关联：在该地产出的批次曲线、相关术语、以及使用这些批次的杯测活动。'),
    h('div', { class: 'grid cols-3' }, cat.origins.map((o) => h('a', { class: 'card linked', href: `#/origins/${o.slug}` },
      h('h3', {}, o.name), h('div', { class: 'meta' }, `${o.country} · ${o.region || ''}`),
      h('p', { class: 'small' }, o.story)))));
});
route('/processes', async () => {
  const cat = await api('/api/catalog');
  app.innerHTML = '';
  app.append(h('h1', {}, '处理法'), p('处理法页面同样关联批次曲线、术语与活动；同一处理法在不同批次的发酵参数可能完全不同。'),
    h('div', { class: 'grid cols-3' }, cat.processes.map((x) => h('a', { class: 'card linked', href: `#/processes/${x.slug}` },
      h('h3', {}, x.name), h('div', { class: 'meta' }, x.category), h('p', { class: 'small' }, x.description)))));
});
function p(t) { return h('p', { class: 'page-sub' }, t); }

/* ================= 产地/处理法详情 ================= */
route('/origins/:slug', async ({ params }) => {
  const d = await api(`/api/origins/${params.slug}`);
  app.innerHTML = '';
  app.append(
    h('h1', {}, d.origin.name),
    h('div', { class: 'meta-strip' },
      h('span', {}, h('b', {}, d.origin.country), ' · ', d.origin.region || '—'),
      h('span', {}, '海拔 ', h('b', {}, d.origin.altitude_m || '—'))),
    ...paragraphs(d.origin.story),
    linkedSection('该产地的批次与曲线', d.batches.map(batchListRow)),
    termSection(d.terms),
    eventSection(d.events),
  );
});
route('/processes/:slug', async ({ params }) => {
  const d = await api(`/api/processes/${params.slug}`);
  app.innerHTML = '';
  app.append(
    h('h1', {}, d.process.name), h('span', { class: 'tag process' }, d.process.category),
    ...paragraphs(d.process.description),
    linkedSection('使用该处理法的批次与曲线', d.batches.map((b) => batchListRow(b, true))),
    termSection(d.terms), eventSection(d.events),
  );
});
function batchListRow(b, isProcess = false) {
  const sub = isProcess ? `${b.origin_name || '—'}（${b.country || ''}）` : `${b.process_name || '—'} · ${b.brand || ''} ${b.name || ''}`;
  return h('a', { class: 'card linked', href: `#/batches/${b.slug}`, style: 'margin-bottom:10px' },
    h('div', { style: 'display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap' },
      h('span', {}, h('b', { class: 'mono' }, b.code), ' ', statusBadge(b.status)),
      h('span', { class: 'meta' }, sub)),
    h('div', { class: 'meta-strip' },
      h('span', {}, '产季 ', h('b', {}, b.harvest_year || '—')),
      h('span', {}, '烘焙日 ', h('b', {}, fmtDate(b.roast_date))),
      h('span', {}, '曲线 ', h('b', {}, String(b.curve_count || 0)), ' 条'),
      b.roast_level ? h('span', {}, '焙度 ', h('b', {}, b.roast_level)) : null));
}
function linkedSection(title, rows) {
  return h('div', {}, h('h2', {}, title), rows.length ? rows : h('div', { class: 'card muted' }, '暂无关联批次'));
}
function termSection(terms) {
  if (!terms || !terms.length) return null;
  return h('div', {}, h('h2', {}, '关联术语'),
    h('div', { class: 'grid cols-2' }, terms.map((t) => h('a', { class: 'card linked', href: `#/glossary?t=${t.slug}` },
      h('h3', {}, t.term), h('span', { class: 'tag ' + t.kind }, t.kind), h('p', { class: 'small muted' }, t.definition)))));
}
function eventSection(events) {
  if (!events || !events.length) return null;
  return h('div', {}, h('h2', {}, '相关活动'),
    h('div', { class: 'grid cols-2' }, events.map((e) => h('a', { class: 'card linked', href: `#/events/${e.slug}` },
      h('b', {}, e.title), h('div', { class: 'meta' }, fmtDate(e.starts_at))))));
}

/* ================= 术语表 ================= */
route('/glossary', async (ctx) => {
  const cat = await api('/api/catalog');
  const focus = ctx.query.t;
  app.innerHTML = '';
  const groups = {};
  cat.terms.forEach((t) => (groups[t.kind] ||= []).push(t));
  const kindName = { origin: '产地', process: '处理法', roasting: '烘焙', sensory: '感官', general: '通用' };
  app.append(h('h1', {}, '术语表'), p('比较前请先对齐定义——尤其是“时间零点”“升温率”与杯测量表。'));
  for (const [kind, list] of Object.entries(groups)) {
    app.append(h('h2', {}, kindName[kind] || kind),
      h('dl', { class: 'card kv-def' }, ...list.flatMap((t) => [
        h('dt', { id: 'term-' + t.slug, style: focus === t.slug ? 'background:#f7ebd5;border-radius:6px;padding:2px 6px' : '' },
          h('a', { href: `#/glossary?t=${t.slug}` }, t.term), h('span', { class: 'mono muted small', style: 'margin-left:8px' }, t.slug)),
        h('dd', {}, t.definition),
      ])));
  }
});

/* ================= 豆款详情 ================= */
route('/products/:slug', async ({ params }) => {
  const d = await api(`/api/products/${params.slug}`);
  app.innerHTML = '';
  app.append(
    h('h1', {}, `${d.product.brand} · ${d.product.name}`),
    ...paragraphs(d.product.description),
    h('div', { class: 'notice info' }, '豆款是稳定的品牌 SKU；曲线、评语与库存都挂在“批次”上。换批后旧曲线仍绑定原批，不会迁移。'),
    h('h2', {}, `全部批次（${d.batches.length}）`),
    h('div', {}, ...d.batches.map((b) => h('a', { class: 'card linked', href: `#/batches/${b.slug}`, style: 'margin-bottom:10px' },
      h('div', { style: 'display:flex;justify-content:space-between' },
        h('span', {}, h('b', { class: 'mono' }, b.code), ' ', statusBadge(b.status)),
        h('span', { class: 'meta' }, `${b.origin_name || '—'} · ${b.process_name || '—'} · ${fmtDate(b.roast_date)}`)),
      h('div', { class: 'meta-strip' },
        h('span', {}, '曲线 ', h('b', {}, String(b.curve_count)), ' 条'),
        b.demo_servings_total != null ? h('span', {}, '可演示份数 ', h('b', {}, String(b.demo_servings_total))) : null)))),
  );
});

/* ================= 批次详情 ================= */
route('/batches/:slug', async ({ params }) => {
  const d = await api(`/api/batches/${params.slug}`);
  const b = d.batch;
  app.innerHTML = '';
  const head = h('div', {},
    h('h1', {}, h('span', { class: 'mono' }, b.code), ' ', statusBadge(b.status)),
    d.delisted ? h('div', { class: 'notice block' }, '该批次已下架：页面与历史链接保留可访问，曲线与评语不再出现在新的比较/活动候选中。') : null,
    h('div', { class: 'meta-strip' },
      h('span', {}, '豆款 ', h('a', { href: `#/products/${b.product_slug}` }, `${b.brand || ''} ${b.product_name || ''}`)),
      h('span', {}, '产地 ', h('a', { href: `#/origins/${b.origin_slug}` }, b.origin_name || '—')),
      h('span', {}, '处理法 ', h('a', { href: `#/processes/${b.process_slug}` }, b.process_name || '—')),
      h('span', {}, '产季 ', h('b', {}, String(b.harvest_year || '—'))),
      h('span', {}, '烘焙日 ', h('b', {}, fmtDate(b.roast_date))),
      h('span', {}, '机器 ', h('b', {}, b.machine || '—')),
    ),
    ...paragraphs(b.story));
  app.append(head);

  // 谱系
  const fam = h('div', { class: 'card family-tree' });
  fam.append(h('h3', { style: 'margin-top:0' }, '批次谱系'));
  if (d.lineage.parents.length) {
    fam.append(h('div', { class: 'small muted' }, '上游：'));
    d.lineage.parents.forEach((l) => fam.append(h('div', { class: 'family-node' },
      h('span', { class: 'relation-tag' }, relationLabel(l.relation)),
      h('a', { href: `#/batches/${l.slug}` }, l.code), ' ', statusBadge(l.status),
      l.note ? h('span', { class: 'meta' }, ' — ' + l.note) : null)));
  }
  if (d.lineage.children.length) {
    fam.append(h('div', { class: 'small muted', style: 'margin-top:8px' }, '下游：'));
    d.lineage.children.forEach((l) => fam.append(h('div', { class: 'family-node' },
      h('span', { class: 'relation-tag' }, relationLabel(l.relation)),
      h('a', { href: `#/batches/${l.slug}` }, l.code), ' ', statusBadge(l.status),
      l.note ? h('span', { class: 'meta' }, ' — ' + l.note) : null)));
  }
  if (!d.lineage.parents.length && !d.lineage.children.length) fam.append(h('span', { class: 'muted small' }, '暂无谱系记录'));
  app.append(fam);

  // 曲线
  app.append(h('h2', {}, `曲线文件（${d.curves.length}）`));
  if (!d.curves.length) app.append(h('div', { class: 'card muted' }, '暂无曲线'));
  for (const c of d.curves) app.append(curveCard(c));

  // 评语
  app.append(h('h2', {}, `感官评语（${d.reviews.length}）`));
  if (!d.reviews.length) app.append(h('div', { class: 'card muted' }, '暂无评语'));
  else app.append(h('div', { class: 'card' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, '量表'), h('th', {}, '分数'), h('th', {}, '评语'), h('th', {}, '杯测师'), h('th', {}, '日期'))),
    h('tbody', {}, ...d.reviews.map((r) => h('tr', {},
      h('td', {}, h('span', { class: 'tag sensory' }, r.scale_code), h('div', { class: 'meta small' }, `${r.scale_name} (${Number(r.scale_min)}~${Number(r.scale_max)})`)),
      h('td', {}, h('b', {}, String(r.score))),
      h('td', {}, r.cup_notes || '—'),
      h('td', {}, r.cupper || '—'),
      h('td', { class: 'meta' }, fmtDate(r.reviewed_at))))))));

  app.append(h('div', { class: 'btn-row', style: 'margin-top:18px' },
    h('a', { class: 'btn secondary', href: `/api/batches/${b.slug}/bundle` }, '⬇ 打包下载（原曲线+元数据+评语+谱系）'),
    h('a', { class: 'btn secondary', href: `#/compare?batch=${b.id}` }, '加入曲线比较')));
});
function relationLabel(r) { return { split: '分裂', blend: '拼配', replace: '换批', parent: '承继' }[r] || r; }

function curveCard(c) {
  const notes = (() => { try { return JSON.parse(c.validation_notes || '{}'); } catch { return {}; } })();
  const cardEl = h('div', { class: 'card', style: 'margin-bottom:12px' });
  const head = h('div', { style: 'display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px' },
    h('div', {},
      h('b', {}, c.original_filename || ('curve#' + c.id)), ' ',
      c.phase === 'acceptance' ? h('span', { class: 'tag sensory' }, '验收曲线（晚到也保留）') : h('span', { class: 'tag roast' }, '生产烘焙曲线'),
      ' ', c.accepted ? h('span', { class: 'pill OK' }, '校验通过') : h('span', { class: 'pill BLOCK' }, '已拒收')),
    h('div', {},
      h('a', { class: 'btn small secondary', href: `/api/curves/${c.id}/download` }, '⬇ 原始文件')));
  cardEl.append(head);
  cardEl.append(h('div', { class: 'meta-strip' },
    h('span', {}, '探头 ', h('b', {}, c.probe_model), '（', c.probe_position, '）'),
    h('span', {}, '单位 ', h('b', {}, c.temp_unit)),
    h('span', {}, '采样间隔 ', h('b', {}, String(c.sample_interval_s), 's')),
    h('span', {}, '时间零点 ', h('b', {}, timeZeroLabel(c.time_zero))),
    h('span', {}, '点数 ', h('b', {}, String(c.point_count))),
    h('span', {}, '时长 ', h('b', {}, String(c.duration_s), 's')),
    h('span', {}, '最长缺测 ', h('b', {}, String(c.max_gap_s), 's')),
  ));
  if (Array.isArray(c.channels) && c.channels.length) {
    cardEl.append(h('div', { class: 'small muted' }, '通道：',
      c.channels.map((ch) => `${ch.channel}[${ch.unit || '?'}] · 缺测${ch.max_gap_s}s`).join(' / ')));
  }
  if (notes.warnings && notes.warnings.length) {
    cardEl.append(h('div', { class: 'notice' }, notes.warnings.map((w) => h('div', {}, '⚠ ' + w))));
  }
  if (!c.accepted && notes.errors && notes.errors.length) {
    cardEl.append(h('div', { class: 'notice block' }, notes.errors.map((x) => h('div', {}, '✕ ' + x))));
  }
  if (c.accepted) {
    const btn = h('button', { class: 'btn small secondary', onclick: async () => {
      btn.disabled = true; btn.textContent = '绘图中…';
      const pts = await api(`/api/curves/${c.id}/points`);
      const host = h('div', {});
      cardEl.append(host);
      host.replaceWith(drawSingleCurve(pts));
    } }, '📈 绘制曲线');
    cardEl.append(btn);
  }
  cardEl.append(h('div', { class: 'meta small mono', style: 'margin-top:6px' },
    'sha256:' + c.content_sha256.slice(0, 16) + '… · ', fmtDate(c.created_at)));
  return cardEl;
}

/* ================= 比较页 ================= */
route('/compare', async (ctx) => {
  const cat = await api('/api/catalog');
  // 需要批次清单（含下架/不同产品）——用产品批次聚合拉取
  const products = await Promise.all(cat.products.map((p) => api(`/api/products/${p.slug}`)));
  const allBatches = products.flatMap((p) => p.batches.map((b) => ({ ...b, product: p.product })));
  const productOpts = cat.products;

  const modeBox = h('div', { class: 'btn-row' },
    h('span', { class: 'pill OK' }, '模式 A：按批次筛选（逐曲线条件检查）'),
    h('a', { class: 'btn small secondary', href: '#/compare-products' }, '切换到“按产品汇总” →'));

  const sel = h('select', { multiple: 'multiple', size: Math.min(10, allBatches.length + 1), style: 'min-height:180px' },
    ...allBatches.map((b) => {
      const o = h('option', { value: b.id }, `${b.code} · ${b.product.brand} ${b.product.name} · ${b.status}`);
      if (b.status === 'delisted') o.disabled = true;
      return o;
    }));
  if (ctx.query.batch) {
    [...sel.options].forEach((o) => { if (o.value === ctx.query.batch) o.selected = true; });
  }
  const out = h('div', {});
  const run = h('button', { class: 'btn', onclick: async () => {
    const ids = [...sel.selectedOptions].map((o) => o.value);
    if (ids.length < 2) return toast('请至少选择 2 个批次', 'error');
    out.innerHTML = '';
    run.disabled = true;
    try {
      const d = await api('/api/compare/batches?ids=' + ids.join(','));
      out.append(renderCompareResult(d));
    } catch (e) { toast(e.message, 'error'); } finally { run.disabled = false; }
  } }, '运行可比条件检查');

  app.innerHTML = '';
  app.append(h('h1', {}, '曲线比较'), p('温度探头、采样间隔、时间零点任一不同，系统都会明确标识；BLOCK 条件不提供叠合排名。长缺测不插值，感官分数跨量表不混排。'),
    modeBox,
    h('div', { class: 'card', style: 'margin-top:12px' },
      h('label', {}, '选择批次（按住 Ctrl/Cmd 多选；已下架批次不参与新比较）'), sel,
      h('div', { class: 'btn-row', style: 'margin-top:10px' }, run)),
    out);
});

route('/compare-products', async () => {
  const cat = await api('/api/catalog');
  const sel = h('select', { multiple: 'multiple', size: Math.min(8, cat.products.length + 1), style: 'min-height:150px' },
    ...cat.products.map((p) => h('option', { value: p.id }, `${p.brand} · ${p.name}`)));
  const out = h('div', {});
  const run = h('button', { class: 'btn', onclick: async () => {
    const ids = [...sel.selectedOptions].map((o) => o.value);
    if (ids.length < 2) return toast('请至少选择 2 个豆款', 'error');
    out.innerHTML = ''; run.disabled = true;
    try { out.append(renderProductCompare(await api('/api/compare/products?ids=' + ids.join(',')))); }
    catch (e) { toast(e.message, 'error'); } finally { run.disabled = false; }
  } }, '按产品汇总比较');
  app.innerHTML = '';
  app.append(h('h1', {}, '按产品汇总比较'),
    p('产品比较会自动展开到各名下批次：品牌同名不视为实验条件相同；只有各当前批次测量条件一致时才下钻叠合曲线。'),
    h('div', { class: 'btn-row' }, h('a', { class: 'btn small secondary', href: '#/compare' }, '← 切换到“按批次筛选”')),
    h('div', { class: 'card', style: 'margin-top:12px' }, h('label', {}, '选择豆款（多选）'), sel,
      h('div', { class: 'btn-row', style: 'margin-top:10px' }, run)), out);
});

function renderChecks(checks) {
  return h('div', { class: 'card' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', { style: 'width:150px' }, '检查维度'), h('th', { style: 'width:90px' }, '判定'), h('th', {}, '说明 / 取值'))),
    h('tbody', {}, ...checks.map((c) => h('tr', {},
      h('td', {}, checkDimLabel(c.dimension)),
      h('td', {}, h('span', { class: 'pill ' + c.severity }, c.severity)),
      h('td', { class: 'small' }, renderDetail(c)))))));
}
function checkDimLabel(d) {
  return {
    curve_available: '曲线可得性', probe_model: '温度探头型号', probe_position: '探头位置',
    temp_unit: '温度量纲', sample_interval: '采样间隔', time_zero: '时间零点',
    gaps: '缺测处理', overlap: '时间覆盖重叠', time_coverage: '时间范围',
  }[d] || d;
}
function renderDetail(c) {
  const d = c.detail || {};
  if (d.reason) return h('span', {}, d.reason, d.values ? h('div', { class: 'mono small muted', style: 'margin-top:4px' }, JSON.stringify(d.values)) : null);
  if (d.action) return h('span', {}, d.action, d.values ? h('div', { class: 'mono small muted', style: 'margin-top:4px' }, JSON.stringify(d.values)) : null);
  if (d.shared != null) return h('span', { class: 'muted' }, '全部一致：', h('b', {}, String(d.shared)));
  if (d.pairs) return h('span', {},
    ...d.pairs.map((pp) => h('div', { class: 'small' }, `${pp.a} ↔ ${pp.b}：覆盖度 ${(pp.overlap * 100).toFixed(0)}%`)),
    d.min_overlap != null ? h('div', { class: 'muted small' }, `最低覆盖度 ${(d.min_overlap * 100).toFixed(0)}%`) : null);
  return h('span', { class: 'mono small muted' }, JSON.stringify(d));
}
function renderCompareResult(d) {
  const box = h('div', {});
  box.append(
    d.comparable
      ? h('div', { class: 'notice ok' }, '✔ 可比：' + d.rationale.join(' '))
      : h('div', { class: 'notice block' }, '✕ 不可直接排名：' + d.rationale.join(' ')),
    h('h2', {}, '逐项条件检查'), renderChecks(d.checks),
  );
  if (d.chart) {
    box.append(h('h2', {}, '叠合曲线（统一 °C · 公共时间网格）'), drawCurves(d.chart));
  } else {
    box.append(h('h2', {}, '曲线并列展示'));
    box.append(h('div', { class: 'notice' }, '由于存在 BLOCK 条件或曲线不可得，这里不叠合、不排名。可分别打开批次页查看各自曲线（各自探头/零点均在图上标注）：',
      h('div', { style: 'margin-top:8px' }, ...d.items.map((it) => h('a', {
        class: 'btn small secondary', style: 'margin:4px 6px 0 0',
        href: `#/batches/${it.batchSlug || ''}`,
      }, it.label)))));
  }
  if (d.sensory) box.append(h('h2', {}, '感官评分'), renderSensory(d.sensory));
  return box;
}
function renderSensory(se) {
  const box = h('div', {});
  box.append(h('div', { class: se.scales.length > 1 ? 'notice block' : 'notice ok' }, se.note));
  for (const sc of se.scales) {
    box.append(h('h3', {}, `${sc.scale_name}（${sc.scale_code}，${sc.min}~${sc.max}）`),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '量表内名次'), h('th', {}, '批次'), h('th', {}, '原始分'), h('th', {}, '归一化(仅供参考)'), h('th', {}, '评语'))),
        h('tbody', {}, ...sc.ranked.map((r) => h('tr', {},
          h('td', {}, h('b', {}, '#' + r.rank_within_scale)),
          h('td', { class: 'mono' }, r.batch),
          h('td', {}, String(r.score)),
          h('td', {}, String(r.normalized)),
          h('td', { class: 'small' }, r.notes || '—'))))));
  }
  return box;
}
function renderProductCompare(d) {
  const box = h('div', {});
  box.append(d.comparable
    ? h('div', { class: 'notice ok' }, '✔ ' + d.rationale)
    : h('div', { class: 'notice block' }, '✕ ' + d.rationale));
  d.groups.forEach((g) => {
    const cardEl = h('div', { class: 'card', style: 'margin:12px 0' });
    cardEl.append(h('h3', { style: 'margin-top:0' },
      `${g.product.brand} · ${g.product.name}`,
      h('span', { class: 'meta', style: 'margin-left:8px' }, `${g.batch_count} 个批次`)));
    g.warnings.forEach((w) => cardEl.append(h('div', { class: 'notice' }, w)));
    const rows = g.batches.map((b) => h('tr', {},
      h('td', { class: 'mono' }, b.code),
      h('td', {}, statusBadge(b.status)),
      h('td', {}, fmtDate(b.roast_date)),
      h('td', {}, String(b.curve_count))));
    cardEl.append(h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '批次'), h('th', {}, '状态'), h('th', {}, '烘焙日'), h('th', {}, '曲线数'))),
      h('tbody', {}, ...rows)));
    box.append(cardEl);
  });
  if (d.pairwise) {
    box.append(h('h2', {}, '当前发布批次的条件检查'), renderChecks(d.pairwise.checks));
    if (d.pairwise.chart) {
      box.append(h('h2', {}, '叠合曲线'), drawCurves(d.pairwise.chart));
    } else {
      box.append(h('div', { class: 'notice' }, '当前批次之间也不满足叠合条件，不做跨豆款排名。'));
    }
    if (d.sensory) box.append(h('h2', {}, '感官评分'), renderSensory(d.sensory));
  }
  return box;
}

/* ================= 活动列表与详情 ================= */
route('/events', async () => {
  const cat = await api('/api/catalog');
  app.innerHTML = '';
  app.append(h('h1', {}, '杯测与烘焙活动'), p('活动名额与“可供演示批次”实时联动；库存撤回后，待处理报名进入“需确认”，不会被静默取消。'),
    h('div', { class: 'grid cols-2' }, cat.events.map((e) => h('a', { class: 'card linked', href: `#/events/${e.slug}` },
      h('h3', {}, e.title), h('div', { class: 'meta' }, fmtDate(e.starts_at)),
      h('span', { class: 'tag sensory' }, `场地名额 ${e.capacity}`)))));
});

route('/events/:slug', async ({ params }) => {
  let cap = await api(`/api/events/${params.slug}`);
  app.innerHTML = '';
  const left = h('div', { style: 'flex:2' });
  const right = h('div', { style: 'flex:1;min-width:280px' });

  function renderCap() {
    right.innerHTML = '';
    const pct = Math.min(100, cap.seats_confirmed / Math.max(1, cap.effective_capacity) * 100);
    right.append(
      h('div', { class: 'card' },
        h('h3', { style: 'margin-top:0' }, '名额联动'),
        h('div', { class: 'meta' }, '场地名额'), h('div', { class: 'scalar-big' }, String(cap.event.capacity)),
        h('div', { class: 'meta', style: 'margin-top:8px' }, `可供演示份数合计 ${cap.demo_servings}`),
        h('div', {}, h('b', {}, '有效名额 = min(场地, 演示份数) = '), h('span', { class: 'scalar-big', style: 'font-size:22px' }, String(cap.effective_capacity))),
        h('div', { class: 'capacity-bar' + (cap.seats_confirmed > cap.effective_capacity ? ' over' : '') },
          h('span', { style: `width:${pct}%` })),
        h('div', { class: 'small' }, `已确认 ${cap.seats_confirmed} 席 · 待处理/需确认 ${cap.seats_pending} 席 · 可新确认余量 ${cap.remaining}`),
      ),
      h('div', { class: 'card', style: 'margin-top:12px' },
        h('h3', { style: 'margin-top:0' }, '演示批次库存'),
        h('table', {}, h('tbody', {}, ...cap.demo_batches.map((b) => h('tr', {},
          h('td', { class: 'mono' }, b.code, b.status === 'delisted' ? h('span', { class: 'badge delisted', style: 'margin-left:6px' }, '已下架') : null),
          h('td', { class: 'small' }, `预留${b.servings_reserved} / 可供${b.servings_available}`),
          h('td', { class: 'small' }, `计入 ${b.usable}`)))))));
  }

  // 报名表单（客户端生成幂等键，重送安全）
  const idem = 'reg-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now();
  const fName = h('input', { placeholder: '姓名', value: '' });
  const fEmail = h('input', { placeholder: '邮箱', type: 'email' });
  const fSize = h('input', { type: 'number', min: '1', value: '1' });
  const form = h('div', { class: 'card' },
    h('h3', { style: 'margin-top:0' }, '在线报名'),
    h('label', {}, '姓名'), fName,
    h('label', {}, '邮箱'), fEmail,
    h('label', {}, '人数'), fSize,
    h('div', { class: 'btn-row', style: 'margin-top:12px' },
      h('button', {
        class: 'btn', onclick: async () => {
          const body = { name: fName.value.trim(), email: fEmail.value.trim(), party_size: Number(fSize.value) || 1, idempotency_key: idem };
          try {
            const r = await api(`/api/events/${params.slug}/register`, { method: 'POST', body });
            cap = r.capacity; renderCap();
            toast((r.idempotent_replay ? '（重送，返回原报名）' : '报名已提交') + '：状态「' + regStatus(r.registration.status) + '」', 'success');
          } catch (e) { toast(e.message, 'error'); }
        }
      }, '提交报名'),
      h('button', {
        class: 'btn secondary', onclick: async () => {
          // 模拟网络重送：用同一个幂等键再次提交
          try {
            const r = await api(`/api/events/${params.slug}/register`, {
              method: 'POST',
              body: { name: fName.value.trim() || '访客', email: fEmail.value.trim() || 'x@x.com', party_size: Number(fSize.value) || 1, idempotency_key: idem },
            });
            cap = r.capacity; renderCap();
            toast('重送结果：' + (r.idempotent_replay ? '幂等命中，未重复创建 ✔' : '创建了新记录'), r.idempotent_replay ? 'success' : 'error');
          } catch (e) { toast(e.message, 'error'); }
        }
      }, '模拟重送(同键)')),
    h('div', { class: 'small muted', style: 'margin-top:8px' }, '若当前余量不足，报名进入“需确认”队列；提交与重送共用一个幂等键，刷新页面后请重新生成。'));

  left.append(
    h('h1', {}, cap.event.title),
    h('div', { class: 'meta-strip' }, h('span', {}, '时间 ', h('b', {}, fmtDate(cap.event.starts_at))), h('span', {}, statusOfEvent(cap.event.status))),
    form);
  const wrap = h('div', { style: 'display:flex;gap:18px;flex-wrap:wrap' }, left, right);
  app.append(wrap);
  renderCap();
});
function statusOfEvent(s) { return s === 'open' ? h('span', { class: 'badge published' }, '报名开放') : h('span', { class: 'badge draft' }, '已关闭'); }

/* ================= 管理端 ================= */
route('/admin', async () => {
  let session = await api('/api/admin/session');
  app.innerHTML = '';
  if (!session.admin) {
    const pw = h('input', { type: 'password', placeholder: '管理员密码（默认 roast-admin）' });
    app.append(h('h1', {}, '管理登录'),
      h('div', { class: 'card', style: 'max-width:420px' },
        h('label', {}, '密码'), pw,
        h('div', { class: 'btn-row', style: 'margin-top:12px' },
          h('button', { class: 'btn', onclick: async () => {
            try { await api('/api/admin/login', { method: 'POST', body: { password: pw.value } }); toast('登录成功', 'success'); render(); }
            catch (e) { toast(e.message, 'error'); }
          } }, '登录'))),
      h('p', { class: 'muted small' }, '可用环境变量 ADMIN_PASSWORD 覆盖默认密码。'));
    return;
  }
  const ov = await api('/api/admin/overview');
  const tabs = h('div', { class: 'btn-row', style: 'margin-bottom:14px;flex-wrap:wrap' },
    ...['总览', '批次与谱系', '上传曲线/评语', '活动与库存', '下载审计', '基础数据'].map((t, i) => {
      const b = h('button', { class: 'btn small ' + (i === 0 ? '' : 'secondary') }, t);
      b.onclick = () => { document.querySelectorAll('.admin-tab').forEach((x, j) => x.style.display = j === i ? '' : 'none'); };
      return b;
    }),
    h('button', { class: 'btn small secondary', style: 'margin-left:auto', onclick: async () => {
      await api('/api/admin/logout', { method: 'POST' }); render();
    } }, '退出'));

  const tabOverview = tab(() => renderOverview(ov));
  const tabBatches = tab(() => renderBatchAdmin());
  const tabUpload = tab(() => renderUploadAdmin());
  const tabEvents = tab(() => renderEventsAdmin());
  const tabDownloads = tab(() => renderDownloadsAdmin(ov));
  const tabBase = tab(() => renderBaseAdmin());
  [tabBatches, tabUpload, tabEvents, tabDownloads, tabBase].forEach((t) => t.style.display = 'none');
  app.append(h('h1', {}, '后台管理'), tabs, tabOverview, tabBatches, tabUpload, tabEvents, tabDownloads, tabBase);
});
function tab(fn) { const d = h('div', { class: 'admin-tab' }); fn(d); return d; }

function renderOverview(ov) {
  const box = h('div', {});
  box.append(h('div', { class: 'grid cols-3' },
    Object.entries(ov.counts).map(([k, v]) => h('div', { class: 'card' },
      h('div', { class: 'scalar-big' }, String(v)), h('div', { class: 'meta' }, k)))));
  box.append(h('h2', {}, '批次（草稿/发布/下架与发布门槛）'),
    h('div', { class: 'card' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '批次'), h('th', {}, '状态'), h('th', {}, '生产曲线'), h('th', {}, '操作'))),
      h('tbody', {}, ...ov.batches.map((b) => h('tr', {},
        h('td', { class: 'mono' }, b.code, h('div', { class: 'meta small' }, `${b.brand || ''} ${b.name || ''}`)),
        h('td', {}, statusBadge(b.status)),
        h('td', {}, String(b.prod_curves)),
        h('td', {}, h('a', { class: 'btn small secondary', href: `#/batches/${b.slug}` }, '查看'))))))));
  if (ov.rejected.length) {
    box.append(h('h2', {}, '最近被拒收的曲线文件（已留档）'),
      h('div', { class: 'card' }, ...ov.rejected.map((r) => h('div', { class: 'notice block', style: 'margin-bottom:8px' },
        h('b', { class: 'mono' }, r.code), ' · ', r.original_filename,
        h('div', { class: 'small' }, r.validation_notes)))));
  }
  box.append(h('h2', {}, '待处理 / 需确认报名'),
    h('div', { class: 'card' }, ov.pending_registrations.length
      ? h('table', {}, h('tbody', {}, ...ov.pending_registrations.map((r) => h('tr', {},
        h('td', {}, r.name, ' ', h('span', { class: 'meta' }, r.email)),
        h('td', {}, r.title), h('td', {}, String(r.party_size), '人'),
        h('td', {}, h('span', { class: 'pill ' + (r.status === 'pending_confirmation' ? 'BLOCK' : 'WARN') }, regStatus(r.status)))))))
      : h('span', { class: 'muted' }, '无')));
  return box;
}

async function adminContext() {
  const cat = await api('/api/catalog');
  const products = await Promise.all(cat.products.map((p) => api(`/api/products/${p.slug}`)));
  const batches = products.flatMap((p) => p.batches.map((b) => ({ ...b, product: p.product })));
  return { cat, products, batches };
}
function batchSelect(batches, id) {
  return h('select', {}, ...batches.map((b) => {
    const o = h('option', { value: b.id }, `${b.code} · ${b.product.name} [${b.status}]`);
    if (Number(id) === b.id) o.selected = true;
    return o;
  }));
}

function renderBatchAdmin() {
  const box = h('div', {});
  box.append(h('h2', {}, '新建批次'));
  adminContext().then(({ cat, batches }) => {
    const f = {};
    const fields = [
      ['slug', 'slug（如 b-xxx-2026）'], ['code', '批次编号'], ['harvest_year', '产季年份'],
      ['roast_date', '烘焙日(YYYY-MM-DD)'], ['roast_level', '焙度'], ['machine', '机器'], ['demo_servings_total', '可演示份数'],
    ];
    const form = h('div', { class: 'card form-grid' });
    fields.forEach(([k, label]) => { f[k] = h('input', {}); form.append(h('div', {}, h('label', {}, label), f[k])); });
    f.product_id = h('select', {}, h('option', { value: '' }, '—'), ...cat.products.map((p) => h('option', { value: p.id }, `${p.brand} ${p.name}`)));
    f.origin_id = h('select', {}, h('option', { value: '' }, '—'), ...cat.origins.map((o) => h('option', { value: o.id }, o.name)));
    f.process_id = h('select', {}, h('option', { value: '' }, '—'), ...cat.processes.map((o) => h('option', { value: o.id }, o.name)));
    f.story = h('textarea', { rows: 2 });
    form.append(
      h('div', {}, h('label', {}, '豆款'), f.product_id),
      h('div', {}, h('label', {}, '产地'), f.origin_id),
      h('div', {}, h('label', {}, '处理法'), f.process_id),
      h('div', { class: 'full' }, h('label', {}, '批次故事'), f.story),
      h('div', { class: 'full' }, h('button', { class: 'btn', onclick: async () => {
        const body = Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
        try { await api('/api/admin/batches', { method: 'POST', body }); toast('批次已创建（草稿）', 'success'); render(); }
        catch (e) { toast(e.message, 'error'); }
      } }, '创建草稿批次')));
    box.append(form);

    // 谱系与发布/下架
    box.append(h('h2', {}, '谱系 · 发布 · 下架'));
    const list = h('div', {});
    batches.forEach((b) => {
      const parent = batchSelect(batches.filter((x) => x.id !== b.id));
      const rel = h('select', {}, ...['parent', 'split', 'blend', 'replace'].map((r) => h('option', { value: r }, relationLabel(r))));
      const row = h('div', { class: 'card', style: 'margin-bottom:10px' },
        h('div', { style: 'display:flex;justify-content:space-between;flex-wrap:wrap' },
          h('span', {}, h('b', { class: 'mono' }, b.code), ' ', statusBadge(b.status),
            h('a', { class: 'btn small secondary', style: 'margin-left:8px', href: `#/batches/${b.slug}` }, '公开页')),
          h('span', { class: 'meta' }, `${b.product.brand} ${b.product.name}`)),
        h('div', { class: 'btn-row', style: 'margin-top:8px' },
          h('span', { class: 'small' }, '建立谱系：父批'), parent, rel,
          h('button', { class: 'btn small secondary', onclick: async () => {
            try {
              await api(`/api/admin/batches/${b.id}/lineage`, { method: 'POST', body: { parent_id: Number(parent.value), relation: rel.value } });
              toast('谱系已建立', 'success'); render();
            } catch (e) { toast(e.message, 'error'); }
          } }, '添加谱系边'),
          h('span', { style: 'flex:1' }),
          b.status !== 'published'
            ? h('button', { class: 'btn small', onclick: async () => {
              try { await api(`/api/admin/batches/${b.id}/publish`, { method: 'POST' }); toast('已发布', 'success'); render(); }
              catch (e) { toast('发布阻止：' + e.message, 'error'); }
            } }, '发布（需有合格烘焙曲线）') : null,
          b.status !== 'delisted'
            ? h('button', { class: 'btn small danger', onclick: async () => {
              if (!confirm('下架后公开页仍可访问（标注已下架），相关报名进入需确认。确定？')) return;
              try { await api(`/api/admin/batches/${b.id}/delist`, { method: 'POST' }); toast('已下架', 'success'); render(); }
              catch (e) { toast(e.message, 'error'); }
            } }, '下架') : null));
      list.append(row);
    });
    box.append(list);
  });
  return box;
}

function renderUploadAdmin() {
  const box = h('div', {});
  adminContext().then(({ batches }) => {
    const batch = batchSelect(batches);
    const phase = h('select', {}, h('option', { value: 'production' }, '生产烘焙曲线'), h('option', { value: 'acceptance' }, '验收曲线（晚到也可挂到既有批次）'));
    const file = h('input', { type: 'file', accept: '.json,.csv' });
    const probe = h('input', { placeholder: '如 Phidget PT100 / Bullet-IRS / Generic K-type TC' });
    const pos = h('select', {}, ...['bean', 'environment', 'inlet', 'exhaust'].map((x) => h('option', { value: x }, x)));
    const unit = h('select', {}, h('option', { value: 'C' }, '°C'), h('option', { value: 'F' }, '°F'));
    const interval = h('input', { placeholder: '如 1（秒）' });
    const tz = h('select', {}, ...['charge', 'turning_point', 'first_crack_start', 'roast_start', 'other'].map((x) => h('option', { value: x }, timeZeroLabel(x))));
    const result = h('div', {});
    box.append(
      h('h2', {}, '上传曲线文件（测点存文件，元数据入库）'),
      h('div', { class: 'notice info' }, '系统会校验：量纲/温度范围、声明采样间隔与时间戳一致性、时间零点与探头信息。验收曲线晚到允许补挂；量纲错误会被拒收并原样留档。'),
      h('div', { class: 'card form-grid' },
        h('div', {}, h('label', {}, '批次'), batch),
        h('div', {}, h('label', {}, '曲线阶段'), phase),
        h('div', {}, h('label', {}, '温度探头型号'), probe),
        h('div', {}, h('label', {}, '探头位置'), pos),
        h('div', {}, h('label', {}, '温度单位'), unit),
        h('div', {}, h('label', {}, '采样间隔(秒)'), interval),
        h('div', {}, h('label', {}, '时间零点'), tz),
        h('div', {}, h('label', {}, '曲线文件 (.json/.csv)'), file),
        h('div', { class: 'full btn-row' }, h('button', { class: 'btn', onclick: async () => {
          if (!file.files[0]) return toast('请选择文件', 'error');
          const fd = new FormData();
          fd.append('file', file.files[0]);
          fd.append('phase', phase.value);
          fd.append('curve_type', phase.value);
          fd.append('probe_model', probe.value);
          fd.append('probe_position', pos.value);
          fd.append('temp_unit', unit.value);
          fd.append('sample_interval_s', interval.value);
          fd.append('time_zero', tz.value);
          result.innerHTML = '';
          try {
            const r = await api(`/api/admin/batches/${batch.value}/curves`, { method: 'POST', body: fd });
            result.append(h('div', { class: 'notice ok' }, '✔ 已接受入库：' + r.curve.original_filename,
              h('div', { class: 'small' }, `${r.summary.point_count} 点 / ${r.summary.duration_s}s / 最长缺测 ${r.summary.max_gap_s}s`),
              ...(r.warnings || []).map((w) => h('div', {}, '⚠ ' + w))));
            toast('曲线已接受', 'success');
          } catch (e) {
            const d = e.data || {};
            result.append(h('div', { class: 'notice block' }, '✕ 拒收（HTTP ' + e.status + '）：' + e.message,
              ...((d.errors) || []).map((x) => h('div', { class: 'small' }, '· ' + x)),
              h('div', { class: 'small muted', style: 'margin-top:6px' }, '原始文件已留存于 storage/curves/rejected/，未影响现有数据。')));
          }
        } }, '上传并校验')),
        result),
      h('h2', {}, '录入感官评语（必须选量表）'),
      sensoryForm(batches));
  });
  return box;
}
function sensoryForm(batches) {
  const batch = batchSelect(batches);
  const scale = h('select', {}, ...[['sca2017', 'SCA 百分制 (0-100)'], ['wb10', '店内十分制 (0-10)'], ['internal5', '五星 (1-5)']]
    .map(([v, l]) => h('option', { value: v }, l)));
  const score = h('input', { placeholder: '分数' });
  const cupper = h('input', { placeholder: '杯测师' });
  const notes = h('textarea', { rows: 2, placeholder: '风味评语' });
  return h('div', { class: 'card form-grid' },
    h('div', {}, h('label', {}, '批次'), batch),
    h('div', {}, h('label', {}, '量表'), scale),
    h('div', {}, h('label', {}, '分数'), score),
    h('div', {}, h('label', {}, '杯测师'), cupper),
    h('div', { class: 'full' }, h('label', {}, '评语'), notes),
    h('div', { class: 'full' }, h('button', { class: 'btn', onclick: async () => {
      try {
        await api(`/api/admin/batches/${batch.value}/reviews`, { method: 'POST',
          body: { scale_code: scale.value, score: Number(score.value), cupper: cupper.value, cup_notes: notes.value } });
        toast('评语已保存', 'success'); render();
      } catch (e) { toast(e.message, 'error'); }
    } }, '保存评语')));
}

function renderEventsAdmin() {
  const box = h('div', {});
  adminContext().then(async ({ cat, batches }) => {
    // 新建活动
    const ne = { slug: h('input', { placeholder: 'slug，如 cupping-2026-11' }),
      title: h('input', { placeholder: '活动标题' }),
      starts_at: h('input', { placeholder: 'ISO 时间，如 2026-11-20T19:00:00Z' }),
      capacity: h('input', { placeholder: '场地名额', value: '20' }) };
    box.append(h('h2', {}, '活动列表 / 撤回库存 / 处理报名'),
      h('div', { class: 'card form-grid' },
        h('div', {}, h('label', {}, 'slug'), ne.slug),
        h('div', {}, h('label', {}, '标题'), ne.title),
        h('div', {}, h('label', {}, '开始时间(ISO)'), ne.starts_at),
        h('div', {}, h('label', {}, '场地名额'), ne.capacity),
        h('div', { class: 'full' }, h('button', { class: 'btn small', onclick: async () => {
          try {
            await api('/api/admin/events', { method: 'POST', body: {
              slug: ne.slug.value, title: ne.title.value, starts_at: ne.starts_at.value,
              capacity: Number(ne.capacity.value), status: 'open' } });
            toast('活动已创建，下一步请绑定演示批次', 'success'); render();
          } catch (e) { toast(e.message, 'error'); }
        } }, '新建活动'))));
    for (const e of cat.events.length ? cat.events : []) {
      const cap = await api(`/api/events/${e.slug}`);
      const regs = await api(`/api/admin/events/${e.id}/registrations`);
      const cardEl = h('div', { class: 'card', style: 'margin-bottom:14px' });
      cardEl.append(h('h3', { style: 'margin-top:0' }, e.title,
        h('span', { class: 'meta', style: 'margin-left:8px' },
          `场地 ${cap.event.capacity} · 演示份数 ${cap.demo_servings} · 有效名额 ${cap.effective_capacity} · 余量 ${cap.remaining}`)));
      // 绑定演示批次
      const bsel = batchSelect(batches);
      const serv = h('input', { placeholder: '预留份数', style: 'max-width:120px' });
      cardEl.append(h('div', { class: 'btn-row small' },
        h('span', { class: 'small' }, '绑定演示批次：'), bsel, serv,
        h('button', { class: 'btn small secondary', onclick: async () => {
          try { await api(`/api/admin/events/${e.id}/demo-batches`, { method: 'POST', body: { batch_id: Number(bsel.value), servings: Number(serv.value) } }); toast('已绑定', 'success'); render(); }
          catch (er) { toast(er.message, 'error'); }
        } }, '绑定/更新')));
      // 撤回
      const wsel = batchSelect(cap.demo_batches.map((d) => batches.find((b) => b.id === d.batch_id)).filter(Boolean));
      const delta = h('input', { value: '-10', style: 'max-width:100px' });
      cardEl.append(h('div', { class: 'btn-row small', style: 'margin-top:8px' },
        h('span', { class: 'small' }, '撤回库存（负数）：'), wsel, delta,
        h('button', { class: 'btn small danger', onclick: async () => {
          try {
            const r = await api(`/api/admin/events/${e.id}/withdraw`, { method: 'POST',
              body: { batch_id: Number(wsel.value), delta: Number(delta.value), reason: 'withdrawal' } });
            toast(`撤回完成，有效名额变为 ${r.capacity.effective_capacity}；待处理报名已重算`, 'success');
            render();
          } catch (er) { toast(er.message, 'error'); }
        } }, '执行撤回并联动报名')));
      // 报名
      cardEl.append(h('table', { style: 'margin-top:10px' }, h('thead', {}, h('tr', {},
        h('th', {}, '报名'), h('th', {}, '人数'), h('th', {}, '状态'), h('th', {}, '操作'))),
        h('tbody', {}, ...regs.registrations.map((r) => h('tr', {},
          h('td', {}, r.name, h('div', { class: 'meta small' }, r.email), r.note ? h('div', { class: 'small muted' }, r.note.trim()) : null),
          h('td', {}, String(r.party_size)),
          h('td', {}, h('span', { class: 'pill ' + (r.status === 'pending_confirmation' ? 'BLOCK' : r.status === 'confirmed' ? 'OK' : r.status === 'cancelled' ? 'BLOCK' : 'WARN') }, regStatus(r.status))),
          h('td', { class: 'btn-row' },
            h('button', { class: 'btn small', onclick: async () => { await decision(r.id, 'confirm'); } }, '确认'),
            h('button', { class: 'btn small secondary', onclick: async () => { await decision(r.id, 'request_confirmation'); } }, '标需确认'),
            h('button', { class: 'btn small danger', onclick: async () => { if (confirm('确定取消该报名？')) await decision(r.id, 'cancel'); } }, '取消')))))));
      box.append(cardEl);
    }
    async function decision(id, action) {
      try { await api(`/api/admin/registrations/${id}/decision`, { method: 'POST', body: { action } }); toast('已处理', 'success'); render(); }
      catch (e) { toast(e.message, 'error'); }
    }
  });
  return box;
}

function renderDownloadsAdmin(ov) {
  const box = h('div', { class: 'card' },
    h('p', {}, '所有原始曲线/打包下载都会记录：批次、曲线、格式、请求方与返回内容的 sha256，确保下载可追到原数据。'),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '时间'), h('th', {}, '批次'), h('th', {}, '格式'), h('th', {}, '请求方'), h('th', {}, '字节'), h('th', {}, 'sha256'))),
      h('tbody', {}, ...ov.recent_downloads.map((d) => h('tr', {},
        h('td', { class: 'small' }, fmtDate(d.created_at) + ' ' + String(d.created_at || '').slice(11, 19)),
        h('td', { class: 'mono' }, d.code || '—'),
        h('td', {}, d.format), h('td', {}, d.requester),
        h('td', {}, String(d.byte_size)),
        h('td', { class: 'mono small' }, String(d.content_sha256 || '').slice(0, 18) + '…'))))));
  return h('div', {}, h('h2', {}, '下载审计'), box);
}

function renderBaseAdmin() {
  const box = h('div', {}, h('h2', {}, '基础数据（产地 / 处理法 / 术语 / 豆款）'));
  adminContext().then(({ cat }) => {
    const mk = (title, endpoint, fields, rows) => {
      const inputs = {};
      const card = h('div', { class: 'card', style: 'margin-bottom:14px' });
      card.append(h('h3', { style: 'margin-top:0' }, title));
      const grid = h('div', { class: 'form-grid' });
      fields.forEach(([k, l]) => { inputs[k] = h('input', {}); grid.append(h('div', {}, h('label', {}, l), inputs[k])); });
      card.append(grid, h('button', { class: 'btn', style: 'margin-top:10px', onclick: async () => {
        const body = Object.fromEntries(fields.map(([k]) => [k, inputs[k].value]));
        try { await api(endpoint, { method: 'POST', body }); toast('已新增', 'success'); render(); }
        catch (e) { toast(e.message, 'error'); }
      } }, '新增'));
      card.append(h('div', { class: 'small muted', style: 'margin-top:8px' }, '现有：' + rows.map((r) => r.name || r.term).join('、')));
      return card;
    };
    box.append(
      mk('产地', '/api/admin/origins', [['slug', 'slug'], ['name', '名称'], ['country', '国家'], ['region', '产区'], ['altitude_m', '海拔'], ['story', '故事']], cat.origins),
      mk('处理法', '/api/admin/processes', [['slug', 'slug'], ['name', '名称'], ['category', '分类'], ['description', '描述']], cat.processes),
      mk('术语', '/api/admin/terms', [['slug', 'slug'], ['term', '术语'], ['kind', 'kind(origin/process/roasting/sensory)'], ['definition', '定义']], cat.terms),
      mk('豆款', '/api/admin/products', [['slug', 'slug'], ['brand', '品牌'], ['name', '名称'], ['description', '描述']], cat.products));
  });
  return box;
}

/* ================= 设计说明 & 404 ================= */
route('/design', async () => {
  app.innerHTML = '';
  const el = h('div', { class: 'design-doc' });
  el.innerHTML = `
  <h1>站内设计说明</h1>
  <p class="page-sub">本文档说明本站如何把“可比较性”当成一等公民来设计：数据如何建模、曲线如何存、比较在什么条件下才被允许，以及异常场景（晚到、量纲错误、下架、重送）如何处理。</p>

  <h2>1. 领域模型：豆款 ≠ 批次，曲线永远绑定批次</h2>
  <ul>
    <li><code>products</code> 是稳定的品牌 SKU（如“山脊·晨曦拼配”）；<code>batches</code> 是具体产季/烘焙批次。豆款换批后，旧曲线仍绑定原批，绝不迁移。</li>
    <li>批次谱系用有向边 <code>batch_lineage</code> 表达：<code>split</code>（分裂）、<code>blend</code>（拼配）、<code>replace</code>（换批）、<code>parent</code>（一般承继）。</li>
    <li>“品牌同名不等于实验条件相同”：按产品比较时自动展开到批次，逐批标注探头、零点、产地与处理法差异。</li>
  </ul>

  <h2>2. 曲线文件独立存储，PostgreSQL 只存测量元数据</h2>
  <ul>
    <li>测点序列（time_s + 多通道）写入 <code>storage/curves/&lt;batchId&gt;/</code>，文件以 <code>时间戳-sha256-原名</code> 命名，原样保存（支持 .json/.csv）。</li>
    <li>数据库 <code>curves</code> 表只保存：探头型号/位置、温度单位、采样间隔、时间零点、点数、时长、最长缺测、文件路径与 sha256；通道结构在 <code>curve_channels</code>。</li>
    <li>感官评语（<code>sensory_reviews</code>）必须引用 <code>rating_scales</code> 中的量表。</li>
  </ul>

  <h2>3. 比较规则：可比条件检查（compare engine）</h2>
  <ul>
    <li><b>温度探头型号/位置不同 → BLOCK</b>：探头系统偏差未知，不叠合、不排名，逐项解释。</li>
    <li><b>采样间隔不同 → WARN</b>：最近邻重采样到公共网格（不做插值），图上显式标注“重采样”。</li>
    <li><b>时间零点不同 → BLOCK</b>：下锅 / 回温点 / 一爆开始是不同的横轴原点，无法对齐。</li>
    <li><b>量纲不同（°C/°F）→ WARN</b>：统一换算到 °C，原始单位仍保留。量纲错误（如 °F 数值伪装成 °C、超物理范围）→ <b>上传即拒收</b>。</li>
    <li><b>缺测</b>：≤2 个采样点的短缺口仅在展示时线性插值并以空心点标注；长缺口永不插值，曲线按缺口分段；两两共同覆盖度 &lt; 50% 判 BLOCK。</li>
    <li><b>感官评分</b>：不同量表（SCA 百分制 / 店内 10 分制 / 5 星）绝不直接混排，只在同一量表内部排名，归一化数值仅作参考。</li>
    <li>提供两种入口：<code>按批次筛选</code>（逐曲线检查）与 <code>按产品汇总</code>（展开批次后再下钻）。不可比项给出人可读解释，而不是静默给一个排名。</li>
  </ul>

  <h2>4. 活动名额与演示批次联动</h2>
  <ul>
    <li>有效名额 = min(活动场地名额, Σ 关联演示批次的当前可供份数)。</li>
    <li>库存撤回会重算所有相关报名：已确认且超出新容量的席位<b>保留并标注“请联系确认”</b>；未处理的 pending 转为 <code>pending_confirmation</code>（需确认），系统绝不静默取消任何人的报名。</li>
    <li>报名接口使用 <code>idempotency_key</code>：网络重送/重复点击返回同一条记录。</li>
  </ul>

  <h2>5. 验收场景</h2>
  <ul>
    <li><b>验收曲线晚到</b>：批次发布后仍可上传 <code>phase=acceptance</code> 曲线，永久挂在原批次上，不替代生产曲线。</li>
    <li><b>量纲错误</b>：通道单位冲突/数值超出物理范围/声明间隔与时间戳不符 → 422 拒收，文件进入 <code>storage/curves/rejected/</code> 留档，批次现有数据不受影响。</li>
    <li><b>下架批次的历史链接</b>：状态置 <code>delisted</code> 后公开页仍可访问并显著标注，不进入新的比较/活动候选；其曲线与谱系完整保留。</li>
    <li><b>报名重送</b>：幂等键去重，重复提交不产生第二条记录、不重复占座。</li>
    <li><b>下载可追原数据</b>：原始文件下载与批次 bundle（全部原始曲线 base64 + 元数据 + 评语 + 谱系）均写 <code>download_log</code>，响应头带 sha256；bundle 本身也落盘并记录哈希。</li>
  </ul>

  <h2>6. 发布门槛与权限</h2>
  <ul>
    <li>批次发布要求至少存在 1 条<b>已通过校验的生产烘焙曲线</b>；只有验收曲线不能发布。</li>
    <li>管理端使用签名会话 cookie（默认密码 <code>roast-admin</code>，可用 <code>ADMIN_PASSWORD</code> 覆盖）。</li>
  </ul>

  <h2>7. 运行与存储</h2>
  <ul>
    <li>默认使用嵌入式 PGlite（真实 PostgreSQL）持久化到 <code>.pglite/</code>；设置 <code>DATABASE_URL</code> 即可切换到外部 PostgreSQL，业务代码无需改动。</li>
    <li>命令：<code>npm run initdb</code> 建表 · <code>npm run seed</code> 演示数据 · <code>npm run reset</code> 全量重置 · <code>npm test</code> 验收用例。</li>
  </ul>

  <h2>8. 原创声明</h2>
  <p>界面视觉（烘焙棕/咖啡渍红/滤纸米配色、卡片与谱系树组件、SVG 曲线绘制）与本说明均为本项目原创实现，未使用 UI 模板；曲线图表未引入第三方图表库。</p>
  `;
  app.append(el);
});

route('/404', async () => {
  app.innerHTML = '';
  app.append(h('h1', {}, '页面不存在'), h('a', { class: 'btn', href: '#/' }, '回到首页'));
});

render();
