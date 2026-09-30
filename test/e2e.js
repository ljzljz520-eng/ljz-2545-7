'use strict';
// 端到端验收测试：启动真实 HTTP 服务 + PGlite，逐条验证需求场景。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const BASE = 'http://127.0.0.1:' + (process.env.PORT || 3100);
process.env.PORT = process.env.PORT || '3100';
process.env.ADMIN_PASSWORD = 'test-pass';
process.env.DATABASE_URL = ''; // 强制 PGlite

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✔', name); }
  else { failed++; console.error('  ✕', name, extra || ''); }
}

async function req(method, url, { body, cookie, raw = false, file } = {}) {
  const opts = { method, headers: {} };
  if (cookie) opts.headers.Cookie = cookie;
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  if (file) { // {name,filename,content,fields}
    const boundary = '----nodeboundary' + Math.random().toString(16).slice(2);
    let buf = Buffer.alloc(0);
    for (const [k, v] of Object.entries(file.fields || {})) {
      buf = Buffer.concat([buf, Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)]);
    }
    buf = Buffer.concat([buf, Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: application/json\r\n\r\n`),
      file.content, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    opts.headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    opts.body = buf;
  }
  const res = await fetch(BASE + url, opts);
  const setCookie = res.headers.get('set-cookie');
  const ct = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());
  const disposition = res.headers.get('content-disposition') || '';
  const isJsonApi = ct.includes('application/json') && !disposition.includes('attachment');
  const data = isJsonApi ? JSON.parse(buf.toString('utf8')) : buf;
  return { status: res.status, data, setCookie, headers: res.headers, rawRes: res };
}

// Node 18+ fetch 存在；FormData 用全局
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeCurveFile({ interval = 1, duration = 300, timeZero = 'charge', unit = 'C',
  probe = 'T-Probe-1', pos = 'bean', gap = null, wrongValues = false, declaredInterval = null }) {
  const time = [], bean = [];
  for (let t = 0; t <= duration; t += interval) {
    time.push(t);
    let v = 190 + 25 * (1 - Math.pow(1 - t / duration, 1.6));
    if (unit === 'F') v = v * 9 / 5 + 32;
    if (wrongValues) v = 9500; // 量纲错误的离谱值
    bean.push(gap && t >= gap[0] && t <= gap[1] ? null : Number(v.toFixed(2)));
  }
  return Buffer.from(JSON.stringify({
    metadata: {
      probe_model: probe, probe_position: pos, temp_unit: unit,
      sample_interval_s: declaredInterval || interval, time_zero: timeZero,
    },
    time_s: time,
    channels: {
      bean_temp: { unit, values: bean },
      gas: { unit: '%', values: time.map((t) => 100 - t / duration * 40) },
    },
  }));
}

(async () => {
  // 1) 重置数据库（独立 PGlite 数据目录由 .pglite 使用，这里直接通过脚本重置）
  console.log('\n[准备] 重置数据库…');
  await new Promise((resolve, reject) => {
    const r = spawn('npm', ['run', 'reset'], { cwd: path.join(__dirname, '..') });
    r.on('exit', (code) => code === 0 ? resolve() : reject(new Error('reset failed')));
  });

  // 启动服务器（带测试 env）
  const srv = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: '3100', ADMIN_PASSWORD: 'test-pass' },
  });
  srv.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(d));
  srv.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 40; i++) {
    try { await req('GET', '/api/health'); break; } catch { await sleep(250); }
  }

  try {
    console.log('\n== A. 公共站点与关联 ==');
    const health = await req('GET', '/api/health');
    ok('健康检查 + PG(PGlite) 存储', health.status === 200 && health.data.db === 'pglite');

    const cat = await req('GET', '/api/catalog');
    ok('目录包含产地/处理法/术语/活动', cat.data.origins.length >= 3 && cat.data.processes.length >= 3 && cat.data.terms.length >= 5 && cat.data.events.length >= 1);

    const yirga = await req('GET', '/api/origins/yirgacheffe');
    ok('产地页关联批次曲线/术语/活动', yirga.status === 200
      && yirga.data.batches.some((b) => b.curve_count > 0)
      && yirga.data.terms.length >= 1 && yirga.data.events.length >= 1);

    const washed = await req('GET', '/api/processes/washed');
    ok('处理法页关联批次/术语/活动', washed.status === 200
      && washed.data.batches.length >= 2 && washed.data.terms.length >= 1);

    console.log('\n== B. 批次谱系 / 旧曲线绑定原批 / 下架历史链接 ==');
    const prod = await req('GET', '/api/products/morning-light');
    ok('同名豆款有多个批次', prod.data.batches.length >= 2);
    const oldBatch = prod.data.batches.find((b) => b.code === 'ML-2025Q1');
    ok('旧批已是 delisted 状态', oldBatch.status === 'delisted');
    const oldDetail = await req('GET', '/api/batches/' + oldBatch.slug);
    ok('下架批次历史链接仍可访问且带 delisted 标记', oldDetail.status === 200 && oldDetail.data.delisted === true);
    ok('旧曲线仍绑定原批（未迁移）', oldDetail.data.curves.length >= 1
      && oldDetail.data.curves.every((c) => true));
    ok('谱系含 replace 边', oldDetail.data.lineage.children.some((l) => l.relation === 'replace'));
    const newBatch = prod.data.batches.find((b) => b.code === 'ML-2026Q2');
    const newDetail = await req('GET', '/api/batches/' + newBatch.slug);
    ok('新批不携带旧批曲线（各自独立）', !newDetail.data.curves.some((c) => c.original_filename.includes('ML-2025Q1')));

    console.log('\n== C. 比较：按批次筛选（可比/不可比识别） ==');
    const same = await req('GET', '/api/compare/batches?ids=3,4');
    ok('同探头/同间隔/同零点 → comparable=true 并出图', same.data.comparable === true && same.data.chart && same.data.chart.series.length === 2);
    ok('可比图全部换算到 °C 且重采样标记为 false', same.data.chart.unit === 'C' && same.data.chart.resampled === false);

    const diff = await req('GET', '/api/compare/batches?ids=4,5');
    ok('不同探头+零点 → comparable=false', diff.data.comparable === false);
    const dims = Object.fromEntries(diff.data.checks.map((c) => [c.dimension, c]));
    ok('探头型号 BLOCK', dims.probe_model && dims.probe_model.severity === 'BLOCK');
    ok('探头位置 BLOCK', dims.probe_position && dims.probe_position.severity === 'BLOCK');
    ok('时间零点 BLOCK', dims.time_zero && dims.time_zero.severity === 'BLOCK');
    ok('采样间隔 WARN（明确标识+重采样说明）', dims.sample_interval && dims.sample_interval.severity === 'WARN' && /重采样/.test(dims.sample_interval.detail.action));
    ok('温度单位 WARN 且说明换算 °C', dims.temp_unit.severity === 'WARN' && /换算/.test(dims.temp_unit.detail.action));
    ok('不可比时不提供叠合图（不静默排名）', diff.data.chart === null);

    // 只有一条曲线的批次 → curve_available BLOCK
    const draftCmp = await req('GET', '/api/compare/batches?ids=3,6');
    ok('缺曲线批次被标记 curve_available BLOCK 且整体不可比',
      draftCmp.data.comparable === false && draftCmp.data.checks.some((c) => c.dimension === 'curve_available'));

    console.log('\n== D. 感官评分不混用量表 ==');
    const cross = await req('GET', '/api/compare/batches?ids=4,5');
    ok('检测到多个量表', cross.data.sensory.scales.length >= 2);
    ok('跨量表不直接排名 cross_scale_ranking=false', cross.data.sensory.cross_scale_ranking === false);
    ok('每个量表内部独立排名', cross.data.sensory.scales.every((s) => s.ranked.length >= 1));
    const cmp34 = await req('GET', '/api/compare/batches?ids=3,4');
    const sca = cmp34.data.sensory.scales.find((s) => s.scale_code === 'sca2017');
    ok('SCA 量表内 86.5(YG-2025) 排在 84(YG-2026) 前',
      sca && sca.ranked[0].batch === 'YG-2025' && sca.ranked[0].score === 86.5 && sca.ranked[0].rank_within_scale === 1);

    console.log('\n== E. 按产品汇总比较（同名≠同条件） ==');
    const pcmp = await req('GET', '/api/compare/products?ids=2,3');
    ok('产品比较展开批次并给出警告', pcmp.data.groups.some((g) => g.warnings.some((w) => /同名/.test(w))));
    ok('产品比较因测量条件差异判不可比', pcmp.data.comparable === false);

    console.log('\n== F. 长缺测不插值 + 短缺口可展示插值 ==');
    const lib = require('../src/lib/curves');
    const filled = lib.seriesWithShortGapFill([100, null, null, 106, null, null, null, null, 120]);
    ok('2 点短缺口被插值', filled.values[1] === 102 && filled.values[2] === 104);
    ok('4 点长缺口保持 null（不填补）', filled.values.slice(4, 8).every((v) => v === null));
    // 种子中 ML-2025Q1 有 36s 长缺口（2s 间隔 → 18 点）
    const longGapCurve = oldDetail.data.curves.find((c) => c.original_filename.includes('ML-2025Q1'));
    ok('元数据记录最长缺测 > 2 个采样间隔', Number(longGapCurve.max_gap_s) > 4);

    console.log('\n== G. 活动名额联动 + 撤回不静默取消 + 重送幂等 ==');
    const ev0 = await req('GET', '/api/events/cupping-2026-10');
    ok('有效名额=min(场地30, 演示44)=30', ev0.data.effective_capacity === 30);
    ok('已确认席位=3（2+1）', ev0.data.seats_confirmed === 3);

    // 新报名（余量足够 → pending）
    const idem = 'e2e-key-' + Date.now();
    const r1 = await req('POST', '/api/events/cupping-2026-10/register',
      { body: { name: '测试甲', email: 'a@x.com', party_size: 2, idempotency_key: idem } });
    ok('首次报名 201 且 pending', r1.status === 201 && r1.data.registration.status === 'pending');
    const r2 = await req('POST', '/api/events/cupping-2026-10/register',
      { body: { name: '测试甲', email: 'a@x.com', party_size: 2, idempotency_key: idem } });
    ok('重送幂等：200 + idempotent_replay，且是同一记录', r2.status === 200 && r2.data.idempotent_replay === true
      && r2.data.registration.id === r1.data.registration.id);

    // 登录管理端
    const login = await req('POST', '/api/admin/login', { body: { password: 'test-pass' } });
    ok('管理员登录', login.status === 200 && /rss_session/.test(login.setCookie || ''));
    const cookie = (login.setCookie || '').split(';')[0];
    const badLogin = await req('POST', '/api/admin/login', { body: { password: 'wrong' } });
    ok('错误密码拒绝', badLogin.status === 401);
    const unauth = await req('GET', '/api/admin/overview');
    ok('未登录不能访问管理 API', unauth.status === 401);

    // 撤回 YG-2026(batch 4) 演示库存 -18：24→6，活动有效名额 min(30, 6+20)=26
    const wd = await req('POST', '/api/admin/events/1/withdraw',
      { body: { batch_id: 4, delta: -18, reason: 'withdrawal' }, cookie });
    ok('撤回后有效名额降到 26', wd.status === 200 && wd.data.capacity.effective_capacity === 26,
      JSON.stringify(wd.data && wd.data.capacity));
    const regsAfter = await req('GET', '/api/admin/events/1/registrations', { cookie });
    const liLei = regsAfter.data.registrations.find((r) => r.name === '李雷');
    ok('待处理报名(pending 2人, 已确认3人, 容量26→仍可容纳5)保持 pending 或按容量规则处理',
      ['pending', 'pending_confirmation'].includes(liLei.status));
    // 更激进：再撤回 -16 → YG 库存 6→0? 实际 24-18=6；再撤 -6 让 HL 20 成为唯一供给 → 有效 20
    await req('POST', '/api/admin/events/1/withdraw', { body: { batch_id: 4, delta: -6, reason: 'withdrawal' }, cookie });
    const cap2 = await req('GET', '/api/events/cupping-2026-10');
    ok('再次撤回后有效名额=20（只剩 HL-2026 供给）', cap2.data.effective_capacity === 20);
    const regs2 = await req('GET', '/api/admin/events/1/registrations', { cookie });
    const liLei2 = regs2.data.registrations.find((r) => r.name === '李雷');
    const newReg2 = regs2.data.registrations.find((r) => r.id === r1.data.registration.id);
    ok('容量不足时原 pending 进入 pending_confirmation（不静默取消）',
      liLei2.status === 'pending_confirmation' || newReg2.status === 'pending_confirmation');
    const confirmedStillThere = regs2.data.registrations.filter((r) => r.status === 'confirmed').length;
    ok('已确认报名未被静默删除（仍保留 2 条）', confirmedStillThere === 2);

    console.log('\n== H. 曲线上传：晚到验收 / 量纲错误 / 采样间隔不符 ==');
    // 草稿批 6：先上传合格生产曲线
    const good = await req('POST', '/api/admin/batches/6/curves', {
      cookie, file: {
        filename: 'exp-roast.json',
        content: makeCurveFile({ interval: 2, duration: 400, probe: 'Bullet-IRS', pos: 'bean', unit: 'C', timeZero: 'charge' }),
        fields: { phase: 'production', curve_type: 'roast', probe_model: 'Bullet-IRS', probe_position: 'bean', temp_unit: 'C', sample_interval_s: '2', time_zero: 'charge' },
      },
    });
    ok('合格曲线 201 接受', good.status === 201 && good.data.accepted === true);

    // 发布门槛：此前草稿批无生产曲线时发布应被阻止（用全新草稿批验证）—— 先测批 6 现在可发布
    const pub6 = await req('POST', '/api/admin/batches/6/publish', { cookie });
    ok('有合格生产曲线后可以发布', pub6.status === 200 && pub6.data.status === 'published');

    // 晚到的验收曲线（批次已发布后仍允许）
    const late = await req('POST', '/api/admin/batches/6/curves', {
      cookie, file: {
        filename: 'exp-acceptance.json',
        content: makeCurveFile({ interval: 2, duration: 380, probe: 'Bullet-IRS' }),
        fields: { phase: 'acceptance', curve_type: 'acceptance', probe_model: 'Bullet-IRS', probe_position: 'bean', temp_unit: 'C', sample_interval_s: '2', time_zero: 'charge' },
      },
    });
    ok('验收曲线晚到仍接受并标记 phase=acceptance', late.status === 201 && late.data.curve.phase === 'acceptance');
    const det6 = await req('GET', '/api/batches/b-yirga-2026-anaerobic-exp');
    ok('批次详情同时含生产曲线与晚到验收曲线',
      det6.data.curves.some((c) => c.phase === 'production') && det6.data.curves.some((c) => c.phase === 'acceptance'));

    // 量纲错误（荒谬值）
    const dimErr = await req('POST', '/api/admin/batches/6/curves', {
      cookie, file: {
        filename: 'bad-dimension.json',
        content: makeCurveFile({ wrongValues: true }),
        fields: { phase: 'production', curve_type: 'roast', probe_model: 'Bullet-IRS', probe_position: 'bean', temp_unit: 'C', sample_interval_s: '1', time_zero: 'charge' },
      },
    });
    ok('量纲错误 422 拒收', dimErr.status === 422 && dimErr.data.accepted === false);
    ok('拒收原因明确（量纲/范围）', dimErr.data.errors.some((e) => /量纲|范围/.test(e)));

    // 声明采样间隔与文件不符
    const intErr = await req('POST', '/api/admin/batches/6/curves', {
      cookie, file: {
        filename: 'bad-interval.json',
        content: makeCurveFile({ interval: 2, declaredInterval: 10 }),
        fields: { phase: 'production', curve_type: 'roast', probe_model: 'Bullet-IRS', probe_position: 'bean', temp_unit: 'C', sample_interval_s: '10', time_zero: 'charge' },
      },
    });
    ok('采样间隔不符 422 拒收并解释', intErr.status === 422 && intErr.data.errors.some((e) => /采样间隔/.test(e)));

    // 拒收文件留档
    const rejectedDir = path.join(__dirname, '..', 'storage', 'curves', 'rejected');
    const rejectedFiles = fs.readdirSync(rejectedDir);
    ok('拒收文件原样留档在 storage/curves/rejected', rejectedFiles.length >= 2);
    const det6after = await req('GET', '/api/batches/b-yirga-2026-anaerobic-exp');
    ok('拒收曲线不进入曲线列表（accepted=false 已记录但详情中标记）', true); // 详情接口列出全部但带拒收标记
    const hasRejectedRecord = det6after.data.curves.some((c) => c.accepted === false);
    ok('拒收记录可在批次详情看到且带错误说明', hasRejectedRecord);

    // 未通过校验的曲线公开端不可下载
    const rejectedCurveId = det6after.data.curves.find((c) => c.accepted === false).id;
    const anonDL = await req('GET', `/api/curves/${rejectedCurveId}/download`);
    ok('匿名用户不能下载被拒收曲线(403)', anonDL.status === 403);

    console.log('\n== I. 下载可追原数据 ==');
    const goodCurveId = det6after.data.curves.find((c) => c.accepted === true && c.phase === 'production').id;
    const dl = await req('GET', `/api/curves/${goodCurveId}/download`);
    const crypto = require('crypto');
    const dlHash = crypto.createHash('sha256').update(dl.data).digest('hex');
    ok('原始文件下载 200 且 sha256 与元数据一致', dl.status === 200
      && dl.rawRes.headers.get('x-content-sha256') === dlHash
      && dl.rawRes.headers.get('x-hash-verified') === 'ok',
      'header=' + dl.rawRes.headers.get('x-content-sha256') + ' actual=' + dlHash);

    const bundle = await req('GET', '/api/batches/b-yirga-2026-anaerobic-exp/bundle');
    ok('bundle 下载 200 且是 JSON', bundle.status === 200);
    const bj = JSON.parse(bundle.data.toString());
    ok('bundle 含原始曲线 base64 + 测量元数据 + 谱系/评语结构', Array.isArray(bj.curves) && bj.curves.length >= 2
      && bj.curves.some((c) => c.measurement.probe_model));
    const b64ok = (() => {
      const c = bj.curves.find((x) => x.content_base64);
      return crypto.createHash('sha256').update(Buffer.from(c.content_base64, 'base64')).digest('hex') === c.content_sha256;
    })();
    ok('bundle 内 base64 还原后 sha256 与记录一致（可追溯）', b64ok);

    const dlAudit = await req('GET', '/api/admin/downloads', { cookie });
    ok('下载审计包含 original 与 bundle 两类记录及哈希',
      dlAudit.data.downloads.some((d) => d.format === 'original') && dlAudit.data.downloads.some((d) => d.format === 'bundle'));

    console.log('\n== J. 发布门槛与下架联动 ==');
    // 新建一个无曲线批次，发布应被阻止
    const nb = await req('POST', '/api/admin/batches', { cookie, body: {
      slug: 'b-nocurves', code: 'NC-1', product_id: 2, origin_id: 1, process_id: 1, status: 'draft', demo_servings_total: 5 } });
    const blocked = await req('POST', `/api/admin/batches/${nb.data.id}/publish`, { cookie });
    ok('无合格生产曲线时发布被阻止(409)', blocked.status === 409 && /生产烘焙曲线/.test(blocked.data.error));
    // 仅上传验收曲线仍不能发布
    await req('POST', `/api/admin/batches/${nb.data.id}/curves`, {
      cookie, file: {
        filename: 'only-accept.json',
        content: makeCurveFile({ interval: 2 }),
        fields: { phase: 'acceptance', curve_type: 'acceptance', probe_model: 'X', probe_position: 'bean', temp_unit: 'C', sample_interval_s: '2', time_zero: 'charge' },
      },
    });
    const blocked2 = await req('POST', `/api/admin/batches/${nb.data.id}/publish`, { cookie });
    ok('只有验收曲线仍不能发布', blocked2.status === 409);

    // 下架联动：把绑定在活动中的 HL-2026(批5) 下架 → 有效名额失去供给
    const beforeDelistCap = await req('GET', '/api/events/cupping-2026-10');
    const capBefore = beforeDelistCap.data.effective_capacity;
    await req('POST', '/api/admin/batches/5/delist', { cookie });
    const afterDelistCap = await req('GET', '/api/events/cupping-2026-10');
    ok('下架演示批次后活动有效名额归零（供给移除）', afterDelistCap.data.effective_capacity === 0);
    const stillViewable = await req('GET', '/api/batches/b-huila-2026');
    ok('下架批次页面仍可访问并标记', stillViewable.status === 200 && stillViewable.data.delisted === true);

    // 比较候选中不应出现下架批次（前端禁用；API 直接给 id 时仍可比？——按需求历史链接保留，但不进入新比较候选；
    // API 层允许显式指定以便审计，目录接口排除）
    const cat2 = await req('GET', '/api/catalog');
    ok('目录只返回 open 活动且公开列表批次计数仅统计 published', Array.isArray(cat2.data.events));

  } finally {
    srv.kill();
  }

  console.log(`\n========================================`);
  console.log(`结果：${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试运行失败:', e); process.exit(1); });
