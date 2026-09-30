'use strict';
// ============================================================
// 可比条件检查引擎
//
// 核心原则：
//  1. 温度探头型号/位置不同      → BLOCK：不叠合排名，给出“不可比项解释”
//  2. 采样间隔不同               → WARN：允许，但重采样到同一网格并显式标注
//  3. 时间零点不同               → BLOCK：横轴无法对齐
//  4. 长缺测（>2 采样点）         → 永不插值，曲线按缺口分段，重叠度<50% 判不可比
//  5. 感官评分：量表不同不直接排名，仅在同量表内归一化排名
//  6. 品牌同名 ≠ 实验条件相同：产品比较必须展开到批次，逐批标注
// ============================================================
const { getDb } = require('../db');
const { loadCurveSeries, toC } = require('./curves');

const OVERLAP_MIN = 0.5;

// 取批次的“代表烘焙曲线”（已接受、production、最新）
async function loadBatchCurveData(db, batchId) {
  const r = await db.query(
    `SELECT c.*, b.code AS batch_code, b.slug AS batch_slug, b.status AS batch_status
       FROM curves c JOIN batches b ON b.id = c.batch_id
      WHERE c.batch_id = $1 AND c.accepted = true AND c.phase = 'production'
      ORDER BY c.created_at DESC LIMIT 1`,
    [batchId]
  );
  if (!r.rows.length) return null;
  const c = r.rows[0];
  const file = loadCurveSeries(c.storage_path);
  // 统一换算到摄氏度
  const beanName = c.bean_channel || Object.keys(file.series).find((k) => /bean|bt/i.test(k));
  const bean = file.series[beanName];
  const celsius = bean ? bean.values.map((v) => (v === null ? null : toC(v, bean.unit || c.temp_unit))) : null;
  return {
    curveId: c.id,
    batchId: c.batch_id,
    batchSlug: c.batch_slug,
    batchCode: c.batch_code,
    batchStatus: c.batch_status,
    label: c.batch_code,
    probe_model: c.probe_model,
    probe_position: c.probe_position,
    temp_unit: c.temp_unit,
    sample_interval_s: Number(c.sample_interval_s),
    time_zero: c.time_zero,
    max_gap_s: Number(c.max_gap_s),
    point_count: c.point_count,
    duration_s: Number(c.duration_s),
    time: file.time,
    valuesC: celsius,
    channelName: beanName,
  };
}

function allSame(arr, key) {
  const vals = new Set(arr.map((x) => x[key]));
  return vals.size <= 1;
}

// 把一条曲线重采样到公共时间网格（网格点取 null 表示落在长缺口内）
function resampleToGrid(time, values, grid, interval) {
  const out = new Array(grid.length).fill(null);
  for (let gi = 0; gi < grid.length; gi++) {
    const t = grid[gi];
    // 找最近点；距离超过间隔视为缺测（不跨长缺口）
    let best = -1, bestDt = Infinity;
    for (let i = 0; i < time.length; i++) {
      const dt = Math.abs(time[i] - t);
      if (dt < bestDt) { bestDt = dt; best = i; }
    }
    if (best >= 0 && bestDt <= interval * 0.6 && values[best] !== null) out[gi] = values[best];
  }
  return out;
}

// 段：把网格中连续非空的区间切段（长缺口两侧分段）
function segments(values) {
  const segs = [];
  let i = 0;
  while (i < values.length) {
    if (values[i] === null) { i++; continue; }
    let j = i;
    while (j < values.length && values[j] !== null) j++;
    segs.push([i, j - 1]);
    i = j;
  }
  return segs;
}

// 两条已对齐网格曲线的“可对齐覆盖度”：至少一条有值且双方都有值的比例
function pairwiseOverlap(a, b) {
  let both = 0, either = 0;
  for (let i = 0; i < a.length; i++) {
    const hasA = a[i] !== null, hasB = b[i] !== null;
    if (hasA || hasB) either++;
    if (hasA && hasB) both++;
  }
  return either === 0 ? 0 : both / either;
}

// 核心：批次筛选比较
async function compareBatches(batchIds) {
  const db = await getDb();
  const checks = [];
  const addCheck = (dimension, severity, comparable, detail) =>
    checks.push({ dimension, severity, comparable, detail });

  const unique = [...new Set(batchIds.map(Number))];
  const loaded = [];
  for (const id of unique) {
    const d = await loadBatchCurveData(db, id);
    if (!d) addCheck('curve_available', 'BLOCK', false, { batch_id: id, reason: '批次没有可比较的已接受烘焙曲线（可能只有验收曲线或尚未上传）' });
    else loaded.push(d);
  }

  const result = {
    mode: 'batch',
    comparable: loaded.length >= 2,
    rationale: [],
    checks,
    items: loaded,
    chart: null,
    sensory: null,
  };
  if (loaded.length < 2) {
    result.comparable = false;
    result.rationale.push('有效可比曲线少于 2 条');
    return finalizeSensory(db, result, unique);
  }

  // 1) 探头
  if (!allSame(loaded, 'probe_model')) {
    result.comparable = false;
    addCheck('probe_model', 'BLOCK', false, {
      values: Object.fromEntries(loaded.map((d) => [d.label, d.probe_model])),
      reason: '温度探头型号不同，系统偏差未知，禁止把曲线叠合后直接排名',
    });
  } else addCheck('probe_model', 'OK', true, { shared: loaded[0].probe_model });

  if (!allSame(loaded, 'probe_position')) {
    result.comparable = false;
    addCheck('probe_position', 'BLOCK', false, {
      values: Object.fromEntries(loaded.map((d) => [d.label, d.probe_position])),
      reason: '探头位置不同（豆温/环境/进风口）测量的不是同一个物理量',
    });
  } else addCheck('probe_position', 'OK', true, { shared: loaded[0].probe_position });

  // 2) 单位（可换算 → 统一 °C）
  if (!allSame(loaded, 'temp_unit')) {
    addCheck('temp_unit', 'WARN', true, {
      values: Object.fromEntries(loaded.map((d) => [d.label, d.temp_unit])),
      action: '已统一换算为 °C 后展示；原始单位保留在元数据中',
    });
  } else addCheck('temp_unit', 'OK', true, { shared: loaded[0].temp_unit });

  // 3) 采样间隔
  let intervalNote = null;
  if (!allSame(loaded, 'sample_interval_s')) {
    const target = Math.max(...loaded.map((d) => d.sample_interval_s));
    intervalNote = target;
    addCheck('sample_interval', 'WARN', true, {
      values: Object.fromEntries(loaded.map((d) => [d.label, d.sample_interval_s])),
      action: `采样间隔不同：已用最近邻重采样到公共网格 ${target}s（不做任何插值填补），图上标注“重采样”`,
      target_interval_s: target,
    });
  } else addCheck('sample_interval', 'OK', true, { shared: loaded[0].sample_interval_s });

  // 4) 时间零点
  if (!allSame(loaded, 'time_zero')) {
    result.comparable = false;
    addCheck('time_zero', 'BLOCK', false, {
      values: Object.fromEntries(loaded.map((d) => [d.label, d.time_zero])),
      reason: '时间零点不同（如“下锅”与“一爆开始”），横轴无法对齐',
    });
  } else addCheck('time_zero', 'OK', true, { shared: loaded[0].time_zero });

  // 5) 长缺测 / 重叠
  const targetInterval = intervalNote || loaded[0].sample_interval_s || 1;
  const tMin = Math.max(...loaded.map((d) => d.time[0]));
  const tMax = Math.min(...loaded.map((d) => d.time[d.time.length - 1]));
  if (tMax <= tMin) {
    result.comparable = false;
    addCheck('time_coverage', 'BLOCK', false, { reason: '曲线时间范围没有交集' });
  } else {
    const grid = [];
    for (let t = Math.ceil(tMin / targetInterval) * targetInterval; t <= tMax; t += targetInterval) grid.push(Number(t.toFixed(2)));
    const aligned = loaded.map((d) => resampleToGrid(d.time, d.valuesC, grid, d.sample_interval_s || targetInterval));
    const segInfo = aligned.map(segments);
    const gapBatches = loaded.filter((d) => d.max_gap_s > (d.sample_interval_s || 1) * 2)
      .map((d) => ({ batch: d.label, max_gap_s: d.max_gap_s }));
    if (gapBatches.length) {
      addCheck('gaps', 'WARN', true, {
        batches: gapBatches,
        action: '长缺测保持空白并按缺口分段，仅短缺口(≤2 点)在展示时以插值点标记',
      });
    }
    // 两两覆盖度
    const pairs = [];
    let worst = 1;
    for (let i = 0; i < aligned.length; i++) {
      for (let j = i + 1; j < aligned.length; j++) {
        const ov = pairwiseOverlap(aligned[i], aligned[j]);
        worst = Math.min(worst, ov);
        pairs.push({ a: loaded[i].label, b: loaded[j].label, overlap: Number(ov.toFixed(3)) });
      }
    }
    if (worst < OVERLAP_MIN) {
      result.comparable = false;
      addCheck('overlap', 'BLOCK', false, { pairs, reason: `可对齐覆盖度最低 ${(worst * 100).toFixed(0)}% < ${OVERLAP_MIN * 100}%（长缺测或时长差异），共同样本不足以比较` });
    } else {
      addCheck('overlap', 'OK', true, { pairs, min_overlap: Number(worst.toFixed(3)) });
      // 只有全部 BLOCK 维度都通过时才输出叠合数据
      if (result.comparable) {
        result.chart = {
          unit: 'C',
          time_zero: loaded[0].time_zero,
          interval_s: targetInterval,
          resampled: !!intervalNote,
          grid,
          series: aligned.map((vals, i) => ({
            label: loaded[i].label,
            batch_id: loaded[i].batchId,
            curve_id: loaded[i].curveId,
            values: vals,
            segments: segInfo[i],
          })),
        };
      }
    }
  }

  result.rationale.unshift(result.comparable
    ? '这些批次的测量条件一致：曲线已统一量纲并对齐到同一时间网格，可以直接叠合比较。'
    : '存在 BLOCK 级不可比条件：不提供叠合排名，仅并列展示各批次曲线并在图注中解释原因。');
  return finalizeSensory(db, result, unique);
}

async function finalizeSensory(db, result, batchIds) {
  const r = await db.query(
    `SELECT s.*, sc.code AS scale_code, sc.name AS scale_name, sc.min_value AS smin, sc.max_value AS smax,
            b.code AS batch_code
       FROM sensory_reviews s
       JOIN rating_scales sc ON sc.id = s.scale_id
       JOIN batches b ON b.id = s.batch_id
      WHERE s.batch_id = ANY($1::int[])
      ORDER BY s.reviewed_at DESC`,
    [batchIds]
  );
  const byScale = {};
  for (const row of r.rows) {
    (byScale[row.scale_code] ||= {
      scale_code: row.scale_code, scale_name: row.scale_name,
      min: Number(row.smin), max: Number(row.smax), reviews: [],
    }).reviews.push({
      batch: row.batch_code, score: Number(row.score), notes: row.cup_notes,
      cupper: row.cupper, reviewed_at: row.reviewed_at,
    });
  }
  const scales = Object.values(byScale);
  // 仅在同一量表内部做归一化排名
  for (const sc of scales) {
    const ranked = sc.reviews.slice().sort((a, b) => b.score - a.score);
    ranked.forEach((rv, i) => { rv.rank_within_scale = i + 1; rv.normalized = Number(((rv.score - sc.min) / (sc.max - sc.min)).toFixed(3)); });
    sc.ranked = ranked;
  }
  result.sensory = {
    scales,
    cross_scale_ranking: false,
    note: scales.length > 1
      ? '检测到多种评分量表：不同量表的分数不做直接排名，仅在各量表内部排序并给出 0~1 归一化位置（归一化仅供参考）。'
      : (scales.length === 1 ? '全部评语使用同一量表，可直接排名。' : '这些批次暂无感官评语。'),
  };
  return result;
}

// 产品（豆款）汇总比较：按产品取已发布批次，逐批展开条件检查
async function compareProducts(productIds) {
  const db = await getDb();
  const unique = [...new Set(productIds.map(Number))];
  const groups = [];
  let comparable = unique.length >= 2;
  const productChecks = [];

  for (const pid of unique) {
    const p = await db.query(
      `SELECT * FROM products WHERE id = $1`, [pid]
    );
    if (!p.rows.length) { productChecks.push({ severity: 'BLOCK', detail: { product_id: pid, reason: '产品不存在' } }); comparable = false; continue; }
    const prod = p.rows[0];
    const batches = await db.query(
      `SELECT b.*, (SELECT count(*)::int FROM curves c WHERE c.batch_id=b.id AND c.accepted=true AND c.phase='production') AS curve_count
         FROM batches b WHERE b.product_id = $1 AND b.status IN ('published','delisted')
        ORDER BY b.roast_date NULLS LAST, b.created_at`, [pid]
    );
    const batchRows = batches.rows;
    const published = batchRows.filter((b) => b.status === 'published');
    const delisted = batchRows.filter((b) => b.status === 'delisted');
    const probeSet = new Set(), posSet = new Set(), tzSet = new Set(), intervalSet = new Set(), originSet = new Set(), processSet = new Set();
    for (const b of batchRows) {
      if (b.origin_id) originSet.add(b.origin_id);
      if (b.process_id) processSet.add(b.process_id);
    }
    // 拉取每批元数据
    const meta = await db.query(
      `SELECT DISTINCT ON (batch_id) batch_id, probe_model, probe_position, time_zero, sample_interval_s
         FROM curves WHERE batch_id = ANY($1::int[]) AND accepted=true AND phase='production'
        ORDER BY batch_id, created_at DESC`,
      [batchRows.map((b) => b.id)]
    );
    meta.rows.forEach((m) => { probeSet.add(m.probe_model); posSet.add(m.probe_position); tzSet.add(m.time_zero); intervalSet.add(Number(m.sample_interval_s)); });

    const warnings = [];
    if (batchRows.length > 1) warnings.push(`该豆款名下有 ${batchRows.length} 个批次：品牌同名不等于实验条件相同，比较已逐批展开，不把同名当作相同实验条件。`);
    const replacedRows = await db.query(
      `SELECT count(*)::int AS n FROM batch_lineage l WHERE l.relation='replace'
         AND l.child_id = ANY($1::int[]) AND l.parent_id = ANY($1::int[])`,
      [batchRows.map((b) => b.id)]);
    const replaced = Number(replacedRows.rows[0].n) > 0;
    if (replaced) warnings.push('该豆款存在换批(replace)谱系：旧曲线仍绑定原批次，不会迁移到新批。');
    if (probeSet.size > 1 || posSet.size > 1 || tzSet.size > 1 || intervalSet.size > 1) {
      warnings.push('该豆款各批次的测量条件（探头/位置/时间零点/采样间隔）不一致，汇总值仅作描述，不参与跨豆款排名。');
      comparable = false;
    }
    if (originSet.size > 1 || processSet.size > 1) warnings.push('该豆款不同批次的产地/处理法发生过变化。');
    if (delisted.length) warnings.push(`包含 ${delisted.length} 个已下架批次（历史链接仍可访问，明确标注“已下架”）。`);

    groups.push({
      product: { id: prod.id, brand: prod.brand, name: prod.name, slug: prod.slug },
      batch_count: batchRows.length,
      batches: batchRows.map((b) => ({
        id: b.id, code: b.code, status: b.status, roast_date: b.roast_date,
        harvest_year: b.harvest_year, origin_id: b.origin_id, process_id: b.process_id,
        curve_count: b.curve_count,
      })),
      warnings,
    });
  }

  // 跨产品：取各产品“当前发布且有曲线”的批次集合做两两批次检查
  const candidateIds = [];
  for (const g of groups) candidateIds.push(...g.batches.filter((b) => b.status === 'published' && b.curve_count > 0).map((b) => b.id));
  let pairwise = null;
  if (candidateIds.length >= 2 && new Set(groups.map((g) => g.product.id)).size >= 2) {
    pairwise = await compareBatches(candidateIds);
    if (!pairwise.comparable) comparable = false;
  } else if (candidateIds.length < 2) {
    comparable = false;
  }

  return {
    mode: 'product',
    comparable,
    rationale: comparable
      ? '各产品当前批次的测量条件一致，可在批次层面叠合比较。'
      : '产品汇总层面存在不可比因素：请下钻到具体批次并阅读各分组的解释。',
    groups,
    pairwise: pairwise ? {
      comparable: pairwise.comparable,
      checks: pairwise.checks,
      rationale: pairwise.rationale,
      chart: pairwise.chart,
    } : null,
    sensory: pairwise ? pairwise.sensory : null,
  };
}

module.exports = { compareBatches, compareProducts, loadBatchCurveData, OVERLAP_MIN };
