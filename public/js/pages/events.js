async function eventsPage(view) {
  const evs = await Promise.all((await API.get('/api/events')).map((e) => API.get('/api/events/' + e.id)));
  view.innerHTML = `
    <h1>活动与报名</h1>
    <div class="callout">名额与<b>可供演示批次</b>联动：只有存在已发布演示批次且有名额时才能报名；
      若演示批次库存撤回，已存在的报名进入<b>“待确认”</b>，系统绝不静默取消。</div>
    <div class="grid cols-2">
      ${evs.map(({ event: e, demo_batches }) => card(`
        <h3>${esc(e.title)} ${e.open ? '<span class="tag ok">可报名</span>' : '<span class="tag bad">报名关闭</span>'}</h3>
        <div class="meta">${fmtDT(e.held_on)} · ${esc(e.location)}</div>
        <p>${esc(e.description)}</p>
        ${kv([
          ['总名额', e.capacity], ['已确认', e.confirmed], ['待确认', e.pending],
          ['剩余(含待确认占位)', e.spots_left], ['可演示批次', `${e.demo_batch_count} 个（已发布）`],
        ])}
        <a href="#/event/${e.id}">查看/报名 →</a>`)).join('')}
    </div>`;
}

async function eventPage(view, id) {
  const d = await API.get('/api/events/' + id);
  const e = d.event;
  view.innerHTML = `
    ${backLink('#/events')}
    <h1>${esc(e.title)}</h1>
    <div class="meta">${fmtDT(e.held_on)} · ${esc(e.location)}</div>
    <p>${esc(e.description)}</p>
    <div class="two-col">
      <div class="card">
        <h3>名额与演示批次联动</h3>
        ${kv([
          ['总名额', e.capacity], ['已确认报名', e.confirmed], ['待确认报名', e.pending],
          ['剩余名额', e.spots_left], ['报名状态', e.open ? statusTag('registered') : '<span class="status-withdrawn">关闭</span>'],
        ])}
        <h3>关联演示批次</h3>
        <table><tr><th>批次</th><th>豆款</th><th>库存状态</th></tr>
        ${d.demo_batches.map((b) => `<tr><td><a href="#/batch/${b.id}">${esc(b.code)}</a></td>
          <td>${esc(b.brand)} ${esc(b.product_name)}</td><td>${statusTag(b.status)}</td></tr>`).join('')}
        </table>
        ${e.demo_batch_count === 0 ? '<div class="callout bad">没有任何已发布演示批次：报名关闭（活动存在但暂不接受新报名）。</div>' : ''}
      </div>
      <div class="card">
        <h3>报名</h3>
        <form id="regForm">
          <label>姓名</label><input name="name" required value="测试顾客">
          <label>邮箱</label><input name="email" required value="guest@example.com">
          <label>备注</label><input name="note" placeholder="选填">
          <label>幂等键（重送时保持不变可安全重试，不会重复占名额；点两次按钮即可验证）</label>
          <input name="idempotency_key" value="web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}">
          <button class="btn" ${e.open ? '' : 'disabled'}>${e.open ? '提交报名' : '报名未开放'}</button>
        </form>
        <div id="regResult"></div>
      </div>
    </div>`;
  document.getElementById('regForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const body = Object.fromEntries(new FormData(f).entries());
    try {
      const r = await API.post(`/api/events/${id}/register`, body);
      document.getElementById('regResult').innerHTML =
        `<div class="callout ok">${r.deduped ? '检测到重送（幂等键相同）：已更新信息，<b>未重复占用名额</b>。' : '报名成功！'}
          当前状态：${statusTag(r.registration.status)}；剩余名额 ${r.availability.spots_left}</div>`;
      setTimeout(() => eventPage(view, id), 1200);
    } catch (err) { toast(err.message, true); }
  };
}
