import { Router } from 'express';
import multer from 'multer';
import { one, many, q } from '../db.js';
import { putCurve, parseCsv, analyzeRows } from '../curveStore.js';
import { publishBatch, withdrawBatch, lineage } from '../services.js';
import { ADMIN_USER, ADMIN_PASS } from '../config.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

export function authToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}
// 简单令牌会话：登录 -> token=base64(user:pass)，前端存 sessionStorage
export function requireAuth(req, res, next) {
  const t = authToken(req);
  if (t) {
    try {
      const [u, p] = Buffer.from(t, 'base64').toString().split(':');
      if (u === ADMIN_USER && p === ADMIN_PASS) return next();
    } catch { /* fallthrough */ }
  }
  res.status(401).json({ error: '未登录' });
}

export const adm = Router();
adm.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS)
    return res.json({ token: Buffer.from(`${username}:${password}`).toString('base64') });
  res.status(401).json({ error: '账号或密码错误' });
});

adm.use(requireAuth);

// --- 谱系/批次 ---
adm.get('/batches', async (_req, res) =>
  res.json(await many(`SELECT b.*, p.brand, p.name AS product_name FROM batches b
    LEFT JOIN products p ON p.id=b.product_id ORDER BY b.roast_date DESC, b.id DESC`)));

adm.post('/batches', async (req, res) => {
  const { code, product_id, origin_id, process_id, parent_id, lineage_note,
    roast_date, roaster, machine, weight_in_g, weight_out_g, story } = req.body || {};
  try {
    const r = await one(`INSERT INTO batches
      (code,product_id,origin_id,process_id,parent_id,lineage_note,roast_date,roaster,machine,weight_in_g,weight_out_g,story,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft') RETURNING *`,
      [code, product_id || null, origin_id || null, process_id || null, parent_id || null,
        lineage_note || '', roast_date, roaster || '', machine || '', weight_in_g || null, weight_out_g || null, story || '']);
    res.status(201).json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

adm.get('/batches/:id/lineage', async (req, res) => res.json(await lineage(Number(req.params.id))));
adm.post('/batches/:id/publish', async (req, res) => {
  try { res.json(await publishBatch(Number(req.params.id))); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
adm.post('/batches/:id/withdraw', async (req, res) => {
  try { res.json(await withdrawBatch(Number(req.params.id), req.body?.reason || '')); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
adm.post('/batches/:id/republish', async (req, res) => {
  await q(`UPDATE batches SET status='published', withdrawn_at=NULL WHERE id=$1`, [req.params.id]);
  res.json({ ok: true, note: '重发后，曾因撤回转入待确认的报名仍需人工确认，不自动恢复' });
});

// 换批：产品 current_batch_id 指向新批；旧曲线不迁移，仍绑定原批
adm.post('/products/:id/set-current-batch', async (req, res) => {
  const { batch_id } = req.body || {};
  const ok = await one(`SELECT 1 FROM batches WHERE id=$1 AND product_id=$2`, [batch_id, req.params.id]);
  if (!ok) return res.status(400).json({ error: '批次不属于该产品' });
  const r = await q(`UPDATE products SET current_batch_id=$1 WHERE id=$2`, [batch_id, req.params.id]);
  res.json({ ok: true, note: '已切换当前批次；历史曲线永久绑定其原批次，不随换批迁移' });
});

// --- 曲线提交/验收 ---
// 晚到标记：?late=1 表示该曲线在批次已发布/下架后补录
adm.post('/batches/:id/curves', upload.single('file'), async (req, res) => {
  const batchId = Number(req.params.id);
  const b = await one(`SELECT * FROM batches WHERE id=$1`, [batchId]);
  if (!b) return res.status(404).json({ error: '批次不存在' });
  if (!req.file) return res.status(400).json({ error: '缺少 CSV 文件（字段名 file）' });
  const meta = req.body || {};
  const probe_type = meta.probe_type;
  const time_zero = meta.time_zero;
  const temp_unit = meta.temp_unit || 'C';
  const sampling = Number(meta.sampling_interval_s);
  if (!['ET', 'BT', 'ET_BT'].includes(probe_type)) return res.status(400).json({ error: 'probe_type 必须为 ET/BT/ET_BT' });
  if (!['roast_start', 'turning_point', 'first_crack', 'charge'].includes(time_zero)) return res.status(400).json({ error: 'time_zero 非法' });
  if (!Number.isFinite(sampling) || sampling <= 0) return res.status(400).json({ error: 'sampling_interval_s 非法' });

  const text = req.file.buffer.toString('utf8');
  const parsed = parseCsv(text);
  if (parsed.error) return res.status(422).json({ error: `CSV 解析失败：${parsed.error}` });
  const an = analyzeRows({ rows: parsed.rows, columns: parsed.columns, expectedUnit: temp_unit });

  const stored = await putCurve(req.file.buffer);
  const dup = await one(`SELECT id FROM roast_curves WHERE sha256=$1`, [stored.sha256]);
  if (dup) return res.status(409).json({ error: '相同内容曲线已存在（sha256 去重）', existing_id: dup.id });

  const isLate = meta.late === '1' || meta.late === 'true' || b.status === 'published';
  const isBackfill = b.status === 'withdrawn';
  // 量纲错误/可疑或缺测过多 => needs_fix，禁止自动接受
  const review_status = an.problems.length ? 'needs_fix'
    : (isLate || isBackfill) ? 'needs_fix' : 'pending';
  const row = await one(`INSERT INTO roast_curves
    (batch_id,filename,sha256,size_bytes,source_filename,review_status,reject_reason,
     probe_type,probe_position,sampling_interval_s,time_zero,temp_unit,channel_meta,
     point_count,duration_s,max_gap_samples,gap_windows,range_check,is_late,late_for_batch_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17::jsonb,$18::jsonb,$19,$20)
    RETURNING *`,
    [batchId, stored.filename, stored.sha256, stored.size, req.file.originalname, review_status,
      an.problems.join('；'), probe_type, meta.probe_position || '', sampling, time_zero, temp_unit,
      JSON.stringify({ columns: parsed.columns }), an.pointCount, an.durationS,
      an.maxGapSamples, JSON.stringify(an.gapWindows), JSON.stringify(an.rangeCheck), isLate, batchId]);
  res.status(201).json({ curve: row, parse_problems: an.problems,
    note: an.problems.length ? '量纲/数据问题：状态 needs_fix，修复后才可验收'
      : isLate ? '曲线晚到补录，需管理员验收后方可作为已发布批次依据'
      : isBackfill ? '历史批次补录曲线，需管理员验收，不改变其下架状态'
      : '已提交，待验收' });
});

adm.get('/curves/pending', async (_req, res) =>
  res.json(await many(`SELECT c.*, b.code AS batch_code FROM roast_curves c
    JOIN batches b ON b.id=c.batch_id
    WHERE c.review_status IN ('pending','needs_fix') ORDER BY c.submitted_at`)));

adm.post('/curves/:id/review', async (req, res) => {
  const { action, reason = '' } = req.body || {};
  const c = await one(`SELECT * FROM roast_curves WHERE id=$1`, [req.params.id]);
  if (!c) return res.status(404).json({ error: '曲线不存在' });
  if (action === 'accept') {
    if (c.range_check?.suspicious && reason !== 'override')
      return res.status(409).json({ error: '量纲可疑，不能直接接受；请先修正文件，或以 reason=override 人工豁免并留痕' });
    await q(`UPDATE roast_curves SET review_status='accepted', reject_reason='' WHERE id=$1`, [c.id]);
  } else if (action === 'reject') {
    await q(`UPDATE roast_curves SET review_status='rejected', reject_reason=$1 WHERE id=$2`, [reason || '管理员拒收', c.id]);
  } else return res.status(400).json({ error: 'action 必须为 accept/reject' });
  res.json({ ok: true });
});

// --- 感官评语 ---
adm.post('/batches/:id/sensory', async (req, res) => {
  const { scale_code, score, cupper, notes, flavor_tags } = req.body || {};
  const sc = await one(`SELECT * FROM sensory_scales WHERE code=$1`, [scale_code]);
  if (!sc) return res.status(400).json({ error: '未知量表' });
  const v = Number(score);
  if (!Number.isFinite(v) || v < sc.min_score || v > sc.max_score)
    return res.status(400).json({ error: `评分须在 ${sc.min_score}..${sc.max_score}（${sc.name}）` });
  const r = await one(`INSERT INTO sensory_evaluations(batch_id,scale_id,score,cupper,notes,flavor_tags)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.params.id, sc.id, v, cupper || '', notes || '', flavor_tags || []]);
  res.status(201).json(r);
});
adm.get('/scales', async (_req, res) => res.json(await many(`SELECT * FROM sensory_scales ORDER BY id`)));

// --- 活动与报名管理 ---
adm.get('/events', async (_req, res) => res.json(await many(`SELECT * FROM events ORDER BY held_on`)));
adm.post('/events', async (req, res) => {
  const { slug, title, held_on, location, capacity, description } = req.body || {};
  try {
    const r = await one(`INSERT INTO events(slug,title,held_on,location,capacity,description)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [slug, title, held_on, location, capacity, description || '']);
    res.status(201).json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
adm.post('/events/:id/batches', async (req, res) => {
  const { batch_id } = req.body || {};
  await q(`INSERT INTO event_demo_batches(event_id,batch_id) VALUES ($1,$2)
    ON CONFLICT DO NOTHING`, [req.params.id, batch_id]);
  res.status(201).json({ ok: true });
});
adm.delete('/events/:id/batches/:batchId', async (req, res) => {
  await q(`DELETE FROM event_demo_batches WHERE event_id=$1 AND batch_id=$2`, [req.params.id, req.params.batchId]);
  res.json({ ok: true });
});
adm.get('/events/:id/registrations', async (req, res) => {
  res.json(await many(`SELECT * FROM registrations WHERE event_id=$1 ORDER BY created_at`, [req.params.id]));
});
adm.post('/registrations/:id/confirm', async (req, res) => {
  await q(`UPDATE registrations SET status='registered', updated_at=now() WHERE id=$1`, [req.params.id]);
  await q(`INSERT INTO registration_events_log(registration_id,event_id,kind,detail)
    SELECT id,event_id,'manual_confirm','管理员人工确认待确认报名' FROM registrations WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});
adm.post('/registrations/:id/cancel', async (req, res) => {
  await q(`UPDATE registrations SET status='cancelled', updated_at=now() WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

// 词典/产地/处理法基础维护
adm.post('/terms', async (req, res) => {
  const { slug, term, category, definition, see_also } = req.body || {};
  try {
    const r = await one(`INSERT INTO glossary_terms(slug,term,category,definition,see_also)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`, [slug, term, category, definition, see_also || []]);
    res.status(201).json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
