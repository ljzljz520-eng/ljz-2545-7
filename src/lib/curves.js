'use strict';
// ============================================================
// 烘焙曲线文件：解析 / 量纲校验 / 缺测处理 / 独立文件存储
//
// 规则（对应需求）：
//  - 曲线测点数据存文件（storage/curves），数据库只存测量元数据
//  - 量纲错误（通道单位与声明不符、数值明显不在声明量纲范围）→ 拒收
//  - 声明采样间隔与文件时间戳不符 → 拒收并说明
//  - 缺测：短缺口（<=2 个采样点）仅用于展示时线性插值；
//          长缺口永不插值，比较时分段处理
//  - 原始文件原样落盘，下载即原数据（sha256 命名，可审计）
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEMP_UNITS = ['C', 'F'];
const TIME_ZEROS = ['charge', 'turning_point', 'first_crack_start', 'roast_start', 'other'];
const RANGE_C = { min: -20, max: 320 };
const SHORT_GAP_SAMPLES = 2;
const INTERVAL_TOL = 0.2;

function toC(v, unit) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return unit === 'F' ? ((v - 32) * 5) / 9 : v;
}

function seriesWithShortGapFill(values) {
  const out = values.slice();
  const filledIdx = new Set();
  let i = 0;
  while (i < out.length) {
    if (out[i] === null) {
      let j = i;
      while (j < out.length && out[j] === null) j++;
      const gap = j - i;
      if (gap <= SHORT_GAP_SAMPLES && i > 0 && j < out.length) {
        const a = out[i - 1], b = out[j];
        for (let k = i; k < j; k++) {
          out[k] = a + ((b - a) * (k - i + 1)) / (gap + 1);
          filledIdx.add(k);
        }
      }
      i = j;
    } else i++;
  }
  return { values: out, filled: filledIdx };
}

function maxGapSeconds(times, values, interval) {
  let max = 0, run = 0;
  for (let i = 0; i < values.length; i++) {
    if (values[i] === null) {
      run += interval || (times[i + 1] - times[i]) || 0;
      max = Math.max(max, run);
    } else run = 0;
  }
  return max;
}

function parseChannelHeader(h) {
  const m = /^([A-Za-z_][\w ]*?)\s*(?:\[([A-Za-z%°℃℉]+)\])?$/.exec(h.trim());
  if (!m) return null;
  let unit = (m[2] || '').replace(/°|℃/g, 'C').replace(/℉/g, 'F');
  return { name: m[1].trim().replace(/\s+/g, '_').toLowerCase(), unit: unit || null };
}

function parseNumber(token) {
  if (token === undefined) return null;
  const t = String(token).trim();
  if (t === '' || t.toLowerCase() === 'na' || t.toLowerCase() === 'null') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function parseCSV(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) throw new Error('CSV 至少需要表头与 2 行数据');
  const headers = lines[0].split(',').map((h) => h.trim());
  if (headers[0].toLowerCase() !== 'time_s') headers[0] = 'time_s';
  const cols = headers.slice(1).map(parseChannelHeader);
  if (cols.some((c) => !c)) throw new Error('CSV 表头通道格式应为 名称[单位]，例如 bean_temp[C]');
  const time = [];
  const channels = Object.fromEntries(cols.map((c) => [c.name, { unit: c.unit, values: [] }]));
  lines.slice(1).forEach((line, ln) => {
    const cells = line.split(',');
    const t = parseNumber(cells[0]);
    if (Number.isNaN(t)) throw new Error(`CSV 第 ${ln + 2} 行时间不是数字`);
    time.push(t);
    cols.forEach((c, idx) => {
      const v = parseNumber(cells[idx + 1]);
      if (Number.isNaN(v)) throw new Error(`CSV 第 ${ln + 2} 行通道 ${c.name} 不是数字`);
      channels[c.name].values.push(v);
    });
  });
  return { time, channels };
}

function parseFile(originalname, buffer) {
  const ext = path.extname(originalname).toLowerCase();
  const text = buffer.toString('utf8');
  if (ext === '.json') {
    let j;
    try { j = JSON.parse(text); } catch { throw new Error('JSON 解析失败'); }
    if (!j || typeof j !== 'object') throw new Error('JSON 根节点必须是对象');
    const time = Array.isArray(j.time_s) ? j.time_s : Array.isArray(j.time) ? j.time : null;
    if (!Array.isArray(time)) throw new Error('JSON 缺少 time_s 数组');
    const rawCh = j.channels || j.series;
    if (!rawCh || typeof rawCh !== 'object') throw new Error('JSON 缺少 channels 对象');
    const channels = {};
    for (const [name, ch] of Object.entries(rawCh)) {
      if (!ch || !Array.isArray(ch.values)) throw new Error(`通道 ${name} 缺少 values 数组`);
      channels[String(name).toLowerCase()] = {
        unit: ch.unit || null,
        values: ch.values.map((v) => (v == null ? null : Number(v))),
      };
    }
    const meta = j.metadata || {};
    return { time: time.map(Number), channels, fileMeta: meta };
  }
  if (ext === '.csv') return { ...parseCSV(text), fileMeta: {} };
  throw new Error('仅支持 .json / .csv 曲线文件');
}

function validateCurve(originalname, buffer, declared) {
  const errors = [];
  const warnings = [];
  let parsed;
  try {
    parsed = parseFile(originalname, buffer);
  } catch (e) {
    return { ok: false, errors: [`文件解析：${e.message}`], warnings: [], summary: null, parsed: null, meta: null };
  }
  const { time, channels, fileMeta } = parsed;

  const probeModel = (declared.probe_model || fileMeta.probe_model || '').trim();
  const probePosition = (declared.probe_position || fileMeta.probe_position || '').trim();
  const tempUnit = (declared.temp_unit || fileMeta.temp_unit || '').trim().toUpperCase();
  const timeZero = (declared.time_zero || fileMeta.time_zero || '').trim();
  const declaredInterval = declared.sample_interval_s != null && declared.sample_interval_s !== ''
    ? Number(declared.sample_interval_s)
    : (fileMeta.sample_interval_s != null ? Number(fileMeta.sample_interval_s) : null);

  if (!probeModel) errors.push('缺少温度探头型号（probe_model）');
  if (!probePosition) errors.push('缺少探头位置（probe_position）');
  if (!TEMP_UNITS.includes(tempUnit)) errors.push(`温度单位必须是 C 或 F（收到：${tempUnit || '空'}）`);
  if (!TIME_ZEROS.includes(timeZero)) errors.push(`时间零点 time_zero 不被识别：${timeZero || '空'}`);
  if (declaredInterval != null && !(declaredInterval > 0)) errors.push('采样间隔必须为正数');

  if (time.length < 2) errors.push('曲线点数不足（<2）');
  for (let i = 1; i < time.length; i++) {
    if (!(time[i] > time[i - 1])) { errors.push(`时间轴在第 ${i + 1} 点非严格递增`); break; }
  }
  const deltas = [];
  for (let i = 1; i < time.length; i++) deltas.push(time[i] - time[i - 1]);
  const sortedD = deltas.slice().sort((a, b) => a - b);
  const observedInterval = sortedD.length ? sortedD[Math.floor(sortedD.length / 2)] : null;
  if (declaredInterval != null && observedInterval != null) {
    const relErr = Math.abs(observedInterval - declaredInterval) / declaredInterval;
    if (relErr > INTERVAL_TOL) {
      errors.push(`采样间隔不符：声明 ${declaredInterval}s，文件时间戳实测中位数 ${observedInterval.toFixed(2)}s（偏差 ${(relErr * 100).toFixed(0)}% > ${INTERVAL_TOL * 100}%）`);
    }
  }

  const chNames = Object.keys(channels);
  const tempName = chNames.find((n) => n.includes('bean')) || chNames.find((n) => n.includes('temp') || n === 'bt');
  if (!tempName) errors.push('未找到豆温通道（名称需包含 bean/temp/bt）');

  const channelSummaries = [];
  for (const [name, ch] of Object.entries(channels)) {
    if (ch.values.length !== time.length) {
      errors.push(`通道 ${name} 长度 ${ch.values.length} 与时间轴 ${time.length} 不一致`);
      continue;
    }
    let unit = ch.unit;
    const isTemp = /temp|bt|et|irt|exhaust|inlet|env/i.test(name);
    if (isTemp) {
      unit = (unit || '').toUpperCase();
      if (!unit) { ch.unit = tempUnit; unit = tempUnit; warnings.push(`通道 ${name} 未标单位，按声明 ${tempUnit} 处理`); }
      if (!TEMP_UNITS.includes(unit)) { errors.push(`通道 ${name} 量纲错误：温度通道单位为 ${unit}`); continue; }
      if (unit !== tempUnit) errors.push(`量纲不一致：声明温度单位 ${tempUnit}，通道 ${name} 标记为 ${unit}`);
      let bad = 0;
      for (const v of ch.values) {
        if (v === null) continue;
        const c = toC(v, unit);
        if (c < RANGE_C.min || c > RANGE_C.max) bad++;
      }
      if (bad > 0) errors.push(`通道 ${name} 有 ${bad} 个点超出合理温度范围 ${RANGE_C.min}~${RANGE_C.max}°C（疑似量纲错误，如把 °F 数值按 °C 上报）`);
    }
    const nonNull = ch.values.filter((v) => v !== null);
    const gapS = maxGapSeconds(time, ch.values, observedInterval);
    channelSummaries.push({
      channel: name,
      unit: isTemp ? unit : ch.unit,
      is_temp: !!isTemp,
      point_count: ch.values.length,
      present_count: nonNull.length,
      max_gap_s: Number(gapS.toFixed(2)),
    });
    if (gapS > (observedInterval || declaredInterval || 1) * SHORT_GAP_SAMPLES) {
      warnings.push(`通道 ${name} 存在 ${gapS.toFixed(1)}s 长缺测：比较与绘图不会跨缺口插值`);
    }
  }

  const beanCh = channelSummaries.find((c) => c.channel === tempName);
  const duration = time.length ? Number((time[time.length - 1] - time[0]).toFixed(3)) : 0;
  const summary = {
    point_count: time.length,
    duration_s: duration,
    observed_interval_s: observedInterval ? Number(observedInterval.toFixed(3)) : null,
    interval_s: Number((declaredInterval || observedInterval || 0).toFixed(3)) || null,
    max_gap_s: beanCh ? beanCh.max_gap_s : 0,
    bean_channel: tempName,
    channels: channelSummaries,
  };
  const meta = {
    probe_model: probeModel,
    probe_position: probePosition,
    temp_unit: tempUnit,
    time_zero: timeZero,
    sample_interval_s: summary.interval_s,
  };
  return { ok: errors.length === 0, errors, warnings, summary, parsed, meta };
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function storeCurveFile(batchId, originalname, buffer, accepted) {
  const hash = sha256(buffer);
  const dir = path.join(__dirname, '..', '..', 'storage', 'curves', accepted ? String(batchId) : 'rejected');
  fs.mkdirSync(dir, { recursive: true });
  const safe = path.basename(originalname).replace(/[^\w.\-]+/g, '_');
  const fname = `${Date.now()}-${hash.slice(0, 12)}-${safe}`;
  const full = path.join(dir, fname);
  fs.writeFileSync(full, buffer);
  return {
    storage_path: path.relative(path.join(__dirname, '..', '..', 'storage'), full),
    content_sha256: hash,
    byte_size: buffer.length,
  };
}

function storageRoot() { return path.join(__dirname, '..', '..', 'storage'); }
function resolveStored(rel) { return path.join(storageRoot(), rel); }

function loadCurveSeries(rel) {
  const full = resolveStored(rel);
  const buffer = fs.readFileSync(full);
  const parsed = parseFile(path.basename(full).replace(/^\d+-[a-f0-9]+-/, ''), buffer);
  const series = {};
  for (const [name, ch] of Object.entries(parsed.channels)) {
    const { values, filled } = seriesWithShortGapFill(ch.values);
    series[name] = { unit: ch.unit, values, filled: [...filled] };
  }
  return { time: parsed.time, series };
}

module.exports = {
  validateCurve, storeCurveFile, loadCurveSeries, sha256, resolveStored,
  storageRoot, toC, seriesWithShortGapFill, SHORT_GAP_SAMPLES,
};
