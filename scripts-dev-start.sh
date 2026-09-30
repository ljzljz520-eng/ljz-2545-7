#!/usr/bin/env bash
# 开发环境启动：确保便携 PostgreSQL 运行 + 迁移/种子 + API
set -e
PGHOME=/tmp/pglocal/usr/lib/postgresql/15
export LD_LIBRARY_PATH=/tmp/pglocal/usr/lib/aarch64-linux-gnu:$PGHOME/lib
if [ ! -d /tmp/pgdata ]; then
  $PGHOME/bin/initdb -D /tmp/pgdata -U pguser --auth=trust --encoding=UTF8
fi
$PGHOME/bin/pg_ctl -D /tmp/pgdata -l /tmp/pglog -o "-k /tmp -p 5439 -h 127.0.0.1" start || true
sleep 1
node server/src/migrate.js
node server/src/seed.js
node server/src/index.js
