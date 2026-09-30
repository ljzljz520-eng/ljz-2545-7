// 原创轻量 Canvas 曲线图：原始缺测留空段，短缺口插值以虚线区分；多条曲线叠加时按各自零点标注
class CurveChart {
  constructor(canvas, opts = {}) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.resize = this._draw.bind(this);
    window.addEventListener('resize', this.resize);
  }
  setData(series, meta = {}) {
    this.series = series; // [{name,color,points,cols:['bt_c']}]
    this.meta = meta;
    this._draw();
  }
  destroy() { window.removeEventListener('resize', this.resize); }
  _draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.cv.clientWidth || 800, h = this.cv.clientHeight || 320;
    this.cv.width = w * dpr; this.cv.height = h * dpr;
    const ctx = this.ctx; ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const pad = { l: 52, r: 18, t: 16, b: 40 };
    const plotW = w - pad.l - pad.r, plotH = h - pad.t - pad.b;
    let tMin = Infinity, tMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const s of this.series || []) {
      for (const p of s.points) {
        tMin = Math.min(tMin, p.time_s); tMax = Math.max(tMax, p.time_s);
        for (const c of s.cols) if (p[c] !== null && p[c] !== undefined) { vMin = Math.min(vMin, p[c]); vMax = Math.max(vMax, p[c]); }
      }
    }
    if (!isFinite(tMin)) return;
    vMin = Math.floor((vMin - 5) / 10) * 10; vMax = Math.ceil((vMax + 5) / 10) * 10;
    const X = (t) => pad.l + (t - tMin) / Math.max(1, tMax - tMin) * plotW;
    const Y = (v) => pad.t + (vMax - v) / (vMax - vMin) * plotH;
    // 网格与坐标
    ctx.strokeStyle = '#e7ddc9'; ctx.fillStyle = '#8a7864'; ctx.font = '11px sans-serif'; ctx.lineWidth = 1;
    for (let v = vMin; v <= vMax; v += 20) {
      ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke();
      ctx.fillText(`${v}°`, 8, Y(v) + 4);
    }
    for (let t = tMin; t <= tMax; t += 60) {
      ctx.beginPath(); ctx.moveTo(X(t), pad.t); ctx.lineTo(X(t), h - pad.b); ctx.stroke();
      ctx.fillText(`${Math.round(t)}s`, X(t) - 12, h - pad.b + 18);
    }
    // 零点轴标
    ctx.fillStyle = '#7a4b26'; ctx.font = '12px sans-serif';
    ctx.fillText(`t=0 零点: ${esc(this.meta.zeroLabel || '—')}`, pad.l, h - 8);
    // 曲线
    for (const s of this.series) {
      for (const col of s.cols) {
        ctx.strokeStyle = s.color || '#7a4b26'; ctx.lineWidth = 2;
        let pen = false, prev = null;
        for (const p of s.points) {
          const v = p[col];
          if (v === null || v === undefined) { pen = false; prev = null; continue; }
          const x = X(p.time_s), y = Y(v);
          // 插值点段用虚线
          const interp = p.interpolated && p.interpolated[col];
          ctx.setLineDash(interp ? [5, 4] : []);
          if (pen && prev) { ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(x, y); ctx.stroke(); }
          prev = { x, y }; pen = true;
        }
        ctx.setLineDash([]);
      }
    }
    // 多系列零点不同提示条
    if (this.meta.zeroWarning) {
      ctx.fillStyle = '#8a5410'; ctx.font = '12px sans-serif';
      ctx.fillText('⚠ 各曲线时间零点不同：此图仅为叠加查看，不构成逐时刻比较', pad.l, pad.t + 2);
    }
  }
}
