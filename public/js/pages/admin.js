async function adminPage(view, sub) {
  if (!API.token) return loginView(view);
  try { await API.get('/api/admin/scales'); } catch { API.logout(); return loginView(view); }
  const tab = sub || 'batches';
  view.innerHTML = `
    <h1>后台 <button class="btn ghost small" id="logoutBtn" style="float:right">退出</button></h1>
    <div class="pill-nav">
      ${[['batches', '批次谱系/发布'], ['curves', '曲线验收'], ['sensory', '感官评语'], ['events', '活动/报名'], ['acceptance', '验收演练']]
        .map(([k, t]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${t}</button>`).join('')}
    </div>
    <div id="adminBody"></div>`;
  document.getElementById('logoutBtn').onclick = () => { API.logout(); location.hash = '#/admin'; };
  view.querySelectorAll('button[data-tab]').forEach((b) => b.onclick = () => location.hash = '#/admin/' + b.dataset.tab);
  const body = document.getElementById('adminBody');
  if (tab === 'curves') await curvesTab(body);
  else if (tab === 'sensory') await sensoryTab(body);
  else if (tab === 'events') await eventsTab(body);
  else if (tab === 'acceptance') await acceptanceTab(body);
  else await batchesTab(body);
}

function loginView(view) {
  view.innerHTML = `<div class="admin-login card">
    <h2>后台登录</h2>
    <label>账号</label><input id="u" value="admin">
    <label>密码</label><input id="p" type="password" value="roast2026">
    <button class="btn" id="loginBtn">登录</button>
    <p class="meta">演示账号 admin / roast2026</p>
  </div>`;
  document.getElementById('loginBtn').onclick = async () => {
    try { await API.login(document.getElementById('u').value, document.getElementById('p').value); location.hash = '#/admin/batches'; }
    catch (e) { toast(e.message, true); }
  };
}

async function batchesTab(body) {
  const bs = await API.get('/api/admin/batches');
  body.innerHTML = `
    <div class="callout">发布前置：至少一条 <b>已验收</b> 曲线。撤回批次会联动活动报名转“待确认”。</div>
    <div class="card"><h3>新建批次（可挂 parent_id 形成谱系）</h3>
      <div class="two-col">
        <div><label>批次号 code</label><input id="nCode" placeholder="XXX-2026-00">
        <label>产品 ID</label><input id="nProd" type="number">
        <label>产地 ID</label><input id="nOrigin" type="number">
        <label>处理法 ID</label><input id="nProc" type="number"></div>
        <div><label>父批次 ID（换批/迭代）</label><input id="nParent" type="number">
        <label>换批备注 lineage_note</label><input id="nNote" placeholder="如：更换探头位置 / 新产季">
        <label>烘焙日期</label><input id="nDate" type="date" value="2026-09-30"></div>
      </div>
      <button class="btn" id="nBtn">创建（草稿）</button>
    </div>
    <table style="margin-top:14px"><tr><th>ID</th><th>批次号</th><th>豆款</th><th>日期</th><th>状态</th><th>谱系</th><th>操作</th></tr>
    ${bs.map((b) => `<tr>
      <td>${b.id}</td><td><a href="#/batch/${b.id}">${esc(b.code)}</a></td>
      <td>${esc(b.brand)} ${esc(b.product_name)}</td>
      <td>${fmtDate(b.roast_date)}</td><td>${statusTag(b.status)}</td>
      <td>${b.parent_id ? `父:#${b.parent_id}` : '—'}${b.lineage_note ? `<br><span class="meta">${esc(b.lineage_note)}</span>` : ''}</td>
      <td style="white-space:nowrap">
        ${b.status !== 'published' ? `<button class="btn small" data-pub="${b.id}">发布</button>` : `<button class="btn small danger" data-wd="${b.id}">撤回</button>`}
        ${b.status === 'withdrawn' ? `<button class="btn small ghost" data-re="${b.id}">重发</button>` : ''}
      </td></tr>`).join('')}
    </table>`;
  document.getElementById('nBtn').onclick = async () => {
    try {
      const v = (id) => document.getElementById(id).value;
      await API.adminPost('/api/admin/batches', {
        code: v('nCode'), product_id: v('nProd') || null, origin_id: v('nOrigin') || null,
        process_id: v('nProc') || null, parent_id: v('nParent') || null, lineage_note: v('nNote'),
        roast_date: v('nDate'),
      });
      toast('已创建草稿批次'); batchesTab(body);
    } catch (e) { toast(e.message, true); }
  };
  body.querySelectorAll('[data-pub]').forEach((btn) => btn.onclick = async () => {
    try { await API.adminPost(`/api/admin/batches/${btn.dataset.pub}/publish`, {}); toast('已发布'); batchesTab(body); }
    catch (e) { toast(e.message, true); }
  });
  body.querySelectorAll('[data-wd]').forEach((btn) => btn.onclick = async () => {
    const reason = prompt('撤回原因（将记录到报名事件日志）', '库存撤回/质量复检') || '';
    try { const r = await API.adminPost(`/api/admin/batches/${btn.dataset.wd}/withdraw`, { reason });
      toast(`已撤回；${r.registrations_moved} 条报名转入待确认（未静默取消）`); batchesTab(body);
    } catch (e) { toast(e.message, true); }
  });
  body.querySelectorAll('[data-re]').forEach((btn) => btn.onclick = async () => {
    const r = await API.adminPost(`/api/admin/batches/${btn.dataset.re}/republish`, {});
    toast(r.note); batchesTab(body);
  });
}

async function curvesTab(body) {
  const [pending, batches] = await Promise.all([API.get('/api/admin/curves/pending'), API.get('/api/admin/batches')]);
  body.innerHTML = `
    <div class="two-col">
      <div class="card"><h3>提交曲线 CSV（独立文件存储 + 元数据入 PG）</h3>
        <label>批次</label><select id="cBatch">${batches.map((b) => `<option value="${b.id}">#${b.id} ${esc(b.code)} (${b.status})</option>`).join('')}</select>
        <div class="two-col">
          <div><label>探头</label><select id="cProbe"><option>BT</option><option>ET</option><option>ET_BT</option></select>
          <label>探头位置</label><input id="cPos" value="豆堆中心"></div>
          <div><label>采样间隔(s)</label><input id="cInt" value="2">
          <label>单位</label><select id="cUnit"><option value="C">°C</option><option value="F">°F</option></select></div>
        </div>
        <label>时间零点</label><select id="cZero"><option value="roast_start">烘焙开始</option><option value="turning_point">回温点</option><option value="first_crack">一爆</option><option value="charge">下豆</option></select>
        <label><input type="checkbox" id="cLate" style="width:auto"> 晚到补录（批次发布后到达）</label><br>
        <label>CSV 文件（time_s,et_c,bt_c；缺测留空）</label><input type="file" id="cFile" accept=".csv,text/csv">
        <button class="btn" id="cBtn">上传提交</button>
      </div>
      <div class="card"><h3>待验收 / 待修正（${pending.length}）</h3>
        ${pending.length ? `<table><tr><th>ID</th><th>批次</th><th>文件</th><th>问题</th><th>状态</th><th>操作</th></tr>
        ${pending.map((c) => `<tr><td>${c.id}</td><td>${esc(c.batch_code)}${c.is_late ? ' <span class="tag warn">晚到</span>' : ''}</td>
          <td class="meta">${esc(c.source_filename)}</td>
          <td class="meta">${esc(c.reject_reason || '—')}<br>缺测 ${c.max_gap_samples} 点</td>
          <td>${statusTag(c.review_status)}</td>
          <td style="white-space:nowrap">
            <button class="btn small" data-acc="${c.id}">验收</button>
            <button class="btn small danger" data-rej="${c.id}">拒收</button></td></tr>`).join('')}</table>`
        : '<p class="meta">没有待处理曲线</p>'}
      </div>
    </div>`;
  document.getElementById('cBtn').onclick = async () => {
    const f = document.getElementById('cFile').files[0];
    if (!f) return toast('请选择 CSV', true);
    const fd = new FormData();
    fd.append('file', f);
    fd.append('probe_type', document.getElementById('cProbe').value);
    fd.append('probe_position', document.getElementById('cPos').value);
    fd.append('sampling_interval_s', document.getElementById('cInt').value);
    fd.append('time_zero', document.getElementById('cZero').value);
    fd.append('temp_unit', document.getElementById('cUnit').value);
    if (document.getElementById('cLate').checked) fd.append('late', '1');
    try { const r = await API.upload(`/api/admin/batches/${document.getElementById('cBatch').value}/curves`, fd);
      toast((r.parse_problems || []).length ? '提交成功但需修正：' + r.parse_problems.join('；') : r.note); curvesTab(body);
    } catch (e) { toast(e.message, true); }
  };
  body.querySelectorAll('[data-acc]').forEach((b) => b.onclick = async () => {
    const override = confirm('确认验收？\n（量纲可疑时点“取消”，需先修正；如确为人工判断正确请再次尝试并留痕）');
    try { await API.adminPost(`/api/admin/curves/${b.dataset.acc}/review`, { action: 'accept' }); toast('已验收'); curvesTab(body); }
    catch (e) {
      if (override && confirm(`${e.message}\n是否人工豁免(override)接受？`)) {
        await API.adminPost(`/api/admin/curves/${b.dataset.acc}/review`, { action: 'accept', reason: 'override' });
        toast('已豁免验收（已留痕）'); curvesTab(body);
      } else toast(e.message, true);
    }
  });
  body.querySelectorAll('[data-rej]').forEach((b) => b.onclick = async () => {
    const reason = prompt('拒收原因', '量纲/缺测不达标') || '';
    await API.adminPost(`/api/admin/curves/${b.dataset.rej}/review`, { action: 'reject', reason });
    curvesTab(body);
  });
}

async function sensoryTab(body) {
  const [batches, scales] = await Promise.all([API.get('/api/admin/batches'), API.get('/api/admin/scales')]);
  body.innerHTML = `<div class="card"><h3>录入感官评语（必须选择量表，分值校验量表范围）</h3>
    <div class="two-col">
      <div><label>批次</label><select id="sBatch">${batches.map((b) => `<option value="${b.id}">${esc(b.code)}</option>`).join('')}</select>
      <label>量表</label><select id="sScale">${scales.map((s) => `<option value="${s.code}">${esc(s.code)} (${s.min_score}–${s.max_score})</option>`).join('')}</select></div>
      <div><label>评分</label><input id="sScore" type="number" step="0.5">
      <label>评审</label><input id="sCupper" value="Lin">
      <label>风味标签（逗号分隔）</label><input id="sTags" value="花香,柑橘">
      <label>评语</label><input id="sNotes"></div>
    </div>
    <button class="btn" id="sBtn">保存评语</button></div>
    <div class="callout">量表在创建评语时固定保存；后续比较中不同量表分组，不互相归一化后直接排名。</div>`;
  document.getElementById('sBtn').onclick = async () => {
    try {
      await API.adminPost(`/api/admin/batches/${document.getElementById('sBatch').value}/sensory`, {
        scale_code: document.getElementById('sScale').value,
        score: document.getElementById('sScore').value,
        cupper: document.getElementById('sCupper').value,
        notes: document.getElementById('sNotes').value,
        flavor_tags: document.getElementById('sTags').value.split(',').map((x) => x.trim()).filter(Boolean),
      });
      toast('评语已保存');
    } catch (e) { toast(e.message, true); }
  };
}

async function eventsTab(body) {
  const evs = await API.get('/api/admin/events');
  body.innerHTML = `<h2>活动与报名处理</h2>
    ${(await Promise.all(evs.map(async (e) => {
      const [reg, detail] = await Promise.all([
        API.get(`/api/admin/events/${e.id}/registrations`),
        API.get(`/api/events/${e.id}`)]);
      return `<div class="card" style="margin:10px 0">
        <h3>${esc(e.title)} <span class="meta">${fmtDT(e.held_on)} · 名额 ${e.capacity}（剩 ${detail.event.spots_left}，演示批次 ${detail.event.demo_batch_count}）</span></h3>
        <div class="meta">关联批次：${detail.demo_batches.map((b) => `${esc(b.code)}${statusTag(b.status)}`).join(' ')}</div>
        <table style="margin-top:8px"><tr><th>ID</th><th>姓名</th><th>邮箱</th><th>状态</th><th>更新时间</th><th>操作</th></tr>
        ${reg.map((r) => `<tr><td>${r.id}</td><td>${esc(r.name)}</td><td>${esc(r.email)}</td>
          <td>${statusTag(r.status)}</td><td class="meta">${fmtDT(r.updated_at)}</td>
          <td>${r.status === 'pending_confirmation' ? `<button class="btn small" data-cf="${r.id}">人工确认</button>` : ''}
          ${r.status !== 'cancelled' ? `<button class="btn small danger" data-cx="${r.id}">取消</button>` : ''}</td></tr>`).join('')}
        ${reg.length === 0 ? '<tr><td colspan="6" class="meta">暂无报名</td></tr>' : ''}
        </table></div>`;
    }))).join('')}`;
  body.querySelectorAll('[data-cf]').forEach((b) => b.onclick = async () => {
    await API.adminPost(`/api/admin/registrations/${b.dataset.cf}/confirm`, {}); toast('已人工确认'); eventsTab(body);
  });
  body.querySelectorAll('[data-cx]').forEach((b) => b.onclick = async () => {
    await API.adminPost(`/api/admin/registrations/${b.dataset.cx}/cancel`, {}); eventsTab(body);
  });
}

async function acceptanceTab(body) {
  body.innerHTML = `<h2>验收演练（一键串联需求中的关键场景）</h2>
  <div class="card">
    <p>点击按钮按顺序演练：① 撤回在售演示批次 → ② 检查活动名额与报名状态 → ③ 晚到曲线提交 → ④ 量纲错误提交 → ⑤ 报名重送幂等 → ⑥ 下架历史链接与下载追溯。</p>
    <button class="btn" id="runAll">运行验收序列</button>
    <pre id="accLog" style="margin-top:12px;min-height:200px"></pre>
  </div>`;
  const log = document.getElementById('accLog');
  const out = (m) => { log.textContent += `\n${new Date().toLocaleTimeString('zh-CN', { hour12: false })}  ${m}`; log.scrollTop = log.scrollHeight; };
  document.getElementById('runAll').onclick = async () => {
    log.textContent = '';
    try {
      // 0) 找一个在售且关联活动的批次（种子：活动1 关联 b1,b2,b6）
      const evBefore = await API.get('/api/events/1');
      out(`[初始] 活动1 已确认=${evBefore.confirmed} 待确认=${evBefore.pending} 剩余=${evBefore.spots_left} 演示批次=${evBefore.demo_batch_count}`);
      // 1) 撤回批次 2（YIR-W-2026-06）
      const w = await API.adminPost('/api/admin/batches/2/withdraw', { reason: '验收演练：库存撤回' });
      out(`[撤回] batch#2 -> 关联活动 ${w.linked_events} 个，报名转待确认 ${w.registrations_moved} 条（非静默取消）`);
      const evMid = await API.get('/api/events/1');
      out(`[联动后] 已确认=${evMid.confirmed} 待确认=${evMid.pending} 剩余=${evMid.spots_left} 可演示批次=${evMid.demo_batch_count}`);
      // 2) 历史链接仍可读
      const hist = await API.get('/api/batches/2');
      out(`[历史链接] /api/batches/2 仍返回 status=${hist.batch.status}，曲线数=${hist.curves.length}`);
      // 3) 晚到曲线
      const csv = 'time_s,et_c,bt_c\n' + Array.from({ length: 30 }, (_, i) => `${i * 2},${(200 + i).toFixed(1)},${(180 + i * 1.7).toFixed(1)}`).join('\n');
      const up1 = await API.upload('/api/admin/batches/2/curves', (() => {
        const fd = new FormData();
        fd.append('file', new File([csv], 'late-after-withdraw.csv', { type: 'text/csv' }));
        fd.append('probe_type', 'BT'); fd.append('probe_position', '豆堆中心');
        fd.append('sampling_interval_s', '2'); fd.append('time_zero', 'roast_start');
        fd.append('temp_unit', 'C'); fd.append('late', '1'); return fd;
      })());
      out(`[晚到曲线] id=${up1.curve.id} is_late=${up1.curve.is_late} 状态=${up1.curve.review_status}（需人工验收，不直接生效）`);
      // 4) 量纲错误
      const bad = 'time_s,bt_c\n' + Array.from({ length: 20 }, (_, i) => `${i * 2},${(356 + i * 3).toFixed(1)}`).join('\n'); // 华氏数值声明 C
      const up2 = await API.upload('/api/admin/batches/4/curves', (() => {
        const fd = new FormData();
        fd.append('file', new File([bad], 'unit-bug.csv', { type: 'text/csv' }));
        fd.append('probe_type', 'BT'); fd.append('probe_position', '豆堆中心');
        fd.append('sampling_interval_s', '2'); fd.append('time_zero', 'roast_start');
        fd.append('temp_unit', 'C'); return fd;
      })());
      out(`[量纲错误] id=${up2.curve.id} 状态=${up2.curve.review_status}；问题：${(up2.parse_problems || []).join('；')}`);
      // 5) 报名重送（同幂等键两次）
      const key = 'acceptance-demo-key';
      const r1 = await API.post('/api/events/1/register', { name: '演练用户', email: 'a@b.c', idempotency_key: key });
      const r2 = await API.post('/api/events/1/register', { name: '演练用户-改名', email: 'a@b.c', idempotency_key: key });
      out(`[报名重送] 首次 deduped=${r1.deduped} 状态=${r1.registration.status}；重送 deduped=${r2.deduped}（同一名额，信息已更新）`);
      // 6) 下载追溯头
      const h = await fetch('/api/curves/1/download');
      out(`[下载追溯] HTTP ${h.status} X-Source-SHA256=${h.headers.get('X-Source-SHA256')?.slice(0, 16)}… 零点=${h.headers.get('X-Time-Zero')} 间隔=${h.headers.get('X-Sampling-Interval-s')}s`);
      // 7) 不可比检查
      const cmp = await API.get('/api/compare?mode=batch&ids=1,2,4,5');
      const badPairs = cmp.pairs.filter((p) => p.verdict === 'incomparable').length;
      out(`[可比检查] 共 ${cmp.pairs.length} 对，其中 ${badPairs} 对不可比（探头/间隔/零点差异被拦截）；同名提示 ${cmp.notes.length} 条`);
      out('✅ 验收序列完成。可到「曲线验收」页处理 needs_fix 项、到「活动/报名」页人工确认待确认报名。');
    } catch (e) { out('❌ ' + e.message); }
  };
}
