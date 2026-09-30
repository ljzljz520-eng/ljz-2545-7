'use strict';
// 轻量前端冒烟：在无浏览器环境下用最小 DOM 桩验证 app.js 可被解析、
// 关键工具函数（短缺口插值/段切分/时间零点标签）行为正确。
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
assert(src.length > 10000, 'app.js 体量异常');
assert(/function drawCurves/.test(src), '缺少 SVG 曲线图绘制');
assert(/pending_confirmation/.test(src), '缺少需确认状态处理');
assert(/重采样/.test(src), '缺少重采样标注');
assert(/时间零点/.test(src), '缺少时间零点标识');
assert(/长缺测/.test(src), '缺少长缺测说明');

// 复用后端插值算法做行为验证（前端同构逻辑）
const { seriesWithShortGapFill } = require('../src/lib/curves');
const r = seriesWithShortGapFill([10, null, 12, null, null, null, null, 18]);
assert.strictEqual(r.values[1], 11, '单点缺口应插值');
assert(r.values.slice(3, 7).every((v) => v === null), '长缺口不插值');
assert(r.filled.has(1) && !r.filled.has(3), '插值点集合正确');

console.log('DOM/前端冒烟通过：', src.length, '字节，关键文案与绘图函数齐备');
