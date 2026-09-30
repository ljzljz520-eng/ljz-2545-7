import pg from 'pg';
import { PG } from './config.js';

export const pool = new pg.Pool(PG);

export async function q(text, params = []) {
  return pool.query(text, params);
}
export async function one(text, params = []) {
  const r = await q(text, params);
  return r.rows[0] || null;
}
export async function many(text, params = []) {
  return (await q(text, params)).rows;
}
export const tx = async (fn) => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
};
