'use strict';
// ============================================================
// 活动名额 × 可供演示批次 联动
//
// effective_capacity = min(活动场地名额, Σ 关联演示批次的可供份数)
// 报名（confirmed）占用席位；库存撤回导致容量下降时：
//   - 超出新容量的 confirmed 不做静默删除（保留席位，标记需复核）
//   - 未处理的 pending 一律进入 pending_confirmation（“需确认”），绝不静默取消
// 报名重送：以 idempotency_key 幂等返回同一记录
// ============================================================
const { getDb } = require('../db');

async function eventCapacity(db, eventId) {
  const ev = await db.query('SELECT * FROM events WHERE id=$1', [eventId]);
  if (!ev.rows.length) return null;
  const e = ev.rows[0];
  const demo = await db.query(
    `SELECT edb.batch_id, edb.servings AS reserved, b.demo_servings_total, b.code, b.status
       FROM event_demo_batches edb JOIN batches b ON b.id = edb.batch_id
      WHERE edb.event_id = $1 ORDER BY b.code`, [eventId]);
  // 可供演示份数：受批次上架状态与当前库存约束（此处 demo_servings_total 即当前可供值，撤回时直接调整）
  const available = demo.rows
    .filter((row) => row.status !== 'delisted')
    .reduce((acc, row) => acc + Math.max(0, Math.min(Number(row.reserved), Number(row.demo_servings_total))), 0);
  const effective = Math.min(Number(e.capacity), available);
  const counts = await db.query(
    `SELECT status, COALESCE(SUM(party_size),0)::int AS seats
       FROM registrations WHERE event_id=$1 GROUP BY status`, [eventId]);
  const byStatus = Object.fromEntries(counts.rows.map((r) => [r.status, r.seats]));
  return {
    event: { id: e.id, slug: e.slug, title: e.title, capacity: Number(e.capacity), status: e.status, starts_at: e.starts_at },
    demo_batches: demo.rows.map((r) => ({
      batch_id: r.batch_id, code: r.code, status: r.status,
      servings_reserved: Number(r.reserved), servings_available: Number(r.demo_servings_total),
      usable: Math.max(0, Math.min(Number(r.reserved), Number(r.demo_servings_total))),
    })),
    demo_servings: available,
    effective_capacity: effective,
    seats_confirmed: byStatus.confirmed || 0,
    seats_pending: (byStatus.pending || 0) + (byStatus.pending_confirmation || 0),
    remaining: Math.max(0, effective - (byStatus.confirmed || 0)),
  };
}

// 库存调整（撤回 delta<0 / 补货 delta>0），随后重算受影响报名
async function adjustInventory(db, batchId, delta, reason, eventId = null) {
  const b = await db.query('SELECT * FROM batches WHERE id=$1', [batchId]);
  if (!b.rows.length) throw Object.assign(new Error('批次不存在'), { status: 404 });
  const next = Number(b.rows[0].demo_servings_total) + Number(delta);
  if (next < 0) throw Object.assign(new Error(`撤回数量超过当前库存（当前 ${b.rows.demo_servings_total}）`), { status: 409 });
  await db.query('UPDATE batches SET demo_servings_total=$1 WHERE id=$2', [next, batchId]);
  await db.query(
    'INSERT INTO inventory_transactions (batch_id, event_id, delta, reason) VALUES ($1,$2,$3,$4)',
    [batchId, eventId, delta, reason]);

  // 找所有用了该演示批次的活动，重算报名状态
  const evs = eventId
    ? await db.query('SELECT event_id FROM event_demo_batches WHERE event_id=$1 AND batch_id=$2', [eventId, batchId])
    : await db.query('SELECT event_id FROM event_demo_batches WHERE batch_id=$1', [batchId]);
  for (const row of evs.rows) await reconcileRegistrations(db, row.event_id);
  return next;
}

async function reconcileRegistrations(db, eventId) {
  const cap = await eventCapacity(db, eventId);
  if (!cap) return;
  const eff = cap.effective_capacity;
  // 库存撤回后：所有尚未确认的报名（pending）一律需要运营重新确认，绝不静默取消。
  // 按报名时间顺序，能放进新容量的标注“可优先确认”，放不下的标注“超容量”，但状态统一为 pending_confirmation。
  const pendings = await db.query(
    `SELECT * FROM registrations WHERE event_id=$1 AND status='pending' ORDER BY created_at, id`, [eventId]);
  let used = cap.seats_confirmed;
  for (const r of pendings.rows) {
    const fits = used + Number(r.party_size) <= eff;
    used += Number(r.party_size);
    await db.query(
      `UPDATE registrations SET status='pending_confirmation',
         note = COALESCE(note,'') || $1, updated_at=now() WHERE id=$2`,
      [fits
        ? '\n[系统] 演示库存/名额已调整：报名进入“需确认”队列（当前容量内，可优先确认；系统未自动确认也未取消）。'
        : '\n[系统] 演示库存撤回后当前容量不足：报名进入“需确认”队列，请运营联系顾客（未取消）。',
       r.id]);
  }
  // 已 confirmed 但超过新容量：不取消，仅在活动记录上保留；报名记录 note 标记
  if (cap.seats_confirmed > eff) {
    await db.query(
      `UPDATE registrations SET note = COALESCE(note,'') || $1, updated_at=now()
        WHERE event_id=$2 AND status='confirmed'
          AND id IN (
            SELECT id FROM (
              SELECT id, SUM(party_size) OVER (ORDER BY created_at, id) AS cum
                FROM registrations WHERE event_id=$2 AND status='confirmed'
            ) q WHERE cum > $3)`,
      ['\n[系统] 库存撤回后席位超出当前可保障名额，请运营联系确认（未取消）。', eventId, eff]);
  }
}

// 创建报名（幂等）
async function createRegistration(db, { event_id, name, email, party_size = 1, idempotency_key, note }) {
  if (!event_id || !name || !email) throw Object.assign(new Error('event_id/name/email 必填'), { status: 400 });
  party_size = Number(party_size) || 1;
  if (idempotency_key) {
    const exist = await db.query('SELECT * FROM registrations WHERE idempotency_key=$1', [idempotency_key]);
    if (exist.rows.length) {
      return { registration: exist.rows[0], idempotent_replay: true };
    }
  }
  return db.tx(async ({ query }) => {
    const cap = await eventCapacity(query, event_id);
    if (!cap) throw Object.assign(new Error('活动不存在'), { status: 404 });
    if (cap.event.status !== 'open') throw Object.assign(new Error('活动已关闭报名'), { status: 409 });
    const fits = cap.remaining >= party_size;
    const status = fits ? 'pending' : 'pending_confirmation';
    const ins = await query(
      `INSERT INTO registrations (event_id,name,email,party_size,status,idempotency_key,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [event_id, name, email, party_size, status,
       idempotency_key || null,
       fits ? note : ((note || '') + '\n[系统] 当前有效名额不足，报名进入需确认队列。')]);
    return { registration: ins.rows[0], idempotent_replay: false };
  });
}

module.exports = { eventCapacity, adjustInventory, reconcileRegistrations, createRegistration };
