import { Router } from 'express';
import { one, many } from '../db.js';
import { compareBatches, compareProducts, sensoryByScale, tzLabel } from '../comparability.js';
import { eventAvailability, submitRegistration, lineage } from '../services.js';
import { getCurvePath, parseCsv, analyzeRows } from '../curveStore.js';
import fs from 'node:fs';
import { MAX_GAP_SAMPLES_FOR_INTERP } from '../config.js';

export const pub = Router();

pub.get('/origins', async (_req, res) =>
  res.json(await many(`SELECT * FROM origins ORDER BY name`)));

pub.get('/origins/:slug', async (req, res) => {
  const o = await one(`SELECT * FROM origins WHERE slug=$1`, [req.params.slug]);
  if (!o) return res.status(404).json({ error: '产地不存在' });
  const processes = await many(`
    SELECT p.*, op.note FROM processes p
    JOIN origin_processes op ON op.process_id=p.id WHERE op.origin_id=$1 ORDER BY p.name`, [o.id]);
  const terms = await many(`
    SELECT t.* FROM glossary_terms t JOIN origin_terms ot ON ot.term_id=t.id
    WHERE ot.origin_id=$1 ORDER BY t.term`, [o.id]);
  const batches = await many(`
    SELECT b.*, p.brand, p.name AS product_name FROM batches b
    LEFT JOIN products p ON p.id=b.product_id
    WHERE b.origin_id=$1 AND b.status='published'
    ORDER BY b.roast_date DESC`, [o.id]);
  const events = await many(`
    SELECT DISTINCT e.id,e.slug,e.title,e.held_on,e.location FROM events e
    JOIN event_demo_batches edb ON edb.event_id=e.id
    JOIN batches b ON b.id=edb.batch_id
    WHERE b.origin_id=$1 AND b.status='published' AND e.published AND e.held_on > now()
    GROUP BY e.id ORDER BY e.held_on`, [o.id]);
  res.json({ origin: o, processes, terms, batches, events });
});

pub.get('/processes', async (_req, res) => res.json(await many(`SELECT * FROM processes ORDER BY name`)));
pub.get('/processes/:slug', async (req, res) => {
  const p = await one(`SELECT * FROM processes WHERE slug=$1`, [req.params.slug]);
  if (!p) return res.status(404).json({ error: '处理法不存在' });
  const terms = await many(`
    SELECT t.* FROM glossary_terms t JOIN process_terms pt ON pt.term_id=t.id
    WHERE pt.process_id=$1 ORDER BY t.term`, [p.id]);
  const origins = await many(`
    SELECT o.*, op.note FROM origins o JOIN origin_processes op ON op.origin_id=o.id
    WHERE op.process_id=$1`, [p.id]);
  const batches = await many(`
    SELECT b.*, br.brand, br.name AS product_name FROM batches b
    LEFT JOIN products br ON br.id=b.product_id
    WHERE b.process_id=$1 AND b.status='published' ORDER BY b.roast_date DESC`, [p.id]);
  const events = await many(`
    SELECT DISTINCT e.id,e.slug,e.title,e.held_on,e.location FROM events e
    JOIN event_demo_batches edb ON edb.event_id=e.id
    JOIN batches b ON b.id=edb.batch_id
    WHERE b.process_id=$1 AND b.status='published' AND e.published AND e.held_on > now()
    GROUP BY e.id ORDER BY e.held_on`, [p.id]);
  res.json({ process: p, terms, origins, batches, events });
});

pub.get('/terms', async (req, res) => {
  const cat = req.query.category;
  res.json(await many(cat
    ? `SELECT * FROM glossary_terms WHERE category=$1 ORDER BY term`
    : `SELECT * FROM glossary_terms ORDER BY category, term`, cat ? [cat] : []));
});

pub.get('/products', async (_req, res) =>
  res.json(await many(`
    SELECT p.*, b.code AS current_batch_code FROM products p
    LEFT JOIN batches b ON b.id=p.current_batch_id ORDER BY p.brand,p.name`)));

pub.get('/products/:id', async (req, res) => {
  const p = await one(`SELECT * FROM products WHERE id=$1`, [req.params.id]);
  if (!p) return res.status(404).json({ error: '产品不存在' });
  const batches = await many(`
    SELECT b.*, (SELECT count(*) FROM roast_curves c WHERE c.batch_id=b.id AND c.review_status='accepted') AS accepted_curves
    FROM batches b WHERE b.product_id=$1 ORDER BY b.roast_date`, [p.id]);
  res.json({ product: p, batches });
});

pub.get('/batches/:id', async (req, res) => {
  const b = await one(`
    SELECT b.*, p.brand, p.name AS product_name, o.name AS origin_name, o.slug AS origin_slug,
           pr.name AS process_name, pr.slug AS process_slug
    FROM batches b
    LEFT JOIN products p ON p.id=b.product_id
    LEFT JOIN origins o ON o.id=b.origin_id
    LEFT JOIN processes pr ON pr.id=b.process_id
    WHERE b.id=$1`, [req.params.id]);
  if (!b) return res.status(404).json({ error: '批次不存在' });
  // 下架批次：历史仍可只读访问，仅明确状态
  const curves = await many(`SELECT id,filename,source_filename,submitted_at,received_at,review_status,
      probe_type,probe_position,sampling_interval_s,time_zero,temp_unit,point_count,duration_s,
      max_gap_samples,gap_windows,range_check,is_late,reject_reason,sha256
    FROM roast_curves WHERE batch_id=$1 ORDER BY submitted_at`, [b.id]);
  const sensory = await many(`
    SELECT se.*, sc.code AS scale_code, sc.name AS scale_name, sc.min_score, sc.max_score
    FROM sensory_evaluations se JOIN sensory_scales sc ON sc.id=se.scale_id
    WHERE se.batch_id=$1 ORDER BY se.evaluated_on DESC`, [b.id]);
  res.json({ batch: b, curves, sensory, time_zero_note: '时间零点以每条曲线测量元数据为准（批次不假定统一零点）' });
});

pub.get('/batches/:id/lineage', async (req, res) => res.json(await lineage(Number(req.params.id))));

// 曲线点（含原始缺测标记 + 仅显示用短缺口插值标记）
pub.get('/curves/:id/points', async (req, res) => {
  const c = await one(`SELECT * FROM roast_curves WHERE id=$1`, [req.params.id]);
  if (!c) return res.status(404).json({ error: '曲线不存在' });
  const full = await getCurvePath(c.filename);
  const text = fs.readFileSync(full, 'utf8');
  const parsed = parseCsv(text);
  if (parsed.error) return res.status(422).json({ error: parsed.error });
  const an = analyzeRows({ rows: parsed.rows, columns: parsed.columns, expectedUnit: c.temp_unit });
  // 显示用插值：仅对 <= MAX 的连续缺口，且逐点标记 interpolated:true
  const points = an.points.map((p) => ({ ...p, interpolated: {} }));
  for (const col of an.tempCols) {
    for (let i = 0; i < points.length; i++) {
      if (points[i][col] === null) {
        let j = i;
        while (j < points.length && points[j][col] === null) j++;
        const gapLen = j - i;
        if (gapLen <= MAX_GAP_SAMPLES_FOR_INTERP && i > 0 && j < points.length) {
          const v0 = points[i - 1][col], v1 = points[j][col];
          for (let k = i; k < j; k++) {
            points[k][col] = v0 + (v1 - v0) * ((k - i + 1) / (gapLen + 1));
            points[k].interpolated[col] = true;
          }
        }
        i = j;
      }
    }
  }
  res.json({
    curve: { id: c.id, batch_id: c.batch_id, probe_type: c.probe_type, probe_position: c.probe_position,
      sampling_interval_s: c.sampling_interval_s, time_zero: c.time_zero, temp_unit: c.temp_unit,
      received_at: c.received_at, submitted_at: c.submitted_at, is_late: c.is_late },
    columns: an.tempCols, points,
    gap_policy: `null 为原始缺测；长度 <= ${MAX_GAP_SAMPLES_FOR_INTERP} 的缺口仅在图上虚线插值显示，长缺测（max=${c.max_gap_samples} 点）不填补、不参与比较`,
    source_sha256: c.sha256,
  });
});

// 原始文件下载：可追溯到原数据（含响应头 sha256/批次/测量元数据）
pub.get('/curves/:id/download', async (req, res) => {
  const c = await one(`SELECT c.*, b.code AS batch_code FROM roast_curves c JOIN batches b ON b.id=c.batch_id WHERE c.id=$1`, [req.params.id]);
  if (!c) return res.status(404).json({ error: '曲线不存在' });
  const full = await getCurvePath(c.filename);
  const asc = (v) => encodeURIComponent(String(v ?? '')).replace(/%/g, '=');
  res.setHeader('X-Source-SHA256', c.sha256);
  res.setHeader('X-Batch-Code', asc(c.batch_code));
  res.setHeader('X-Probe', asc(`${c.probe_type}/${c.probe_position || ''}`));
  res.setHeader('X-Sampling-Interval-s', String(c.sampling_interval_s));
  res.setHeader('X-Time-Zero', c.time_zero);
  res.setHeader('X-Temp-Unit', c.temp_unit);
  res.setHeader('X-Received-At', new Date(c.received_at).toISOString());
  res.download(full, c.source_filename || `${c.sha256.slice(0, 12)}.csv`);
});

// 比较：?mode=batch&ids=1,2,3 或 mode=product&ids=1,2
pub.get('/compare', async (req, res) => {
  const mode = req.query.mode || 'batch';
  const ids = String(req.query.ids || '').split(',').map((x) => Number(x)).filter(Boolean);
  if (ids.length < 2) return res.status(400).json({ error: '至少选择 2 个对象' });
  if (mode === 'product') return res.json(await compareProducts(ids));
  return res.json(await compareBatches(ids));
});

pub.get('/compare/sensory', async (req, res) => {
  const ids = String(req.query.batches || '').split(',').map(Number).filter(Boolean);
  if (ids.length < 2) return res.status(400).json({ error: '至少选择 2 个批次' });
  res.json(await sensoryByScale(ids));
});

pub.get('/events', async (_req, res) => res.json(await many(`SELECT * FROM events WHERE published ORDER BY held_on`)));
pub.get('/events/:id', async (req, res) => {
  const av = await eventAvailability(Number(req.params.id));
  if (!av) return res.status(404).json({ error: '活动不存在' });
  const demos = await many(`
    SELECT b.id,b.code,b.status,p.brand,p.name AS product_name
    FROM event_demo_batches edb JOIN batches b ON b.id=edb.batch_id
    LEFT JOIN products p ON p.id=b.product_id WHERE edb.event_id=$1`, [av.id]);
  res.json({ event: av, demo_batches: demos });
});
pub.post('/events/:id/register', async (req, res) => {
  const { name, email, note, idempotency_key } = req.body || {};
  if (!name || !email || !idempotency_key)
    return res.status(400).json({ error: 'name / email / idempotency_key 必填' });
  try {
    const out = await submitRegistration({
      eventId: Number(req.params.id), name, email, note, idempotencyKey: idempotency_key,
    });
    res.status(201).json(out);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
