import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { STORAGE_DIR } from './config.js';

await fs.mkdir(STORAGE_DIR, { recursive: true });

// 独立文件存储：按 sha256 内容寻址，同名重传不产生副本，删除元数据不删原文件（可追溯原数据）
export async function putCurve(buf) {
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const dir = path.join(STORAGE_DIR, sha256.slice(0, 2));
  await fs.mkdir(dir, { recursive: true });
  const filename = path.join(sha256.slice(0, 2), `${sha256}.csv`);
  const full = path.join(STORAGE_DIR, filename);
  try {
    await fs.writeFile(full, buf, { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  return { filename, sha256, size: buf.length, full };
}

export async function getCurvePath(filename) {
  const full = path.join(STORAGE_DIR, filename);
  // 防目录穿越
  if (!full.startsWith(STORAGE_DIR)) throw new Error('bad path');
  await fs.access(full);
  return full;
}

// CSV 解析。约定列：time_s,et_c,bt_c 或 time_s,temp_c；缺测留空。
// 返回 { columns, rows, error? }
export function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return { error: '文件至少需要表头与一行数据' };
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const need = ['time_s'];
  for (const c of need) if (!header.includes(c)) return { error: `缺少必需列 ${c}` };
  if (!header.some((c) => ['et_c', 'bt_c', 'temp_c'].includes(c)))
    return { error: '缺少温度列（et_c / bt_c / temp_c 之一）' };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',').map((c) => c.trim());
    const row = {};
    header.forEach((h, idx) => { row[h] = cells[idx] ?? ''; });
    rows.push(row);
  }
  return { columns: header, rows };
}

// 量纲/数值校验 + 缺测窗口检测（不填补长缺测）
export function analyzeRows({ rows, columns, expectedUnit = 'C' }) {
  const tIdx = columns;
  const tempCols = columns.filter((c) => ['et_c', 'bt_c', 'temp_c'].includes(c));
  const problems = [];
  let prevT = null;
  let maxGap = 0;
  const gapWindows = [];
  const values = [];
  const points = rows.map((r, idx) => {
    const t = Number(r.time_s);
    if (!Number.isFinite(t)) problems.push(`第 ${idx + 2} 行 time_s 非数字: "${r.time_s}"`);
    if (prevT !== null && Number.isFinite(t) && t <= prevT)
      problems.push(`第 ${idx + 2} 行时间非严格递增（${prevT} -> ${t}）`);
    prevT = Number.isFinite(t) ? t : prevT;
    const p = { time_s: t };
    for (const c of tempCols) {
      const raw = r[c];
      if (raw === '' || raw.toLowerCase() === 'na' || raw.toLowerCase() === 'nan') {
        p[c] = null;
      } else {
        const v = Number(raw);
        if (!Number.isFinite(v)) {
          problems.push(`第 ${idx + 2} 行 ${c} 非数值: "${raw}"`);
          p[c] = null;
        } else {
          p[c] = v;
          values.push(v);
        }
      }
    }
    return p;
  });
  // 逐通道统计连续缺测
  for (const c of tempCols) {
    let start = null;
    let cnt = 0;
    for (let i = 0; i < points.length; i++) {
      if (points[i][c] === null) {
        if (cnt === 0) start = points[i - 1] ? points[i - 1].time_s : points[i].time_s;
        cnt++;
      } else {
        if (cnt > 0) {
          maxGap = Math.max(maxGap, cnt);
          gapWindows.push({ channel: c, from_s: start, to_s: points[i].time_s, missing_samples: cnt });
        }
        cnt = 0;
      }
    }
    if (cnt > 0) {
      maxGap = Math.max(maxGap, cnt);
      gapWindows.push({ channel: c, from_s: start, to_s: null, missing_samples: cnt });
    }
  }
  // 量纲合理性：烘焙豆温典型 60..260 C。若明显像华氏（>260 且 <=550 且声明为 C）给量纲嫌疑。
  const minV = values.length ? Math.min(...values) : null;
  const maxV = values.length ? Math.max(...values) : null;
  let suspicious = false;
  let dimProblem = null;
  if (expectedUnit === 'C' && maxV !== null && maxV > 260) {
    suspicious = true;
    dimProblem = `声明单位为摄氏度，但出现 ${maxV}° 超过 260°C，疑似华氏度量纲未换算`;
    problems.push(dimProblem);
  }
  if (expectedUnit === 'F' && maxV !== null && maxV < 260 && minV !== null && minV < 100) {
    suspicious = true;
    problems.push(`声明单位为华氏度，但数值范围 ${minV}..${maxV} 更像摄氏度`);
  }
  if (points.length < 5) problems.push('数据点过少（<5），无法构成可比较曲线');
  const duration = points.length ? points[points.length - 1].time_s - points[0].time_s : 0;
  return {
    points, tempCols, pointCount: points.length, durationS: duration,
    maxGapSamples: maxGap, gapWindows,
    rangeCheck: { minC: minV, maxC: maxV, suspicious },
    problems,
  };
}
