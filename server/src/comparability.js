// 可比条件检查：
// 1) 温度探头类型/位置必须相同 2) 采样间隔容差 <=10% 3) 时间零点必须一致，否则只允许对齐显示且明确标识
// 4) 温度单位必须一致 5) 插值仅显示用，> MAX_GAP_SAMPLES_FOR_INTERP 的缺测 => 该通道区间不可比
// 6) 感官评分量表不同 => 不可直接排名
import { MAX_GAP_SAMPLES_FOR_INTERP } from './config.js';
import { many } from './db.js';

export async function loadCurveContext(curveId) {
  const rows = await many(`
    SELECT c.*, b.code AS batch_code, b.status AS batch_status, p.brand, p.name AS product_name,
           sc.code AS scale_code
    FROM roast_curves c
    JOIN batches b ON b.id = c.batch_id
    LEFT JOIN products p ON p.id = b.product_id
    LEFT JOIN LATERAL (
      SELECT sc.code FROM sensory_evaluations se
      JOIN sensory_scales sc ON sc.id = se.scale_id
      WHERE se.batch_id = b.id LIMIT 1
    ) sc ON true
    WHERE c.id = $1`, [curveId]);
  return rows[0] || null;
}

export async function loadBatchCurveContexts(batchIds) {
  if (!batchIds.length) return [];
  return many(`
    SELECT c.*, b.code AS batch_code, b.status AS batch_status, p.brand, p.name AS product_name,
           b.product_id, b.id AS batch_id
    FROM roast_curves c
    JOIN batches b ON b.id = c.batch_id
    LEFT JOIN products p ON p.id = b.product_id
    WHERE c.review_status = 'accepted' AND c.batch_id = ANY($1::int[])
    ORDER BY c.submitted_at DESC`, [batchIds]);
}

function pairCheck(a, b) {
  const checks = [];
  const add = (key, ok, label, detail, severity = 'block') =>
    checks.push({ key, ok, label, detail, severity: ok ? 'ok' : severity });

  add('probe', a.probe_type === b.probe_type && (a.probe_position || '') === (b.probe_position || ''),
    '温度探头',
    `A: ${a.probe_type}${a.probe_position ? `/${a.probe_position}` : ''}；B: ${b.probe_type}${b.probe_position ? `/${b.probe_position}` : ''}`);

  const ia = Number(a.sampling_interval_s), ib = Number(b.sampling_interval_s);
  const tol = Math.abs(ia - ib) / Math.max(ia, ib);
  add('sampling', tol <= 0.1, '采样间隔',
    `A: ${ia}s；B: ${ib}s（差异 ${(tol * 100).toFixed(1)}%，容差 10%）`);

  add('timezero', a.time_zero === b.time_zero, '时间零点',
    `A: ${tzLabel(a.time_zero)}；B: ${tzLabel(b.time_zero)}`);

  add('unit', a.temp_unit === b.temp_unit, '温度单位',
    `A: °${a.temp_unit}；B: °${b.temp_unit}`);

  const gapA = a.max_gap_samples > MAX_GAP_SAMPLES_FOR_INTERP;
  const gapB = b.max_gap_samples > MAX_GAP_SAMPLES_FOR_INTERP;
  add('gap', !gapA && !gapB, '缺测处理',
    gapA || gapB
      ? `存在 >${MAX_GAP_SAMPLES_FOR_INTERP} 点连续缺测（A ${a.max_gap_samples} / B ${b.max_gap_samples}）；插值仅用于短缺口显示，长缺测区间不比较`
      : `最长连续缺测 A ${a.max_gap_samples} / B ${b.max_gap_samples} 点，可在图上以插值显示并标识`,
    'partial');

  const hardKeys = ['probe', 'sampling', 'timezero', 'unit'];
  const comparable = checks.filter((c) => hardKeys.includes(c.key)).every((c) => c.ok);
  const partial = comparable && checks.some((c) => c.key === 'gap' && !c.ok);
  return {
    checks,
    comparable,
    partial,
    verdict: !comparable ? 'incomparable' : partial ? 'comparable_with_gaps' : 'comparable',
  };
}

export function tzLabel(tz) {
  return { roast_start: '烘焙开始(Start)', turning_point: '回温点(TP)', first_crack: '一爆(FC)', charge: '下豆(Charge)' }[tz] || tz;
}

// 批次模式：每批取最新接受曲线，逐对检查
export async function compareBatches(batchIds) {
  const ctxs = await loadBatchCurveContexts(batchIds);
  const picked = new Map();
  for (const c of ctxs) if (!picked.has(c.batch_id)) picked.set(c.batch_id, c);
  const list = [...picked.values()];
  const items = list.map((c) => ({
    curve_id: c.id, batch_id: c.batch_id, batch_code: c.batch_code,
    brand: c.brand, product_name: c.product_name, status: c.batch_status,
    probe_type: c.probe_type, probe_position: c.probe_position,
    sampling_interval_s: c.sampling_interval_s, time_zero: c.time_zero, temp_unit: c.temp_unit,
    max_gap_samples: c.max_gap_samples,
  }));
  const pairResults = [];
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const r = pairCheck(list[i], list[j]);
      pairResults.push({
        a: list[i].batch_code, b: list[j].batch_code, ...r,
      });
    }
  const notes = buildNameNotes(list);
  return { mode: 'batch', items, pairs: pairResults, notes };
}

// 产品模式：按产品汇总其全部批次曲线；同名同品牌不视为实验条件相同
export async function compareProducts(productIds) {
  const rows = await many(`
    SELECT c.*, b.code AS batch_code, b.status AS batch_status, b.id AS batch_id,
           p.brand, p.name AS product_name, p.id AS product_id
    FROM products p
    JOIN batches b ON b.product_id = p.id
    JOIN roast_curves c ON c.batch_id = b.id AND c.review_status = 'accepted'
    WHERE p.id = ANY($1::int[])
    ORDER BY p.id, b.roast_date DESC, c.submitted_at DESC`, [productIds]);
  const byProduct = new Map();
  for (const r of rows) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push(r);
  }
  const groups = [...byProduct.entries()].map(([pid, curves]) => ({
    product_id: pid, brand: curves[0].brand, product_name: curves[0].product_name,
    batch_count: new Set(curves.map((c) => c.batch_id)).size,
    curves: curves.map((c) => ({
      curve_id: c.id, batch_id: c.batch_id, batch_code: c.batch_code, status: c.batch_status,
      probe_type: c.probe_type, sampling_interval_s: c.sampling_interval_s,
      time_zero: c.time_zero, temp_unit: c.temp_unit, max_gap_samples: c.max_gap_samples,
    })),
  }));
  // 跨产品：只比较“各自当前/每批”，并对每对跨组曲线生成解释
  const pairs = [];
  const glist = [...byProduct.values()];
  for (let i = 0; i < glist.length; i++) {
    for (let j = i + 1; j < glist.length; j++) {
      const A = glist[i], B = glist[j];
      // 产品聚合比较仅在“批对批”层面可比；逐对输出
      for (const a of A.slice(0, 3)) for (const b of B.slice(0, 3)) {
        const r = pairCheck(a, b);
        pairs.push({ a: a.batch_code, b: b.batch_code, product_a: `${a.brand}/${a.product_name}`, product_b: `${b.brand}/${b.product_name}`, ...r });
      }
    }
  }
  const allCurves = rows;
  const notes = buildNameNotes(allCurves);
  return { mode: 'product', groups, pairs, notes };
}

// 品牌同名提示：同名不代表实验条件相同；换批后旧曲线仍绑定原批
function buildNameNotes(curves) {
  const names = new Map();
  for (const c of curves) {
    const key = `${c.brand}::${c.product_name}`;
    if (!names.has(key)) names.set(key, []);
    names.get(key).push(c.batch_code);
  }
  const notes = [];
  for (const [key, codes] of names) {
    if (new Set(codes).size > 1)
      notes.push(`「${key.replace('::', ' / ')}」出现于多个批次（${[...new Set(codes)].join('、')}）；曲线始终绑定原批次，同名品牌不作为实验条件相同的依据。`);
  }
  return notes;
}

// 感官可比性：按量表分组，禁止跨量表排名
export async function sensoryByScale(batchIds) {
  const rows = await many(`
    SELECT se.id, se.batch_id, b.code AS batch_code, se.score, sc.code AS scale_code,
           sc.name AS scale_name, sc.min_score, sc.max_score, se.notes, se.flavor_tags,
           se.cupper, se.evaluated_on
    FROM sensory_evaluations se
    JOIN sensory_scales sc ON sc.id = se.scale_id
    JOIN batches b ON b.id = se.batch_id
    WHERE se.batch_id = ANY($1::int[])
    ORDER BY sc.id, se.score DESC`, [batchIds]);
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.scale_code)) groups.set(r.scale_code, { scale: r.scale_code, name: r.scale_name, min: r.min_score, max: r.max_score, rankings: [] });
    const g = groups.get(r.scale_code);
    g.rankings.push({ ...r, normalized: (r.score - r.min_score) / (r.max_score - r.min_score) });
  }
  return {
    groups: [...groups.values()],
    ranking_allowed: groups.size === 1,
    explanation: groups.size > 1
      ? `检测到 ${groups.size} 套不同量表（${[...groups.keys()].join('、')}），已分组展示；不同量表分值口径不同，不提供跨量表混合排名。组内可按归一化(0..1)参考。`
      : groups.size === 1 ? '全部评语使用同一量表，可直接排名。' : '该范围内暂无感官评语。',
  };
}
