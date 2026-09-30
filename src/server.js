'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { getDb } = require('./db');
const { validateCurve, storeCurveFile, loadCurveSeries, resolveStored, sha256 } = require('./lib/curves');
const { compareBatches, compareProducts } = require('./lib/comparability');
const { eventCapacity, adjustInventory, createRegistration } = require('./lib/events');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'roast-admin';
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 会话（极简签名 cookie，无外部依赖） ----------
function sign(v) { return crypto.createHmac('sha256', ADMIN_PASSWORD).update(v).digest('hex'); }
function setSession(res) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const exp = Date.now() + SESSION_TTL_MS;
  const body = `${nonce}.${exp}`;
  res.cookie('rss_session', `${body}.${sign(body)}`, { httpOnly: true, sameSite: 'lax' });
}
function isAdmin(req) {
  const c = req.cookies.rss_session;
  if (!c) return false;
  const m = /^([0-9a-f]+\.\d+)\.([0-9a-f]+)$/.exec(c);
  if (!m) return false;
  if (sign(m[1]) !== m[2]) return false;
  return Number(m[1].split('.')[1]) > Date.now();
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: '需要管理员登录' });
  next();
}
function requester(req) { return isAdmin(req) ? 'admin:session' : 'public'; }

function wrap(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }

// ---------- 公共：站点目录 ----------
app.get('/api/health', wrap(async (req, res) => {
  const db = await getDb();
  res.json({ ok: true, db: db.mode, time: new Date().toISOString() });
}));

app.get('/api/catalog', wrap(async (req, res) => {
  const db = await getDb();
  const origins = await db.query('SELECT id,slug,name,country,region,altitude_m,story FROM origins ORDER BY name');
  const processes = await db.query('SELECT id,slug,name,category,description FROM processes ORDER BY name');
  const products = await db.query(
    `SELECT p.id,p.slug,p.brand,p.name,p.description,
            (SELECT count(*)::int FROM batches b WHERE b.product_id=p.id AND b.status='published') AS published_batches
       FROM products p WHERE p.active=true ORDER BY p.brand,p.name`);
  const events = await db.query(
    `SELECT id,slug,title,starts_at,capacity,status FROM events WHERE status='open' ORDER BY starts_at`);
  const terms = await db.query('SELECT id,slug,term,kind FROM glossary_terms ORDER BY kind,term');
  res.json({ origins: origins.rows, processes: processes.rows, products: products.rows, events: events.rows, terms: terms.rows });
}));

// 产地详情：关联批次曲线、术语、活动
app.get('/api/origins/:slug', wrap(async (req, res) => {
  const db = await getDb();
  const o = await db.query('SELECT * FROM origins WHERE slug=$1', [req.params.slug]);
  if (!o.rows.length) return res.status(404).json({ error: '产地不存在' });
  const batches = await db.query(
    `SELECT b.id,b.slug,b.code,b.status,b.harvest_year,b.roast_date,b.roast_level,b.machine,
            p.slug AS product_slug,p.brand,p.name,
            pr.slug AS process_slug,pr.name AS process_name,
            (SELECT count(*)::int FROM curves c WHERE c.batch_id=b.id AND c.accepted=true) AS curve_count
       FROM batches b
       LEFT JOIN products p ON p.id=b.product_id
       LEFT JOIN processes pr ON pr.id=b.process_id
      WHERE b.origin_id=$1 ORDER BY b.roast_date DESC NULLS LAST`, [o.rows[0].id]);
  const terms = await db.query(
    `SELECT g.* FROM glossary_terms g JOIN origin_glossary og ON og.term_id=g.id
      WHERE og.origin_id=$1 ORDER BY g.term`, [o.rows[0].id]);
  const events = await db.query(
    `SELECT DISTINCT e.id,e.slug,e.title,e.starts_at FROM events e
       JOIN event_demo_batches edb ON edb.event_id=e.id
       JOIN batches b ON b.id=edb.batch_id
      WHERE b.origin_id=$1 ORDER BY e.starts_at`, [o.rows[0].id]);
  res.json({ origin: o.rows[0], batches: batches.rows, terms: terms.rows, events: events.rows });
}));

// 处理法详情：同样关联批次曲线、术语、活动
app.get('/api/processes/:slug', wrap(async (req, res) => {
  const db = await getDb();
  const p = await db.query('SELECT * FROM processes WHERE slug=$1', [req.params.slug]);
  if (!p.rows.length) return res.status(404).json({ error: '处理法不存在' });
  const batches = await db.query(
    `SELECT b.id,b.slug,b.code,b.status,b.harvest_year,b.roast_date,b.roast_level,
            pp.slug AS product_slug,pp.brand,pp.name,
            o.slug AS origin_slug,o.name AS origin_name,o.country,
            (SELECT count(*)::int FROM curves c WHERE c.batch_id=b.id AND c.accepted=true) AS curve_count
       FROM batches b
       LEFT JOIN products pp ON pp.id=b.product_id
       LEFT JOIN origins o ON o.id=b.origin_id
      WHERE b.process_id=$1 ORDER BY b.roast_date DESC NULLS LAST`, [p.rows[0].id]);
  const terms = await db.query(
    `SELECT g.* FROM glossary_terms g JOIN process_glossary pg ON pg.term_id=g.id
      WHERE pg.process_id=$1 ORDER BY g.term`, [p.rows[0].id]);
  const events = await db.query(
    `SELECT DISTINCT e.id,e.slug,e.title,e.starts_at FROM events e
       JOIN event_demo_batches edb ON edb.event_id=e.id
       JOIN batches b ON b.id=edb.batch_id
      WHERE b.process_id=$1 ORDER BY e.starts_at`, [p.rows[0].id]);
  res.json({ process: p.rows[0], batches: batches.rows, terms: terms.rows, events: events.rows });
}));

app.get('/api/terms/:slug', wrap(async (req, res) => {
  const db = await getDb();
  const t = await db.query('SELECT * FROM glossary_terms WHERE slug=$1', [req.params.slug]);
  if (!t.rows.length) return res.status(404).json({ error: '术语不存在' });
  res.json({ term: t.rows[0] });
}));

// 产品详情：列出全部批次（含下架），强调批次边界
app.get('/api/products/:slug', wrap(async (req, res) => {
  const db = await getDb();
  const p = await db.query('SELECT * FROM products WHERE slug=$1', [req.params.slug]);
  if (!p.rows.length) return res.status(404).json({ error: '豆款不存在' });
  const batches = await db.query(
    `SELECT b.*, o.name AS origin_name, pr.name AS process_name,
            (SELECT count(*)::int FROM curves c WHERE c.batch_id=b.id AND c.accepted=true) AS curve_count
       FROM batches b LEFT JOIN origins o ON o.id=b.origin_id
                      LEFT JOIN processes pr ON pr.id=b.process_id
      WHERE b.product_id=$1 ORDER BY b.created_at`, [p.rows[0].id]);
  res.json({ product: p.rows[0], batches: batches.rows });
}));

// 批次详情（下架批次仍可访问，明确标注；谱系；曲线元数据；评语）
app.get('/api/batches/:slug', wrap(async (req, res) => {
  const db = await getDb();
  const br = await db.query(
    `SELECT b.*, p.brand,p.name AS product_name,p.slug AS product_slug,
            o.slug AS origin_slug,o.name AS origin_name,o.country,
            pr.slug AS process_slug,pr.name AS process_name
       FROM batches b LEFT JOIN products p ON p.id=b.product_id
                      LEFT JOIN origins o ON o.id=b.origin_id
                      LEFT JOIN processes pr ON pr.id=b.process_id
      WHERE b.slug=$1`, [req.params.slug]);
  if (!br.rows.length) return res.status(404).json({ error: '批次不存在' });
  const b = br.rows[0];
  const curves = await db.query(
    `SELECT c.id,c.curve_type,c.phase,c.original_filename,c.content_sha256,c.byte_size,
            c.probe_model,c.probe_position,c.temp_unit,c.sample_interval_s,c.time_zero,
            c.point_count,c.duration_s,c.max_gap_s,c.accepted,c.validation_status,c.validation_notes,
            c.recorded_at,c.created_at,
            (SELECT json_agg(json_build_object('channel',ch.channel,'unit',ch.unit,'point_count',ch.point_count,'max_gap_s',ch.max_gap_s))
               FROM curve_channels ch WHERE ch.curve_id=c.id) AS channels
       FROM curves c WHERE c.batch_id=$1 ORDER BY c.created_at DESC`, [b.id]);
  const parents = await db.query(
    `SELECT l.relation,l.note,b.id,b.slug,b.code,b.status FROM batch_lineage l
       JOIN batches b ON b.id=l.parent_id WHERE l.child_id=$1`, [b.id]);
  const children = await db.query(
    `SELECT l.relation,l.note,b.id,b.slug,b.code,b.status FROM batch_lineage l
       JOIN batches b ON b.id=l.child_id WHERE l.parent_id=$1`, [b.id]);
  const reviews = await db.query(
    `SELECT s.*, sc.code AS scale_code, sc.name AS scale_name, sc.min_value AS scale_min, sc.max_value AS scale_max,
            c.phase AS curve_phase
       FROM sensory_reviews s JOIN rating_scales sc ON sc.id=s.scale_id
       LEFT JOIN curves c ON c.id=s.curve_id
      WHERE s.batch_id=$1 ORDER BY s.reviewed_at DESC`, [b.id]);
  res.json({
    batch: b,
    curves: curves.rows,
    lineage: { parents: parents.rows, children: children.rows },
    reviews: reviews.rows,
    delisted: b.status === 'delisted',
  });
}));

// 曲线测点（从文件读取，不入库）；公开端只给已接受曲线
app.get('/api/curves/:id/points', wrap(async (req, res) => {
  const db = await getDb();
  const r = await db.query('SELECT * FROM curves WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: '曲线不存在' });
  const c = r.rows[0];
  if (!c.accepted && !isAdmin(req)) return res.status(403).json({ error: '该曲线未通过校验，仅管理员可查看' });
  const data = loadCurveSeries(c.storage_path);
  res.json({
    curve: {
      id: c.id, batch_id: c.batch_id, phase: c.phase, curve_type: c.curve_type,
      probe_model: c.probe_model, probe_position: c.probe_position, temp_unit: c.temp_unit,
      sample_interval_s: Number(c.sample_interval_s), time_zero: c.time_zero,
      validation_status: c.validation_status, validation_notes: c.validation_notes,
    },
    ...data,
  });
}));

// ---------- 比较：按批次筛选 ----------
app.get('/api/compare/batches', wrap(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
  if (ids.length < 2) return res.status(400).json({ error: '请至少选择 2 个批次（?ids=1,2）' });
  res.json(await compareBatches(ids));
}));
// 比较：按产品汇总
app.get('/api/compare/products', wrap(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => Number(s.trim())).filter(Boolean);
  if (ids.length < 2) return res.status(400).json({ error: '请至少选择 2 个豆款（?ids=1,2）' });
  res.json(await compareProducts(ids));
}));

// ---------- 活动 ----------
app.get('/api/events/:slug', wrap(async (req, res) => {
  const db = await getDb();
  const e = await db.query('SELECT * FROM events WHERE slug=$1', [req.params.slug]);
  if (!e.rows.length) return res.status(404).json({ error: '活动不存在' });
  res.json(await eventCapacity(db, e.rows[0].id));
}));

app.post('/api/events/:slug/register', wrap(async (req, res) => {
  const db = await getDb();
  const e = await db.query('SELECT id FROM events WHERE slug=$1', [req.params.slug]);
  if (!e.rows.length) return res.status(404).json({ error: '活动不存在' });
  const out = await createRegistration(db, {
    event_id: e.rows[0].id,
    name: req.body.name, email: req.body.email, party_size: req.body.party_size,
    idempotency_key: req.body.idempotency_key, note: req.body.note,
  });
  const cap = await eventCapacity(db, e.rows[0].id);
  res.status(out.idempotent_replay ? 200 : 201).json({ ...out, capacity: cap });
}));

// ---------- 下载（审计，可追原数据） ----------
app.get('/api/curves/:id/download', wrap(async (req, res) => {
  const db = await getDb();
  const r = await db.query('SELECT * FROM curves WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: '曲线不存在' });
  const c = r.rows[0];
  if (!c.accepted && !isAdmin(req)) return res.status(403).json({ error: '该曲线已拒收，仅管理员可下载' });
  const full = resolveStored(c.storage_path);
  const buf = fs.readFileSync(full);
  const hashOk = sha256(buf) === c.content_sha256;
  await db.query(
    'INSERT INTO download_log (batch_id,curve_id,format,requester,content_sha256,byte_size) VALUES ($1,$2,$3,$4,$5,$6)',
    [c.batch_id, c.id, 'original', requester(req), c.content_sha256, buf.length]);
  res.setHeader('X-Content-SHA256', c.content_sha256);
  res.setHeader('X-Hash-Verified', hashOk ? 'ok' : 'mismatch');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(c.original_filename || c.storage_path)}"`);
  res.type(c.mime || 'application/octet-stream');
  res.send(buf);
}));

// 打包下载：批次全部原始曲线 + 元数据 + 评语 + 谱系（JSON bundle）
app.get('/api/batches/:slug/bundle', wrap(async (req, res) => {
  const db = await getDb();
  const br = await db.query('SELECT * FROM batches WHERE slug=$1', [req.params.slug]);
  if (!br.rows.length) return res.status(404).json({ error: '批次不存在' });
  const batch = br.rows[0];
  const curves = await db.query('SELECT * FROM curves WHERE batch_id=$1 ORDER BY created_at', [batch.id]);
  const files = [];
  for (const c of curves.rows) {
    const buf = fs.readFileSync(resolveStored(c.storage_path));
    files.push({
      curve_id: c.id, original_filename: c.original_filename, storage_path: c.storage_path,
      content_sha256: c.content_sha256, byte_size: c.byte_size, mime: c.mime,
      measurement: {
        probe_model: c.probe_model, probe_position: c.probe_position, temp_unit: c.temp_unit,
        sample_interval_s: Number(c.sample_interval_s), time_zero: c.time_zero,
        point_count: c.point_count, duration_s: Number(c.duration_s), max_gap_s: Number(c.max_gap_s),
      },
      validation: { status: c.validation_status, accepted: c.accepted, notes: c.validation_notes },
      content_base64: c.accepted || isAdmin(req) ? buf.toString('base64') : null,
    });
  }
  const reviews = await db.query(
    `SELECT s.score,s.cup_notes,s.cupper,s.reviewed_at,sc.code AS scale_code,sc.name AS scale_name,sc.min_value,sc.max_value
       FROM sensory_reviews s JOIN rating_scales sc ON sc.id=s.scale_id WHERE s.batch_id=$1`, [batch.id]);
  const lineage = await db.query(
    `SELECT (SELECT code FROM batches WHERE id=l.parent_id) AS parent,
            (SELECT code FROM batches WHERE id=l.child_id) AS child, l.relation,l.note
       FROM batch_lineage l WHERE l.parent_id=$1 OR l.child_id=$1`, [batch.id]);
  const bundle = {
    exported_at: new Date().toISOString(),
    batch: {
      slug: batch.slug, code: batch.code, status: batch.status, roast_date: batch.roast_date,
      harvest_year: batch.harvest_year, roast_level: batch.roast_level, machine: batch.machine, story: batch.story,
    },
    curves: files,
    sensory_reviews: reviews.rows,
    lineage: lineage.rows,
    note: '本包内含原始上传曲线文件（逐文件 sha256 可校验）、测量元数据与感官评语；数据可追溯到具体批次与曲线。',
  };
  const out = Buffer.from(JSON.stringify(bundle, null, 2));
  const bundleHash = sha256(out);
  fs.mkdirSync(path.join(__dirname, '..', 'storage', 'bundles'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'storage', 'bundles', `${batch.slug}-${Date.now()}.json`), out);
  await db.query(
    'INSERT INTO download_log (batch_id,curve_id,format,requester,content_sha256,byte_size) VALUES ($1,NULL,$2,$3,$4,$5)',
    [batch.id, 'bundle', requester(req), bundleHash, out.length]);
  res.setHeader('X-Content-SHA256', bundleHash);
  res.setHeader('Content-Disposition', `attachment; filename="${batch.slug}-bundle.json"`);
  res.type('application/json');
  res.send(out);
}));

// ---------- 认证 ----------
app.post('/api/admin/login', wrap(async (req, res) => {
  const expected = crypto.createHash('sha256').update(String(req.body.password || '')).digest('hex');
  const actual = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex');
  const ok = expected.length === actual.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  if (!ok) return res.status(401).json({ error: '密码错误' });
  setSession(res);
  res.json({ ok: true });
}));
app.post('/api/admin/logout', (req, res) => { res.clearCookie('rss_session'); res.json({ ok: true }); });
app.get('/api/admin/session', (req, res) => res.json({ admin: isAdmin(req) }));

// ---------- 管理端 ----------
app.get('/api/admin/overview', requireAdmin, wrap(async (req, res) => {
  const db = await getDb();
  const counts = {};
  for (const t of ['origins', 'processes', 'products', 'batches', 'curves', 'sensory_reviews', 'events', 'registrations']) {
    counts[t] = Number((await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
  }
  const drafts = await db.query(
    `SELECT b.id,b.slug,b.code,b.status,p.brand,p.name,
            (SELECT count(*)::int FROM curves c WHERE c.batch_id=b.id AND c.accepted=true AND c.phase='production') AS prod_curves
       FROM batches b LEFT JOIN products p ON p.id=b.product_id ORDER BY b.created_at DESC LIMIT 50`);
  const rejected = await db.query(
    `SELECT c.id,c.original_filename,c.validation_notes,c.created_at,b.code
       FROM curves c JOIN batches b ON b.id=c.batch_id WHERE c.accepted=false ORDER BY c.created_at DESC LIMIT 20`);
  const pendingRegs = await db.query(
    `SELECT r.*, e.title FROM registrations r JOIN events e ON e.id=r.event_id
      WHERE r.status IN ('pending','pending_confirmation') ORDER BY r.created_at DESC LIMIT 30`);
  const recentDownloads = await db.query(
    `SELECT d.*, b.code FROM download_log d LEFT JOIN batches b ON b.id=d.batch_id
      ORDER BY d.created_at DESC LIMIT 20`);
  res.json({ counts, batches: drafts.rows, rejected, pending_registrations: pendingRegs.rows, recent_downloads: recentDownloads.rows });
}));

// 通用创建/更新产地/处理法/术语/产品
async function upsert(db, table, fields, body, id) {
  const cols = fields.filter((f) => body[f] !== undefined);
  if (id) {
    if (!cols.length) return (await db.query(`SELECT * FROM ${table} WHERE id=$1`, [id])).rows[0];
    const set = cols.map((c, i) => `${c}=$${i + 2}`).join(',');
    const r = await db.query(`UPDATE ${table} SET ${set} WHERE id=$1 RETURNING *`, [id, ...cols.map((c) => body[c])]);
    return r.rows[0];
  }
  const ph = cols.map((_, i) => `$${i + 1}`).join(',');
  const r = await db.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph}) RETURNING *`, cols.map((c) => body[c]));
  return r.rows[0];
}

app.post('/api/admin/origins', requireAdmin, wrap(async (req, res) => {
  res.status(201).json(await upsert(await getDb(), 'origins', ['slug', 'name', 'country', 'region', 'altitude_m', 'story'], req.body));
}));
app.put('/api/admin/origins/:id', requireAdmin, wrap(async (req, res) => {
  res.json(await upsert(await getDb(), 'origins', ['slug', 'name', 'country', 'region', 'altitude_m', 'story'], req.body, req.params.id));
}));
app.post('/api/admin/processes', requireAdmin, wrap(async (req, res) => {
  res.status(201).json(await upsert(await getDb(), 'processes', ['slug', 'name', 'category', 'description'], req.body));
}));
app.put('/api/admin/processes/:id', requireAdmin, wrap(async (req, res) => {
  res.json(await upsert(await getDb(), 'processes', ['slug', 'name', 'category', 'description'], req.body, req.params.id));
}));
app.post('/api/admin/terms', requireAdmin, wrap(async (req, res) => {
  const db = await getDb();
  const row = await upsert(db, 'glossary_terms', ['slug', 'term', 'kind', 'definition'], req.body);
  res.status(201).json(row);
}));
app.post('/api/admin/products', requireAdmin, wrap(async (req, res) => {
  res.status(201).json(await upsert(await getDb(), 'products', ['slug', 'brand', 'name', 'description', 'active'], req.body));
}));
app.put('/api/admin/products/:id', requireAdmin, wrap(async (req, res) => {
  res.json(await upsert(await getDb(), 'products', ['slug', 'brand', 'name', 'description', 'active'], req.body, req.params.id));
}));

// 批次 CRUD + 发布
app.post('/api/admin/batches', requireAdmin, wrap(async (req, res) => {
  const db = await getDb();
  const b = req.body;
  const r = await db.query(
    `INSERT INTO batches (slug,code,product_id,origin_id,process_id,harvest_year,roast_date,roast_level,machine,status,story,demo_servings_total)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [b.slug, b.code, b.product_id || null, b.origin_id || null, b.process_id || null,
     b.harvest_year || null, b.roast_date || null, b.roast_level || null, b.machine || null,
     b.status || 'draft', b.story || null, b.demo_servings_total || 0]);
  res.status(201).json(r.rows[0]);
}));
app.put('/api/admin/batches/:id', requireAdmin, wrap(async (req, res) => {
  const db = await getDb();
  const cur = await db.query('SELECT * FROM batches WHERE id=$1', [req.params.id]);
  if (!cur.rows.length) return res.status(404).json({ error: '批次不存在' });
  const b = { ...cur.rows[0], ...req.body };
  const r = await db.query(
    `UPDATE batches SET slug=$1,code=$2,product_id=$3,origin_id=$4,process_id=$5,harvest_year=$6,
       roast_date=$7,roast_level=$8,machine=$9,story=$10,demo_servings_total=$11 WHERE id=$12 RETURNING *`,
    [b.slug, b.code, b.product_id, b.origin_id, b.process_id, b.harvest_year, b.roast_date,
     b.roast_level, b.machine, b.story, b.demo_servings_total, req.params.id]);
  res.json(r.rows[0]);
}));

// 谱系：parent/child/relation
app.post('/api/admin/batches/:id/lineage', requireAdmin, wrap(async (req, res) => {
  const db = await getDb();
  const { parent_id, relation, note } = req.body;
  if (!['split', 'blend', 'replace', 'parent'].includes(relation)) return res.status(400).json({ error: 'relation 非法' });
  if (Number(parent_id) === Number(req.params.id)) return res.status(400).json({ error: '不能与自身建立谱系' });
  const r = await db.query(
    `INSERT INTO batch_lineage (child_id,parent_id,relation,note) VALUES ($1,$2,$3,$4)
     ON CONFLICT DO NOTHING RETURNING *`,
    [req.params.id, parent_id, relation, note || null]);
  res.status(201).json(r.rows[0] || { ok: true, note: '谱系边已存在' });
}));

// 发布：必须有至少 1 条已接受的 production 烘焙曲线
app.post('/api/admin/batches/:id/publish', requireAdmin, wrap(async (req, res) => {
  const db = await getDb();
  const id = req.params.id;
  const b = await db.query('SELECT * FROM batches WHERE id=$1', [id]);
  if (!b.rows.length) return res.status(404).json({ error: '批次不存在' });
  const n = await db.query(
    `SELECT count(*)::int AS n FROM curves WHERE batch_id=$1 AND accepted=true AND phase='production' AND curve_type='roast'`, [id]);
  if (n.rows[0].n < 1) {
    return res.status(409).json({ error: '发布被阻止：批次缺少已通过校验的生产烘焙曲线（验收曲线不能代替烘焙曲线）' });
  }
  const r = await db.query(`UPDATE batches SET status='published' WHERE id=$1 RETURNING *`, [id]);
  res.json(r.rows[0]);
}));
// 下架：保留页面与历史链接
app.post('/api/admin/batches/:id/delist', requireAdmin, wrap(async (req, res) => {
  const db = await getDb();
  const r = await db.query(`UPDATE batches SET status='delisted' WHERE id=$1 RETURNING *`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: '批次不存在' });
  for (const row of (await db.query('SELECT event_id FROM event_demo_batches WHERE batch_id=$1', [req.params.id])).rows) {
    const { reconcileRegistrations } = require('./lib/events');
    await reconcileRegistrations(db, row.event_id);
  }
  res.json(r.rows[0]);
}));

// 曲线上传（晚到的验收曲线始终允许挂到既有批次；量纲错误拒收并留档）
app.post('/api/admin/batches/:id/curves', requireAdmin, upload.single('file'), wrap(async (req, res) => {
  const db = await getDb();
  const b = await db.query('SELECT * FROM batches WHERE id=$1', [req.params.id]);
  if (!b.rows.length) return res.status(404).json({ error: '批次不存在' });
  if (!req.file) return res.status(400).json({ error: '缺少上传文件 file' });
  const phase = req.body.phase === 'acceptance' ? 'acceptance' : 'production';
  const curveType = req.body.curve_type === 'acceptance' ? 'acceptance' : 'roast';
  const v = validateCurve(req.file.originalname, req.file.buffer, {
    probe_model: req.body.probe_model,
    probe_position: req.body.probe_position,
    temp_unit: req.body.temp_unit,
    sample_interval_s: req.body.sample_interval_s,
    time_zero: req.body.time_zero,
  });

  const stored = storeCurveFile(b.rows[0].id, req.file.originalname, req.file.buffer, v.ok);
  const meta = v.meta || {
    probe_model: req.body.probe_model || '', probe_position: req.body.probe_position || '',
    temp_unit: (req.body.temp_unit || ''), time_zero: req.body.time_zero || '',
    sample_interval_s: req.body.sample_interval_s || null,
  };
  const ins = await db.query(
    `INSERT INTO curves (batch_id,curve_type,phase,source,original_filename,storage_path,content_sha256,mime,byte_size,
       probe_model,probe_position,temp_unit,sample_interval_s,time_zero,recorded_at,
       point_count,duration_s,max_gap_s,validation_status,validation_notes,accepted)
     VALUES ($1,$2,$3,'upload',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [b.rows[0].id, curveType, phase, req.file.originalname, stored.storage_path, stored.content_sha256,
     req.file.mimetype, stored.byte_size,
     meta.probe_model, meta.probe_position, meta.temp_unit, meta.sample_interval_s, meta.time_zero,
     req.body.recorded_at || null,
     v.summary ? v.summary.point_count : 0,
     v.summary ? v.summary.duration_s : null,
     v.summary ? v.summary.max_gap_s : 0,
     v.ok ? 'accepted' : 'rejected',
     JSON.stringify({ errors: v.errors, warnings: v.warnings }),
     v.ok]);
  if (v.ok && v.summary) {
    for (const ch of v.summary.channels) {
      await db.query(
        `INSERT INTO curve_channels (curve_id,channel,unit,point_count,max_gap_s) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (curve_id,channel) DO UPDATE SET unit=EXCLUDED.unit,point_count=EXCLUDED.point_count,max_gap_s=EXCLUDED.max_gap_s`,
        [ins.rows[0].id, ch.channel, ch.unit, ch.point_count, ch.max_gap_s]);
    }
  }
  res.status(v.ok ? 201 : 422).json({
    accepted: v.ok,
    curve: ins.rows[0],
    errors: v.errors,
    warnings: v.warnings,
    summary: v.summary,
    note: v.ok ? undefined : '文件已留存到 storage/curves/rejected 供排查，未写入测点，批次现有曲线不受影响。',
  });
}));

// 感官评语（必须选择量表）
app.post('/api/admin/batches/:id/reviews', requireAdmin, wrap(async (req, res) => {
  const db = await getDb();
  const { scale_code, score, cup_notes, cupper, curve_id } = req.body;
  const sc = await db.query('SELECT * FROM rating_scales WHERE code=$1', [scale_code]);
  if (!sc.rows.length) return res.status(400).json({ error: '未知评分量表' });
  const num = Number(score);
  if (!(num >= Number(sc.rows[0].min_value) && num <= Number(sc.rows[0].max_value))) {
    return res.status(400).json({ error: `分数需在量表范围 ${sc.rows[0].min_value}~${sc.rows[0].max_value} 内` });
  }
  const r = await db.query(
    `INSERT INTO sensory_reviews (batch_id,scale_id,score,cup_notes,cupper,curve_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.params.id, sc.rows[0].id, num, cup_notes || null, cupper || null, curve_id || null]);
  res.status(201).json(r.rows[0]);
}));

// 活动 CRUD + 演示批次绑定 + 库存撤回
app.post('/api/admin/events', requireAdmin, wrap(async (req, res) => {
  const db = await getDb();
  const e = req.body;
  const r = await db.query(
    `INSERT INTO events (slug,title,description,starts_at,capacity,status) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [e.slug, e.title, e.description || null, e.starts_at, e.capacity, e.status || 'open']);
  res.status(201).json(r.rows[0]);
}));
app.post('/api/admin/events/:id/demo-batches', requireAdmin, wrap(async (req, res) => {
  const db = await getDb();
  const { batch_id, servings } = req.body;
  const r = await db.query(
    `INSERT INTO event_demo_batches (event_id,batch_id,servings) VALUES ($1,$2,$3)
     ON CONFLICT (event_id,batch_id) DO UPDATE SET servings=EXCLUDED.servings RETURNING *`,
    [req.params.id, batch_id, servings]);
  const { reconcileRegistrations } = require('./lib/events');
  await reconcileRegistrations(db, Number(req.params.id));
  res.status(201).json(r.rows[0]);
}));
// 撤回某演示批次在某活动中的库存
app.post('/api/admin/events/:id/withdraw', requireAdmin, wrap(async (req, res) => {
  const db = await getDb();
  const { batch_id, delta, reason } = req.body;
  if (!Number.isFinite(Number(batch_id)) || !Number.isFinite(Number(delta))) {
    return res.status(400).json({ error: 'batch_id 与 delta 必须是数字' });
  }
  const next = await adjustInventory(db, Number(batch_id), Number(delta), reason || 'withdrawal', Number(req.params.id));
  res.json({ ok: true, demo_servings_total: next, capacity: await eventCapacity(db, Number(req.params.id)) });
}));
app.get('/api/admin/events/:id/registrations', requireAdmin, wrap(async (req, res) => {
  const db = await getDb();
  const rows = await db.query(
    `SELECT r.*, e.title FROM registrations r JOIN events e ON e.id=r.event_id
      WHERE r.event_id=$1 ORDER BY r.created_at`, [req.params.id]);
  res.json({ registrations: rows.rows, capacity: await eventCapacity(db, Number(req.params.id)) });
}));
app.post('/api/admin/registrations/:id/decision', requireAdmin, wrap(async (req, res) => {
  const db = await getDb();
  const { action, note } = req.body; // confirm / request_confirmation / cancel
  const map = { confirm: 'confirmed', request_confirmation: 'pending_confirmation', cancel: 'cancelled' };
  if (!map[action]) return res.status(400).json({ error: 'action 非法' });
  const r = await db.query(
    `UPDATE registrations SET status=$1, note=COALESCE(note,'')||$2, updated_at=now() WHERE id=$3 RETURNING *`,
    [map[action], note ? `\n[管理员] ${note}` : '', req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: '报名不存在' });
  res.json(r.rows[0]);
}));

app.get('/api/admin/downloads', requireAdmin, wrap(async (req, res) => {
  const db = await getDb();
  const rows = await db.query(
    `SELECT d.*, b.code FROM download_log d LEFT JOIN batches b ON b.id=d.batch_id ORDER BY d.created_at DESC LIMIT 100`);
  res.json({ downloads: rows.rows });
}));

// 前端 history fallback
app.get(/^\/(?!api\/).*/, (req, res, next) => {
  if (req.method !== 'GET') return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({ error: err.message || '服务器错误' });
});

if (require.main === module) {
  getDb().then(() => {
    app.listen(PORT, () => console.log(`☕ Roast Story Station on http://localhost:${PORT}`));
  });
}
module.exports = app;
