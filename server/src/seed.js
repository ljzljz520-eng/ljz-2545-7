import fs from 'node:fs';
import path from 'node:path';
import { pool } from './db.js';
import { putCurve, parseCsv, analyzeRows } from './curveStore.js';

await pool.query(`
  TRUNCATE registration_events_log, registrations, event_demo_batches, events,
    sensory_evaluations, roast_curves, batches, products,
    process_terms, origin_terms, origin_processes, glossary_terms, processes, origins, sensory_scales RESTART IDENTITY CASCADE;
`);

const ins = async (sql, p) => (await pool.query(sql, p)).rows[0];

// ---------- 产地 ----------
const origins = {};
for (const o of [
  ['yirgacheffe', '耶加雪菲', '埃塞俄比亚', '西达摩 耶加雪菲', 1750, 2200,
   '高海拔与遮阴森林造就花香与柑橘调性，当地以水洗与日晒两种处理法闻名。'],
  ['huila', '慧兰', '哥伦比亚', '慧兰省 圣奥古斯丁', 1500, 1900,
   '火山土坡地微型农场，水洗为主，焦糖甜与红苹果酸质。'],
  ['manggarai', '芒加莱', '印度尼西亚', '弗洛勒斯岛', 1200, 1600,
   '高原湿刨传统，醇厚草本与黑巧克力，后段发展时间明显拉长。'],
]) {
  origins[o[0]] = await ins(
    `INSERT INTO origins(slug,name,country,region,altitude_min_m,altitude_max_m,story)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, o);
}

// ---------- 处理法 ----------
const processes = {};
for (const p of [
  ['washed', '水洗', 'Washed / Wet Process', '脱皮去 mucilage 后清水发酵，强调干净酸质与产地表达。'],
  ['natural', '日晒', 'Natural / Dry Process', '带果干燥，发酵香与甜感更强，需控制翻动避免过度发酵。'],
  ['wet-hulled', '湿刨', 'Wet-hulled / Giling Basah', '印尼传统：带羊皮纸高含水率刨壳，草本与厚体感。'],
]) processes[p[0]] = await ins(
  `INSERT INTO processes(slug,name,full_name,description) VALUES ($1,$2,$3,$4) RETURNING *`, p);

const linkOP = async (os, ps, note) => {
  for (const o of os) for (const pr of ps)
    await pool.query(`INSERT INTO origin_processes(origin_id,process_id,note) VALUES ($1,$2,$3)`,
      [origins[o].id, processes[pr].id, note]);
};
await linkOP(['yirgacheffe'], ['washed', 'natural'], '当地合作社两种主流处理');
await linkOP(['huila'], ['washed'], '小型水洗站集中处理');
await linkOP(['manggarai'], ['wet-hulled'], '家庭式湿刨');

// ---------- 术语 ----------
const terms = {};
const termDefs = [
  ['first-crack', '一爆', 'roast', '咖啡豆内水蒸气压力导致的爆裂声，标志烘焙发展阶段开始，常用作曲线时间零点之一。'],
  ['turning-point', '回温点', 'roast', '豆温下豆后触底回升的拐点；不同机器/装载量差异大，作零点需谨慎。'],
  ['ror', '升温率 RoR', 'roast', '单位时间豆温上升幅度（°/min），曲线形状比较的核心指标。'],
  ['development-time', '发展时间 DTR', 'roast', '一爆至出豆时长占总烘焙时间比例。'],
  ['probe-et', '环境温度探头 ET', 'roast', '测量滚筒/热风温度的探头，响应快；与豆温探头不能混用比较。'],
  ['probe-bt', '豆温探头 BT', 'roast', '接触豆堆的温度探头，位置与响应延迟因机器而异。'],
  ['time-zero', '时间零点', 'roast', '曲线横轴对齐基准（下豆/开始/回温点/一爆）。零点不同的曲线必须先标注再决定是否可对齐。'],
  ['sampling-interval', '采样间隔', 'roast', '相邻测量点时间间隔。间隔差异过大时逐点比较无意义。'],
  ['gap-interp', '缺测与插值', 'roast', '传感器掉线产生缺口；仅对极短缺口做显示用虚线插值，长缺测保留空段、不填补、不比较。'],
  ['mucilage', '果胶层 Mucilage', 'process', '羊皮纸内侧黏质层，发酵与处理法风味的主要来源。'],
  ['giling-basah', '湿刨 Giling Basah', 'process', '印尼特有的高湿刨壳处理，形成独特厚体感。'],
  ['anaerobic', '厌氧处理', 'process', '密闭无氧环境控时发酵，风味强烈但批次变量多。'],
  ['sca-cupping', 'SCA 杯测表', 'sensory', '百分制（通常 80+ 精品），与 5 分制或 10 分制不可直接混排。'],
  ['dry-aroma', '干香/湿香', 'sensory', '研磨后与注水后的香气评价项。'],
  ['cupping-reserve', '待确认报名', 'event', '演示批次撤回库存时，既有报名转人工确认状态，系统不静默取消。'],
];
for (const [slug, term, category, definition] of termDefs)
  terms[slug] = await ins(`INSERT INTO glossary_terms(slug,term,category,definition) VALUES ($1,$2,$3,$4) RETURNING *`,
    [slug, term, category, definition]);

const linkTerm = async (table, col, id, slugs) => {
  for (const s of slugs) await pool.query(`INSERT INTO ${table}(${col},term_id) VALUES ($1,$2)`, [id, terms[s].id]);
};
await linkTerm('process_terms', 'process_id', processes.washed.id, ['mucilage']);
await linkTerm('process_terms', 'process_id', processes.natural.id, ['anaerobic']);
await linkTerm('process_terms', 'process_id', processes['wet-hulled'].id, ['giling-basah']);
for (const o of Object.values(origins))
  await linkTerm('origin_terms', 'origin_id', o.id, ['dry-aroma']);

// ---------- 量表 ----------
const scales = {};
for (const s of [
  ['SCA2017', 'SCA 杯测 (2017)', 0, 100, '精品咖啡百分制'],
  ['OUR5', '店内 5 分制', 0, 5, '快速内部评测 0-5'],
  ['WCR10', 'WCR 风味 10 分制', 0, 10, '品种研究风味强度 0-10'],
]) scales[s[0]] = await ins(
  `INSERT INTO sensory_scales(code,name,min_score,max_score,description) VALUES ($1,$2,$3,$4,$5) RETURNING *`, s);

// ---------- 曲线 CSV 生成 ----------
function genCurve({ durationS = 600, interval = 2, unit = 'C', kind = 'bt',
                    gaps = [], badDim = false, startTime = 0, profile = 0 } = {}) {
  const rows = [['time_s', 'et_c', 'bt_c'].join(',')];
  const pts = [];
  for (let t = startTime; t <= startTime + durationS; t += interval) {
    const x = (t - startTime) / durationS;
    let bt = 180 + (45 + profile * 4) * (1 - Math.exp(-(3.2 + profile * 0.25) * x)) + (38 - profile * 2) * x;
    if (x < 0.12) bt = 180 - 55 * (x / 0.12) + 30 * x;     // 下豆回温
    const et = bt + 22 + 10 * Math.sin(x * 5);
    if (unit === 'F') { bt = bt * 9 / 5 + 32; }
    if (badDim) { bt = bt * 9 / 5 + 32; } // 声明为 C 却塞华氏数 -> 量纲错误
    const inGap = gaps.some(([a, b]) => t >= a && t <= b);
    const etV = inGap ? '' : et.toFixed(1);
    const btV = inGap ? '' : bt.toFixed(1);
    rows.push(`${t},${kind === 'et' ? '' : etV},${kind === 'et' ? '' : btV}`.replace(/,$/, ''));
    pts.push(t);
  }
  return rows.join('\n') + '\n';
}

async function addCurve(batch, { filename, probe_type, probe_position = '滚筒前壁',
  sampling_interval_s, time_zero, temp_unit = 'C', status, is_late = false, csv, scaleCheck = true }) {
  const buf = Buffer.from(csv);
  const stored = await putCurve(buf);
  const parsed = parseCsv(csv);
  const an = analyzeRows({ rows: parsed.rows, columns: parsed.columns, expectedUnit: temp_unit });
  const row = await ins(`INSERT INTO roast_curves
    (batch_id,filename,sha256,size_bytes,source_filename,review_status,reject_reason,
     probe_type,probe_position,sampling_interval_s,time_zero,temp_unit,channel_meta,
     point_count,duration_s,max_gap_samples,gap_windows,range_check,is_late,late_for_batch_id,
     submitted_at,received_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20,
      now() - ($21 || ' minutes')::interval, now() - ($22 || ' minutes')::interval) RETURNING *`,
    [batch.id, stored.filename, stored.sha256, stored.size, filename, status,
      an.problems.join('；'), probe_type, probe_position, sampling_interval_s, time_zero, temp_unit,
      JSON.stringify({ columns: parsed.columns }), an.pointCount, an.durationS,
      an.maxGapSamples, JSON.stringify(an.gapWindows), JSON.stringify(an.rangeCheck), is_late,
      is_late ? batch.id : null, is_late ? 2 * 24 * 60 : 0, is_late ? 2 * 24 * 60 : 0]);
  return row;
}

// ---------- 产品与批次（谱系） ----------
// 产品1：耶加雪菲水洗，两批——探头/零点不同 => 不可比演示
const prod1 = await ins(`INSERT INTO products(slug,brand,name,description) VALUES ($1,$2,$3,$4) RETURNING *`,
  ['yirga-washed', '山脊烘焙', '耶加雪菲 水洗', '旗舰单品，花香柑橘']);
const b1 = await ins(`INSERT INTO batches
  (code,product_id,origin_id,process_id,roast_date,roaster,machine,weight_in_g,weight_out_g,status,story)
  VALUES ('YIR-W-2026-03',$1,$2,$3,'2026-03-10','Lin','Probatino 1kg',1200,1008,'published','春季批次，一爆后发展 18%')
  RETURNING *`, [prod1.id, origins.yirgacheffe.id, processes.washed.id]);
const b2 = await ins(`INSERT INTO batches
  (code,product_id,origin_id,process_id,parent_id,lineage_note,roast_date,roaster,machine,weight_in_g,weight_out_g,status,story)
  VALUES ('YIR-W-2026-06',$1,$2,$3,$4,'换产季；换了豆温探头安装位置并改用一爆零点','2026-06-02','Lin','Probatino 1kg',1200,1014,'published','夏季批次，发展 20%')
  RETURNING *`, [prod1.id, b1.id, origins.yirgacheffe.id, processes.washed.id]);
await pool.query(`UPDATE products SET current_batch_id=$1 WHERE id=$2`, [b2.id, prod1.id]);

// 产品2：同品牌同名日晒？不——做"品牌同名但不同实验条件"演示：与 b1 同采样但不同时间零点
const prod2 = await ins(`INSERT INTO products(slug,brand,name,description) VALUES ($1,$2,$3,$4) RETURNING *`,
  ['yirga-natural', '山脊烘焙', '耶加雪菲 日晒', '蓝莓发酵调，甜感型']);
const b3 = await ins(`INSERT INTO batches
  (code,product_id,origin_id,process_id,roast_date,roaster,machine,weight_in_g,weight_out_g,status)
  VALUES ('YIR-N-2026-05',$1,$2,$3,'2026-05-18','Lin','Probatino 1kg',1200,996,'published')
  RETURNING *`, [prod2.id, origins.yirgacheffe.id, processes.natural.id]);

// 产品3：慧兰水洗，两批采样间隔不同 => 不可比
const prod3 = await ins(`INSERT INTO products(slug,brand,name,description) VALUES ($1,$2,$3,$4) RETURNING *`,
  ['huila-washed', '山谷烘焙', '慧兰 水洗', '红苹果焦糖']);
const b4 = await ins(`INSERT INTO batches
  (code,product_id,origin_id,process_id,roast_date,roaster,machine,status,weight_in_g,weight_out_g)
  VALUES ('HUI-W-2026-04',$1,$2,$3,'2026-04-12','Mei','Aillio Bullet R1','published',1000,850)
  RETURNING *`, [prod3.id, processes.washed.id, origins.huila.id]);
const b5 = await ins(`INSERT INTO batches
  (code,product_id,origin_id,process_id,parent_id,lineage_note,roast_date,roaster,machine,status,weight_in_g,weight_out_g)
  VALUES ('HUI-W-2026-07',$1,$2,$3,$4,'升级固件后采样从 5s 加密到 1.5s','2026-07-05','Mei','Aillio Bullet R1','published',1000,846)
  RETURNING *`, [prod3.id, processes.washed.id, origins.huila.id, b4.id]);
await pool.query(`UPDATE products SET current_batch_id=$1 WHERE id=$2`, [b5.id, prod3.id]);

// 产品4：弗洛勒斯湿刨——撤回批次（历史链接仍可访问）
const prod4 = await ins(`INSERT INTO products(slug,brand,name,description) VALUES ($1,$2,$3,$4) RETURNING *`,
  ['flores-wb', '群岛咖啡', '弗洛勒斯 湿刨', '黑巧克力草本']);
const b6 = await ins(`INSERT INTO batches
  (code,product_id,origin_id,process_id,roast_date,roaster,machine,status,weight_in_g,weight_out_g,story)
  VALUES ('FLO-WH-2026-02',$1,$2,$3,'2026-02-20','Surya','Prabhtuki 2kg','withdrawn',2000,1640,'该批因草腥味复检撤回，但曲线保留供历史追溯')
  RETURNING *`, [prod4.id, processes['wet-hulled'].id, origins.manggarai.id]);
await pool.query(`UPDATE products SET current_batch_id=NULL WHERE id=$1`, [prod4.id]);

// ---------- 曲线 ----------
await addCurve(b1, { filename: 'yir-w-03.csv', probe_type: 'BT', probe_position: '豆堆中心',
  sampling_interval_s: 2, time_zero: 'roast_start', status: 'accepted',
  csv: genCurve({ interval: 2, profile: 1 }) });
await addCurve(b2, { filename: 'yir-w-06.csv', probe_type: 'BT', probe_position: '滚筒前壁(新位置)',
  sampling_interval_s: 2, time_zero: 'first_crack', status: 'accepted',
  csv: genCurve({ interval: 2, profile: -1.5 }) });
await addCurve(b3, { filename: 'yir-n-05.csv', probe_type: 'ET_BT', probe_position: '双通道 前壁',
  sampling_interval_s: 2, time_zero: 'roast_start', status: 'accepted',
  csv: genCurve({ interval: 2, profile: 2 }) });
// b4 5s 间隔 vs b5 1.5s；同时 b5 含一个短缺口（可插值显示）
await addCurve(b4, { filename: 'hui-w-04.csv', probe_type: 'BT', probe_position: '豆堆中心',
  sampling_interval_s: 5, time_zero: 'roast_start', status: 'accepted',
  csv: genCurve({ interval: 5, profile: -1 }) });
await addCurve(b5, { filename: 'hui-w-07.csv', probe_type: 'BT', probe_position: '豆堆中心',
  sampling_interval_s: 1.5, time_zero: 'roast_start', status: 'accepted',
  csv: genCurve({ interval: 1.5, gaps: [[240, 241.5]], profile: 0.6 }) }); // 1 个短缺口
// b6 撤回批次曲线：含长缺测（掉线 40s），不填补
await addCurve(b6, { filename: 'flo-wh-02.csv', probe_type: 'BT', probe_position: '豆堆中心',
  sampling_interval_s: 3, time_zero: 'turning_point', status: 'accepted',
  csv: genCurve({ interval: 3, gaps: [[300, 339]], profile: 1.2 }) });

// 验收场景1：量纲错误（声明 C 实为 F）-> needs_fix
await addCurve(b5, { filename: 'hui-w-07-unitbug.csv', probe_type: 'BT',
  sampling_interval_s: 1.5, time_zero: 'roast_start', temp_unit: 'C',
  status: 'needs_fix', csv: genCurve({ interval: 1.5, badDim: true }) });
// 验收场景2：曲线晚到（批次已发布后补录，is_late）
await addCurve(b1, { filename: 'yir-w-03-late.csv', probe_type: 'BT', probe_position: '豆堆中心',
  sampling_interval_s: 2, time_zero: 'roast_start', status: 'pending', is_late: true,
  csv: genCurve({ interval: 2, durationS: 612, profile: -0.8 }) });

// ---------- 感官评语（混量表 => 不排名演示） ----------
await pool.query(`INSERT INTO sensory_evaluations(batch_id,scale_id,score,cupper,notes,flavor_tags,evaluated_on) VALUES
  ($1,$2,86.5,'Lin','茉莉、柠檬、红茶尾韵','{茉莉,柠檬,红茶}','2026-03-12'),
  ($1,$3,4.2,'Mei','店内快评：干净透亮','{花香,柑橘}','2026-03-13')`,
  [b1.id, scales.SCA2017.id, scales.OUR5.id]);
await pool.query(`INSERT INTO sensory_evaluations(batch_id,scale_id,score,cupper,notes,flavor_tags,evaluated_on) VALUES
  ($1,$2,87.0,'Lin','甜感更高，蓝莓','{蓝莓,红糖}','2026-06-03')`,
  [b2.id, scales.SCA2017.id]);
await pool.query(`INSERT INTO sensory_evaluations(batch_id,scale_id,score,cupper,notes,flavor_tags,evaluated_on) VALUES
  ($1,$2,85.0,'Mei','红苹果 焦糖','{红苹果,焦糖}','2026-04-13'),
  ($1,$3,7.8,'WCR客座','风味强度研究口径','{苹果}','2026-04-14')`,
  [b4.id, scales.SCA2017.id, scales.WCR10.id]);
await pool.query(`INSERT INTO sensory_evaluations(batch_id,scale_id,score,cupper,notes,flavor_tags) VALUES
  ($1,$2,88.0,'Mei','固件升级后更均匀','{红苹果,蜂蜜}')`, [b5.id, scales.SCA2017.id]);
await pool.query(`INSERT INTO sensory_evaluations(batch_id,scale_id,score,cupper,notes,flavor_tags) VALUES
  ($1,$2,78.5,'Surya','草腥 黑巧（撤回依据）','{草腥,黑巧克力}')`, [b6.id, scales.SCA2017.id]);

// ---------- 活动 ----------
const ev1 = await ins(`INSERT INTO events(slug,title,held_on,location,capacity,description)
  VALUES ('open-roast-oct','十月开放烘焙日','2026-10-18 14:00+08','店内烘焙间',2,'含曲线对比演示，名额与演示批次库存联动') RETURNING *`);
await pool.query(`INSERT INTO event_demo_batches(event_id,batch_id) VALUES ($1,$2),($1,$3),($1,$4)`,
  [ev1.id, b1.id, b2.id, b6.id]); // b6 已撤回 => 可演示批次=2
const ev2 = await ins(`INSERT INTO events(slug,title,held_on,location,capacity,description)
  VALUES ('cupping-nov','十一月产地杯测','2026-11-08 10:00+08','杯测室',12,'多产地横向杯测（分量表讲解）') RETURNING *`);
await pool.query(`INSERT INTO event_demo_batches(event_id,batch_id) VALUES ($1,$2),($1,$3),($1,$4)`,
  [ev2.id, b3.id, b4.id, b5.id]);
// 预置一条已确认报名（撤回 b6 后转待确认的验收场景在测试中动态演示）
await pool.query(`INSERT INTO registrations(event_id,name,email,idempotency_key,status)
  VALUES ($1,'王小明','wang@example.com','seed-key-wang','registered')`, [ev1.id]);

console.log('seed done:',
  Object.keys(origins).length, 'origins,',
  (await pool.query('SELECT count(*) FROM batches')).rows[0].count, 'batches,',
  (await pool.query('SELECT count(*) FROM roast_curves')).rows[0].count, 'curves,',
  (await pool.query('SELECT count(*) FROM sensory_evaluations')).rows[0].count, 'sensory');
await pool.end();
