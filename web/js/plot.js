// Minimal canvas plotting: line plots with zoom/hover/legend, heatmaps with colorbars.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function theme() {
  return {
    surface: css('--surface-1'),
    fg: css('--text-primary'),
    fg2: css('--text-secondary'),
    muted: css('--text-muted'),
    grid: css('--grid'),
    axis: css('--axis'),
    s1: css('--series-1'),
    s2: css('--series-2'),
    s3: css('--series-3'),
    s4: css('--series-4'),
    s5: css('--series-5'),
    s6: css('--series-6'),
    hl: css('--highlight'),
    font: '11px ' + css('--font-chart'),
    mono: '11px ' + css('--font-mono'),
  };
}

// ---------------------------------------------------------------------------------------
// Number formatting

const SI = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n']];

export function si(v, digits = 3, unit = '') {
  if (!Number.isFinite(v)) return '–';
  if (v === 0) return '0' + (unit ? ' ' + unit : '');
  const a = Math.abs(v);
  for (const [s, p] of SI) {
    if (a >= s * 0.9999) return `${+(v / s).toPrecision(digits)}${unit || p ? ' ' : ''}${p}${unit}`;
  }
  return v.toExponential(digits - 1) + (unit ? ' ' + unit : '');
}

export function fmt(v, digits = 3) {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) {
    const [m, e] = v.toExponential(digits - 1).split('e');
    return `${+m}e${+e}`;
  }
  return String(+v.toPrecision(digits));
}

export function niceTicks(min, max, count = 5) {
  if (!(max > min)) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** Log-axis labels: decades as 1eN (except 1–100), others in the same style. */
function logLabel(v) {
  const e = Math.floor(Math.log10(v) + 1e-9);
  const m = +(v / Math.pow(10, e)).toPrecision(2);
  if (e >= 0 && e <= 2) return String(+v.toPrecision(3));
  return m === 1 ? `1e${e}` : `${m}e${e}`;
}

function logTicks(min, max) {
  const out = [];
  const lo = Math.floor(Math.log10(min)), hi = Math.ceil(Math.log10(max));
  const every = Math.max(1, Math.ceil((hi - lo) / 6));
  for (let e = lo; e <= hi; e += every) {
    const v = Math.pow(10, e);
    if (v >= min * 0.999 && v <= max * 1.001) out.push(v);
  }
  if (out.length < 2) {
    for (const m of [2, 5]) for (let e = lo; e <= hi; e++) {
      const v = m * Math.pow(10, e);
      if (v >= min && v <= max) out.push(v);
    }
    out.sort((a, b) => a - b);
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Colormaps

const MAPS = {
  plasma: ['#0d0887', '#46039f', '#7201a8', '#9c179e', '#bd3786', '#d8576b', '#ed7953', '#fb9f3a', '#fdca26', '#f0f921'],
  inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'],
  viridis: ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725'],
  blue: ['#0d366b', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'],
  gray: ['#000000', '#ffffff'],
};
export const COLORMAPS = Object.keys(MAPS);
const lutCache = {};

export function lut(name) {
  if (lutCache[name]) return lutCache[name];
  const stops = MAPS[name].map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
  const out = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f;
  }
  return (lutCache[name] = out);
}

export function cmapColor(name, t) {
  const L = lut(name);
  const i = Math.max(0, Math.min(255, Math.round(t * 255))) * 3;
  return `rgb(${L[i]},${L[i + 1]},${L[i + 2]})`;
}

// ---------------------------------------------------------------------------------------
// Tooltip (single shared element)

let tipEl;
export function showTip(clientX, clientY, html) {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tooltip';
    document.body.appendChild(tipEl);
  }
  tipEl.innerHTML = html;
  tipEl.style.display = 'block';
  const r = tipEl.getBoundingClientRect();
  let x = clientX + 14, y = clientY + 14;
  if (x + r.width > innerWidth - 8) x = clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = clientY - r.height - 14;
  tipEl.style.left = `${Math.max(8, x)}px`;
  tipEl.style.top = `${Math.max(8, y)}px`;
}
export function hideTip() {
  if (tipEl) tipEl.style.display = 'none';
}

// ---------------------------------------------------------------------------------------
// Canvas base: DPR-aware, resizes with its container, batches redraws.

export class Surface {
  constructor(el, draw) {
    this.el = el;
    this.canvas = document.createElement('canvas');
    el.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.drawFn = draw;
    this.pending = false;
    this.w = 0; this.h = 0;
    new ResizeObserver(() => this.render()).observe(el);
  }
  render() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      const dpr = devicePixelRatio || 1;
      const w = this.el.clientWidth, h = this.el.clientHeight;
      if (!w || !h) return;
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';
      }
      this.w = w; this.h = h;
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      this.drawFn(ctx, w, h, theme());
    });
  }
  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
}

function drawEmpty(ctx, w, h, t, message) {
  ctx.fillStyle = t.muted;
  ctx.font = t.font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, w / 2, h / 2);
}

// ---------------------------------------------------------------------------------------
// Line plot

export class LinePlot {
  /**
   * opts: { xLabel, yLabel, yLog, xFormat, yFormat, empty, legend: true }
   * series: [{ label, x, y, color: 'sN' | css color, width, dash, hidden }]
   * bands: [{ x0, x1, label }]  shaded x ranges;  vlines: [{ x, label }]
   */
  constructor(el, opts = {}) {
    this.opts = { legend: true, empty: 'No data', xFormat: fmt, yFormat: fmt, ...opts };
    this.series = [];
    this.bands = [];
    this.vlines = [];
    this.view = null; // [x0, x1] zoom window
    this.hover = null;
    this.drag = null;
    el.classList.add('plot');
    if (this.opts.legend) {
      this.legendEl = document.createElement('div');
      this.legendEl.className = 'legend';
      el.appendChild(this.legendEl);
    }
    const area = document.createElement('div');
    area.className = 'plot-area';
    el.appendChild(area);
    this.surface = new Surface(area, (ctx, w, h, t) => this.draw(ctx, w, h, t));
    const c = this.surface.canvas;
    c.addEventListener('mousemove', (e) => this.onMove(e));
    c.addEventListener('mouseleave', () => { this.hover = null; this.drag = null; hideTip(); this.render(); });
    c.addEventListener('mousedown', (e) => { const [x] = this.surface.local(e); this.drag = { x0: x, x1: x }; });
    c.addEventListener('mouseup', () => this.onDragEnd());
    c.addEventListener('dblclick', () => { this.view = null; this.render(); });
  }

  set(series, { bands, vlines, keepView } = {}) {
    this.series = series;
    if (bands) this.bands = bands;
    if (vlines) this.vlines = vlines;
    if (!keepView) this.view = null;
    this.renderLegend();
    this.render();
  }

  setView(view) { this.view = view; this.render(); }

  render() { this.surface.render(); }

  renderLegend() {
    if (!this.legendEl) return;
    this.legendEl.innerHTML = '';
    const visible = this.series.filter((s) => s.label);
    if (visible.length < 2 && !this.opts.alwaysLegend) return;
    const t = theme();
    for (const s of visible) {
      const item = document.createElement('button');
      item.className = 'legend-item' + (s.hidden ? ' off' : '');
      const sw = document.createElement('span');
      sw.className = 'swatch' + (s.dash ? ' dashed' : '');
      sw.style.setProperty('--c', this.color(s, t));
      item.append(sw, document.createTextNode(s.label));
      item.title = 'Toggle series';
      item.onclick = () => { s.hidden = !s.hidden; this.renderLegend(); this.render(); };
      this.legendEl.appendChild(item);
    }
  }

  color(s, t) { return t[s.color] || s.color || t.s1; }

  frame(w, h) {
    return { l: 58, r: 12, t: 10, b: 34, W: w - 70, H: h - 44 };
  }

  domain() {
    let x0 = Infinity, x1 = -Infinity;
    for (const s of this.series) {
      if (s.hidden || !s.x.length) continue;
      x0 = Math.min(x0, s.x[0]); x1 = Math.max(x1, s.x[s.x.length - 1]);
    }
    if (this.opts.xDomain) [x0, x1] = this.opts.xDomain;
    if (this.view) [x0, x1] = this.view;
    let y0 = Infinity, y1 = -Infinity;
    for (const s of this.series) {
      if (s.hidden) continue;
      for (let i = 0; i < s.x.length; i++) {
        const x = s.x[i], y = s.y[i];
        if (x < x0 || x > x1 || !Number.isFinite(y) || (this.opts.yLog && y <= 0)) continue;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (this.opts.yLog) {
      if (this.opts.yFloorRatio && y1 / y0 > this.opts.yFloorRatio) y0 = y1 / this.opts.yFloorRatio;
      const pad = Math.pow(y1 / y0 || 10, 0.06);
      y0 /= pad; y1 *= pad;
      if (!(y1 > y0)) { y0 = y0 / 10 || 0.1; y1 = y0 * 100; }
    } else {
      if (this.opts.yZero) y0 = Math.min(0, y0);
      const pad = (y1 - y0) * 0.06 || Math.abs(y1) * 0.1 || 1;
      y0 -= this.opts.yZero && y0 === 0 ? 0 : pad; y1 += pad;
    }
    return { x0, x1, y0, y1 };
  }

  draw(ctx, w, h, t) {
    const f = this.frame(w, h);
    if (!this.series.some((s) => !s.hidden && s.x.length)) return drawEmpty(ctx, w, h, t, this.opts.empty);
    const d = this.domain();
    if (!Number.isFinite(d.x0) || !Number.isFinite(d.y0)) return drawEmpty(ctx, w, h, t, this.opts.empty);
    const log = this.opts.yLog;
    const ly0 = log ? Math.log10(d.y0) : d.y0, ly1 = log ? Math.log10(d.y1) : d.y1;
    const X = (x) => f.l + ((x - d.x0) / (d.x1 - d.x0 || 1)) * f.W;
    const Y = (y) => f.t + f.H - (((log ? Math.log10(y) : y) - ly0) / (ly1 - ly0 || 1)) * f.H;
    this.scales = { X, Y, d, f };

    // Bands
    for (const b of this.bands) {
      const a = Math.max(f.l, X(b.x0)), z = Math.min(f.l + f.W, X(b.x1));
      if (z <= a) continue;
      ctx.fillStyle = t.grid;
      ctx.globalAlpha = 0.45;
      ctx.fillRect(a, f.t, z - a, f.H);
      ctx.globalAlpha = 1;
    }

    // Grid + ticks
    ctx.font = t.font;
    ctx.lineWidth = 1;
    ctx.strokeStyle = t.grid;
    ctx.fillStyle = t.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yt = log ? logTicks(d.y0, d.y1) : niceTicks(d.y0, d.y1, Math.max(2, Math.floor(f.H / 45)));
    for (const v of yt) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(f.l, y); ctx.lineTo(f.l + f.W, y); ctx.stroke();
      ctx.fillText(log ? logLabel(v) : this.opts.yFormat(v), f.l - 6, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const v of niceTicks(d.x0, d.x1, Math.max(2, Math.floor(f.W / 80)))) {
      const x = Math.round(X(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, f.t); ctx.lineTo(x, f.t + f.H); ctx.stroke();
      ctx.fillText(this.opts.xFormat(v), x, f.t + f.H + 6);
    }
    ctx.strokeStyle = t.axis;
    ctx.beginPath(); ctx.moveTo(f.l, f.t + f.H + 0.5); ctx.lineTo(f.l + f.W, f.t + f.H + 0.5); ctx.stroke();

    // Labels
    ctx.fillStyle = t.fg2;
    if (this.opts.xLabel) ctx.fillText(this.opts.xLabel, f.l + f.W / 2, h - 13);
    if (this.opts.yLabel) {
      ctx.save(); ctx.translate(11, f.t + f.H / 2); ctx.rotate(-Math.PI / 2);
      ctx.textBaseline = 'middle'; ctx.fillText(this.opts.yLabel, 0, 0); ctx.restore();
    }

    // Vertical markers
    for (const v of this.vlines) {
      const x = Math.round(X(v.x)) + 0.5;
      if (x < f.l || x > f.l + f.W) continue;
      ctx.strokeStyle = t.fg2; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, f.t); ctx.lineTo(x, f.t + f.H); ctx.stroke();
      ctx.setLineDash([]);
      if (v.label) { ctx.fillStyle = t.fg2; ctx.textAlign = 'left'; ctx.fillText(v.label, x + 4, f.t + 2); }
    }

    // Series
    ctx.save();
    ctx.beginPath(); ctx.rect(f.l, f.t, f.W, f.H); ctx.clip();
    for (const s of this.series) {
      if (s.hidden) continue;
      ctx.strokeStyle = this.color(s, t);
      ctx.lineWidth = s.width || 1.5;
      ctx.setLineDash(s.dash ? [5, 4] : []);
      ctx.lineJoin = 'round';
      this.path(ctx, s, X, Y, d, f, log);
    }
    ctx.restore();
    ctx.setLineDash([]);

    // Drag selection
    if (this.drag && Math.abs(this.drag.x1 - this.drag.x0) > 3) {
      ctx.fillStyle = t.s1; ctx.globalAlpha = 0.12;
      ctx.fillRect(Math.min(this.drag.x0, this.drag.x1), f.t, Math.abs(this.drag.x1 - this.drag.x0), f.H);
      ctx.globalAlpha = 1;
    }

    // Hover crosshair
    if (this.hover && !this.drag) {
      const x = Math.round(X(this.hover.x)) + 0.5;
      ctx.strokeStyle = t.fg2; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, f.t); ctx.lineTo(x, f.t + f.H); ctx.stroke();
      for (const p of this.hover.points) {
        if (!Number.isFinite(p.y) || (log && p.y <= 0)) continue;
        ctx.fillStyle = p.color; ctx.strokeStyle = t.surface; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), 4, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      }
    }
  }

  /** Draws a series, decimating to min/max per pixel column when dense. */
  path(ctx, s, X, Y, d, f, log) {
    const n = s.x.length;
    let i0 = lowerBound(s.x, d.x0) - 1, i1 = lowerBound(s.x, d.x1) + 1;
    i0 = Math.max(0, i0); i1 = Math.min(n, i1);
    const valid = (y) => Number.isFinite(y) && (!log || y > 0);
    ctx.beginPath();
    let pen = false;
    if (i1 - i0 > f.W * 2) {
      let col = -1, mn = 0, mx = 0;
      const flush = () => {
        if (col < 0) return;
        const x = f.l + col + 0.5;
        if (!pen) { ctx.moveTo(x, Y(mn)); pen = true; } else ctx.lineTo(x, Y(mn));
        ctx.lineTo(x, Y(mx));
      };
      for (let i = i0; i < i1; i++) {
        const y = s.y[i];
        if (!valid(y)) { flush(); col = -1; pen = false; continue; }
        const c = Math.floor(X(s.x[i]) - f.l);
        if (c !== col) { flush(); col = c; mn = mx = y; } else { if (y < mn) mn = y; if (y > mx) mx = y; }
      }
      flush();
    } else {
      for (let i = i0; i < i1; i++) {
        const y = s.y[i];
        if (!valid(y)) { pen = false; continue; }
        const px = X(s.x[i]), py = Y(y);
        if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
      }
    }
    ctx.stroke();
  }

  onMove(e) {
    const [mx] = this.surface.local(e);
    if (this.drag) { this.drag.x1 = mx; this.render(); return; }
    if (!this.scales) return;
    const { d, f } = this.scales;
    if (mx < f.l || mx > f.l + f.W) { this.hover = null; hideTip(); this.render(); return; }
    const x = d.x0 + ((mx - f.l) / f.W) * (d.x1 - d.x0);
    const t = theme();
    const points = [];
    let hx = x;
    for (const s of this.series) {
      if (s.hidden || !s.x.length) continue;
      let i = lowerBound(s.x, x);
      if (i > 0 && (i >= s.x.length || Math.abs(s.x[i - 1] - x) < Math.abs(s.x[i] - x))) i--;
      if (i >= s.x.length) continue;
      hx = s.x[i];
      points.push({ x: s.x[i], y: s.y[i], color: this.color(s, t), label: s.label || this.opts.yLabel || 'value' });
    }
    this.hover = { x: hx, points };
    const rows = points
      .map((p) => `<div class="tip-row"><span class="swatch" style="--c:${p.color}"></span>${p.label}<b>${this.opts.yFormat(p.y)}</b></div>`)
      .join('');
    showTip(e.clientX, e.clientY, `<div class="tip-head">${this.opts.xLabel || 'x'}: ${this.opts.xFormat(hx)}</div>${rows}`);
    this.render();
  }

  onDragEnd() {
    const drag = this.drag;
    this.drag = null;
    if (drag && this.scales && Math.abs(drag.x1 - drag.x0) > 5) {
      const { d, f } = this.scales;
      const toX = (px) => d.x0 + ((px - f.l) / f.W) * (d.x1 - d.x0);
      const a = toX(Math.min(drag.x0, drag.x1)), b = toX(Math.max(drag.x0, drag.x1));
      this.view = [a, b];
      this.opts.onZoom?.(this.view);
    }
    this.render();
  }
}

function lowerBound(arr, v) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] < v) lo = m + 1; else hi = m;
  }
  return lo;
}

// ---------------------------------------------------------------------------------------
// Heatmap / image plot

/**
 * opts: { sky: bool (unit-disk l/m image), xLabel, yLabel, xFormat, yFormat, cbLabel, empty,
 *         equal: bool aspect, overlay(ctx, toPx, t), hoverExtra(x, y) -> html }
 * data: { values: Float32Array (row-major, row 0 at y0), cols, rows, x0, x1, y0, y1 }
 */
export class ImagePlot {
  constructor(el, opts = {}) {
    this.opts = { cmap: 'plasma', scale: 'linear', xFormat: fmt, yFormat: fmt, empty: 'No data', ...opts };
    this.data = null;
    this.range = null; // [vmin, vmax] override
    this.offscreen = document.createElement('canvas');
    el.classList.add('plot');
    const area = document.createElement('div');
    area.className = 'plot-area';
    el.appendChild(area);
    this.surface = new Surface(area, (ctx, w, h, t) => this.draw(ctx, w, h, t));
    const c = this.surface.canvas;
    c.addEventListener('mousemove', (e) => this.onMove(e));
    c.addEventListener('mouseleave', () => { this.cursor = null; hideTip(); this.render(); });
    c.addEventListener('click', (e) => this.onClick(e));
  }

  set(data) { this.data = data; this.dirty = true; this.render(); }
  setOptions(o) { Object.assign(this.opts, o); this.dirty = true; this.render(); }
  setRange(r) { this.range = r; this.dirty = true; this.render(); }
  render() { this.surface.render(); }

  transform(v) {
    if (this.opts.scale === 'log') return v > 0 ? 10 * Math.log10(v) : NaN;
    if (this.opts.scale === 'sqrt') return v >= 0 ? Math.sqrt(v) : NaN;
    return v;
  }
  inverse(v) {
    if (this.opts.scale === 'log') return Math.pow(10, v / 10);
    if (this.opts.scale === 'sqrt') return v * v;
    return v;
  }

  /** Display range in transformed units. */
  displayRange() {
    const vals = this.data.values;
    let lo = Infinity, hi = -Infinity;
    if (this.range) {
      lo = this.transform(this.range[0]); hi = this.transform(this.range[1]);
    }
    if ((!Number.isFinite(lo) || !Number.isFinite(hi)) && this.opts.robust) {
      const sorted = Array.from(vals, (v) => this.transform(v)).filter(Number.isFinite).sort((a, b) => a - b);
      lo = sorted[Math.floor(sorted.length * 0.02)];
      hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.995))];
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = Infinity; hi = -Infinity;
      for (const v of vals) {
        const tv = this.transform(v);
        if (!Number.isFinite(tv)) continue;
        if (tv < lo) lo = tv;
        if (tv > hi) hi = tv;
      }
    }
    if (this.opts.scale === 'log' && this.opts.dynamicRange && hi - lo > this.opts.dynamicRange) lo = hi - this.opts.dynamicRange;
    if (!(hi > lo)) hi = lo + 1;
    return [lo, hi];
  }

  rebuild() {
    const { values, cols, rows } = this.data;
    const [lo, hi] = (this.dr = this.displayRange());
    this.offscreen.width = cols; this.offscreen.height = rows;
    const octx = this.offscreen.getContext('2d');
    const img = octx.createImageData(cols, rows);
    const L = lut(this.opts.cmap);
    for (let r = 0; r < rows; r++) {
      const dst = (rows - 1 - r) * cols; // row 0 at the bottom
      for (let c = 0; c < cols; c++) {
        const tv = this.transform(values[r * cols + c]);
        const o = (dst + c) * 4;
        if (!Number.isFinite(tv)) { img.data[o + 3] = 0; continue; }
        const k = Math.max(0, Math.min(255, Math.round(((tv - lo) / (hi - lo)) * 255))) * 3;
        img.data[o] = L[k]; img.data[o + 1] = L[k + 1]; img.data[o + 2] = L[k + 2]; img.data[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    this.dirty = false;
  }

  draw(ctx, w, h, t) {
    if (!this.data) return drawEmpty(ctx, w, h, t, this.opts.empty);
    if (this.dirty) this.rebuild();
    const { x0, x1, y0, y1 } = this.data;
    // Colorbar gutter sized to its labels, so wider (e.g. monospace) chart fonts do not clip them.
    const [lo, hi] = this.dr;
    const cbTicks = niceTicks(lo, hi, Math.max(2, Math.floor((h - 44) / 40)));
    const cbText = (v) => (this.opts.scale === 'log' ? `${fmt(v, 3)} dB` : fmt(this.opts.scale === 'sqrt' ? v * v : v, 3));
    ctx.font = t.font;
    const labelW = Math.max(0, ...cbTicks.map((v) => ctx.measureText(cbText(v)).width));
    const cb = 14 + 10 + 4 + labelW + (this.opts.cbLabel ? 18 : 4);
    const m = { l: 48, r: cb, t: 10, b: 34 };
    let W = w - m.l - m.r, H = h - m.t - m.b;
    if (this.opts.sky || this.opts.equal) { const s = Math.min(W, H); W = s; H = s; }
    const L = m.l + (w - m.l - m.r - W) / 2, T = m.t + (h - m.t - m.b - H) / 2;
    const X = (x) => L + ((x - x0) / (x1 - x0)) * W;
    const Y = (y) => T + H - ((y - y0) / (y1 - y0)) * H;
    this.geom = { L, T, W, H, X, Y };

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.offscreen, L, T, W, H);

    ctx.font = t.font;
    ctx.lineWidth = 1;
    if (this.opts.sky) {
      ctx.strokeStyle = t.axis;
      const cx = X(0), cy = Y(0), r = W / 2;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke();
      ctx.globalAlpha = 0.35; ctx.strokeStyle = '#ffffff';
      for (const alt of [30, 60]) { ctx.beginPath(); ctx.arc(cx, cy, r * Math.cos((alt * Math.PI) / 180), 0, 2 * Math.PI); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy); ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // Axes ticks
    ctx.fillStyle = t.muted; ctx.strokeStyle = t.axis;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const v of niceTicks(x0, x1, Math.max(2, Math.floor(W / 70)))) {
      const x = X(v);
      ctx.beginPath(); ctx.moveTo(x, T + H); ctx.lineTo(x, T + H + 4); ctx.stroke();
      ctx.fillText(this.opts.xFormat(v), x, T + H + 6);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of niceTicks(y0, y1, Math.max(2, Math.floor(H / 45)))) {
      const y = Y(v);
      ctx.beginPath(); ctx.moveTo(L - 4, y); ctx.lineTo(L, y); ctx.stroke();
      ctx.fillText(this.opts.yFormat(v), L - 6, y);
    }
    ctx.fillStyle = t.fg2; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    if (this.opts.xLabel) ctx.fillText(this.opts.xLabel, L + W / 2, h - 13);
    if (this.opts.yLabel) {
      ctx.save(); ctx.translate(11, T + H / 2); ctx.rotate(-Math.PI / 2);
      ctx.textBaseline = 'middle'; ctx.fillText(this.opts.yLabel, 0, 0); ctx.restore();
    }

    // Overlay
    if (this.opts.overlay) {
      ctx.save();
      ctx.beginPath(); ctx.rect(L, T, W, H); ctx.clip();
      this.opts.overlay(ctx, (x, y) => [X(x), Y(y)], t, this.geom);
      ctx.restore();
    }

    // Cursor marker
    if (this.marker) {
      const [mx, my] = [X(this.marker[0]), Y(this.marker[1])];
      ctx.strokeStyle = t.hl; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(mx, my, 7, 0, 2 * Math.PI); ctx.stroke();
    }

    // Colorbar
    const bx = L + W + 14, bw = 10;
    const L8 = lut(this.opts.cmap);
    for (let i = 0; i < H; i++) {
      const k = Math.round((1 - i / H) * 255) * 3;
      ctx.fillStyle = `rgb(${L8[k]},${L8[k + 1]},${L8[k + 2]})`;
      ctx.fillRect(bx, T + i, bw, 1.5);
    }
    ctx.fillStyle = t.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (const v of cbTicks) {
      const y = T + H - ((v - lo) / (hi - lo)) * H;
      ctx.fillText(cbText(v), bx + bw + 4, y);
    }
    if (this.opts.cbLabel) {
      ctx.save(); ctx.translate(w - 6, T + H / 2); ctx.rotate(-Math.PI / 2);
      ctx.textAlign = 'center'; ctx.fillStyle = t.fg2; ctx.fillText(this.opts.cbLabel, 0, 0); ctx.restore();
    }
  }

  pick(e) {
    if (!this.data || !this.geom) return null;
    const [px, py] = this.surface.local(e);
    const { L, T, W, H } = this.geom;
    if (px < L || px > L + W || py < T || py > T + H) return null;
    const { x0, x1, y0, y1, cols, rows, values } = this.data;
    const x = x0 + ((px - L) / W) * (x1 - x0);
    const y = y0 + ((T + H - py) / H) * (y1 - y0);
    const c = Math.min(cols - 1, Math.floor(((x - x0) / (x1 - x0)) * cols));
    const r = Math.min(rows - 1, Math.floor(((y - y0) / (y1 - y0)) * rows));
    return { x, y, c, r, value: values[r * cols + c] };
  }

  onMove(e) {
    const p = this.pick(e);
    if (!p) { hideTip(); return; }
    const extra = this.opts.hoverExtra ? this.opts.hoverExtra(p) : '';
    showTip(e.clientX, e.clientY,
      `<div class="tip-head">${this.opts.xLabel || 'x'} ${this.opts.xFormat(p.x)} · ${this.opts.yLabel || 'y'} ${this.opts.yFormat(p.y)}</div>` +
      `<div class="tip-row">value<b>${Number.isFinite(p.value) ? fmt(p.value, 4) : '–'}</b></div>` +
      (this.opts.scale === 'log' && p.value > 0 ? `<div class="tip-row">dB<b>${fmt(10 * Math.log10(p.value), 4)}</b></div>` : '') + extra);
  }

  onClick(e) {
    const p = this.pick(e);
    if (p && this.opts.onClick) this.opts.onClick(p);
  }
}
