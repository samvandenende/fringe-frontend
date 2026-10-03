// Environment views: 3D scene, array layout and orthographic sky map.
import { Surface, showTip, hideTip, cmapColor, niceTicks, fmt, si } from './plot.js';
import { centroid, sourceIntensity, sourceGain } from './model.js';

const DEG = 180 / Math.PI;

/**
 * Maps intensities to [0, 1] for colour/size encodings. `auto` picks a log scale for
 * catalogues with a large dynamic range (point sources) and linear for diffuse models.
 */
export function intensityNormalizer(values, mode = 'auto') {
  const pos = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (!pos.length) return () => 0;
  const hi = pos[pos.length - 1];
  const p50 = pos[pos.length >> 1];
  const log = mode === 'log' || (mode === 'auto' && hi / p50 > 30);
  // Linear scales saturate at the 99.5th percentile so a single bright source (e.g. Cas A in
  // GSM skies) does not wash out the diffuse structure.
  const top = pos[Math.min(pos.length - 1, Math.floor(pos.length * 0.995))];
  if (!log) return (v) => Math.min(1, Math.max(0, v / top));
  const lo = Math.max(pos[0], hi / 1e4);
  const l0 = Math.log10(lo), l1 = Math.log10(hi);
  return (v) => (v > 0 ? Math.max(0, (Math.log10(v) - l0) / (l1 - l0 || 1)) : 0);
}

/** Dot radius range so dense skies stay legible: [min, max] in px for a disk of radius R. */
function dotRadii(n, R) {
  const spacing = R * Math.sqrt(Math.PI / Math.max(1, n));
  const max = Math.max(1.2, Math.min(4.5, 0.55 * spacing));
  return [Math.max(0.7, 0.35 * max), max];
}

function sourceTip(s, freq) {
  const I = sourceIntensity(s, freq);
  return `<div class="tip-head">Source</div>` +
    `<div class="tip-row">RA / Dec<b>${(s.ra * DEG).toFixed(2)}° / ${(s.dec * DEG).toFixed(2)}°</b></div>` +
    `<div class="tip-row">elevation<b>${(Math.asin(Math.max(-1, Math.min(1, s.z))) * DEG).toFixed(1)}°</b></div>` +
    `<div class="tip-row">I(${si(freq, 3, 'Hz')})<b>${fmt(I, 4)}</b></div>` +
    `<div class="tip-row">apparent (×z²)<b>${fmt(I * sourceGain(s), 4)}</b></div>` +
    `<div class="tip-row">spectral index<b>${fmt(s.alpha, 3)}</b></div>`;
}

// ---------------------------------------------------------------------------------------

export class SceneView {
  constructor(el) {
    this.el = el;
    this.yaw = -0.7; this.pitch = 0.42; this.zoom = 1;
    this.rotate = false;
    this.env = null;
    this.surface = new Surface(el, (ctx, w, h, t) => this.draw(ctx, w, h, t));
    const c = this.surface.canvas;
    c.style.cursor = 'grab';
    c.addEventListener('mousedown', (e) => { this.dragging = [e.clientX, e.clientY]; c.style.cursor = 'grabbing'; hideTip(); });
    addEventListener('mouseup', () => { this.dragging = null; c.style.cursor = 'grab'; });
    addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      const [x, y] = this.dragging;
      this.yaw -= (e.clientX - x) * 0.008;
      this.pitch = Math.max(0.02, Math.min(Math.PI / 2, this.pitch + (e.clientY - y) * 0.008));
      this.dragging = [e.clientX, e.clientY];
      this.render();
    });
    c.addEventListener('mousemove', (e) => !this.dragging && this.hoverAt(e));
    c.addEventListener('mouseleave', () => hideTip());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.max(0.5, Math.min(4, this.zoom * Math.exp(-e.deltaY * 0.001)));
      this.render();
    }, { passive: false });
  }

  set(env) { this.env = env; this.prepare(); this.render(); }
  render() { this.surface.render(); }

  setRotate(on) {
    this.rotate = on;
    const tick = () => {
      if (!this.rotate) return;
      if (this.el.offsetParent) { this.yaw += 0.004; this.render(); }
      requestAnimationFrame(tick);
    };
    if (on) requestAnimationFrame(tick);
  }

  prepare() {
    const { positions, sources, freq } = this.env;
    const c = centroid(positions);
    let r = 0;
    for (const p of positions) r = Math.max(r, Math.hypot(p.x - c.x, p.y - c.y));
    this.center = c;
    this.arrayRadius = r || 1;
    this.scale = 0.3 / this.arrayRadius; // array occupies the inner 30% of the dome
    const app = sources.map((s) => sourceIntensity(s, freq) * sourceGain(s));
    const norm = intensityNormalizer(app, this.env.scale);
    this.sourceStyle = app.map((v) => norm(v));
  }

  project(w, h) {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const D = 3.4, F = Math.min(w, h * 1.25) * 0.42 * this.zoom;
    const ox = w / 2, oy = h * 0.5 + F * 0.32 * Math.cos(this.pitch);
    return (x, y, z) => {
      const x1 = x * cy - y * sy, y1 = x * sy + y * cy;
      const depth = y1 * cp - z * sp;
      const up = y1 * sp + z * cp;
      const s = (F * D) / (D + depth);
      return [ox + x1 * s, oy - up * s, depth];
    };
  }

  draw(ctx, w, h, t) {
    if (!this.env) return;
    const P = this.project(w, h);
    this.P = P;
    const { positions, sources, calibrator, cmap } = this.env;

    // Ground disk
    ctx.beginPath();
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * 2 * Math.PI;
      const [x, y] = P(Math.cos(a), Math.sin(a), 0);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.fillStyle = t.grid; ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = t.axis; ctx.lineWidth = 1; ctx.stroke();

    // Dome wireframe (split by depth so the far side reads as behind)
    const line = (pts) => {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        ctx.globalAlpha = (a[2] + b[2]) / 2 > 0 ? 0.25 : 0.6;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    ctx.strokeStyle = t.axis;
    for (const alt of [30, 60]) {
      const pts = [];
      const ca = Math.cos(alt / DEG), sa = Math.sin(alt / DEG);
      for (let i = 0; i <= 72; i++) { const a = (i / 72) * 2 * Math.PI; pts.push(P(ca * Math.cos(a), ca * Math.sin(a), sa)); }
      line(pts);
    }
    for (let az = 0; az < 360; az += 30) {
      const pts = [];
      for (let i = 0; i <= 24; i++) { const e = (i / 24) * (Math.PI / 2); pts.push(P(Math.cos(e) * Math.cos(az / DEG), Math.cos(e) * Math.sin(az / DEG), Math.sin(e))); }
      line(pts);
    }

    // Axis labels
    ctx.font = t.font; ctx.fillStyle = t.fg2; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [x, y, label] of [[1.1, 0, '+x'], [0, 1.1, '+y'], [-1.1, 0, '−x'], [0, -1.1, '−y']]) {
      const [px, py] = P(x, y, 0); ctx.fillText(label, px, py);
    }
    { const [px, py] = P(0, 0, 1.07); ctx.fillText('zenith', px, py); }

    // Antennas
    const c = this.center, s = this.scale;
    ctx.fillStyle = t.s1;
    const antSize = Math.max(1, Math.min(4, 90 / Math.sqrt(positions.length + 1)));
    for (const p of positions) {
      const [x, y] = P((p.x - c.x) * s, (p.y - c.y) * s, (p.z - c.z) * s);
      ctx.fillRect(x - antSize / 2, y - antSize / 2, antSize, antSize);
    }

    // Sources, back to front
    const proj = sources.map((src, i) => { const q = P(src.x, src.y, src.z); return [q[0], q[1], q[2], i]; });
    proj.sort((a, b) => b[2] - a[2]);
    this.projected = proj;
    const [rMin, rMax] = dotRadii(sources.length, Math.min(w, h) * 0.42 * this.zoom * 0.8);
    for (const [x, y, depth, i] of proj) {
      const v = this.sourceStyle[i];
      const src = sources[i];
      ctx.globalAlpha = (depth > 0 ? 0.55 : 1) * (src.z < 0 ? 0.3 : 1);
      ctx.fillStyle = cmapColor(cmap, 0.1 + 0.9 * v);
      ctx.beginPath(); ctx.arc(x, y, rMin + (rMax - rMin) * v, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Calibrator
    if (calibrator && calibrator.enabled) {
      const rel = { x: calibrator.position.x - c.x, y: calibrator.position.y - c.y, z: calibrator.position.z - c.z };
      const dist = Math.hypot(rel.x, rel.y, rel.z) || 1;
      let k = s;
      const far = dist * s > 0.95;
      if (far) k = 0.95 / dist;
      const q = P(rel.x * k, rel.y * k, rel.z * k);
      const g = P(rel.x * k, rel.y * k, 0);
      const o = P(0, 0, 0);
      ctx.strokeStyle = t.s3; ctx.lineWidth = 1.2; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(g[0], g[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = t.s3; ctx.strokeStyle = t.surface; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(q[0], q[1] - 7); ctx.lineTo(q[0] + 6, q[1]); ctx.lineTo(q[0], q[1] + 7); ctx.lineTo(q[0] - 6, q[1]); ctx.closePath();
      ctx.stroke(); ctx.fill();
      ctx.fillStyle = t.fg; ctx.textAlign = 'left';
      ctx.fillText(`calibrator · ${si(dist, 3, 'm')}${far ? ' (not to scale)' : ''}`, q[0] + 10, q[1]);
    }

    // Scale note
    ctx.fillStyle = t.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(`array ⌀ ${si(2 * this.arrayRadius, 3, 'm')} (scaled) · sources on unit sphere · drag to orbit, scroll to zoom`, 8, h - 6);
  }

  hoverAt(e) {
    if (!this.projected) return;
    const [mx, my] = this.surface.local(e);
    let best = null, bd = 64;
    for (const p of this.projected) {
      const d = (p[0] - mx) ** 2 + (p[1] - my) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return hideTip();
    showTip(e.clientX, e.clientY, sourceTip(this.env.sources[best[3]], this.env.freq));
  }
}

// ---------------------------------------------------------------------------------------

export class ArrayView {
  constructor(el, { onSelect } = {}) {
    this.onSelect = onSelect;
    this.env = null;
    this.surface = new Surface(el, (ctx, w, h, t) => this.draw(ctx, w, h, t));
    const c = this.surface.canvas;
    c.addEventListener('mousemove', (e) => this.hoverAt(e));
    c.addEventListener('mouseleave', () => hideTip());
    c.addEventListener('click', (e) => {
      const i = this.nearest(e);
      if (i !== null && this.onSelect) this.onSelect(i);
    });
  }

  /** env: { positions, calibrator, values?: per-antenna power, selected?, cmap } */
  set(env) {
    this.env = env;
    if (env.values) {
      let lo = Infinity, hi = -Infinity;
      for (const v of env.values) { if (v < lo) lo = v; if (v > hi) hi = v; }
      this.vrange = [lo, hi];
    }
    this.render();
  }
  render() { this.surface.render(); }

  draw(ctx, w, h, t) {
    if (!this.env) return;
    const { positions, calibrator, values, selected, cmap } = this.env;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of positions) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    const span = Math.max(maxX - minX, maxY - minY, 1) * 1.12;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const cb = values ? 70 : 0;
    const m = { l: 52, r: 14 + cb, t: 12, b: 36 };
    const S = Math.min(w - m.l - m.r, h - m.t - m.b);
    const L = m.l + (w - m.l - m.r - S) / 2, T = m.t + (h - m.t - m.b - S) / 2;
    const X = (x) => L + ((x - (cx - span / 2)) / span) * S;
    const Y = (y) => T + S - ((y - (cy - span / 2)) / span) * S;
    this.geom = { X, Y };

    // Grid
    ctx.font = t.font; ctx.lineWidth = 1;
    ctx.strokeStyle = t.grid; ctx.fillStyle = t.muted;
    for (const v of niceTicks(cx - span / 2, cx + span / 2, 5)) {
      const x = Math.round(X(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, T); ctx.lineTo(x, T + S); ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(fmt(v), x, T + S + 6);
    }
    for (const v of niceTicks(cy - span / 2, cy + span / 2, 5)) {
      const y = Math.round(Y(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + S, y); ctx.stroke();
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(fmt(v), L - 6, y);
    }
    ctx.fillStyle = t.fg2; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('x (m)', L + S / 2, h - 14);
    ctx.save(); ctx.translate(12, T + S / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText('y (m)', 0, 0); ctx.restore();

    // Antennas
    const pxPerM = S / span;
    let spacing = Infinity;
    if (positions.length > 1 && positions.length < 3000) {
      for (let i = 0; i < Math.min(positions.length, 200); i++) for (let j = 0; j < positions.length; j++) {
        if (i === j) continue;
        const d = Math.hypot(positions[i].x - positions[j].x, positions[i].y - positions[j].y);
        if (d > 0 && d < spacing) spacing = d;
      }
    }
    const r = Math.max(1.6, Math.min(6, Number.isFinite(spacing) ? spacing * pxPerM * 0.36 : 3));
    const [lo, hi] = this.vrange || [0, 1];
    positions.forEach((p, i) => {
      ctx.fillStyle = values ? cmapColor(cmap, (values[i] - lo) / (hi - lo || 1)) : t.s1;
      ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), r, 0, 2 * Math.PI); ctx.fill();
    });
    if (selected != null && positions[selected]) {
      const p = positions[selected];
      ctx.strokeStyle = t.hl; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), r + 4, 0, 2 * Math.PI); ctx.stroke();
    }

    // Calibrator ground position, or an edge arrow when outside the view
    if (calibrator && calibrator.enabled) {
      const { x, y, z } = calibrator.position;
      let px = X(x), py = Y(y);
      const inside = px >= L && px <= L + S && py >= T && py <= T + S;
      ctx.fillStyle = t.s3; ctx.strokeStyle = t.surface; ctx.lineWidth = 2;
      let label = `calibrator h=${si(z, 3, 'm')}`;
      if (!inside) {
        const ox = L + S / 2, oy = T + S / 2;
        const dx = px - ox, dy = py - oy;
        const k = (S / 2 - 10) / Math.max(Math.abs(dx), Math.abs(dy));
        px = ox + dx * k; py = oy + dy * k;
        label += ` · ${si(Math.hypot(x - cx, y - cy), 3, 'm')} away`;
      }
      ctx.beginPath(); ctx.moveTo(px, py - 7); ctx.lineTo(px + 6, py); ctx.lineTo(px, py + 7); ctx.lineTo(px - 6, py); ctx.closePath();
      ctx.stroke(); ctx.fill();
      ctx.fillStyle = t.fg; ctx.font = t.font; ctx.textBaseline = 'middle';
      ctx.textAlign = px > L + S / 2 ? 'right' : 'left';
      ctx.fillText(label, px + (px > L + S / 2 ? -10 : 10), py);
    }

    // Colorbar for per-antenna values
    if (values) {
      const bx = L + S + 16, bw = 10;
      for (let i = 0; i < S; i++) { ctx.fillStyle = cmapColor(cmap, 1 - i / S); ctx.fillRect(bx, T + i, bw, 1.5); }
      ctx.fillStyle = t.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      for (const v of niceTicks(lo, hi, 4)) ctx.fillText(fmt(v), bx + bw + 4, T + S - ((v - lo) / (hi - lo || 1)) * S);
    }
  }

  nearest(e) {
    if (!this.env || !this.geom) return null;
    const [mx, my] = this.surface.local(e);
    let best = null, bd = 144;
    this.env.positions.forEach((p, i) => {
      const d = (this.geom.X(p.x) - mx) ** 2 + (this.geom.Y(p.y) - my) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  hoverAt(e) {
    const i = this.nearest(e);
    if (i === null) return hideTip();
    const p = this.env.positions[i];
    showTip(e.clientX, e.clientY,
      `<div class="tip-head">Antenna ${i}</div>` +
      `<div class="tip-row">position<b>${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)} m</b></div>` +
      (this.env.values ? `<div class="tip-row">in-band power<b>${fmt(this.env.values[i], 4)}</b></div>` : '') +
      (this.onSelect ? `<div class="tip-foot">click to inspect</div>` : ''));
  }
}

// ---------------------------------------------------------------------------------------

export class SkyView {
  constructor(el) {
    this.env = null;
    this.surface = new Surface(el, (ctx, w, h, t) => this.draw(ctx, w, h, t));
    const c = this.surface.canvas;
    c.addEventListener('mousemove', (e) => this.hoverAt(e));
    c.addEventListener('mouseleave', () => hideTip());
  }

  /** env: { sources, calibrator, positions, freq, apparent: bool, cmap } */
  set(env) {
    this.env = env;
    const vals = env.sources.map((s) => sourceIntensity(s, env.freq) * (env.apparent ? sourceGain(s) : 1));
    const norm = intensityNormalizer(vals, env.scale);
    this.style = vals.map(norm);
    this.order = vals.map((_, i) => i).sort((a, b) => vals[a] - vals[b]);
    this.render();
  }
  render() { this.surface.render(); }

  draw(ctx, w, h, t) {
    if (!this.env) return;
    const { sources, calibrator, positions, cmap } = this.env;
    const R = Math.min(w, h - 22) / 2 - 18;
    const ox = w / 2, oy = (h - 22) / 2 + 6;
    this.geom = { R, ox, oy };

    ctx.fillStyle = t.grid; ctx.globalAlpha = 0.3;
    ctx.beginPath(); ctx.arc(ox, oy, R, 0, 2 * Math.PI); ctx.fill(); ctx.globalAlpha = 1;
    ctx.strokeStyle = t.axis; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(ox, oy, R, 0, 2 * Math.PI); ctx.stroke();
    ctx.strokeStyle = t.grid;
    for (const alt of [30, 60]) { ctx.beginPath(); ctx.arc(ox, oy, R * Math.cos(alt / DEG), 0, 2 * Math.PI); ctx.stroke(); }
    for (let a = 0; a < 180; a += 45) {
      const dx = Math.cos(a / DEG) * R, dy = Math.sin(a / DEG) * R;
      ctx.beginPath(); ctx.moveTo(ox - dx, oy - dy); ctx.lineTo(ox + dx, oy + dy); ctx.stroke();
    }
    ctx.font = t.font; ctx.fillStyle = t.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('30°', ox + R * Math.cos(30 / DEG) + 3, oy - 6);
    ctx.fillText('60°', ox + R * Math.cos(60 / DEG) + 3, oy - 6);
    ctx.fillStyle = t.fg2; ctx.textAlign = 'center';
    ctx.fillText('+x', ox + R + 10, oy); ctx.fillText('+y', ox, oy - R - 9);

    let below = 0;
    const [rMin, rMax] = dotRadii(sources.length, R);
    for (const i of this.order) {
      const s = sources[i];
      if (s.z <= 0) { below++; continue; }
      const v = this.style[i];
      ctx.fillStyle = cmapColor(cmap, 0.1 + 0.9 * v);
      ctx.beginPath(); ctx.arc(ox + s.x * R, oy - s.y * R, rMin + (rMax - rMin) * v, 0, 2 * Math.PI); ctx.fill();
    }

    if (calibrator && calibrator.enabled && positions.length) {
      const c = centroid(positions);
      const d = [calibrator.position.x - c.x, calibrator.position.y - c.y, calibrator.position.z - c.z];
      const n = Math.hypot(...d) || 1;
      const px = ox + (d[0] / n) * R, py = oy - (d[1] / n) * R;
      ctx.fillStyle = t.s3; ctx.strokeStyle = t.surface; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px, py - 7); ctx.lineTo(px + 6, py); ctx.lineTo(px, py + 7); ctx.lineTo(px - 6, py); ctx.closePath();
      ctx.stroke(); ctx.fill();
      ctx.fillStyle = t.fg; ctx.textAlign = 'left';
      ctx.fillText(d[2] / n > 0 ? 'calibrator' : 'calibrator (below horizon)', px + 9, py);
    }

    ctx.fillStyle = t.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(`orthographic (l, m) from zenith · ${sources.length - below} above horizon${below ? ` · ${below} below (still summed with gain z²)` : ''}`, 8, h - 4);
  }

  hoverAt(e) {
    if (!this.env || !this.geom) return;
    const [mx, my] = this.surface.local(e);
    const { R, ox, oy } = this.geom;
    let best = -1, bd = 64;
    this.env.sources.forEach((s, i) => {
      if (s.z <= 0) return;
      const d = (ox + s.x * R - mx) ** 2 + (oy - s.y * R - my) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    if (best < 0) return hideTip();
    showTip(e.clientX, e.clientY, sourceTip(this.env.sources[best], this.env.freq));
  }
}
