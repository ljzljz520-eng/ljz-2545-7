'use strict';
// 统一查询层：
// - 有 DATABASE_URL 时连接外部 PostgreSQL（pg）
// - 否则使用嵌入式 PGlite（真实 PostgreSQL 引擎，数据持久化到 .pglite/）
const path = require('path');

let db = null;

async function getDb() {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  if (url) {
    const pg = require('pg');
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    db = {
      mode: 'pg',
      query: (text, params) => pool.query(text, params),
      exec: async (text) => { await pool.query(text); },
      tx: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const qfn = client.query.bind(client);
        qfn.query = qfn;
        const r = await fn(qfn);
          await client.query('COMMIT');
          return r;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = require('@electric-sql/pglite');
    const pg = new PGlite(path.join(__dirname, '..', '.pglite'));
    db = {
      mode: 'pglite',
      query: (text, params) => pg.query(text, params),
      exec: (text) => pg.exec(text),
      tx: async (fn) => {
        await pg.query('BEGIN');
        try {
          const qfn = pg.query.bind(pg);
        qfn.query = qfn;
        const r = await fn(qfn);
          await pg.query('COMMIT');
          return r;
        } catch (e) {
          await pg.query('ROLLBACK');
          throw e;
        }
      },
      close: () => pg.close(),
    };
  }
  return db;
}

module.exports = { getDb };
