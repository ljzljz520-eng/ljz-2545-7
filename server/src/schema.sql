-- 咖啡烘焙故事站 schema
CREATE TABLE IF NOT EXISTS origins (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  region TEXT,
  altitude_min_m INT,
  altitude_max_m INT,
  story TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS processes (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS origin_processes (
  origin_id INT REFERENCES origins(id) ON DELETE CASCADE,
  process_id INT REFERENCES processes(id) ON DELETE CASCADE,
  note TEXT DEFAULT '',
  PRIMARY KEY (origin_id, process_id)
);

CREATE TABLE IF NOT EXISTS glossary_terms (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  term TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('origin','process','roast','sensory','event')),
  definition TEXT NOT NULL,
  see_also TEXT[] NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS process_terms (
  process_id INT REFERENCES processes(id) ON DELETE CASCADE,
  term_id INT REFERENCES glossary_terms(id) ON DELETE CASCADE,
  PRIMARY KEY (process_id, term_id)
);
CREATE TABLE IF NOT EXISTS origin_terms (
  origin_id INT REFERENCES origins(id) ON DELETE CASCADE,
  term_id INT REFERENCES glossary_terms(id) ON DELETE CASCADE,
  PRIMARY KEY (origin_id, term_id)
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  brand TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  current_batch_id INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 批次谱系：parent_id 指向上一批（换批/迭代），换批原因留痕
CREATE TABLE IF NOT EXISTS batches (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  product_id INT REFERENCES products(id) ON DELETE SET NULL,
  origin_id INT REFERENCES origins(id),
  process_id INT REFERENCES processes(id),
  parent_id INT REFERENCES batches(id),
  lineage_note TEXT DEFAULT '',
  roast_date DATE NOT NULL,
  roaster TEXT DEFAULT '',
  machine TEXT DEFAULT '',
  weight_in_g NUMERIC(8,2),
  weight_out_g NUMERIC(8,2),
  -- 批次级库存/状态：draft 未发布, published 已发布(在售可演示), withdrawn 撤回/下架(历史保留)
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','withdrawn')),
  withdrawn_at TIMESTAMPTZ,
  story TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_current_batch') THEN
    ALTER TABLE products ADD CONSTRAINT fk_current_batch
      FOREIGN KEY (current_batch_id) REFERENCES batches(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_batches_product ON batches(product_id);

-- 测量元数据保存在 PG；曲线数据本体在独立文件存储（storage/curves），此处只保存指针
CREATE TABLE IF NOT EXISTS roast_curves (
  id SERIAL PRIMARY KEY,
  batch_id INT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,                 -- 存储内相对文件名（内容寻址 sha256）
  sha256 TEXT UNIQUE NOT NULL,
  size_bytes BIGINT NOT NULL,
  source_filename TEXT DEFAULT '',
  fmt TEXT NOT NULL DEFAULT 'csv',
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  review_status TEXT NOT NULL DEFAULT 'pending'
     CHECK (review_status IN ('pending','accepted','rejected','needs_fix')),
  reject_reason TEXT DEFAULT '',
  -- 测量元数据（PG）
  probe_type TEXT NOT NULL CHECK (probe_type IN ('ET','BT','ET_BT')),
  probe_position TEXT DEFAULT '',
  sampling_interval_s NUMERIC(6,2) NOT NULL,
  time_zero TEXT NOT NULL CHECK (time_zero IN ('roast_start','turning_point','first_crack','charge')),
  temp_unit TEXT NOT NULL DEFAULT 'C' CHECK (temp_unit IN ('C','F')),
  channel_meta JSONB NOT NULL DEFAULT '{}',
  point_count INT NOT NULL DEFAULT 0,
  duration_s INT NOT NULL DEFAULT 0,
  max_gap_samples INT NOT NULL DEFAULT 0,  -- 最长连续缺测样本数（不做长缺测填补）
  gap_windows JSONB NOT NULL DEFAULT '[]',-- [{from_s,to_s,missing_samples}]
  range_check JSONB NOT NULL DEFAULT '{}',-- {minC,maxC,suspicious:bool}
  is_late BOOLEAN NOT NULL DEFAULT false, -- 验收用例：曲线晚到
  late_for_batch_id INT REFERENCES batches(id)
);
CREATE INDEX IF NOT EXISTS idx_curves_batch ON roast_curves(batch_id);

-- 感官评语；量表随评语保存，不同量表不直接排名
CREATE TABLE IF NOT EXISTS sensory_scales (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,        -- SCA2017, OUR5, WCR10
  name TEXT NOT NULL,
  min_score NUMERIC(5,2) NOT NULL,
  max_score NUMERIC(5,2) NOT NULL,
  description TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sensory_evaluations (
  id SERIAL PRIMARY KEY,
  batch_id INT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  scale_id INT NOT NULL REFERENCES sensory_scales(id),
  score NUMERIC(5,2) NOT NULL,
  cupper TEXT DEFAULT '',
  evaluated_on DATE NOT NULL DEFAULT CURRENT_DATE,
  notes TEXT DEFAULT '',
  flavor_tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sensory_batch ON sensory_evaluations(batch_id);

-- 活动与可供演示批次联动
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  held_on TIMESTAMPTZ NOT NULL,
  location TEXT DEFAULT '',
  capacity INT NOT NULL CHECK (capacity >= 0),
  description TEXT DEFAULT '',
  published BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS event_demo_batches (
  event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  batch_id INT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, batch_id)
);
-- 报名状态：registered 已确认 / pending_confirmation 库存撤回后待确认(绝不静默取消) / cancelled
CREATE TABLE IF NOT EXISTS registrations (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'registered'
     CHECK (status IN ('registered','pending_confirmation','cancelled')),
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS registration_events_log (
  id SERIAL PRIMARY KEY,
  registration_id INT REFERENCES registrations(id) ON DELETE SET NULL,
  event_id INT,
  kind TEXT NOT NULL,
  detail TEXT DEFAULT '',
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
