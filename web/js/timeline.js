// Timeline: every run is a series of integrations at UTC times (start epoch + i × interval).
//
// Over the timeline the sky can stay fixed in the array frame, follow the lunar far-side
// ephemeris (an ICRS sky rotated into the local frame at each time) or turn at a constant rate
// about an axis. Each calibrator can be off, move with constant acceleration from a state at the
// start epoch (kinematic), or follow a series of states (one per integration: position, velocity
// for the Doppler shift, acceleration and transmit power). Calibrators below the horizon can be
// switched off, skipping the integrations with none above. The frames mirror the server's
// (src/lunar.rs, src/pipeline.rs), so the preview shows what the run uses.
import * as M from './model.js';
import { LinePlot, fmt, si } from './plot.js';
import { CALIBRATOR_EXAMPLES } from './calibrators.js';

const $ = (id) => document.getElementById(id);
const DEG = 180 / Math.PI;
const R_MOON = 1737.4e3;
const GM_MOON = 4.9028e12;
/** Rotation of the Moon relative to the stars (one sidereal month), degrees per hour. */
const LUNAR_SIDEREAL_RATE = 360 / (27.321661 * 24);
/** Most points evaluated for the over-the-timeline charts. */
const CHART_SAMPLES = 600;
/** Integrations sampled to fix the views' colour scale over a rotating sky. */
const SCALE_SAMPLES = 24;
/** Most trajectory points handed to the views. */
const TRACK_POINTS = 4000;
const MHz = (f) => `${+(f / 1e6).toFixed(3)} MHz`;
const dot = (a, s) => a[0] * s.x + a[1] * s.y + a[2] * s.z;
const AXES_VEC = { north: [0, 1, 0], up: [0, 0, 1] };

const AXIS_COLUMNS = { x: ['x', 'x_m', 'east', 'e'], y: ['y', 'y_m', 'north', 'n'], z: ['z', 'z_m', 'up', 'u', 'height'] };
const VECTOR_COLUMNS = {
  v: [['vx', 'v_x', 'vel_x', 'velocity_x', 'vx_m_s'], ['vy', 'v_y', 'vel_y', 'velocity_y', 'vy_m_s'], ['vz', 'v_z', 'vel_z', 'velocity_z', 'vz_m_s']],
  a: [['ax', 'a_x', 'acc_x', 'acceleration_x'], ['ay', 'a_y', 'acc_y', 'acceleration_y'], ['az', 'a_z', 'acc_z', 'acceleration_z']],
};
const POWER_COLUMNS = ['power', 'power_w', 'calibrator_power', 'eirp', 'eirp_w'];
/** Column layouts of headerless rows by column count: x, y, z, then velocity, acceleration, power. */
const HEADERLESS = { 3: {}, 4: { p: 3 }, 6: { v: 3 }, 7: { v: 3, p: 6 }, 9: { v: 3, a: 6 }, 10: { v: 3, a: 6, p: 9 } };
const isNumber = (v) => /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(v);
const ZERO = Object.freeze({ x: 0, y: 0, z: 0 });
const vec = (o) => (o ? { x: o.x, y: o.y, z: o.z } : null);

/**
 * Parses calibrator states from a CSV/TSV/whitespace table: a header naming x, y, z and optionally
 * vx, vy, vz, ax, ay, az and power columns (others are ignored); or headerless rows of x, y, z
 * [, vx, vy, vz [, ax, ay, az]] [, power]. Rows: { x, y, z, v, a, power } with null for missing.
 */
export function parsePositions(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) throw new Error('the file has no rows');
  const delim = lines[0].includes(',') ? ',' : lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : /\s+/;
  const split = (l) => l.split(delim).map((c) => c.trim().replace(/^"|"$/g, ''));
  const first = split(lines[0]);
  const headerless = first.every(isNumber);
  let cols;
  if (headerless) {
    const layout = HEADERLESS[first.length];
    if (!layout) throw new Error(`headerless rows need 3, 4, 6, 7, 9 or 10 columns (x, y, z, vx, vy, vz, ax, ay, az, power), not ${first.length}`);
    const at = (k) => (k === undefined ? null : [k, k + 1, k + 2]);
    cols = { x: 0, y: 1, z: 2, v: at(layout.v), a: at(layout.a), p: layout.p ?? -1 };
  } else {
    const header = first.map((h) => h.toLowerCase());
    const find = (names) => header.findIndex((h) => names.includes(h));
    const triple = (names) => {
      const idx = names.map(find);
      if (idx.every((i) => i < 0)) return null;
      if (idx.some((i) => i < 0)) throw new Error(`the header has some but not all of ${names.map((n) => n[0]).join(', ')}`);
      return idx;
    };
    cols = { x: find(AXIS_COLUMNS.x), y: find(AXIS_COLUMNS.y), z: find(AXIS_COLUMNS.z), v: triple(VECTOR_COLUMNS.v), a: triple(VECTOR_COLUMNS.a), p: find(POWER_COLUMNS) };
    if (cols.x < 0 || cols.y < 0 || cols.z < 0) throw new Error(`the header needs x, y and z columns (found: ${header.join(', ')})`);
  }
  const body = headerless ? lines : lines.slice(1);
  if (!body.length) throw new Error('the file has no positions');
  const firstRow = headerless ? 1 : 2;
  return body.map((line, n) => {
    const c = split(line);
    const row = n + firstRow;
    const [x, y, z] = [cols.x, cols.y, cols.z].map((i) => parseFloat(c[i]));
    if (![x, y, z].every(Number.isFinite)) throw new Error(`row ${row}: x, y and z must be numbers`);
    const vector = (idx, what) => {
      if (!idx || idx.every((i) => c[i] === undefined || c[i] === '')) return null;
      const [vx, vy, vz] = idx.map((i) => parseFloat(c[i]));
      if (![vx, vy, vz].every(Number.isFinite)) throw new Error(`row ${row}: the ${what} must be numbers`);
      return { x: vx, y: vy, z: vz };
    };
    const power = cols.p >= 0 && c[cols.p] !== undefined && c[cols.p] !== '' ? parseFloat(c[cols.p]) : null;
    if (power !== null && !(power >= 0)) throw new Error(`row ${row}: power must be a non-negative number`);
    return { x, y, z, v: vector(cols.v, 'velocity'), a: vector(cols.a, 'acceleration'), power };
  });
}

/** Milliseconds since the Unix epoch for an ISO 8601 time, read as UTC unless it has an offset. */
export function parseUtc(text) {
  let t = text.trim().replace(' ', 'T');
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(t)) t += 'Z';
  const ms = Date.parse(t);
  if (!Number.isFinite(ms)) throw new Error(`"${text}" is not an ISO 8601 time`);
  return ms;
}

const isoOf = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

/** UTC timestamp `offset` seconds after `t0` (ms, whole seconds), with nanosecond precision. */
function isoPrecise(t0, offset) {
  const whole = Math.floor(offset);
  return `${isoOf(t0 + whole * 1000).replace('Z', '').slice(0, 19)}.${(offset - whole).toFixed(9).slice(2)}Z`;
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Evenly spaced indices into 0..n-1, at most `max` of them. */
function sampleIndices(n, max) {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: max }, (_, k) => Math.round((k * (n - 1)) / (max - 1)));
}

/**
 * ctx: { state, api, toast, download, ask, views, setIntegrations(n), active(), onStep(), onChange(),
 *        transmitter: { shape(tx), dto(cal, power, opts), setPower(cal, p) } }
 * state.calibrators: [{ name, color, mode: 'off' | 'fixed' | 'series', position, velocity,
 *   acceleration (kinematic state at the start epoch), transmitter, series: { rows, source, python,
 *   pythonPending, origin, doppler } }]; active() is the one the sidebar edits.
 * onStep: the current integration changed (redraw the environment views).
 * onChange: the plan changed (also re-derive workload, output sizes, staleness).
 */
export function initTimeline(ctx) {
  const { state, api, toast } = ctx;
  const tl = {
    n: 1, t0: 0, dt: 0,
    // One track per enabled calibrator (kinematic or series), up to one state per integration:
    // { cal, positions, velocity, acceleration, power, elevation, distance, rangeRate, velocitySource }.
    tracks: [],
    kept: [], skipped: null, // indices of integrations that run; Uint8Array flags, or null
    anySilent: false, // whether some calibrator is switched off at some integration
    base: null, baseKey: '', pending: null, baseLocal: null, baseLocalKey: '',
    chart: null, activeSources: 0,
    step: 0, playing: false, token: 0, version: 0, skyCache: { key: '', sources: [] }, scaleCache: { key: '', sources: null },
  };

  const powerPlot = new LinePlot($('tl-power-plot'), { xLabel: 'integration', yLabel: 'power per bin (Jy)', yLog: true, empty: 'Single integration' });
  const elevPlot = new LinePlot($('tl-elev-plot'), { xLabel: 'integration', yLabel: 'calibrator elevation (°)', empty: 'No positions' });
  const dopplerPlot = new LinePlot($('tl-doppler-plot'), { xLabel: 'integration', yLabel: 'Doppler shift (kHz)', empty: 'No velocity' });
  ctx.views.push(powerPlot, elevPlot, dopplerPlot);

  const rotation = () => $('sky-rotation').value;
  const rotSky = () => document.querySelector('input[name="rot-sky"]:checked').value;
  const active = () => ctx.active();
  const enabledCals = () => state.calibrators.filter((c) => c.mode !== 'off');
  /** Whether a kinematic calibrator moves. */
  const moving = (cal) => {
    const { velocity: v, acceleration: a } = cal;
    return [v.x, v.y, v.z, a.x, a.y, a.z].some((c) => c !== 0);
  };
  /** Whether a calibrator's position changes between integrations. */
  const trackVaries = (cal) => cal.mode === 'series' || (cal.mode === 'fixed' && moving(cal));
  const anyTrackVaries = () => enabledCals().some(trackVaries);
  const trackOf = (cal) => tl.tracks.find((t) => t.cal === cal);
  const skipBelow = () => $('cal-skip').checked;
  /** Whether a track's calibrator is switched off at integration i (below the horizon). */
  const silentAt = (t, i) => skipBelow() && t.elevation[i] <= 0;
  const antennas = () => state.array.antenna_positions;
  const windowDuration = () => state.array.sample_window_size / state.array.sample_frequency;
  const usesGsm = () => rotation() !== 'none' && rotSky() === 'gsm';

  // ---------------------------------------------------------------------------------------
  // Times and sky frames

  function resolveTimeline() {
    tl.n = Math.max(1, parseInt($('integrations').value, 10) || 1);
    const interval = parseFloat($('tl-interval').value);
    tl.dt = interval > 0 ? interval : windowDuration();
    $('tl-interval').placeholder = `${fmt(windowDuration(), 3)} (back to back)`;
    let t0;
    try { t0 = parseUtc($('tl-epoch').value || '2026-01-01T00:00:00'); } catch { t0 = Date.parse('2026-01-01T00:00:00Z'); }
    tl.t0 = Math.floor(t0 / 1000) * 1000;
  }

  const offsetAt = (i) => i * tl.dt;
  const isoAt = (i) => isoPrecise(tl.t0, offsetAt(i));
  const axis = () => AXES_VEC[$('rot-axis').value];
  const rate = () => { const r = parseFloat($('rot-rate').value); return Number.isFinite(r) ? r : 0; };

  function basisAt(i) {
    const mode = rotation();
    if (mode === 'lunar') return M.farsideBasis(tl.t0 / 1000 + offsetAt(i));
    if (mode === 'constant') return M.rotationBasis(axis(), -(rate() * offsetAt(i)) / 3600 / DEG);
    return null;
  }

  /** Parameters of the GSM2016 all-sky model in ICRS that rotating skies start from. */
  function gsmParams() {
    const [lo, hi] = M.physicalBand(state.array);
    return {
      nside: parseInt($('rot-nside').value, 10), maps: parseInt($('rot-maps').value, 10), order: parseInt($('rot-order').value, 10),
      fmin: Math.max(10e6, lo), fmax: hi, frame: 'equatorial', epoch: null, resolution: 'auto', above_horizon: false,
    };
  }

  /** Generates the GSM2016 base for the current parameters (once; concurrent callers share it). */
  function ensureBase() {
    const params = gsmParams();
    const key = JSON.stringify(params);
    if (tl.baseKey === key && tl.base) return Promise.resolve();
    if (tl.pending && tl.pending.key === key) return tl.pending.promise;
    const promise = api('/sky/gsm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) })
      .then(({ csv }) => { tl.base = M.parseSourcesCsv(csv); tl.baseKey = key; })
      .finally(() => { if (tl.pending && tl.pending.key === key) tl.pending = null; });
    tl.pending = { key, promise };
    return promise;
  }

  /**
   * The sky the rotation starts from: ICRS for the lunar ephemeris, the array frame at the start
   * epoch for a constant rate (GSM2016 placed as seen from the lunar far side at that epoch).
   */
  function baseSky() {
    if (rotation() === 'none' || rotSky() === 'model') return state.sources;
    if (!tl.base || tl.baseKey !== JSON.stringify(gsmParams())) return null;
    if (rotation() === 'lunar') return tl.base;
    const key = `${tl.baseKey}|${tl.t0}`;
    if (tl.baseLocalKey !== key) {
      const b = M.farsideBasis(tl.t0 / 1000);
      tl.baseLocal = tl.base.map((s) => {
        const [ra, dec] = M.toRaDec(dot(b.east, s), dot(b.north, s), dot(b.up, s));
        return M.makeSource(ra, dec, s.f0, s.I0, s.alpha, s.alpha2, s.alpha3);
      });
      tl.baseLocalKey = key;
    }
    return tl.baseLocal;
  }

  /** Sources of `base` above the horizon at integration i, in the array frame. */
  function frameAt(base, i) {
    const out = [];
    const b = basisAt(i);
    for (const s of base) {
      const u = dot(b.up, s);
      if (u <= 0) continue;
      const e = dot(b.east, s), n = dot(b.north, s);
      const [ra, dec] = M.toRaDec(e, n, u);
      out.push({ ra, dec, f0: s.f0, I0: s.I0, alpha: s.alpha, alpha2: s.alpha2, alpha3: s.alpha3, x: e, y: n, z: u });
    }
    return out;
  }

  /** Sources above the horizon at integration i, in the array frame. */
  function skyAt(i) {
    if (rotation() === 'none') return state.sources;
    const key = `${tl.version}|${i}`;
    if (tl.skyCache.key === key) return tl.skyCache.sources;
    const base = baseSky();
    const out = base ? frameAt(base, i) : [];
    tl.skyCache = { key, sources: out };
    return out;
  }

  /**
   * Sources above the horizon at a spread of integrations, pooled, so the views can fix one colour
   * scale for the whole timeline instead of rescaling at every step (null for a fixed sky).
   */
  function scaleSky() {
    if (rotation() === 'none') return null;
    const base = baseSky();
    if (!base) return null;
    if (tl.scaleCache.key === tl.version) return tl.scaleCache.sources;
    // About half the base is up at a time; fewer frames for big skies keep the pool near 200k.
    const frames = Math.max(2, Math.min(SCALE_SAMPLES, Math.floor(4e5 / Math.max(1, base.length))));
    const out = [];
    for (const i of sampleIndices(tl.n, frames)) for (const s of frameAt(base, i)) out.push(s);
    tl.scaleCache = { key: tl.version, sources: out };
    return out;
  }

  /** Apparent sky power per bin at frequency f for integration i (sources below the horizon count zero). */
  function skyPower(i, f) {
    const sources = skyAt(i);
    let sum = 0;
    for (const s of sources) if (s.z > 0) sum += s.z * s.z * M.sourceIntensity(s, f);
    return sum;
  }

  // ---------------------------------------------------------------------------------------
  // Calibrator

  /**
   * A calibrator's state at each integration (all of them in kinematic mode, up to one per row in
   * series mode), with its elevation, distance and range rate from the array centroid.
   */
  function resolveTrack(cal) {
    const mode = cal.mode, ser = cal.series;
    const m = mode === 'fixed' ? tl.n : Math.min(ser.rows.length, tl.n);
    const ctr = M.centroid(antennas());
    const P = cal.transmitter.power;
    const t = {
      cal,
      positions: new Array(m), velocity: new Array(m), acceleration: new Array(m),
      power: new Float64Array(m), elevation: new Float64Array(m), distance: new Float64Array(m), rangeRate: new Float64Array(m),
      velocitySource: '',
    };
    if (mode === 'fixed') {
      const { position: p, velocity: v, acceleration: a } = cal;
      for (let i = 0; i < m; i++) {
        const dt = offsetAt(i), h = 0.5 * dt * dt;
        t.positions[i] = { x: p.x + v.x * dt + a.x * h, y: p.y + v.y * dt + a.y * h, z: p.z + v.z * dt + a.z * h };
        t.velocity[i] = { x: v.x + a.x * dt, y: v.y + a.y * dt, z: v.z + a.z * dt };
        t.acceleration[i] = a;
        t.power[i] = P;
      }
      t.velocitySource = moving(cal) ? 'kinematic' : '';
    } else {
      const c = ser.origin === 'centroid' ? ctr : ZERO;
      const estimate = ser.doppler && m > 1;
      let given = 0, estimated = 0;
      for (let i = 0; i < m; i++) {
        const r = ser.rows[i];
        t.positions[i] = { x: r.x + c.x, y: r.y + c.y, z: r.z + c.z };
        if (r.v) { t.velocity[i] = r.v; given++; }
        else if (estimate) {
          // Central differences over the integration times (one-sided at the ends).
          const j0 = Math.max(0, i - 1), j1 = Math.min(m - 1, i + 1);
          const dt = offsetAt(j1) - offsetAt(j0);
          const a = ser.rows[j0], b = ser.rows[j1];
          t.velocity[i] = dt > 0 ? { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt, z: (b.z - a.z) / dt } : ZERO;
          estimated++;
        } else t.velocity[i] = ZERO;
        t.acceleration[i] = r.a || ZERO;
        t.power[i] = r.power ?? P;
      }
      t.velocitySource = given === m && m ? 'given' : given ? `given for ${given.toLocaleString()} rows${estimated ? ', estimated for the rest' : ''}` : estimated ? 'estimated' : '';
    }
    for (let i = 0; i < m; i++) {
      const p = t.positions[i], v = t.velocity[i];
      const d = [p.x - ctr.x, p.y - ctr.y, p.z - ctr.z];
      const dist = Math.hypot(...d) || 1;
      t.distance[i] = dist;
      t.elevation[i] = Math.asin(d[2] / dist) * DEG;
      t.rangeRate[i] = (v.x * d[0] + v.y * d[1] + v.z * d[2]) / dist;
    }
    return t;
  }

  const mismatch = (cal) => cal.mode === 'series' && cal.series.rows.length > 0 && !cal.series.pythonPending && cal.series.rows.length !== tl.n;

  // ---------------------------------------------------------------------------------------
  // Python positions

  const timelineKey = () => `${tl.n}|${tl.dt}|${tl.t0}`;

  /** The ctx passed to a calibrator's positions(ctx). */
  function pythonContext(cal) {
    const c = M.centroid(antennas());
    const [fmin, fmax] = M.physicalBand(state.array);
    return {
      integrations: tl.n,
      interval: tl.dt,
      offsets: Array.from({ length: tl.n }, (_, i) => offsetAt(i)),
      epoch: isoAt(0),
      epoch_unix: tl.t0 / 1000,
      frequency: cal.transmitter.frequency,
      antennas: antennas().map((p) => [p.x, p.y, p.z]),
      centroid: [c.x, c.y, c.z],
      origin: cal.series.origin,
      moon_radius: R_MOON,
      moon_gm: GM_MOON,
      fmin,
      fmax,
    };
  }

  /** The positions() response as a result: positions, and velocity, acceleration and power when given. */
  const decode = (res) => {
    const xyz = (rows) => rows && rows.map(([x, y, z]) => ({ x, y, z }));
    return { positions: xyz(res.positions), velocity: xyz(res.velocity) || null, acceleration: xyz(res.acceleration) || null, power: res.power || null };
  };
  const toRows = (result) => result.positions.map((p, i) => ({
    x: p.x, y: p.y, z: p.z,
    v: vec(result.velocity && result.velocity[i]),
    a: vec(result.acceleration && result.acceleration[i]),
    power: result.power ? result.power[i] : null,
  }));

  /** Re-runs the applied code of each series calibrator waiting for the current timeline. */
  const rerunPython = debounce(async () => {
    const key = timelineKey();
    await Promise.all(state.calibrators.filter((c) => c.series.pythonPending && c.series.python).map(async (cal) => {
      const ser = cal.series, code = ser.python.code;
      try {
        const res = await api('/python', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'calibrator', code, context: pythonContext(cal) }),
        });
        if (!ser.python || ser.python.code !== code) return;
        if (res.error) throw new Error(res.error.split('\n').slice(-1)[0]);
        ser.rows = toRows(decode(res));
      } catch (e) {
        toast(`${cal.name} positions(): ${e.message}`, 'error');
      }
      if (ser.python && ser.python.code === code) ser.python.key = key;
      ser.pythonPending = false;
    }));
    refresh();
  }, 300);

  /**
   * Integrations that run: all of them, or (when calibrators below the horizon are switched off)
   * those with some calibrator above it.
   */
  function computeKept() {
    tl.skipped = null;
    tl.anySilent = skipBelow() && tl.tracks.some((t) => t.elevation.some((e) => e <= 0));
    if (skipBelow() && tl.tracks.length) {
      tl.skipped = new Uint8Array(tl.n);
      for (let i = 0; i < tl.n; i++) {
        let has = false, up = false;
        for (const t of tl.tracks) {
          if (i >= t.positions.length) continue;
          has = true;
          if (t.elevation[i] > 0) { up = true; break; }
        }
        tl.skipped[i] = has && !up ? 1 : 0;
      }
    }
    tl.kept = [];
    for (let i = 0; i < tl.n; i++) if (!tl.skipped || !tl.skipped[i]) tl.kept.push(i);
  }

  /** A track's calibrator at integration i, as the views and the model take it (null without a state). */
  function calAt(t, i) {
    if (i >= t.positions.length) return null;
    const silent = silentAt(t, i);
    return {
      enabled: true, name: t.cal.name, color: t.cal.color, named: tl.tracks.length > 1, silent,
      position: t.positions[i], velocity: t.velocity[i], acceleration: t.acceleration[i],
      power: silent ? 0 : t.power[i], shape: ctx.transmitter.shape(t.cal.transmitter),
    };
  }

  /** The calibrators with a state at integration i. */
  const calsAt = (i) => tl.tracks.map((t) => calAt(t, i)).filter(Boolean);

  /** Doppler shift (Hz) of a track's carrier at integration i, seen from the array centroid. */
  const dopplerAt = (t, i) => (-t.cal.transmitter.frequency * t.rangeRate[i]) / M.C;

  /**
   * Frequency the timeline compares powers at: the reference frequency of the selected calibrator
   * (or the first one on), or the band centre.
   */
  function chartFreq() {
    const cal = active().mode !== 'off' ? active() : enabledCals()[0];
    const shape = cal ? ctx.transmitter.shape(cal.transmitter) : null;
    if (shape && shape.peak > 0) return shape.refFreq;
    const [lo, hi] = M.physicalBand(state.array);
    return (lo + hi) / 2;
  }

  /**
   * Frequency a calibrator's power is charted at: `fc`, unless its spectrum has little power there
   * (a calibrator on another carrier), then its own reference frequency.
   */
  function calFreq(cal, fc) {
    const shape = ctx.transmitter.shape(cal.transmitter);
    return shape && shape.peak > 0 && shape.at(fc) < 0.25 * shape.peak ? shape.refFreq : fc;
  }

  /** Per-bin calibrator power at frequency f, mean over the antennas. */
  function calPower(c, f) {
    return c && c.shape ? M.meanCalibratorPower(c, antennas()) * c.shape.at(f) : NaN;
  }

  const noiseAt = (f) => state.array.system_noise_intensity / M.effectiveAperture(f);

  // ---------------------------------------------------------------------------------------
  // Derived series

  /** Sampled sky, noise and calibrator powers, and the sources ever above the horizon. */
  function computeChart() {
    const fc = chartFreq();
    const noise = noiseAt(fc);
    const idx = sampleIndices(tl.n, CHART_SAMPLES);
    const base = baseSky();
    const rotating = rotation() !== 'none';
    const everUp = rotating && base ? new Uint8Array(base.length) : null;
    const sky = [];
    const cals = tl.tracks.map((t) => ({ track: t, f: calFreq(t.cal, fc), y: [] }));
    const fixedSky = rotating ? 0 : skyPower(0, fc);
    for (const i of idx) {
      if (rotating) {
        let sum = 0;
        if (base) {
          const b = basisAt(i);
          base.forEach((s, k) => {
            const u = dot(b.up, s);
            if (u > 0) { everUp[k] = 1; sum += u * u * M.sourceIntensity(s, fc); }
          });
        }
        sky.push(sum);
      } else sky.push(fixedSky);
      for (const c of cals) c.y.push(calPower(calAt(c.track, i), c.f));
    }
    tl.activeSources = rotating ? (everUp ? everUp.reduce((a, v) => a + v, 0) : 0) : state.sources.length;
    tl.chart = { idx, sky, cals, noise, fc };
  }

  /**
   * Sets a calibrator's transmit power so it is `db` above sky + noise per bin at its closest
   * approach (at its reference frequency) among the integrations that run with it on. Returns
   * false if there is nothing to scale.
   */
  function autoPower(cal = active(), db = 10) {
    const t = trackOf(cal);
    const shape = ctx.transmitter.shape(cal.transmitter);
    if (!t || !shape || !(shape.peak > 0) || !tl.chart) return false;
    let k = -1;
    for (let i = 0; i < t.positions.length; i++) {
      if ((!tl.skipped || !tl.skipped[i]) && !silentAt(t, i) && (k < 0 || t.distance[i] < t.distance[k])) k = i;
    }
    if (k < 0) return false;
    const f = shape.refFreq;
    const unit = M.meanCalibratorPower({ enabled: true, position: t.positions[k], power: 1 }, antennas()) * shape.at(f);
    if (!(unit > 0)) return false;
    ctx.transmitter.setPower(cal, +((10 ** (db / 10) * (skyPower(k, f) + noiseAt(f))) / unit).toPrecision(3));
    return true;
  }

  /**
   * Re-derives everything after the timeline, sky, calibrators or environment change. With
   * `autoPower`, then sets that calibrator's transmit power (see autoPower).
   */
  async function refresh({ autoPower: auto = null } = {}) {
    const token = ++tl.token;
    resolveTimeline();
    let rerun = false;
    for (const cal of enabledCals()) {
      const ser = cal.series;
      if (cal.mode === 'series' && ser.python && ser.python.key !== timelineKey()) { ser.pythonPending = true; rerun = true; }
    }
    if (rerun) rerunPython();
    tl.tracks = enabledCals().map(resolveTrack);
    computeKept();
    tl.step = Math.min(tl.step, tl.n - 1);
    tl.version++;
    renderControls();
    if (usesGsm() && !baseSky()) {
      tl.chart = null;
      render();
      ctx.onChange();
      try { await ensureBase(); } catch (e) { if (token === tl.token) toast(`GSM2016 sky: ${e.message}`, 'error'); }
      if (token !== tl.token) return;
      tl.version++;
    }
    computeChart();
    // setPower re-enters refresh through the transmitter's change handler.
    if (auto && autoPower(auto)) return;
    render();
    ctx.onChange();
  }

  // ---------------------------------------------------------------------------------------
  // Rendering

  function renderControls() {
    const mode = rotation();
    $('rot-constant-params').hidden = mode !== 'constant';
    $('rot-sky').hidden = mode === 'none';
    const gsm = document.querySelector('input[name="rot-sky"][value="gsm"]');
    gsm.disabled = !state.gsmAvailable;
    gsm.closest('label').title = state.gsmAvailable ? '' : 'Needs pygdsm on the server';
    if (!state.gsmAvailable && gsm.checked) document.querySelector('input[name="rot-sky"][value="model"]').checked = true;
    $('rot-gsm-params').hidden = rotSky() !== 'gsm';
    $('rot-model-label').textContent = mode === 'lunar' ? 'The sky model above, read as ICRS RA/Dec' : 'The sky model above, as the sky at the start epoch';
  }

  function render() {
    $('tl-step').max = tl.n - 1;
    $('tl-step').value = tl.step;
    $('tl-play').disabled = tl.n < 2;
    renderRotationNote();
    renderSeriesSummary();
    renderCharts();
    renderStepInfo();
  }

  const degPerIntegration = () => ((rotation() === 'lunar' ? LUNAR_SIDEREAL_RATE : Math.abs(rate())) * tl.dt) / 3600;

  function renderRotationNote() {
    const mode = rotation();
    const el = $('rot-note');
    el.classList.remove('warn');
    if (mode === 'none') { el.textContent = 'Every integration uses the sky model above, fixed in the array frame.'; return; }
    const base = baseSky();
    if (!base) { el.textContent = 'Generating the GSM2016 all-sky model…'; return; }
    const per = degPerIntegration(), total = per * Math.max(0, tl.n - 1);
    const what = usesGsm()
      ? `GSM2016 (NSIDE ${$('rot-nside').value}, ${base.length.toLocaleString()} pixels, all sky)`
      : `The sky model (${base.length.toLocaleString()} sources)`;
    let text;
    if (mode === 'lunar') {
      const [ra, dec] = M.toRaDec(...basisAt(tl.step).up);
      text = `${what} in ICRS, rotated into the lunar far-side frame at each integration time: ` +
        `${fmt(per, 3)}° per integration, ${fmt(total, 3)}° over the timeline. Zenith at integration ${tl.step + 1}: RA ${(ra * DEG).toFixed(1)}°, Dec ${(dec * DEG).toFixed(1)}°.`;
    } else {
      text = `${what}${usesGsm() ? ' as seen from the lunar far side at the start epoch' : ' at the start epoch'}, turning ${fmt(rate(), 4)}°/h about ` +
        `${$('rot-axis').value === 'north' ? 'north (y)' : 'the zenith (z)'}: ${fmt(per, 3)}° per integration, ${fmt(total, 3)}° over the timeline.`;
    }
    text += tl.chart ? ` ${tl.activeSources.toLocaleString()} sources are above the horizon at some point; below it they get zero flux density.` : '';
    if (!usesGsm() && base.length && base.every((s) => s.z > 0) && total > 1) {
      text = `The sky model only covers the sky above the horizon, so rotation brings empty sky into view. ${text}`;
      el.classList.add('warn');
    }
    el.textContent = text;
  }

  /** Summary of the selected calibrator's series. */
  function renderSeriesSummary() {
    const cal = active(), ser = cal.series;
    const el = $('series-summary');
    const mis = mismatch(cal);
    $('series-mismatch').hidden = !mis;
    if (mis) {
      const m = ser.rows.length, n = tl.n;
      $('series-mismatch-text').textContent = `${m.toLocaleString()} positions for ${n.toLocaleString()} integrations.` +
        (m < n ? ` Integrations after ${m.toLocaleString()} have no ${cal.name} position.` : '');
      $('series-drop').hidden = m < n;
      $('series-drop').textContent = `Drop positions after ${n.toLocaleString()}`;
      $('series-fit').textContent = `Set integrations to ${m.toLocaleString()}`;
    }
    if (!ser.rows.length) { el.textContent = 'No positions loaded.'; el.classList.remove('warn'); return; }
    const t = trackOf(cal);
    const m = t ? t.positions.length : 0;
    const lo = (arr) => arr.reduce((a, v) => Math.min(a, v), Infinity), hi = (arr) => arr.reduce((a, v) => Math.max(a, v), -Infinity);
    const range = (arr) => `${fmt(lo(arr), 3)} – ${fmt(hi(arr), 3)}`;
    let below = 0;
    for (let i = 0; i < m; i++) if (t.elevation[i] <= 0) below++;
    const parts = [`${ser.source}: ${ser.rows.length.toLocaleString()} positions`];
    if (m) {
      parts.push(`elevation ${range(t.elevation)}°`);
      parts.push(`distance ${si(lo(t.distance), 3, 'm')} – ${si(hi(t.distance), 3, 'm')}`);
      if (t.velocitySource) {
        const d = Array.from({ length: m }, (_, i) => dopplerAt(t, i));
        parts.push(`velocity ${t.velocitySource}, Doppler ${si(lo(d), 3, 'Hz')} – ${si(hi(d), 3, 'Hz')}`);
      } else parts.push('no velocity (no Doppler shift)');
      const own = ser.rows.slice(0, m).filter((r) => r.power !== null).length;
      if (own) parts.push(`power from ${own === m ? 'every row' : `${own.toLocaleString()} rows`}`);
    }
    if (ser.pythonPending) parts.push('re-running for the new timeline…');
    let text = parts.join(' · ');
    const skip = skipBelow();
    if (below) {
      text = skip
        ? `${cal.name} is below the horizon, and switched off, at ${below.toLocaleString()} of ${m.toLocaleString()} integrations. ${text}`
        : `${below.toLocaleString()} position${below > 1 ? 's are' : ' is'} at or below the horizon; fringe does not model occlusion. ${text}`;
    }
    el.textContent = text;
    el.classList.toggle('warn', below > 0 && !skip);
  }

  /** Shaded spans of skipped integrations. */
  function skippedBands() {
    if (!tl.skipped) return [];
    const bands = [];
    for (let i = 0; i < tl.n && bands.length < 200; i++) {
      if (!tl.skipped[i]) continue;
      let j = i;
      while (j + 1 < tl.n && tl.skipped[j + 1]) j++;
      bands.push({ x0: i - 0.5, x1: j + 0.5 });
      i = j;
    }
    return bands;
  }

  function renderCharts() {
    const moving = tl.tracks.filter((t) => trackVaries(t.cal) && t.positions.length > 0);
    const series = moving.length > 0;
    const withDoppler = tl.tracks.filter((t) => t.velocitySource && t.positions.length > 0);
    const doppler = series && withDoppler.length > 0;
    const show = tl.n > 1 && (rotation() !== 'none' || series);
    $('tl-charts').hidden = !show;
    if (!show || !tl.chart) return;
    $('tl-elev-plot').hidden = !series;
    $('tl-doppler-plot').hidden = !doppler;
    const several = tl.tracks.length > 1;
    const what = several ? 'calibrators’' : 'calibrator’s';
    $('tl-charts-caption').textContent = `Per-bin power at ${MHz(tl.chart.fc)}` +
      (tl.chart.cals.some((c) => c.f !== tl.chart.fc) ? ' (calibrators on other carriers at their own frequency)' : '') +
      (series ? `, and the ${what} elevation${doppler ? ' and Doppler shift of the carrier' : ''} from the array centroid` : '') +
      (tl.skipped ? '; shaded integrations are skipped' : '') +
      (tl.n > CHART_SAMPLES ? ` (power sampled at ${CHART_SAMPLES} of ${tl.n.toLocaleString()} integrations)` : '');
    const { idx, sky, cals, noise } = tl.chart;
    const lines = [
      { label: 'Sky sources', x: idx, y: sky, color: 's1' },
      { label: 'System noise', x: idx, y: idx.map(() => noise), color: 's2' },
    ];
    for (const c of cals) {
      const at = c.f !== tl.chart.fc ? ` at ${MHz(c.f)}` : '';
      lines.push({ label: `${several ? c.track.cal.name : 'Calibrator'} (array mean)${at}`, x: idx, y: c.y, color: c.track.cal.color });
    }
    const bands = skippedBands();
    powerPlot.set(lines, { bands, vlines: [{ x: tl.step }] });
    if (series) {
      const label = (t) => (several ? t.cal.name : '');
      const plotted = tl.tracks.filter((t) => t.positions.length > 0);
      elevPlot.set(plotted.map((t) => {
        const e = sampleIndices(t.positions.length, 2000);
        return { label: label(t), x: e, y: e.map((i) => t.elevation[i]), color: t.cal.color };
      }), { bands, vlines: [{ x: tl.step }] });
      if (doppler) {
        dopplerPlot.set(withDoppler.map((t) => {
          const e = sampleIndices(t.positions.length, 2000);
          return { label: label(t), x: e, y: e.map((i) => dopplerAt(t, i) / 1e3), color: t.cal.color };
        }), { bands, vlines: [{ x: tl.step }] });
      }
    }
  }

  /** Elevation / azimuth (degrees) and distance of a calibrator from the array centroid. */
  function geometry(c) {
    const ctr = M.centroid(antennas());
    const d = [c.position.x - ctr.x, c.position.y - ctr.y, c.position.z - ctr.z];
    const dist = Math.hypot(...d) || 1;
    return { el: Math.asin(d[2] / dist) * DEG, az: ((Math.atan2(d[0], d[1]) * DEG) + 360) % 360, dist };
  }

  function renderStepInfo() {
    const n = tl.step;
    const skipped = tl.skipped && tl.skipped[n];
    $('tl-step-out').textContent = `${n + 1} / ${tl.n.toLocaleString()}${skipped ? ' · skipped' : ''}`;
    const tiles = [['Time (UTC)', isoAt(n).replace('T', ' ').replace(/\.?0*Z$/, ''), `+${si(offsetAt(n), 4, 's')}`]];
    const sources = skyAt(n);
    const mode = rotation();
    if (mode === 'none') tiles.push(['Sky', 'fixed', `${sources.length.toLocaleString()} sources`]);
    else if (!baseSky()) tiles.push(['Sky', '…', 'generating GSM2016']);
    else if (mode === 'lunar') {
      const [ra, dec] = M.toRaDec(...basisAt(n).up);
      tiles.push(['Zenith (ICRS)', `${(ra * DEG).toFixed(1)}°, ${(dec * DEG).toFixed(1)}°`, `${sources.length.toLocaleString()} sources above the horizon`]);
    } else {
      tiles.push(['Sky rotation', `${fmt((rate() * offsetAt(n)) / 3600, 4)}°`, `${sources.length.toLocaleString()} sources above the horizon`]);
    }
    const fc = tl.chart ? tl.chart.fc : chartFreq();
    /** Calibrator / (sky + noise) per bin, in dB, at frequency f. */
    const ratio = (c, f) => {
      const r = 10 * Math.log10(calPower(c, f) / (skyPower(n, f) + noiseAt(f)));
      return Number.isFinite(r) ? `${r.toFixed(1)} dB` : '–';
    };
    if (skipped) {
      const top = Math.max(...tl.tracks.filter((t) => n < t.positions.length).map((t) => t.elevation[n]));
      tiles.push(['Skipped', `${top.toFixed(1)}°`, tl.tracks.length > 1 ? 'every calibrator below the horizon' : 'calibrator below the horizon']);
    } else if (tl.tracks.length === 1) {
      const t = tl.tracks[0], c = calAt(t, n);
      if (c) {
        const g = geometry(c);
        const f = calFreq(t.cal, fc);
        tiles.push(['Calibrator elevation / azimuth', `${g.el.toFixed(1)}° / ${g.az.toFixed(1)}°`, 'azimuth from +y towards +x']);
        tiles.push(['Calibrator distance', si(g.dist, 4, 'm'), `delay ${si(g.dist / M.C, 3, 's')}`]);
        if (t.velocitySource) {
          const speed = Math.hypot(c.velocity.x, c.velocity.y, c.velocity.z);
          tiles.push(['Doppler shift', si(dopplerAt(t, n), 4, 'Hz'), `range rate ${si(t.rangeRate[n], 3, 'm/s')} · speed ${si(speed, 3, 'm/s')}`]);
        }
        tiles.push(['Calibrator / (sky + noise)', ratio(c, f), `per bin at ${MHz(f)} · EIRP ${si(c.power, 3, 'W')}`]);
      } else tiles.push(['Calibrator', 'none', 'no position for this integration']);
    } else {
      // One compact tile per calibrator.
      for (const t of tl.tracks) {
        const c = calAt(t, n);
        if (!c) { tiles.push([t.cal.name, 'none', 'no position for this integration']); continue; }
        const g = geometry(c);
        const f = calFreq(t.cal, fc);
        const sub = [si(g.dist, 3, 'm')];
        if (t.velocitySource) sub.push(`Doppler ${si(dopplerAt(t, n), 3, 'Hz')}`);
        sub.push(c.silent ? 'off (below the horizon)' : `${ratio(c, f)} over sky + noise at ${MHz(f)}`);
        tiles.push([`${t.cal.name} elevation / azimuth`, `${g.el.toFixed(1)}° / ${g.az.toFixed(1)}°`, sub.join(' · ')]);
      }
    }
    $('tl-tiles').innerHTML = tiles.map(([k, v, sub]) =>
      `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`).join('');
    if (!$('tl-charts').hidden) {
      for (const p of [powerPlot, elevPlot, dopplerPlot]) { p.vlines = [{ x: n }]; p.render(); }
    }
  }

  function setStep(n) {
    tl.step = Math.max(0, Math.min(tl.n - 1, n));
    $('tl-step').value = tl.step;
    renderStepInfo();
    if (rotation() === 'lunar') renderRotationNote();
    ctx.onStep();
  }

  function togglePlay(on = !tl.playing) {
    tl.playing = on && tl.n > 1;
    $('tl-play').textContent = tl.playing ? '❚❚' : '▶';
    $('tl-play').setAttribute('aria-label', tl.playing ? 'Pause' : 'Play');
    if (!tl.playing) return;
    let last = performance.now(), acc = 0;
    const tick = (now) => {
      if (!tl.playing) return;
      if ($('tab-environment').hidden) { togglePlay(false); return; }
      acc += ((now - last) / 1000) * parseFloat($('tl-speed').value);
      last = now;
      const steps = Math.floor(acc);
      if (steps > 0) { acc -= steps; setStep((tl.step + steps) % tl.n); }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---------------------------------------------------------------------------------------
  // Loading positions

  /** Asks how to reconcile loaded positions with the timeline when their lengths differ. */
  async function reconcile(cal, m, from) {
    const n = tl.n;
    if (m === n) return;
    const buttons = [{ label: 'Decide later', value: '' }];
    if (m > n) buttons.push({ label: `Drop positions after ${n.toLocaleString()}`, value: 'drop' });
    buttons.push({ label: `Set integrations to ${m.toLocaleString()}`, value: 'fit', primary: true });
    const choice = await ctx.ask(
      'Positions and integrations differ',
      `${from} ${m.toLocaleString()} positions for ${cal.name}, but the timeline has ${n.toLocaleString()} integrations. ` +
        (m > n ? 'Run one integration per position, or keep the integrations and drop the extra positions?' : 'Run one integration per position?'),
      buttons,
    );
    if (choice === 'fit') ctx.setIntegrations(m);
    else if (choice === 'drop') cal.series.rows = cal.series.rows.slice(0, n);
  }

  const refreshSoon = debounce(() => refresh(), 150);
  const fileName = (cal, what) => `${cal.name.toLowerCase()}_${what}`;

  $('series-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const cal = active();
    try {
      const rows = parsePositions(await file.text());
      Object.assign(cal.series, { python: null, pythonPending: false, rows, source: file.name });
      tl.step = 0;
      toast(`${rows.length.toLocaleString()} ${cal.name} positions loaded`);
      resolveTimeline();
      await reconcile(cal, rows.length, 'The file has');
      refresh({ autoPower: rows.every((r) => r.power === null) ? cal : null });
    } catch (err) {
      toast(`Positions file: ${err.message}`, 'error');
    } finally {
      e.target.value = '';
    }
  });
  $('series-template').addEventListener('click', () => {
    const rows = ['x,y,z,vx,vy,vz,power'];
    for (let i = 0; i < 5; i++) rows.push(`${-200 + i * 100},50,150,10,0,0,`);
    ctx.download('calibrator_positions.csv', rows.join('\n') + '\n', 'text/csv');
  });
  $('series-export').addEventListener('click', () => {
    const cal = active(), t = trackOf(cal);
    if (!t || !t.positions.length) return;
    const c = cal.series.origin === 'centroid' ? M.centroid(antennas()) : ZERO;
    const rows = ['x,y,z,vx,vy,vz,ax,ay,az,power', ...t.positions.map((p, i) => {
      const v = t.velocity[i], a = t.acceleration[i];
      return [p.x - c.x, p.y - c.y, p.z - c.z, v.x, v.y, v.z, a.x, a.y, a.z, t.power[i]].join(',');
    })];
    ctx.download(fileName(cal, 'positions.csv'), rows.join('\n') + '\n', 'text/csv');
  });
  $('series-drop').addEventListener('click', () => { const ser = active().series; ser.rows = ser.rows.slice(0, tl.n); refresh(); });
  $('series-fit').addEventListener('click', () => ctx.setIntegrations(active().series.rows.length));
  $('series-origin').addEventListener('change', (e) => { active().series.origin = e.target.value; refresh(); });
  $('series-doppler').addEventListener('change', (e) => { active().series.doppler = e.target.checked; refresh(); });
  $('cal-skip').addEventListener('change', () => refresh());

  for (const id of ['integrations', 'tl-epoch', 'tl-interval', 'rot-rate']) $(id).addEventListener('input', refreshSoon);
  for (const id of ['sky-rotation', 'rot-axis', 'rot-nside', 'rot-maps', 'rot-order']) $(id).addEventListener('change', () => refresh());
  document.querySelectorAll('input[name="rot-sky"]').forEach((r) => r.addEventListener('change', () => refresh()));
  $('tl-step').addEventListener('input', (e) => { togglePlay(false); setStep(parseInt(e.target.value, 10)); });
  $('tl-play').addEventListener('click', () => togglePlay());

  // Integration counts are needed before the first full refresh (which waits for the environment).
  resolveTimeline();
  computeKept();

  return {
    refresh,
    /** Integrations on the timeline, and those that run (after skipping). */
    count: () => tl.n,
    runCount: () => tl.kept.length,
    /** Whether the run needs per-integration times, positions or frames (the pipeline path). */
    needsPipeline: () => rotation() !== 'none' || anyTrackVaries() || tl.kept.length !== tl.n || tl.anySilent,
    /** Whether the environment changes between integrations. */
    varies: () => tl.n > 1 && (rotation() !== 'none' || anyTrackVaries()),
    /** Sources per simulated window (the run keeps the count constant). */
    sourceCount: () => tl.activeSources,
    step: () => tl.step,

    /** Environment at the current step: the sky, the calibrators and the tracks of moving ones. */
    env() {
      const i = tl.step;
      const env = { sources: skyAt(i), calibrators: calsAt(i), scaleSources: scaleSky(), trajectories: [] };
      for (const t of tl.tracks) {
        if (!trackVaries(t.cal) || t.positions.length < 2) continue;
        const k = Math.ceil(t.positions.length / TRACK_POINTS);
        const points = k > 1 ? t.positions.filter((_, j) => j % k === 0) : t.positions;
        env.trajectories.push({ points, index: Math.min(points.length - 1, Math.floor(i / k)), color: t.cal.color });
      }
      return env;
    },

    /**
     * Timeline fields of a pipeline request; throws if the plan is not ready. With `key`, the
     * transmit buffer is replaced by its identity (for change detection).
     */
    requestPart({ key = false } = {}) {
      for (const cal of enabledCals()) {
        if (cal.mode !== 'series') continue;
        if (!cal.series.rows.length) throw new Error(`load or generate ${cal.name} positions first`);
        if (mismatch(cal)) throw new Error(`there are ${cal.series.rows.length} ${cal.name} positions for ${tl.n} integrations; choose how to match them under Calibrators`);
      }
      if (!tl.kept.length) throw new Error(`every integration has ${tl.tracks.length > 1 ? 'all calibrators' : 'the calibrator'} below the horizon`);
      const base = baseSky();
      if (!base) throw new Error('the GSM2016 all-sky model is not ready yet');
      const mode = rotation();
      const part = {
        times: tl.kept.map(isoAt),
        calibrators: tl.tracks.map((t) => ({
          name: t.cal.name,
          transmitter: ctx.transmitter.dto(t.cal, t.cal.transmitter.power, { key }),
          states: tl.kept.map((i) => ({
            position: t.positions[i], velocity: t.velocity[i], acceleration: t.acceleration[i], power: silentAt(t, i) ? 0 : t.power[i],
          })),
        })),
        sky_frame: { none: 'fixed', lunar: 'lunar-farside', constant: 'rotating' }[mode],
        sources: base.map(M.sourceDto),
      };
      if (mode === 'constant') {
        const [x, y, z] = axis();
        part.sky_rotation = { epoch: isoAt(0), axis: { x, y, z }, rate: rate() };
      }
      return part;
    },

    /** Sky at the middle integration that runs: the analytic model for the Signals/Imaging tabs. */
    snapshotSources: () => skyAt(tl.kept[Math.floor(tl.kept.length / 2)] ?? 0).slice(),
    /**
     * Calibrators for the analytic model (with their spectral shapes); moving ones, and static ones
     * switched off below the horizon, are left out.
     */
    snapshotCalibrators: () => enabledCals().filter((c) => {
      const t = trackOf(c);
      return c.mode === 'fixed' && !moving(c) && !(t && t.positions.length && silentAt(t, 0));
    }).map((c, _, all) => ({
      name: c.name, color: c.color, named: all.length > 1, enabled: true,
      position: { ...c.position }, velocity: { ...c.velocity }, acceleration: { ...c.acceleration },
      power: c.transmitter.power, shape: ctx.transmitter.shape(c.transmitter),
    })),
    autoPower,
    /** Writes the selected calibrator's series settings to the controls. */
    writeSeriesControls() {
      const ser = active().series;
      $('series-origin').value = ser.origin;
      $('series-doppler').checked = ser.doppler;
      renderSeriesSummary();
    },

    onEnvironmentChanged() { refresh(); },

    /** The calibrator kind of the Python dialog (see pydialog.js). */
    pythonKind: {
      get title() { return `Python calibrator positions · ${active().name}`; },
      fn: 'positions',
      what: 'positions',
      get applyLabel() { return `Use as ${active().name}'s series`; },
      storageKey: 'fringe.calibratorCode',
      examples: CALIBRATOR_EXAMPLES,
      context() { resolveTimeline(); return pythonContext(active()); },
      decode,
      mountPreview(el) {
        el.innerHTML = '<div class="viz short"></div><div class="py-stats"></div>';
        const plot = new LinePlot(el.firstChild, { xLabel: 'integration', yLabel: 'calibrator elevation (°)', legend: false, empty: 'Run the code to preview' });
        ctx.views.push(plot);
        const stats = el.lastChild;
        return {
          show(result) {
            if (!result) { plot.set([]); stats.innerHTML = ''; return; }
            const cal = active();
            const c = cal.series.origin === 'centroid' ? M.centroid(antennas()) : ZERO;
            const ctr = M.centroid(antennas());
            const geo = result.positions.map((p, i) => {
              const d = [p.x + c.x - ctr.x, p.y + c.y - ctr.y, p.z + c.z - ctr.z];
              const dist = Math.hypot(...d) || 1;
              const v = result.velocity && result.velocity[i];
              const doppler = v ? (-cal.transmitter.frequency * (v.x * d[0] + v.y * d[1] + v.z * d[2])) / dist / M.C : NaN;
              return { el: Math.asin(d[2] / dist) * DEG, dist, doppler };
            });
            const idx = sampleIndices(geo.length, 2000);
            plot.set([{ x: idx, y: idx.map((i) => geo[i].el), color: 's3' }]);
            const range = (vals, f) => `${f(vals.reduce((a, v) => Math.min(a, v), Infinity))} – ${f(vals.reduce((a, v) => Math.max(a, v), -Infinity))}`;
            const below = geo.filter((g) => g.el <= 0).length;
            const m = geo.length, n = tl.n;
            const powered = result.power ? result.power.filter((v) => v !== null).length : 0;
            const rows = [
              ['Positions', `${m.toLocaleString()}${m === n ? '' : ` (timeline: ${n.toLocaleString()} integrations)`}`, m === n ? '' : 'warn'],
              ['Elevation', range(geo.map((g) => g.el), (v) => `${fmt(v, 3)}°`)],
              ['Distance', range(geo.map((g) => g.dist), (v) => si(v, 3, 'm'))],
              ['Below the horizon', below ? `${below.toLocaleString()} (${skipBelow() ? 'switched off' : 'transmitting'})` : 'none'],
              ['Doppler', result.velocity
                ? `${range(geo.map((g) => g.doppler), (v) => si(v, 4, 'Hz'))} at ${MHz(cal.transmitter.frequency)}`
                : cal.series.doppler ? 'velocity estimated from the positions' : 'none (no velocity)'],
              ['Acceleration', result.acceleration ? 'from positions()' : 'zero'],
              ['Power', powered ? `from positions() (${powered.toLocaleString()} rows)` : 'power field'],
            ];
            stats.innerHTML = `<dl>${rows.map(([k, v, cls]) => `<dt>${k}</dt><dd class="${cls || ''}">${v}</dd>`).join('')}</dl>`;
          },
        };
      },
      async apply(result, code) {
        const cal = active();
        Object.assign(cal.series, { rows: toRows(result), python: { code, key: timelineKey() }, pythonPending: false, source: 'Python positions(ctx)' });
        tl.step = 0;
        toast(`${cal.name} series from Python: ${cal.series.rows.length.toLocaleString()} positions`, 'ok');
        await reconcile(cal, cal.series.rows.length, 'positions() returned');
        refresh({ autoPower: result.power ? null : cal });
      },
    },
  };
}
