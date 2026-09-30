'use strict';
// 演示数据：刻意制造“不同探头 / 不同采样间隔 / 不同时间零点 / 长缺测 / 跨量表 /
// 同名豆款换批 / 验收曲线晚到 / 活动库存撤回”等场景，供比较引擎与验收测试使用。
const fs = require('fs');
const path = require('path');
const { getDb } = require('../src/db');
const { validateCurve, storeCurveFile } = require('../src/lib/curves');

async function q(db, sql, p = []) { return db.query(sql, p); }

function makeCurve({ interval = 1, duration = 480, timeZero = 'charge', unit = 'C',
  probeModel = 'Phidget PT100', probePosition = 'bean', startTemp = 200,
  peakTemp = 212, gap = null, label }) {
  const time = [];
  const bean = [];
  for (let t = 0; t <= duration; t += interval) {
    time.push(Number(t.toFixed(2)));
    // ROR 衰减式升温：从 startTemp 升到 peakTemp，中段斜率最大
    const p01 = t / duration;
    const c = startTemp + (peakTemp - startTemp) * (1 - Math.pow(1 - p01, 1.7))
      + Math.sin(t / 22) * 0.8;
    let v;
    if (gap && t >= gap[0] && t <= gap[1]) v = null;
    else v = unit === 'F' ? c * 9 / 5 + 32 : c;
    bean.push(v === null ? null : Number(v.toFixed(2)));
  }
  const inlet = bean.map((v, i) => (v === null ? null : Number((v + 26 + Math.sin(i / 15) * 1.2).toFixed(2))));
  return {
    metadata: {
      probe_model: probeModel, probe_position: probePosition, temp_unit: unit,
      sample_interval_s: interval, time_zero: timeZero, label,
    },
    time_s: time,
    channels: {
      bean_temp: { unit, values: bean },
      inlet_temp: { unit, values: inlet },
      gas: { unit: '%', values: time.map((t) => Math.max(0, Number((100 - (t / duration) * 55).toFixed(1)))) },
    },
  };
}

async function insertCurve(db, batchId, originalname, obj, { phase = 'production', type = 'roast', overrideDecl = {} }) {
  const buf = Buffer.from(JSON.stringify(obj));
  const declared = { ...obj.metadata, ...overrideDecl };
  const v = validateCurve(originalname, buf, declared);
  const stored = storeCurveFile(batchId, originalname, buf, v.ok);
  const m = v.meta || declared;
  const ins = await q(db,
    `INSERT INTO curves (batch_id,curve_type,phase,source,original_filename,storage_path,content_sha256,mime,byte_size,
       probe_model,probe_position,temp_unit,sample_interval_s,time_zero,recorded_at,
       point_count,duration_s,max_gap_s,validation_status,validation_notes,accepted)
     VALUES ($1,$2,$3,'seed',$4,$5,$6,'application/json',$7,$8,$9,$10,$11,$12,now(),$13,$14,$15,$16,$17,$18) RETURNING *`,
    [batchId, type, phase, originalname, stored.storage_path, stored.content_sha256, buf.length,
     m.probe_model, m.probe_position, m.temp_unit, m.sample_interval_s, m.time_zero,
     v.summary ? v.summary.point_count : 0, v.summary ? v.summary.duration_s : null,
     v.summary ? v.summary.max_gap_s : 0,
     v.ok ? 'accepted' : 'rejected', JSON.stringify({ errors: v.errors, warnings: v.warnings }), v.ok]);
  if (v.ok) for (const ch of v.summary.channels) {
    await q(db, `INSERT INTO curve_channels (curve_id,channel,unit,point_count,max_gap_s) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (curve_id,channel) DO UPDATE SET unit=EXCLUDED.unit,point_count=EXCLUDED.point_count,max_gap_s=EXCLUDED.max_gap_s`,
      [ins.rows[0].id, ch.channel, ch.unit, ch.point_count, ch.max_gap_s]);
  }
  return { row: ins.rows[0], validation: v };
}

(async () => {
  const db = await getDb();
  await q(db, `TRUNCATE download_log, registrations, event_demo_batches, events, sensory_reviews,
               curve_channels, curves, batch_lineage, batches, products, origin_glossary, process_glossary,
               glossary_terms, processes, origins, inventory_transactions, rating_scales RESTART IDENTITY CASCADE`);

  // 量表
  await q(db, `INSERT INTO rating_scales (code,name,min_value,max_value,description) VALUES
    ('sca2017','SCA 杯测表 2017',0,100,'精品咖啡协会 2017 版 10 项 × 6~10 加权百分制'),
    ('wb10','店内 10 分制',0,10,'烘焙师内部快速杯测，0~10'),
    ('internal5','5 星偏好量表',1,5,'面向顾客的喜好度，1~5 星')`);

  // 产地
  const origins = [
    ['yirgacheffe', '耶加雪菲', '埃塞俄比亚', 'Gedeo 产区', '1,900–2,200m', '高海拔遮阴种植，花香与柑橘调性来自当地原生种与云雾微气候。'],
    ['huila', '慧兰', '哥伦比亚', 'Huila 省', '1,700–1,900m', '安第斯山坡水洗传统，坚果与红糖甜感，酸度柔和。'],
    ['montanha', '蒙塔尼亚', '巴西', 'Espírito Santo', '900–1,200m', '低海拔半日晒处理，醇厚低酸，适合意式拼配基底。'],
  ];
  for (const o of origins) await q(db, `INSERT INTO origins (slug,name,country,region,altitude_m,story) VALUES ($1,$2,$3,$4,$5,$6)`, o);

  // 处理法
  const procs = [
    ['washed', '水洗', 'washed', '去果皮果肉后发酵洗净，强调清晰酸质与产地表达。'],
    ['natural', '日晒', 'natural', '整颗樱桃晒干，果香浓郁、醇厚。'],
    ['honey', '蜜处理', 'honey', '保留部分黏膜干燥，甜感与酸质折中。'],
    ['anaerobic', '厌氧发酵', 'anaerobic', '密闭罐内控温发酵，风味更极端且批次差异大。'],
  ];
  for (const p of procs) await q(db, `INSERT INTO processes (slug,name,category,description) VALUES ($1,$2,$3,$4)`, p);

  // 术语
  const terms = [
    ['ror', '升温率 ROR', 'roasting', 'Rate of Rise，豆温每分钟上升度数。受探头型号与位置影响显著。'],
    ['first-crack', '一爆', 'roasting', '豆内水蒸气压力导致的爆裂声，常被用作曲线的时间零点之一。'],
    ['turning-point', '回温点', 'roasting', '豆温下降后重新上升的拐点，常被用作曲线的时间零点之一。'],
    ['time-zero', '时间零点', 'roasting', '曲线横轴的参考起点（下锅/回温点/一爆）。零点不同的曲线不能直接对齐。'],
    ['anaerobic-fermentation', '厌氧发酵', 'process', '无氧环境下的可控发酵，需逐批记录参数。'],
    ['sl28', 'SL28', 'origin', '肯尼亚经典品种，黑醋栗酸质。'],
    ['cupping-protocol', '杯测协议', 'sensory', '统一研磨度、水温与浸出时间；不同评分量表不可直接排名。'],
    ['density', '豆密度', 'origin', '硬豆密度高、吸热慢，烘焙曲线需更长发展。'],
  ];
  for (const t of terms) await q(db, `INSERT INTO glossary_terms (slug,term,kind,definition) VALUES ($1,$2,$3,$4)`, t);
  await q(db, `INSERT INTO origin_glossary (origin_id,term_id)
     SELECT o.id,g.id FROM origins o, glossary_terms g
      WHERE o.slug='yirgacheffe' AND g.slug IN ('sl28','density')`);
  await q(db, `INSERT INTO process_glossary (process_id,term_id)
     SELECT p.id,g.id FROM processes p, glossary_terms g
      WHERE p.slug='anaerobic' AND g.slug='anaerobic-fermentation'`);
  await q(db, `INSERT INTO origin_glossary (origin_id,term_id)
     SELECT o.id,g.id FROM origins o, glossary_terms g
      WHERE o.slug='yirgacheffe' AND g.slug IN ('first-crack')`);
  await q(db, `INSERT INTO process_glossary (process_id,term_id)
     SELECT p.id,g.id FROM processes p, glossary_terms g
      WHERE p.slug IN ('washed','natural') AND g.slug='cupping-protocol'`);

  // 豆款（品牌同名问题：同一个“晨曦”名下跨批换产地）
  await q(db, `INSERT INTO products (slug,brand,name,description) VALUES
    ('morning-light', '山脊咖啡', '晨曦拼配', '门店招牌拼配。注意：2025 与 2026 批次配方/产地已变化，名称相同不等于条件相同。'),
    ('yirgacheffe-single', '山脊咖啡', '耶加雪菲单品', '季节单品，按产季换批。'),
    ('huila-reserve', '山脊咖啡', '慧兰珍藏', '水洗单品。')`);

  // 批次
  async function batch(vals) {
    const r = await q(db,
      `INSERT INTO batches (slug,code,product_id,origin_id,process_id,harvest_year,roast_date,roast_level,machine,status,story,demo_servings_total)
       VALUES ($1,$2,$3,(SELECT id FROM origins WHERE slug=$4),(SELECT id FROM processes WHERE slug=$5),$6,$7,$8,$9,$10,$11,$12) RETURNING *`, vals);
    return r.rows[0];
  }
  // 晨曦 旧批：耶加雪菲+慧兰拼配（已下架）；新批：巴西+耶加雪菲
  const b1 = await batch(['b-morning-2025q1', 'ML-2025Q1', 1, 'yirgacheffe', 'washed', 2024, '2025-01-15', '中浅', 'Probatino 1.2kg', 'delisted', '初代配方，耶加雪菲主导花香。', 0]);
  const b2 = await batch(['b-morning-2026q2', 'ML-2026Q2', 1, 'montanha', 'natural', 2025, '2026-04-10', '中', 'Probatino 1.2kg', 'published', '改用巴西半日晒做底，醇厚提升；旧曲线仍属于 ML-2025Q1。', 40]);
  // 耶加单品两产季，同探头同间隔——可比
  const b3 = await batch(['b-yirga-2025', 'YG-2025', 2, 'yirgacheffe', 'washed', 2024, '2025-03-02', '浅', 'Aillio Bullet R1', 'published', '2025 产季水洗耶加。', 30]);
  const b4 = await batch(['b-yirga-2026', 'YG-2026', 2, 'yirgacheffe', 'washed', 2025, '2026-03-20', '浅', 'Aillio Bullet R1', 'published', '2026 产季，同设备复现。', 24]);
  // 慧兰：不同探头（K 型热电偶）+ 不同时间零点——与 YG 不可比
  const b5 = await batch(['b-huila-2026', 'HL-2026', 3, 'huila', 'washed', 2025, '2026-02-11', '中浅', 'Probatino 1.2kg', 'published', '使用入料口 K 型热电偶记录，时间零点取一爆。', 20]);
  // 草稿批（未发布，缺曲线之一用）
  const b6 = await batch(['b-yirga-2026-anaerobic-exp', 'YG-2026-ANA-EXP', 2, 'yirgacheffe', 'anaerobic', 2025, '2026-05-06', '实验', 'Aillio Bullet R1', 'draft', '厌氧微批次，曲线待定。', 6]);

  // 谱系
  await q(db, `INSERT INTO batch_lineage (child_id,parent_id,relation,note) VALUES
    ($1,$2,'replace','配方调整：耶加/慧兰 → 巴西/耶加'),
    ($3,$4,'parent','同地块次年产季承继')`,
    [b2.id, b1.id, b4.id, b3.id]);
  await q(db, `INSERT INTO batch_lineage (child_id,parent_id,relation,note) VALUES ($1,$2,'split','从 YG-2026 分出厌氧实验小批')`,
    [b6.id, b4.id]);

  // 曲线文件
  await insertCurve(db, b1.id, 'ML-2025Q1-roast.json', makeCurve({
    interval: 2, duration: 520, startTemp: 196, peakTemp: 211,
    probeModel: 'Phidget PT100', probePosition: 'bean', unit: 'C', timeZero: 'charge', gap: [300, 336], label: 'ML-2025Q1' }),
    { phase: 'production', type: 'roast' });
  await insertCurve(db, b2.id, 'ML-2026Q2-roast.json', makeCurve({
    interval: 2, duration: 500, startTemp: 198, peakTemp: 214,
    probeModel: 'Phidget PT100', probePosition: 'bean', unit: 'C', timeZero: 'charge', label: 'ML-2026Q2' }), {});
  await insertCurve(db, b3.id, 'YG-2025-roast.json', makeCurve({
    interval: 1, duration: 470, startTemp: 196, peakTemp: 208,
    probeModel: 'Bullet-IRS', probePosition: 'bean', unit: 'C', timeZero: 'charge', label: 'YG-2025' }), {});
  await insertCurve(db, b4.id, 'YG-2026-roast.json', makeCurve({
    interval: 1, duration: 475, startTemp: 197, peakTemp: 209,
    probeModel: 'Bullet-IRS', probePosition: 'bean', unit: 'C', timeZero: 'charge', label: 'YG-2026' }), {});
  // 慧兰：探头不同 + 时间零点不同（取一爆后 180s），且间隔 5s
  await insertCurve(db, b5.id, 'HL-2026-roast.json', makeCurve({
    interval: 5, duration: 300, startTemp: 196, peakTemp: 213,
    probeModel: 'Generic K-type TC', probePosition: 'inlet', unit: 'F', timeZero: 'first_crack_start', label: 'HL-2026' }), {});

  // 评语：跨量表
  await q(db, `INSERT INTO sensory_reviews (batch_id,scale_id,score,cup_notes,cupper,curve_id)
    SELECT b.id, s.id, $3,$4,$5,c.id FROM batches b, rating_scales s, curves c
     WHERE b.code=$1 AND s.code=$2 AND c.batch_id=b.id AND c.phase='production' LIMIT 1`,
    ['YG-2025', 'sca2017', 86.5, '茉莉、柠檬、红茶尾韵，干净。', '林杯']);
  await q(db, `INSERT INTO sensory_reviews (batch_id,scale_id,score,cup_notes,cupper,curve_id)
    SELECT b.id, s.id, $3,$4,$5,c.id FROM batches b, rating_scales s, curves c
     WHERE b.code=$1 AND s.code=$2 AND c.batch_id=b.id AND c.phase='production' LIMIT 1`,
    ['YG-2026', 'sca2017', 84.0, '橙花、白桃，body 略轻。', '林杯']);
  await q(db, `INSERT INTO sensory_reviews (batch_id,scale_id,score,cup_notes,cupper,curve_id)
    SELECT b.id, s.id, $3,$4,$5,c.id FROM batches b, rating_scales s, curves c
     WHERE b.code=$1 AND s.code=$2 AND c.batch_id=b.id AND c.phase='production' LIMIT 1`,
    ['HL-2026', 'wb10', 8.2, '红糖、坚果，酸质温和。', '阿山']);
  await q(db, `INSERT INTO sensory_reviews (batch_id,scale_id,score,cup_notes,cupper,curve_id)
    SELECT b.id, s.id, $3,$4,$5,c.id FROM batches b, rating_scales s, curves c
     WHERE b.code=$1 AND s.code=$2 AND c.batch_id=b.id AND c.phase='production' LIMIT 1`,
    ['ML-2026Q2', 'internal5', 4, '顺口，巧克力甜。', '门店客调']);

  // 活动：杯测会，绑定 YG-2026(24) 与 HL-2026(20)，场地 30 → 有效 min(30,44)=30
  const ev = await q(db,
    `INSERT INTO events (slug,title,description,starts_at,capacity,status)
     VALUES ('cupping-2026-10','十月产地杯测会','对比同探头批次，并演示跨设备数据为何不能直接叠合。', now() + interval '12 days', 30,'open') RETURNING *`);
  const eventId = ev.rows[0].id;
  await q(db, `INSERT INTO event_demo_batches (event_id,batch_id,servings) VALUES ($1,$2,24),($1,$3,20)`,
    [eventId, b4.id, b5.id]);

  // 已确认与待处理报名各若干
  async function reg(name, email, size, status, key) {
    await q(db, `INSERT INTO registrations (event_id,name,email,party_size,status,idempotency_key) VALUES ($1,$2,$3,$4,$5,$6)`,
      [eventId, name, email, size, status, key]);
  }
  await reg('王芳', 'wangf@example.com', 2, 'confirmed', 'seed-key-1');
  await reg('陈晨', 'chen@example.com', 1, 'confirmed', 'seed-key-2');
  await reg('李雷', 'lilei@example.com', 2, 'pending', 'seed-key-3');

  console.log('[seed] done. 批次:',
    [b1, b2, b3, b4, b5, b6].map((x) => x.code).join(', '));
  console.log('[seed] 演示: 活动 id=%d；测试撤回可调用 POST /api/admin/events/%d/withdraw {batch_id:%d,delta:-18}',
    eventId, eventId, b4.id);
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
