-- ============================================================
-- 咖啡烘焙故事站 · PostgreSQL 结构
-- 设计要点：
--   * 曲线文件独立于数据库存储（storage/curves），库里只存测量元数据
--   * 产品(豆款)与批次严格分离；曲线永远绑定批次，不随产品改名/换批迁移
--   * 感官评语记录评分量表，跨量表不做直接排名
-- ============================================================

CREATE TABLE IF NOT EXISTS origins (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  country     TEXT NOT NULL,
  region      TEXT,
  altitude_m  TEXT,
  story       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS processes (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  category    TEXT,                    -- washed / natural / honey / anaerobic ...
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS glossary_terms (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  term        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'general', -- origin / process / roasting / sensory
  definition  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS origin_glossary (
  origin_id INTEGER REFERENCES origins(id) ON DELETE CASCADE,
  term_id   INTEGER REFERENCES glossary_terms(id) ON DELETE CASCADE,
  PRIMARY KEY (origin_id, term_id)
);
CREATE TABLE IF NOT EXISTS process_glossary (
  process_id INTEGER REFERENCES processes(id) ON DELETE CASCADE,
  term_id    INTEGER REFERENCES glossary_terms(id) ON DELETE CASCADE,
  PRIMARY KEY (process_id, term_id)
);

-- 豆款（稳定 SKU/品牌名）。同名不等于实验条件相同——比较时必须下钻到批次。
CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  brand       TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 批次谱系（有向边）：split(分裂) / blend(拼配) / replace(换批) / parent(一般承继)
CREATE TABLE IF NOT EXISTS batches (
  id              SERIAL PRIMARY KEY,
  slug            TEXT UNIQUE NOT NULL,
  code            TEXT UNIQUE NOT NULL,
  product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL,
  origin_id       INTEGER REFERENCES origins(id),
  process_id      INTEGER REFERENCES processes(id),
  harvest_year    INTEGER,
  roast_date      DATE,
  roast_level     TEXT,
  machine         TEXT,
  status          TEXT NOT NULL DEFAULT 'draft', -- draft / published / delisted
  story           TEXT,
  demo_servings_total INTEGER NOT NULL DEFAULT 0, -- 可供演示的份数（活动名额联动）
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS batch_lineage (
  id           SERIAL PRIMARY KEY,
  child_id     INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  parent_id    INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  relation     TEXT NOT NULL,            -- split / blend / replace / parent
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (child_id <> parent_id)
);

-- 曲线：数据库中只保存“测量元数据 + 文件定位”，测点数据存文件
CREATE TABLE IF NOT EXISTS curves (
  id               SERIAL PRIMARY KEY,
  batch_id         INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  curve_type       TEXT NOT NULL,        -- roast（烘焙） / acceptance（验收）
  phase            TEXT NOT NULL DEFAULT 'production', -- production / acceptance
  source           TEXT NOT NULL DEFAULT 'upload',     -- upload / manual
  original_filename TEXT,
  storage_path     TEXT NOT NULL,       -- 相对 storage 根目录
  content_sha256   TEXT NOT NULL,
  mime             TEXT NOT NULL,
  byte_size        INTEGER NOT NULL,
  -- 测量元数据（跨设备比较时必须显式核对）
  probe_model      TEXT NOT NULL,
  probe_position   TEXT NOT NULL,        -- bean / environment / inlet / exhaust
  temp_unit        TEXT NOT NULL,        -- C / F
  sample_interval_s NUMERIC(10,3),       -- 声明采样间隔（秒）；与文件时间戳不一致将拒收
  time_zero        TEXT NOT NULL,        -- charge / first_crack_start / roast_start ...
  recorded_at      TIMESTAMPTZ,
  point_count      INTEGER NOT NULL DEFAULT 0,
  duration_s       NUMERIC(10,3),
  min_temp_c       NUMERIC(8,3),
  max_temp_c       NUMERIC(8,3),
  max_gap_s        NUMERIC(10,3) NOT NULL DEFAULT 0, -- 文件内最长连续缺测（秒）
  validation_status TEXT NOT NULL DEFAULT 'accepted', -- accepted / rejected
  validation_notes  TEXT,
  accepted         BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_curves_batch ON curves(batch_id);

-- 曲线包含哪些通道（bean temp / inlet / exhaust ...）
CREATE TABLE IF NOT EXISTS curve_channels (
  id         SERIAL PRIMARY KEY,
  curve_id   INTEGER NOT NULL REFERENCES curves(id) ON DELETE CASCADE,
  channel    TEXT NOT NULL,
  unit       TEXT NOT NULL,
  point_count INTEGER NOT NULL,
  max_gap_s  NUMERIC(10,3) NOT NULL DEFAULT 0,
  UNIQUE (curve_id, channel)
);

-- 感官评分量表：不同量表的分数不可直接混排
CREATE TABLE IF NOT EXISTS rating_scales (
  id          SERIAL PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,      -- sca2017 / wb10 / internal5 ...
  name        TEXT NOT NULL,
  min_value   NUMERIC(6,2) NOT NULL,
  max_value   NUMERIC(6,2) NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS sensory_reviews (
  id          SERIAL PRIMARY KEY,
  batch_id    INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  curve_id    INTEGER REFERENCES curves(id) ON DELETE SET NULL, -- 评语针对的烘焙曲线
  scale_id    INTEGER NOT NULL REFERENCES rating_scales(id),
  score       NUMERIC(6,2) NOT NULL,
  cup_notes   TEXT,                      -- 感官评语（自由文本）
  cupper      TEXT,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sensory_batch ON sensory_reviews(batch_id);

-- 活动
CREATE TABLE IF NOT EXISTS events (
  id               SERIAL PRIMARY KEY,
  slug             TEXT UNIQUE NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  starts_at        TIMESTAMPTZ NOT NULL,
  capacity         INTEGER NOT NULL,     -- 场地/运营名额
  status           TEXT NOT NULL DEFAULT 'open', -- open / closed
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS event_demo_batches (
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  batch_id INTEGER REFERENCES batches(id) ON DELETE CASCADE,
  servings INTEGER NOT NULL DEFAULT 0,   -- 该批次为该活动预留的演示份数
  PRIMARY KEY (event_id, batch_id)
);

-- 报名：容量撤回后 pending 进入“需确认”，绝不静默取消
CREATE TABLE IF NOT EXISTS registrations (
  id              SERIAL PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  email           TEXT NOT NULL,
  party_size      INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'pending', -- confirmed / pending_confirmation / cancelled
  idempotency_key TEXT UNIQUE,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reg_event ON registrations(event_id);

-- 批次演示份数变动流水（撤回/补充都可审计）
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id          SERIAL PRIMARY KEY,
  batch_id    INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  event_id    INTEGER REFERENCES events(id) ON DELETE SET NULL,
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,             -- withdrawal / restock / reservation
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 下载审计：每次下载都能追到原始数据
CREATE TABLE IF NOT EXISTS download_log (
  id            SERIAL PRIMARY KEY,
  batch_id      INTEGER REFERENCES batches(id) ON DELETE SET NULL,
  curve_id      INTEGER REFERENCES curves(id) ON DELETE SET NULL,
  format        TEXT NOT NULL,           -- original / bundle
  requester     TEXT,                    -- public / admin:<...>
  content_sha256 TEXT,
  byte_size     INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
