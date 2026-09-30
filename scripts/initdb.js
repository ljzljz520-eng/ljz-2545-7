'use strict';
const fs = require('fs');
const path = require('path');
const { getDb } = require('../src/db');

(async () => {
  const db = await getDb();
  const sql = fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8');
  await db.exec(sql);
  console.log('[initdb] schema applied (mode=' + db.mode + ')');
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
