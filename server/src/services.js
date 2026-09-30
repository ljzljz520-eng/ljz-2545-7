import { q, one, tx, many } from './db.js';

// 活动可演示批次 = 关联且 published
export async function eventAvailability(eventId) {
  const ev = await one(`SELECT e.*,
      (SELECT count(*) FROM event_demo_batches edb
         JOIN batches b ON b.id = edb.batch_id
       WHERE edb.event_id = e.id AND b.status = 'published') AS demo_batch_count
    FROM events e WHERE e.id = $1`, [eventId]);
  if (!ev) return null;
  const counts = await one(
    `SELECT count(*) FILTER (WHERE status='registered') AS confirmed,
            count(*) FILTER (WHERE status='pending_confirmation') AS pending,
            count(*) FILTER (WHERE status<>'cancelled') AS held
     FROM registrations WHERE event_id=$1`, [eventId]);
  return {
    ...ev,
    demo_batch_count: Number(ev.demo_batch_count),
    confirmed: Number(counts.confirmed),
    pending: Number(counts.pending),
    held: Number(counts.held),
    spots_left: Math.max(0, ev.capacity - Number(counts.held)),
    open: ev.published && Number(ev.demo_batch_count) > 0 && ev.capacity - Number(counts.held) > 0,
  };
}

// 报名（幂等：同 event+idempotency_key 重送不新建）
export async function submitRegistration({ eventId, name, email, note = '', idempotencyKey }) {
  return tx(async (c) => {
    const av = await eventAvailability(eventId);
    if (!av) throw httpErr(404, '活动不存在');
    const existing = (await c.query(
      `SELECT * FROM registrations WHERE event_id=$1 AND idempotency_key=$2`,
      [eventId, idempotencyKey])).rows[0];
    if (existing) {
      await c.query(
        `UPDATE registrations SET name=$1, email=$2, note=$3, updated_at=now()
         WHERE id=$4 RETURNING *`, [name, email, note, existing.id]);
      await c.query(
        `INSERT INTO registration_events_log(registration_id,event_id,kind,detail)
         VALUES ($1,$2,'resend','客户端重送报名（幂等键相同），更新联系信息，不新建名额占用')`,
        [existing.id, eventId]);
      return { registration: (await c.query('SELECT * FROM registrations WHERE id=$1', [existing.id])).rows[0], deduped: true, availability: av };
    }
    if (!av.open) throw httpErr(409, av.demo_batch_count === 0 ? '该活动暂无可供演示批次，报名未开放' : '名额已满');
    const r = (await c.query(
      `INSERT INTO registrations(event_id,name,email,note,idempotency_key,status)
       VALUES ($1,$2,$3,$4,$5,'registered') RETURNING *`,
      [eventId, name, email, note, idempotencyKey])).rows[0];
    await c.query(
      `INSERT INTO registration_events_log(registration_id,event_id,kind,detail)
       VALUES ($1,$2,'submit','新报名')`, [r.id, eventId]);
    return { registration: r, deduped: false, availability: await eventAvailability(eventId) };
  });
}

export function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }

// 批次撤回/下架：联动把关联活动的待办报名置为 pending_confirmation（绝不静默取消）
export async function withdrawBatch(batchId, reason = '') {
  return tx(async (c) => {
    const b = (await c.query(`SELECT * FROM batches WHERE id=$1`, [batchId])).rows[0];
    if (!b) throw httpErr(404, '批次不存在');
    await c.query(`UPDATE batches SET status='withdrawn', withdrawn_at=now() WHERE id=$1`, [batchId]);
    const linked = (await c.query(
      `SELECT DISTINCT edb.event_id FROM event_demo_batches edb WHERE edb.batch_id=$1`, [batchId])).rows;
    let moved = 0;
    for (const { event_id } of linked) {
      const res = await c.query(
        `UPDATE registrations SET status='pending_confirmation', updated_at=now()
         WHERE event_id=$1 AND status='registered' RETURNING id`, [event_id]);
      moved += res.rowCount;
      for (const row of res.rows) {
        await c.query(
          `INSERT INTO registration_events_log(registration_id,event_id,kind,detail)
           VALUES ($1,$2,'batch_withdrawn',$3)`,
          [row.id, event_id, `演示批次 ${b.code}（${reason}）撤回库存：报名转待确认，不静默取消`]);
      }
    }
    return { batch: b.code, linked_events: linked.length, registrations_moved: moved };
  });
}

export async function republishBatch(batchId) {
  await q(`UPDATE batches SET status='published', withdrawn_at=NULL WHERE id=$1`, [batchId]);
  // 重发后仍需人工确认积压报名（不自动恢复），保留可审计
  return { ok: true };
}

// 批次谱系（递归 CTE）：祖先链 + 后代
export async function lineage(batchId) {
  const ancestors = await many(`
    WITH RECURSIVE anc AS (
      SELECT b.*, 0 AS depth FROM batches b WHERE id=$1
      UNION ALL
      SELECT p.*, a.depth-1 FROM batches p JOIN anc a ON a.parent_id=p.id
    ) SELECT * FROM anc ORDER BY depth`, [batchId]);
  const descendants = await many(`
    WITH RECURSIVE des AS (
      SELECT b.*, 0 AS depth FROM batches b WHERE id=$1
      UNION ALL
      SELECT ch.*, d.depth+1 FROM batches ch JOIN des d ON ch.parent_id=d.id
    ) SELECT * FROM des WHERE depth>0 ORDER BY depth, roast_date`, [batchId]);
  return { root: ancestors.find((a) => a.depth === 0), ancestors: ancestors.filter((a) => a.depth < 0), descendants };
}

// 发布：必须有接受曲线；draft -> published
export async function publishBatch(batchId) {
  const b = await one(`SELECT * FROM batches WHERE id=$1`, [batchId]);
  if (!b) throw httpErr(404, '批次不存在');
  const accepted = await one(`SELECT count(*)::int AS n FROM roast_curves WHERE batch_id=$1 AND review_status='accepted'`, [batchId]);
  if (accepted.n === 0) throw httpErr(409, '没有已验收(accepted)的曲线，不能发布');
  await q(`UPDATE batches SET status='published' WHERE id=$1`, [batchId]);
  return { ok: true };
}
