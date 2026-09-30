// 端到端验收：先重置种子，再对 HTTP API 断言
import { execSync } from 'node:child_process';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}
async function j(method, path, body, token, isForm) {
  const h = {};
  if (token) h.Authorization = 'Bearer ' + token;
  let payload = body;
  if (body && !isForm) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + path, { method, headers: h, body: payload });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data, headers: r.headers };
}

console.log('— 重置演示数据 —');
execSync('node server/src/seed.js', { stdio: 'inherit' });

console.log('— 1. 产地/处理法页关联批次曲线、术语 —');
{
  const o = (await j('GET', '/api/origins/yirgacheffe')).data;
  ok('产地页含处理法', o.processes.length >= 2);
  ok('产地页含术语', o.terms.length >= 1);
  ok('产地页关联已发布批次（带曲线入口）', o.batches.length >= 2);
  const p = (await j('GET', '/api/processes/wet-hulled')).data;
  ok('处理法页关联产地与术语（下架批次不在公开列表，历史链接仍保留）', p.origins.length === 1 && p.terms.length >= 1);
}

console.log('— 2. 批次谱系 —');
{
  const l = (await j('GET', '/api/batches/2/lineage')).data;
  ok('批次2祖先是批次1（换批谱系）', l.ancestors.some((a) => a.id === 1));
  ok('批次1后代含批次2', (await j('GET', '/api/batches/1/lineage')).data.descendants.some((a) => a.id === 2));
}

console.log('— 3. 可比条件检查（按批次筛选）—');
{
  const cmp = (await j('GET', '/api/compare?mode=batch&ids=1,2,4,5')).data;
  const pairOf = (a, b) => cmp.pairs.find((p) => [p.a, p.b].sort().join() === [a, b].sort().join());
  const yPair = pairOf('YIR-W-2026-03', 'YIR-W-2026-06');
  ok('YIR 两批：探头位置不同被拦截', yPair.checks.find((c) => c.key === 'probe').ok === false);
  ok('YIR 两批：时间零点不同被拦截', yPair.checks.find((c) => c.key === 'timezero').ok === false);
  ok('YIR 两批判定不可比并给解释', yPair.verdict === 'incomparable');
  const hPair = pairOf('HUI-W-2026-04', 'HUI-W-2026-07');
  ok('HUI 两批：采样间隔 5s vs 1.5s 被拦截', hPair.checks.find((c) => c.key === 'sampling').ok === false);
  ok('每个不可比项均有文字解释', cmp.pairs.every((p) => p.checks.every((c) => c.detail && c.label)));
  ok('同品牌多批给出“同名不等于同条件”提示', cmp.notes.some((n) => n.includes('多个批次')));
}

console.log('— 4. 按产品汇总比较 —');
{
  const cmp = (await j('GET', '/api/compare?mode=product&ids=1,3')).data;
  ok('产品模式分组且逐对落到批对批', cmp.groups.length === 2 && cmp.pairs.length >= 1);
  ok('产品模式保留批次编号', cmp.pairs.every((p) => p.a && p.b && p.product_a));
}

console.log('— 5. 缺测：长缺测不填补，短缺口仅显示插值 —');
{
  const pts6 = (await j('GET', '/api/curves/6/points')).data;
  ok('撤回批曲线长缺测保留 null（不填补）', pts6.points.filter((p) => p.bt_c === null).length >= 10);
  ok('长缺测点不被标记为插值', pts6.points.every((p) => !(p.interpolated.bt_c)));
  const pts5 = (await j('GET', '/api/curves/5/points')).data;
  ok('短缺口（<=2点）存在虚线插值点', pts5.points.some((p) => p.interpolated.bt_c));
  ok('原始数据中短缺口位置仍可追溯（点数不变）', pts5.points.length >= 300);
}

console.log('— 6. 感官评分：跨量表不混排 —');
{
  const s = (await j('GET', '/api/compare/sensory?batches=1,4')).data;
  ok('识别出多套量表', s.groups.length >= 2);
  ok('明确不允许跨量表排名', s.ranking_allowed === false && s.explanation.includes('不提供跨量表'));
  ok('每个分组内可排名', s.groups.every((g) => g.rankings.length >= 1));
}

console.log('— 7. 后台登录与发布前置校验 —');
let token;
{
  const bad = await j('POST', '/api/admin/login', { username: 'admin', password: 'wrong' });
  ok('错误密码被拒', bad.status === 401);
  token = (await j('POST', '/api/admin/login', { username: 'admin', password: 'roast2026' })).data.token;
  ok('管理员登录拿令牌', !!token);
  const nb = await j('POST', '/api/admin/batches', {
    code: 'TEST-2026-09', product_id: 1, origin_id: 1, process_id: 1, roast_date: '2026-09-30',
  }, token);
  const pub = await j('POST', `/api/admin/batches/${nb.data.id}/publish`, {}, token);
  ok('无已验收曲线时禁止发布', pub.status === 409);
}

console.log('— 8. 曲线量纲错误拦截 —');
{
  const fd = new FormData();
  const badCsv = 'time_s,bt_c\n' + Array.from({ length: 30 }, (_, i) => `${i * 2},${(350 + i * 2).toFixed(1)}`).join('\n');
  fd.append('file', new Blob([badCsv], { type: 'text/csv' }), 'unit-bug.csv');
  fd.append('probe_type', 'BT'); fd.append('probe_position', '豆堆中心');
  fd.append('sampling_interval_s', '2'); fd.append('time_zero', 'roast_start'); fd.append('temp_unit', 'C');
  const up = await j('POST', '/api/admin/batches/4/curves', fd, token, true);
  ok('量纲错误曲线落 needs_fix', up.data.curve.review_status === 'needs_fix');
  ok('量纲问题被解析器指出', (up.data.parse_problems || []).some((m) => m.includes('华氏')));
  const acc = await j('POST', `/api/admin/curves/${up.data.curve.id}/review`, { action: 'accept' }, token);
  ok('量纲可疑曲线不能直接验收', acc.status === 409);
  const ov = await j('POST', `/api/admin/curves/${up.data.curve.id}/review`, { action: 'accept', reason: 'override' }, token);
  ok('人工 override 可豁免（留痕）', ov.status === 200);
}

console.log('— 9. 曲线晚到补录 —');
{
  const fd = new FormData();
  const csv = 'time_s,et_c,bt_c\n' + Array.from({ length: 40 }, (_, i) =>
    `${i * 2},${(205 + i * 0.6).toFixed(1)},${(185 + i * 1.2).toFixed(1)}`).join('\n');
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'late.csv');
  fd.append('probe_type', 'BT'); fd.append('probe_position', '豆堆中心');
  fd.append('sampling_interval_s', '2'); fd.append('time_zero', 'roast_start');
  fd.append('temp_unit', 'C'); fd.append('late', '1');
  const up = await j('POST', '/api/admin/batches/2/curves', fd, token, true);
  ok('晚到曲线标记 is_late', up.data.curve.is_late === true);
  ok('晚到曲线需修正/验收不自动生效', ['needs_fix', 'pending'].includes(up.data.curve.review_status));
}

console.log('— 10. 库存撤回联动：报名转待确认而非静默取消 —');
{
  const before = (await j('GET', '/api/events/1')).data.event;
  const seedRegs = before.confirmed;
  const w = await j('POST', '/api/admin/batches/1/withdraw', { reason: '验收测试撤回' }, token);
  ok('撤回返回被联动的报名数', w.data.registrations_moved === seedRegs && w.data.registrations_moved >= 1);
  const after = (await j('GET', '/api/events/1')).data.event;
  ok('原已确认报名转为 pending_confirmation', after.pending === seedRegs && after.confirmed === 0);
  ok('待确认仍占名额（不超卖）', after.spots_left === after.capacity - (after.pending + after.confirmed));
  const regs = (await j('GET', '/api/admin/events/1/registrations', null, token)).data;
  ok('报名记录仍存在（未被静默取消）', regs.some((r) => r.status === 'pending_confirmation'));
  const cf = await j('POST', `/api/admin/registrations/${regs.find((r) => r.status === 'pending_confirmation').id}/confirm`, {}, token);
  ok('管理员可人工确认', cf.status === 200);
  // 下架批次历史链接仍可访问
  const b1 = await j('GET', '/api/batches/1');
  ok('撤回批次历史链接 200 且带 withdrawn 状态', b1.status === 200 && b1.data.batch.status === 'withdrawn');
}

console.log('— 11. 报名重送幂等 —');
{
  const key = 'test-idempotent-key-001';
  const r1 = await j('POST', '/api/events/1/register',
    { name: '甲', email: 'a@b.c', idempotency_key: key });
  const r2 = await j('POST', '/api/events/1/register',
    { name: '甲-改名', email: 'a@b.c', idempotency_key: key });
  ok('首次报名成功', r1.status === 201);
  ok('重送幂等去重不重复占名额', r2.data.deduped === true && r2.data.registration.id === r1.data.registration.id);
  ok('重送更新了姓名', r2.data.registration.name === '甲-改名');
}

console.log('— 12. 下载可追溯原数据 —');
{
  const r = await fetch(`${BASE}/api/curves/1/download`);
  ok('原始 CSV 可下载', r.status === 200);
  ok('响应头含 sha256', (r.headers.get('x-source-sha256') || '').length === 64);
  ok('响应头含批次/探头/间隔/零点/单位',
    r.headers.get('x-batch-code') === 'YIR-W-2026-03' &&
    Number(r.headers.get('x-sampling-interval-s')) === 2 &&
    r.headers.get('x-time-zero') === 'roast_start' &&
    r.headers.get('x-temp-unit') === 'C');
  const text = await r.text();
  ok('下载内容与 points 接口同源（含 time_s 表头）', text.startsWith('time_s,'));
}

console.log('— 13. 无演示批次时报名关闭 —');
{
  // 活动1关联批次1(撤回)、2(published)、6(撤回) -> 仍有1个可演示；全撤回后应关闭
  await j('POST', '/api/admin/batches/2/withdraw', { reason: '验收测试撤回2' }, token);
  const e = (await j('GET', '/api/events/1')).data.event;
  ok('所有演示批次撤回后报名关闭', e.open === false && e.demo_batch_count === 0);
  const r = await j('POST', '/api/events/1/register',
    { name: '乙', email: 'b@b.c', idempotency_key: 'should-fail' });
  ok('关闭状态报名返回 409', r.status === 409);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
